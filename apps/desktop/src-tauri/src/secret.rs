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
    /// 实现只负责"取到原始字符串"，不做长度/合法性判定（交给编排层自愈损坏项）。
    fn get(&self) -> Result<Option<String>, String>;
    /// 写入机密（已存在则覆盖）。机密只经 stdin / 内存，绝不进命令行参数。
    fn put(&self, secret: &str) -> Result<(), String>;
    /// 删除已存机密；不存在视为成功（幂等）。供编排层清掉损坏项后重建。
    fn delete(&self) -> Result<(), String>;
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

    /// 组装 `security` 子命令的 argv（**不含任何密钥**）。
    /// 密钥对写入通过 `-w` 独立参数触发、随后经 stdin 提供。
    /// 纯函数：供单测断言 argv 里永远不出现口令。
    fn argv_for(&self, op: KeychainOp) -> Vec<String> {
        match op {
            KeychainOp::Find => vec![
                "find-generic-password".to_string(),
                "-s".to_string(),
                self.service.clone(),
                "-a".to_string(),
                self.account.clone(),
                // find 的 -w：只把密码写到 stdout（不打印属性/弹窗元信息）。
                "-w".to_string(),
            ],
            KeychainOp::Add => vec![
                // add -U：项不存在则新建，已存在则原地更新（实测 macOS 上
                // `set-generic-password -w` 不可用——被解析成 partition-list 子命令，exit 2；
                // `add-generic-password -U` 才是更新已有项的正确姿势）。
                "add-generic-password".to_string(),
                "-U".to_string(),
                "-s".to_string(),
                self.service.clone(),
                "-a".to_string(),
                self.account.clone(),
                // add 的 -w 后【不接值】，强制 security 从 stdin 读口令，避免进 ps。
                "-w".to_string(),
            ],
            KeychainOp::Delete => vec![
                "delete-generic-password".to_string(),
                "-s".to_string(),
                self.service.clone(),
                "-a".to_string(),
                self.account.clone(),
            ],
        }
    }
}

#[derive(Clone, Copy)]
enum KeychainOp {
    Find,
    Add,
    Delete,
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
            // 这里不做长度判定：过短值视为"损坏的已存项"，交给 ensure_jwt_secret 自愈
            // （delete 后重建），而不是把用户卡死在必须手动开钥匙串访问删项的境地。
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
        // 统一走 add-generic-password -U（不存在则建，已存在则更新）；实测此版 macOS 上
        // set-generic-password -w 不可用，-U 是官方支持的 upsert 姿势。
        self.run_write(KeychainOp::Add, secret)
    }

    fn delete(&self) -> Result<(), String> {
        let output = Command::new(&self.security_bin)
            .args(self.argv_for(KeychainOp::Delete))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("无法调用系统钥匙串工具 security：{e}"))?;
        // 幂等：项不存在（退出码 44）也视为成功。
        if output.status.success() || output.status.code() == Some(SEC_ERR_ITEM_NOT_FOUND) {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "删除钥匙串密钥失败（code={:?}）：{err}",
                output.status.code()
            ))
        }
    }
}

impl KeychainStore {
    fn run_write(&self, op: KeychainOp, secret: &str) -> Result<(), String> {
        let mut child = Command::new(&self.security_bin)
            .args(self.argv_for(op))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法调用系统钥匙串工具 security：{e}"))?;
        // 关键：`security add-generic-password -w`（-w 不接值）进入交互式【二次确认】——
        // 先读 "password data for new item"，再读 "retype password"，两行不一致就判
        // "passwords don't match"（但仍 exit 0，会留下一个空/截断密码项！）。故必须把同一
        // 口令经 stdin 喂【两次】，每次以换行结束。口令绝不出现在 argv / ps。
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(secret.as_bytes());
            let _ = stdin.write_all(b"\n");
            let _ = stdin.write_all(secret.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("等待钥匙串写入失败：{e}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "写入钥匙串密钥失败（code={:?}）",
            output.status.code()
        ))
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
        if existing.len() >= JWT_LEN {
            return Ok(SecretOutcome {
                secret: existing,
                source: SecretSource::Existing,
                legacy_deleted: false,
            });
        }
        // 已存项过短＝损坏（如旧版 put 只喂一次确认值，被 security 双确认写成空项）。
        // 自愈：删掉损坏项后落到下方迁移/新建分支重建，避免把用户卡在"手动开钥匙串删项"。
        store.delete()?;
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
    fn delete(&self) -> Result<(), String> {
        *self.inner.lock().expect("mem secret lock") = None;
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

    /// 可控的内存 store：可预置"损坏的过短已存项"，并记录 delete 调用次数。
    struct CorruptibleStore {
        inner: std::sync::Mutex<Option<String>>,
        deletes: std::sync::atomic::AtomicU32,
    }
    impl CorruptibleStore {
        fn preloaded(v: &str) -> Self {
            Self {
                inner: std::sync::Mutex::new(Some(v.to_string())),
                deletes: 0.into(),
            }
        }
    }
    impl SecretStore for CorruptibleStore {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(self.inner.lock().unwrap().clone())
        }
        fn put(&self, secret: &str) -> Result<(), String> {
            *self.inner.lock().unwrap() = Some(secret.to_string());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            self.deletes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *self.inner.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn corrupted_short_secret_is_deleted_and_recreated() {
        // 已存项过短（损坏）：必须 delete 后重新创建 48 字符新密钥，而不是沿用或报错卡死。
        let store = CorruptibleStore::preloaded("");
        let legacy = temp_legacy_path("corrupt");
        let _ = std::fs::remove_file(&legacy);
        let out = ensure_jwt_secret(&store, &legacy).expect("损坏项应自愈成功");
        assert_eq!(out.source, SecretSource::Created);
        assert_eq!(out.secret.len(), JWT_LEN);
        assert_eq!(
            store.deletes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "应删除一次损坏项"
        );
        let _ = std::fs::remove_file(&legacy);
    }

    #[test]
    fn keychain_argv_never_carries_secret_and_w_is_standalone() {
        let store = KeychainStore::jwt();
        // Find：带独立 -w；Add：add -U 且带独立 -w（upsert，口令走 stdin 双确认）；
        // Delete：无 -w（删除不需要口令）。
        let find = store.argv_for(KeychainOp::Find);
        assert!(find.contains(&"-w".to_string()));
        assert!(find.iter().all(|a| !(a.starts_with("-w") && a.len() > 2)));

        let add = store.argv_for(KeychainOp::Add);
        assert!(add.contains(&"-U".to_string()), "写入须用 add -U upsert");
        assert!(add.contains(&"-w".to_string()));
        assert!(add.iter().all(|a| !(a.starts_with("-w") && a.len() > 2)));
        assert!(add.iter().any(|a| a == SERVICE_MAIN));
        assert!(add.iter().any(|a| a == ACCOUNT_JWT));

        let delete = store.argv_for(KeychainOp::Delete);
        assert!(!delete.contains(&"-w".to_string()), "删除不带 -w");
        assert!(delete[0].contains("delete-generic-password"));

        for argv in [find, add, delete] {
            for a in &argv {
                assert_ne!(a, "SUPER-SECRET-PASSWORD");
            }
        }
        // 常量契约：JWT service/account 与 vault 命名空间隔离。
        assert_ne!(SERVICE_MAIN, SERVICE_VAULT_RESERVED);
        assert_eq!(ACCOUNT_JWT, "jwt-secret");
    }
}
