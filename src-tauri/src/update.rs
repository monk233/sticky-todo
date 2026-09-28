//! 检查更新、下载新版本、以及在退出后替换自己的 exe。
//!
//! 这一层不碰界面：版本比较、Release 解析、替换脚本的生成都是纯函数，
//! 网络与进程操作集中在它们下面，方便用 `cargo test` 覆盖关键分支。

use std::cmp::Ordering;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 默认更新源：仓库最新的正式 Release。
pub const DEFAULT_ENDPOINT: &str =
    "https://api.github.com/repos/monk233/sticky-todo/releases/latest";

/// 覆盖更新源用的环境变量，方便换镜像，也方便本地起一个假源做验证。
pub const ENDPOINT_ENV: &str = "STICKY_TODO_UPDATE_ENDPOINT";

/// 更新包在 Release 里的资产名。
pub const ASSET_NAME: &str = "sticky-todo.exe";

/// 替换脚本最多重试多少次覆盖（每次间隔约一秒）。
const MAX_OVERWRITE_TRIES: u32 = 40;

/// 结果文件名，写在数据目录的 `updates/` 下，供下次启动时读取。
pub const RESULT_FILE: &str = "last-install.txt";

#[derive(Debug)]
pub enum UpdateError {
    Network(String),
    Parse(String),
    Io(String),
    Checksum { expected: String, actual: String },
    NoAsset,
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpdateError::Network(message) => write!(f, "网络请求失败：{message}"),
            UpdateError::Parse(message) => write!(f, "更新信息解析失败：{message}"),
            UpdateError::Io(message) => write!(f, "读写更新文件失败：{message}"),
            UpdateError::Checksum { expected, actual } => write!(
                f,
                "下载下来的文件校验不一致（期望 {expected}，实际 {actual}），已丢弃"
            ),
            UpdateError::NoAsset => write!(f, "该 Release 里没有 {ASSET_NAME}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// 远端的一个可用版本。
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseInfo {
    pub version: String,
    pub notes: String,
    pub download_url: String,
    pub size: Option<u64>,
    /// 裸的十六进制 SHA-256；源头没给摘要时为 `None`。
    pub sha256: Option<String>,
}

#[derive(Deserialize)]
struct RawAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

/// 去掉版本号前面的 `v`（大小写都认）以及首尾空白。
fn strip_v_prefix(value: &str) -> String {
    let trimmed = value.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    stripped.to_string()
}

fn version_segments(value: &str) -> Vec<u64> {
    strip_v_prefix(value)
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 逐段按数值比较版本。缺段补 0，非数字段按 0 处理，所以 `1.3` 与 `1.3.0` 相等。
pub fn compare_versions(current: &str, remote: &str) -> Ordering {
    let left = version_segments(current);
    let right = version_segments(remote);
    let length = left.len().max(right.len());

    for index in 0..length {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            Ordering::Equal => continue,
            other => return other,
        }
    }

    Ordering::Equal
}

/// 把 `sha256:abcd…` 这种摘要拆成裸的十六进制串；给的不是摘要就返回 `None`。
pub fn sha256_in_digest(digest: Option<&str>) -> Option<String> {
    let value = digest?.trim();
    if value.is_empty() {
        return None;
    }

    let hex = value.strip_prefix("sha256:").unwrap_or(value).trim();
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    Some(hex.to_ascii_lowercase())
}

/// 解析 GitHub 的 `releases/latest` 响应。
pub fn parse_release(json: &str) -> Result<ReleaseInfo, UpdateError> {
    let raw: RawRelease =
        serde_json::from_str(json).map_err(|error| UpdateError::Parse(error.to_string()))?;

    let asset = raw
        .assets
        .iter()
        .find(|asset| asset.name == ASSET_NAME)
        .ok_or(UpdateError::NoAsset)?;

    Ok(ReleaseInfo {
        version: strip_v_prefix(&raw.tag_name),
        notes: raw.body,
        download_url: asset.browser_download_url.clone(),
        size: asset.size,
        sha256: sha256_in_digest(asset.digest.as_deref()),
    })
}

/// 生成替换脚本需要的参数。
///
/// `restart` 为假时不启动新版本（测试用，避免弹出真实进程）；
/// `tries` 是覆盖失败后的重试次数，正式流程用 [`MAX_OVERWRITE_TRIES`]。
pub struct InstallScriptSpec<'a> {
    pub new_exe: &'a Path,
    pub target_exe: &'a Path,
    pub result_file: &'a Path,
    pub version: &'a str,
    pub restart: bool,
    pub tries: u32,
}

/// 生成替换自身的批处理脚本。
///
/// 正在运行的 exe 不能被覆盖，所以让脚本在进程退出后再动手：反复尝试覆盖，
/// 成功就启动新版本并把 `ok:<版本>` 写进结果文件；重试到头还没成功就写
/// `failed:<版本>`。脚本内容全部是 ASCII，避免 cmd 的代码页问题。
pub fn build_install_script(spec: &InstallScriptSpec<'_>) -> String {
    let new_exe = spec.new_exe.display();
    let target_exe = spec.target_exe.display();
    let result_file = spec.result_file.display();
    let version = spec.version;
    let restart = if spec.restart {
        format!("start \"\" \"{target_exe}\"\r\n")
    } else {
        String::new()
    };

    format!(
        "@echo off\r\n\
setlocal enabledelayedexpansion\r\n\
set tries=0\r\n\
:retry\r\n\
set /a tries+=1\r\n\
move /y \"{new_exe}\" \"{target_exe}\" > nul 2>&1\r\n\
if not errorlevel 1 goto done\r\n\
if !tries! geq {tries} goto failed\r\n\
ping -n 2 127.0.0.1 > nul\r\n\
goto retry\r\n\
:done\r\n\
> \"{result_file}\" echo ok:{version}\r\n\
{restart}\
exit /b 0\r\n\
:failed\r\n\
> \"{result_file}\" echo failed:{version}\r\n\
exit /b 1\r\n",
        tries = spec.tries
    )
}

/// 上次替换的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOutcome {
    Ok,
    Failed,
    /// 文件不存在、是空的，或者内容认不出来。
    Unknown,
}

