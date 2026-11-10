//! 本地内核 sidecar 生命周期托管（IMPL-0.2.5-beta §4-R2 / #825 / #846）。
//!
//! 取代 PoC 的「只起不停、无条件 spawn」：把随包 Node 内核做成可命令式
//! start / stop / status 的托管结构，只绑 `127.0.0.1`，独立进程组，停即整组优雅收尸。
//!
//! 分层（为了让整条生命周期能在 `cargo test` 下 headless 真实跑通，而不依赖 Tauri Builder
//! 或随包 Node 产物）：
//!   - [`StartPlan`]：一个要拉起的进程的纯描述（程序/参数/cwd/环境）。
//!   - [`KernelPlanner`]：产出启动计划。生产实现 [`LocalKernelPlanner`]【每次启动】都先做
//!     Keychain JWT→`migrate deploy`→`nav-reconcile`（0.3.0 P0：覆盖升级转圈根治，迁移幂等只增），
//!     再给出跑 `dist/index.js` 的常驻计划；常驻 env 经 extra_daemon_env 注入授权 + 同步服务端门，
//!     两子进程不接 extra env。测试用「真 node 跑内联假内核」的计划，验证 spawn/进程组/readyz/收尸全链路。
//!   - [`SidecarManager`]：与「是什么内核」无关的进程生命周期 + `/readyz` 轮询 + 进程组停止。
//!
//! 安全/纪律：
//!   - 只绑回环：计划与端口探测都固定 `127.0.0.1`，绝不监听 0.0.0.0。
//!   - stop 只发信号、等退出，**绝不删数据目录/dev.db**。
//!   - SIGTERM 打整个进程组（node 是组首），≤grace 未退再 SIGKILL，避免孤儿 node。
//!   - 不引新依赖：HTTP 探活手写 1.0 请求，信号走 libc `kill`，与 PoC 一致（aws-lc-rs=0）。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
#[cfg(test)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::secret::{ensure_jwt_secret, KeychainStore, SecretStore, SERVICE_MAIN};
use crate::upstream::normalize_http_base;

/// 随包 Node 可执行名（Apple Silicon）。
const NODE_BIN: &str = "gxnode-aarch64-apple-darwin";
/// 随包内核目录名（resource_dir 下）。
const SERVER_DIR: &str = "server";

/// readyz 轮询默认上限（生产）。内核 migrate 已在 spawn 前同步跑完，listen+探针通常秒级。
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(40);
/// stop 优雅等待默认上限（生产，IMPL §3：≤8s 后 SIGKILL）。
const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(8);
/// readyz 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(150);

/// 副本定时间隔缺省值（毫秒），与内核 configReplica.ts REPLICA_DEFAULT_INTERVAL_MS 对齐。
const REPLICA_DEFAULT_INTERVAL_MS: u64 = 30_000;
/// 副本定时间隔下限（毫秒），与内核 REPLICA_MIN_INTERVAL_MS 对齐（防把远端打爆）。
const REPLICA_MIN_INTERVAL_MS: u64 = 5_000;
/// 副本节点 ID 长度上限（目录名/钥匙串 account 片段）。
const REPLICA_NODE_ID_MAX_LEN: usize = 64;
/// 副本数据目录在主数据目录下的子目录名。
const REPLICAS_SUBDIR: &str = "replicas";
/// 缺省副本 clientId（内核同口径 local-replica）。
const REPLICA_DEFAULT_CLIENT_ID: &str = "local-replica";

/// 一个内核进程的纯启动描述。安全敏感：环境变量里携带 JWT（子进程 env，不进 `ps` 参数）。
pub struct StartPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

// 手动 Debug：env 可能携带 JWT_SECRET，绝不能被 `{:?}` 原样打进日志；只打印键名、隐去值。
impl std::fmt::Debug for StartPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartPlan")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field(
                "env_keys",
                &self.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// 产出内核启动计划；首 boot 的有副作用编排（migrate/JWT）在 [`KernelPlanner::plan`] 内完成。
pub trait KernelPlanner: Send + Sync {
    /// 数据目录（status 的 added 判定、首 boot 判定都看它）。
    fn data_dir(&self) -> &Path;

    /// 在已选定回环端口 `port` 后，完成首 boot 步骤并返回常驻内核的启动计划。
    /// 阻塞调用（migrate 同步执行）；生产在 spawn_blocking 线程中跑。
    fn plan(&self, port: u16) -> Result<StartPlan, String>;
}

/// 一个正在运行的内核子进程。
struct Running {
    child: Child,
    pid: u32,
    port: u16,
}

