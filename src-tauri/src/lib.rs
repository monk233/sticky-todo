//! sticky-todo 的 Tauri 后端。
//!
//! 职责划分：
//! - `config`：本机数据目录的位置；
//! - `store`：data.json 的原子读写；
//! - `images`：图片导入；
//! - `themes`：自定义主题文件的读取；
//! - 本文件：把上面四者包装成 IPC 命令，并管理窗口、托盘与全局快捷键。

mod config;
mod images;
mod store;
mod themes;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use config::{AppConfig, ConfigStore};
use store::{DataFile, DataStore, LoadOutcome, StoreError};

const MAIN_WINDOW: &str = "main";

/// 事件名：托盘或全局快捷键要求新建任务 / 新建分组。
const EVENT_NEW_TASK: &str = "app://new-task";
const EVENT_NEW_GROUP: &str = "app://new-group";

struct AppState {
    config: ConfigStore,
    data_dir: Mutex<PathBuf>,
    default_data_dir: PathBuf,
    /// 关闭按钮是否隐藏到托盘，由前端在保存设置时同步过来。
    close_to_tray: Mutex<bool>,
    /// 用户主动退出时置位，用来跳过「关闭窗口即隐藏」的拦截。
    quitting: AtomicBool,
}

fn current_data_dir(state: &State<'_, AppState>) -> PathBuf {
    state
        .data_dir
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.quitting.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

/// 让 asset 协议可以读取数据目录下的图片。数据目录是用户自选的，
/// 只能在运行时把路径加进作用域。
fn allow_asset_dir(app: &AppHandle, dir: &Path) {
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(dir, true);
}

/// 把一段组合键描述规范化成 global-hotkey 认得的 Code 名。
fn normalize_accelerator_part(part: &str) -> String {
    let lower = part.to_ascii_lowercase();
    match lower.as_str() {
        "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => return "Ctrl".to_string(),
        "alt" | "option" => return "Alt".to_string(),
        "shift" => return "Shift".to_string(),
        "super" | "meta" | "cmd" | "command" | "win" => return "Super".to_string(),
        "space" | "spacebar" => return "Space".to_string(),
        "esc" | "escape" => return "Escape".to_string(),
        "enter" | "return" => return "Enter".to_string(),
        "up" => return "ArrowUp".to_string(),
        "down" => return "ArrowDown".to_string(),
        "left" => return "ArrowLeft".to_string(),
        "right" => return "ArrowRight".to_string(),
        _ => {}
    }

    let mut chars = part.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        if ch.is_ascii_alphabetic() {
            return format!("Key{}", ch.to_ascii_uppercase());
        }
        if ch.is_ascii_digit() {
            return format!("Digit{ch}");
        }
    }

    part.to_string()
}

/// 生成若干候选写法。存储层写的是人读得懂的 "Ctrl+Alt+N"，而 global-hotkey
/// 主要认 "Ctrl+Alt+KeyN" 这类 Code 名，不同版本对修饰符别名的接受度也不一致，
/// 所以逐个试，任一成功即可。
fn accelerator_candidates(input: &str) -> Vec<String> {
    let trimmed = input.trim().to_string();
    let mut candidates = vec![trimmed.clone()];

    let normalized = trimmed
        .split('+')
        .map(|part| normalize_accelerator_part(part.trim()))
        .collect::<Vec<_>>()
        .join("+");

    if normalized != trimmed {
        candidates.push(normalized.clone());
    }

    candidates.push(normalized.replace("Ctrl", "Control"));
    candidates.push(normalized.replace("Super", "Meta"));

    candidates.sort();
    candidates.dedup();
    candidates
}

fn parse_accelerator(input: &str) -> Option<Shortcut> {
    if input.trim().is_empty() {
        return None;
    }
    accelerator_candidates(input)
        .iter()
        .find_map(|candidate| candidate.parse::<Shortcut>().ok())
}

