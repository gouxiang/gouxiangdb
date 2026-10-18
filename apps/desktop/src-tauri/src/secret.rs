//! JWT 密钥保管（IMPL-0.2.5-beta §4-R2 / #825 / #845）。
//!
//! 设计结论（DESIGN-MACOS-APP §8.5）：桌面壳的内核 JWT_SECRET 不落明文文件，改存
//! macOS 登录钥匙串；随包内核启动时由壳取出，经 `JWT_SECRET` 环境变量交给 node（node
//! 是壳的子进程，环境变量不进 `ps` 参数列表、不出现在命令行）。
//!
//! 本模块三层，刻意把「会碰真机钥匙串、会弹系统授权」的部分隔离到最底层：
//!   1. [`SecretStore`]：抽象 get/put。生产用 [`KeychainStore`]（`/usr/bin/security`），
//!      测试用内存 store——编排逻辑因此可在 `cargo test` 下 headless 全测，不弹授权。
//!   2. [`ensure_jwt_secret`]：纯编排——先查钥匙串；未命中则迁移旧 `.jwt-secret` 文件；
//!      都没有才生成新随机。与「怎么存」解耦，故不依赖 Tauri、不依赖真机。
//!   3. [`KeychainStore`]：唯一生成 `security` 子进程的地方。密码经 **stdin** 喂给
//!      `security -w`（`-w` 独立成参、不把口令接在命令行），确保 `ps` 看不到密钥。
//!
//! # 红线
//! 不引入任何 crypto crate（系统钥匙串负责存储加密），全树 aws-lc-rs 计数须保持 0。
//! 随机仅用 `/dev/urandom`（+ xorshift 兜底），与 upstream.rs probeId 同一手法。
//!
//! # 加密磁盘匣命名空间（#828 占位，本阶段不实现）
//! 离线副本的 sparsebundle 密码将用独立 service：
//! `service = cc.gouxiang.desktop.vault`，`account = "local" | "node:<nodeId>"`。
//! 此处仅登记常量，R2 不读写该命名空间。

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// JWT 所在钥匙串 service（= bundle id）。
pub const SERVICE_MAIN: &str = "cc.gouxiang.desktop";
/// JWT 在钥匙串里的 account。
pub const ACCOUNT_JWT: &str = "jwt-secret";
/// #828 加密磁盘匣专用 service（R2 只登记不使用，故显式允许 dead_code）。
#[allow(dead_code)]
pub const SERVICE_VAULT_RESERVED: &str = "cc.gouxiang.desktop.vault";

/// 新生成 JWT 密钥长度（≥32，PoC 文件方案同为 48）。
pub const JWT_LEN: usize = 48;

/// 一处机密的存取抽象。生产是 macOS 钥匙串；测试是内存 map。
pub trait SecretStore: Send + Sync {
    /// 读取已存机密；不存在返回 `Ok(None)`；钥匙串/IO 错误返回 `Err`（中文，可展示）。
    fn get(&self) -> Result<Option<String>, String>;
    /// 写入机密（已存在则覆盖）。机密只经 stdin / 内存，绝不进命令行参数。
    fn put(&self, secret: &str) -> Result<(), String>;
}

/// 机密来源（供日志/首 boot 判定，不返回给前端敏感内容）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretSource {
    /// 钥匙串里已有，直接沿用（最常见：第二次起）。
    Existing,
    /// 从旧 `.jwt-secret` 文件迁入钥匙串（一次性，D0→D2 升级）。
    Migrated,
    /// 首次生成的新随机密钥。
    Created,
}

/// [`ensure_jwt_secret`] 的结果。
pub struct SecretOutcome {
    pub secret: String,
    pub source: SecretSource,
    /// 迁移成功后旧明文文件是否已删除（仅 Migrated 时有意义）。
    pub legacy_deleted: bool,
}

/// macOS 钥匙串后端：`/usr/bin/security` generic password。
///
/// 选 CLI 而非 `security-framework` crate：链接成本为零、不引依赖（守 aws-lc-rs=0）；
/// 代价是 spawn 进程，但首 boot 仅一次，可接受。密钥经 stdin 传入，规避 `ps` 泄露。
pub struct KeychainStore {
    service: String,
    account: String,
    security_bin: String,
}

impl KeychainStore {
    /// 生产用：JWT 固定 service/account。
    pub fn jwt() -> Self {
        Self::new(SERVICE_MAIN, ACCOUNT_JWT)
    }