/// 内核托管器：`Mutex<Option<Running>>` 保证单活、可重复幂等起停。
pub struct SidecarManager {
    inner: Mutex<Option<Running>>,
    ready_timeout: Duration,
    stop_grace: Duration,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self::with_timeouts(DEFAULT_READY_TIMEOUT, DEFAULT_STOP_GRACE)
    }

    /// 测试用：缩短 ready 超时与 stop 优雅等待。
    pub fn with_timeouts(ready_timeout: Duration, stop_grace: Duration) -> Self {
        Self {
            inner: Mutex::new(None),
            ready_timeout,
            stop_grace,
        }
    }

    /// 当前是否有「仍存活」的子进程。顺带回收已退出的僵尸并清空句柄。
    fn reap_if_dead(&self) -> Option<(u32, u16)> {
        let mut g = self.inner.lock().expect("sidecar lock poisoned");
        if let Some(running) = g.as_mut() {
            match running.child.try_wait() {
                // 仍在跑：返回 pid/port。
                Ok(None) => return Some((running.pid, running.port)),
                // 已退出：回收，落回 None（不清任何数据）。
                Ok(Some(_status)) => {
                    let pid = running.pid;
                    *g = None;
                    crate::dbg_log(&format!("sidecar {pid} 已自行退出，已回收句柄"));
                    return None;
                }
                Err(e) => {
                    crate::dbg_log(&format!("sidecar try_wait 出错（按在跑处理）: {e}"));
                    return Some((running.pid, running.port));
                }
            }
        }
        None
    }

    /// 幂等启动：已在跑则直接返回现有端口；否则按 planner 起新内核并轮询 readyz。
    /// 阻塞（含 migrate 与轮询）；调用方应放在 spawn_blocking 线程。
    pub fn start<P: KernelPlanner>(&self, planner: &P) -> Result<u16, String> {
        // 幂等：已存活直接返回端口，绝不重复建库/重复 spawn。
        if let Some((_pid, port)) = self.reap_if_dead() {
            return Ok(port);
        }

        // 先选一个空闲回环端口（绑 127.0.0.1:0 拿实际口，立即释放交给内核）。
        let port = free_loopback_port()?;

        // planner.plan 在首 boot 时跑 migrate/nav/JWT（spawn 之前失败=数据未动/已留备份）。
        let plan = planner.plan(port)?;

        // spawn：独立进程组（组首=内核 pid），stdout/stderr 丢弃（PoC2 日志门控不在本路径）。
        let mut cmd = Command::new(&plan.program);
        cmd.args(&plan.args)
            .current_dir(&plan.cwd)
            .envs(plan.env)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("启动本地内核失败：{e}"))?;
        let pid = child.id();
        crate::dbg_log(&format!("sidecar spawned pid={pid} port={port}"));

        // 轮询：进程先死=启动失败（立即返回，不傻等超时）；readyz 200=就绪。
        let deadline = Instant::now() + self.ready_timeout;
        let mut ready = false;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "本地内核提前退出（退出码 {status}），请查看内核日志"
                    ));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("检查本地内核进程失败：{e}")),
            }
            if readyz_is_ready(port) {
                ready = true;
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        if !ready {
            // 超时未就绪：杀掉整组，避免起了个半死的孤儿。
            kill_group(pid, libc_signal::TERM);
            std::thread::sleep(Duration::from_millis(300));
            kill_group(pid, libc_signal::KILL);
            let _ = child.wait();
            return Err(format!(
                "本地内核在 {:.0}s 内未就绪（/readyz 未通过）",
                self.ready_timeout.as_secs_f64()
            ));
        }

        let port_out = port;
        *self.inner.lock().expect("sidecar lock poisoned") = Some(Running { child, pid, port });
        crate::dbg_log(&format!("sidecar ready pid={pid} port={port}"));
        Ok(port_out)
    }

    /// 优雅停止：SIGTERM 整组 → 等 ≤grace → 仍在则 SIGKILL。**不删任何数据。** 返回是否曾在跑。
    /// 幂等：没在跑返回 Ok(false)。
    pub fn stop(&self) -> Result<bool, String> {
        let running = self.inner.lock().expect("sidecar lock poisoned").take();
        let Some(mut running) = running else {
            return Ok(false);
        };
        let pid = running.pid;
        kill_group(pid, libc_signal::TERM);

        let deadline = Instant::now() + self.stop_grace;
        let mut exited = false;
        while Instant::now() < deadline {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        if !exited {
            crate::dbg_log(&format!("sidecar {pid} 优雅停止超时，SIGKILL 进程组"));
            kill_group(pid, libc_signal::KILL);
        }
        // 必须 wait 回收，避免僵尸；KILL 后子进程应很快可回收。
        match running.child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = running.child.wait();
            }
        }
        crate::dbg_log(&format!("sidecar stopped pid={pid}（数据保留）"));
        Ok(true)
    }

    /// 若有存活进程，返回其端口（不打 readyz、不查文件系统；供切上游 local 前置判定）。
    pub fn running_port(&self) -> Option<u16> {
        self.reap_if_dead().map(|(_pid, port)| port)
    }

    /// 当前内核状态（§3：added/initialized/running/ready/kernelPort）。
    pub fn status<P: KernelPlanner>(&self, planner: &P) -> LocalStatus {
        self.status_for_dir(planner.data_dir())
    }

    /// 按显式数据目录取状态（副本 status 用：只有 nodeId、无远端 URL，不应为判状态伪造 planner，
    /// 也不应因此创建目录）。`running/ready/kernel_port` 仍来自本托管器单槽，与节点无关；
    /// `added/initialized` 看给定目录下是否有 `dev.db`。
    pub fn status_for_dir(&self, data_dir: &Path) -> LocalStatus {
        let added = is_added(data_dir);
        match self.reap_if_dead() {
            Some((_pid, port)) => {
                let ready = readyz_is_ready(port);
                LocalStatus {
                    added,
                    initialized: added,
                    running: true,
                    ready,
                    kernel_port: Some(port),
                }
            }
            None => LocalStatus {
                added,
                initialized: added,
                running: false,
                ready: false,
                kernel_port: None,
            },
        }
    }

    /// 仅供退出收尸用：若在跑则按给定超时优雅停（App 退出/更新重启路径）。
    pub fn shutdown_if_running(&self, grace: Duration) {
        // 退出路径用调用方给的预算（通常比交互式 stop 更短），直接发信号+wait，不改共享配置。
        let running = self.inner.lock().expect("sidecar lock poisoned").take();
        if let Some(mut running) = running {
            let pid = running.pid;
            kill_group(pid, libc_signal::TERM);
            let deadline = Instant::now() + grace;
            let mut exited = false;
            while Instant::now() < deadline {
                if matches!(running.child.try_wait(), Ok(Some(_))) {
                    exited = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !exited {
                kill_group(pid, libc_signal::KILL);
            }
            let _ = running.child.wait();
        }
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// `gx:local_status` 返回（camelCase 序列化对齐 §3）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub added: bool,
    pub initialized: bool,
    pub running: bool,
    pub ready: bool,
    pub kernel_port: Option<u16>,
}

/// 本地节点是否曾添加 / 库是否已初始化：数据目录下存在 `dev.db`。
fn is_added(data_dir: &Path) -> bool {
    data_dir.join("dev.db").is_file()
}

/// 校验并规整副本节点 ID（用作隔离目录名与钥匙串 account 片段）。
///
/// 规则（fail-closed，任何不满足都返回中文错误）：
/// - trim 后非空，长度 1..=64；
/// - 仅允许 `[A-Za-z0-9._-]`（由此天然拒绝 `/`、`\`、`:`、NUL 等任何路径分隔/逃逸字符）；
/// - 拒绝整体等于 `.` 或 `..`（点段逃逸）；`a..b` 这类含连续点但非点段的名字放行。
///
/// 因为白名单已排除路径分隔符，节点名在拼接时只能是【单个目录段】，无法跨目录。
pub fn sanitize_node_id(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("节点 ID 不能为空".to_string());
    }
    if name.len() > REPLICA_NODE_ID_MAX_LEN {
        return Err(format!(
            "节点 ID 长度不能超过 {REPLICA_NODE_ID_MAX_LEN} 个字符（当前 {}）",
            name.len()
        ));
    }
    if name == "." || name == ".." {
        return Err("节点 ID 不能是 \".\" 或 \"..\"".to_string());
    }
    if let Some(ch) = name
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-'))
    {
        return Err(format!(
            "节点 ID 仅允许字母、数字、点、下划线、连字符（收到非法字符 {ch:?}）"
        ));
    }
    Ok(name.to_string())
}

/// 计算某节点副本的隔离数据目录路径：`<base_data_dir>/replicas/<sanitized_node>/`。
///
/// 纯函数：只做 [`sanitize_node_id`] + 单段 join，**不创建目录、不触碰文件系统**。
/// 因白名单已排除路径分隔符，结果恒为 replicas/ 下的单段名，不存在逃逸。
/// 供 status 等只读路径使用（不应为"看一眼状态"而建目录）。
pub fn replica_data_path(base_data_dir: &Path, node: &str) -> Result<PathBuf, String> {
    let name = sanitize_node_id(node)?;
    Ok(base_data_dir.join(REPLICAS_SUBDIR).join(name))
}

/// 计算并确保某节点副本的隔离数据目录存在：`<base_data_dir>/replicas/<sanitized_node>/`。
///
/// 除了[`sanitize_node_id`]的字符级防护，再做一次文件系统级的 canonicalize 前缀断言，
/// 纵深防御符号链接等把目录指到 `replicas/` 之外的情况。返回的路径已 canonicalize。
pub fn replica_data_dir(base_data_dir: &Path, node: &str) -> Result<PathBuf, String> {
    let target = replica_data_path(base_data_dir, node)?;
    let replicas_root = base_data_dir.join(REPLICAS_SUBDIR);
    // 先建根与目标，canonicalize 才有落点。
    std::fs::create_dir_all(&target).map_err(|e| format!("创建副本数据目录失败：{e}"))?;
    let canon_root = replicas_root
        .canonicalize()
        .map_err(|e| format!("解析副本根目录失败：{e}"))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("解析副本数据目录失败：{e}"))?;
    if !canon_target.starts_with(&canon_root) {
        // 命中符号链接逃逸等异常：拒绝并报中文错误，绝不据此外泄到根外目录。
        return Err(format!(
            "副本数据目录逃逸异常：{} 不在 {} 之下",
            canon_target.display(),
            canon_root.display()
        ));
    }
    Ok(canon_target)
}

