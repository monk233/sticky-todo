//! 到期提醒。
//!
//! 前端在数据变化时把「未完成 + 有到期时间」的任务推过来，时间用毫秒时间戳，
//! 这样后端不必再引一个日期库。常驻线程按间隔检查，到点发系统通知。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 前端推上来的提醒条目。`due_ms` 是 UTC 毫秒时间戳。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderItem {
    pub id: String,
    pub due_ms: i64,
    pub text: String,
}

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
            let shown = app
                .notification()
                .builder()
                .title("待办便签")
                .body(notification_body(&item.text))
                .show();

            // 无论发没发出去都记为已处理：失败时每半分钟重试一次只会刷屏，
            // 用户想要的是「这条到点了」，不是「这条一直在响」。
            let _ = shown;
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
}