    /// 自定义 service/account（#828 vault 复用同一后端）。
    pub fn new(service: &str, account: &str) -> Self {
        Self {
            service: service.to_string(),
            account: account.to_string(),
            security_bin: "/usr/bin/security".to_string(),
        }
    }

    /// 组装 `security find/add/set-generic-password` 的 argv（**不含任何密钥**）。
    /// 密钥对 add/set 通过 `-w` 独立参数触发、随后经 stdin 提供。
    /// 纯函数：供单测断言 argv 里永远不出现口令。
    fn argv_for(&self, op: KeychainOp) -> Vec<String> {
        let sub = match op {
            KeychainOp::Find => "find-generic-password",
            KeychainOp::Add => "add-generic-password",
            KeychainOp::Set => "set-generic-password",
        };
        vec![
            sub.to_string(),
            "-s".to_string(),
            self.service.clone(),
            "-a".to_string(),
            self.account.clone(),
            // 三个子命令都带 -w：
            //  find：-w 表示「只把密码写到 stdout」（不打印属性/弹窗元信息）；
            //  add/set：-w 后【不接值】，强制 security 从 stdin 读口令，避免进 ps。
            "-w".to_string(),
        ]
    }
}

#[derive(Clone, Copy)]
enum KeychainOp {
    Find,
    Add,
    Set,
}

/// `security` 退出码：44 = errSecItemNotFound（找不到该项）。
const SEC_ERR_ITEM_NOT_FOUND: i32 = 44;

impl SecretStore for KeychainStore {
    fn get(&self) -> Result<Option<String>, String> {
        let output = Command::new(&self.security_bin)
            .args(self.argv_for(KeychainOp::Find))
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("无法调用系统钥匙串工具 security：{e}"))?;
        if output.status.success() {
            // stdout 末尾通常带换行；密钥字符集不含空白，trim_end 安全。
            let secret = String::from_utf8_lossy(&output.stdout);
            let secret = secret.trim_end_matches(['\n', '\r']).to_string();
            if secret.len() < JWT_LEN {
                return Err(
                    "钥匙串中的 JWT 密钥长度异常（可能已损坏），请在钥匙串访问中删除该项后重试"
                        .to_string(),
                );
            }
            Ok(Some(secret))
        } else if output.status.code() == Some(SEC_ERR_ITEM_NOT_FOUND) {
            Ok(None)
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "读取钥匙串密钥失败（code={:?}）：{err}",
                output.status.code()
            ))
        }
    }

    fn put(&self, secret: &str) -> Result<(), String> {
        // 先 add；遇到「已存在」(duplicate) 再 set 覆盖。两次都把口令经 stdin 喂入。
        match self.run_write(KeychainOp::Add, secret) {
            Ok(()) => Ok(()),
            Err(WriteErr::Duplicate) => {
                self.run_write(KeychainOp::Set, secret)
                    .map_err(|e| match e {
                        WriteErr::Duplicate => "钥匙串写入失败：项已存在且无法更新".to_string(),
                        WriteErr::Other(m) => m,
                    })
            }
            Err(WriteErr::Other(m)) => Err(m),
        }
    }
}

enum WriteErr {
    Duplicate,
    Other(String),
}

impl KeychainStore {
    fn run_write(&self, op: KeychainOp, secret: &str) -> Result<(), WriteErr> {
        let mut child = Command::new(&self.security_bin)
            .args(self.argv_for(op))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| WriteErr::Other(format!("无法调用系统钥匙串工具 security：{e}")))?;
        // 口令写进 stdin（末尾换行结束输入）；它绝不出现在 argv / ps。
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(secret.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
        let output = child
            .wait_with_output()
            .map_err(|e| WriteErr::Other(format!("等待钥匙串写入失败：{e}")))?;
        if output.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&output.stderr);
        // 重复项：security 文本含 "already exists"；不同本地化/版本措辞不一，
        // 同时认 errSecDuplicateItem 退出码 45。
        let code = output.status.code();
        if code == Some(45) || err.to_ascii_lowercase().contains("already exists") {
            return Err(WriteErr::Duplicate);
        }
        Err(WriteErr::Other(format!(
            "写入钥匙串密钥失败（code={code:?}）：{}",
            err.trim()
        )))
    }
}