/// 绑一个空闲回环端口并立即释放，返回端口号。存在极小竞态（释放后被抢），
/// 但回环临时口 + 立刻 listen，实测可忽略；内核 listen 失败会在 readyz 轮询中暴露。
fn free_loopback_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("分配本地回环端口失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取本地端口失败：{e}"))?
        .port();
    Ok(port)
}

/// 探活：GET http://127.0.0.1:<port>/readyz 返回 200（五探针全绿）即就绪。
/// 任何连接失败/非 200 都算未就绪（轮询会重试）。
fn readyz_is_ready(port: u16) -> bool {
    probe_http_200(port, "/readyz")
}

/// 最小 HTTP/1.0 GET：连接回环、发请求、读首行状态码。零依赖、短超时。
fn probe_http_200(port: u16, path: &str) -> bool {
    let mut stream = match TcpStream::connect_timeout(
        &std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            port,
        ),
        Duration::from_millis(800),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    // 只读开头即可判状态码；读到 EOF 或拿满首段。
    if let Ok(n) = stream.read(&mut chunk) {
        if n == 0 {
            return false;
        }
        buf.extend_from_slice(&chunk[..n]);
    } else {
        return false;
    }
    let head = String::from_utf8_lossy(&buf);
    // 状态行形如 "HTTP/1.1 200 OK"。
    head.lines()
        .next()
        .map(|l| l.contains(" 200"))
        .unwrap_or(false)
}

/// 最小 HTTP/1.0 GET：在状态码为 200 时返回**响应体**字符串（供读 `/api/auth/bootstrap-status`
/// 的 `{initialized}`）。连接失败 / 非 200 / 空体 / 体过大一律返回 `None`（调用方据此回退到
/// dev.db 判定）。零依赖、短超时；发 `Connection: close`，读到对端 EOF 即完整响应。
pub fn http_get_200_body(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect_timeout(
        &std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
            port,
        ),
        Duration::from_millis(800),
    )
    .ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;

    // 读到 EOF（对端 close），64KiB 上盖（bootstrap 体仅几十字节）。
    let mut all = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                all.extend_from_slice(&chunk[..n]);
                if all.len() > 64 * 1024 {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&all);
    let status_line = text.lines().next()?;
    if !status_line.contains(" 200") {
        return None;
    }
    // 仅取头/体分隔后的 body（弃去响应头，不做 chunked 解码——close 定界、Hono 带 Content-Length）。
    let sep = text.find("\r\n\r\n")?;
    let body = text[sep + 4..].trim();
    if body.is_empty() {
        return None;
    }
    Some(body.to_string())
}

mod libc_signal {
    pub const TERM: i32 = 15;
    pub const KILL: i32 = 9;
}

/// 按【进程组】发信号（负 pid = pgid，spawn 时组首=内核 pid）。
/// 组发失败退回直发进程。unsafe 仅一个 kill syscall（与 PoC 同一手法）。
fn kill_group(pid: u32, sig: i32) {
    let pid = pid as i32;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        let r = kill(-pid, sig);
        if r != 0 {
            let _ = kill(pid, sig);
        }
    }
}

// ───────────────────────── 生产 planner：随包 Node 内核 ─────────────────────────

/// 本地节点（主库）内核规划器：resource_dir（随包 node/server）+ data_dir（Application Support）。
/// JWT 走 macOS 钥匙串（[`KeychainStore`]），旧 `.jwt-secret` 文件一次性迁入后删除。
pub struct LocalKernelPlanner {
    resource_dir: PathBuf,
    data_dir: PathBuf,
    secrets: std::sync::Arc<dyn SecretStore>,
}

impl LocalKernelPlanner {
    pub fn new(resource_dir: PathBuf, data_dir: PathBuf) -> Self {
        Self::with_secret_store(
            resource_dir,
            data_dir,
            std::sync::Arc::new(KeychainStore::jwt()),
        )
    }

    /// 测试/PoC：注入自定义 SecretStore（如内存或临时 service）。
    pub fn with_secret_store(
        resource_dir: PathBuf,
        data_dir: PathBuf,
        secrets: std::sync::Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            resource_dir,
            data_dir,
            secrets,
        }
    }
}

impl KernelPlanner for LocalKernelPlanner {
    fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn plan(&self, port: u16) -> Result<StartPlan, String> {
        // 主库【常驻内核】专属环境变量：不注入任何副本同步变量，但带两类必须通电的开关。
        // 这些变量只经 extra_daemon_env 进入常驻 dist/index.js，绝不进 migrate/nav 子进程
        // （build_kernel_plan 已保证两子进程不接 extra env），避免迁移期触发网络/授权。
        //
        // (A) 商业授权 4 枚（0.3.0 通电）：桌面单机的本地侧车就是授权客户端，否则侧车按默认
        //     off 启动、零心跳零闸门，桌面端直接绕过商业授权。
        //  - URL：正式授权中心（与内置生产公钥 ff02db72 配套，dist 须 GX_LICENSE_PROD=1 构建）；
        //  - MODE：首发 verify（全通电、闸门只提示不锁人）；dataDir 放 license.mode=enforce 可热切；
        //  - PLATFORM/PACKAGE_TYPE：desktop/dmg，心跳枚举须精确匹配授权中心 zod 校验。
        //
        // (B) 同步服务端总门 1 枚（0.3.1 通电，#1294）：主库内核在「自指单机」或「被其它副本
        //     订阅为远端」时就是同步服务端面。GX_SYNC_SERVER 默认 off 时 routes/v1/sync 整组
        //     在任何 DB 访问前短路 404、不建表——这正是离线同步长期「功能在包里却用不起来」的
        //     真正堵点。注入规范值 on（configSync 的 parseSyncServerFlag 会 trim+小写化后认
        //     on/true/1，大小写/首尾空白不敏感，其余值一律关），per-request 读 env、不进冻结快照。
        //     【绝不能】加进 ReplicaKernelPlanner::daemon_env：副本是纯客户端，
        //     其服务端门必须保持 off，只发出站订阅、不开放被订阅面。
        let local_daemon_env: Vec<(String, String)> = vec![
            (
                "GX_LICENSE_URL".to_string(),
                "https://gouxiang.hn.takin.cc".to_string(),
            ),
            ("GX_LICENSE_MODE".to_string(), "verify".to_string()),
            ("GX_LICENSE_PLATFORM".to_string(), "desktop".to_string()),
            ("GX_PACKAGE_TYPE".to_string(), "dmg".to_string()),
            ("GX_SYNC_SERVER".to_string(), "on".to_string()),
        ];
        build_kernel_plan(
            &self.resource_dir,
            &self.data_dir,
            self.secrets.as_ref(),
            port,
            &local_daemon_env,
        )
    }
}

