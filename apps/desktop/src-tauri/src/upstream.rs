//! 上游模型与 probeId 短期握手表（IMPL-0.2.5-beta §2 / §3 / §4-R1）。
//!
//! 本模块是不依赖 tauri::Builder 的纯状态层，可在 `cargo test` 下 headless 直接测；
//! 命令薄封装在 commands.rs，HTTP/WS 转发在 proxy.rs / proxy_ws.rs。
//!
//! - 当前活动上游 `Upstream` 取值 `None | Local{port} | Remote{base} | Replica{port}`，
//!   仅由 `gx:set_active_upstream` 经 [`Shared::set_upstream`] 原子替换（单活）。
//! - probeId→baseURL 表仅供「添加节点握手」短期使用：随机 id、TTL ≤120s、仅 loopback 可达
//!   （调用方只能从壳口同源 `/__gx/probe/<id>/...` 触达），base 必须是 http/https。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

/// probeId 有效期上限（IMPL §3：TTL ≤120s）。
pub const PROBE_TTL: Duration = Duration::from_secs(120);

/// 当前活动上游。切换节点只替换它，壳口端口全程不变、WebView 永不整页跳转。
#[derive(Debug, Clone, PartialEq, Eq)]
// Local(R2 #825) 与 Replica(#828) 是 §2 冻结模型的预留分支，R1 尚无构造点，不能删；
// 显式允许 dead_code 以过 -D warnings（http_base 对二者的 match 分支一并保留）。
#[allow(dead_code)]
pub enum Upstream {
    /// 无活动节点：业务前缀代理回 503 NODE_NOT_ACTIVE，前端据以回启动器。
    None,
    /// 本地内核 sidecar，口为动态 KERNEL_PORT（R2 才真正起停）。
    Local { port: u16 },
    /// 任意远端节点；base 为规范化的 http(s) origin（无尾斜杠、无凭证/query）。
    Remote { base: String },
    /// 离线副本内核（#828）。R1 仅枚举占位，转发差异本单不实现。
    Replica { port: u16 },
}

impl Upstream {
    /// 转发用的 HTTP(S) origin base；None 无上游。
    /// Local/Replica → `http://127.0.0.1:<port>`；Remote → 其规范化 base。
    pub fn http_base(&self) -> Option<String> {
        match self {
            Upstream::None => None,
            Upstream::Local { port } | Upstream::Replica { port } => {
                Some(format!("http://127.0.0.1:{port}"))
            }
            Upstream::Remote { base } => Some(base.clone()),
        }
    }

    /// 上游是否具备可连端口/地址（用于 set_active_upstream 的 local 前置判定等）。
    /// R1 非测试构建暂无调用点（测试中用于断言 None 态）；保留为 §2 公共判定。
    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        !matches!(self, Upstream::None)
    }
}

/// 一条 probe 记录：目标 base 与创建时刻（据此判 TTL 过期）。
#[derive(Debug, Clone)]
struct Probe {
    base: String,
    created: Instant,
}

/// 壳口共享状态：原子上游 + probe 表。由 main.rs 构造后 `.manage()` 进 Tauri，
/// 同时以 `Arc<Shared>` 交给 axum 服务（两条访问路径共用同一份状态）。
pub struct Shared {
    /// 当前活动上游。异步锁：命令与代理 handler 均在 tokio 上，临界区极短。
    pub upstream: AsyncMutex<Upstream>,
    /// probeId→Probe。用 std Mutex 即可：操作全是瞬时内存读写，不跨 await 持锁。
    probes: std::sync::Mutex<HashMap<String, Probe>>,
    /// probe TTL（生产 120s；测试注入短值验证过期）。
    ttl: Duration,
}

impl Shared {
    pub fn new() -> Self {
        Self::with_ttl(PROBE_TTL)
    }

    /// 仅供测试：自定义 probe TTL（过期即视为未知 id）。
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            upstream: AsyncMutex::new(Upstream::None),
            probes: std::sync::Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// 取当前上游快照（Clone，不持锁跨 await）。
    pub async fn get_upstream(&self) -> Upstream {
        self.upstream.lock().await.clone()
    }

    /// 原子替换当前上游。
    pub async fn set_upstream(&self, up: Upstream) {
        *self.upstream.lock().await = up;
    }

    /// 注册一条 probe，返回随机 probeId。base 必须是规范化 http(s) origin
    /// （调用方先经 [`normalize_http_base`] 校验）。不改变当前活动上游。
    pub fn begin_probe(&self, base: String) -> String {
        let id = random_probe_id();
        let mut probes = self.probes.lock().expect("probes lock poisoned");
        probes.insert(
            id.clone(),
            Probe {
                base,
                created: Instant::now(),
            },
        );
        id
    }

    /// 立即注销 probeId；返回是否曾命中（幂等，结束不存在的 id 不算错误）。
    pub fn end_probe(&self, id: &str) -> bool {
        self.probes
            .lock()
            .expect("probes lock poisoned")
            .remove(id)
            .is_some()
    }

