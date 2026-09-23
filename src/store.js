// 唯一的状态持有者。
//
// 这一层负责：内存中的数据结构、变更通知、防抖持久化，以及和 Rust 命令的往来。
// 它不生成 DOM，也不做过滤/排序（那些在 model.js）。

import { DEFAULT_SETTINGS, createEmptyData, sortTasks } from "./model.js";

function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

const FALLBACK_GROUP_NAME = "未命名";

/** 分组名不能为空：空白一律换成兜底名。 */
function normalizeGroupName(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? FALLBACK_GROUP_NAME : trimmed;
}

function normalizeData(raw) {
  const source = raw ?? {};
  const groups = Array.isArray(source.groups) ? source.groups : [];
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];

  return {
    ...createEmptyData(),
    ...source,
    settings: { ...DEFAULT_SETTINGS, ...(source.settings ?? {}) },
    groups: groups.map((group, index) => ({
      ...group,
      id: group.id ?? uuid(),
      name: normalizeGroupName(group.name),
      order: Number.isFinite(group.order) ? group.order : index,
    })),
    tasks: tasks.map((task, index) => ({
      ...task,
      id: task.id ?? uuid(),
      groupId: task.groupId ?? groups[0]?.id ?? null,
      text: task.text ?? "",
      done: Boolean(task.done),
      order: Number.isFinite(task.order) ? task.order : index,
      createdAt: task.createdAt ?? nowIso(),
      updatedAt: task.updatedAt ?? task.createdAt ?? nowIso(),
      images: Array.isArray(task.images) ? task.images : [],
    })),
  };
}