// ─────────────────────── 离线副本（replica）内核规划器 ───────────────────────

/// 副本连远端所需的规整配置（fail-closed：URL/节点非法在构造期即报错）。
///
/// `token` 是机密：只允许进入 [`StartPlan`] 的子进程 env，绝不进 argv / 日志 / 命令返回体；
/// [`StartPlan`] 的手动 Debug 只打 env 键名，单测另断言 `{:?}` 不含令牌明文。
pub struct ReplicaRemote {
    /// 已规范化为 origin（无 path/尾斜杠/内嵌凭证）的远端地址。
    base_url: String,
    /// 远端访问令牌（X-GX-Token），trim 后可空。
    token: String,
    /// 定时间隔毫秒（None→30000，已夹下限 5000）。
    interval_ms: u64,
    /// 已 sanitize 的节点 ID（同时是隔离目录段/钥匙串 account 片段）。
    node_id: String,
    /// 本机直写 clientId（空→local-replica）。
    client_id: String,
}

impl ReplicaRemote {
    /// 校验并规整副本远端配置。
    ///
    /// - `raw_url`：经 [`normalize_http_base`] 校验，空/非 http(s) 直接中文报错（fail-closed）；
    /// - `token`：trim 后保存，允许空串；
    /// - `node_id`：经 [`sanitize_node_id`] 校验（决定隔离目录与钥匙串 account）；
    /// - `client_id`：None/trim 后空 → `local-replica`；
    /// - `interval_ms`：None → 30000；Some 夹下限 5000（与内核 parseReplicaIntervalMs 同口径）。
    pub fn new(
        raw_url: &str,
        token: &str,
        node_id: &str,
        client_id: Option<&str>,
        interval_ms: Option<u64>,
    ) -> Result<Self, String> {
        let base_url = normalize_http_base(raw_url)?;
        let node = sanitize_node_id(node_id)?;
        let cid = client_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(REPLICA_DEFAULT_CLIENT_ID);
        let interval = interval_ms
            .map(|v| v.max(REPLICA_MIN_INTERVAL_MS))
            .unwrap_or(REPLICA_DEFAULT_INTERVAL_MS);
        Ok(Self {
            base_url,
            token: token.trim().to_string(),
            interval_ms: interval,
            node_id: node,
            client_id: cid.to_string(),
        })
    }

    /// 已 sanitize 的节点 ID（只读暴露给 planner 建隔离目录/钥匙串 account）。
    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    /// 副本内核【常驻主进程】额外环境变量（6 枚）。
    ///
    /// 这些变量**只**注入常驻 `dist/index.js`，绝不进 prisma migrate / nav-reconcile 子进程
    /// （见 [`build_kernel_plan`] 中两子进程不接 `extra_daemon_env`），避免迁移期触发任何同步网络。
    fn daemon_env(&self) -> Vec<(String, String)> {
        vec![
            // 捕获总门：精确小写 on（configOfflineReplica 仅认 on/true/1）。
            ("GX_OFFLINE_REPLICA".to_string(), "on".to_string()),
            ("GX_REPLICA_REMOTE_URL".to_string(), self.base_url.clone()),
            // 令牌只在子进程 env；StartPlan 手动 Debug 不打值。
            ("GX_REPLICA_REMOTE_TOKEN".to_string(), self.token.clone()),
            (
                "GX_OFFLINE_SYNC_INTERVAL_MS".to_string(),
                self.interval_ms.to_string(),
            ),
            ("GX_OFFLINE_NODE_ID".to_string(), self.node_id.clone()),
            ("GX_OFFLINE_CLIENT_ID".to_string(), self.client_id.clone()),
        ]
    }
}

/// 离线副本内核规划器：与主库共用同一随包 node/server，但 data_dir 为按节点隔离的
/// `<base>/replicas/<node>/`，JWT 用独立钥匙串 account `replica-jwt:<node>`，常驻 env 追加 6 副本变量。
pub struct ReplicaKernelPlanner {
    resource_dir: PathBuf,
    data_dir: PathBuf,
    secrets: std::sync::Arc<dyn SecretStore>,
    remote: ReplicaRemote,
}

impl ReplicaKernelPlanner {
    /// 生产构造：由 base_data_dir 解析出隔离目录，钥匙串 account 按节点独立。
    pub fn new(
        resource_dir: PathBuf,
        base_data_dir: &Path,
        remote: ReplicaRemote,
    ) -> Result<Self, String> {
        let data_dir = replica_data_dir(base_data_dir, remote.node_id())?;
        let account = format!("replica-jwt:{}", remote.node_id());
        let secrets = std::sync::Arc::new(KeychainStore::new(SERVICE_MAIN, &account));
        Ok(Self::with_secret_store(
            resource_dir, data_dir, secrets, remote,
        ))
    }

    /// 构造并注入自定义 SecretStore（生产由 [`Self::new`] 传入按节点独立的钥匙串；
    /// 测试注入内存 store）。
    pub fn with_secret_store(
        resource_dir: PathBuf,
        data_dir: PathBuf,
        secrets: std::sync::Arc<dyn SecretStore>,
        remote: ReplicaRemote,
    ) -> Self {
        Self {
            resource_dir,
            data_dir,
            secrets,
            remote,
        }
    }
}

impl KernelPlanner for ReplicaKernelPlanner {
    fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn plan(&self, port: u16) -> Result<StartPlan, String> {
        build_kernel_plan(
            &self.resource_dir,
            &self.data_dir,
            self.secrets.as_ref(),
            port,
            &self.remote.daemon_env(),
        )
    }
}

/// 子进程失败时，从其 stdout/stderr 抽取尾部文本用于错误上报（限长，避免巨量日志刷屏）。
fn tail_process_output(stdout: &[u8], stderr: &[u8]) -> String {
    const MAX_CHARS: usize = 800;
    let mut combined = String::new();
    let push = |buf: &[u8], out: &mut String| {
        if let Ok(s) = String::from_utf8(Vec::from(buf)) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(trimmed);
            }
        }
    };
    // 报错信息通常在 stderr；stdout 补充 prisma 的迁移进度。
    push(stderr, &mut combined);
    push(stdout, &mut combined);
    if combined.is_empty() {
        return "（迁移进程无输出）".to_string();
    }
    if combined.chars().count() > MAX_CHARS {
        let keep: String = combined
            .chars()
            .skip(combined.chars().count() - MAX_CHARS)
            .collect();
        format!("…{keep}")
    } else {
        combined
    }
}

