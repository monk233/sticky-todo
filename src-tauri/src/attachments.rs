//! 孤儿附件清理。
//!
//! 图片按内容哈希存进 `attachments/`，删任务时只改 JSON、不动文件 —— 同一张图
//! 可能被多条任务引用，顺手删会连带毁掉别处的图。代价是那个目录只增不减。
//!
//! 这一层负责把「不再被任何任务引用」的那些找出来，并在用户确认之后删掉。
//! 它只认文件系统：哪些路径算被引用由前端把它知道的引用集合传进来。

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::images::ALLOWED_EXTENSIONS;

/// 附件目录在数据目录下的名字。
const ATTACHMENTS_DIR: &str = "attachments";

/// 文件名长度上限，与主流文件系统的限制取齐。
const MAX_NAME_BYTES: usize = 255;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanFile {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanScan {
    pub orphans: Vec<OrphanFile>,
    pub total_bytes: u64,
    /// 被跳过的条目数：非图片文件、子目录都算在内。
    pub skipped: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedFile {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub deleted: usize,
    pub freed_bytes: u64,
    pub failed: Vec<FailedFile>,
}

fn attachments_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(ATTACHMENTS_DIR)
}

/// 名字的扩展名是否在允许导入的图片格式里。
fn is_image_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ALLOWED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 删除前对名字的把关，挡住 `..\..\data.json` 这类构造。
///
/// 只有「本目录下的一个图片文件」才可能通过。
pub fn is_safe_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_BYTES {
        return false;
    }
    if name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') || name.contains('\0') {
        return false;
    }
    is_image_name(name)
}

/// 把前端传来的引用路径压成文件名集合。
///
/// 只取最后一段并统一小写：`attachments/abc.png`、`attachments\abc.png`、
/// `./attachments/abc.png` 都归到 `abc.png`。取不出名字的条目直接忽略 ——
/// 忽略的后果是「这个条目不代表任何文件」，不会让它去匹配上别的东西。
fn file_names_of(keep: &[String]) -> HashSet<String> {
    keep.iter()
        .filter_map(|raw| {
            let unified = raw.trim().replace('\\', "/");
            let last = unified.rsplit('/').next().unwrap_or("").trim();
            if last.is_empty() {
                None
            } else {
                Some(last.to_lowercase())
            }
        })
        .collect()
}

/// 列出 `attachments/` 里不再被引用的图片。
///
/// 目录不存在时返回空结果：没导入过图片是正常状态，不该报错。
pub fn scan(data_dir: &Path, keep: &[String]) -> io::Result<OrphanScan> {
    let dir = attachments_dir(data_dir);
    if !dir.is_dir() {
        return Ok(OrphanScan {
            orphans: Vec::new(),
            total_bytes: 0,
            skipped: 0,
        });
    }

    let referenced = file_names_of(keep);
    let mut orphans = Vec::new();
    let mut total_bytes = 0u64;
    let mut skipped = 0usize;

    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();

        // 子目录、符号链接等一概不碰，也不列出来。
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            skipped += 1;
            continue;
        }

        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(value) => value.to_string(),
            None => {
                skipped += 1;
                continue;
            }
        };

        if !is_image_name(&name) {
            skipped += 1;
            continue;
        }

        if referenced.contains(&name.to_lowercase()) {
            continue;
        }

        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        total_bytes += size;
        orphans.push(OrphanFile { name, size });
    }

    // 文件名排序，让界面上的顺序稳定，不跟着目录项顺序变。
    orphans.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(OrphanScan {
        orphans,
        total_bytes,
        skipped,
    })
}

/// 删掉指定的文件。
///
/// 一次处理一个，任何一个不过关都只记进 `failed` 并继续下一个 —— 用户确认过
/// 的是一批文件，不该因为其中一个被占用就整批放弃。
pub fn delete(data_dir: &Path, keep: &[String], names: &[String]) -> io::Result<DeleteReport> {
    let dir = attachments_dir(data_dir);
    let referenced = file_names_of(keep);
    let mut report = DeleteReport::default();

    for name in names {
        match remove_one(&dir, name, &referenced) {
            Ok(size) => {
                report.deleted += 1;
                report.freed_bytes += size;
            }
            Err(reason) => report.failed.push(FailedFile {
                name: name.clone(),
                reason,
            }),
        }
    }

    Ok(report)
}

