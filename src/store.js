// 唯一的状态持有者。
//
// 这一层负责：内存中的数据结构、变更通知、防抖持久化，以及和 Rust 命令的往来。
// 它不生成 DOM，也不做过滤/排序（那些在 model.js）。

import {
  DEFAULT_SETTINGS,
  cloneSnapshot,
  createEmptyData,
  formatBytes,
  formatStamp,
  isDueToday,
  isOverdue,
  nextDueAt,
  pad2,
  parseLocalDateTime,
  planDrop,
  pushSnapshot,
  resolveView,
  sortTasks,
  takeSnapshot,
  toMarkdown,
  visibleTasks,
} from "./model.js";
import {
  DEFAULT_THEME_ID,
  loadBuiltinThemes,
  mergeThemes,
  missingThemeSeeds,
  normalizeUserThemes,
  resolveThemeId,
} from "./theme.js";

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

/** 启动后先等一会儿再查更新，别和启动本身抢资源；之后每 6 小时查一次。 */
const FIRST_CHECK_DELAY_MS = 8000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
    tasks: tasks.map((task, index) => {
      // 标签功能已经移除：文件里可能还留着这个旧字段，读进来直接丢掉。
      const { tags: _dropped, ...rest } = task;

      return {
        ...rest,
        id: rest.id ?? uuid(),
        groupId: rest.groupId ?? groups[0]?.id ?? null,
        text: rest.text ?? "",
        done: Boolean(rest.done),
        order: Number.isFinite(rest.order) ? rest.order : index,
        createdAt: rest.createdAt ?? nowIso(),
        updatedAt: rest.updatedAt ?? rest.createdAt ?? nowIso(),
        images: Array.isArray(rest.images) ? rest.images : [],
        dueAt: rest.dueAt ?? null,
        repeat: rest.repeat ?? null,
      };
    }),
  };
}

