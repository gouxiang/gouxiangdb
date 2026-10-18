//! 本地内核 sidecar 生命周期托管（IMPL-0.2.5-beta §4-R2 / #825 / #846）。
//!
//! 取代 PoC 的「只起不停、无条件 spawn」：把随包 Node 内核做成可命令式
//! start / stop / status 的托管结构，只绑 `127.0.0.1`，独立进程组，停即整组优雅收尸。
//!
//! 分层（为了让整条生命周期能在 `cargo test` 下 headless 真实跑通，而不依赖 Tauri Builder
//! 或随包 Node 产物）：
//!   - [`StartPlan`]：一个要拉起的进程的纯描述（程序/参数/cwd/环境）。
//!   - [`KernelPlanner`]：产出启动计划。生产实现 [`LocalKernelPlanner`] 在首 boot 时先做
//!     冷备→Keychain JWT→`migrate deploy`→`nav-reconcile`，再给出跑 `dist/index.js` 的计划；
//!     测试用「真 node 跑内联假内核」的计划，验证 spawn/进程组/readyz/收尸全链路。
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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::secret::{ensure_jwt_secret, KeychainStore, SecretStore};

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
        let added = is_added(planner.data_dir());
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

/// 生产内核规划器：resource_dir（随包 node/server）+ data_dir（Application Support）。
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

    fn node_path(&self) -> PathBuf {
        self.resource_dir.join(NODE_BIN)
    }
    fn server_dir(&self) -> PathBuf {
        self.resource_dir.join(SERVER_DIR)
    }
}

impl KernelPlanner for LocalKernelPlanner {
    fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn plan(&self, port: u16) -> Result<StartPlan, String> {
        let node = self.node_path();
        let server = self.server_dir();
        if !node.exists() {
            return Err(format!("随包 Node 缺失：{}", node.display()));
        }
        if !server.join("dist/index.js").exists() {
            return Err(format!("内核程序缺失：{}/dist/index.js", server.display()));
        }

        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
        let uploads = self.data_dir.join("uploads");
        let audit = self.data_dir.join(".audit");
        std::fs::create_dir_all(&uploads).ok();
        std::fs::create_dir_all(&audit).ok();

        let db_path = self.data_dir.join("dev.db");
        let first_boot = !db_path.exists();

        // 已有库：首启前冷备（sidecar 尚未起，纯文件拷贝；迁移只增不删，双保险）。
        if !first_boot {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak = self.data_dir.join(format!("dev.db.{stamp}.bak"));
            if let Err(e) = std::fs::copy(&db_path, &bak) {
                // 冷备失败不阻断（迁移只增），但明确告知日志。
                crate::dbg_log(&format!("WARN 冷备 dev.db 失败（继续）: {e}"));
            }
        }

        // JWT：钥匙串优先 → 迁移旧 .jwt-secret → 新建。仅首 boot 首次会触发系统授权弹窗。
        let legacy = self.data_dir.join(".jwt-secret");
        let outcome = ensure_jwt_secret(self.secrets.as_ref(), &legacy)
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

        // 首 boot 的同步步骤（已初始化则跳过——不再重建、不再要求建管理员）。
        if first_boot {
            // 1) migrate deploy（只增不删）。
            let migrate_status = Command::new(&node)
                .current_dir(&server)
                .arg("node_modules/prisma/build/index.js")
                .arg("migrate")
                .arg("deploy")
                .arg("--schema=prisma/schema.prisma")
                .env("DATABASE_URL", &database_url)
                .env("GX_DATA_DIR", &self.data_dir)
                .envs(common_env.clone())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .status()
                .map_err(|e| format!("启动数据库迁移失败：{e}"))?;
            if !migrate_status.success() {
                return Err(format!(
                    "数据库迁移失败（退出码 {migrate_status}，旧库与备份均已保留）"
                ));
            }

            // 2) nav-reconcile --apply（幂等；失败不阻断首启，导航可运行期修复）。
            let nav = Command::new(&node)
                .current_dir(&server)
                .arg("dist/nav-reconcile.js")
                .arg("--apply")
                .env("DATABASE_URL", &database_url)
                .env("GX_DATA_DIR", &self.data_dir)
                .env("GX_AUDIT_DIR", &audit)
                .env("JWT_SECRET", &jwt_secret)
                .envs(common_env.clone())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .status();
            match nav {
                Ok(s) if s.success() => crate::dbg_log("nav-reconcile --apply ok"),
                Ok(s) => crate::dbg_log(&format!("nav-reconcile 非零退出 {s}（不阻断首启）")),
                Err(e) => crate::dbg_log(&format!("nav-reconcile 启动失败 {e}（不阻断首启）")),
            }
        }

        // 3) 常驻内核进程计划（PORT 用 manager 选定的回环口）。
        let mut env = vec![
            ("DATABASE_URL".to_string(), database_url),
            (
                "GX_DATA_DIR".to_string(),
                self.data_dir.display().to_string(),
            ),
            ("UPLOAD_ROOT".to_string(), uploads.display().to_string()),
            ("GX_AUDIT_DIR".to_string(), audit.display().to_string()),
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

        Ok(StartPlan {
            program: node.display().to_string(),
            args: vec!["dist/index.js".to_string()],
            cwd: server,
            env,
        })
    }
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
}
