//! 应用级配置。
//!
//! 配置目录下保存的是「本机」的东西：数据目录的位置，以及是否自动检查更新。
//! 它们描述的都不是数据本身，因此不与 data.json 一起参与同步。

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::store::write_atomic;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// 用户自定义的数据目录。为空表示使用默认目录。
    pub data_dir: String,
    /// 启动后是否自动检查更新。
    pub auto_check_update: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            data_dir: String::new(),
            // 默认开：自用工具，能自动发现自己有新版本是好事。
            auto_check_update: true,
        }
    }
}

pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 读取配置。文件缺失或损坏时回退到默认值，不报错：
    /// 一个坏掉的配置文件不应该拦住程序启动。
    pub fn load(&self) -> AppConfig {
        match fs::read(&self.path) {
            Ok(raw) => serde_json::from_slice(&raw).unwrap_or_default(),
            Err(_) => AppConfig::default(),
        }
    }

    pub fn save(&self, config: &AppConfig) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(config)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        write_atomic(&self.path, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_then_load_roundtrip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("config.json"));
        let config = AppConfig {
            data_dir: "D:\\记录\\待办".to_string(),
            auto_check_update: false,
        };

        store.save(&config).unwrap();
        assert_eq!(store.load(), config);
    }

    #[test]
    fn auto_check_defaults_to_on_when_the_field_is_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, br#"{"dataDir":"C:\\data"}"#).unwrap();
        let store = ConfigStore::new(&path);

        assert!(store.load().auto_check_update);
    }

    #[test]
    fn missing_file_falls_back_to_default() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("config.json"));
        assert_eq!(store.load(), AppConfig::default());
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"{ this is not json").unwrap();
        let store = ConfigStore::new(&path);
        assert_eq!(store.load(), AppConfig::default());
    }

    #[test]
    fn unknown_fields_are_tolerated() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, br#"{"dataDir":"C:\\data","futureField":42}"#).unwrap();
        let store = ConfigStore::new(&path);
        assert_eq!(store.load().data_dir, "C:\\data");
    }

    #[test]
    fn writes_through_a_placeholder_file_so_partial_writes_never_land() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::new(&path);

        store
            .save(&AppConfig {
                data_dir: "first".to_string(),
                ..Default::default()
            })
            .unwrap();
        store
            .save(&AppConfig {
                data_dir: "second".to_string(),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(store.load().data_dir, "second");
        assert!(!dir.path().join("config.json.tmp").exists());
    }
}
