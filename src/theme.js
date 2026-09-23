// 主题解析与应用。
//
// normalizeTheme / resolveTheme 是纯函数，不接触浏览器 API，可以直接单元测试；
// createThemeController 负责把结果写到根元素的 data-theme 上。

export const THEMES = ["light", "dark", "system"];

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : "system";
}

export function resolveTheme(theme, prefersDark) {
  const normalized = normalizeTheme(theme);
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

export function createThemeController({ root, query = queryPrefersDark }) {
  let theme = "system";
  let detach = null;

  function apply() {
    const resolved = resolveTheme(theme, query());
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }

  function watchSystemPreference() {
    if (detach || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") {
        apply();
      }
    };
    media.addEventListener("change", handler);
    detach = () => media.removeEventListener("change", handler);
  }

  apply();
  watchSystemPreference();

  return {
    set(next) {
      theme = normalizeTheme(next);
      apply();
    },
    current() {
      return theme;
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
