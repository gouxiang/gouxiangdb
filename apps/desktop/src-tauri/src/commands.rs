//! Tauri 命令薄封装（IMPL-0.2.5-beta §3 冻结命令契约）。
//!
//! R1：`gx:get_shell_info / gx:set_active_upstream / gx:begin_probe / gx:end_probe`。
//! R2（#825）：`gx:start_local / gx:stop_local / gx:local_status`，本地内核由
//! sidecar.rs 托管、JWT 由 secret.rs 入 macOS 钥匙串。
//!
//! 命名写法（已核对 tauri-macros 2.7.3 源码）：Rust 函数名不允许含 `:`，故命令名无法
//! 直接叫 `gx:get_shell_info`。tauri v2 的 `#[tauri::command]` 支持属性 `rename = "<name>"`
//! （见 tauri-macros-2.7.3/src/command/wrapper.rs 对 `rename` 的解析），它会把注册/invoke
//! 名精确覆盖为带冒号的字符串，函数本身仍用合法 Rust 标识。前端 invoke 的名字因此与 §3
//! 表逐字一致（`gx:get_shell_info` 等）。
//!
//! 入参大小写：宏默认把 Rust 参数名转 lowerCamelCase 后从 IPC payload 取键。`probe_id →
//! probeId`、`kind/target` 本就无下划线，均与 web 入参一致；唯独 begin_probe 的 web 键是
//! 全大写的 `baseURL`（`base_url` 只会映射成 `baseUrl`），故该命令改用
//! [`tauri::ipc::Request`] 取原始 payload 后手动解析 `baseURL`（Request 命令参数读取的是
//! 整条消息体，不参与按键映射）。
//!
//! 所有面向用户的错误均为中文、可直接展示；绝不 panic 到前端。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tauri::State;

use crate::sidecar::{KernelPlanner, LocalKernelPlanner, LocalStatus, SidecarManager};
use crate::upstream::{normalize_http_base, Shared, Upstream};

/// 壳的统一托管状态：Tauri `.manage()` 与 axum `State` 共用同一个 `Arc<ShellState>`，
/// 命令（切上游 / probe 注册 / 本地内核起停）与 HTTP/WS 代理看到的是同一份上游与 probe 表。
///
/// - `port` 为 SHELL_PORT：setup 中 axum 绑定随机回环口后写入，App 生命周期内不变；
///   0 表示尚未绑定（WebView 导航到壳口之后才有命令调用，理论上读不到 0）。
/// - `web_root` 为壳静态资源根（R1=resource_dir/server/public，R3 对齐 frontendDist），
///   仅能在 setup 取得 resource_dir，故用 OnceLock 在绑定壳口前设置一次。
/// - `resource_dir` / `data_dir` 为随包产物根与本地数据目录（R2 sidecar 首 boot 用），
///   同样只在 setup 取得一次。
/// - `sidecar` 为本地内核生命周期托管器（start/stop/status，单活、独立进程组）。
pub struct ShellState {
    /// 上游 + probeId 表（纯状态层见 upstream.rs）。
    pub shared: Arc<Shared>,
    web_root: OnceLock<PathBuf>,
    resource_dir: OnceLock<PathBuf>,
    data_dir: OnceLock<PathBuf>,
    port: AtomicU16,
    sidecar: Arc<SidecarManager>,
}

