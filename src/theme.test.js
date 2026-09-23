import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  createThemeController,
  extractThemeCss,
  findTheme,
  mergeThemes,
  normalizeMode,
  normalizeUserThemes,
  resolveAppearance,
  resolveThemeId,
  themeNameFromCss,
  themeVariable,
} from "./theme.js";

test("normalizeMode 只接受三种取值，其余回退 system", () => {
  assert.equal(normalizeMode("light"), "light");
  assert.equal(normalizeMode("dark"), "dark");
  assert.equal(normalizeMode("system"), "system");
  assert.equal(normalizeMode("neon"), "system");
  assert.equal(normalizeMode(undefined), "system");
});

test("resolveAppearance 在 system 下跟随系统偏好", () => {
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
  assert.equal(resolveAppearance("light", true), "light");
});

test("themeNameFromCss 从注释里取名字", () => {
  assert.equal(themeNameFromCss("/* @name 纸本便签 */\n:root{}", "fallback"), "纸本便签");
  assert.equal(themeNameFromCss("/*@name  紧凑  */\n:root{}", "fallback"), "紧凑");
});

test("themeNameFromCss 在缺失或空名时回退", () => {
  assert.equal(themeNameFromCss(":root{}", "paper"), "paper");
  assert.equal(themeNameFromCss("/* @name  */\n:root{}", "paper"), "paper");
  assert.equal(themeNameFromCss("", "paper"), "paper");
});

test("extractThemeCss 只保留属于该主题的变量块", () => {
  const raw = `
    /* @name 测试 */
    :root[data-theme="demo"] {
      --bg: #fff; /* 行内注释 */
      --accent: #b23a2f;
    }
    :root[data-theme="other"] { --bg: #000; }
    :root { --text: red; }
  `;

  const css = extractThemeCss(raw, "demo");

  assert.equal(css, ':root[data-theme="demo"] { --bg: #fff; --accent: #b23a2f; }');
});

test("extractThemeCss 丢掉任何会改布局的规则", () => {
  const raw = `
    /* @name 恶意 */
    body { display: none !important; }
    .task { position: fixed; inset: 0; }
    @import url("https://example.com/x.css");
    :root[data-theme="evil"] { --bg: #000; }
  `;

  const css = extractThemeCss(raw, "evil");

  assert.equal(css, ':root[data-theme="evil"] { --bg: #000; }');
  assert.ok(!css.includes("display"));
  assert.ok(!css.includes("position"));
  assert.ok(!css.includes("@import"));
});

test("extractThemeCss 保留暗黑块与普通块各自的选择器", () => {
  const raw = `
    :root[data-theme="demo"] { --bg: #fff; }
    :root[data-theme="demo"][data-appearance="dark"] { --bg: #111; }
  `;

  const css = extractThemeCss(raw, "demo");

  assert.ok(css.includes(':root[data-theme="demo"] { --bg: #fff; }'));
  assert.ok(
    css.includes(':root[data-theme="demo"][data-appearance="dark"] { --bg: #111; }')
  );
});

test("extractThemeCss 忽略没有任何变量声明的块", () => {
  const raw = ':root[data-theme="demo"] { color: red; }';
  assert.equal(extractThemeCss(raw, "demo"), "");
});

test("extractThemeCss 对空输入返回空串", () => {
  assert.equal(extractThemeCss("", "demo"), "");
  assert.equal(extractThemeCss(undefined, "demo"), "");
});

test("themeVariable 取出变量字面值，取不到返回空串", () => {
  const css = ':root[data-theme="demo"] { --bg: #f5f1e8; --accent: #b23a2f; }';
  assert.equal(themeVariable(css, "--bg"), "#f5f1e8");
  assert.equal(themeVariable(css, "--accent"), "#b23a2f");
  assert.equal(themeVariable(css, "--missing"), "");
  assert.equal(themeVariable("", "--bg"), "");
});

test("normalizeUserThemes 过滤掉没有 id 的条目并做变量过滤", () => {
  const rows = [
    { id: "mine", name: "我的", css: ':root[data-theme="mine"] { --bg: #123; }\nbody{display:none}' },
    { id: "", name: "空 id", css: "" },
    null,
  ];

  const themes = normalizeUserThemes(rows);

  assert.equal(themes.length, 1);
  assert.equal(themes[0].id, "mine");
  assert.equal(themes[0].source, "user");
  assert.equal(themes[0].css, ':root[data-theme="mine"] { --bg: #123; }');
});

