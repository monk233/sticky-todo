//! 主题文件的读取。
//!
//! 自定义主题放在数据目录的 `themes/` 下，一个 `.css` 文件就是一套主题。
//! 这一层只负责把文件读成文本并解析出标识与名称，不做任何样式过滤
//! （过滤在前端做，那里才有 CSSOM）。

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFile {
    /// 文件名规范化后的标识，前端用它拼 `:root[data-theme="<id>"]`。
    pub id: String,
    /// 首行 `@name` 指定的显示名，缺省用文件名。
    pub name: String,
    pub css: String,
    pub file: String,
}

/// 文件名去掉扩展名后，只保留字母数字与 `-`、`_`。中文等 Unicode
/// 字母数字同样保留，中文文件名不需要改名就能用。
pub fn theme_id_from_file_name(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    let id: String = stem
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();

    if id.is_empty() {
        "theme".to_string()
    } else {
        id
    }
}

/// 从前几行里找 `/* @name 纸本便签 */`。没写就用文件名当显示名。
pub fn theme_name_from_css(css: &str, fallback: &str) -> String {
    for line in css.lines().take(6) {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("/*") else {
            continue;
        };
        let inner = rest.trim_end_matches("*/").trim();
        let Some(name) = inner.strip_prefix("@name") else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }

    fallback.to_string()
}

/// 读取目录下所有 `.css`。目录不存在时会创建，让用户有个现成的放置位置。
pub fn load_user_themes(dir: &Path) -> Result<Vec<ThemeFile>, std::io::Error> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }

        let path = entry.path();
        let is_css = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        if !is_css {
            continue;
        }

        // 单个文件读不出来就跳过，不让一个坏文件挡住其它主题。
        let Ok(css) = fs::read_to_string(&path) else {
            continue;
        };

        let file_name = entry.file_name().to_string_lossy().to_string();
        let id = theme_id_from_file_name(&file_name);
        let name = theme_name_from_css(&css, &id);

        entries.push(ThemeFile {
            id,
            name,
            css,
            file: path.to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(entries)
}

/// 预置内置主题时前端传来的一项：目标文件名与文件原文。
///
/// 传原文而不是解析后的变量块，是为了让写出的文件里保留 `@name` 注释，
/// 下次读取时显示名才不会退化成文件名。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSeed {
    pub file_name: String,
    pub css: String,
}

