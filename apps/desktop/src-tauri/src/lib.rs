// apps/desktop/src-tauri/src/lib.rs
// Tauri 应用入口 + 命令注册

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! 欢迎使用 GouXiangDB 桌面壳", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            // 启动时拿到主窗口（v1 风格）
            let window = app.get_webview_window("main").unwrap();
            window.set_title("GouXiangDB").unwrap();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("启动 GouXiangDB 失败");
}