test("mergeThemes 让自定义主题覆盖同名内置主题", () => {
  const builtin = [
    { id: "default", name: "默认", source: "builtin", css: "" },
    { id: "paper", name: "纸本便签", source: "builtin", css: "a" },
  ];
  const user = [{ id: "paper", name: "我的纸", source: "user", css: "b" }];

  const merged = mergeThemes(builtin, user);

  assert.equal(merged.length, 2);
  assert.equal(findTheme(merged, "paper").name, "我的纸");
  assert.equal(findTheme(merged, "paper").source, "user");
  assert.equal(merged[0].source, "builtin");
});

test("resolveThemeId 在缺失时回退到默认主题", () => {
  const themes = [
    { id: "default" },
    { id: "paper" },
  ];
  assert.equal(resolveThemeId(themes, "paper"), "paper");
  assert.equal(resolveThemeId(themes, "不存在"), DEFAULT_THEME_ID);
  assert.equal(resolveThemeId([{ id: "only" }], "不存在"), "only");
  assert.equal(resolveThemeId([], "不存在"), DEFAULT_THEME_ID);
});

test("createThemeController 把属性与样式写到位", () => {
  const root = { dataset: {}, style: {} };
  const styleElement = { textContent: "" };
  const controller = createThemeController({ root, styleElement, query: () => true });

  assert.equal(root.dataset.appearance, "dark");
  assert.equal(root.dataset.theme, DEFAULT_THEME_ID);
  assert.equal(root.style.colorScheme, "dark");

  controller.set({ mode: "light", themeId: "paper", css: ':root[data-theme="paper"]{}' });

  assert.equal(root.dataset.appearance, "light");
  assert.equal(root.dataset.theme, "paper");
  assert.equal(styleElement.textContent, ':root[data-theme="paper"]{}');

  controller.set({ mode: "system" });
  assert.equal(root.dataset.appearance, "dark");
  assert.equal(root.dataset.theme, "paper");
});

test("createThemeController 对非法模式回退 system", () => {
  const root = { dataset: {}, style: {} };
  const styleElement = { textContent: "" };
  const controller = createThemeController({ root, styleElement, query: () => false });

  controller.set({ mode: "rainbow" });

  assert.equal(controller.currentMode(), "system");
  assert.equal(root.dataset.appearance, "light");
});

test("每个内置主题文件都能被提取成合法的变量块", () => {
  for (const entry of BUILTIN_THEMES) {
    if (!entry.file) continue;

    const raw = readFileSync(new URL(`./${entry.file}`, import.meta.url), "utf8");
    const css = extractThemeCss(raw, entry.id);

    assert.ok(css.length > 0, `${entry.id}: 没有提取到任何变量`);
    assert.ok(css.includes(`:root[data-theme="${entry.id}"]`), `${entry.id}: 选择器缺失`);
    assert.equal(css.includes("undefined"), false, `${entry.id}: 出现了 undefined`);
    assert.equal(css.includes("@import"), false, `${entry.id}: 混入了 @import`);
  }
});

test("多行渐变写法的氛围变量没有被分号切坏", () => {
  for (const id of ["liquid-glass", "sunlit"]) {
    const css = extractThemeCss(
      readFileSync(new URL(`./themes/${id}.css`, import.meta.url), "utf8"),
      id
    );

    assert.ok(css.includes("--ambient-image"), `${id}: 缺 --ambient-image`);
    assert.ok(css.includes("radial-gradient"), `${id}: 渐变被切掉了`);
    assert.ok(css.includes("--ambient-animation"), `${id}: 缺 --ambient-animation`);
  }
});

test("工业粗野的扫描线纹理保留了 repeating-linear-gradient", () => {
  const css = extractThemeCss(
    readFileSync(new URL("./themes/industrial.css", import.meta.url), "utf8"),
    "industrial"
  );

  assert.ok(css.includes("--texture-image"));
  assert.ok(css.includes("repeating-linear-gradient"));
});

test("流光溢影的纸张噪点是完整的 data URI", () => {
  const css = extractThemeCss(
    readFileSync(new URL("./themes/sunlit.css", import.meta.url), "utf8"),
    "sunlit"
  );

  assert.ok(css.includes("--texture-image"));
  assert.ok(css.includes("data:image/svg+xml"));
  assert.ok(css.includes("feTurbulence"));
});
