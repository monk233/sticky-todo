// 纯数据投影：过滤、排序、计数、时间格式化。
//
// 这一层不接触 DOM，也不发起 IPC，因此可以直接用 node --test 测试。
// 渲染层只消费这里的输出。

export const DEFAULT_SETTINGS = {
  layout: "panel",
  theme: "system",
  themeName: "default",
  alwaysOnTop: true,
  closeToTray: true,
  hideCompleted: false,
  completedBottom: false,
  hideActions: false,
  showCreatedAt: true,
  showUpdatedAt: true,
  globalHotkeyEnabled: true,
  globalHotkey: "Ctrl+Alt+N",
};

export function createEmptyData() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    groups: [],
    tasks: [],
  };
}

export function sortGroups(groups) {
  return [...groups].sort((a, b) => {
    const diff = Number(a.order ?? 0) - Number(b.order ?? 0);
    if (diff !== 0) return diff;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-Hans-CN");
  });
}

function compareTasks(a, b) {
  const diff = Number(a.order ?? 0) - Number(b.order ?? 0);
  if (diff !== 0) return diff;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
}

export function sortTasks(tasks, completedBottom) {
  const sorted = [...tasks].sort(compareTasks);
  if (!completedBottom) {
    return sorted;
  }
  return [...sorted.filter((task) => !task.done), ...sorted.filter((task) => task.done)];
}

/** 每个分组的未完成任务数。 */
export function groupCounts(state) {
  const counts = new Map();
  for (const group of state.groups) {
    counts.set(group.id, 0);
  }
  for (const task of state.tasks) {
    if (task.done) continue;
    if (counts.has(task.groupId)) {
      counts.set(task.groupId, counts.get(task.groupId) + 1);
    }
  }
  return counts;
}

/** 某个分组在界面上要展示的任务序列：先过滤，再排序。 */
export function tasksForGroup(state, groupId) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  let list = state.tasks.filter((task) => task.groupId === groupId);
  if (settings.hideCompleted) {
    list = list.filter((task) => !task.done);
  }
  return sortTasks(list, settings.completedBottom);
}

export function allTasksOrdered(state) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  let list = [...state.tasks];
  if (settings.hideCompleted) {
    list = list.filter((task) => !task.done);
  }
  if (settings.completedBottom) {
    return [...sortTasks(list, false).filter((task) => !task.done), ...sortTasks(list, false).filter((task) => task.done)];
  }
  return sortTasks(list, false);
}

// ---- 视图与筛选 ------------------------------------------------------

export const VIEW_KINDS = ["group", "all"];

function normalizeQuery(query) {
  return String(query ?? "").trim();
}

/** 把 ui.view 归一化成视图描述；缺字段或取值不认识时回落到分组视图。 */
export function resolveView(ui) {
  const raw = ui?.view ?? {};
  if (raw.kind === "all") return { kind: "all" };
  return { kind: "group" };
}

/** 任务是否命中搜索词：只看正文，大小写不敏感，空搜索词一律命中。 */
export function matchTask(task, query) {
  const needle = normalizeQuery(query).toLowerCase();
  if (needle === "") return true;
  return String(task?.text ?? "").toLowerCase().includes(needle);
}

/** 把正文切成高亮片段；搜索词按字面量处理，不解释正则元字符。 */
export function highlight(text, query) {
  const source = String(text ?? "");
  const needle = normalizeQuery(query);
  if (needle === "") return [{ text: source, hit: false }];

  const haystack = source.toLowerCase();
  const lowered = needle.toLowerCase();
  const parts = [];
  let from = 0;
  let found = haystack.indexOf(lowered, from);

  while (found >= 0) {
    if (found > from) parts.push({ text: source.slice(from, found), hit: false });
    parts.push({ text: source.slice(found, found + needle.length), hit: true });
    from = found + needle.length;
    found = haystack.indexOf(lowered, from);
  }

  if (parts.length === 0) return [{ text: source, hit: false }];
  if (from < source.length) parts.push({ text: source.slice(from), hit: false });
  return parts;
}