/// 注册全局快捷键；先清掉旧键。返回是否注册成功。
fn apply_global_hotkey(app: &AppHandle, accelerator: &str) -> bool {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let Some(shortcut) = parse_accelerator(accelerator) else {
        return false;
    };

    manager
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                show_main_window(app);
                let _ = app.emit_to(MAIN_WINDOW, EVENT_NEW_TASK, ());
            }
        })
        .is_ok()
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏窗口", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, "new_task", "新建任务", true, None::<&str>)?;
    let new_group = MenuItem::with_id(app, "new_group", "新建分组", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let items: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 5] =
        [&toggle, &new_task, &new_group, &separator, &quit];
    let menu = Menu::with_items(app, &items)?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("待办便签")
        .menu(&menu)
        // 左键单击用来切换窗口显隐，菜单留给右键，避免一次点击触发两个动作。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "new_task" => {
                show_main_window(app);
                let _ = app.emit_to(MAIN_WINDOW, EVENT_NEW_TASK, ());
            }
            "new_group" => {
                show_main_window(app);
                let _ = app.emit_to(MAIN_WINDOW, EVENT_NEW_GROUP, ());
            }
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    data_dir: String,
    default_data_dir: String,
    app_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadResult {
    data: DataFile,
    warnings: Vec<String>,
    created: bool,
    data_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    saved_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    rel_path: String,
}

fn now_millis() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", now.as_millis())
}

#[tauri::command]
fn get_bootstrap(app: AppHandle, state: State<'_, AppState>) -> Bootstrap {
    Bootstrap {
        data_dir: current_data_dir(&state).to_string_lossy().to_string(),
        default_data_dir: state.default_data_dir.to_string_lossy().to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn set_data_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("数据目录不能为空。".to_string());
    }

    let dir = PathBuf::from(trimmed);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建或访问 {}：{e}", dir.display()))?;

    let as_string = dir.to_string_lossy().to_string();

    state
        .config
        .save(&AppConfig {
            data_dir: as_string.clone(),
        })
        .map_err(|e| format!("保存配置失败：{e}"))?;

    {
        let mut guard = state
            .data_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = dir.clone();
    }

    allow_asset_dir(&app, &dir);
    Ok(as_string)
}

#[tauri::command]
fn load_data(app: AppHandle, state: State<'_, AppState>) -> Result<LoadResult, String> {
    let dir = current_data_dir(&state);
    let data_store = DataStore::new(dir.clone());

    let outcome = match data_store.load() {
        Ok(outcome) => outcome,
        Err(StoreError::Corrupt { .. }) => {
            // 无法解析的文件先改名备份，再用初始数据启动，绝不覆盖用户内容。
            let backup = data_store.quarantine().map_err(|e| e.to_string())?;
            let mut outcome = data_store.load().map_err(|e| e.to_string())?;
            let name = backup
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| backup.to_string_lossy().to_string());
            outcome.warnings.insert(
                0,
                format!("原数据文件无法解析，已备份为 {name}，本次以空数据启动。"),
            );
            outcome
        }
        Err(other) => return Err(other.to_string()),
    };

    let LoadOutcome {
        data,
        warnings,
        created,
    } = outcome;

    allow_asset_dir(&app, &dir);

    Ok(LoadResult {
        data,
        warnings,
        created,
        data_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn save_data(state: State<'_, AppState>, data: DataFile) -> Result<SaveResult, String> {
    let dir = current_data_dir(&state);
    DataStore::new(dir).save(&data).map_err(|e| e.to_string())?;

    {
        let mut guard = state
            .close_to_tray
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = data.settings.close_to_tray;
    }

    Ok(SaveResult {
        saved_at: now_millis(),
    })
}

#[tauri::command]
fn import_image(state: State<'_, AppState>, source: String) -> Result<ImportResult, String> {
    let dir = current_data_dir(&state);
    images::import_path(&dir, Path::new(&source))
        .map(|rel_path| ImportResult { rel_path })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn import_image_bytes(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    ext: String,
) -> Result<ImportResult, String> {
    let dir = current_data_dir(&state);
    images::import_bytes(&dir, &bytes, &ext)
        .map(|rel_path| ImportResult { rel_path })
        .map_err(|e| e.to_string())
}

/// 用系统文件管理器打开一个目录，不存在时先创建。
fn open_directory(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建 {}：{e}", dir.display()))?;

    #[cfg(windows)]
    let spawned = std::process::Command::new("explorer").arg(dir).spawn();

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(dir).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(dir).spawn();

    spawned.map_err(|e| format!("打开目录失败：{e}"))?;
    Ok(())
}

#[tauri::command]
fn open_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    open_directory(&current_data_dir(&state))
}

#[tauri::command]
fn open_themes_dir(state: State<'_, AppState>) -> Result<(), String> {
    open_directory(&current_data_dir(&state).join("themes"))
}

#[tauri::command]
fn list_user_themes(state: State<'_, AppState>) -> Result<Vec<themes::ThemeFile>, String> {
    let dir = current_data_dir(&state).join("themes");
    themes::load_user_themes(&dir).map_err(|e| format!("读取主题目录失败：{e}"))
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = sender.send(folder);
    });

    let picked = receiver
        .recv()
        .map_err(|e| format!("目录选择对话框异常：{e}"))?;

    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_image(app: AppHandle) -> Result<Option<String>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("图片", &images::ALLOWED_EXTENSIONS)
        .pick_file(move |file| {
            let _ = sender.send(file);
        });

    let picked = receiver
        .recv()
        .map_err(|e| format!("图片选择对话框异常：{e}"))?;

    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("读取开机自启状态失败：{e}"))
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| format!("设置开机自启失败：{e}"))
}

