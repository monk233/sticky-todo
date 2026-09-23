// 渲染层：把 model.js 的投影结果变成 DOM。
//
// 这一层不含业务规则（过滤、排序、计数都在 model.js），也不发起 IPC。
// 所有交互都写成 data-action 属性，由 events.js 统一委托处理。

import { icons } from "./icons.js";
import { formatStamp, formatFullStamp, formatAccelerator } from "./model.js";

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "checked" || key === "disabled" || key === "hidden" || key === "value") {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

function iconButton({ name, action, label, dataset = {}, extraClass = "", disabled = false }) {
  return h("button", {
    class: `icon-button ${extraClass}`.trim(),
    type: "button",
    title: label,
    "aria-label": label,
    disabled,
    dataset: { action, ...dataset },
    html: icons[name],
  });
}

function renderSidebar(view, ctx) {
  const items = view.groups.map(({ group, count, active }) => {
    if (ctx.ui.editingGroupId === group.id) {
      return h(
        "div",
        { class: "group group--editing" },
        h("input", {
          class: "group__editor",
          type: "text",
          spellcheck: "false",
          maxlength: 60,
          dataset: { action: "group-editor", id: group.id },
        })
      );
    }

    return h(
      "button",
      {
        class: `group ${active ? "is-active" : ""}`,
        type: "button",
        dataset: { action: "select-group", id: group.id },
        title: group.name,
      },
      h("span", { class: "group__name" }, group.name),
      h("span", { class: "group__count" }, String(count))
    );
  });

  return h(
    "aside",
    { class: "sidebar" },
    h(
      "div",
      { class: "sidebar__brand" },
      h("span", { class: "sidebar__mark", html: icons.check }),
      h("span", { class: "sidebar__title" }, "待办便签")
    ),
    h("nav", { class: "groups", "aria-label": "分组" }, items),
    h(
      "div",
      { class: "sidebar__foot" },
      h(
        "button",
        { class: "ghost-button", type: "button", dataset: { action: "add-group" } },
        h("span", { class: "ghost-button__icon", html: icons.plus }),
        "添加分组"
      ),
      iconButton({ name: "settings", action: "open-settings", label: "设置" })
    )
  );
}

function renderTaskMeta(task, settings) {
  const parts = [];
  if (settings.showCreatedAt) {
    parts.push(
      h(
        "span",
        { class: "task__stamp", title: `创建于 ${formatFullStamp(task.createdAt)}` },
        `创建 ${formatStamp(task.createdAt)}`
      )
    );
  }
  if (settings.showUpdatedAt) {
    parts.push(
      h(
        "span",
        { class: "task__stamp", title: `更新于 ${formatFullStamp(task.updatedAt)}` },
        `更新 ${formatStamp(task.updatedAt)}`
      )
    );
  }
  if (parts.length === 0) return null;
  return h("div", { class: "task__meta" }, parts);
}

function renderThumbs(task, assetUrl) {
  if (!task.images || task.images.length === 0) return null;
  return h(
    "div",
    { class: "task__thumbs" },
    task.images.map((rel) =>
      h(
        "span",
        { class: "thumb" },
        h("img", {
          src: assetUrl(rel),
          alt: "待办图片",
          loading: "lazy",
          dataset: { action: "preview-image", rel },
        }),
        h("button", {
          class: "thumb__remove",
          type: "button",
          title: "移除这张图片",
          "aria-label": "移除这张图片",
          dataset: { action: "remove-image", id: task.id, rel },
          html: icons.close,
        })
      )
    )
  );
}

function renderTask(task, view, ctx) {
  const { ui, assetUrl } = ctx;
  const { settings } = view;

  if (ui.editingTaskId === task.id) {
    return h(
      "li",
      { class: "task is-editing", dataset: { id: task.id } },
      h("textarea", {
        class: "task__editor",
        rows: 2,
        spellcheck: "false",
        placeholder: "写下要做的事，Enter 保存",
        dataset: { action: "editor", id: task.id },
      }),
      h("div", { class: "task__hint" }, "Enter 或点击别处保存 · Shift + Enter 换行 · Esc 取消")
    );
  }

  const check = h("button", {
    class: `task__check ${task.done ? "is-done" : ""}`,
    type: "button",
    role: "checkbox",
    "aria-checked": task.done ? "true" : "false",
    title: task.done ? "标记为未完成" : "标记为已完成",
    dataset: { action: "toggle-task", id: task.id },
    html: icons.check,
  });

  const body = h(
    "div",
    { class: "task__main", dataset: { action: "focus-task", id: task.id } },
    h("div", { class: "task__text" }, task.text || "（空）"),
    renderThumbs(task, assetUrl),
    renderTaskMeta(task, settings)
  );

  const tools = h(
    "div",
    { class: "task__tools" },
    iconButton({ name: "image", action: "add-image", label: "添加图片", dataset: { id: task.id } }),
    iconButton({ name: "pencil", action: "edit-task", label: "编辑", dataset: { id: task.id } }),
    iconButton({
      name: "trash",
      action: "delete-task",
      label: "删除",
      dataset: { id: task.id },
      extraClass: "icon-button--danger",
    })
  );

  const classes = ["task"];
  if (task.done) classes.push("is-done");
  if (ui.cursorTaskId === task.id) classes.push("is-cursor");
  if (settings.hideActions) classes.push("is-plain");

  return h("li", { class: classes.join(" "), dataset: { id: task.id } }, check, body, tools);
}

function groupToolbar(group, view, ctx, { compact = false } = {}) {
  const confirming = ctx.ui.confirmDeleteGroupId === group.id;

  return h(
    "div",
    { class: compact ? "section__tools" : "workspace__tools" },
    iconButton({
      name: "chevronUp",
      action: "move-group",
      label: "分组上移",
      dataset: { id: group.id, delta: "-1" },
    }),
    iconButton({
      name: "chevronDown",
      action: "move-group",
      label: "分组下移",
      dataset: { id: group.id, delta: "1" },
    }),
    iconButton({
      name: "pencil",
      action: "rename-group",
      label: "重命名分组",
      dataset: { id: group.id },
    }),
    iconButton({
      name: "trash",
      action: "delete-group",
      label: confirming ? "再点一次确认删除" : "删除分组",
      dataset: { id: group.id },
      extraClass: confirming ? "icon-button--danger is-confirming" : "icon-button--danger",
    }),
    h("span", { class: "tools-divider" }),
    h(
      "button",
      { class: "primary-button", type: "button", dataset: { action: "add-task" } },
      h("span", { class: "primary-button__icon", html: icons.plus }),
      "新任务"
    )
  );
}

function renderEmptyState() {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty__title" }, "还没有分组"),
    h("p", { class: "empty__hint" }, "先建一个分组，再把要做的事写进去。"),
    h(
      "button",
      { class: "primary-button", type: "button", dataset: { action: "add-group" } },
      h("span", { class: "primary-button__icon", html: icons.plus }),
      "添加分组"
    )
  );
}

