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
    version: 3,
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

export const VIEW_KINDS = ["group", "all", "today", "overdue", "week"];

function normalizeQuery(query) {
  return String(query ?? "").trim();
}

/** 把 ui.view 归一化成视图描述；缺字段或取值不认识时回落到分组视图。 */
export function resolveView(ui) {
  const raw = ui?.view ?? {};
  if (VIEW_KINDS.includes(raw.kind) && raw.kind !== "group") {
    return { kind: raw.kind };
  }
  return { kind: "group" };
}

// ---- 到期时间 --------------------------------------------------------

/** 把 dueAt 解析成 Date；没有或者解析不出来时返回 null。 */
export function parseDue(dueAt) {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  // 一周从周一算起：周日（0）要往前退 6 天。
  const day = date.getDay();
  const offset = day === 0 ? 6 : day - 1;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/** 已过期：到期时刻早于现在，且任务还没完成。 */
export function isOverdue(task, now = new Date()) {
  const due = parseDue(task?.dueAt);
  if (!due || task?.done) return false;
  return due.getTime() < now.getTime();
}

/** 到期落在本地今天。 */
export function isDueToday(task, now = new Date()) {
  const due = parseDue(task?.dueAt);
  if (!due) return false;
  const start = startOfDay(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return due >= start && due < end;
}

/** 到期落在本周（周一到下周一）。 */
export function isDueThisWeek(task, now = new Date()) {
  const due = parseDue(task?.dueAt);
  if (!due) return false;
  const start = startOfWeek(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return due >= start && due < end;
}

/** 把 <input type="date"> 与 <input type="time"> 的值拼成本地时间；日期非法时返回 null。 */
export function parseLocalDateTime(dateText, timeText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText ?? "").trim());
  if (!dateMatch) return null;

  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(String(timeText ?? "").trim());
  const hour = timeMatch ? Number(timeMatch[1]) : 9;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;

  const date = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    hour,
    minute,
    0,
    0
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 把到期时间拆成两个输入框要的文本（本地时间）。 */
export function splitDueForInputs(dueAt) {
  const date = parseDue(dueAt);
  if (!date) return { date: "", time: "09:00" };

  const pad = (value) => String(value).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/** 重复规则：`null` / `daily` / `weekly` / `monthly` / `weekdays` / `every:N:day|week|month`。 */
export function parseRepeat(repeat) {
  const value = String(repeat ?? "").trim();
  if (value === "") return null;
  if (value === "daily") return { unit: "day", count: 1 };
  if (value === "weekly") return { unit: "week", count: 1 };
  if (value === "monthly") return { unit: "month", count: 1 };
  if (value === "weekdays") return { unit: "weekday", count: 1 };

  const match = /^every:(\d+):(day|week|month)$/.exec(value);
  if (!match) return null;

  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 1) return null;

  return { unit: match[2], count };
}

/** 重复规则的显示文案。 */
export function repeatLabel(repeat) {
  const rule = parseRepeat(repeat);
  if (!rule) return "不重复";
  if (rule.unit === "day") return rule.count === 1 ? "每天" : `每 ${rule.count} 天`;
  if (rule.unit === "week") return rule.count === 1 ? "每周" : `每 ${rule.count} 周`;
  if (rule.unit === "month") return rule.count === 1 ? "每月" : `每 ${rule.count} 个月`;
  return "每个工作日";
}

/** 存储的规则值 → 下拉框选中项。 */
export function repeatPreset(repeat) {
  const rule = parseRepeat(repeat);
  if (!rule) return "";
  if (rule.unit === "weekday") return "weekdays";
  if (rule.count > 1) return `every-${rule.unit}`;
  if (rule.unit === "day") return "daily";
  if (rule.unit === "week") return "weekly";
  return "monthly";
}

/** 下拉框选中项（外加自定义间隔的数字） → 存储的规则值。 */
export function repeatFromPreset(preset, count) {
  const value = String(preset ?? "").trim();
  if (value === "") return null;
  if (["daily", "weekly", "monthly", "weekdays"].includes(value)) return value;

  const match = /^every-(day|week|month)$/.exec(value);
  if (!match) return null;

  // 选「每 N 天」时还没填数字：默认给 2，否则 1 会被当成「每天」，
  // 数字框刚出现就消失，看起来像没生效。
  const raw = Number(count);
  const amount = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
  return `every:${amount}:${match[1]}`;
}

function addDays(date, days) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

/** 加月份时保留原日号；当月没有这个日号就退到当月最后一天。 */
function addMonths(date, months) {
  const day = date.getDate();
  const target = new Date(
    date.getFullYear(),
    date.getMonth() + months,
    1,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

function nextWeekday(date) {
  let next = addDays(date, 1);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next = addDays(next, 1);
  }
  return next;
}

function advance(date, rule) {
  if (rule.unit === "day") return addDays(date, rule.count);
  if (rule.unit === "week") return addDays(date, rule.count * 7);
  return addMonths(date, rule.count);
}

/**
 * 下一次到期时刻：从当前到期时间按规则往前推，一直推到晚于 `now` 为止。
 * 没有到期时间或规则认不出来时返回 null。
 */
export function nextDueAt(dueAt, repeat, now = new Date()) {
  const rule = parseRepeat(repeat);
  const start = parseDue(dueAt);
  if (!rule || !start) return null;

  let next = start;
  let guard = 0;

  do {
    next = rule.unit === "weekday" ? nextWeekday(next) : advance(next, rule);
    guard += 1;
  } while (next.getTime() <= now.getTime() && guard < 1000);

  return next.toISOString();
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
export function visibleTasks(state, view, query, now = new Date()) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  const resolved = view ?? resolveView(null);
  const groups = sortGroups(state.groups ?? []);
  const groupRank = new Map(groups.map((group, index) => [group.id, index]));
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const needle = normalizeQuery(query);

  let list = [...(state.tasks ?? [])];
  if (settings.hideCompleted) list = list.filter((task) => !task.done);

  if (resolved.kind === "today") {
    list = list.filter((task) => isDueToday(task, now));
  } else if (resolved.kind === "overdue") {
    list = list.filter((task) => isOverdue(task, now));
  } else if (resolved.kind === "week") {
    list = list.filter((task) => isDueThisWeek(task, now));
  }

  if (needle !== "") list = list.filter((task) => matchTask(task, needle));

  // 聚合视图按到期时间说话：有到期的在前、升序，没到期的按原顺序跟在后面。
  // 分组视图保持手动顺序，不然上移／下移就没意义了。
  const byDueFirst = resolved.kind !== "group";

  const sorted = list.sort((a, b) => {
    if (byDueFirst) {
      const dueA = parseDue(a.dueAt);
      const dueB = parseDue(b.dueAt);
      if (dueA && dueB) {
        const diff = dueA.getTime() - dueB.getTime();
        if (diff !== 0) return diff;
      } else if (dueA) {
        return -1;
      } else if (dueB) {
        return 1;
      }
    }

    const rank =
      (groupRank.get(a.groupId) ?? groups.length) - (groupRank.get(b.groupId) ?? groups.length);
    if (rank !== 0) return rank;
    return compareTasks(a, b);
  });

  const ordered = settings.completedBottom ? completedToGroupTail(sorted) : sorted;
  return ordered.map((task) => ({ task, groupName: groupName.get(task.groupId) ?? "" }));
}

/** 扁平列表的标题。搜索时一律叫「搜索结果」。 */
function flatTitleOf(view, query) {
  if (query !== "") return "搜索结果";

  const titles = {
    all: "全部待办",
    today: "今天",
    overdue: "逾期",
    week: "本周",
  };
  return titles[view.kind] ?? "全部待办";
}

/** 左栏四个固定视图的未完成计数。 */
function viewItemCounts(state, now) {
  const open = (state.tasks ?? []).filter((task) => !task.done);

  return {
    all: open.length,
    today: open.filter((task) => isDueToday(task, now)).length,
    overdue: open.filter((task) => isOverdue(task, now)).length,
    week: open.filter((task) => isDueThisWeek(task, now)).length,
  };
}

/** 组装渲染所需的全部结构，渲染层不再做任何判断。 */
export function buildView(state, ui, now = new Date()) {
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
  const flatTasks = flat ? visibleTasks(state, view, query, now) : null;
  const viewCounts = viewItemCounts(state, now);

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
    flatTitle: flatTitleOf(view, query),
    viewItems: [
      { key: "all", label: "全部待办", count: viewCounts.all, active: view.kind === "all" },
      { key: "today", label: "今天", count: viewCounts.today, active: view.kind === "today" },
      {
        key: "overdue",
        label: "逾期",
        count: viewCounts.overdue,
        active: view.kind === "overdue",
      },
      { key: "week", label: "本周", count: viewCounts.week, active: view.kind === "week" },
    ],
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

// ---- 撤销快照栈 ------------------------------------------------------

/** 撤销栈的长度上限，超出的丢掉最旧的那份。 */
export const UNDO_LIMIT = 50;

/**
 * 快照要的深拷贝。
 *
 * 数据是纯 JSON，没有函数、没有循环引用，structuredClone 够用；老内核上
 * 没有它时退回 JSON 一趟。
 */
export function cloneSnapshot(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * 压一份快照，返回新的栈。
 *
 * 不改动传入的数组：栈是 store 里的持有物，就地改会让「压栈失败」这种事
 * 无从判断。超出上限时丢掉最旧的那些 —— 越早的状态越不可能还有人要回去。
 */
export function pushSnapshot(stack, snapshot, limit = UNDO_LIMIT) {
  const capped = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (capped === 0) return [];

  const next = [...stack, snapshot];
  return next.length > capped ? next.slice(next.length - capped) : next;
}

/**
 * 弹出最新的一份快照。
 *
 * 栈空时返回 null，调用方据此提示「没有可撤销的操作」，而不是当作异常。
 */
export function takeSnapshot(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return null;
  return {
    snapshot: stack[stack.length - 1],
    rest: stack.slice(0, -1),
  };
}

/**
 * 文件体积的人话写法：1024 进一位，保留一位小数。
 *
 * 字节那一档不带小数 —— 「1.5 B」没有意义。
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return index === 0 ? `${Math.round(size)} B` : `${size.toFixed(1)} ${units[index]}`;
}

// ---- 导出 ------------------------------------------------------------

/** 一行待办。多行正文的续行缩进两个空格，留在同一个列表项里。 */
function taskLine(task, now) {
  const meta = [];

  if (parseDue(task.dueAt)) meta.push(`到期 ${formatStamp(task.dueAt, now)}`);
  if (parseRepeat(task.repeat)) meta.push(repeatLabel(task.repeat));

  const images = Array.isArray(task.images) ? task.images.length : 0;
  if (images > 0) meta.push(`${images} 张图片`);

  const text = String(task.text ?? "").trim();
  const [first, ...rest] = text === "" ? ["（无内容）"] : text.split(/\r?\n/);
  const suffix = meta.length > 0 ? ` · ${meta.join(" · ")}` : "";

  const head = `${task.done ? "- [x] " : "- [ ] "}${first}${suffix}`;
  return head + rest.map((line) => `\n  ${line}`).join("");
}

/**
 * 把全部分组与待办导成 Markdown。
 *
 * 忽略 hideCompleted 与 completedBottom：导出要的是完整而稳定的一份，不跟着
 * 界面上的显示开关变。顺序沿用分组顺序与组内手动顺序。
 */
export function toMarkdown(data, now = new Date()) {
  const groups = sortGroups(data.groups ?? []);
  const tasks = data.tasks ?? [];
  const known = new Set(groups.map((group) => group.id));

  const lines = ["# 待办便签", "", `导出时间：${formatFullStamp(now)}`, ""];

  const pushSection = (title, list) => {
    if (list.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const task of list) lines.push(taskLine(task, now));
    lines.push("");
  };

  for (const group of groups) {
    pushSection(
      group.name,
      sortTasks(tasks.filter((task) => task.groupId === group.id), false)
    );
  }

  // 指向已不存在分组的任务：另起一节放在最后，免得它们从导出里凭空消失。
  pushSection(
    "未命名",
    sortTasks(tasks.filter((task) => !known.has(task.groupId)), false)
  );

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// ---- 拖拽落点 --------------------------------------------------------

/**
 * 拖拽落点算成新的定位。
 *
 * 返回所有受影响任务的 `{ id, groupId, order }`，由 store 按 id 套用。两个
 * 分组都要重排：跨组时源分组留下空位，目标分组多出一个位置，各自的 `order`
 * 都要重新连续起来。
 *
 * 落点与当前位置一致时返回空数组 —— 那种拖动没有产生任何效果，不该在撤销栈
 * 里留一步。
 */
export function planDrop(state, { taskId, groupId, beforeTaskId }) {
  const tasks = state?.tasks ?? [];

  const task = tasks.find((item) => item.id === taskId);
  if (!task) return [];

  if (!(state?.groups ?? []).some((group) => group.id === groupId)) return [];

  const sourceGroupId = task.groupId;

  // 目标分组当前的顺序，先把自己摘掉：自己本来就可能在这一组里。
  const targetOrder = sortTasks(
    tasks.filter((item) => item.groupId === groupId && item.id !== taskId),
    false
  );

  let index = targetOrder.length;
  if (beforeTaskId) {
    if (beforeTaskId === taskId) return [];

    const found = targetOrder.findIndex((item) => item.id === beforeTaskId);
    // 落点认不出来（指向别的分组、或者那条已经被删了）时退回末尾。
    if (found >= 0) index = found;
  }

  const nextOrder = [...targetOrder];
  nextOrder.splice(index, 0, task);

  if (sourceGroupId === groupId) {
    const current = sortTasks(
      tasks.filter((item) => item.groupId === groupId),
      false
    );
    const unchanged =
      current.length === nextOrder.length &&
      current.every((item, at) => item.id === nextOrder[at].id);
    if (unchanged) return [];
  }

  const changes = nextOrder.map((item, position) => ({
    id: item.id,
    groupId,
    order: position,
  }));

  if (sourceGroupId !== groupId) {
    const rest = sortTasks(
      tasks.filter((item) => item.groupId === sourceGroupId && item.id !== taskId),
      false
    );
    rest.forEach((item, position) => {
      changes.push({ id: item.id, groupId: sourceGroupId, order: position });
    });
  }

  return changes;
}
