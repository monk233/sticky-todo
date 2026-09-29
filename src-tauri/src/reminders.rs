//! 到期提醒。
//!
//! 前端在数据变化时把「未完成 + 有到期时间」的任务推过来，时间用毫秒时间戳，
//! 这样后端不必再引一个日期库。常驻线程按间隔检查，到点发系统通知。
//!
//! Windows 上不走 tauri-plugin-notification：那个插件只在「已安装」的应用里
//! 设置自己的 AppUserModelID，未安装时通知卡片会顶着 Windows PowerShell 的身份。
//! 这里直接调 WinRT，AUMID 自己登记，顺带把「延后」按钮接上。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

/// 前端推上来的提醒条目。due_ms 是 UTC 毫秒时间戳。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderItem {
    pub id: String,
    pub due_ms: i64,
    pub text: String,
}

/// 用户在通知里点了「延后」，要回传给前端的请求。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeRequest {
    pub id: String,
    pub minutes: i64,
}

/// 前端监听的事件名。
pub const EVENT_REMINDER_SNOOZE: &str = "app://reminder-snooze";

/// 通知身份。Windows 靠 AppUserModelID 认应用，卡片上那行名字就是它。
#[cfg(windows)]
pub const AUMID: &str = "com.stickytodo.desktop";

/// 卡片上显示的应用名。
#[cfg(windows)]
pub const APP_DISPLAY_NAME: &str = "待办便签";

/// 点一下「延后」往后推多少分钟。
#[cfg(windows)]
const SNOOZE_MINUTES: [i64; 3] = [10, 30, 60];

/// 按钮 action 的前缀。
#[cfg(windows)]
const SNOOZE_PREFIX: &str = "snooze";

/// 登记 AUMID 时得有个真实文件当图标，运行时把内嵌的这份放到数据目录。
#[cfg(windows)]
const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

#[derive(Default)]
pub struct ReminderState {
    items: Vec<ReminderItem>,
    /// 已经响过的条目键，避免同一个到期时刻反复提醒。
    fired: HashSet<String>,
}

pub type SharedReminders = Arc<Mutex<ReminderState>>;

pub fn new_shared() -> SharedReminders {
    Arc::new(Mutex::new(ReminderState::default()))
}

/// 检查间隔。到点误差最多半分钟，对自用清单足够。
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// 只补提醒这么久以内到期的，免得开机炸出一堆历史逾期。
const CATCH_UP_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// 通知正文最多这么长。
const MAX_BODY_CHARS: usize = 80;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn fired_key(item: &ReminderItem) -> String {
    format!("{}@{}", item.id, item.due_ms)
}

/// 现在该响的条目：已到点、还在补提醒窗口内、而且没响过。
pub fn due_now(items: &[ReminderItem], fired: &HashSet<String>, now: i64) -> Vec<ReminderItem> {
    items
        .iter()
        .filter(|item| {
            item.due_ms <= now
                && now - item.due_ms <= CATCH_UP_WINDOW_MS
                && !fired.contains(&fired_key(item))
        })
        .cloned()
        .collect()
}

/// 通知正文：折叠换行、去掉空白、太长就截断。
pub fn notification_body(text: &str) -> String {
    let single_line = text.replace(['\r', '\n'], " ");
    let trimmed = single_line.trim();

    if trimmed.is_empty() {
        return "有一条待办到期了。".to_string();
    }

    let mut body: String = trimmed.chars().take(MAX_BODY_CHARS).collect();
    if trimmed.chars().count() > MAX_BODY_CHARS {
        body.push('…');
    }
    body
}

/// 用新的计划替换旧计划；已经响过的记录保留，同一条不会重复提醒。
pub fn replace_items(state: &SharedReminders, items: Vec<ReminderItem>) {
    let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.items = items;
}

/// 按钮 action：snooze|分钟|任务 id。
#[cfg(windows)]
fn snooze_argument(task_id: &str, minutes: i64) -> String {
    format!("{SNOOZE_PREFIX}|{minutes}|{task_id}")
}

/// 解析按钮回传的 action。认不出就返回 None。
#[cfg(windows)]
pub fn parse_snooze_argument(argument: &str) -> Option<SnoozeRequest> {
    let mut parts = argument.splitn(3, '|');
    if parts.next()? != SNOOZE_PREFIX {
        return None;
    }

    let minutes = parts.next()?.parse::<i64>().ok()?;
    let id = parts.next()?.to_string();

    if id.is_empty() || minutes <= 0 {
        return None;
    }

    Some(SnoozeRequest { id, minutes })
}