/// 取到内核要用的 JWT 密钥：钥匙串优先 → 迁移旧文件 → 否则新生成（#825 首 boot）。
///
/// 顺序（任一步成功即返回，绝不重复写）：
/// 1. `store.get()` 命中：沿用，[`SecretSource::Existing`]；
/// 2. 未命中且 `legacy_file` 是长度 ≥ [`JWT_LEN`] 的旧密钥：`put` 进 store 后**删除旧明文
///    文件**（D0→D2 升级，只此一次；删除尽力而为，结果记在 `legacy_deleted`）；
/// 3. 否则生成 [`JWT_LEN`] 字符随机密钥 `put` 进 store，[`SecretSource::Created`]。
///
/// 过短/不可读的 legacy 文件一律不当作密钥（防止读到半截写入），保留不动、走新建分支。
pub fn ensure_jwt_secret<S: SecretStore + ?Sized>(
    store: &S,
    legacy_file: &Path,
) -> Result<SecretOutcome, String> {
    if let Some(existing) = store.get()? {
        return Ok(SecretOutcome {
            secret: existing,
            source: SecretSource::Existing,
            legacy_deleted: false,
        });
    }

    // 旧 PoC 文件方案迁移。
    if let Ok(content) = std::fs::read_to_string(legacy_file) {
        let trimmed = content.trim();
        if trimmed.len() >= JWT_LEN {
            let secret = trimmed.to_string();
            store.put(&secret)?;
            // 迁入后删除明文；删除失败不致命（下次 get 已命中，不会再读它），如实上报。
            let legacy_deleted = std::fs::remove_file(legacy_file).is_ok();
            return Ok(SecretOutcome {
                secret,
                source: SecretSource::Migrated,
                legacy_deleted,
            });
        }
        // 过短：疑似损坏/写一半，不迁移、不删除，落到新建。
    }

    let secret = random_secret(JWT_LEN);
    store.put(&secret)?;
    Ok(SecretOutcome {
        secret,
        source: SecretSource::Created,
        legacy_deleted: false,
    })
}

/// 生成 `n` 字符密钥：优先 `/dev/urandom`，失败退化为时间/地址熵 xorshift。
/// 字符集 [A-Za-z0-9]，无 shell/换行敏感字符（可安全经 stdin 与 env 传递）。
pub fn random_secret(n: usize) -> String {
    use std::io::Read;
    // 每字符需在 62 字母表内无偏取样：取整字节数略多于 n，拒绝采样。
    let mut raw = vec![0u8; n * 2];
    let from_urandom = match std::fs::File::open("/dev/urandom") {
        Ok(mut f) => f.read_exact(&mut raw).is_ok(),
        Err(_) => false,
    };
    if !from_urandom {
        fallback_entropy(&mut raw);
    }
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(n);
    for &b in &raw {
        let r = b as usize;
        if r < 248 {
            // 248 = 4*62，拒绝 [248,256) 消除模偏差。
            out.push(ALPHABET[r % 62] as char);
        }
        if out.len() == n {
            break;
        }
    }
    // 理论上 raw 有 2n 字节，足够；极端兜底用 xorshift 补齐到 n。
    let mut x = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e3779b97f4a7c15)
        ^ std::process::id() as u64
        ^ out.capacity() as u64;
    while out.len() < n {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let r = x.wrapping_mul(0x2545F4914F6CDD1D);
        out.push(ALPHABET[(r >> 33) as usize % 62] as char);
    }
    out
}

fn fallback_entropy(bytes: &mut [u8]) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e3779b97f4a7c15)
        ^ std::process::id() as u64
        ^ bytes.as_ptr() as u64;
    for slot in bytes.iter_mut() {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let r = x.wrapping_mul(0x2545F4914F6CDD1D);
        *slot = (r & 0xff) as u8;
    }
}

/// headless 用内存后端（断言编排逻辑，绝不碰真机钥匙串/不弹授权）。
#[cfg(test)]
#[derive(Default)]
pub struct MemSecretStore {
    inner: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
impl MemSecretStore {
    pub fn empty() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }
    pub fn preloaded(secret: &str) -> Self {
        Self {
            inner: std::sync::Mutex::new(Some(secret.to_string())),
        }
    }
    /// 测试断言当前保存值。
    pub fn snapshot(&self) -> Option<String> {
        self.inner.lock().expect("mem secret lock").clone()
    }
}

#[cfg(test)]
impl SecretStore for MemSecretStore {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.inner.lock().expect("mem secret lock").clone())
    }
    fn put(&self, secret: &str) -> Result<(), String> {
        *self.inner.lock().expect("mem secret lock") = Some(secret.to_string());
        Ok(())
    }
}