/// 主题文件名的白名单：单层文件名、`.css` 结尾、不含路径分隔符、不以点开头。
///
/// 文件名来自前端，`..\` 这类名字必须在落盘之前挡住。
pub fn is_safe_theme_file_name(file_name: &str) -> bool {
    if file_name.is_empty() || file_name.starts_with('.') {
        return false;
    }
    if !file_name.to_ascii_lowercase().ends_with(".css") {
        return false;
    }
    file_name
        .chars()
        .all(|ch| ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

/// 把内置主题预置进主题目录：只写缺失的文件，已存在的一律不碰。
///
/// 数据目录里同名的那份是用户能直接编辑的版本，比内置的新旧更该被保留，
/// 所以这里用 `create_new` 拿写入权，已存在就跳过。返回真正写下的文件名。
pub fn seed_builtin_themes(dir: &Path, seeds: &[ThemeSeed]) -> Result<Vec<String>, std::io::Error> {
    if seeds.is_empty() {
        return Ok(Vec::new());
    }
    fs::create_dir_all(dir)?;

    let mut written = Vec::new();
    for seed in seeds {
        if !is_safe_theme_file_name(&seed.file_name) {
            continue;
        }

        let path = dir.join(&seed.file_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(seed.css.as_bytes())?;
                written.push(seed.file_name.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn id_keeps_letters_digits_dash_and_underscore() {
        assert_eq!(theme_id_from_file_name("paper.css"), "paper");
        assert_eq!(theme_id_from_file_name("Paper-Dark.css"), "Paper-Dark");
        assert_eq!(theme_id_from_file_name("my_theme.2.css"), "my_theme2");
    }

    #[test]
    fn id_keeps_unicode_letters_so_chinese_file_names_work() {
        assert_eq!(theme_id_from_file_name("纸本便签.css"), "纸本便签");
    }

    #[test]
    fn id_falls_back_when_nothing_usable_remains() {
        assert_eq!(theme_id_from_file_name("!!!.css"), "theme");
        assert_eq!(theme_id_from_file_name("  .css"), "theme");
    }

    #[test]
    fn name_comes_from_the_first_comment() {
        let css = "/* @name 纸本便签 */\n\n:root[data-theme=\"paper\"] { }";
        assert_eq!(theme_name_from_css(css, "paper"), "纸本便签");
    }

    #[test]
    fn name_falls_back_to_file_when_comment_missing() {
        let css = ":root[data-theme=\"paper\"] { }";
        assert_eq!(theme_name_from_css(css, "paper"), "paper");
    }

    #[test]
    fn name_ignores_an_empty_at_name() {
        let css = "/* @name  */\n:root { }";
        assert_eq!(theme_name_from_css(css, "paper"), "paper");
    }

    #[test]
    fn missing_directory_is_created_and_yields_nothing() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");

        let loaded = load_user_themes(&themes).unwrap();

        assert!(loaded.is_empty());
        assert!(themes.is_dir());
    }

    #[test]
    fn loads_css_files_and_skips_everything_else() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");
        fs::create_dir_all(&themes).unwrap();
        fs::write(
            themes.join("paper.css"),
            "/* @name 纸本便签 */\n:root[data-theme=\"paper\"] { --bg: #fff; }",
        )
        .unwrap();
        fs::write(themes.join("notes.txt"), "不是主题").unwrap();
        fs::write(themes.join("readme.md"), "# 说明").unwrap();
        fs::create_dir_all(themes.join("nested.css")).unwrap();

        let loaded = load_user_themes(&themes).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "paper");
        assert_eq!(loaded[0].name, "纸本便签");
        assert!(loaded[0].css.contains("data-theme=\"paper\""));
        assert!(loaded[0].file.ends_with("paper.css"));
    }

    #[test]
    fn results_are_sorted_by_id() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");
        fs::create_dir_all(&themes).unwrap();
        fs::write(themes.join("zeta.css"), ":root{}").unwrap();
        fs::write(themes.join("alpha.css"), ":root{}").unwrap();

        let loaded = load_user_themes(&themes).unwrap();

        assert_eq!(
            loaded.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            vec!["alpha".to_string(), "zeta".to_string()]
        );
    }

    #[test]
    fn upper_case_extension_is_accepted() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");
        fs::create_dir_all(&themes).unwrap();
        fs::write(themes.join("Paper.CSS"), ":root{}").unwrap();

        let loaded = load_user_themes(&themes).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "Paper");
    }

    #[test]
    fn seeds_write_missing_files_and_report_them() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");

        let written = seed_builtin_themes(
            &themes,
            &[
                ThemeSeed {
                    file_name: "paper.css".to_string(),
                    css: "/* @name 纸本便签 */\n:root[data-theme=\"paper\"] { --bg: #fff; }"
                        .to_string(),
                },
                ThemeSeed {
                    file_name: "terminal.css".to_string(),
                    css: ":root[data-theme=\"terminal\"] { --bg: #000; }".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(written, vec!["paper.css", "terminal.css"]);
        assert!(fs::read_to_string(themes.join("paper.css"))
            .unwrap()
            .contains("@name 纸本便签"));
    }

    #[test]
    fn seeds_keep_the_copy_the_user_already_has() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");
        fs::create_dir_all(&themes).unwrap();
        fs::write(themes.join("paper.css"), "/* 我自己改过的 */").unwrap();

        let written = seed_builtin_themes(
            &themes,
            &[ThemeSeed {
                file_name: "paper.css".to_string(),
                css: "/* @name 纸本便签 */".to_string(),
            }],
        )
        .unwrap();

        assert!(written.is_empty());
        assert_eq!(
            fs::read_to_string(themes.join("paper.css")).unwrap(),
            "/* 我自己改过的 */"
        );
    }

    #[test]
    fn seeds_refuse_names_that_would_escape_the_directory() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");
        fs::create_dir_all(&themes).unwrap();

        let written = seed_builtin_themes(
            &themes,
            &[
                ThemeSeed {
                    file_name: "../escape.css".to_string(),
                    css: "x".to_string(),
                },
                ThemeSeed {
                    file_name: "..\\escape.css".to_string(),
                    css: "x".to_string(),
                },
                ThemeSeed {
                    file_name: "notes.txt".to_string(),
                    css: "x".to_string(),
                },
                ThemeSeed {
                    file_name: ".hidden.css".to_string(),
                    css: "x".to_string(),
                },
                ThemeSeed {
                    file_name: String::new(),
                    css: "x".to_string(),
                },
            ],
        )
        .unwrap();

        assert!(written.is_empty());
        assert!(!dir.path().join("escape.css").exists());
        assert!(!themes.join("notes.txt").exists());
    }

    #[test]
    fn seeds_accept_unicode_file_names() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");

        let written = seed_builtin_themes(
            &themes,
            &[ThemeSeed {
                file_name: "纸本便签.css".to_string(),
                css: "x".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(written, vec!["纸本便签.css"]);
    }

    #[test]
    fn seeding_nothing_does_not_create_the_directory() {
        let dir = tempdir().unwrap();
        let themes = dir.path().join("themes");

        let written = seed_builtin_themes(&themes, &[]).unwrap();

        assert!(written.is_empty());
        assert!(!themes.exists());
    }
}