function renderPanelWorkspace(view, ctx) {
  const group = view.activeGroup;
  if (!group) {
    return h("main", { class: "workspace" }, renderEmptyState());
  }

  const tasks = view.activeTasks;

  return h(
    "main",
    { class: "workspace" },
    h(
      "header",
      { class: "workspace__head" },
      h(
        "div",
        { class: "workspace__title" },
        h("h1", {}, group.name),
        h("span", { class: "workspace__count" }, `${tasks.length} 项`)
      ),
      groupToolbar(group, view, ctx)
    ),
    tasks.length === 0
      ? h(
          "div",
          { class: "empty empty--inline" },
          h("p", { class: "empty__hint" }, "这个分组还没有待办。按 Ctrl + N 新建一条。")
        )
      : h("ul", { class: "tasks" }, tasks.map((task) => renderTask(task, view, ctx)))
  );
}

function renderListWorkspace(view, ctx) {
  if (view.sections.length === 0) {
    return h("main", { class: "workspace" }, renderEmptyState());
  }

  const sections = view.sections.map(({ group, count, collapsed, tasks }) =>
    h(
      "section",
      { class: `section ${collapsed ? "is-collapsed" : ""}`, dataset: { id: group.id } },
      h(
        "header",
        { class: "section__head" },
        h(
          "button",
          {
            class: "section__toggle",
            type: "button",
            dataset: { action: "toggle-collapse", id: group.id },
            "aria-expanded": collapsed ? "false" : "true",
          },
          h("span", { class: "section__chevron", html: icons.chevronDown }),
          h("span", { class: "section__name" }, group.name),
          h("span", { class: "section__count" }, String(count))
        ),
        groupToolbar(group, view, ctx, { compact: true })
      ),
      collapsed
        ? null
        : tasks.length === 0
          ? h("p", { class: "section__empty" }, "暂无待办")
          : h("ul", { class: "tasks" }, tasks.map((task) => renderTask(task, view, ctx)))
    )
  );

  return h(
    "main",
    { class: "workspace" },
    h(
      "header",
      { class: "workspace__head" },
      h(
        "div",
        { class: "workspace__title" },
        h("h1", {}, "全部待办"),
        h("span", { class: "workspace__count" }, `${view.totalUnfinished} 项未完成`)
      )
    ),
    h("div", { class: "sections" }, sections)
  );
}

