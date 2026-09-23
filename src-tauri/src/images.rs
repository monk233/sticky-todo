//! 图片导入。
//!
//! 这一层只关心「把一张图片安全地放进数据目录，并返回一个可写进 JSON 的相对路径」，
//! 不涉及任何界面逻辑。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 单个图片文件的体积上限。
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 允许导入的图片扩展名。
pub const ALLOWED_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Debug)]
pub enum ImageError {
    UnsupportedExtension(String),
    Empty,
    TooLarge { size: u64, limit: u64 },
    NotFound(PathBuf),
    Io { path: PathBuf, source: io::Error },
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImageError::UnsupportedExtension(ext) if ext.is_empty() => write!(
                f,
                "只能导入 {} 格式的图片。",
                ALLOWED_EXTENSIONS.join("、")
            ),
            ImageError::UnsupportedExtension(ext) => write!(
                f,
                "不支持的图片格式 .{ext}，只接受 {}。",
                ALLOWED_EXTENSIONS.join("、")
            ),
            ImageError::Empty => write!(f, "图片内容为空，已跳过。"),
            ImageError::TooLarge { size, limit } => write!(
                f,
                "图片体积 {:.1}MB 超过上限 {:.0}MB，已跳过。",
                *size as f64 / 1024.0 / 1024.0,
                *limit as f64 / 1024.0 / 1024.0
            ),
            ImageError::NotFound(path) => {
                write!(f, "找不到图片文件：{}", path.display())
            }
            ImageError::Io { path, source } => {
                write!(f, "处理图片 {} 失败：{source}", path.display())
            }
        }
    }
}

impl std::error::Error for ImageError {}

/// 把扩展名规范成小写、去掉前导点，并检查是否受支持。
pub fn normalize_extension(raw: &str) -> Result<String, ImageError> {
    let ext = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        return Err(ImageError::UnsupportedExtension(String::new()));
    }
    if ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(ImageError::UnsupportedExtension(ext))
    }
}

/// 从本地路径导入图片（拖放、文件选择走这条）。
pub fn import_path(data_dir: &Path, source: &Path) -> Result<String, ImageError> {
    let ext = normalize_extension(source.extension().and_then(|e| e.to_str()).unwrap_or(""))?;

    let meta = fs::metadata(source).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            ImageError::NotFound(source.to_path_buf())
        } else {
            ImageError::Io {
                path: source.to_path_buf(),
                source: err,
            }
        }
    })?;

    if !meta.is_file() {
        return Err(ImageError::NotFound(source.to_path_buf()));
    }

    if meta.len() > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge {
            size: meta.len(),
            limit: MAX_IMAGE_BYTES,
        });
    }

    let bytes = fs::read(source).map_err(|err| ImageError::Io {
        path: source.to_path_buf(),
        source: err,
    })?;

    store_bytes(data_dir, &bytes, &ext)
}

/// 从字节导入图片（剪贴板粘贴走这条）。
pub fn import_bytes(data_dir: &Path, bytes: &[u8], ext: &str) -> Result<String, ImageError> {
    let ext = normalize_extension(ext)?;

    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge {
            size: bytes.len() as u64,
            limit: MAX_IMAGE_BYTES,
        });
    }

    store_bytes(data_dir, bytes, &ext)
}

fn store_bytes(data_dir: &Path, bytes: &[u8], ext: &str) -> Result<String, ImageError> {
    if bytes.is_empty() {
        return Err(ImageError::Empty);
    }

    let name = format!("{}.{}", hex::encode(Sha256::digest(bytes)), ext);
    let attachments = data_dir.join("attachments");
    let target = attachments.join(&name);

    fs::create_dir_all(&attachments).map_err(|source| ImageError::Io {
        path: attachments.clone(),
        source,
    })?;

    // 内容相同的图片共用同一个文件，重复导入不会撑大数据目录。
    if !target.exists() {
        fs::write(&target, bytes).map_err(|source| ImageError::Io {
            path: target.clone(),
            source,
        })?;
    }

    Ok(format!("attachments/{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn import_returns_a_relative_path_under_attachments() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let source = write_source(dir.path(), "a.png", b"fake png bytes");

        let rel = import_path(&data_dir, &source).unwrap();

        assert!(rel.starts_with("attachments/"));
        assert!(rel.ends_with(".png"));
        assert!(data_dir.join(&rel).exists());
    }

    #[test]
    fn identical_content_reuses_the_same_file() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let first = write_source(dir.path(), "one.png", b"same bytes");
        let second = write_source(dir.path(), "two.png", b"same bytes");

        let rel_a = import_path(&data_dir, &first).unwrap();
        let rel_b = import_path(&data_dir, &second).unwrap();

        assert_eq!(rel_a, rel_b);
        let files: Vec<_> = fs::read_dir(data_dir.join("attachments"))
            .unwrap()
            .collect();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn different_content_produces_different_names() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let a = write_source(dir.path(), "a.png", b"aaa");
        let b = write_source(dir.path(), "b.png", b"bbb");

        assert_ne!(
            import_path(&data_dir, &a).unwrap(),
            import_path(&data_dir, &b).unwrap()
        );
    }

    #[test]
    fn extension_case_and_dot_prefix_are_normalized() {
        assert_eq!(normalize_extension(".PNG").unwrap(), "png");
        assert_eq!(normalize_extension("Jpeg").unwrap(), "jpeg");
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let source = write_source(dir.path(), "note.txt", b"hello");

        let err = import_path(&data_dir, &source).unwrap_err();

        assert!(matches!(err, ImageError::UnsupportedExtension(_)));
        assert!(!data_dir.join("attachments").exists());
    }

    #[test]
    fn bytes_without_extension_are_rejected() {
        let dir = tempdir().unwrap();
        let err = import_bytes(&dir.path().join("data"), b"abc", "").unwrap_err();
        assert!(matches!(err, ImageError::UnsupportedExtension(_)));
    }

    #[test]
    fn oversized_image_is_rejected_before_writing() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let bytes = vec![7u8; (MAX_IMAGE_BYTES + 1) as usize];

        let err = import_bytes(&data_dir, &bytes, "png").unwrap_err();

        assert!(matches!(err, ImageError::TooLarge { .. }));
        assert!(!data_dir.join("attachments").exists());
    }

    #[test]
    fn empty_bytes_are_rejected() {
        let dir = tempdir().unwrap();
        let err = import_bytes(&dir.path().join("data"), b"", "png").unwrap_err();
        assert!(matches!(err, ImageError::Empty));
    }

    #[test]
    fn missing_source_file_reports_not_found() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.png");

        let err = import_path(&dir.path().join("data"), &missing).unwrap_err();

        assert!(matches!(err, ImageError::NotFound(_)));
        assert!(err.to_string().contains("找不到图片文件"));
    }

    #[test]
    fn same_bytes_via_path_and_via_bytes_land_on_the_same_file() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let source = write_source(dir.path(), "clip.png", b"clipboard content");

        let rel_path = import_path(&data_dir, &source).unwrap();
        let rel_bytes = import_bytes(&data_dir, b"clipboard content", "png").unwrap();

        assert_eq!(rel_path, rel_bytes);
    }
}