impl ShellState {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            web_root: OnceLock::new(),
            resource_dir: OnceLock::new(),
            data_dir: OnceLock::new(),
            port: AtomicU16::new(0),
            sidecar: Arc::new(SidecarManager::new()),
        }
    }

    /// setup 中调用一次，登记壳静态资源根。
    pub fn set_web_root(&self, root: PathBuf) {
        // 只设置一次；重复设置忽略（不会发生）。
        let _ = self.web_root.set(root);
    }

    /// 读壳静态资源根（静态服务用；未设置时为 None，调用方回 500，不 panic）。
    pub fn web_root(&self) -> Option<&PathBuf> {
        self.web_root.get()
    }

    /// setup 中调用一次，登记随包资源根与本地数据目录（R2 sidecar 用）。
    pub fn set_dirs(&self, resource_dir: PathBuf, data_dir: PathBuf) {
        let _ = self.resource_dir.set(resource_dir);
        let _ = self.data_dir.set(data_dir);
    }

    /// setup 绑定壳口后调用一次，固化 SHELL_PORT。
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::SeqCst);
    }

    /// 读 SHELL_PORT（Location 重写与 get_shell_info 用）。
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// 本地内核托管器（start/stop/status 命令与退出收尸共用）。
    pub fn sidecar(&self) -> Arc<SidecarManager> {
        self.sidecar.clone()
    }

    /// 用当前 resource_dir/data_dir 构造一个生产内核 planner（Keychain JWT）。
    /// 目录未登记（理论不发生）返回中文错误，不 panic。
    fn kernel_planner(&self) -> Result<LocalKernelPlanner, String> {
        match (self.resource_dir.get(), self.data_dir.get()) {
            (Some(r), Some(d)) => Ok(LocalKernelPlanner::new(r.clone(), d.clone())),
            _ => Err("本地环境尚未初始化（资源目录缺失），请重启应用后重试".to_string()),
        }
    }
}

/// `gx:get_shell_info` 返回；字段序列化为 camelCase，逐字段对齐 web 的 ShellInfo
/// （apps/web/src/node/shellBridge.ts：shellVersion/platform/arch/shellPort/launcher）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfoDto {
    shell_version: String,
    platform: String,
    arch: String,
    shell_port: u16,
    launcher: bool,
}

/// 壳版本/平台信息（§3 冻结值）。本期仅 Apple Silicon、darwin/arm64。
#[tauri::command(rename = "gx:get_shell_info")]
pub async fn gx_get_shell_info(state: State<'_, Arc<ShellState>>) -> Result<ShellInfoDto, String> {
    Ok(ShellInfoDto {
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: "darwin".to_string(),
        arch: "arm64".to_string(),
        shell_port: state.port(),
        launcher: true,
    })
}

/// `gx:set_active_upstream`：原子替换当前活动上游（单活）。
///
/// - kind=none   → `Upstream::None`（业务前缀代理随后回 503 NODE_NOT_ACTIVE）；
/// - kind=remote → 必须带 `target`，经 [`normalize_http_base`] 校验后存 Remote{base}；
/// - kind=local  → R1 尚无托管内核，按派单返回业务失败体 `{ok:false,error}`（非 reject）；
///   R2 接入 sidecar 后这里改为读当前 kernelPort 并置 Local{port}。
#[tauri::command(rename = "gx:set_active_upstream")]
pub async fn gx_set_active_upstream(
    state: State<'_, Arc<ShellState>>,
    kind: String,
    target: Option<String>,
) -> Result<serde_json::Value, String> {
    match kind.as_str() {
        "none" => {
            state.shared.set_upstream(Upstream::None).await;
            Ok(serde_json::json!({ "ok": true }))
        }
        "remote" => {
            let raw = target
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .ok_or_else(|| "连接远端节点需要提供节点地址".to_string())?;
            // 校验 http/https origin；失败信息已是中文、可直接展示。
            let base = normalize_http_base(&raw)?;
            state.shared.set_upstream(Upstream::Remote { base }).await;
            Ok(serde_json::json!({ "ok": true }))
        }
        "local" => {
            // R2：读托管内核当前端口；必须已由 gx:start_local 拉起且进程存活。
            match state.sidecar.running_port() {
                Some(port) => {
                    state.shared.set_upstream(Upstream::Local { port }).await;
                    Ok(serde_json::json!({ "ok": true }))
                }
                None => Ok(serde_json::json!({ "ok": false, "error": "本地内核尚未启动" })),
            }
        }
        other => Err(format!("未知的上游类型：{other}")),
    }
}