export function createStore({ invoke, saveDelay = 300, onChange = () => {}, onError = () => {} }) {
  let data = createEmptyData();
  let dataDir = "";
  let saveTimer = null;
  let toastSeq = 0;

  const ui = {
    activeGroupId: null,
    cursorTaskId: null,
    editingTaskId: null,
    editingGroupId: null,
    confirmDeleteGroupId: null,
    settingsOpen: false,
    settingsFresh: false,
    recordingHotkey: false,
    hotkeyOk: null,
    autoStart: false,
    previewImage: null,
    collapsedGroups: new Set(),
    toasts: [],
  };

  const notify = () => onChange();
  const getData = () => data;
  const getUi = () => ui;
  const getDataDir = () => dataDir;

  function toast(text, kind = "info") {
    const entry = { id: ++toastSeq, text, kind, fresh: true };
    ui.toasts = [...ui.toasts, entry];
    notify();
    setTimeout(() => {
      ui.toasts = ui.toasts.filter((item) => item.id !== entry.id);
      notify();
    }, 4200);
  }

  function patchUi(patch) {
    Object.assign(ui, patch);
    notify();
  }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, saveDelay);
  }

  async function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      await invoke("save_data", { data });
    } catch (error) {
      onError(`保存失败：${String(error)}`);
      toast(`保存失败：${String(error)}`, "error");
    }
  }

  function findTask(id) {
    return data.tasks.find((task) => task.id === id) ?? null;
  }

  function siblingsOf(task) {
    return sortTasks(
      data.tasks.filter((item) => item.groupId === task.groupId),
      false
    );
  }

  // ---- 持久化与初始化 -------------------------------------------------

  async function reload() {
    const result = await invoke("load_data");
    data = normalizeData(result.data);
    if (result.dataDir) dataDir = result.dataDir;

    const ids = new Set(data.groups.map((group) => group.id));
    if (!ui.activeGroupId || !ids.has(ui.activeGroupId)) {
      ui.activeGroupId = data.groups[0]?.id ?? null;
    }
    ui.cursorTaskId = null;
    ui.editingTaskId = null;
    ui.editingGroupId = null;
    ui.collapsedGroups = new Set([...ui.collapsedGroups].filter((id) => ids.has(id)));

    for (const warning of result.warnings ?? []) {
      toast(warning, "warn");
    }

    notify();
  }

  async function applyHotkey() {
    try {
      const accelerator = data.settings.globalHotkeyEnabled
        ? data.settings.globalHotkey
        : null;
      ui.hotkeyOk = await invoke("set_global_hotkey", { accelerator });
    } catch (error) {
      ui.hotkeyOk = false;
      onError(String(error));
    }
    notify();
  }

  async function syncHostState() {
    try {
      await invoke("set_always_on_top", { enabled: Boolean(data.settings.alwaysOnTop) });
    } catch (error) {
      onError(String(error));
    }
    try {
      ui.autoStart = await invoke("get_autostart");
    } catch (error) {
      onError(String(error));
    }
    await applyHotkey();
  }

  async function init() {
    const bootstrap = await invoke("get_bootstrap");
    dataDir = bootstrap.dataDir ?? "";
    await reload();
    await syncHostState();
  }

  // ---- 分组 ----------------------------------------------------------

  function addGroup(name = "新分组") {
    const maxOrder = data.groups.reduce(
      (max, group) => Math.max(max, Number(group.order) || 0),
      -1
    );
    const group = {
      id: uuid(),
      name: normalizeGroupName(name),
      order: maxOrder + 1,
    };
    data.groups.push(group);
    ui.activeGroupId = group.id;
    ui.editingGroupId = group.id;
    scheduleSave();
    notify();
    return group;
  }

  function selectGroup(id) {
    ui.activeGroupId = id;
    ui.editingTaskId = null;
    const first = sortTasks(
      data.tasks.filter((task) => task.groupId === id),
      data.settings.completedBottom
    )[0];
    ui.cursorTaskId = first?.id ?? null;
    notify();
  }

  function startRenameGroup(id) {
    ui.editingGroupId = id;
    notify();
  }

  function renameGroup(id, name) {
    const group = data.groups.find((item) => item.id === id);
    ui.editingGroupId = null;
    if (!group) {
      notify();
      return;
    }
    // 分组不能没有名字：清空后提交就保持原来的名字。
    const typed = String(name ?? "").trim();
    const next = typed === "" ? normalizeGroupName(group.name) : typed;

    if (next !== group.name) {
      group.name = next;
      scheduleSave();
    }
    notify();
  }

  function moveGroup(id, delta) {
    const ordered = [...data.groups].sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)
    );
    const index = ordered.findIndex((group) => group.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;

    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    ordered.forEach((group, position) => {
      group.order = position;
    });

    scheduleSave();
    notify();
  }

  function deleteGroup(id) {
    const index = data.groups.findIndex((group) => group.id === id);
    if (index < 0) return;

    if (ui.confirmDeleteGroupId !== id) {
      ui.confirmDeleteGroupId = id;
      notify();
      setTimeout(() => {
        if (ui.confirmDeleteGroupId === id) {
          ui.confirmDeleteGroupId = null;
          notify();
        }
      }, 3200);
      return;
    }

    const [removed] = data.groups.splice(index, 1);
    const affected = data.tasks.filter((task) => task.groupId === id).length;
    data.tasks = data.tasks.filter((task) => task.groupId !== id);
    ui.confirmDeleteGroupId = null;

    if (ui.activeGroupId === id) {
      const next = data.groups[Math.min(index, data.groups.length - 1)];
      ui.activeGroupId = next?.id ?? null;
    }
    if (data.tasks.every((task) => task.id !== ui.cursorTaskId)) {
      ui.cursorTaskId = null;
    }

    scheduleSave();
    notify();
    toast(
      affected > 0
        ? `已删除分组「${removed?.name ?? ""}」及其 ${affected} 条待办。`
        : `已删除分组「${removed?.name ?? ""}」。`
    );
  }

  // ---- 任务 ----------------------------------------------------------

  function ensureGroupId() {
    if (ui.activeGroupId && data.groups.some((group) => group.id === ui.activeGroupId)) {
      return ui.activeGroupId;
    }
    return data.groups[0]?.id ?? null;
  }

  function addTask(text = "") {
    let groupId = ensureGroupId();
    if (!groupId) {
      groupId = addGroup("待办").id;
    }

    const siblings = data.tasks.filter((task) => task.groupId === groupId);
    const maxOrder = siblings.reduce(
      (max, task) => Math.max(max, Number(task.order) || 0),
      -1
    );
    const timestamp = nowIso();
    const task = {
      id: uuid(),
      groupId,
      text,
      done: false,
      order: maxOrder + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      images: [],
    };

    data.tasks.push(task);
    ui.activeGroupId = groupId;
    ui.cursorTaskId = task.id;
    ui.editingTaskId = task.id;
    scheduleSave();
    notify();
    return task;
  }

  function setCursor(id) {
    ui.cursorTaskId = id;
    notify();
  }

  function startEdit(id) {
    ui.editingTaskId = id;
    ui.cursorTaskId = id;
    notify();
  }

  function cancelEdit() {
    ui.editingTaskId = null;
    notify();
  }

  function commitEdit(id, text) {
    const task = findTask(id);
    ui.editingTaskId = null;
    if (!task) {
      notify();
      return;
    }

    const next = String(text ?? "").replace(/\s+$/u, "");
    if (!next.trim()) {
      // 新建后什么都没写：直接丢弃这条空待办。
      if (!task.text) {
        removeTask(id, { silent: true });
        return;
      }
      notify();
      return;
    }

    if (next !== task.text) {
      task.text = next;
      task.updatedAt = nowIso();
      scheduleSave();
    }
    notify();
  }

  function toggleTask(id) {
    const task = findTask(id);
    if (!task) return;
    task.done = !task.done;
    task.updatedAt = nowIso();
    ui.cursorTaskId = id;
    scheduleSave();
    notify();
  }

  function removeTask(id, { silent = false } = {}) {
    const index = data.tasks.findIndex((task) => task.id === id);
    if (index < 0) return;
    const [removed] = data.tasks.splice(index, 1);
    if (ui.cursorTaskId === id) ui.cursorTaskId = null;
    if (ui.editingTaskId === id) ui.editingTaskId = null;
    scheduleSave();
    notify();
    if (!silent) toast("已删除一条待办。");
  }

  function moveTask(id, delta) {
    const task = findTask(id);
    if (!task) return;

    const ordered = siblingsOf(task);
    const index = ordered.findIndex((item) => item.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;

    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    ordered.forEach((item, position) => {
      item.order = position;
    });

    scheduleSave();
    notify();
  }

  function addImages(taskId, relPaths) {
    const task = findTask(taskId);
    if (!task || relPaths.length === 0) return;
    const fresh = relPaths.filter((rel) => !task.images.includes(rel));
    if (fresh.length === 0) return;
    task.images = [...task.images, ...fresh];
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  function removeImage(taskId, relPath) {
    const task = findTask(taskId);
    if (!task) return;
    task.images = task.images.filter((rel) => rel !== relPath);
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  function cycleTask(delta) {
    const view = ensureGroupId();
    if (!view) return;
    const ordered = sortTasks(
      data.tasks.filter(
        (task) => task.groupId === view && !(data.settings.hideCompleted && task.done)
      ),
      data.settings.completedBottom
    );
    if (ordered.length === 0) return;

    const index = ordered.findIndex((task) => task.id === ui.cursorTaskId);
    const next = index < 0 ? 0 : (index + delta + ordered.length) % ordered.length;
    ui.cursorTaskId = ordered[next].id;
    ui.editingTaskId = null;
    notify();
  }

  function cycleGroup(delta) {
    const ordered = [...data.groups].sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)
    );
    if (ordered.length === 0) return;
    const index = ordered.findIndex((group) => group.id === ui.activeGroupId);
    const next = index < 0 ? 0 : (index + delta + ordered.length) % ordered.length;
    selectGroup(ordered[next].id);
  }

  function toggleCollapse(id) {
    const next = new Set(ui.collapsedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    ui.collapsedGroups = next;
    notify();
  }

  // ---- 设置 ----------------------------------------------------------

  function applyHostSideEffects(key, value) {
    if (key === "alwaysOnTop") {
      invoke("set_always_on_top", { enabled: Boolean(value) }).catch((error) =>
        onError(String(error))
      );
    }
    if (key === "globalHotkey" || key === "globalHotkeyEnabled") {
      void applyHotkey();
    }
  }

  function updateSetting(key, value) {
    if (!(key in data.settings)) return;
    data.settings[key] = value;
    scheduleSave();
    applyHostSideEffects(key, value);
    notify();
  }

  async function toggleAutoStart() {
    const next = !ui.autoStart;
    try {
      await invoke("set_autostart", { enabled: next });
      ui.autoStart = await invoke("get_autostart");
      toast(next ? "已开启开机自启。" : "已关闭开机自启。");
    } catch (error) {
      onError(String(error));
      toast(`开机自启设置失败：${String(error)}`, "error");
    }
    notify();
  }

  function beginHotkeyRecording() {
    ui.recordingHotkey = true;
    notify();
  }

  function cancelHotkeyRecording() {
    if (!ui.recordingHotkey) return;
    ui.recordingHotkey = false;
    notify();
  }

  async function applyRecordedHotkey(accelerator) {
    ui.recordingHotkey = false;
    data.settings.globalHotkey = accelerator;
    scheduleSave();
    await applyHotkey();
    if (ui.hotkeyOk) {
      toast(`全局快捷键已改为 ${accelerator}。`);
    } else {
      toast(`无法注册 ${accelerator}，可能已被其它程序占用。`, "warn");
    }
  }

  async function changeDataDir() {
    const picked = await invoke("pick_directory");
    if (!picked) return;
    try {
      await invoke("set_data_dir", { path: picked });
      await reload();
      toast(`数据目录已切换到 ${picked}`);
    } catch (error) {
      onError(String(error));
      toast(`切换数据目录失败：${String(error)}`, "error");
    }
  }

  function openDataDir() {
    invoke("open_data_dir").catch((error) => {
      onError(String(error));
      toast(`打开数据目录失败：${String(error)}`, "error");
    });
  }

  function quitApp() {
    invoke("quit_app_command").catch((error) => onError(String(error)));
  }

  return {
    getData,
    getUi,
    getDataDir,
    init,
    reload,
    flush,
    toast,
    patchUi,
    addGroup,
    selectGroup,
    startRenameGroup,
    renameGroup,
    moveGroup,
    deleteGroup,
    addTask,
    setCursor,
    startEdit,
    cancelEdit,
    commitEdit,
    toggleTask,
    removeTask,
    moveTask,
    addImages,
    removeImage,
    cycleTask,
    cycleGroup,
    toggleCollapse,
    updateSetting,
    toggleAutoStart,
    beginHotkeyRecording,
    cancelHotkeyRecording,
    applyRecordedHotkey,
    changeDataDir,
    openDataDir,
    quitApp,
    applyHotkey,
  };
}
