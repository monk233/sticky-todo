import test from "node:test";
import assert from "node:assert/strict";

import { createThemeController, normalizeTheme, resolveTheme, THEMES } from "./theme.js";

test("normalizeTheme 接受三种取值，其余一律回退 system", () => {
  assert.deepEqual(THEMES, ["light", "dark", "system"]);
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("system"), "system");
  assert.equal(normalizeTheme("neon"), "system");
  assert.equal(normalizeTheme(undefined), "system");
});

test("resolveTheme 在 system 下跟随系统偏好", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("createThemeController 把解析结果写到根元素", () => {
  const root = { dataset: {}, style: {} };
  const controller = createThemeController({ root, query: () => true });

  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");

  controller.set("light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(controller.current(), "light");

  controller.set("system");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(controller.current(), "system");
});

test("createThemeController 对非法主题回退 system 而不是写坏值", () => {
  const root = { dataset: {}, style: {} };
  const controller = createThemeController({ root, query: () => false });

  controller.set("rainbow");

  assert.equal(controller.current(), "system");
  assert.equal(root.dataset.theme, "light");
});