fn remove_one(dir: &Path, name: &str, referenced: &HashSet<String>) -> Result<u64, String> {
    if !is_safe_name(name) {
        return Err("文件名不合法，已跳过。".to_string());
    }

    let target = dir.join(name);

    // 名字过了关还不够：拼完之后再确认一次父目录就是 attachments，
    // 不把安全性压在字符串判断上。
    if target.parent() != Some(dir) {
        return Err("目标不在附件目录里，已跳过。".to_string());
    }

    // 扫描与删除之间用户可能又用上了这张图。用户确认的是扫描时那份清单，
    // 所以这里按当前的引用集合再验一次。
    if referenced.contains(&name.to_lowercase()) {
        return Err("这个文件已经被引用了，已跳过。".to_string());
    }

    // symlink_metadata：符号链接本身不算普通文件，正好一并拒绝。
    let meta = fs::symlink_metadata(&target).map_err(|err| match err.kind() {
        io::ErrorKind::NotFound => "文件已经不在了。".to_string(),
        _ => format!("读取文件信息失败：{err}"),
    })?;

    if !meta.is_file() {
        return Err("不是普通文件，已跳过。".to_string());
    }

    fs::remove_file(&target).map_err(|err| format!("删除失败：{err}"))?;
    Ok(meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");
        fs::create_dir_all(attachments_dir(&data_dir)).unwrap();
        (dir, data_dir)
    }

    /// 放一个图片文件进去，返回前端那种相对路径写法。
    fn put(data_dir: &Path, name: &str, bytes: &[u8]) -> String {
        fs::write(attachments_dir(data_dir).join(name), bytes).unwrap();
        format!("attachments/{name}")
    }

    fn names_of(scan: &OrphanScan) -> Vec<String> {
        scan.orphans.iter().map(|item| item.name.clone()).collect()
    }

    #[test]
    fn missing_directory_scans_as_empty() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().join("data");

        let scan = scan(&data_dir, &[]).unwrap();

        assert!(scan.orphans.is_empty());
        assert_eq!(scan.total_bytes, 0);
        assert_eq!(scan.skipped, 0);
    }

    #[test]
    fn referenced_files_are_not_orphans() {
        let (_tmp, data_dir) = setup();
        let keep = vec![put(&data_dir, "aaa.png", b"one"), put(&data_dir, "bbb.jpg", b"two")];

        let scan = scan(&data_dir, &keep).unwrap();

        assert!(scan.orphans.is_empty());
        assert_eq!(scan.total_bytes, 0);
    }

    #[test]
    fn only_unreferenced_files_are_listed() {
        let (_tmp, data_dir) = setup();
        let keep = vec![put(&data_dir, "aaa.png", b"one")];
        put(&data_dir, "bbb.png", b"twotwo");
        put(&data_dir, "ccc.png", b"three");

        let scan = scan(&data_dir, &keep).unwrap();

        assert_eq!(names_of(&scan), vec!["bbb.png", "ccc.png"]);
        assert_eq!(scan.total_bytes, 6 + 5);
    }

    #[test]
    fn a_file_referenced_by_two_tasks_is_still_referenced() {
        let (_tmp, data_dir) = setup();
        let path = put(&data_dir, "aaa.png", b"shared");
        let keep = vec![path.clone(), path];

        let scan = scan(&data_dir, &keep).unwrap();

        assert!(scan.orphans.is_empty());
    }

    #[test]
    fn non_images_and_directories_are_skipped() {
        let (_tmp, data_dir) = setup();
        fs::write(attachments_dir(&data_dir).join("notes.txt"), b"hi").unwrap();
        fs::create_dir_all(attachments_dir(&data_dir).join("sub")).unwrap();

        let scan = scan(&data_dir, &[]).unwrap();

        assert!(scan.orphans.is_empty());
        assert_eq!(scan.skipped, 2);
    }

    #[test]
    fn reference_paths_are_normalized_before_matching() {
        let (_tmp, data_dir) = setup();
        put(&data_dir, "aaa.png", b"one");

        let with_backslash = scan(&data_dir, &[r"attachments\aaa.png".to_string()]).unwrap();
        assert!(with_backslash.orphans.is_empty());

        let with_dot_prefix = scan(&data_dir, &["./attachments/aaa.png".to_string()]).unwrap();
        assert!(with_dot_prefix.orphans.is_empty());

        let upper_case = scan(&data_dir, &["attachments/AAA.PNG".to_string()]).unwrap();
        assert!(upper_case.orphans.is_empty());
    }

    #[test]
    fn unsafe_names_are_rejected() {
        for name in [
            "",
            ".",
            "..",
            "a/b.png",
            r"a\b.png",
            r"..\..\data.json",
            "notes.txt",
            "c:.png",
        ] {
            assert!(!is_safe_name(name), "{name} 不该通过检查");
        }

        assert!(is_safe_name("abc123.png"));
        assert!(is_safe_name("abc123.WEBP"));
    }

    #[test]
    fn delete_refuses_traversal_and_leaves_the_target_alone() {
        let (_tmp, data_dir) = setup();
        let outside = data_dir.join("data.json");
        fs::write(&outside, b"important").unwrap();

        let report = delete(&data_dir, &[], &[r"..\data.json".to_string()]).unwrap();

        assert_eq!(report.deleted, 0);
        assert_eq!(report.failed.len(), 1);
        assert!(outside.exists());
    }

    #[test]
    fn delete_refuses_files_that_are_still_referenced() {
        let (_tmp, data_dir) = setup();
        let keep = vec![put(&data_dir, "aaa.png", b"one")];

        let report = delete(&data_dir, &keep, &["aaa.png".to_string()]).unwrap();

        assert_eq!(report.deleted, 0);
        assert_eq!(report.failed.len(), 1);
        assert!(attachments_dir(&data_dir).join("aaa.png").exists());
    }

    #[test]
    fn delete_reports_missing_files_but_finishes_the_batch() {
        let (_tmp, data_dir) = setup();
        put(&data_dir, "aaa.png", b"one");

        let report = delete(
            &data_dir,
            &[],
            &["aaa.png".to_string(), "ghost.png".to_string()],
        )
        .unwrap();

        assert_eq!(report.deleted, 1);
        assert_eq!(report.freed_bytes, 3);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].name, "ghost.png");
        assert!(!attachments_dir(&data_dir).join("aaa.png").exists());
    }

    #[test]
    fn deleting_nothing_is_a_no_op() {
        let (_tmp, data_dir) = setup();

        let report = delete(&data_dir, &[], &[]).unwrap();

        assert_eq!(report, DeleteReport::default());
    }
}