/// 主库 / 副本共用的内核启动编排骨架。
///
/// 顺序：预检随包 node 与 dist → 建 data_dir/uploads/.audit/backups → 冷备已有 dev.db →
/// 取/迁/建 JWT（钥匙串按 `secrets` 区分主库/副本命名空间）→【每次启动】都跑
/// `prisma migrate deploy`（幂等，修 0.3.0 覆盖升级不迁移的 P0）与 `nav-reconcile --apply`
/// （两者均**不带** `extra_daemon_env`，故迁移子进程永不携带副本/授权变量）→ 产出常驻
/// `dist/index.js` 计划，其 env 在公共变量后追加 `extra_daemon_env`（副本为 6 枚同步变量，
/// 主库为 4 枚 GX_LICENSE_* 商业授权变量）。
fn build_kernel_plan(
    resource_dir: &Path,
    data_dir: &Path,
    secrets: &dyn SecretStore,
    port: u16,
    extra_daemon_env: &[(String, String)],
) -> Result<StartPlan, String> {
    let node = resource_dir.join(NODE_BIN);
    let server = resource_dir.join(SERVER_DIR);
    if !node.exists() {
        return Err(format!("随包 Node 缺失：{}", node.display()));
    }
    if !server.join("dist/index.js").exists() {
        return Err(format!("内核程序缺失：{}/dist/index.js", server.display()));
    }

    std::fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let uploads = data_dir.join("uploads");
    let audit = data_dir.join(".audit");
    // 桌面端备份根：必须显式注入可写目录。否则内核 config 在 NODE_ENV=production 下
    // 默认落到 Linux 的 /var/backups/gouxiangdb（config.ts），macOS 非 root 不可写，
    // 启动期 scopeBackfillBoot 写一致性快照 EACCES → 为保护数据跳过权限投影自愈。
    // 与 fpk cmd/main 的 BACKUP_DIR=$DATA_DIR/backups 保持同一约定。
    let backups = data_dir.join("backups");
    std::fs::create_dir_all(&uploads).ok();
    std::fs::create_dir_all(&audit).ok();
    std::fs::create_dir_all(&backups).ok();

    let db_path = data_dir.join("dev.db");
    let first_boot = !db_path.exists();

    // 已有库：首启前冷备（sidecar 尚未起，纯文件拷贝；迁移只增不删，双保险）。
    if !first_boot {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bak = data_dir.join(format!("dev.db.{stamp}.bak"));
        if let Err(e) = std::fs::copy(&db_path, &bak) {
            // 冷备失败不阻断（迁移只增），但明确告知日志。
            crate::dbg_log(&format!("WARN 冷备 dev.db 失败（继续）: {e}"));
        }
    }

    // JWT：钥匙串优先 → 迁移旧 .jwt-secret → 新建。仅首 boot 首次会触发系统授权弹窗。
    let legacy = data_dir.join(".jwt-secret");
    let outcome = ensure_jwt_secret(secrets, &legacy)
        .map_err(|e| format!("准备本地密钥失败：{e}"))?;
    crate::dbg_log(&format!(
        "JWT 来源: {:?}（legacy 删除={}）",
        outcome.source, outcome.legacy_deleted
    ));
    let jwt_secret = outcome.secret;

    let common_env: Vec<(String, String)> = vec![
        ("NODE_ENV".into(), "production".into()),
        ("GX_BIND_HOST".into(), "127.0.0.1".into()),
        (
            "CORS_ORIGIN".into(),
            "http://127.0.0.1:*,http://localhost:*".into(),
        ),
    ];
    let database_url = format!("file:{}", db_path.display());

    // 升级迁移修复（0.3.0 事故，P0）：旧实现仅在库文件不存在（首装）时迁移，导致
    // 0.2.7→0.3.0 覆盖升级时真机库停在旧迁移，/readyz 的 migrations 探针恒 503 →
    // 壳轮询失败后杀死新内核 → 前端永久转圈。现改为【每次启动都先 migrate deploy】：
    // 已应用迁移自动跳过（天然幂等），迁移只增不删且上方已对存量库冷备，故对已是最新的
    // 库零副作用、可回滚。两个子进程都【不】接 extra_daemon_env：migrate/nav 期间绝不携带
    // 副本同步变量（与原首 boot 约束一致）。
    // 1) migrate deploy（只增不删）。抓 stdout/stderr：失败时把 prisma 真实报错尾部带进 Err
    //    （否则真机只看到「退出码 1」，无法定位锁冲突/脏迁移等具体原因）。
    let migrate_out = Command::new(&node)
        .current_dir(&server)
        .arg("node_modules/prisma/build/index.js")
        .arg("migrate")
        .arg("deploy")
        .arg("--schema=prisma/schema.prisma")
        .env("DATABASE_URL", &database_url)
        .env("GX_DATA_DIR", data_dir)
        .envs(common_env.clone())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("启动数据库迁移失败：{e}"))?;
    if !migrate_out.status.success() {
        let detail = tail_process_output(&migrate_out.stdout, &migrate_out.stderr);
        crate::dbg_log(&format!(
            "migrate deploy 失败 {:?}：{detail}",
            migrate_out.status.code()
        ));
        return Err(format!(
            "数据库迁移失败（退出码 {}，旧库与备份均已保留）。{detail}",
            migrate_out
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ));
    }
    if first_boot {
        crate::dbg_log("首装迁移完成（migrate deploy）");
    } else {
        crate::dbg_log("启动迁移校验完成（migrate deploy，已应用自动跳过）");
    }

    // 2) nav-reconcile --apply（幂等；每次启动重算非根节点 path/depth，失败不阻断启动，
    //    导航可在运行期修复）。
    let nav = Command::new(&node)
        .current_dir(&server)
        .arg("dist/nav-reconcile.js")
        .arg("--apply")
        .env("DATABASE_URL", &database_url)
        .env("GX_DATA_DIR", data_dir)
        .env("GX_AUDIT_DIR", &audit)
        .env("JWT_SECRET", &jwt_secret)
        .envs(common_env.clone())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status();
    match nav {
        Ok(s) if s.success() => crate::dbg_log("nav-reconcile --apply ok"),
        Ok(s) => crate::dbg_log(&format!("nav-reconcile 非零退出 {s}（不阻断启动）")),
        Err(e) => crate::dbg_log(&format!("nav-reconcile 启动失败 {e}（不阻断启动）")),
    }

    // 3) 常驻内核进程计划（PORT 用 manager 选定的回环口）；副本 6 变量仅在此追加。
    let mut env = vec![
        ("DATABASE_URL".to_string(), database_url),
        ("GX_DATA_DIR".to_string(), data_dir.display().to_string()),
        ("UPLOAD_ROOT".to_string(), uploads.display().to_string()),
        ("GX_AUDIT_DIR".to_string(), audit.display().to_string()),
        ("BACKUP_DIR".to_string(), backups.display().to_string()),
        (
            "GX_WEB_DIST".to_string(),
            server.join("public").display().to_string(),
        ),
        (
            "GX_MIGRATIONS_DIR".to_string(),
            server.join("prisma/migrations").display().to_string(),
        ),
        ("PORT".to_string(), port.to_string()),
        ("JWT_SECRET".to_string(), jwt_secret),
    ];
    env.extend(common_env);
    env.extend(extra_daemon_env.iter().cloned());

    Ok(StartPlan {
        program: node.display().to_string(),
        args: vec!["dist/index.js".to_string()],
        cwd: server,
        env,
    })
}