/// 结果文件的内容：结果本身，外加这次处理的版本号（失败时要用它告诉用户
/// 新文件留在哪儿）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallResult {
    pub outcome: InstallOutcome,
    pub version: Option<String>,
}

impl InstallResult {
    fn unknown() -> Self {
        Self {
            outcome: InstallOutcome::Unknown,
            version: None,
        }
    }
}

pub fn parse_install_result(text: &str) -> InstallResult {
    let value = text.trim();
    let (head, tail) = match value.split_once(':') {
        Some((head, tail)) => (head.trim(), Some(tail.trim())),
        None => (value, None),
    };
    let version = tail
        .map(|tail| tail.to_string())
        .filter(|tail| !tail.is_empty());

    let outcome = if head.is_empty() {
        InstallOutcome::Unknown
    } else if head.eq_ignore_ascii_case("ok") {
        InstallOutcome::Ok
    } else if head.to_ascii_lowercase().starts_with("failed") {
        InstallOutcome::Failed
    } else {
        InstallOutcome::Unknown
    };

    InstallResult { outcome, version }
}

/// 当前的更新源：环境变量优先，其次是默认地址。
pub fn endpoint() -> String {
    resolve_endpoint(std::env::var(ENDPOINT_ENV).ok())
}

fn resolve_endpoint(env_value: Option<String>) -> String {
    env_value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
}

