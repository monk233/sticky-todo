// 入口装配：取 bootstrap、加载数据、首次渲染、注册外部事件。

import { createStore } from "./store.js";
import { buildView, attachmentPath } from "./model.js";
import { renderApp } from "./render.js";
import { createThemeController } from "./theme.js";
import { createInteraction } from "./events.js";

const host = document.getElementById("root");
let bannerShown = false;

function tauriApi() {
  return window.__TAURI__ ?? null;
}

function requireInvoke() {
  const api = tauriApi();
  if (!api?.core?.invoke) {
    throw new Error(
      "没有检测到 Tauri 运行环境。请用应用本体启动，而不是在浏览器里直接打开 index.html。"
    );
  }
  return api.core.invoke;
}

function fileSource(path) {
  const api = tauriApi();
  return api?.core?.convertFileSrc ? api.core.convertFileSrc(path) : path;
}

/**
 * 启动失败的兜底页。
 *
 * 数据文件读不出来时所有界面都渲染不了，所以这一页必须自带出路：程序版本比
 * 数据旧是最常见的失败原因，那就得能在这里检查更新、把程序换掉再重启。
 */
function showBanner(message) {
  if (bannerShown) return;
  bannerShown = true;

  const box = document.createElement("div");
  box.className = "boot-error";

  const title = document.createElement("h1");
  title.textContent = "启动失败";

  const body = document.createElement("p");
  body.textContent = message;

  box.append(title, body);

  const invoke = tauriApi()?.core?.invoke;
  if (invoke) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "boot-error__action";
    action.textContent = "检查更新";

    const status = document.createElement("p");
    status.className = "boot-error__status";

    action.addEventListener("click", () => {
      void runUpdateFromBanner(invoke, action, status);
    });

    box.append(action, status);
  }

  host.replaceChildren(box);
}

/**
 * 错误页上的更新流程：检查 → 下载 → 替换重启。
 *
 * 这三步只用后端自己的设置与数据目录，不需要读任务数据，所以界面起不来的
 * 时候照样能走完。
 */
async function runUpdateFromBanner(invoke, action, status) {
  action.disabled = true;

  try {
    status.textContent = "正在检查…";
    const result = await invoke("check_update");

    if (!result.update) {
      status.textContent = "已经是最新版本（" + (result.currentVersion ?? "—") + "）。";
      action.disabled = false;
      return;
    }

    const remote = result.update;
    status.textContent = "发现 " + remote.version + "，正在下载…";

    const downloaded = await invoke("download_update", {
      version: remote.version,
      url: remote.downloadUrl,
      sha256: remote.sha256 ?? null,
    });

    status.textContent = "已下载 " + remote.version + "，正在替换并重启…";
    await invoke("install_update", { path: downloaded.path });
  } catch (error) {
    status.textContent = "更新失败：" + String(error);
    action.disabled = false;
  }
}

window.addEventListener("error", (event) => {
  showBanner(String(event.error ?? event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  showBanner(String(event.reason));
});

async function main() {
  const invoke = requireInvoke();

  // 主题变量始终写进这一个 style 元素，切换主题只换内容，不碰 DOM 结构。
  const themeStyle = document.createElement("style");
  themeStyle.id = "theme-vars";
  document.head.append(themeStyle);
  const theme = createThemeController({
    root: document.documentElement,
    styleElement: themeStyle,
  });

  let render = () => {};

  const store = createStore({
    invoke,
    onChange: () => render(),
    onError: (message) => console.error(message),
  });

  const assetUrl = (relPath) => fileSource(attachmentPath(store.getDataDir(), relPath));

  const interaction = createInteraction({ host, store, invoke, assetUrl });

  function applyTheme() {
    const settings = store.getData().settings;
    const active = store.activeTheme();
    theme.set({
      mode: settings.theme,
      themeId: active?.id ?? settings.themeName,
      css: active?.css ?? "",
    });
  }

  render = () => {
    // 先落主题再重建界面，避免用旧配色渲染一帧。
    applyTheme();

    interaction.beforeRender();

    const view = buildView(store.getData(), store.getUi());
    host.replaceChildren(
      renderApp(view, {
        ui: store.getUi(),
        dataDir: store.getDataDir(),
        assetUrl,
      })
    );

    interaction.afterRender();
  };

  const api = tauriApi();
  if (api?.event?.listen) {
    await api.event.listen("app://new-task", () => {
      store.patchUi({ settingsOpen: false, previewImage: null });
      store.addTask("");
    });
    await api.event.listen("app://new-group", () => {
      store.patchUi({ settingsOpen: false, previewImage: null });
      store.addGroup("新分组");
    });
    await api.event.listen("app://update-progress", (event) => {
      store.applyUpdateProgress(event.payload ?? {});
    });
    await api.event.listen("app://check-update", () => {
      // 托盘里点了「检查更新」：顺手把设置面板打开，让用户看到结果。
      store.patchUi({ settingsOpen: true, settingsFresh: true });
      void store.checkUpdate({ manual: true });
    });
    await api.event.listen("app://reminder-snooze", (event) => {
      // 通知里点了「延后」：后端只回 id 和分钟数，改到期时间还得前端来。
      const payload = event.payload ?? {};
      store.snoozeTask(String(payload.id ?? ""), Number(payload.minutes));
    });
  }

  await store.init();
  render();
}

main().catch((error) => {
  showBanner(String(error));
});