// ───────────────────────────── headless 测试 ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU16, Ordering as AtomicOrdering};

    /// 唯一临时目录标签计数，避免并行用例目录互踩。
    fn unique_dir(tag: &str) -> PathBuf {
        static N: AtomicU16 = AtomicU16::new(0);
        let n = N.fetch_add(1, AtomicOrdering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "gx-sidecar-{tag}-{}-{n}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn system_node() -> String {
        // 用系统 node 跑内联假内核（headless 机有 node 22）。
        std::env::var("GX_TEST_NODE").unwrap_or_else(|_| "node".to_string())
    }

    #[test]
    fn tail_process_output_prefers_stderr_and_limits_len() {
        // 空输出给中文占位；非空时 stderr 在前；超长截断保留尾部。
        assert_eq!(tail_process_output(b"", b""), "（迁移进程无输出）");
        let s = tail_process_output(b"applying x", b"Boom: locked");
        assert!(s.starts_with("Boom: locked"), "实际: {s}");
        assert!(s.contains("applying x"));
        let big = "x".repeat(5000);
        let cut = tail_process_output(b"", big.as_bytes());
        assert!(cut.starts_with('…'), "超长应前加省略号");
        assert!(cut.chars().count() <= 801, "应截断到 800+省略号");
    }

    /// 内联假内核：读 PORT，起 http server，/readyz 回 200。
    fn ready_server_script() -> String {
        r#"
        const http=require('http');
        http.createServer((req,res)=>{
          if(req.url==='/readyz'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ready"}');}
          else {res.writeHead(404);res.end();}
        }).listen(Number(process.env.PORT),'127.0.0.1');
        "#
        .to_string()
    }

    /// 假内核：/readyz 永远 503（用于就绪超时分支）。
    fn not_ready_script() -> String {
        r#"
        const http=require('http');
        http.createServer((req,res)=>{res.writeHead(503);res.end();})
          .listen(Number(process.env.PORT),'127.0.0.1');
        setInterval(()=>{}, 100000);
        "#
        .to_string()
    }

    /// 测试 planner：用系统 node -e 跑给定脚本，data_dir 可控 added。
    struct ScriptPlanner {
        data_dir: PathBuf,
        script: String,
    }
    impl KernelPlanner for ScriptPlanner {
        fn data_dir(&self) -> &Path {
            &self.data_dir
        }
        fn plan(&self, port: u16) -> Result<StartPlan, String> {
            // 模拟生产 planner：把选定端口放进 PORT，只绑回环。
            Ok(StartPlan {
                program: system_node(),
                args: vec!["-e".to_string(), self.script.clone()],
                cwd: self.data_dir.clone(),
                env: vec![
                    ("PORT".to_string(), port.to_string()),
                    ("NODE_ENV".to_string(), "test".to_string()),
                ],
            })
        }
    }

    #[test]
    fn free_port_is_loopback_and_usable() {
        let p = free_loopback_port().expect("应能分配回环端口");
        assert!(p > 1024);
        // 释放后应可再绑。
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_status_ready_stop_reaps_process() {
        // 短超时：ready 6s（node 起 server 通常 <0.5s），stop grace 3s。
        let mgr = SidecarManager::with_timeouts(Duration::from_secs(6), Duration::from_secs(3));
        let dir = unique_dir("ok");
        // 未放 dev.db：added=false（未初始化）。
        let planner = ScriptPlanner {
            data_dir: dir.clone(),
            script: ready_server_script(),
        };

        let st0 = mgr.status(&planner);
        assert!(!st0.added && !st0.running && !st0.ready && st0.kernel_port.is_none());

        let port = mgr.start(&planner).expect("假内核应就绪");
        assert!(readyz_is_ready(port), "就绪后探针必须 200");

        // 模拟「已添加」：落一个 dev.db，status 应 added/initialized=true、running/ready=true。
        std::fs::write(dir.join("dev.db"), b"fake-sqlite").unwrap();
        let st1 = mgr.status(&planner);
        assert!(st1.added && st1.initialized && st1.running && st1.ready);
        assert_eq!(st1.kernel_port, Some(port));

        // 幂等：再 start 不重复 spawn，返回同一端口。
        let port2 = mgr.start(&planner).expect("重复 start 应幂等");
        assert_eq!(port2, port);

        // stop：整组收尸，进程必须真的没了。
        let was = mgr.stop().expect("stop ok");
        assert!(was, "首次 stop 应返回 true（曾在跑）");

        // 取 pid 已不可得，但可通过再 stop=false 与 status running=false 间接验证；
        // 直接证据：readyz 不再通 + status not running。
        assert!(!readyz_is_ready(port), "停后探针必须失败");
        let st2 = mgr.status(&planner);
        assert!(!st2.running && !st2.ready && st2.kernel_port.is_none());
        assert!(st2.added, "停后数据/dev.db 必须保留，added 仍为 true");

        // 幂等 stop。
        assert!(!mgr.stop().expect("第二次 stop ok"), "重复 stop 返回 false");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn crashed_kernel_fails_fast_without_waiting_full_timeout() {
        // 进程秒退：start 必须在轮询中立即发现并报错，而不是等满超时。
        let mgr = SidecarManager::with_timeouts(Duration::from_secs(8), Duration::from_secs(2));
        let dir = unique_dir("crash");
        let planner = ScriptPlanner {
            data_dir: dir.clone(),
            script: "process.exit(1);".to_string(),
        };
        let t0 = Instant::now();
        let err = mgr.start(&planner).expect_err("秒退内核必须报错");
        let elapsed = t0.elapsed();
        assert!(err.contains("提前退出"), "实际错误: {err}");
        assert!(
            elapsed < Duration::from_secs(3),
            "应快速失败，实际 {elapsed:?}"
        );
        assert!(mgr.status(&planner).kernel_port.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn never_ready_kernel_is_killed_after_timeout() {
        // 进程活着但 /readyz 恒 503：超时后必须整组杀掉，不留孤儿。
        let mgr =
            SidecarManager::with_timeouts(Duration::from_millis(1200), Duration::from_secs(2));
        let dir = unique_dir("notready");
        let planner = ScriptPlanner {
            data_dir: dir.clone(),
            script: not_ready_script(),
        };
        let err = mgr.start(&planner).expect_err("永不就绪必须超时报错");
        assert!(err.contains("未就绪"), "实际错误: {err}");
        // 留给 KILL/wait 一点时间后，进程组应已死。
        std::thread::sleep(Duration::from_millis(500));
        let st = mgr.status(&planner);
        assert!(!st.running, "超时后不得残留运行中的内核");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_preserves_data_dir() {
        let mgr = SidecarManager::with_timeouts(Duration::from_secs(6), Duration::from_secs(3));
        let dir = unique_dir("data");
        std::fs::create_dir_all(dir.join("uploads")).unwrap();
        std::fs::write(dir.join("dev.db"), b"user-data").unwrap();
        std::fs::write(dir.join("uploads/avatar.png"), b"png").unwrap();
        let planner = ScriptPlanner {
            data_dir: dir.clone(),
            script: ready_server_script(),
        };
        mgr.start(&planner).expect("就绪");
        mgr.stop().expect("stop");
        // 数据原样保留（铁律：stop 不删数据）。
        assert_eq!(std::fs::read(dir.join("dev.db")).unwrap(), b"user-data");
        assert_eq!(
            std::fs::read(dir.join("uploads/avatar.png")).unwrap(),
            b"png"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_added_reflects_dev_db_only() {
        let dir = unique_dir("added");
        assert!(!is_added(&dir));
        std::fs::write(dir.join("other.txt"), b"x").unwrap();
        assert!(!is_added(&dir), "只有 dev.db 才算已初始化");
        std::fs::write(dir.join("dev.db"), b"db").unwrap();
        assert!(is_added(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_http_200_rejects_closed_port() {
        // 没在监听的端口必须判 false（不 panic、不挂起）。
        assert!(!probe_http_200(1, "/readyz"), "1 号端口无服务应快速 false");
    }

    #[test]
    fn production_planner_missing_node_returns_chinese_error_without_keychain() {
        // 生产 planner 预检：随包 Node 缺失时必须在碰 Keychain 之前返回中文错误（不 panic）。
        let res_dir = unique_dir("missing-resource"); // 空目录：无 gxnode、无 server/dist
        let data_dir = unique_dir("missing-data");
        let planner = LocalKernelPlanner::with_secret_store(
            res_dir.clone(),
            data_dir.clone(),
            std::sync::Arc::new(crate::secret::MemSecretStore::empty()),
        );
        let err = planner.plan(31001).expect_err("缺随包 Node 必须报错");
        assert!(err.contains("随包 Node 缺失"), "实际错误: {err}");
        // 数据目录可能已建，但绝不应产出 dev.db（失败在建库之前）。
        assert!(!data_dir.join("dev.db").exists(), "失败路径不得建库");
        let _ = std::fs::remove_dir_all(&res_dir);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    // ─────────────── 副本节点 ID 净化与隔离目录（#1148）───────────────

    #[test]
    fn sanitize_node_id_accepts_legal_and_rejects_traversal() {
        // 合法：字母数字点下划线连字符，含连续点（非点段）。
        assert_eq!(sanitize_node_id("node-B").unwrap(), "node-B");
        assert_eq!(sanitize_node_id("node_1.2-3").unwrap(), "node_1.2-3");
        assert_eq!(sanitize_node_id("  a..b  ").unwrap(), "a..b", "trim 后 a..b 合法");
        // 非法：空白/空。
        assert!(sanitize_node_id("   ").is_err(), "纯空白拒绝");
        // 非法：路径分隔/穿越。
        assert!(sanitize_node_id("a/b").is_err(), "斜杠拒绝");
        assert!(sanitize_node_id("..").is_err(), ".. 拒绝");
        assert!(sanitize_node_id("../x").is_err(), "../x 拒绝");
        assert!(sanitize_node_id(".").is_err(), ". 拒绝");
        // 非法：其它分隔/空白/特殊字符。
        for bad in ["a\\b", "a b", "a:b", "a\0b", "a/b", "x/.."] {
            assert!(sanitize_node_id(bad).is_err(), "应拒绝 {bad:?}");
        }
        // 含点但非点段的单段名安全（无分隔符，join 后不可逃逸），放行。
        assert_eq!(sanitize_node_id("..x").unwrap(), "..x");
        assert_eq!(sanitize_node_id("x..").unwrap(), "x..");
        // 非法：超长（65 个字符）。
        assert!(sanitize_node_id(&"a".repeat(65)).is_err(), "65 字符拒绝");
        // 边界：64 字符合法。
        assert_eq!(sanitize_node_id(&"a".repeat(64)).unwrap().len(), 64);
    }

    #[test]
    fn replica_data_dir_is_isolated_and_within_replicas_root() {
        let base = unique_dir("repdir-base");
        // 两个不同节点目录彼此独立，且都落在 replicas/ 下。
        let d1 = replica_data_dir(&base, "node-B").expect("合法节点应建目录");
        let d2 = replica_data_dir(&base, "node_1.2-3").expect("合法节点应建目录");
        let root = base.join(REPLICAS_SUBDIR).canonicalize().unwrap();
        assert!(d1.starts_with(&root) && d1.ends_with("node-B"));
        assert!(d2.starts_with(&root) && d2.ends_with("node_1.2-3"));
        assert_ne!(d1, d2, "两节点目录必须隔离");
        // 建库文件落在隔离目录内，与主库物理分离。
        std::fs::write(d1.join("dev.db"), b"rep").unwrap();
        assert!(!base.join("dev.db").exists(), "副本 dev.db 不得出现在主数据目录根");
        // 穿越节点名必须在建任何目录前被拒。
        assert!(replica_data_dir(&base, "../escape").is_err());
        assert!(replica_data_dir(&base, "..").is_err());
        assert!(!base.join("escape").exists(), "逃逸目录不得被创建");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ─────────────── 副本远端配置规整（ReplicaRemote，#1149）───────────────

    #[test]
    fn replica_remote_validates_and_applies_defaults() {
        // 合法：URL 规范化去 path/尾斜杠；node trim；client 缺省；interval 缺省 30000。
        let r = ReplicaRemote::new(
            "  http://192.168.31.15:3101/sync/  ",
            "  tok-abc  ",
            "  node-B ",
            None,
            None,
        )
        .expect("合法入参应通过");
        assert_eq!(r.node_id(), "node-B");
        let env = r.daemon_env();
        let get = |k: &str| {
            env.iter()
                .find(|(ek, _)| ek == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("缺少 {k}"))
        };
        assert_eq!(get("GX_OFFLINE_REPLICA"), "on");
        assert_eq!(get("GX_REPLICA_REMOTE_URL"), "http://192.168.31.15:3101");
        assert_eq!(get("GX_REPLICA_REMOTE_TOKEN"), "tok-abc", "token 应 trim");
        assert_eq!(get("GX_OFFLINE_SYNC_INTERVAL_MS"), "30000");
        assert_eq!(get("GX_OFFLINE_NODE_ID"), "node-B");
        assert_eq!(get("GX_OFFLINE_CLIENT_ID"), "local-replica");
        // 恰好 6 枚。
        assert_eq!(env.len(), 6);

        // interval 夹下限：1→5000；合法大值原样；自定义 client trim 后透传。
        let r2 = ReplicaRemote::new(
            "https://h.example.com",
            "",
            "n1",
            Some("  cli-9  "),
            Some(1),
        )
        .unwrap();
        let e2 = r2.daemon_env();
        let g2 = |k: &str| {
            e2.iter()
                .find(|(ek, _)| ek == k)
                .map(|(_, v)| v.as_str())
                .unwrap()
        };
        assert_eq!(g2("GX_OFFLINE_SYNC_INTERVAL_MS"), "5000");
        assert_eq!(g2("GX_OFFLINE_CLIENT_ID"), "cli-9");
        assert_eq!(g2("GX_REPLICA_REMOTE_TOKEN"), "", "空 token 允许");
        let r3 = ReplicaRemote::new("https://h.example.com", "", "n1", None, Some(7000)).unwrap();
        assert_eq!(
            r3.daemon_env()
                .iter()
                .find(|(k, _)| k == "GX_OFFLINE_SYNC_INTERVAL_MS")
                .map(|(_, v)| v.as_str())
                .unwrap(),
            "7000"
        );

        // fail-closed：空 / 非 http URL 拒绝；非法节点名拒绝。
        assert!(ReplicaRemote::new("   ", "t", "node-B", None, None).is_err(), "空 URL 拒绝");
        assert!(
            ReplicaRemote::new("ftp://h", "t", "node-B", None, None).is_err(),
            "非 http(s) 拒绝"
        );
        assert!(
            ReplicaRemote::new("http://h", "t", "../x", None, None).is_err(),
            "穿越节点名拒绝"
        );
        assert!(
            ReplicaRemote::new("http://user:pass@h", "t", "node-B", None, None).is_err(),
            "内嵌凭证拒绝"
        );
    }

    // ─────────────── 副本 planner：env 注入 / 隔离库 / token 脱敏（#1149）───────────────

    #[test]
    fn replica_planner_plan_injects_six_env_and_isolates_db_with_token_redacted() {
        // 假随包产物：让预检 node/dist 通过；预置 dev.db → first_boot=false。
        // 注意：build_kernel_plan 现在【每次启动】都跑 migrate deploy 与 nav-reconcile（0.3.0 P0
        // 修复），故假 node 必须可执行且对这两个子命令都退出 0，否则 plan 会在迁移步报错。
        let res = unique_dir("rep-plan-res");
        let fake_node = res.join(NODE_BIN);
        std::fs::write(
            &fake_node,
            b"#!/bin/sh\n# 假随包 node：对 migrate/nav 子命令一律成功，其余参数也正常退出\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_node, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir_all(res.join(SERVER_DIR).join("dist")).unwrap();
        std::fs::write(res.join(SERVER_DIR).join("dist/index.js"), b"// kernel").unwrap();

        let base = unique_dir("rep-plan-base");
        let data_dir = replica_data_dir(&base, "node-B").expect("隔离目录");
        // 预置已初始化库 → 跳过首 boot 子进程。
        std::fs::write(data_dir.join("dev.db"), b"already-booted").unwrap();

        const TOKEN: &str = "SUPER-SECRET-TOKEN-9f3a";
        let remote = ReplicaRemote::new(
            "http://192.168.31.15:3101/s/",
            TOKEN,
            "node-B",
            None,
            Some(1),
        )
        .unwrap();
        let planner = ReplicaKernelPlanner::with_secret_store(
            res.clone(),
            data_dir.clone(),
            std::sync::Arc::new(crate::secret::MemSecretStore::empty()),
            remote,
        );

        let plan = planner.plan(41999).expect("plan 应构造成功（不跑 migrate）");
        let get = |k: &str| {
            plan.env
                .iter()
                .find(|(ek, _)| ek == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("缺少 {k}"))
        };

        // 常驻进程是 dist/index.js。
        assert_eq!(plan.args, vec!["dist/index.js".to_string()]);
        assert_eq!(get("PORT"), "41999");

        // 6 枚副本变量齐全且仅在常驻 env；捕获门精确 on；URL 规范化；interval 夹下限。
        assert_eq!(get("GX_OFFLINE_REPLICA"), "on");
        assert_eq!(get("GX_REPLICA_REMOTE_URL"), "http://192.168.31.15:3101");
        assert_eq!(get("GX_REPLICA_REMOTE_TOKEN"), TOKEN);
        assert_eq!(get("GX_OFFLINE_SYNC_INTERVAL_MS"), "5000");
        assert_eq!(get("GX_OFFLINE_NODE_ID"), "node-B");
        assert_eq!(get("GX_OFFLINE_CLIENT_ID"), "local-replica");

        // DATABASE_URL 必须指向隔离目录 replicas/node-B/dev.db，与主库物理不同。
        let db_url = get("DATABASE_URL");
        assert!(
            db_url.contains(&format!("{REPLICAS_SUBDIR}/node-B/dev.db")),
            "副本 DATABASE_URL 应落在 replicas/node-B/，实际 {db_url}"
        );
        assert_eq!(
            db_url,
            format!("file:{}", data_dir.join("dev.db").display())
        );
        assert_ne!(
            db_url,
            format!("file:{}", base.join("dev.db").display()),
            "副本库不得等于主库路径"
        );

        // 随包 server 资源指向 resource_dir（GX_WEB_DIST / GX_MIGRATIONS_DIR）。
        assert_eq!(
            get("GX_WEB_DIST"),
            res.join(SERVER_DIR).join("public").display().to_string()
        );
        assert_eq!(
            get("GX_MIGRATIONS_DIR"),
            res.join(SERVER_DIR)
                .join("prisma/migrations")
                .display()
                .to_string()
        );

        // token 脱敏：手动 Debug 只打 env 键名，绝不含令牌明文（也不含 URL 之外的机密）。
        let debug = format!("{plan:?}");
        assert!(!debug.contains(TOKEN), "StartPlan Debug 泄漏 token：{debug}");
        assert!(debug.contains("GX_REPLICA_REMOTE_TOKEN"), "Debug 应只列键名");
        assert!(!debug.contains("192.168.31.15"), "Debug 不应打印任何 env 值（含 URL）");

        // 主库计划不带任何副本/离线变量（local 仅注入 GX_LICENSE_* 授权变量，见 LocalKernelPlanner::plan）。
        let local_data = unique_dir("rep-plan-local");
        std::fs::write(local_data.join("dev.db"), b"x").unwrap();
        let local = LocalKernelPlanner::with_secret_store(
            res.clone(),
            local_data.clone(),
            std::sync::Arc::new(crate::secret::MemSecretStore::empty()),
        );
        let lp = local.plan(42000).unwrap();
        for (k, _) in &lp.env {
            assert!(
                !(k.starts_with("GX_REPLICA_")
                    || k == "GX_OFFLINE_REPLICA"
                    || k == "GX_OFFLINE_NODE_ID"
                    || k == "GX_OFFLINE_CLIENT_ID"
                    || k == "GX_OFFLINE_SYNC_INTERVAL_MS"),
                "主库计划不得携带副本变量，却出现 {k}"
            );
        }
        // 主库同步服务端总门必须通电（#1294）：精确小写 on，随常驻内核注入。
        assert_eq!(
            lp.env
                .iter()
                .find(|(k, _)| k == "GX_SYNC_SERVER")
                .map(|(_, v)| v.as_str()),
            Some("on"),
            "主库常驻内核必须注入 GX_SYNC_SERVER=on，否则同步路由整组 404"
        );
        // 授权 4 枚仍在（改名 local_daemon_env 不得丢授权）。
        for k in [
            "GX_LICENSE_URL",
            "GX_LICENSE_MODE",
            "GX_LICENSE_PLATFORM",
            "GX_PACKAGE_TYPE",
        ] {
            assert!(
                lp.env.iter().any(|(ek, _)| ek == k),
                "主库常驻内核缺少授权变量 {k}"
            );
        }
        // 副本是纯客户端：其常驻 env【绝不能】携带服务端总门，否则副本会误开被订阅面。
        assert!(
            plan.env.iter().all(|(k, _)| k != "GX_SYNC_SERVER"),
            "副本计划不得注入 GX_SYNC_SERVER（须保持服务端门 off，纯出站订阅）"
        );

        let _ = std::fs::remove_dir_all(&res);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&local_data);
    }
}
