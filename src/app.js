// 入口装配：取 bootstrap、加载数据、首次渲染、注册外部事件。

import { createStore } from "./store.js";
import { buildView, attachmentPath } from "./model.js";
import { renderApp } from "./render.js";
import { createThemeController } from "./theme.js";
import { createInteraction } from "./events.js";

const host = document.getElementById("root");

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

function errorBanner(message) {
  const box = document.createElement("div");
  box.className = "boot-error";

  const title = document.createElement("h1");
  title.textContent = "启动失败";

  const body = document.createElement("p");
  body.textContent = message;

  box.append(title, body);
  return box;
}

async function main() {
  const invoke = requireInvoke();
  const theme = createThemeController({ root: document.documentElement });

  let lastTheme = null;
  let render = () => {};

  const store = createStore({
    invoke,
    onChange: () => render(),
    onError: (message) => console.error(message),
  });

  const assetUrl = (relPath) => fileSource(attachmentPath(store.getDataDir(), relPath));

  const interaction = createInteraction({ host, store, invoke, assetUrl });

  render = () => {
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

    const themeName = view.settings.theme;
    if (themeName !== lastTheme) {
      lastTheme = themeName;
      theme.set(themeName);
    }
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

  try {
    await store.init();
  } catch (error) {
    host.replaceChildren(errorBanner(String(error)));
    return;
  }

  render();
}

main();
