// PoC-1：把随包 Node sidecar + apps/api 内核嵌进 Tauri 包，干净机首启建库并只绑回环。
//
// 边界（PoC，后续 D2 替换）：
//   - JWT_SECRET 暂存数据目录 .jwt-secret 文件（D2 换 macOS Keychain，届时才弹系统授权）。
//   - 健康判据用「回环 TCP 可连通」；migrate 已在此前单独同步跑完，故 listen 成功即建库完成。
//   - 界面用 window.location.replace 跳到 http://127.0.0.1:<port>/（同源托管），PoC-2 再细化。
#![cfg_attr(not(debug_assertions), cfg_attr(windows, windows_subsystem = "windows"))]

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewWindow};

const BUNDLE_ID: &str = "cc.gouxiang.desktop";
const NODE_BIN: &str = "gxnode-aarch64-apple-darwin";
const SERVER_DIR: &str = "server";
const EXIT_LOG: &str = "/tmp/gx-desktop-exit.log";
/// PoC-2 门控（仅自测）：GX_POC2=1 时把 sidecar 输出落盘并导航到同源探针页 /poc2.html。
/// 默认（无此 env）行为与 PoC-1 完全一致：日志丢弃、导航到 /。
const POC2_SIDECAR_LOG: &str = "/tmp/gx-poc2-sidecar.log";

fn dbg_log(msg: &str) {
  use std::io::Write;
  if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(EXIT_LOG) {
    let _ = writeln!(f, "{msg}");
  }
}

// 只存 sidecar PID（0=未起/已停）。退出时按进程组发信号，避免持有 Child 的锁/借用问题。
struct SidecarPid(AtomicI32);

fn main() {
  let _ = fs::remove_file(EXIT_LOG);
  dbg_log(&format!("app run begin pid={}", std::process::id()));
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(SidecarPid(AtomicI32::new(0)))
    .setup(|app| {
      let window: WebviewWindow = app.get_webview_window("main").expect("main window");
      let resource_dir = app.path().resource_dir().expect("resource_dir");
      let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
      // PoC-2：数据目录可由 GX_POC2_DATA_DIR 覆盖（隔离自测，绝不碰真实 Application Support）。
      // 不能靠覆盖 HOME 隔离——会让 Tauri resource_dir() 解析失败（UnknownPath）。
      let data_dir = match std::env::var("GX_POC2_DATA_DIR") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => PathBuf::from(home)
          .join("Library/Application Support")
          .join(BUNDLE_ID),
      };

      thread::spawn(move || {
        let poc2 = std::env::var("GX_POC2").map(|v| v == "1").unwrap_or(false);
        if let Err(e) = boot_local_kernel(&window, &resource_dir, &data_dir, poc2) {
          eprintln!("[desktop] 本地内核启动失败: {e}");
          let _ = window.eval(&format!(
            "document.body.innerHTML='<pre style=\"padding:24px;color:#b00\">本地内核启动失败：{}</pre>'",
            js_escape(&e)
          ));
        }
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building GouXiangDB desktop");

  // 双保险收尸：
  //  - ExitRequested：可阻止。prevent_exit 后另起线程优雅停 sidecar（SIGTERM 等 ≤5s），再 app.exit。
  //  - Exit：不可阻止但仍能同步收尾，做有界 SIGTERM→SIGKILL 兜底（防某些终止路径不发 Requested）。
  app.run(move |app_handle, event| match event {
    tauri::RunEvent::ExitRequested { api, .. } => {
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

fn boot_local_kernel(window: &WebviewWindow, resource_dir: &Path, data_dir: &Path, poc2: bool) -> Result<String, String> {
  if poc2 {
    let _ = fs::remove_file(POC2_SIDECAR_LOG);
    dbg_log(&format!("PoC-2 mode ON: sidecar log -> {POC2_SIDECAR_LOG}, nav /poc2.html, data={}", data_dir.display()));
  }
  let node = resource_dir.join(NODE_BIN);
  let server = resource_dir.join(SERVER_DIR);
  if !node.exists() {
    return Err(format!("随包 Node 缺失：{}", node.display()));
  }
  if !server.join("dist/index.js").exists() {
    return Err(format!("内核 dist 缺失：{}/dist/index.js", server.display()));
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
    return Err(format!("prisma migrate deploy 退出码 {migrate_status}（已保留旧库与备份）"));
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
  let port = listener.local_addr().map_err(|e| format!("读端口失败: {e}"))?.port();
  drop(listener);

  // 3) 起常驻内核。PoC-2 时 stdout/stderr 落盘（探针经同源访问日志旁路回传结果）。
  let open_log = || -> Stdio {
    fs::OpenOptions::new()
      .create(true).append(true)
      .open(POC2_SIDECAR_LOG)
      .map(Stdio::from)
      .unwrap_or_else(|_| Stdio::null())
  };
  let (out_log, err_log) = if poc2 { (open_log(), open_log()) } else { (Stdio::null(), Stdio::null()) };
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

  // PoC-2：导航到同源探针页（由 stage 注入 public/poc2.html）；默认仍是首页 /。
  let path = if poc2 { "/poc2.html" } else { "/" };
  let url = format!("http://127.0.0.1:{port}{path}");
  // 5) WebView 跳到内核同源页（界面/API/WS/附件全同源，绕开自定义协议 CORS）。
  window
    .eval(&format!("window.location.replace('{url}');"))
    .map_err(|e| format!("跳转本地内核失败: {e}"))?;
  Ok(url)
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
  s.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ")
}

// 直接调 libc kill：成功 0，失败 -1（errno）。避免为一个 syscall 引 libc crate。
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
  extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
  }
  kill(pid, sig)
}
