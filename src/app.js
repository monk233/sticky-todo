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
  host.replaceChildren(box);
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
  }

  await store.init();
  render();
}

main().catch((error) => {
  showBanner(String(error));
});
