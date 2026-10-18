// PoC-1：把随包 Node sidecar + apps/api 内核嵌进 Tauri 包，干净机首启建库并只绑回环。
//
// 边界（PoC，后续 D2 替换）：
//   - JWT_SECRET 暂存数据目录 .jwt-secret 文件（D2 换 macOS Keychain，届时才弹系统授权）。
//   - 健康判据用「回环 TCP 可连通」；migrate 已在此前单独同步跑完，故 listen 成功即建库完成。
//   - 界面用 window.location.replace 跳到 http://127.0.0.1:<port>/（同源托管），PoC-2 再细化。
#![cfg_attr(
    not(debug_assertions),
    cfg_attr(windows, windows_subsystem = "windows")
)]

// R1（IMPL-0.2.5-beta §4）：把 PoC 单文件拆成模块，main.rs 只负责装配。
mod commands;
mod proxy;
mod proxy_ws;
mod shell_server;
mod upstream;

// R1 headless 集成测试（IMPL §4-R1 六类）：真实回环 HTTP/裸 TCP，不依赖 Tauri Builder/winit。
#[cfg(test)]
mod headless_tests;

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewWindow};
// PoC-3：仅用其 UpdaterExt（app.updater()）。插件在 Builder 注册但默认永不 check——
// 只有 GX_POC3=1 时才主动发起，且 endpoints/pubkey 由构建期 --config 注入，正式 tauri.conf 不含 updater 段。
use tauri_plugin_updater::UpdaterExt;

const BUNDLE_ID: &str = "cc.gouxiang.desktop";
const NODE_BIN: &str = "gxnode-aarch64-apple-darwin";
const SERVER_DIR: &str = "server";
const EXIT_LOG: &str = "/tmp/gx-desktop-exit.log";
/// PoC-2 门控（仅自测）：GX_POC2=1 时把 sidecar 输出落盘并导航到同源探针页 /poc2.html。
/// 默认（无此 env）行为与 PoC-1 完全一致：日志丢弃、导航到 /。
const POC2_SIDECAR_LOG: &str = "/tmp/gx-poc2-sidecar.log";
/// PoC-3 门控（仅自测）：GX_POC3=1 时延迟若干秒后向构建期注入的静态源 check 更新，
/// 下载→minisign 公钥校验→安装前优雅停 sidecar→替换→restart，全过程落盘供无交互判定。
const POC3_LOG: &str = "/tmp/gx-poc3-updater.log";
/// PoC-4 门控（仅自测，#816 承载验证）：GX_POC4=1 时壳在【独立回环静态口】托管 web/dist，
/// WebView 加载壳口的 /poc4.html?kernel=<内核口>，跨源连本地内核口，实测 CORS/预检/CORP/WS/multipart。
/// 默认（无此 env）行为与 PoC-1 完全一致：不起壳静态口、直接同源跳内核口。
const POC4_LOG: &str = "/tmp/gx-poc4-shell.log";

fn dbg_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(EXIT_LOG)
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// PoC-3 专用无交互日志（与主退出日志分开，便于脚本直接判定更新闭环结果）。
fn poc3_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(POC3_LOG)
    {
        let _ = writeln!(f, "{msg}");
    }
}

// 只存 sidecar PID（0=未起/已停）。退出时按进程组发信号，避免持有 Child 的锁/借用问题。
struct SidecarPid(AtomicI32);