/// 把内嵌的图标写到本地数据目录，返回可当 IconUri 用的路径。
///
/// 免安装运行时图标还躺在源码目录里，而注册表只认磁盘上真实存在的文件。
#[cfg(windows)]
pub fn materialize_icon(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    let dir = app.path().app_local_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;

    let path = dir.join("aumid-icon.png");
    let expected = ICON_PNG.len() as u64;
    let current = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if current != expected {
        std::fs::write(&path, ICON_PNG).ok()?;
    }

    Some(path)
}

/// 把 AUMID 登记到当前用户下。
///
/// 未安装的应用没有安装器帮忙登记，只能自己写一条；少了这条，系统不认这个
/// 身份，通知卡片上的名字就不是我们的。
#[cfg(windows)]
pub fn register_aumid(icon: Option<&std::path::Path>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(format!("Software\\Classes\\AppUserModelId\\{AUMID}"))
    else {
        return;
    };

    let _ = key.set_value("DisplayName", &APP_DISPLAY_NAME);
    if let Some(path) = icon {
        let _ = key.set_value("IconUri", &path.to_string_lossy().to_string());
    }
}

/// 开始菜单里那个快捷方式的落点。名字本身就是通知卡片上的应用名。
#[cfg(windows)]
fn start_menu_shortcut_path() -> Option<std::path::PathBuf> {
    let programs = std::env::var("APPDATA").ok()?;

    Some(
        std::path::Path::new(&programs)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(format!("{APP_DISPLAY_NAME}.lnk")),
    )
}

/// 在开始菜单放一个绑了 AUMID 的快捷方式。
///
/// 只写 AppUserModelId 注册表项是不够的：通知卡片上那行名字，Windows 是从开始
/// 菜单快捷方式里取的，找不到就退回去把 AUMID 字符串原样显示出来。
#[cfg(windows)]
pub fn ensure_start_menu_shortcut() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    let exe = std::env::current_exe().ok()?;
    let link = start_menu_shortcut_path()?;

    unsafe {
        // 已经初始化过就会失败，那种情况照样能用，忽略返回值。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        if write_shortcut(&exe, &link).is_err() {
            return None;
        }
    }

    Some(link)
}

/// 快捷方式本体：全 COM 样板，任一步失败就整个放弃。
#[cfg(windows)]
unsafe fn write_shortcut(
    exe: &std::path::Path,
    link_path: &std::path::Path,
) -> windows::core::Result<()> {
    use windows::core::{GUID, HSTRING, Interface, PWSTR};
    use windows::Win32::Foundation::{E_OUTOFMEMORY, PROPERTYKEY};
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemAlloc, CoTaskMemFree, IPersistFile,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    /// System.AppUserModel.ID
    const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;

    let exe_text = HSTRING::from(exe.to_string_lossy().as_ref());
    link.SetPath(&exe_text)?;
    link.SetIconLocation(&exe_text, 0)?;

    let store: IPropertyStore = link.cast()?;

    let wide: Vec<u16> = AUMID.encode_utf16().chain(std::iter::once(0)).collect();
    let raw = CoTaskMemAlloc(wide.len() * std::mem::size_of::<u16>()) as *mut u16;
    if raw.is_null() {
        return Err(windows::core::Error::from(E_OUTOFMEMORY));
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), raw, wide.len());

    // 手工拼一个 VT_LPWSTR 的 PROPVARIANT：windows 没有暴露
    // InitPropVariantFromString，而 union 字段不能逐个赋值，只能整体构造。
    let value = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(raw),
                },
            }),
        },
    };

    // SetValue 会把值拷进属性存储，随后这块临时内存就能还回去了。
    let stored = store
        .SetValue(&PKEY_APP_USER_MODEL_ID, &value)
        .and_then(|()| store.Commit());
    CoTaskMemFree(Some(raw as *const core::ffi::c_void));
    stored?;

    let file: IPersistFile = link.cast()?;
    file.Save(&HSTRING::from(link_path.to_string_lossy().as_ref()), true)?;

    Ok(())
}

/// 弹一条提醒。Windows 上挂三个「延后」，点了就通知前端改到期时间。
#[cfg(windows)]
fn show_reminder(app: &AppHandle, item: &ReminderItem) {
    use tauri::Emitter;
    use tauri_winrt_notification::{Duration, Toast};

    let body = notification_body(&item.text);
    let activation_app = app.clone();

    let mut toast = Toast::new(AUMID)
        .title(&body)
        .duration(Duration::Short)
        .on_activated(move |action| {
            if let Some(request) = action.as_deref().and_then(parse_snooze_argument) {
                let _ = activation_app.emit(EVENT_REMINDER_SNOOZE, request);
            }
            Ok(())
        });

    for minutes in SNOOZE_MINUTES {
        toast = toast.add_button(
            &format!("延后 {minutes} 分钟"),
            &snooze_argument(&item.id, minutes),
        );
    }

    let _ = toast.show();
}