/// 向更新源要一次最新版本。已经是最新时返回 `None`。
pub fn check(endpoint: &str, current_version: &str) -> Result<Option<ReleaseInfo>, UpdateError> {
    let response = ureq::get(endpoint)
        .set("User-Agent", "sticky-todo-updater")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call();

    let body = match response {
        Ok(response) => response
            .into_string()
            .map_err(|error| UpdateError::Network(error.to_string()))?,
        // 还没有发布过任何 Release 时 GitHub 会 404，这不算故障。
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(error) => return Err(UpdateError::Network(error.to_string())),
    };

    let info = parse_release(&body)?;
    if compare_versions(current_version, &info.version) == Ordering::Less {
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

/// 下载新版本到 `dest`，边写边算 SHA-256；给了摘要就比对，不一致时删掉文件。
pub fn download(
    url: &str,
    dest: &Path,
    expected_sha: Option<&str>,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), UpdateError> {
    let response = ureq::get(url)
        .set("User-Agent", "sticky-todo-updater")
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|error| UpdateError::Network(error.to_string()))?;

    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| UpdateError::Io(error.to_string()))?;
    }

    let mut reader = response.into_reader();
    let mut file = fs::File::create(dest).map_err(|error| UpdateError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut written = 0_u64;

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| UpdateError::Network(error.to_string()))?;
        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|error| UpdateError::Io(error.to_string()))?;
        written += read as u64;
        on_progress(written, total);
    }

    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| UpdateError::Io(error.to_string()))?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if let Some(expected) = expected_sha {
        if !expected.eq_ignore_ascii_case(&actual) {
            let _ = fs::remove_file(dest);
            return Err(UpdateError::Checksum {
                expected: expected.to_string(),
                actual,
            });
        }
    }

    Ok(())
}

/// 把下载好的 exe 放到临时目录，生成替换脚本并启动它。
///
/// 返回暂存后的路径，调用方拿到之后就该退出应用，把舞台交给脚本。
pub fn install(
    new_exe: &Path,
    target_exe: &Path,
    result_file: &Path,
    version: &str,
) -> Result<PathBuf, UpdateError> {
    let file_name = new_exe
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("sticky-todo-new.exe"));
    let staged = std::env::temp_dir().join(file_name);

    fs::copy(new_exe, &staged).map_err(|error| UpdateError::Io(error.to_string()))?;

    if let Some(parent) = result_file.parent() {
        fs::create_dir_all(parent).map_err(|error| UpdateError::Io(error.to_string()))?;
    }
    // 上一次留下的结果先清掉，免得被当成本次的结果读走。
    let _ = fs::remove_file(result_file);

    let script_path = std::env::temp_dir().join(format!("sticky-todo-update-{}.cmd", timestamp()));
    let script = build_install_script(&InstallScriptSpec {
        new_exe: &staged,
        target_exe,
        result_file,
        version,
        restart: true,
        tries: MAX_OVERWRITE_TRIES,
    });
    fs::write(&script_path, script).map_err(|error| UpdateError::Io(error.to_string()))?;

    let mut command = std::process::Command::new("cmd");
    command.arg("/c").arg(&script_path);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// 别让替换脚本弹出黑窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|error| UpdateError::Io(error.to_string()))?;

    Ok(staged)
}

/// 启动时清掉上次留下的半截下载。
pub fn cleanup_partials(data_dir: &Path) {
    let Ok(entries) = fs::read_dir(update_dir(data_dir)) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|ext| ext == "part").unwrap_or(false) {
            let _ = fs::remove_file(path);
        }
    }
}

/// 顺手清掉临时目录里过期的替换脚本。
///
/// 替换脚本不删自己（cmd 删掉正在执行的批处理之后没法正常收尾），所以由下一次
/// 启动来收尸。只删一小时以前的，免得把正在进行的那一次误伤。
pub fn cleanup_temp_scripts() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();

        if !name.starts_with("sticky-todo-update-") || !name.ends_with(".cmd") {
            continue;
        }

        let old_enough = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age.as_secs() > 3600)
            .unwrap_or(false);

        if old_enough {
            let _ = fs::remove_file(path);
        }
    }
}