/// `gx:start_local`：按需启动本地内核（首 boot 建库，已初始化仅起进程）。
///
/// 阻塞部分（migrate/nav/轮询 readyz）放进 spawn_blocking，避免卡住命令运行时；
/// 就绪后原子置当前上游为 Local{port}，浏览器随后经壳口同源即用。
/// 返回 §3：`{ok:true,kernelPort,initialized}` 或 `{ok:false,error}`（业务失败体，非 reject）。
#[tauri::command(rename = "gx:start_local")]
pub async fn gx_start_local(
    state: State<'_, Arc<ShellState>>,
) -> Result<serde_json::Value, String> {
    let planner = match state.kernel_planner() {
        Ok(p) => p,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "error": e })),
    };
    // 是否已初始化（启动前判定，用于返回体）。
    let initialized = planner.data_dir().join("dev.db").is_file();
    let mgr = state.sidecar();
    let start_res = tauri::async_runtime::spawn_blocking(move || mgr.start(&planner))
        .await
        .map_err(|e| format!("启动任务执行失败：{e}"))?;
    match start_res {
        Ok(port) => {
            state.shared.set_upstream(Upstream::Local { port }).await;
            Ok(serde_json::json!({ "ok": true, "kernelPort": port, "initialized": initialized }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// `gx:stop_local`：优雅停内核（不删数据）。停止后若当前正指向本地，则把上游复位为 None，
/// 保证代理不再指向已关闭的端口（IMPL §3：停后上游不得再指向 Local）。
#[tauri::command(rename = "gx:stop_local")]
pub async fn gx_stop_local(state: State<'_, Arc<ShellState>>) -> Result<serde_json::Value, String> {
    let mgr = state.sidecar();
    let stopped = tauri::async_runtime::spawn_blocking(move || mgr.stop())
        .await
        .map_err(|e| format!("停止任务执行失败：{e}"))??;
    // 若当前是 Local，复位 None（Remote/None 不动）。
    if matches!(state.shared.get_upstream().await, Upstream::Local { .. }) {
        state.shared.set_upstream(Upstream::None).await;
    }
    Ok(serde_json::json!({ "ok": true, "wasRunning": stopped }))
}

/// `gx:local_status`：本地节点四态（未添加/已添加停止/运行中/就绪）。
/// status 会做一次 readyz 探测（可能短暂阻塞），放 spawn_blocking。
#[tauri::command(rename = "gx:local_status")]
pub async fn gx_local_status(state: State<'_, Arc<ShellState>>) -> Result<LocalStatusDto, String> {
    let planner = state.kernel_planner()?;
    let mgr = state.sidecar();
    let status = tauri::async_runtime::spawn_blocking(move || mgr.status(&planner))
        .await
        .map_err(|e| format!("读取本地状态失败：{e}"))?;
    Ok(LocalStatusDto::from(status))
}

/// `gx:local_status` 返回体，字段 camelCase 对齐 §3 与 web 的 LocalStatus。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatusDto {
    added: bool,
    initialized: bool,
    running: bool,
    ready: bool,
    kernel_port: Option<u16>,
}

impl From<LocalStatus> for LocalStatusDto {
    fn from(s: LocalStatus) -> Self {
        Self {
            added: s.added,
            initialized: s.initialized,
            running: s.running,
            ready: s.ready,
            kernel_port: s.kernel_port,
        }
    }
}

/// `gx:begin_probe`：注册短期 probeId→baseURL（TTL≤120s），不改变当前活动上游。
///
/// web 入参键为全大写 `baseURL`，无法用普通 camelCase 参数承接，故直接取 IPC 原始 body
/// （[`tauri::ipc::Request`]）手动解析。
#[tauri::command(rename = "gx:begin_probe")]
pub async fn gx_begin_probe(
    state: State<'_, Arc<ShellState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<serde_json::Value, String> {
    let base_url = match request.body() {
        tauri::ipc::InvokeBody::Json(v) => v
            .get("baseURL")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "缺少节点地址 baseURL".to_string())?,
        // 本通道只收 JSON（withGlobalTauri 全局 invoke 传对象）。
        tauri::ipc::InvokeBody::Raw(_) => {
            return Err("节点地址格式不正确".to_string());
        }
    };
    let base = normalize_http_base(&base_url)?;
    let probe_id = state.shared.begin_probe(base);
    Ok(serde_json::json!({ "probeId": probe_id }))
}

/// `gx:end_probe`：立即注销 probeId（幂等；ok 表达是否曾命中）。
#[tauri::command(rename = "gx:end_probe")]
pub async fn gx_end_probe(
    state: State<'_, Arc<ShellState>>,
    probe_id: String,
) -> Result<serde_json::Value, String> {
    let ok = state.shared.end_probe(&probe_id);
    Ok(serde_json::json!({ "ok": ok }))
}