fn main() {
    // R1 硬要求：进程级幂等安装 rustls ring crypto provider，必须早于任何 https/wss 连接。
    // reqwest 用 rustls-no-provider、rustls 仅选 ring（全树无 aws-lc-rs），否则首次 TLS 握手运行时报错。
    // 写法逐字对齐 tauri-plugin-updater updater.rs:585-587（get_default().is_none() 才装）。
    proxy::ensure_crypto_provider();

    let _ = fs::remove_file(EXIT_LOG);
    dbg_log(&format!("app run begin pid={}", std::process::id()));
    let poc3 = std::env::var("GX_POC3").map(|v| v == "1").unwrap_or(false);
    if poc3 {
        // 始终 append：更新 restart 会继承环境并以新 .app 再进 main，新旧两段证据必须留在同一日志。
        // 注意：绝不能靠会被重启继承的 env 在运行时自删（曾用 GX_POC3_RESET_LOG 导致新版抹掉旧版证据）；
        // 清空日志由驱动脚本在【开跑前】外部截断一次。GX_POC3_RESET_LOG 仅保留给"单次启动不更新"的隔离调试。
        if std::env::var("GX_POC3_RESET_LOG")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            let _ = fs::remove_file(POC3_LOG);
        }
        poc3_log(&format!(
            "---- session begin pid={} crate_ver={} ----",
            std::process::id(),
            env!("CARGO_PKG_VERSION")
        ));
    }
    // R1：壳统一状态（上游 + probe 表 + SHELL_PORT + 静态根）。Tauri 命令与 axum 共用同一 Arc。
    let shell_state: Arc<commands::ShellState> =
        Arc::new(commands::ShellState::new(Arc::new(upstream::Shared::new())));
    let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    // PoC-3：注册 updater 插件。其 endpoints/pubkey 只在 PoC 构建的 --config 覆盖里提供；
    // 默认 tauri.conf.json 无 updater 段，且非 GX_POC3 时永远不调用 check，故零自动行为。
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(SidecarPid(AtomicI32::new(0)))
    .manage(shell_state.clone())
    // R1 §3：注册 4 条 gx:* 命令（invoke 名经函数上的 rename = "gx:..." 精确含冒号）。
    .invoke_handler(tauri::generate_handler![
      commands::gx_get_shell_info,
      commands::gx_set_active_upstream,
      commands::gx_begin_probe,
      commands::gx_end_probe
    ])
    .setup(move |app| {
      let window: WebviewWindow = app.get_webview_window("main").expect("main window");
      let resource_dir = app.path().resource_dir().expect("resource_dir");
      // 记录构建期 --config 注入的真实 bundle 版本（两版 crate 版本相同，须靠它区分 0.1.0/0.2.0）。
      if std::env::var("GX_POC3").map(|v| v == "1").unwrap_or(false) {
        poc3_log(&format!(
          "bundle_version={} name={}",
          app.package_info().version,
          app.package_info().name
        ));
      }
      let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
      // PoC-2/PoC-3：数据目录可由 GX_POC2_DATA_DIR / GX_POC3_DATA_DIR 覆盖（隔离自测，绝不碰真实 Application Support）。
      // 不能靠覆盖 HOME 隔离——会让 Tauri resource_dir() 解析失败（UnknownPath）。
      let data_dir = match std::env::var("GX_POC3_DATA_DIR").ok().filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => match std::env::var("GX_POC2_DATA_DIR").ok().filter(|p| !p.trim().is_empty()) {
          Some(p) => PathBuf::from(p),
          None => PathBuf::from(home)
            .join("Library/Application Support")
            .join(BUNDLE_ID),
        },
      };

      // PoC-3：起一条专用系统线程，等 sidecar 就绪（轮询共享 PID）后再查更新，
      // 避免与内核启动抢占；安装前在 on_download_finish 里优雅停 sidecar。
      // 用普通线程 + std 等待，仅在两处 updater 异步调用上 block_on（该线程不在 tokio 运行时内，安全）。
      if poc3 {
        let handle3 = app.handle().clone();
        thread::spawn(move || run_poc3_update(handle3));
      }

      // R1：默认走「壳口静态 + 零配置出口代理」，不再无条件 boot 本地内核（内核在 R2 由命令起停）。
      // GX_POC2/GX_POC3/GX_POC4 为 PoC 自测门控，整段保留原行为：
      //   - POC4：壳独立静态口跨源探针（run_poc4）；
      //   - POC2/POC3：直接起内核并同源导航（POC3 的更新流程依赖该内核 PID）。
      thread::spawn(move || {
        let poc4 = std::env::var("GX_POC4").map(|v| v == "1").unwrap_or(false);
        if poc4 {
          // #816 承载验证：壳独立回环静态口 → 跨源连本地内核口（不再同源跳内核口）。
          run_poc4(window, resource_dir, data_dir);
          return;
        }
        let poc2 = std::env::var("GX_POC2").map(|v| v == "1").unwrap_or(false);
        let is_poc3 = std::env::var("GX_POC3").map(|v| v == "1").unwrap_or(false);
        if poc2 || is_poc3 {
          // PoC 旧路径：起随包 Node 内核并把 WebView 同源导到内核口（POC3 更新流程复用）。
          if let Err(e) = boot_local_kernel(&window, &resource_dir, &data_dir, poc2, true) {
            eprintln!("[desktop] 本地内核启动失败: {e}");
            let _ = window.eval(format!(
              "document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">本地内核启动失败：{}</pre>'",
              js_escape(&e)
            ));
          }
          return;
        }
        // R1 默认：绑定 SHELL_PORT（随机回环口，生命周期内不变），静态托管 + 反代，导航到壳口。
        // 前面两个分支均 diverge，故这里直接 move window/resource_dir/shell_state。
        boot_shell(window, resource_dir, shell_state);
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building GouXiangDB desktop");

    // 双保险收尸：
    //  - ExitRequested：可阻止。prevent_exit 后另起线程优雅停 sidecar（SIGTERM 等 ≤5s），再 app.exit。
    //  - Exit：不可阻止但仍能同步收尾，做有界 SIGTERM→SIGKILL 兜底（防某些终止路径不发 Requested）。
    //  - updater 重启（code==RESTART_EXIT_CODE=80）：绝不 prevent_exit，只在退出前同步优雅停 sidecar，
    //    让 Tauri 完成"替换 .app 后重启"；否则会把更新重启误判成普通退出而卡死。
    app.run(move |app_handle, event| match event {
    tauri::RunEvent::ExitRequested { code, api, .. } => {
      if code == Some(tauri::RESTART_EXIT_CODE) {
        dbg_log("ExitRequested RESTART(80) -> updater relaunch: graceful stop, do NOT prevent_exit");
        poc3_log("RESTART_EXIT_CODE received: stopping sidecar before relaunch");
        let pid = app_handle
          .try_state::<SidecarPid>()
          .map(|s| s.0.swap(0, Ordering::SeqCst))
          .unwrap_or(0);
        if pid > 0 {
          graceful_stop(pid, Duration::from_secs(5));
        }
        // 不调用 api.prevent_exit()：放行 Tauri 重启流程。
        let _ = api;
      } else {
        dbg_log("ExitRequested received -> prevent_exit + graceful");
        api.prevent_exit();
        let pid = app_handle
          .try_state::<SidecarPid>()
          .map(|s| s.0.swap(0, Ordering::SeqCst))
          .unwrap_or(0);
        dbg_log(&format!("sidecar pid from state = {pid}"));
        let handle = app_handle.clone();
        thread::spawn(move || {
          if pid > 0 {
            graceful_stop(pid, Duration::from_secs(5));
          }
          handle.exit(0);
        });
      }
    }
    tauri::RunEvent::Exit => {
      dbg_log("RunEvent::Exit -> backstop reaper");
      if let Some(state) = app_handle.try_state::<SidecarPid>() {
        let pid = state.0.swap(0, Ordering::SeqCst);
        if pid > 0 {
          graceful_stop(pid, Duration::from_secs(3));
        }
      }
    }
    _ => {}
  });
}

/// 进程是否仍在（signal 0）。
fn process_alive(pid: i32) -> bool {
    unsafe { libc_kill(pid, 0) == 0 }
}

/// 按【进程组】先发 SIGTERM（spawn 时 sidecar 自成 pgid），命中内核已有优雅关闭
/// （flushAllAndClose → 断 Prisma）；轮询至超时，仍在则 SIGKILL 兜底，避免孤儿 node。
fn graceful_stop(pid: i32, timeout: Duration) {
    if !process_alive(pid) {
        dbg_log(&format!("sidecar {pid} 已不在，无需收尸"));
        return;
    }
    unsafe {
        // 负 pid = 整个进程组；组首 == pid。
        let r = libc_kill(-pid, 15);
        dbg_log(&format!("kill -TERM pgid {pid} -> {r}"));
        // 若独立成组失败（r!=0），退回直接打进程。
        if r != 0 {
            let r2 = libc_kill(pid, 15);
            dbg_log(&format!("kill -TERM pid {pid} fallback -> {r2}"));
        }
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            dbg_log(&format!("sidecar {pid} 已退出（SIGTERM 优雅）"));
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    unsafe {
        let r = libc_kill(-pid, 9);
        dbg_log(&format!("超时，SIGKILL 进程组 {pid} -> {r}"));
    }
    thread::sleep(Duration::from_millis(300));
}

/// PoC-3 无交互自动更新编排（仅 GX_POC3=1 时在专用系统线程里跑）。
///
/// 流程与无交互判定（★严格遵守 updater 2.13.3 的真实时序）：
/// 1. 等 sidecar 就绪（轮询共享 PID 置位），再等几秒让内核把库真正打开，避免抢跑；
/// 2. updater().check() 拉构建期注入的静态源 latest.json（semver 判定，无新版=正常返回）；
/// 3. update.download()：收齐字节后先跑 minisign verify（updater.rs:837）。
///    其 on_download_finish 在 verify【之前】（:835），故该回调绝不能停 sidecar——
///    否则坏签名被拒时内核已被误停。篡改/坏签名在此 Err 返回，内核全程不动、旧版照跑；
/// 4. download 成功（已校验）后，才优雅停 sidecar（保 WAL 落盘）；
/// 5. update.install(bytes)（内部对字节再 verify 一次 + 解压替换 .app）；
/// 6. macOS 装完不自动重启，显式 app_handle.restart() 触发 ExitRequested(RESTART_EXIT_CODE)，
///    由主 run 循环放行并再做一次 sidecar 收尸，然后 Tauri 用新 .app 重启。
///
/// 本线程不在 tokio 运行时内，故两处 updater 异步调用用 block_on 驱动；等待一律用 std sleep。
/// 全过程写 POC3_LOG，外部脚本只需 grep RESULT 行即可判定，无需人点界面。
fn run_poc3_update(handle: tauri::AppHandle) {
    /// 等 sidecar PID 登记（内核已 listen）。
    fn wait_sidecar_ready(handle: &tauri::AppHandle) -> bool {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let pid = handle
                .try_state::<SidecarPid>()
                .map(|s| s.0.load(Ordering::SeqCst))
                .unwrap_or(0);
            if pid > 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(500));
        }
        false
    }

    if !wait_sidecar_ready(&handle) {
        poc3_log("RESULT FAIL reason=sidecar-never-ready");
        return;
    }
    poc3_log("sidecar ready; settle 4s before check");
    thread::sleep(Duration::from_secs(4));

    let updater = match handle.updater() {
        Ok(u) => u,
        Err(e) => {
            poc3_log(&format!("RESULT FAIL reason=updater-build error={e}"));
            return;
        }
    };

    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            poc3_log("RESULT NONE reason=already-latest（静态源版本不高于当前，属正常分支）");
            return;
        }
        Err(e) => {
            poc3_log(&format!("RESULT FAIL reason=check error={e}"));
            return;
        }
    };

    poc3_log(&format!(
        "update available: current={} remote={} target={} url={}",
        update.current_version, update.version, update.target, update.download_url
    ));

    // 下载进度回调（限频落日志）。
    let mut last_log: u64 = 0;
    // 关键：不能用 download_and_install 的 on_download_finish 停 sidecar。
    // 实测 tauri-plugin-updater 2.13.3（updater.rs:835-843）该回调在【下载完成时】先于
    // verify_signature 触发——若在其中停内核，坏签名虽被拒（843 行 Err），内核却已被我们误停。
    // 正确顺序：download（完成回调只记日志，不停任何东西；坏签名在此 Err 直接返回，内核不动）
    //          → 成功拿到字节后【这里才】优雅停 sidecar → install（内部再 verify 一次 + 替换）→ restart。
    let bytes = match tauri::async_runtime::block_on(update.download(
        move |chunk, total| {
            last_log = last_log.saturating_add(chunk as u64);
            // 每 ~4MiB 或已知总量末包打一条，避免日志爆量。
            if last_log % (4 * 1024 * 1024) < chunk as u64
                || matches!(total, Some(t) if last_log >= t)
            {
                poc3_log(&format!("download bytes={last_log} total={total:?}"));
            }
        },
        || {
            // 仅表示下载字节收齐；签名校验此刻【尚未】进行，绝不能在这里停 sidecar。
            poc3_log("download finished (signature not yet verified); keep sidecar running");
        },
    )) {
        Ok(b) => b,
        Err(e) => {
            // 篡改 / 坏签名落这里：on_download_finish 未停内核，sidecar 与旧版原样运行、业务不中断。
            poc3_log(&format!("RESULT FAIL reason=download_or_verify error={e}"));
            poc3_log("NOTE 校验失败：未安装，且 sidecar 全程未被停止（旧版继续运行）");
            return;
        }
    };

    // 下载【且 minisign 公钥校验】已通过——此刻、且仅此刻，才在替换前优雅停内核保最后落盘。
    poc3_log(&format!(
        "signature OK ({} bytes verified); graceful stop sidecar before install",
        bytes.len()
    ));
    let pid = handle
        .try_state::<SidecarPid>()
        .map(|s| s.0.swap(0, Ordering::SeqCst))
        .unwrap_or(0);
    if pid > 0 {
        graceful_stop(pid, Duration::from_secs(8));
    }

    // install 内部对 bytes 再 verify 一次，然后解压替换 .app；不会自动重启。
    if let Err(e) = update.install(bytes) {
        poc3_log(&format!("RESULT FAIL reason=install error={e}"));
        poc3_log("NOTE 安装失败：新包未落位（sidecar 已停，需重启 App；坏包不会替换成功）");
        return;
    }

    poc3_log("RESULT INSTALLED（新 .app 已落位），请求 restart");
    // 触发 RESTART_EXIT_CODE；主 run 循环会再停一次 sidecar（幂等）并放行重启。
    handle.restart();
}

