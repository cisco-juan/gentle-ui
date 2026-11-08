mod bridge_process;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(bridge_process::initial_state())
        .invoke_handler(tauri::generate_handler![
            greet,
            bridge_process::bridge_endpoint
        ])
        .setup(|app| {
            bridge_process::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window ends the session: the bridge must not outlive it as an orphan.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                bridge_process::shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Last resort for every other exit path, including a crash-free quit from the menu.
            if matches!(event, tauri::RunEvent::Exit) {
                bridge_process::shutdown(app);
            }
        });
}