#[tauri::command]
fn set_global_hotkey(app: AppHandle, accelerator: Option<String>) -> Result<bool, String> {
    Ok(apply_global_hotkey(
        &app,
        accelerator.as_deref().unwrap_or_default(),
    ))
}

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|e| format!("设置窗口置顶失败：{e}"))
}

#[tauri::command]
fn quit_app_command(app: AppHandle) {
    quit_app(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle();

            let config_path = handle
                .path()
                .app_config_dir()
                .map(|dir| dir.join("config.json"))
                .unwrap_or_else(|_| PathBuf::from("sticky-todo-config.json"));
            let config = ConfigStore::new(config_path);

            let default_data_dir = handle
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("sticky-todo-data"));

            let configured = config.load().data_dir;
            let data_dir = if configured.trim().is_empty() {
                default_data_dir.clone()
            } else {
                PathBuf::from(configured.trim())
            };

            allow_asset_dir(handle, &data_dir);

            app.manage(AppState {
                config,
                data_dir: Mutex::new(data_dir),
                default_data_dir,
                close_to_tray: Mutex::new(true),
                quitting: AtomicBool::new(false),
            });

            build_tray(handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let quitting = state.quitting.load(Ordering::SeqCst);
                let close_to_tray = *state
                    .close_to_tray
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());

                if close_to_tray && !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap,
            set_data_dir,
            load_data,
            save_data,
            import_image,
            import_image_bytes,
            open_data_dir,
            open_themes_dir,
            list_user_themes,
            pick_directory,
            pick_image,
            get_autostart,
            set_autostart,
            set_global_hotkey,
            set_always_on_top,
            quit_app_command,
        ])
        .build(tauri::generate_context!())
        .expect("初始化 sticky-todo 失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                let quitting = state.quitting.load(Ordering::SeqCst);
                let close_to_tray = *state
                    .close_to_tray
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());

                // 托盘常驻：窗口关完不应该把进程带走。
                if close_to_tray && !quitting {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_accelerator_parses() {
        assert!(parse_accelerator("Ctrl+Alt+N").is_some());
    }

    #[test]
    fn code_style_accelerator_parses() {
        assert!(parse_accelerator("Ctrl+Alt+KeyN").is_some());
        assert!(parse_accelerator("Ctrl+Shift+Digit1").is_some());
    }

    #[test]
    fn empty_accelerator_is_rejected() {
        assert!(parse_accelerator("").is_none());
        assert!(parse_accelerator("   ").is_none());
    }

    #[test]
    fn unknown_key_is_rejected() {
        assert!(parse_accelerator("Ctrl+Alt+没有这个键").is_none());
    }

    #[test]
    fn single_character_parts_are_normalized() {
        assert_eq!(normalize_accelerator_part("n"), "KeyN");
        assert_eq!(normalize_accelerator_part("N"), "KeyN");
        assert_eq!(normalize_accelerator_part("7"), "Digit7");
        assert_eq!(normalize_accelerator_part("ctrl"), "Ctrl");
        assert_eq!(normalize_accelerator_part("esc"), "Escape");
        assert_eq!(normalize_accelerator_part("F5"), "F5");
    }

    #[test]
    fn candidates_include_both_human_and_code_forms() {
        let candidates = accelerator_candidates("Ctrl+Alt+N");
        assert!(candidates.contains(&"Ctrl+Alt+N".to_string()));
        assert!(candidates.contains(&"Ctrl+Alt+KeyN".to_string()));
        assert!(candidates.contains(&"Control+Alt+KeyN".to_string()));
    }
}