/// PoC-4 专用无交互日志（壳口承载验证，与主退出日志分开，便于脚本直接 grep 判定）。
fn poc4_log(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(POC4_LOG)
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// PoC-4：壳自己的【极简回环静态服务】（#816 承载验证；D1/D3 产品化可换 tiny_http/axum）。
/// 零新依赖：std::net + thread-per-connection。只绑 127.0.0.1、随机端口，只托管 root 下静态文件
/// （不碰任何数据/API）。带目录穿越防护与基本 MIME。返回实际监听端口。
fn serve_static_loopback(root: PathBuf) -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("壳静态口绑定失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读壳静态口失败: {e}"))?
        .port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            thread::spawn(move || {
                let _ = serve_one(stream, &root);
            });
        }
    });
    Ok(port)
}

fn mime_for(path: &str) -> &'static str {
    if path.ends_with(".html") || path.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

fn serve_one(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    // 解析请求行：GET /path?query HTTP/1.1
    let mut lines = req.split_whitespace();
    let method = lines.next().unwrap_or("GET");
    let target = lines.next().unwrap_or("/");
    let path_only = target.split('?').next().unwrap_or("/");

    // PoC-4 探针结果旁路：同源 GET /__poc4/... 编码结果，落 POC4_LOG 供无交互判定（返回 204 空）。
    if path_only.starts_with("/__poc4/") {
        poc4_log(&format!("PROBE {method} {path_only}"));
        let _ = write!(stream, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
        return Ok(());
    }

    let rel = path_only.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let file = root.join(rel);
    // 目录穿越防护：规范化后必须仍在 root 内。
    let safe = file
        .canonicalize()
        .map(|c| c.starts_with(root.canonicalize().unwrap_or(root.to_path_buf())))
        .unwrap_or(false);
    if !safe || !file.is_file() {
        let body = "not found";
        let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        poc4_log(&format!("SHELL 404 {path_only}"));
        return Ok(());
    }
    let data = fs::read(&file)?;
    let mime = mime_for(&file.to_string_lossy());
    let head = format!(
    "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
    data.len()
  );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&data)?;
    poc4_log(&format!(
        "SHELL 200 {path_only} ({len} B)",
        len = data.len()
    ));
    Ok(())
}