    /// 查 probeId 的 baseURL；过期或未知返回 None（过期顺手清理）。
    pub fn lookup_probe(&self, id: &str) -> Option<String> {
        let mut probes = self.probes.lock().expect("probes lock poisoned");
        let expired = match probes.get(id) {
            Some(p) => p.created.elapsed() > self.ttl,
            None => return None,
        };
        if expired {
            probes.remove(id);
            return None;
        }
        probes.get(id).map(|p| p.base.clone())
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// 规范化一个 http(s) baseURL，失败返回中文错误（直接可展示）。
///
/// 规则：
/// - scheme 仅允许 http/https（其余拒绝）；
/// - 必须含 host；
/// - 只保留 origin（scheme://host[:port]），丢弃 path/query/fragment 与内嵌凭证，
///   代理转发时业务路径（/api/...）一律拼在 origin 之后；
/// - 无尾斜杠。
pub fn normalize_http_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let url = url::Url::parse(trimmed).map_err(|e| format!("节点地址无效：{e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "节点地址必须以 http:// 或 https:// 开头（收到 {other}）"
            ))
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| "节点地址缺少主机名".to_string())?;
    if host.is_empty() {
        return Err("节点地址缺少主机名".to_string());
    }
    // 拒绝内嵌用户名/密码，避免令牌被误塞进 base。
    if !url.username().is_empty() || url.password().is_some() {
        return Err("节点地址不允许包含用户名/密码，请只填 http(s)://主机:端口".to_string());
    }
    match url.port() {
        Some(port) => Ok(format!("{}://{host}:{port}", url.scheme())),
        None => Ok(format!("{}://{host}", url.scheme())),
    }
}

/// 生成 16 字节随机 probeId（32 个十六进制字符）。
///
/// 直接读 macOS/Linux 均有的 `/dev/urandom`，零新增依赖；probe 仅 loopback 可达且 TTL 120s。
fn random_probe_id() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    match std::fs::File::open("/dev/urandom") {
        Ok(mut f) => {
            if f.read_exact(&mut bytes).is_err() {
                // 极端情况下 urandom 不可读：退化为时间/进程熵（仍 loopback-only、短时有效）。
                fallback_entropy(&mut bytes);
            }
        }
        Err(_) => fallback_entropy(&mut bytes),
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
        // xorshift64*
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let r = x.wrapping_mul(0x2545F4914F6CDD1D);
        *slot = (r & 0xff) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_http_https_origin() {
        assert_eq!(
            normalize_http_base("http://192.168.31.15:3001").unwrap(),
            "http://192.168.31.15:3001"
        );
        assert_eq!(
            normalize_http_base("https://node.example.com/").unwrap(),
            "https://node.example.com"
        );
        // 丢 path/query/尾斜杠。
        assert_eq!(
            normalize_http_base("https://n.example.com/x/y?a=1#h").unwrap(),
            "https://n.example.com"
        );
        // 去空白。
        assert_eq!(
            normalize_http_base("  http://127.0.0.1:8080  ").unwrap(),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn normalize_rejects_bad_scheme_and_inputs() {
        assert!(normalize_http_base("ftp://host").is_err());
        assert!(normalize_http_base("not a url").is_err());
        assert!(normalize_http_base("http://").is_err());
        // 禁止凭证。
        assert!(normalize_http_base("http://user:pass@host:9000").is_err());
    }

    #[tokio::test]
    async fn upstream_atomic_get_set() {
        let s = Shared::new();
        assert_eq!(s.get_upstream().await, Upstream::None);
        s.set_upstream(Upstream::Local { port: 4100 }).await;
        assert_eq!(s.get_upstream().await, Upstream::Local { port: 4100 });
        assert_eq!(
            s.get_upstream().await.http_base().as_deref(),
            Some("http://127.0.0.1:4100")
        );
        s.set_upstream(Upstream::Remote {
            base: "https://r.example.com".into(),
        })
        .await;
        assert_eq!(
            s.get_upstream().await,
            Upstream::Remote {
                base: "https://r.example.com".into()
            }
        );
        s.set_upstream(Upstream::None).await;
        assert!(!s.get_upstream().await.is_active());
    }

    #[tokio::test]
    async fn probe_begin_lookup_end_lifecycle() {
        let s = Shared::new();
        let id = s.begin_probe("http://10.0.0.1:3001".into());
        assert_eq!(id.len(), 32, "probeId 应为 16 字节 hex（32 字符）");
        assert_eq!(s.lookup_probe(&id).as_deref(), Some("http://10.0.0.1:3001"));
        // 未知 id。
        assert!(s.lookup_probe("deadbeef").is_none());
        // end 命中返回 true，随后查不到。
        assert!(s.end_probe(&id));
        assert!(s.lookup_probe(&id).is_none());
        // 重复 end 幂等返回 false。
        assert!(!s.end_probe(&id));
    }

    #[tokio::test]
    async fn probe_expires_after_short_ttl() {
        let s = Shared::with_ttl(Duration::from_millis(20));
        let id = s.begin_probe("http://127.0.0.1:9".into());
        assert!(s.lookup_probe(&id).is_some());
        tokio::time::sleep(Duration::from_millis(40)).await;
        // 过期视为未知（且已被清理）。
        assert!(s.lookup_probe(&id).is_none());
        assert!(!s.end_probe(&id));
    }
}