/// 测试辅助：临时 legacy 文件路径（每用例唯一，避免互踩）。
#[cfg(test)]
pub fn temp_legacy_path(tag: &str) -> std::path::PathBuf {
    let pid = std::process::id();
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("gx-jwt-legacy-{tag}-{pid}-{ns}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_new_when_empty_and_no_legacy() {
        let store = MemSecretStore::empty();
        let legacy = temp_legacy_path("new");
        let _ = std::fs::remove_file(&legacy);
        let out = ensure_jwt_secret(&store, &legacy).expect("应成功");
        assert_eq!(out.source, SecretSource::Created);
        assert_eq!(out.secret.len(), JWT_LEN);
        assert!(out.secret.bytes().all(|b| b.is_ascii_alphanumeric()));
        // 已落 store。
        assert_eq!(store.snapshot().as_deref(), Some(out.secret.as_str()));
        let _ = std::fs::remove_file(&legacy);
    }

    #[test]
    fn existing_is_returned_unchanged() {
        let store = MemSecretStore::preloaded(&"x".repeat(JWT_LEN));
        let legacy = temp_legacy_path("existing");
        let _ = std::fs::remove_file(&legacy);
        let out = ensure_jwt_secret(&store, &legacy).expect("应成功");
        assert_eq!(out.source, SecretSource::Existing);
        assert_eq!(out.secret.len(), JWT_LEN);
        let _ = std::fs::remove_file(&legacy);
    }

    #[test]
    fn migrates_legacy_file_then_deletes_it() {
        let store = MemSecretStore::empty();
        let legacy = temp_legacy_path("migrate");
        let old_secret = "L".repeat(JWT_LEN + 4);
        std::fs::write(&legacy, format!("{old_secret}\n")).expect("写 legacy");
        let out = ensure_jwt_secret(&store, &legacy).expect("应成功");
        assert_eq!(out.source, SecretSource::Migrated);
        assert_eq!(out.secret, old_secret, "应迁入旧文件内容（trim 尾换行）");
        assert!(out.legacy_deleted, "迁移后应删除旧明文文件");
        assert!(!legacy.exists(), "旧 .jwt-secret 文件必须已删除");
        assert_eq!(store.snapshot().as_deref(), Some(old_secret.as_str()));
    }

    #[test]
    fn short_legacy_is_ignored_and_preserved() {
        let store = MemSecretStore::empty();
        let legacy = temp_legacy_path("short");
        std::fs::write(&legacy, "too-short").expect("写 legacy");
        let out = ensure_jwt_secret(&store, &legacy).expect("应成功");
        assert_eq!(
            out.source,
            SecretSource::Created,
            "过短文件不算密钥，走新建"
        );
        assert!(legacy.exists(), "可疑的过短文件不应被删除，原样保留");
        let _ = std::fs::remove_file(&legacy);
    }

    #[test]
    fn random_secret_length_charset_and_uniqueness() {
        let a = random_secret(JWT_LEN);
        let b = random_secret(JWT_LEN);
        assert_eq!(a.len(), JWT_LEN);
        assert_eq!(b.len(), JWT_LEN);
        assert_ne!(a, b, "两次随机应不同");
        for s in [&a, &b] {
            assert!(s.bytes().all(|x| x.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn keychain_argv_never_carries_secret_and_w_is_standalone() {
        let store = KeychainStore::jwt();
        for op in [KeychainOp::Find, KeychainOp::Add, KeychainOp::Set] {
            let argv = store.argv_for(op);
            // 固定 service/account。
            assert!(argv.iter().any(|a| a == SERVICE_MAIN));
            assert!(argv.iter().any(|a| a == ACCOUNT_JWT));
            // -w 必须是独立参数（口令从 stdin 来），不得出现 "-wSOMESECRET" 形态。
            assert!(argv.iter().any(|a| a == "-w"));
            for a in &argv {
                // 只允许精确的 "-w"；任何以 -w 开头的更长参数都意味着口令被拼进命令行。
                assert!(
                    !(a.starts_with("-w") && a.len() > 2),
                    "参数 {a:?} 不得把口令拼进 -w"
                );
                assert_ne!(a, "SUPER-SECRET-PASSWORD");
            }
        }
        // 常量契约：JWT service/account 与 vault 命名空间隔离。
        assert_ne!(SERVICE_MAIN, SERVICE_VAULT_RESERVED);
        assert_eq!(ACCOUNT_JWT, "jwt-secret");
    }
}