/** 已完成置底：在各分组内部把已完成挪到末尾，分组之间的先后次序不动。 */
function completedToGroupTail(sorted) {
  const out = [];
  let index = 0;

  while (index < sorted.length) {
    const groupId = sorted[index].groupId;
    const open = [];
    const done = [];
    while (index < sorted.length && sorted[index].groupId === groupId) {
      (sorted[index].done ? done : open).push(sorted[index]);
      index += 1;
    }
    out.push(...open, ...done);
  }

  return out;
}

/**
 * 当前视图下可见的任务：先按视图与搜索词过滤，再按「分组顺序 → 组内顺序」
 * 排序，每项带上所属分组名，供降平列表直接消费。
 */
export function visibleTasks(state, view, query) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  const resolved = view ?? resolveView(null);
  const groups = sortGroups(state.groups ?? []);
  const groupRank = new Map(groups.map((group, index) => [group.id, index]));
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const needle = normalizeQuery(query);

  let list = [...(state.tasks ?? [])];
  if (settings.hideCompleted) list = list.filter((task) => !task.done);

  if (needle !== "") list = list.filter((task) => matchTask(task, needle));

  const sorted = list.sort((a, b) => {
    const rank =
      (groupRank.get(a.groupId) ?? groups.length) - (groupRank.get(b.groupId) ?? groups.length);
    if (rank !== 0) return rank;
    return compareTasks(a, b);
  });

  const ordered = settings.completedBottom ? completedToGroupTail(sorted) : sorted;
  return ordered.map((task) => ({ task, groupName: groupName.get(task.groupId) ?? "" }));
}

/** 扁平列表的标题。搜索时一律叫「搜索结果」。 */
function flatTitleOf(query) {
  return query !== "" ? "搜索结果" : "全部待办";
}

/** 组装渲染所需的全部结构，渲染层不再做任何判断。 */
export function buildView(state, ui) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  const groups = sortGroups(state.groups ?? []);
  const counts = groupCounts(state);
  const view = resolveView(ui);
  const query = normalizeQuery(ui?.query);

  const activeGroup =
    groups.find((group) => group.id === ui.activeGroupId) ?? groups[0] ?? null;

  const sections = groups.map((group) => ({
    group,
    count: counts.get(group.id) ?? 0,
    collapsed: ui.collapsedGroups.has(group.id),
    tasks: tasksForGroup(state, group.id),
  }));

  const activeTasks = activeGroup ? tasksForGroup(state, activeGroup.id) : [];

  // 搜索的作用域跟着视图走，展示形态却一律降平：只要在搜，或者视图本身
  // 不是「分组」，右栏就走扁平列表。
  const flat = query !== "" || view.kind !== "group";
  const flatTasks = flat ? visibleTasks(state, view, query) : null;

  return {
    layout: settings.layout,
    settings,
    ui,
    groups: groups.map((group) => ({
      group,
      count: counts.get(group.id) ?? 0,
      active: view.kind === "group" && activeGroup !== null && group.id === activeGroup.id,
    })),
    activeGroup,
    activeTasks,
    sections,
    totalUnfinished: counts.size === 0 ? 0 : [...counts.values()].reduce((a, b) => a + b, 0),

    view,
    query,
    flat,
    flatTasks,
    flatTitle: flatTitleOf(query),
    viewItems: [{ key: "all", label: "全部待办", active: view.kind === "all" }],
  };
}

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 界面上的短时间戳：同一年省略年份。传入 reference 仅为了可测试，
 * 真实调用使用当前时间。
 */
export function formatStamp(value, reference = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return "—";
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const day = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  if (date.getFullYear() === reference.getFullYear()) {
    return `${day} ${clock}`;
  }
  return `${date.getFullYear()}-${day} ${clock}`;
}

export function formatFullStamp(value) {
  const date = parseTimestamp(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 把相对路径拼成数据目录下的绝对路径，供 asset 协议使用。 */
export function attachmentPath(dataDir, relPath) {
  const normalized = String(relPath ?? "").replace(/\\/g, "/");
  const base = String(dataDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${normalized}`;
}

/**
 * 界面上的组合键写法：把 KeyboardEvent.code 的机器名还原成人看的名字。
 * 存储层保留 "Ctrl+Alt+KeyN" 这种形式，展示时才美化。
 */
export function formatAccelerator(accelerator) {
  const parts = String(accelerator ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.replace(/^Key(?=[A-Z0-9]$)/, "").replace(/^Digit(?=\d$)/, "")
    );
  return parts.join(" + ");
}