function renderSwitch({ action, key, checked, label, disabled = false }) {
  return h(
    "button",
    {
      class: `switch ${checked ? "is-on" : ""}`,
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-label": label,
      disabled,
      dataset: { action, key },
    },
    h("span", { class: "switch__knob" })
  );
}

function renderField(label, control, hint) {
  return h(
    "div",
    { class: "field" },
    h(
      "div",
      { class: "field__label" },
      h("span", {}, label),
      hint ? h("span", { class: "field__hint" }, hint) : null
    ),
    control
  );
}

function renderSegmented({ key, value, options }) {
  return h(
    "div",
    { class: "segmented", role: "radiogroup" },
    options.map((option) =>
      h(
        "button",
        {
          class: `segmented__item ${option.value === value ? "is-active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": option.value === value ? "true" : "false",
          dataset: { action: "update-setting", key, value: option.value },
          title: option.label,
        },
        h("span", { class: "segmented__icon", html: icons[option.icon] }),
        h("span", {}, option.label)
      )
    )
  );
}

function renderSettings(view, ctx) {
  const { settings } = view;
  const { ui, dataDir } = ctx;

  const hotkeyHint =
    ui.hotkeyOk === false
      ? "该组合键已被其它程序占用，换一个或关闭它"
      : "在任意界面按下即可呼出窗口并新建任务";

  return h(
    "div",
    { class: "settings", dataset: { action: "settings-backdrop" } },
    h(
      "div",
      {
        class: `settings__panel ${ui.settingsFresh ? "is-entering" : ""}`.trim(),
        dataset: { action: "settings-panel" },
      },
      h(
        "header",
        { class: "settings__head" },
        h("h2", {}, "设置"),
        iconButton({ name: "close", action: "close-settings", label: "关闭设置" })
      ),
      h(
        "div",
        { class: "settings__body" },
        h(
          "section",
          { class: "settings__group" },
          h("h3", {}, "显示"),
          renderField(
            "布局方式",
            renderSegmented({
              key: "layout",
              value: settings.layout,
              options: [
                { value: "panel", label: "面板", icon: "panel" },
                { value: "list", label: "列表", icon: "list" },
              ],
            })
          ),
          renderField(
            "隐藏已完成任务",
            renderSwitch({
              action: "update-setting-bool",
              key: "hideCompleted",
              checked: settings.hideCompleted,
              label: "隐藏已完成任务",
            })
          ),
          renderField(
            "已完成任务置于底部",
            renderSwitch({
              action: "update-setting-bool",
              key: "completedBottom",
              checked: settings.completedBottom,
              label: "已完成任务置于底部",
            })
          ),
          renderField(
            "隐藏任务操作按钮",
            renderSwitch({
              action: "update-setting-bool",
              key: "hideActions",
              checked: settings.hideActions,
              label: "隐藏任务操作按钮",
            })
          ),
          renderField(
            "显示创建时间",
            renderSwitch({
              action: "update-setting-bool",
              key: "showCreatedAt",
              checked: settings.showCreatedAt,
              label: "显示创建时间",
            })
          ),
          renderField(
            "显示更新时间",
            renderSwitch({
              action: "update-setting-bool",
              key: "showUpdatedAt",
              checked: settings.showUpdatedAt,
              label: "显示更新时间",
            })
          )
        ),
        h(
          "section",
          { class: "settings__group" },
          h("h3", {}, "外观"),
          renderField(
            "主题",
            renderSegmented({
              key: "theme",
              value: settings.theme,
              options: [
                { value: "light", label: "明亮", icon: "sun" },
                { value: "dark", label: "暗黑", icon: "moon" },
                { value: "system", label: "跟随系统", icon: "monitor" },
              ],
            })
          )
        ),
        h(
          "section",
          { class: "settings__group" },
          h("h3", {}, "数据"),
          h(
            "div",
            { class: "field field--stack" },
            h("span", { class: "field__hint" }, "数据目录"),
            h("code", { class: "path" }, dataDir || "—"),
            h(
              "div",
              { class: "field__actions" },
              h(
                "button",
                { class: "ghost-button", type: "button", dataset: { action: "change-data-dir" } },
                "更改目录"
              ),
              h(
                "button",
                { class: "ghost-button", type: "button", dataset: { action: "open-data-dir" } },
                h("span", { class: "ghost-button__icon", html: icons.folder }),
                "打开目录"
              )
            ),
            h("span", { class: "field__hint" }, "备份或同步时，直接复制整个数据目录即可。")
          )
        ),
        h(
          "section",
          { class: "settings__group" },
          h("h3", {}, "系统"),
          renderField(
            "窗口置顶",
            renderSwitch({
              action: "update-setting-bool",
              key: "alwaysOnTop",
              checked: settings.alwaysOnTop,
              label: "窗口置顶",
            })
          ),
          renderField(
            "点击关闭按钮时隐藏到托盘",
            renderSwitch({
              action: "update-setting-bool",
              key: "closeToTray",
              checked: settings.closeToTray,
              label: "点击关闭按钮时隐藏到托盘",
            })
          ),
          renderField(
            "开机自启",
            renderSwitch({
              action: "toggle-autostart",
              key: "autoStart",
              checked: ui.autoStart === true,
              label: "开机自启",
            })
          ),
          renderField(
            "全局快捷键",
            h(
              "div",
              { class: "field__actions" },
              renderSwitch({
                action: "update-setting-bool",
                key: "globalHotkeyEnabled",
                checked: settings.globalHotkeyEnabled,
                label: "启用全局快捷键",
              }),
              h(
                "button",
                {
                  class: `key-button ${ui.recordingHotkey ? "is-recording" : ""}`,
                  type: "button",
                  dataset: { action: "record-hotkey" },
                  disabled: !settings.globalHotkeyEnabled,
                },
                ui.recordingHotkey
                  ? "请按下新的组合键…"
                  : formatAccelerator(settings.globalHotkey)
              )
            ),
            hotkeyHint
          ),
          renderField(
            "退出程序",
            h(
              "div",
              { class: "field__actions" },
              h(
                "button",
                { class: "ghost-button", type: "button", dataset: { action: "quit-app" } },
                h("span", { class: "ghost-button__icon", html: icons.power }),
                "退出"
              )
            ),
            "关闭窗口只会隐藏到托盘，需要从这里退出。"
          )
        )
      )
    )
  );
}

function renderLightbox(ctx) {
  const { ui, assetUrl } = ctx;
  return h(
    "div",
    { class: "lightbox", dataset: { action: "close-preview" } },
    h("img", { class: "lightbox__image", src: assetUrl(ui.previewImage), alt: "图片预览" }),
    iconButton({ name: "close", action: "close-preview", label: "关闭预览" })
  );
}

function renderToasts(ui) {
  if (!ui.toasts || ui.toasts.length === 0) return null;
  return h(
    "div",
    { class: "toasts", role: "status", "aria-live": "polite" },
    ui.toasts.map((toast) =>
      h(
        "div",
        {
          class: `toast toast--${toast.kind} ${toast.fresh ? "is-entering" : ""}`.trim(),
          dataset: { id: String(toast.id) },
        },
        toast.text
      )
    )
  );
}

export function renderApp(view, ctx) {
  const root = h("div", { class: `app app--${view.layout}` });

  root.append(
    renderSidebar(view, ctx),
    view.layout === "list" ? renderListWorkspace(view, ctx) : renderPanelWorkspace(view, ctx)
  );

  if (ctx.ui.settingsOpen) root.append(renderSettings(view, ctx));
  if (ctx.ui.previewImage) root.append(renderLightbox(ctx));

  const toasts = renderToasts(ctx.ui);
  if (toasts) root.append(toasts);

  return root;
}

export { h, iconButton };