export function createStore({ invoke, saveDelay = 300, onChange = () => {}, onError = () => {} }) {
  let data = createEmptyData();
  let dataDir = "";
  let saveTimer = null;
  let toastSeq = 0;
  let autoCheckTimer = null;

  const ui = {
    activeGroupId: null,
    exporting: false,
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
    themes: [],
    view: { kind: "group" },
    query: "",
    dueEditorTaskId: null,
    orphans: {
      /** idle | scanning | ready | deleting */
      status: "idle",
      files: [],
      totalBytes: 0,
      skipped: 0,
      /** 删除按钮的第二次确认是否已经点亮。 */
      confirming: false,
      error: "",
    },
    update: {
      autoCheck: true,
      endpoint: "",
      /** idle | checking | latest | downloading | ready | failed */
      status: "idle",
      current: "",
      remote: null,
      progress: 0,
      downloaded: 0,
      total: null,
      path: "",
      verified: true,
      error: "",
      checkedAt: "",
      installing: false,
    },
  };

  const notify = () => onChange();
  const getData = () => data;
  const getUi = () => ui;
  const getDataDir = () => dataDir;

  function toast(text, kind = "info", extra = {}) {
    const entry = { id: ++toastSeq, text, kind, fresh: true, ...extra };
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

    // 数据一变就把提醒计划与托盘摘要刷新一遍，省得每个改动点都得记着调。
    void pushReminders();
    void pushTraySummary();
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

  // ---- 撤销 ----------------------------------------------------------

  let undoStack = [];
  let applyingUndo = false;

  /**
   * 改动分组或任务之前压一份快照。
   *
   * 调用位置很讲究：要在「确认这次真的要改」之后、真正改之前。越界就直接
   * return 的分支不该留下一步空的撤销；一次操作改了好几处（删分组连带删掉
   * 组里所有任务）也只压一份，否则撤销要按很多次才回得到原样。
   *
   * 快照只含分组与任务，不含设置：撤主题、撤布局不是这里要管的事。
   */
  function pushUndo(label) {
    if (applyingUndo) return;
    undoStack = pushSnapshot(undoStack, {
      label,
      groups: cloneSnapshot(data.groups),
      tasks: cloneSnapshot(data.tasks),
      activeGroupId: ui.activeGroupId,
      cursorTaskId: ui.cursorTaskId,
    });
  }

  /** 撤回上一步。栈空时只提示，不当成出错。 */
  function undo() {
    const taken = takeSnapshot(undoStack);
    if (!taken) {
      toast("没有可撤销的操作。", "warn");
      return false;
    }

    undoStack = taken.rest;

    applyingUndo = true;
    data.groups = taken.snapshot.groups;
    data.tasks = taken.snapshot.tasks;
    ui.activeGroupId = taken.snapshot.activeGroupId;
    ui.cursorTaskId = taken.snapshot.cursorTaskId;
    // 撤销出来的数据可能与正在进行的编辑对不上：那几条任务也许已经不在
    // 了，先把这些状态清干净再让渲染层接手。
    ui.editingTaskId = null;
    ui.editingGroupId = null;
    ui.confirmDeleteGroupId = null;
    ui.dueEditorTaskId = null;
    applyingUndo = false;

    // 顺带把提醒计划与托盘摘要刷成撤销后的样子。
    scheduleSave();
    notify();

    // 还能接着撤的时候在提示条上留个入口。
    toast(`已撤销：${taken.snapshot.label}`, "info", { undo: undoStack.length > 0 });
    return true;
  }

  // ---- 持久化与初始化 -------------------------------------------------

  async function reload() {
    const result = await invoke("load_data");
    data = normalizeData(result.data);
    if (result.dataDir) dataDir = result.dataDir;

    // 换了数据来源，旧栈指向的是另一份数据，留着会串台。
    undoStack = [];

    // 附件清单同理：那是上一个数据目录的扫描结果。
    ui.orphans.status = "idle";
    ui.orphans.files = [];
    ui.orphans.totalBytes = 0;
    ui.orphans.skipped = 0;
    ui.orphans.confirming = false;
    ui.orphans.error = "";

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

  function fetchThemeText(path) {
    return fetch(new URL(path, document.baseURI)).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });
  }

  /** 内置主题与自定义主题合并成一张列表。任一来源失败都不影响另一个。 */
  async function loadThemes() {
    let builtin = [];
    try {
      builtin = await loadBuiltinThemes(fetchThemeText);
    } catch (error) {
      onError(`内置主题加载失败：${String(error)}`);
    }

    let user = [];
    try {
      user = normalizeUserThemes(await invoke("list_user_themes"));
    } catch (error) {
      onError(`读取自定义主题失败：${String(error)}`);
    }

    // 内置主题里数据目录还没有的那些先落一份过去。之后改主题只要改数据目录
    // 里的文件再点「重新加载主题」，不必重新构建程序；已经存在的那份是用户
    // 自己编辑过的版本，后端只补缺失的，不会覆盖。
    const seeds = missingThemeSeeds(builtin, user);
    if (seeds.length > 0) {
      try {
        await invoke("seed_builtin_themes", { themes: seeds });
        user = normalizeUserThemes(await invoke("list_user_themes"));
      } catch (error) {
        onError(`预置内置主题失败：${String(error)}`);
      }
    }

    ui.themes = mergeThemes(builtin, user);
    notify();
  }

  /** 主题名指向不存在的主题时回退到默认，并告诉用户。 */
  function reconcileThemeName() {
    const wanted = data.settings.themeName ?? DEFAULT_THEME_ID;
    const resolved = resolveThemeId(ui.themes, wanted);
    if (resolved === wanted) return;
    data.settings.themeName = resolved;
    scheduleSave();
    toast(`找不到主题「${wanted}」，已改用「${resolved}」。`, "warn");
  }

  async function reloadThemes() {
    await loadThemes();
    reconcileThemeName();
    toast(`已重新加载主题，共 ${ui.themes.length} 套。`);
  }

  function setTheme(id) {
    updateSetting("themeName", resolveThemeId(ui.themes, id));
  }

  function openThemesDir() {
    invoke("open_themes_dir").catch((error) => {
      onError(String(error));
      toast(`打开主题目录失败：${String(error)}`, "error");
    });
  }

  /** 当前要应用的主题对象，供渲染层读取。 */
  function activeTheme() {
    return (
      ui.themes.find((theme) => theme.id === data.settings.themeName) ??
      ui.themes.find((theme) => theme.id === DEFAULT_THEME_ID) ??
      null
    );
  }

  async function init() {
    const bootstrap = await invoke("get_bootstrap");
    dataDir = bootstrap.dataDir ?? "";
    ui.update.current = bootstrap.appVersion ?? "";
    await loadThemes();
    await reload();
    reconcileThemeName();
    await syncHostState();
    await initUpdate();

    // 启动时先把提醒计划和托盘摘要交给后端，之后每次数据变化都会再推。
    void pushReminders();
    void pushTraySummary();
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
    pushUndo("新建分组");
    data.groups.push(group);
    ui.activeGroupId = group.id;
    ui.editingGroupId = group.id;
    scheduleSave();
    notify();
    return group;
  }

  function selectGroup(id) {
    ui.activeGroupId = id;
    ui.view = { kind: "group" };
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
      pushUndo("重命名分组");
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

    pushUndo("移动分组");
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

    pushUndo("删除分组");
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
      dueAt: null,
      repeat: null,
    };

    pushUndo("新建待办");
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
      pushUndo("修改正文");
      task.text = next;
      task.updatedAt = nowIso();
      scheduleSave();
    }
    notify();
  }

  function toggleTask(id) {
    const task = findTask(id);
    if (!task) return;

    const wasDone = task.done;
    pushUndo(wasDone ? "取消完成" : "勾选完成");
    task.done = !task.done;
    task.updatedAt = nowIso();
    ui.cursorTaskId = id;

    // 刚勾上完成：带重复规则的任务顺手把下一次排出来。
    if (!wasDone && task.done) {
      spawnNextOccurrence(task);
    }

    scheduleSave();
    notify();
  }

  /**
   * 重复任务：完成时排下一条。
   *
   * 原任务留着做记录，新任务复制内容与图片、到期时间按规则往前推。推进之后
   * 仍然比现在还早的话会继续推，所以放了很久的每日任务不会被排成一串过期条目。
   */
  function spawnNextOccurrence(task) {
    const nextDue = nextDueAt(task.dueAt, task.repeat, new Date());
    if (!nextDue) return null;

    const siblings = data.tasks.filter((item) => item.groupId === task.groupId);
    const maxOrder = siblings.reduce(
      (max, item) => Math.max(max, Number(item.order) || 0),
      -1
    );
    const timestamp = nowIso();

    const next = {
      ...task,
      id: uuid(),
      done: false,
      order: maxOrder + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      images: [...(task.images ?? [])],
      dueAt: nextDue,
    };

    data.tasks.push(next);
    toast(`已排下一次：${formatStamp(nextDue)}`);
    return next;
  }

  function removeTask(id, { silent = false } = {}) {
    const index = data.tasks.findIndex((task) => task.id === id);
    if (index < 0) return;
    // silent 是内部清理（新建之后一个字没写就丢弃），不算用户的一次操作。
    if (!silent) pushUndo("删除待办");
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

    pushUndo("移动待办");
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    ordered.forEach((item, position) => {
      item.order = position;
    });

    scheduleSave();
    notify();
  }

  /**
   * 拖拽落点：改分组、改顺序。
   *
   * 定位怎么算是 model.js 的 planDrop 的事，这里只负责压撤销、套用与保存。
   * 返回是否真的动了数据 —— 落点与原来一致时什么都不做。
   */
  function dropTask(taskId, { groupId, beforeTaskId = null }) {
    const changes = planDrop(
      { groups: data.groups, tasks: data.tasks },
      { taskId, groupId, beforeTaskId }
    );
    if (changes.length === 0) return false;

    const task = findTask(taskId);
    if (!task) return false;

    const groupChanged = task.groupId !== groupId;

    pushUndo("移动待办");

    for (const change of changes) {
      const item = findTask(change.id);
      if (!item) continue;
      item.groupId = change.groupId;
      item.order = change.order;
    }

    // 只有被拖的那一条算「更新过」：顺移的那些只是顺序变了。
    task.updatedAt = nowIso();
    ui.cursorTaskId = taskId;

    scheduleSave();
    notify();

    if (groupChanged) {
      const group = data.groups.find((item) => item.id === groupId);
      toast(`已移动到「${group ? group.name : "分组"}」。`);
    }

    return true;
  }

  function addImages(taskId, relPaths) {
    const task = findTask(taskId);
    if (!task || relPaths.length === 0) return;
    const fresh = relPaths.filter((rel) => !task.images.includes(rel));
    if (fresh.length === 0) return;
    pushUndo("添加图片");
    task.images = [...task.images, ...fresh];
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  function removeImage(taskId, relPath) {
    const task = findTask(taskId);
    if (!task) return;
    if (task.images.includes(relPath)) pushUndo("移除图片");
    task.images = task.images.filter((rel) => rel !== relPath);
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  function cycleTask(delta) {
    const ordered = visibleRows();
    if (ordered.length === 0) return;

    const index = ordered.findIndex((row) => row.task.id === ui.cursorTaskId);
    const next = index < 0 ? 0 : (index + delta + ordered.length) % ordered.length;
    ui.cursorTaskId = ordered[next].task.id;
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

  // ---- 视图、搜索与标签 ------------------------------------------------

  /** 当前视图下可见的任务行。光标移动与「第一条」定位都以它为准。 */
  function visibleRows() {
    return visibleTasks(data, ui.view, ui.query);
  }

  function firstVisibleId() {
    return visibleRows()[0]?.task.id ?? null;
  }

  /** 切视图时顺手离开搜索态，免得列表与搜索框里的词互相打架。 */
  function setView(next) {
    ui.view = resolveView({ view: next });
    ui.query = "";
    ui.editingTaskId = null;
    ui.cursorTaskId = firstVisibleId();
    notify();
  }

  function setQuery(text) {
    ui.query = String(text ?? "");
    ui.cursorTaskId = firstVisibleId();
    notify();
  }

  // ---- 附件清理 --------------------------------------------------------

  let confirmOrphanTimer = null;

  /** 前端这边知道的引用集合：所有任务里记着的图片路径。 */
  function attachmentKeep() {
    const keep = new Set();
    for (const task of data.tasks) {
      for (const rel of task.images ?? []) keep.add(rel);
    }
    return [...keep];
  }

  function clearOrphanConfirm() {
    if (confirmOrphanTimer !== null) {
      clearTimeout(confirmOrphanTimer);
      confirmOrphanTimer = null;
    }
    ui.orphans.confirming = false;
  }

  /** 扫一遍附件目录，列出不再被任何任务引用的图片。 */
  async function scanOrphans() {
    clearOrphanConfirm();
    ui.orphans.status = "scanning";
    ui.orphans.error = "";
    notify();

    try {
      const result = await invoke("scan_orphan_attachments", { keep: attachmentKeep() });
      ui.orphans.files = result.orphans ?? [];
      ui.orphans.totalBytes = result.totalBytes ?? 0;
      ui.orphans.skipped = result.skipped ?? 0;
      ui.orphans.status = "ready";
    } catch (error) {
      ui.orphans.status = "idle";
      ui.orphans.error = String(error);
      onError(String(error));
    }

    notify();
  }

  /** 点两次才真删：中间那次只把按钮点亮，3.2 秒没人接着点就退回去。 */
  function deleteOrphans() {
    const orphans = ui.orphans;
    if (orphans.status !== "ready" || orphans.files.length === 0) return;

    if (!orphans.confirming) {
      orphans.confirming = true;
      notify();

      if (confirmOrphanTimer !== null) clearTimeout(confirmOrphanTimer);
      confirmOrphanTimer = setTimeout(() => {
        confirmOrphanTimer = null;
        if (ui.orphans.confirming) {
          ui.orphans.confirming = false;
          notify();
        }
      }, 3200);
      return;
    }

    clearOrphanConfirm();
    orphans.status = "deleting";
    notify();
    void runOrphanDelete();
  }

  async function runOrphanDelete() {
    const names = ui.orphans.files.map((file) => file.name);

    try {
      const report = await invoke("delete_orphan_attachments", {
        keep: attachmentKeep(),
        names,
      });
      const deleted = report.deleted ?? 0;
      const failed = report.failed ?? [];

      if (failed.length === 0) {
        toast(`已清理 ${deleted} 个文件，释放 ${formatBytes(report.freedBytes ?? 0)}。`);
      } else {
        toast(`已清理 ${deleted} 个文件，${failed.length} 个失败：${failed[0].reason}`, "warn");
      }
    } catch (error) {
      toast(`清理失败：${String(error)}`, "error");
      onError(String(error));
    }

    // 这份清单已经作废（删掉的与没删掉的混在一起），退回初始态让用户重新检查。
    ui.orphans.files = [];
    ui.orphans.totalBytes = 0;
    ui.orphans.status = "idle";
    notify();
  }

  // ---- 导出 ------------------------------------------------------------

  /** 把全部待办导成 Markdown，写到用户选定的位置。 */
  async function exportMarkdown() {
    if (ui.exporting) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

    ui.exporting = true;
    notify();

    try {
      const path = await invoke("export_text", {
        content: toMarkdown(data, now),
        defaultName: `待办便签-${stamp}.md`,
      });
      // 返回 null 表示用户在保存对话框里取消了，不必打扰他。
      if (path) toast(`已导出到 ${path}`);
    } catch (error) {
      toast(`导出失败：${String(error)}`, "error");
      onError(String(error));
    }

    ui.exporting = false;
    notify();
  }

  // ---- 检查更新 --------------------------------------------------------

  /** 下载进度由后端事件推上来。 */
  function applyUpdateProgress(payload) {
    if (ui.update.status !== "downloading") return;

    const downloaded = Number(payload?.downloaded ?? 0);
    const rawTotal = Number(payload?.total ?? 0);
    const total = rawTotal > 0 ? rawTotal : null;

    ui.update.downloaded = downloaded;
    ui.update.total = total;
    ui.update.progress = total ? Math.min(1, downloaded / total) : 0;
    notify();
  }

  /** 排下一次自动检查。开关关掉时只负责把计时器清干净。 */
  function scheduleAutoCheck(delay = FIRST_CHECK_DELAY_MS) {
    if (autoCheckTimer !== null) {
      clearTimeout(autoCheckTimer);
      autoCheckTimer = null;
    }
    if (!ui.update.autoCheck) return;

    autoCheckTimer = setTimeout(() => {
      autoCheckTimer = null;
      void checkUpdate();
    }, delay);
  }

  async function checkUpdate({ manual = false } = {}) {
    // 正在查或者正在下载就别插队，免得两份请求互相盖状态。
    if (ui.update.status === "checking" || ui.update.status === "downloading") return;

    ui.update.status = "checking";
    ui.update.error = "";
    notify();

    try {
      const result = await invoke("check_update");
      ui.update.current = result.currentVersion ?? ui.update.current;
      ui.update.checkedAt = nowIso();

      if (result.update) {
        ui.update.remote = {
          version: result.update.version,
          notes: result.update.notes ?? "",
          size: result.update.size ?? null,
          sha256: result.update.sha256 ?? null,
          downloadUrl: result.update.downloadUrl,
        };
        ui.update.status = "downloading";
        ui.update.progress = 0;
        ui.update.downloaded = 0;
        ui.update.total = result.update.size ?? null;
        notify();
        await downloadUpdate();
      } else {
        ui.update.remote = null;
        ui.update.status = "latest";
        notify();
        if (manual) toast("已经是最新版本。");
      }
    } catch (error) {
      ui.update.status = "failed";
      ui.update.error = String(error);
      notify();
      if (manual) toast(`检查更新失败：${String(error)}`, "warn");
    }

    scheduleAutoCheck(AUTO_CHECK_INTERVAL_MS);
  }

  async function downloadUpdate() {
    const remote = ui.update.remote;
    if (!remote) return;

    try {
      const result = await invoke("download_update", {
        version: remote.version,
        url: remote.downloadUrl,
        sha256: remote.sha256,
      });

      ui.update.path = result.path;
      ui.update.verified = Boolean(result.verified);
      ui.update.progress = 1;
      ui.update.status = "ready";
      notify();
      toast(`新版本 ${remote.version} 已经下载好，可以更新。`);
    } catch (error) {
      ui.update.status = "failed";
      ui.update.error = String(error);
      notify();
      toast(`下载更新失败：${String(error)}`, "error");
    }
  }

  async function installUpdate() {
    if (!ui.update.path) return;

    ui.update.installing = true;
    notify();

    try {
      await invoke("install_update", { path: ui.update.path });
      // 到这里替换脚本已经起来了，进程马上会被它接管。
    } catch (error) {
      ui.update.installing = false;
      ui.update.error = String(error);
      notify();
      toast(`启动更新失败：${String(error)}`, "error");
    }
  }

  async function setAutoCheck(enabled) {
    ui.update.autoCheck = Boolean(enabled);
    notify();

    try {
      await invoke("set_auto_check_update", { enabled: Boolean(enabled) });
    } catch (error) {
      onError(String(error));
    }

    scheduleAutoCheck();
  }

  function openReleases() {
    invoke("open_releases_page").catch((error) => onError(String(error)));
  }

  async function initUpdate() {
    try {
      const prefs = await invoke("get_update_prefs");
      ui.update.autoCheck = prefs.autoCheck !== false;
      ui.update.endpoint = prefs.endpoint ?? "";
    } catch (error) {
      onError(String(error));
    }

    // 上次替换留下的结果：成功就报个喜，失败就告诉用户新文件在哪。
    try {
      const report = await invoke("take_install_result");

      if (report.status === "ok" && report.version) {
        toast(`已更新到 ${report.version}。`);
      } else if (report.status === "failed") {
        toast(
          report.stagedPath
            ? `自动替换失败，请手动把 ${report.stagedPath} 复制到程序所在目录。`
            : "自动替换失败，请手动下载新版本替换。",
          "error"
        );
      }
    } catch (error) {
      onError(String(error));
    }

    notify();
    scheduleAutoCheck();
  }

  // ---- 到期与提醒 ------------------------------------------------------

  function openDueEditor(taskId) {
    ui.dueEditorTaskId = taskId;
    ui.editingTaskId = null;
    notify();
  }

  function closeDueEditor() {
    ui.dueEditorTaskId = null;
    notify();
  }

  /** 设置到期时间；日期清空就等于不要到期时间。 */
  function setDue(taskId, dateText, timeText) {
    const task = findTask(taskId);
    if (!task) return;

    const date = String(dateText ?? "").trim();
    if (date === "") {
      clearDue(taskId);
      return;
    }

    const parsed = parseLocalDateTime(date, timeText);
    if (!parsed) return;

    const next = parsed.toISOString();
    if (next !== task.dueAt) pushUndo("设置到期");

    task.dueAt = next;
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  function setRepeat(taskId, repeat) {
    const task = findTask(taskId);
    if (!task) return;

    const value = String(repeat ?? "").trim();
    const next = value === "" ? null : value;
    if (next !== task.repeat) pushUndo("设置重复");

    task.repeat = next;
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  /** 清掉到期与重复：重复是挂在到期上的，到期没了它就无从谈起。 */
  function clearDue(taskId) {
    const task = findTask(taskId);
    if (!task) return;

    // 本来就空着的时候不留一步空操作：撤销栈只记真的改动。
    if (task.dueAt !== null || task.repeat !== null) pushUndo("清除到期");

    task.dueAt = null;
    task.repeat = null;
    task.updatedAt = nowIso();
    scheduleSave();
    notify();
  }

  /** 通知里点了「延后」：把到期时间往后推一段，顺带把新计划推回后端。 */
  function snoozeTask(taskId, minutes) {
    const task = findTask(taskId);
    if (!task || !task.dueAt) return;

    const due = new Date(task.dueAt).getTime();
    if (!Number.isFinite(due) || !Number.isFinite(minutes) || minutes <= 0) return;

    pushUndo("延后提醒");
    task.dueAt = new Date(due + minutes * 60 * 1000).toISOString();
    task.updatedAt = nowIso();
    // scheduleSave 会顺手刷新提醒计划，后端因此知道新的到期时刻。
    scheduleSave();
    toast(`已延后 ${minutes} 分钟。`);
    notify();
  }

  /** 把「未完成 + 有到期时间」的任务推给后端，由它按点提醒。 */
  async function pushReminders() {
    const items = data.tasks
      .filter((task) => !task.done && task.dueAt)
      .map((task) => ({
        id: task.id,
        dueMs: new Date(task.dueAt).getTime(),
        text: task.text || "（无内容）",
      }))
      .filter((item) => Number.isFinite(item.dueMs));

    try {
      await invoke("set_reminders", { items });
    } catch (error) {
      onError(String(error));
    }
  }

  /** 托盘提示里的摘要。 */
  async function pushTraySummary() {
    const now = new Date();
    const open = data.tasks.filter((task) => !task.done);
    const overdue = open.filter((task) => isOverdue(task, now)).length;
    const today = open.filter((task) => isDueToday(task, now) && !isOverdue(task, now)).length;

    const parts = [];
    if (overdue > 0) parts.push(`逾期 ${overdue}`);
    if (today > 0) parts.push(`今天 ${today}`);

    try {
      await invoke("set_tray_summary", { summary: parts.join(" · ") });
    } catch (error) {
      onError(String(error));
    }
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
    undo,
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
    dropTask,
    addImages,
    removeImage,
    cycleTask,
    cycleGroup,
    toggleCollapse,
    setView,
    setQuery,
    openDueEditor,
    closeDueEditor,
    setDue,
    setRepeat,
    clearDue,
    snoozeTask,
    pushReminders,
    pushTraySummary,
    applyUpdateProgress,
    checkUpdate,
    downloadUpdate,
    installUpdate,
    setAutoCheck,
    openReleases,
    updateSetting,
    setTheme,
    reloadThemes,
    openThemesDir,
    activeTheme,
    toggleAutoStart,
    beginHotkeyRecording,
    cancelHotkeyRecording,
    applyRecordedHotkey,
    changeDataDir,
    openDataDir,
    scanOrphans,
    deleteOrphans,
    exportMarkdown,
    quitApp,
    applyHotkey,
  };
}
