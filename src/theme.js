// 主题：解析、提取、加载与应用。
//
// 设计要点：主题只是一份 CSS 文本，最终写进 <head> 里一个固定的 <style>。
// 切换主题只替换这个 style 的内容与根元素上的两个属性，不碰 DOM 结构。
//
// 明暗与主题是两个正交维度：
//   mode      light | dark | system  ->  解析成 data-appearance
//   themeId   主题标识               ->  data-theme

export const MODES = ["light", "dark", "system"];
export const DEFAULT_THEME_ID = "default";

/** 内置主题。file 为 null 表示沿用 style.css 里的默认值，不额外注入。 */
export const BUILTIN_THEMES = [
  { id: "default", name: "默认", file: null },
  { id: "minimal", name: "极简", file: "themes/minimal.css" },
  { id: "paper", name: "纸本便签", file: "themes/paper.css" },
  { id: "sunlit", name: "流光溢影", file: "themes/sunlit.css" },
  { id: "liquid-glass", name: "液态玻璃", file: "themes/liquid-glass.css" },
  { id: "industrial", name: "工业粗野", file: "themes/industrial.css" },
  { id: "terminal", name: "等宽终端", file: "themes/terminal.css" },
];

export function normalizeMode(value) {
  return MODES.includes(value) ? value : "system";
}

export function resolveAppearance(mode, prefersDark) {
  const normalized = normalizeMode(mode);
  if (normalized === "system") {
    return prefersDark ? "dark" : "light";
  }
  return normalized;
}

export function queryPrefersDark() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从注释里读显示名：`/* @name 纸本便签 *\/`。 */
export function themeNameFromCss(css, fallback) {
  const match = String(css ?? "").match(/\/\*\s*@name\s+([^*]+?)\s*\*\//);
  if (!match) return fallback;
  const name = match[1].trim();
  return name === "" ? fallback : name;
}

/**
 * 只保留属于这个主题的变量块，丢掉其它任何规则。
 *
 * 主题文件是用户（或别人分享的文件）放进来的，不能让它改布局：这里只接受
 * `:root[data-theme="<id>"]` 开头、内部全是 `--自定义属性` 的块，其它一律
 * 丢弃。顺带也去掉了注释。
 */
export function extractThemeCss(rawCss, id) {
  const text = String(rawCss ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = new RegExp(
    `:root\\[data-theme="${escapeForRegExp(id)}"\\](\\[data-appearance="(?:light|dark)"\\])?\\s*\\{([^}]*)\\}`,
    "g"
  );

  const blocks = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const appearance = match[1] ?? "";
    const declarations = match[2]
      .split(";")
      .map((piece) => piece.trim().replace(/\s+/g, " "))
      .filter((piece) => piece.startsWith("--") && piece.includes(":"));

    if (declarations.length > 0) {
      blocks.push(`:root[data-theme="${id}"]${appearance} { ${declarations.join("; ")}; }`);
    }
    match = pattern.exec(text);
  }

  return blocks.join("\n");
}

/** 从主题 CSS 里取某个变量的字面值，只用于列表里的色块预览。 */
export function themeVariable(css, name) {
  const pattern = new RegExp(`(?:^|[;{\\s])${escapeForRegExp(name)}\\s*:\\s*([^;}]+)`, "m");
  const match = pattern.exec(String(css ?? ""));
  return match ? match[1].trim() : "";
}

/** 拉取内置主题文件；读不到就跳过，不让一个缺失的文件挡住启动。 */
export async function loadBuiltinThemes(fetchText) {
  const themes = [];

  for (const entry of BUILTIN_THEMES) {
    if (!entry.file) {
      themes.push({ id: entry.id, name: entry.name, source: "builtin", css: "" });
      continue;
    }
    try {
      const raw = await fetchText(entry.file);
      themes.push({
        id: entry.id,
        name: themeNameFromCss(raw, entry.name),
        source: "builtin",
        css: extractThemeCss(raw, entry.id),
      });
    } catch (error) {
      themes.push({ id: entry.id, name: entry.name, source: "builtin", css: "" });
    }
  }

  return themes;
}

/** 把 Rust 返回的自定义主题转成统一结构并过滤。 */
export function normalizeUserThemes(rows) {
  return (rows ?? [])
    .filter((row) => row && typeof row.id === "string" && row.id !== "")
    .map((row) => ({
      id: row.id,
      name: typeof row.name === "string" && row.name !== "" ? row.name : row.id,
      source: "user",
      css: extractThemeCss(row.css, row.id),
      file: row.file ?? "",
    }));
}

/** 同名时自定义主题覆盖内置主题。 */
export function mergeThemes(builtin, user) {
  const merged = new Map();
  for (const theme of builtin) merged.set(theme.id, theme);
  for (const theme of user) merged.set(theme.id, theme);
  return [...merged.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function findTheme(themes, id) {
  return themes.find((theme) => theme.id === id) ?? null;
}

export function resolveThemeId(themes, wanted) {
  if (findTheme(themes, wanted)) return wanted;
  if (findTheme(themes, DEFAULT_THEME_ID)) return DEFAULT_THEME_ID;
  return themes[0]?.id ?? DEFAULT_THEME_ID;
}

/**
 * 把解析结果写到根元素与那个固定的 <style> 上。不重建 DOM。
 */
export function createThemeController({ root, styleElement, query = queryPrefersDark }) {
  let mode = "system";
  let themeId = DEFAULT_THEME_ID;
  let css = "";
  let detach = null;

  function apply() {
    const appearance = resolveAppearance(mode, query());
    root.dataset.appearance = appearance;
    root.dataset.theme = themeId;
    root.style.colorScheme = appearance;
    if (styleElement && styleElement.textContent !== css) {
      styleElement.textContent = css;
    }
  }

  function watchSystemPreference() {
    if (detach || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") apply();
    };
    media.addEventListener("change", handler);
    detach = () => media.removeEventListener("change", handler);
  }

  apply();
  watchSystemPreference();

  return {
    set({ mode: nextMode, themeId: nextThemeId, css: nextCss }) {
      if (nextMode !== undefined) mode = normalizeMode(nextMode);
      if (nextThemeId !== undefined) themeId = nextThemeId;
      if (nextCss !== undefined) css = nextCss;
      apply();
    },
    currentMode() {
      return mode;
    },
    currentThemeId() {
      return themeId;
    },
    refresh: apply,
    dispose() {
      if (detach) {
        detach();
        detach = null;
      }
    },
  };
}
