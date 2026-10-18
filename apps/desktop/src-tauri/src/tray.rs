//! 菜单栏驻留托盘（IMPL-0.2.5-beta §4-R2 / #825 / #847）。
//!
//! 行为（DESIGN-MACOS-APP §8.5：关窗驻留菜单栏 + 显式彻底退出）：
//!   - 点窗口红色关闭钮：默认**隐藏**窗口、进程常驻（内核/反代不断），不退出；
//!   - 托盘菜单三项：显示主窗口 / 检查更新 / 彻底退出；
//!   - 「彻底退出」置退出标志 → 优雅停 sidecar → 真正退出；
//!   - updater 重启（RESTART_EXIT_CODE=80）不经本菜单，main 的 run 循环直接放行，
//!     绝不能被驻留逻辑 prevent_exit。
//!
//! 图标：编译期内嵌品牌 PNG（icons/32x32.png），非 emoji、非运行期外部文件依赖。

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    AppHandle, Manager,
};

/// 菜单事件 id（与构造时一一对应）。
pub const EVT_SHOW: &str = "gx:tray:show";
pub const EVT_CHECK_UPDATE: &str = "gx:tray:check_update";
pub const EVT_QUIT: &str = "gx:tray:quit";

/// 「彻底退出」请求标志：用户显式点菜单退出时置位，run 循环据此放行而非驻留。
/// updater RESTART(80) 不看此标志（始终放行）。
#[derive(Default)]
pub struct QuitFlag(std::sync::atomic::AtomicBool);

impl QuitFlag {
    pub fn request_quit(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn should_quit(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// 取品牌托盘图标：复用 Tauri 已加载的默认窗口图标（同源品牌 PNG），从其 RGBA 像素重建
/// 一个 `'static` 图像（不依赖外部解码 feature、零新依赖）。
fn tray_icon(app: &AppHandle) -> tauri::image::Image<'static> {
    match app.default_window_icon() {
        Some(img) => tauri::image::Image::new_owned(img.rgba().to_vec(), img.width(), img.height()),
        // 极端兜底：1×1 透明像素，保证托盘仍能创建（不应发生）。
        None => tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1),
    }
}

/// 构建并安装系统托盘，返回其 TrayId 对应的 Tray（Builder 上链式调用）。
pub fn build_tray(app: &AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    let show = MenuItem::with_id(app, EVT_SHOW, "显示主窗口", true, None::<&str>)?;
    let check = MenuItem::with_id(app, EVT_CHECK_UPDATE, "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, EVT_QUIT, "彻底退出 GouXiangDB", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check, &quit])?;

    tauri::tray::TrayIconBuilder::with_id("gx-main-tray")
        .icon(tray_icon(app))
        .tooltip("构想工作台")
        .menu(&menu)
        // macOS：点托盘图标本身也显示主窗口（无右键菜单习惯差异下的便利项）。
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(
            |tray: &tauri::tray::TrayIcon, event: tauri::tray::TrayIconEvent| {
                if let tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            },
        )
        .build(app)
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        EVT_SHOW => show_main_window(app),
        EVT_CHECK_UPDATE => {
            // #829 才接 updater 手动检查闭环（minisign endpoint/pubkey 在打包期注入）。
            // R2 不落原生弹窗（避免为此引入 dialog 插件），仅写退出日志备查。
            crate::dbg_log("tray 检查更新：#829 待接 updater，当前内测版本暂不检查");
        }
        EVT_QUIT => {
            // 置退出标志；run 循环的 ExitRequested 见标志后优雅停 sidecar 并真正退出。
            if let Some(flag) = app.try_state::<QuitFlag>() {
                flag.request_quit();
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// 显示并聚焦主窗口（从最小化/隐藏恢复）。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 关窗拦截：隐藏而非关闭（驻留菜单栏）。仅当不是显式彻底退出时才隐藏。
/// 收 `&tauri::Window`（on_window_event 回调给出的类型；Window 自身有 hide）。
pub fn hide_instead_of_close(win: &tauri::Window) {
    let app = win.app_handle();
    let quitting = app
        .try_state::<QuitFlag>()
        .map(|f| f.should_quit())
        .unwrap_or(false);
    if !quitting {
        let _ = win.hide();
    }
}
