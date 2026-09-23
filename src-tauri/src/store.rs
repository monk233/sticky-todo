//! data.json 的读写与校验。
//!
//! 这一层只负责「字节如何安全落盘」，不理解任何界面语义。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 当前支持的数据文件版本。
pub const CURRENT_VERSION: u32 = 1;

fn default_version() -> u32 {
    CURRENT_VERSION
}

fn default_layout() -> String {
    "panel".to_string()
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_hotkey() -> String {
    "Ctrl+Alt+N".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub layout: String,
    pub theme: String,
    pub always_on_top: bool,
    pub close_to_tray: bool,
    pub hide_completed: bool,
    pub completed_bottom: bool,
    pub hide_actions: bool,
    pub show_created_at: bool,
    pub show_updated_at: bool,
    pub global_hotkey_enabled: bool,
    pub global_hotkey: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            layout: default_layout(),
            theme: default_theme(),
            always_on_top: true,
            close_to_tray: true,
            hide_completed: false,
            completed_bottom: false,
            hide_actions: false,
            show_created_at: true,
            show_updated_at: true,
            global_hotkey_enabled: true,
            global_hotkey: default_hotkey(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i64,
}

impl Group {
    pub fn new(name: impl Into<String>, order: i64) -> Self {
        Self {
            id: generate_id("g"),
            name: name.into(),
            order,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    /// 未识别的顶层字段原样保留，避免本版本覆盖掉更新版本写入的内容。
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for DataFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            settings: Settings::default(),
            groups: Vec::new(),
            tasks: Vec::new(),
            extra: Map::new(),
        }
    }
}

/// 生成一个对当前进程足够唯一的标识符。前端使用 `crypto.randomUUID()`，
/// 两种形式的 id 都是普通字符串，可以混用。
pub fn generate_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}{nanos:x}{:04x}", std::process::id() & 0xffff)
}

/// 首次运行时的初始数据：一个默认分组，没有任务。
pub fn default_data() -> DataFile {
    DataFile {
        version: CURRENT_VERSION,
        settings: Settings::default(),
        groups: vec![Group::new("待办", 0)],
        tasks: Vec::new(),
        extra: Map::new(),
    }
}

#[derive(Debug)]
pub enum StoreError {
    Io {
        path: PathBuf,
        source: io::Error,
    },
    Corrupt {
        path: PathBuf,
        message: String,
    },
    FutureVersion {
        found: u32,
        supported: u32,
    },
    Serialize(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io { path, source } => {
                write!(f, "读写 {} 失败：{source}", path.display())
            }
            StoreError::Corrupt { path, message } => {
                write!(f, "{} 不是合法的 JSON 数据：{message}", path.display())
            }
            StoreError::FutureVersion { found, supported } => write!(
                f,
                "数据文件版本为 {found}，高于本程序支持的 {supported}。请使用更新版本的程序打开，本程序不会覆盖它。"
            ),
            StoreError::Serialize(message) => write!(f, "序列化数据失败：{message}"),
        }
    }
}

impl std::error::Error for StoreError {}

#[derive(Debug, Clone)]
pub struct LoadOutcome {
    pub data: DataFile,
    pub warnings: Vec<String>,
    /// 本次加载是否新建了数据文件。
    pub created: bool,
}

pub struct DataStore {
    dir: PathBuf,
}

impl DataStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn data_path(&self) -> PathBuf {
        self.dir.join("data.json")
    }

    /// 读取数据文件。文件不存在时创建初始数据；解析失败时返回 `Corrupt`，
    /// 由调用方决定如何备份与降级，本层不擅自覆盖用户文件。
    pub fn load(&self) -> Result<LoadOutcome, StoreError> {
        let path = self.data_path();
        let mut warnings = Vec::new();

        if !path.exists() {
            let data = default_data();
            self.save(&data)?;
            return Ok(LoadOutcome {
                data,
                warnings,
                created: true,
            });
        }

        let raw = fs::read(&path).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;

        let data: DataFile =
            serde_json::from_slice(&raw).map_err(|e| StoreError::Corrupt {
                path: path.clone(),
                message: e.to_string(),
            })?;

        if data.version > CURRENT_VERSION {
            return Err(StoreError::FutureVersion {
                found: data.version,
                supported: CURRENT_VERSION,
            });
        }

        if data.version < CURRENT_VERSION {
            warnings.push(format!(
                "数据文件版本为 {}，已按版本 {} 读取。",
                data.version, CURRENT_VERSION
            ));
        }

        Ok(LoadOutcome {
            data,
            warnings,
            created: false,
        })
    }

    pub fn save(&self, data: &DataFile) -> Result<(), StoreError> {
        if data.version > CURRENT_VERSION {
            return Err(StoreError::FutureVersion {
                found: data.version,
                supported: CURRENT_VERSION,
            });
        }

        fs::create_dir_all(&self.dir).map_err(|source| StoreError::Io {
            path: self.dir.clone(),
            source,
        })?;

        let mut json = serde_json::to_vec_pretty(data)
            .map_err(|e| StoreError::Serialize(e.to_string()))?;
        json.push(b'\n');

        write_atomic(&self.data_path(), &json).map_err(|source| StoreError::Io {
            path: self.data_path(),
            source,
        })?;

        Ok(())
    }

    /// 把无法解析的数据文件改名备份，返回备份后的路径。
    pub fn quarantine(&self) -> Result<PathBuf, StoreError> {
        let path = self.data_path();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut backup = path.as_os_str().to_os_string();
        backup.push(format!(".corrupt-{stamp}"));
        let backup = PathBuf::from(backup);

        fs::rename(&path, &backup).map_err(|source| StoreError::Io {
            path: path.clone(),
            source,
        })?;

        Ok(backup)
    }
}