/// 其他平台的兜底：仍旧走插件，那边没有 AUMID 这回事。
#[cfg(not(windows))]
fn show_reminder(app: &AppHandle, item: &ReminderItem) {
    let _ = app
        .notification()
        .builder()
        .title(APP_DISPLAY_NAME)
        .body(notification_body(&item.text))
        .show();
}

/// 起一个常驻线程，按间隔检查并发送通知。
pub fn spawn_worker(app: AppHandle, state: SharedReminders) {
    thread::spawn(move || loop {
        thread::sleep(CHECK_INTERVAL);

        let pending = {
            let guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            due_now(&guard.items, &guard.fired, now_ms())
        };

        if pending.is_empty() {
            continue;
        }

        for item in pending {
            show_reminder(&app, &item);

            // 无论发没发出去都记为已处理：失败时每半分钟重试一次只会刷屏，
            // 用户想要的是「这条到点了」，不是「这条一直在响」。
            let mut guard = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.fired.insert(fired_key(&item));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, due_ms: i64, text: &str) -> ReminderItem {
        ReminderItem {
            id: id.to_string(),
            due_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn due_now_picks_only_what_has_come_due() {
        let now = 1_000_000_i64;
        let items = vec![
            item("past", now - 60_000, "已经到点"),
            item("future", now + 60_000, "还没到"),
            item("ancient", now - CATCH_UP_WINDOW_MS - 1, "早就过期了"),
        ];

        let due = due_now(&items, &HashSet::new(), now);

        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "past");
    }

    #[test]
    fn due_now_skips_what_already_fired() {
        let now = 1_000_000_i64;
        let items = vec![item("a", now - 1000, "响过了")];
        let mut fired = HashSet::new();
        fired.insert(fired_key(&items[0]));

        assert!(due_now(&items, &fired, now).is_empty());
    }

    #[test]
    fn fired_key_separates_the_same_task_by_due_time() {
        let first = item("t1", 100, "x");
        let next = item("t1", 200, "x");

        assert_ne!(fired_key(&first), fired_key(&next));
        assert_eq!(fired_key(&first), "t1@100");
    }

    #[test]
    fn catch_up_window_boundary() {
        let now = 1_000_000_i64;
        let inside = vec![item("inside", now - CATCH_UP_WINDOW_MS, "刚好在窗口边上")];
        let outside = vec![item("outside", now - CATCH_UP_WINDOW_MS - 1, "差一毫秒就出去了")];

        assert_eq!(due_now(&inside, &HashSet::new(), now).len(), 1);
        assert!(due_now(&outside, &HashSet::new(), now).is_empty());
    }

    #[test]
    fn notification_body_trims_and_truncates() {
        assert_eq!(notification_body("   "), "有一条待办到期了。");
        assert_eq!(notification_body("第一行\n第二行"), "第一行 第二行");

        let long = "字".repeat(200);
        let body = notification_body(&long);
        assert_eq!(body.chars().count(), MAX_BODY_CHARS + 1);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn notification_body_short_text_is_kept_as_is() {
        assert_eq!(notification_body("  交房租  "), "交房租");
        assert_eq!(notification_body("买牛奶"), "买牛奶");
    }

    #[test]
    fn replacing_the_plan_keeps_what_already_fired() {
        let state = new_shared();
        replace_items(&state, vec![item("t1", 100, "x")]);

        {
            let mut guard = state.lock().unwrap();
            guard.fired.insert("t1@100".to_string());
        }

        replace_items(&state, vec![item("t1", 100, "x"), item("t2", 200, "y")]);

        let guard = state.lock().unwrap();
        assert_eq!(guard.items.len(), 2);
        assert!(guard.fired.contains("t1@100"), "已响过的记录不该被清掉");
    }

    #[cfg(windows)]
    #[test]
    fn snooze_argument_round_trips() {
        let request = parse_snooze_argument("snooze|30|abc-123").expect("应当解析成功");

        assert_eq!(request.id, "abc-123");
        assert_eq!(request.minutes, 30);
    }

    #[cfg(windows)]
    #[test]
    fn snooze_argument_rejects_foreign_actions() {
        assert!(parse_snooze_argument("").is_none());
        assert!(parse_snooze_argument("dismiss").is_none());
        assert!(parse_snooze_argument("snooze|10").is_none());
        assert!(parse_snooze_argument("snooze|abc|id").is_none());
        assert!(parse_snooze_argument("snooze|10|").is_none());
        assert!(parse_snooze_argument("snooze|-5|id").is_none());
        assert!(parse_snooze_argument("snooze|0|id").is_none());
    }
}
