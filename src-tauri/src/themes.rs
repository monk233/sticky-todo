//! 主题文件的读取。
//!
//! 自定义主题放在数据目录的 `themes/` 下，一个 `.css` 文件就是一套主题。
//! 这一层只负责把文件读成文本并解析出标识与名称，不做任何样式过滤
//! （过滤在前端做，那里才有 CSSOM）。

use std::fs;
use std::path::Path;

use serde::Serialize;

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
}