/// 先写同目录下的 `.tmp` 文件并 `fsync`，再改名覆盖目标文件。
/// 这样任何时刻磁盘上的目标文件要么是旧的完整内容，要么是新的完整内容。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
    }

    // Windows 上 std 的 rename 使用 MOVEFILE_REPLACE_EXISTING，可直接覆盖已有文件。
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, DataStore) {
        let dir = tempdir().unwrap();
        let store = DataStore::new(dir.path().join("data"));
        (dir, store)
    }

    #[test]
    fn missing_file_creates_default_data_with_one_group() {
        let (_dir, store) = store();

        let outcome = store.load().unwrap();

        assert!(outcome.created);
        assert_eq!(outcome.data.groups.len(), 1);
        assert_eq!(outcome.data.groups[0].name, "待办");
        assert!(outcome.data.tasks.is_empty());
        assert!(store.data_path().exists());
    }

    #[test]
    fn second_load_reads_back_what_was_saved() {
        let (_dir, store) = store();

        let mut data = store.load().unwrap().data;
        let group_id = data.groups[0].id.clone();
        data.tasks.push(Task {
            id: "t1".to_string(),
            group_id,
            text: "写测试".to_string(),
            done: false,
            order: 0,
            created_at: "2026-09-23T14:04:00.000Z".to_string(),
            updated_at: "2026-09-23T14:04:00.000Z".to_string(),
            images: vec!["attachments/abc.png".to_string()],
        });
        store.save(&data).unwrap();

        let reloaded = store.load().unwrap();
        assert!(!reloaded.created);
        assert_eq!(reloaded.data.tasks, data.tasks);
        assert_eq!(reloaded.data.settings, data.settings);
    }

    #[test]
    fn corrupt_json_is_reported_instead_of_panicking() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.data_path(), b"{\"version\": 1, \"groups\": [").unwrap();

        let err = store.load().unwrap_err();

        assert!(matches!(err, StoreError::Corrupt { .. }));
        assert!(err.to_string().contains("不是合法的 JSON"));
    }

    #[test]
    fn corrupt_file_can_be_quarantined_and_then_restarted_fresh() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.data_path(), b"not json at all").unwrap();

        let backup = store.quarantine().unwrap();
        assert!(backup.exists());
        assert!(!store.data_path().exists());

        let outcome = store.load().unwrap();
        assert!(outcome.created);
    }

    #[test]
    fn future_version_is_refused_on_load_and_save() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(
            store.data_path(),
            format!(r#"{{"version":{},"groups":[],"tasks":[]}}"#, CURRENT_VERSION + 1),
        )
        .unwrap();

        let err = store.load().unwrap_err();
        assert!(matches!(err, StoreError::FutureVersion { .. }));

        let mut future = default_data();
        future.version = CURRENT_VERSION + 1;
        let save_err = store.save(&future).unwrap_err();
        assert!(matches!(save_err, StoreError::FutureVersion { .. }));
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.data_path(), br#"{"version":1}"#).unwrap();

        let data = store.load().unwrap().data;

        assert_eq!(data.settings, Settings::default());
        assert!(data.groups.is_empty());
        assert!(data.tasks.is_empty());
    }

    #[test]
    fn unknown_top_level_fields_survive_a_round_trip() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(
            store.data_path(),
            br#"{"version":1,"groups":[],"tasks":[],"futureThing":{"a":[1,2]}}"#,
        )
        .unwrap();

        let data = store.load().unwrap().data;
        store.save(&data).unwrap();

        let raw = fs::read_to_string(store.data_path()).unwrap();
        assert!(raw.contains("futureThing"));
        assert!(raw.contains("\"a\""));
    }

    #[test]
    fn writing_twice_leaves_no_placeholder_behind() {
        let (_dir, store) = store();
        let data = store.load().unwrap().data;
        store.save(&data).unwrap();
        store.save(&data).unwrap();

        assert!(!store.dir().join("data.json.tmp").exists());
    }

    #[test]
    fn generate_id_is_unique_enough_for_a_single_session() {
        let a = generate_id("g");
        let b = generate_id("g");
        assert_ne!(a, b);
        assert!(a.starts_with('g'));
    }
}