/// 新版本存放在数据目录里的位置。
pub fn package_path(data_dir: &Path, version: &str) -> PathBuf {
    update_dir(data_dir).join(format!("sticky-todo-{version}.exe"))
}

/// 下载时先写这个后缀，完成后才改名成正式文件名。
pub fn partial_path(data_dir: &Path, version: &str) -> PathBuf {
    update_dir(data_dir).join(format!("sticky-todo-{version}.exe.part"))
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 下载与安装过程中用到的目录：`<数据目录>/updates`。
pub fn update_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("updates")
}

pub fn result_path(data_dir: &Path) -> PathBuf {
    update_dir(data_dir).join(RESULT_FILE)
}

/// 读取上次的替换结果。
pub fn read_install_result(data_dir: &Path) -> InstallResult {
    match fs::read_to_string(result_path(data_dir)) {
        Ok(text) => parse_install_result(&text),
        Err(_) => InstallResult::unknown(),
    }
}

pub fn clear_install_result(data_dir: &Path) -> std::io::Result<()> {
    let path = result_path(data_dir);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "tag_name": "v1.4.0",
        "body": "修了一些问题",
        "assets": [
            {
                "name": "sticky-todo.exe",
                "browser_download_url": "https://example.com/sticky-todo.exe",
                "size": 4123456,
                "digest": "sha256:4D1F766DC4575EA12DAF4F586938230C59542E1CF3C83D8D07B5629AB00F25E1"
            }
        ]
    }"#;

    #[test]
    fn version_compare_handles_numeric_order() {
        assert_eq!(compare_versions("1.3.0", "1.3.0"), Ordering::Equal);
        assert_eq!(compare_versions("v1.3.0", "1.3.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.3.0", "1.4.0"), Ordering::Less);
        assert_eq!(compare_versions("1.3.0", "1.3.1"), Ordering::Less);
        assert_eq!(compare_versions("1.4.0", "1.3.9"), Ordering::Greater);
        // 数值比较，不是字典序
        assert_eq!(compare_versions("1.9.9", "1.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
    }

    #[test]
    fn version_compare_is_lenient_about_missing_and_odd_parts() {
        assert_eq!(compare_versions("1.3", "1.3.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.3.0", "1.3"), Ordering::Equal);
        assert_eq!(compare_versions("1.3.0.1", "1.3.0"), Ordering::Greater);
        // 非数字段按 0 处理，不 panic
        assert_eq!(compare_versions("1.3.0", "1.3.0-beta"), Ordering::Equal);
        assert_eq!(compare_versions("", "1.0.0"), Ordering::Less);
    }

    #[test]
    fn release_json_is_parsed_into_info() {
        let info = parse_release(SAMPLE).unwrap();

        assert_eq!(info.version, "1.4.0");
        assert_eq!(info.notes, "修了一些问题");
        assert_eq!(info.download_url, "https://example.com/sticky-todo.exe");
        assert_eq!(info.size, Some(4_123_456));
        assert_eq!(
            info.sha256.as_deref(),
            Some("4d1f766dc4575ea12daf4f586938230c59542e1cf3c83d8d07b5629ab00f25e1")
        );
    }

    #[test]
    fn release_without_digest_still_parses() {
        let json = r#"{"tag_name":"v1.4.0","assets":[{"name":"sticky-todo.exe","browser_download_url":"https://example.com/a.exe"}]}"#;
        let info = parse_release(json).unwrap();

        assert_eq!(info.version, "1.4.0");
        assert_eq!(info.sha256, None);
        assert_eq!(info.size, None);
    }

    #[test]
    fn release_without_the_exe_asset_is_reported() {
        let json = r#"{"tag_name":"v1.4.0","assets":[{"name":"other.zip","browser_download_url":"https://example.com/z.zip"}]}"#;
        let error = parse_release(json).unwrap_err();

        assert!(matches!(error, UpdateError::NoAsset));
        assert!(error.to_string().contains("sticky-todo.exe"));
    }

    #[test]
    fn release_without_assets_field_is_reported() {
        let json = r#"{"tag_name":"v1.4.0"}"#;
        assert!(matches!(parse_release(json).unwrap_err(), UpdateError::NoAsset));
    }

    #[test]
    fn broken_json_is_reported() {
        let error = parse_release("{ 不是 json").unwrap_err();
        assert!(matches!(error, UpdateError::Parse(_)));
    }

    #[test]
    fn digest_parsing_accepts_only_hex() {
        assert_eq!(
            sha256_in_digest(Some("sha256:ABCDEF01")).as_deref(),
            Some("abcdef01")
        );
        assert_eq!(sha256_in_digest(Some("abcdef01")).as_deref(), Some("abcdef01"));
        assert_eq!(sha256_in_digest(Some("sha256:")), None);
        assert_eq!(sha256_in_digest(Some("sha256:zzzz")), None);
        assert_eq!(sha256_in_digest(Some("   ")), None);
        assert_eq!(sha256_in_digest(None), None);
    }

    #[test]
    fn install_script_quotes_paths_and_has_both_branches() {
        let script = build_install_script(&InstallScriptSpec {
            new_exe: Path::new(r"C:\Users\me\AppData\Local\Temp\sticky-todo-1.4.0.exe"),
            target_exe: Path::new(r"C:\Program Files\sticky-todo\sticky-todo.exe"),
            result_file: Path::new(r"C:\data\updates\last-install.txt"),
            version: "1.4.0",
            restart: true,
            tries: MAX_OVERWRITE_TRIES,
        });

        assert!(script.contains(r#"move /y "C:\Users\me\AppData\Local\Temp\sticky-todo-1.4.0.exe" "C:\Program Files\sticky-todo\sticky-todo.exe""#));
        assert!(script.contains(r#"> "C:\data\updates\last-install.txt" echo ok:1.4.0"#));
        assert!(script.contains(r#"> "C:\data\updates\last-install.txt" echo failed:1.4.0"#));
        assert!(script.contains(r#"start "" "C:\Program Files\sticky-todo\sticky-todo.exe""#));
        assert!(script.contains(&MAX_OVERWRITE_TRIES.to_string()));
        // 全是 ASCII，避免 cmd 代码页把提示写花
        assert!(script.is_ascii());
        // 先覆盖成功再启动，失败时不启动
        let done = script.find(":done").unwrap();
        let failed = script.find(":failed").unwrap();
        assert!(done < failed);
    }

    #[test]
    fn install_script_without_restart_does_not_start_anything() {
        let script = build_install_script(&InstallScriptSpec {
            new_exe: Path::new(r"C:\tmp\new.exe"),
            target_exe: Path::new(r"C:\tmp\old.exe"),
            result_file: Path::new(r"C:\tmp\result.txt"),
            version: "1.4.0",
            restart: false,
            tries: 1,
        });

        assert!(!script.contains("start \"\""));
        assert!(script.contains("ok:1.4.0"));
    }

    /// 真跑一遍替换脚本：这一步验证的是 cmd 脚本本身能用，而不是 Rust 代码。
    #[test]
    fn install_script_actually_swaps_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let new_exe = dir.path().join("sticky-todo-9.9.9.exe");
        let target = dir.path().join("installed.exe");
        let result = dir.path().join("last-install.txt");
        fs::write(&new_exe, b"new build").unwrap();
        fs::write(&target, b"old build").unwrap();

        let script_path = dir.path().join("swap.cmd");
        let script = build_install_script(&InstallScriptSpec {
            new_exe: &new_exe,
            target_exe: &target,
            result_file: &result,
            version: "9.9.9",
            restart: false,
            tries: 1,
        });
        fs::write(&script_path, script).unwrap();

        let status = std::process::Command::new("cmd")
            .arg("/c")
            .arg(&script_path)
            .status()
            .unwrap();

        assert!(status.success(), "替换脚本没有正常退出：{status}");
        assert_eq!(fs::read(&target).unwrap(), b"new build");
        assert!(!new_exe.exists(), "新文件应该是被移走，不是复制");
        assert_eq!(
            parse_install_result(&fs::read_to_string(&result).unwrap()).outcome,
            InstallOutcome::Ok
        );
    }

    /// 覆盖不了的时候（目标目录不存在）脚本必须留下 failed，而不是无声无息。
    #[test]
    fn install_script_reports_failure_when_it_cannot_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let new_exe = dir.path().join("sticky-todo-9.9.9.exe");
        let target = dir.path().join("没有这个目录").join("installed.exe");
        let result = dir.path().join("last-install.txt");
        fs::write(&new_exe, b"new build").unwrap();

        let script_path = dir.path().join("swap.cmd");
        let script = build_install_script(&InstallScriptSpec {
            new_exe: &new_exe,
            target_exe: &target,
            result_file: &result,
            version: "9.9.9",
            restart: false,
            tries: 1,
        });
        fs::write(&script_path, script).unwrap();

        let status = std::process::Command::new("cmd")
            .arg("/c")
            .arg(&script_path)
            .status()
            .unwrap();

        assert!(!status.success());
        assert!(
            new_exe.exists(),
            "覆盖失败时新文件要留着，用户还得靠它手动替换"
        );
        assert_eq!(
            parse_install_result(&fs::read_to_string(&result).unwrap()).outcome,
            InstallOutcome::Failed
        );
    }

    #[test]
    fn install_result_parsing() {
        let ok = parse_install_result("ok:1.4.0\n");
        assert_eq!(ok.outcome, InstallOutcome::Ok);
        assert_eq!(ok.version.as_deref(), Some("1.4.0"));

        let failed = parse_install_result("FAILED:1.4.0");
        assert_eq!(failed.outcome, InstallOutcome::Failed);
        assert_eq!(failed.version.as_deref(), Some("1.4.0"));

        // 没有版本号的旧格式也认
        assert_eq!(parse_install_result("ok").outcome, InstallOutcome::Ok);
        assert_eq!(parse_install_result("failed").outcome, InstallOutcome::Failed);
        assert_eq!(parse_install_result("failed").version, None);

        assert_eq!(parse_install_result("").outcome, InstallOutcome::Unknown);
        assert_eq!(parse_install_result("   \r\n").outcome, InstallOutcome::Unknown);
        assert_eq!(parse_install_result("谁知道呢").outcome, InstallOutcome::Unknown);
    }

    #[test]
    fn update_paths_live_under_the_data_dir() {
        let dir = Path::new(r"C:\data");

        assert_eq!(update_dir(dir), PathBuf::from(r"C:\data\updates"));
        assert_eq!(
            result_path(dir),
            PathBuf::from(r"C:\data\updates\last-install.txt")
        );
    }

    #[test]
    fn missing_result_file_reads_as_unknown() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(read_install_result(dir.path()).outcome, InstallOutcome::Unknown);
        // 清理一个不存在的文件不该报错
        clear_install_result(dir.path()).unwrap();
    }

    #[test]
    fn endpoint_prefers_a_non_empty_env_value() {
        assert_eq!(resolve_endpoint(None), DEFAULT_ENDPOINT);
        assert_eq!(resolve_endpoint(Some("  ".to_string())), DEFAULT_ENDPOINT);
        assert_eq!(
            resolve_endpoint(Some(" http://127.0.0.1:9/latest ".to_string())),
            "http://127.0.0.1:9/latest"
        );
    }

    #[test]
    fn package_paths_sit_under_updates() {
        let dir = Path::new(r"C:\data");

        assert_eq!(
            package_path(dir, "1.4.0"),
            PathBuf::from(r"C:\data\updates\sticky-todo-1.4.0.exe")
        );
        assert_eq!(
            partial_path(dir, "1.4.0"),
            PathBuf::from(r"C:\data\updates\sticky-todo-1.4.0.exe.part")
        );
    }

    #[test]
    fn cleanup_removes_only_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let updates = update_dir(dir.path());
        fs::create_dir_all(&updates).unwrap();
        fs::write(updates.join("sticky-todo-1.4.0.exe.part"), b"half").unwrap();
        fs::write(updates.join("sticky-todo-1.3.0.exe"), b"whole").unwrap();
        fs::write(updates.join("last-install.txt"), b"ok").unwrap();

        cleanup_partials(dir.path());

        assert!(!updates.join("sticky-todo-1.4.0.exe.part").exists());
        assert!(updates.join("sticky-todo-1.3.0.exe").exists());
        assert!(updates.join("last-install.txt").exists());
    }

    #[test]
    fn cleanup_on_a_missing_directory_is_harmless() {
        let dir = tempfile::tempdir().unwrap();
        cleanup_partials(&dir.path().join("从来没建过"));
    }

    /// 起一个只回应一次的极简 HTTP 服务器，用来喂给 `download` 一段确定的字节。
    fn serve_once(body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/sticky-todo.exe");

        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });

        (url, handle)
    }

    #[test]
    fn download_writes_the_file_and_reports_progress() {
        let payload = vec![7_u8; 200_000];
        let expected = hex::encode(Sha256::digest(&payload));
        let (url, server) = serve_once(payload.clone());

        let dir = tempfile::tempdir().unwrap();
        let dest = package_path(dir.path(), "1.4.0");
        let mut seen = Vec::new();

        download(&url, &dest, Some(&expected), |written, total| {
            seen.push((written, total));
        })
        .unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&dest).unwrap(), payload);
        assert!(!seen.is_empty(), "进度回调一次都没被调用");
        assert_eq!(seen.last().unwrap().0, 200_000);
        assert_eq!(seen.last().unwrap().1, Some(200_000));
    }

    #[test]
    fn download_rejects_a_checksum_mismatch_and_deletes_the_file() {
        let payload = b"not the real thing".to_vec();
        let (url, server) = serve_once(payload.clone());

        let dir = tempfile::tempdir().unwrap();
        let dest = package_path(dir.path(), "1.4.0");
        let wrong = "0".repeat(64);

        let error = download(&url, &dest, Some(&wrong), |_, _| {}).unwrap_err();
        server.join().unwrap();

        assert!(matches!(error, UpdateError::Checksum { .. }));
        assert!(!dest.exists(), "校验失败的文件应该被删掉");
    }

    #[test]
    fn download_without_a_digest_skips_verification() {
        let payload = b"whatever".to_vec();
        let (url, server) = serve_once(payload.clone());

        let dir = tempfile::tempdir().unwrap();
        let dest = package_path(dir.path(), "1.4.0");

        download(&url, &dest, None, |_, _| {}).unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&dest).unwrap(), payload);
    }

    #[test]
    fn download_reports_a_connection_failure() {
        let dir = tempfile::tempdir().unwrap();
        let dest = package_path(dir.path(), "1.4.0");

        // 127.0.0.1:1 上不会有服务在听
        let error = download("http://127.0.0.1:1/nope", &dest, None, |_, _| {}).unwrap_err();

        assert!(matches!(error, UpdateError::Network(_)));
        assert!(!dest.exists());
    }

    #[test]
    fn install_result_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = result_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"failed:1.4.0").unwrap();

        let result = read_install_result(dir.path());
        assert_eq!(result.outcome, InstallOutcome::Failed);
        assert_eq!(result.version.as_deref(), Some("1.4.0"));

        clear_install_result(dir.path()).unwrap();
        assert_eq!(read_install_result(dir.path()).outcome, InstallOutcome::Unknown);
    }
}