/// PoC-4 编排（GX_POC4=1，#816）：
/// 1) 起本地内核（navigate=false，仅绑回环，默认 CORS 白名单已含 127.0.0.1 任意端口）拿内核口；
/// 2) 壳在独立回环口静态托管 server/public（含注入的 poc4.html）；
/// 3) WebView 导到壳口跨源探针页，并把内核口通过 query 传进去。
///
/// 验证：壳 http 源 → 内核口的 fetch/预检、带 X-GX-Token、multipart、公开/私有图 CORP、WS 跨源。
fn run_poc4(window: WebviewWindow, resource_dir: PathBuf, data_dir: PathBuf) {
    let _ = fs::remove_file(POC4_LOG);
    poc4_log(&format!("==== PoC-4 begin pid={} ====", std::process::id()));
    let web_root = resource_dir.join("server").join("public");
    if !web_root.join("poc4.html").exists() {
        poc4_log("FATAL 未找到随包 poc4.html（需 GX_POC4=1 重新 stage）");
        let _ = window.eval("document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">PoC-4 探针页未随包，请用 GX_POC4=1 重新 stage/build</pre>'");
        return;
    }
    // 1) 起内核但不导航。
    let kernel_port = match boot_local_kernel(&window, &resource_dir, &data_dir, false, false) {
        Ok(p) => p,
        Err(e) => {
            poc4_log(&format!("FATAL 内核启动失败: {e}"));
            let _ = window.eval(format!("document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">内核启动失败：{}</pre>'", js_escape(&e)));
            return;
        }
    };
    poc4_log(&format!(
        "kernel ready on 127.0.0.1:{kernel_port}（未导航）"
    ));

    // 2) 壳独立静态口。
    let shell_port = match serve_static_loopback(web_root) {
        Ok(p) => p,
        Err(e) => {
            poc4_log(&format!("FATAL {e}"));
            return;
        }
    };
    poc4_log(&format!(
        "shell static on 127.0.0.1:{shell_port}（跨端口 vs kernel {kernel_port}）"
    ));

    // 3) 导航 WebView 到壳口探针页（?kernel= 内核口）。
    let url = format!("http://127.0.0.1:{shell_port}/poc4.html?kernel={kernel_port}");
    if let Err(e) = window.eval(format!("window.location.replace('{url}');")) {
        poc4_log(&format!("FATAL 导航壳口失败: {e}"));
    }
}

/// R1 默认启动路径（IMPL §4）：绑定随机回环壳口，静态托管前端 + 反代当前活动上游，
/// 然后把主窗口导航到 `http://127.0.0.1:SHELL_PORT/`。R1 默认不起本地内核（R2 才命令式起停）。
///
/// 在普通系统线程中调用（与 PoC 一致），用 tauri 自带 tokio runtime 的 block_on 驱动绑定；
/// 服务任务经 `tauri::async_runtime::spawn` 常驻，App 生命周期内不退出。
fn boot_shell(window: WebviewWindow, resource_dir: PathBuf, state: Arc<commands::ShellState>) {
    // TODO(R3): 对齐 tauri.conf frontendDist 壳静态根（R1 先用 resource_dir/server/public）。
    let web_root = resource_dir.join(SERVER_DIR).join("public");
    state.set_web_root(web_root);

    // 绑定随机回环口（127.0.0.1:0），拿实际端口后写回状态，再起常驻服务。
    let bound = tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("壳口绑定失败: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("读壳口失败: {e}"))?
            .port();
        state.set_port(port);
        let serve_state = state.clone();
        tauri::async_runtime::spawn(async move {
            shell_server::serve(listener, serve_state).await;
        });
        Ok::<u16, String>(port)
    });

    match bound {
        Ok(port) => {
            dbg_log(&format!("R1 shell ready on 127.0.0.1:{port}"));
            let url = format!("http://127.0.0.1:{port}/");
            if let Err(e) = window.eval(format!("window.location.replace('{url}');")) {
                eprintln!("[desktop] 导航壳口失败: {e}");
                let _ = window.eval(
          "document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">壳口启动失败，无法加载界面</pre>'",
        );
            }
        }
        Err(e) => {
            eprintln!("[desktop] {e}");
            let _ = window.eval(format!(
                "document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">{}</pre>'",
                js_escape(&e)
            ));
        }
    }
}

/// 启动本地内核。
/// - `navigate = true`（PoC-1/2 默认）：内核就绪后 WebView 直接同源跳内核口（/ 或 /poc2.html）。
/// - `navigate = false`（PoC-4）：只起内核、不导航，返回端口；由调用方起壳静态口后把
///   WebView 导到壳口跨源探针页（?kernel=<内核口>）。
fn boot_local_kernel(
    window: &WebviewWindow,
    resource_dir: &Path,
    data_dir: &Path,
    poc2: bool,
    navigate: bool,
) -> Result<u16, String> {
    if poc2 {
        let _ = fs::remove_file(POC2_SIDECAR_LOG);
        dbg_log(&format!(
            "PoC-2 mode ON: sidecar log -> {POC2_SIDECAR_LOG}, nav /poc2.html, data={}",
            data_dir.display()
        ));
    }
    let node = resource_dir.join(NODE_BIN);
    let server = resource_dir.join(SERVER_DIR);
    if !node.exists() {
        return Err(format!("随包 Node 缺失：{}", node.display()));
    }
    if !server.join("dist/index.js").exists() {
        return Err(format!(
            "内核 dist 缺失：{}/dist/index.js",
            server.display()
        ));
    }

    fs::create_dir_all(data_dir).map_err(|e| format!("建数据目录失败: {e}"))?;
    let uploads = data_dir.join("uploads");
    let audit = data_dir.join(".audit");
    fs::create_dir_all(&uploads).ok();
    fs::create_dir_all(&audit).ok();

    let db_path = data_dir.join("dev.db");
    // 首启用的 dev.db 冷备（只在已有库时做；PoC 简单文件拷贝，sidecar 尚未启动）。
    if db_path.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = fs::copy(&db_path, data_dir.join(format!("dev.db.{stamp}.bak")));
    }

    // JWT 密钥：PoC 存本地文件（≥32 字节）；D2 换 Keychain。
    let secret_path = data_dir.join(".jwt-secret");
    let jwt_secret = match fs::read_to_string(&secret_path) {
        Ok(s) if s.len() >= 32 => s,
        _ => {
            let s = random_secret(48);
            fs::write(&secret_path, &s).map_err(|e| format!("写密钥文件失败: {e}"))?;
            s
        }
    };

    let common_env = vec![
        ("NODE_ENV", "production"),
        ("GX_BIND_HOST", "127.0.0.1"),
        ("CORS_ORIGIN", "http://127.0.0.1:*,http://localhost:*"),
    ];

    // 1) migrate deploy（同步，只增不删）。
    let migrate_status = Command::new(&node)
        .current_dir(&server)
        .arg("node_modules/prisma/build/index.js")
        .arg("migrate")
        .arg("deploy")
        .arg("--schema=prisma/schema.prisma")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("GX_DATA_DIR", data_dir)
        .envs(common_env.clone())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("启动 migrate 失败: {e}"))?;
    if !migrate_status.success() {
        return Err(format!(
            "prisma migrate deploy 退出码 {migrate_status}（已保留旧库与备份）"
        ));
    }

    // 1.5) nav-reconcile --apply（幂等，迁移后重算导航 path）。与飞牛 install/upgrade 回调同序；
    //      失败不阻断首启（导航可在运行期修复），仅记日志。
    let nav_status = Command::new(&node)
        .current_dir(&server)
        .arg("dist/nav-reconcile.js")
        .arg("--apply")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("GX_DATA_DIR", data_dir)
        .env("GX_AUDIT_DIR", &audit)
        .env("JWT_SECRET", &jwt_secret) // 内核脚本同样过生产配置闸门，需 JWT_SECRET
        .envs(common_env.clone())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status();
    match nav_status {
        Ok(s) if s.success() => dbg_log("nav-reconcile --apply ok"),
        Ok(s) => dbg_log(&format!("nav-reconcile 非零退出 {s}（不阻断首启）")),
        Err(e) => dbg_log(&format!("nav-reconcile 启动失败 {e}（不阻断首启）")),
    }

    // 2) 选一个空闲回环端口。
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("选端口失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读端口失败: {e}"))?
        .port();
    drop(listener);

    // 3) 起常驻内核。PoC-2 时 stdout/stderr 落盘（探针经同源访问日志旁路回传结果）。
    let open_log = || -> Stdio {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(POC2_SIDECAR_LOG)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null())
    };
    let (out_log, err_log) = if poc2 {
        (open_log(), open_log())
    } else {
        (Stdio::null(), Stdio::null())
    };
    let child = Command::new(&node)
        .current_dir(&server)
        .arg("dist/index.js")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("GX_DATA_DIR", data_dir)
        .env("UPLOAD_ROOT", &uploads)
        .env("GX_AUDIT_DIR", &audit)
        .env("GX_WEB_DIST", server.join("public"))
        .env("GX_MIGRATIONS_DIR", server.join("prisma/migrations"))
        .env("PORT", port.to_string())
        .env("JWT_SECRET", jwt_secret)
        .envs(common_env)
        .process_group(0) // sidecar 自成进程组（pgid=其 pid），退出时整组 SIGTERM
        .stdout(out_log)
        .stderr(err_log)
        .spawn()
        .map_err(|e| format!("启动内核失败: {e}"))?;

    let sidecar_pid = child.id() as i32;

    // 4) 轮询回环端口（migrate 已完成，listen 成功即可用）。句柄将 forget，故用 signal 0 探活。
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut ready = false;
    while Instant::now() < deadline {
        let alive = unsafe { libc_kill(sidecar_pid, 0) == 0 };
        if !alive {
            return Err("内核提前退出（进程已不存在）".into());
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    if !ready {
        unsafe {
            libc_kill(-sidecar_pid, 9);
        }
        return Err("40s 内本地内核未监听回环端口".into());
    }

    // 登记 PID 供退出时收尸；句柄 forget（不与 Rust 进程同生死，由 ExitRequested 显式停止）。
    if let Some(state) = window.app_handle().try_state::<SidecarPid>() {
        state.0.store(sidecar_pid, Ordering::SeqCst);
    }
    std::mem::forget(child);
    dbg_log(&format!("sidecar ready pid={sidecar_pid} port={port}"));

    // PoC-4（navigate=false）：不导航，端口交回调用方，由壳静态口就绪后再跨源引导 WebView。
    if !navigate {
        dbg_log(&format!(
            "sidecar ready (no-nav) pid={sidecar_pid} port={port}"
        ));
        return Ok(port);
    }

    // PoC-2：导航到同源探针页（由 stage 注入 public/poc2.html）；默认是首页 /。
    let path = if poc2 { "/poc2.html" } else { "/" };
    let nav_url = format!("http://127.0.0.1:{port}{path}");
    // 5) WebView 跳到内核同源页（界面/API/WS/附件全同源，绕开自定义协议 CORS）。
    window
        .eval(format!("window.location.replace('{nav_url}');"))
        .map_err(|e| format!("跳转本地内核失败: {e}"))?;
    Ok(port)
}

fn random_secret(n: usize) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e3779b97f4a7c15)
        ^ std::process::id() as u64;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    (0..n)
        .map(|_| {
            // xorshift64*
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            let r = x.wrapping_mul(0x2545F4914F6CDD1D);
            alphabet[(r >> 33) as usize % alphabet.len()] as char
        })
        .collect()
}

fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', " ")
}

// 直接调 libc kill：成功 0，失败 -1（errno）。避免为一个 syscall 引 libc crate。
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, sig)
}
