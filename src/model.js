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

/** 组装渲染所需的全部结构，渲染层不再做任何判断。 */
export function buildView(state, ui) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  const groups = sortGroups(state.groups ?? []);
  const counts = groupCounts(state);

  const activeGroup =
    groups.find((group) => group.id === ui.activeGroupId) ?? groups[0] ?? null;

  const sections = groups.map((group) => ({
    group,
    count: counts.get(group.id) ?? 0,
    collapsed: ui.collapsedGroups.has(group.id),
    tasks: tasksForGroup(state, group.id),
  }));

  const activeTasks = activeGroup ? tasksForGroup(state, activeGroup.id) : [];

  return {
    layout: settings.layout,
    settings,
    ui,
    groups: groups.map((group) => ({
      group,
      count: counts.get(group.id) ?? 0,
      active: activeGroup !== null && group.id === activeGroup.id,
    })),
    activeGroup,
    activeTasks,
    sections,
    totalUnfinished: counts.size === 0 ? 0 : [...counts.values()].reduce((a, b) => a + b, 0),
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
