import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  UNDO_LIMIT,
  attachmentPath,
  buildView,
  cloneSnapshot,
  createEmptyData,
  formatAccelerator,
  formatBytes,
  formatFullStamp,
  formatStamp,
  groupCounts,
  highlight,
  isDueThisWeek,
  isDueToday,
  isOverdue,
  matchTask,
  nextDueAt,
  parseLocalDateTime,
  planDrop,
  pushSnapshot,
  repeatFromPreset,
  repeatLabel,
  repeatPreset,
  resolveView,
  sortGroups,
  sortTasks,
  splitDueForInputs,
  takeSnapshot,
  tasksForGroup,
  toMarkdown,
  visibleTasks,
} from "./model.js";

function makeState(overrides = {}) {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    groups: [
      { id: "g2", name: "进行中", order: 1 },
      { id: "g1", name: "待处理", order: 0 },
    ],
    tasks: [
      {
        id: "t1",
        groupId: "g1",
        text: "第一条",
        done: false,
        order: 0,
        createdAt: "2026-09-23T01:00:00.000Z",
        updatedAt: "2026-09-23T01:00:00.000Z",
        images: [],
      },
      {
        id: "t2",
        groupId: "g1",
        text: "第二条",
        done: true,
        order: 1,
        createdAt: "2026-09-23T02:00:00.000Z",
        updatedAt: "2026-09-23T02:30:00.000Z",
        images: [],
      },
      {
        id: "t3",
        groupId: "g2",
        text: "第三条",
        done: false,
        order: 0,
        createdAt: "2026-09-23T03:00:00.000Z",
        updatedAt: "2026-09-23T03:00:00.000Z",
        images: [],
      },
    ],
    ...overrides,
  };
}

function makeUi(overrides = {}) {
  return {
    activeGroupId: "g1",
    cursorTaskId: null,
    editingTaskId: null,
    collapsedGroups: new Set(),
    view: { kind: "group" },
    query: "",
    ...overrides,
  };
}

test("sortGroups 按 order 升序，不改动入参", () => {
  const groups = [
    { id: "b", name: "乙", order: 2 },
    { id: "a", name: "甲", order: 1 },
  ];
  const sorted = sortGroups(groups);
  assert.deepEqual(
    sorted.map((group) => group.id),
    ["a", "b"]
  );
  assert.equal(groups[0].id, "b");
});

test("sortTasks 按 order 升序", () => {
  const tasks = [
    { id: "b", order: 5, createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "a", order: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(
    sortTasks(tasks, false).map((task) => task.id),
    ["a", "b"]
  );
});

test("sortTasks 开启置底后，已完成排在未完成之后", () => {
  const tasks = [
    { id: "done", order: 0, done: true, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "todo", order: 1, done: false, createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  assert.deepEqual(
    sortTasks(tasks, true).map((task) => task.id),
    ["todo", "done"]
  );
  assert.deepEqual(
    sortTasks(tasks, false).map((task) => task.id),
    ["done", "todo"]
  );
});

test("tasksForGroup 在开启隐藏已完成时剔除已完成任务", () => {
  const base = makeState();
  assert.deepEqual(
    tasksForGroup(base, "g1").map((task) => task.id),
    ["t1", "t2"]
  );

  const hidden = makeState({ settings: { ...DEFAULT_SETTINGS, hideCompleted: true } });
  assert.deepEqual(
    tasksForGroup(hidden, "g1").map((task) => task.id),
    ["t1"]
  );
});

test("tasksForGroup 同时应用置底设置", () => {
  const state = makeState({
    settings: { ...DEFAULT_SETTINGS, completedBottom: true },
    tasks: [
      { id: "done-first", groupId: "g1", done: true, order: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "todo-later", groupId: "g1", done: false, order: 1, createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(
    tasksForGroup(state, "g1").map((task) => task.id),
    ["todo-later", "done-first"]
  );
});

test("groupCounts 只数未完成任务", () => {
  const counts = groupCounts(makeState());
  assert.equal(counts.get("g1"), 1);
  assert.equal(counts.get("g2"), 1);
});

test("buildView 在 activeGroupId 失效时回退到第一个分组", () => {
  const view = buildView(makeState(), makeUi({ activeGroupId: "不存在" }));
  assert.equal(view.activeGroup.id, "g1");
  assert.equal(view.groups[0].active, true);
});

test("buildView 反映折叠状态与未完成总数", () => {
  const view = buildView(
    makeState(),
    makeUi({ collapsedGroups: new Set(["g2"]) })
  );
  assert.equal(view.totalUnfinished, 2);
  const section = view.sections.find((item) => item.group.id === "g2");
  assert.equal(section.collapsed, true);
});

test("buildView 对空数据不抛错", () => {
  const view = buildView(createEmptyData(), makeUi({ activeGroupId: null }));
  assert.equal(view.activeGroup, null);
  assert.deepEqual(view.sections, []);
  assert.deepEqual(view.activeTasks, []);
  assert.equal(view.totalUnfinished, 0);
});

test("formatStamp 同一年省略年份，跨年显示年份", () => {
  const iso = "2026-09-23T14:04:00.000Z";
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  assert.equal(formatStamp(iso, new Date(date.getFullYear(), 0, 1)), `${day} ${clock}`);
  assert.equal(
    formatStamp(iso, new Date(date.getFullYear() + 1, 0, 1)),
    `${date.getFullYear()}-${day} ${clock}`
  );
});

test("formatStamp 与 formatFullStamp 对无效输入返回占位", () => {
  assert.equal(formatStamp(""), "—");
  assert.equal(formatStamp("不是时间"), "—");
  assert.equal(formatFullStamp(null), "");
  assert.equal(formatFullStamp("2026-09-23T14:04:05.000Z").length, 19);
});

test("formatAccelerator 把 Code 名还原成人看的写法", () => {
  assert.equal(formatAccelerator("Ctrl+Alt+KeyN"), "Ctrl + Alt + N");
  assert.equal(formatAccelerator("Ctrl+Alt+N"), "Ctrl + Alt + N");
  assert.equal(formatAccelerator("Ctrl+Shift+Digit1"), "Ctrl + Shift + 1");
  assert.equal(formatAccelerator(""), "");
});

test("attachmentPath 统一分隔符并去掉尾部斜杠", () => {
  assert.equal(attachmentPath("C:\\data", "attachments/a.png"), "C:/data/attachments/a.png");
  assert.equal(attachmentPath("C:\\data\\", "attachments/a.png"), "C:/data/attachments/a.png");
  assert.equal(
    attachmentPath("C:\\data", "attachments\\a.png"),
    "C:/data/attachments/a.png"
  );
});

test("resolveView 只认分组与全部，其余回落到分组视图", () => {
  assert.deepEqual(resolveView(undefined), { kind: "group" });
  assert.deepEqual(resolveView({}), { kind: "group" });
  assert.deepEqual(resolveView({ view: { kind: "all" } }), { kind: "all" });
  assert.deepEqual(resolveView({ view: { kind: "没这个" } }), { kind: "group" });
});

test("matchTask 只看正文，大小写不敏感", () => {
  const task = { text: "Fix Login", images: ["attachments/abc123.png"] };
  assert.equal(matchTask(task, ""), true);
  assert.equal(matchTask(task, "   "), true);
  assert.equal(matchTask(task, "login"), true);
  assert.equal(matchTask(task, "LOGIN"), true);
  assert.equal(matchTask({ text: "筛选机制" }, "机制"), true);
  assert.equal(matchTask(task, "后端"), false);
  assert.equal(matchTask(task, "abc123"), false);
});

test("highlight 切出命中片段，搜索词按字面量处理", () => {
  assert.deepEqual(highlight("abc", ""), [{ text: "abc", hit: false }]);
  assert.deepEqual(highlight("abcabc", "bc"), [
    { text: "a", hit: false },
    { text: "bc", hit: true },
    { text: "a", hit: false },
    { text: "bc", hit: true },
  ]);
  assert.deepEqual(highlight("筛选机制", "机制"), [
    { text: "筛选", hit: false },
    { text: "机制", hit: true },
  ]);
  assert.deepEqual(highlight("AB", "ab"), [{ text: "AB", hit: true }]);
  assert.deepEqual(highlight("a.c", "."), [
    { text: "a", hit: false },
    { text: ".", hit: true },
    { text: "c", hit: false },
  ]);
  assert.deepEqual(highlight("xyz", "q"), [{ text: "xyz", hit: false }]);
  assert.deepEqual(highlight("", ""), [{ text: "", hit: false }]);
});

test("visibleTasks 的 all 视图跨分组降平，按分组顺序排列", () => {
  const rows = visibleTasks(makeState(), { kind: "all" }, "");
  assert.deepEqual(
    rows.map((row) => row.task.id),
    ["t1", "t2", "t3"]
  );
  assert.equal(rows[0].groupName, "待处理");
  assert.equal(rows[2].groupName, "进行中");
});

test("visibleTasks 叠加隐藏已完成与搜索词", () => {
  const hidden = makeState({ settings: { ...DEFAULT_SETTINGS, hideCompleted: true } });
  assert.deepEqual(
    visibleTasks(hidden, { kind: "all" }, "").map((row) => row.task.id),
    ["t1", "t3"]
  );
  assert.deepEqual(
    visibleTasks(makeState(), { kind: "group" }, "第三条").map((row) => row.task.id),
    ["t3"]
  );
  assert.deepEqual(
    visibleTasks(makeState(), { kind: "all" }, "第二条").map((row) => row.task.id),
    ["t2"]
  );
});

test("visibleTasks 开启置底后被完成的任务落在各自分组的末尾", () => {
  const state = makeState({
    settings: { ...DEFAULT_SETTINGS, completedBottom: true },
    tasks: [
      { id: "a-done", groupId: "g1", done: true, order: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a-open", groupId: "g1", done: false, order: 1, createdAt: "2026-01-01T00:01:00.000Z" },
      { id: "b-done", groupId: "g2", done: true, order: 0, createdAt: "2026-01-01T00:02:00.000Z" },
      { id: "b-open", groupId: "g2", done: false, order: 1, createdAt: "2026-01-01T00:03:00.000Z" },
    ],
  });
  assert.deepEqual(
    visibleTasks(state, { kind: "all" }, "").map((row) => row.task.id),
    ["a-open", "a-done", "b-open", "b-done"]
  );
});

test("buildView 的分组视图保持原样，不给扁平列表", () => {
  const view = buildView(makeState(), makeUi());

  assert.equal(view.flat, false);
  assert.equal(view.flatTasks, null);
  assert.equal(view.groups.find((item) => item.group.id === "g1").active, true);
});

test("buildView 在全部视图下给出扁平列表与标题", () => {
  const view = buildView(makeState(), makeUi({ view: { kind: "all" } }));

  assert.equal(view.flat, true);
  assert.equal(view.flatTitle, "全部待办");
  assert.deepEqual(
    view.flatTasks.map((row) => row.task.id),
    ["t1", "t2", "t3"]
  );
  assert.equal(view.groups.every((item) => item.active === false), true);
});

test("buildView 有搜索词时一律降平，标题改成搜索结果", () => {
  const view = buildView(makeState(), makeUi({ query: "第三" }));

  assert.equal(view.flat, true);
  assert.equal(view.flatTitle, "搜索结果");
  assert.deepEqual(
    view.flatTasks.map((row) => row.task.id),
    ["t3"]
  );
});

test("buildView 对空数据在扁平视图下也不抛错", () => {
  const view = buildView(
    createEmptyData(),
    makeUi({ activeGroupId: null, view: { kind: "all" } })
  );

  assert.equal(view.flat, true);
  assert.deepEqual(view.flatTasks, []);
});

// ---- 到期、提醒与重复 ------------------------------------------------

/** 本地时间构造，省得在测试里到处写 new Date(y, m - 1, d, h, mi)。 */
function atLocal(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("isDueToday 认准本地今天的边界", () => {
  const now = atLocal(2026, 9, 29, 15, 0);

  assert.equal(isDueToday({ dueAt: atLocal(2026, 9, 29, 0, 0).toISOString() }, now), true);
  assert.equal(isDueToday({ dueAt: atLocal(2026, 9, 29, 23, 59).toISOString() }, now), true);
  assert.equal(isDueToday({ dueAt: atLocal(2026, 9, 30, 0, 0).toISOString() }, now), false);
  assert.equal(isDueToday({ dueAt: atLocal(2026, 9, 28, 23, 59).toISOString() }, now), false);
  assert.equal(isDueToday({ dueAt: null }, now), false);
  assert.equal(isDueToday({}, now), false);
});

test("isOverdue 只认未完成的任务", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const past = atLocal(2026, 9, 29, 9, 0).toISOString();

  assert.equal(isOverdue({ dueAt: past, done: false }, now), true);
  assert.equal(isOverdue({ dueAt: past, done: true }, now), false);
  assert.equal(isOverdue({ dueAt: atLocal(2026, 9, 29, 16, 0).toISOString() }, now), false);
  assert.equal(isOverdue({ dueAt: null }, now), false);
});

test("isDueThisWeek 以周一到下周一为界", () => {
  // 2026-09-29 是周二，本周一是 09-28，下周一是 10-05
  const now = atLocal(2026, 9, 29, 12, 0);

  assert.equal(isDueThisWeek({ dueAt: atLocal(2026, 9, 28, 0, 0).toISOString() }, now), true);
  assert.equal(isDueThisWeek({ dueAt: atLocal(2026, 10, 4, 23, 59).toISOString() }, now), true);
  assert.equal(isDueThisWeek({ dueAt: atLocal(2026, 10, 5, 0, 0).toISOString() }, now), false);
  assert.equal(isDueThisWeek({ dueAt: atLocal(2026, 9, 27, 23, 0).toISOString() }, now), false);

  // 周日当天，本周仍然从上周一算起
  const sunday = atLocal(2026, 10, 4, 12, 0);
  assert.equal(isDueThisWeek({ dueAt: atLocal(2026, 9, 28, 9, 0).toISOString() }, sunday), true);
});

test("nextDueAt 推进到下一个周期，并跳过已经过去的时间", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const due = atLocal(2026, 9, 29, 9, 0).toISOString();

  // 今天 9 点已经过去，下一次是明天 9 点
  assert.equal(nextDueAt(due, "daily", now), atLocal(2026, 9, 30, 9, 0).toISOString());
  assert.equal(nextDueAt(due, "weekly", now), atLocal(2026, 10, 6, 9, 0).toISOString());
  assert.equal(nextDueAt(due, "every:3:day", now), atLocal(2026, 10, 2, 9, 0).toISOString());
});

test("nextDueAt 到期时间还没到时也只推一个周期", () => {
  const now = atLocal(2026, 9, 29, 8, 0);
  const due = atLocal(2026, 9, 29, 9, 0).toISOString();

  assert.equal(nextDueAt(due, "daily", now), atLocal(2026, 9, 30, 9, 0).toISOString());
});

test("nextDueAt 会一直推进到未来（跳过多个月没打开的情况）", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const due = atLocal(2026, 1, 29, 9, 0).toISOString();

  const next = nextDueAt(due, "every:2:month", now);
  assert.equal(next, atLocal(2026, 11, 29, 9, 0).toISOString());
});

test("weekdays 跳过周末", () => {
  const friday = atLocal(2026, 10, 2, 9, 0);
  const now = atLocal(2026, 10, 2, 10, 0);

  assert.equal(nextDueAt(friday.toISOString(), "weekdays", now), atLocal(2026, 10, 5, 9, 0).toISOString());
});

test("monthly 遇到没有该日号的月份退到当月最后一天", () => {
  const jan31 = atLocal(2026, 1, 31, 9, 0);
  const now = atLocal(2026, 1, 31, 10, 0);

  assert.equal(nextDueAt(jan31.toISOString(), "monthly", now), atLocal(2026, 2, 28, 9, 0).toISOString());
});

test("nextDueAt 对缺失或非法输入返回 null", () => {
  const now = new Date();
  const due = now.toISOString();

  assert.equal(nextDueAt(null, "daily", now), null);
  assert.equal(nextDueAt(due, null, now), null);
  assert.equal(nextDueAt(due, "每两天", now), null);
  assert.equal(nextDueAt(due, "every:0:day", now), null);
  assert.equal(nextDueAt(due, "every:2:fortnight", now), null);
});

test("repeatLabel 给出人看的文案", () => {
  assert.equal(repeatLabel(null), "不重复");
  assert.equal(repeatLabel("daily"), "每天");
  assert.equal(repeatLabel("weekdays"), "每个工作日");
  assert.equal(repeatLabel("weekly"), "每周");
  assert.equal(repeatLabel("monthly"), "每月");
  assert.equal(repeatLabel("every:3:day"), "每 3 天");
  assert.equal(repeatLabel("every:2:month"), "每 2 个月");
});

test("resolveView 认五种视图，其余回落到分组", () => {
  assert.deepEqual(resolveView({ view: { kind: "today" } }), { kind: "today" });
  assert.deepEqual(resolveView({ view: { kind: "overdue" } }), { kind: "overdue" });
  assert.deepEqual(resolveView({ view: { kind: "week" } }), { kind: "week" });
  assert.deepEqual(resolveView({ view: { kind: "group" } }), { kind: "group" });
  assert.deepEqual(resolveView({ view: { kind: "没这个" } }), { kind: "group" });
});

test("visibleTasks 的今天与逾期视图各取所需", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const state = makeState({
    tasks: [
      { id: "past", groupId: "g1", done: false, dueAt: atLocal(2026, 9, 29, 9, 0).toISOString(), order: 0, createdAt: "a" },
      { id: "later", groupId: "g1", done: false, dueAt: atLocal(2026, 9, 29, 18, 0).toISOString(), order: 1, createdAt: "b" },
      { id: "tomorrow", groupId: "g1", done: false, dueAt: atLocal(2026, 9, 30, 9, 0).toISOString(), order: 2, createdAt: "c" },
      { id: "none", groupId: "g1", done: false, order: 3, createdAt: "d" },
      { id: "donePast", groupId: "g1", done: true, dueAt: atLocal(2026, 9, 29, 8, 0).toISOString(), order: 4, createdAt: "e" },
    ],
  });

  // 聚合视图统一按到期时间升序，已完成的也在里面（hideCompleted 关着）
  assert.deepEqual(
    visibleTasks(state, { kind: "today" }, "", now).map((row) => row.task.id),
    ["donePast", "past", "later"]
  );
  assert.deepEqual(
    visibleTasks(state, { kind: "overdue" }, "", now).map((row) => row.task.id),
    ["past"]
  );
  assert.deepEqual(
    visibleTasks(state, { kind: "week" }, "", now).map((row) => row.task.id),
    ["donePast", "past", "later", "tomorrow"]
  );
});

test("聚合视图按到期时间排：有到期的在前，没到期的跟在后面", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const state = makeState({
    tasks: [
      { id: "late", groupId: "g1", dueAt: atLocal(2026, 10, 2, 9, 0).toISOString(), order: 0, createdAt: "a" },
      { id: "none", groupId: "g1", dueAt: null, order: 1, createdAt: "b" },
      { id: "soon", groupId: "g1", dueAt: atLocal(2026, 10, 1, 9, 0).toISOString(), order: 2, createdAt: "c" },
    ],
  });

  assert.deepEqual(
    visibleTasks(state, { kind: "all" }, "", now).map((row) => row.task.id),
    ["soon", "late", "none"]
  );
});

test("分组视图保持手动顺序，不按到期时间重排", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const state = makeState({
    tasks: [
      { id: "first", groupId: "g1", dueAt: atLocal(2026, 10, 2, 9, 0).toISOString(), order: 0, createdAt: "a" },
      { id: "second", groupId: "g1", dueAt: atLocal(2026, 10, 1, 9, 0).toISOString(), order: 1, createdAt: "b" },
    ],
  });

  assert.deepEqual(
    visibleTasks(state, { kind: "group" }, "", now).map((row) => row.task.id),
    ["first", "second"]
  );
});

test("buildView 给出四个固定视图与各自的未完成计数", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const state = makeState({
    tasks: [
      { id: "overdue", groupId: "g1", done: false, dueAt: atLocal(2026, 9, 29, 9, 0).toISOString(), order: 0, createdAt: "a" },
      { id: "today", groupId: "g1", done: false, dueAt: atLocal(2026, 9, 29, 18, 0).toISOString(), order: 1, createdAt: "b" },
      { id: "week", groupId: "g1", done: false, dueAt: atLocal(2026, 10, 1, 9, 0).toISOString(), order: 2, createdAt: "c" },
      { id: "none", groupId: "g1", done: false, order: 3, createdAt: "d" },
      { id: "doneOverdue", groupId: "g1", done: true, dueAt: atLocal(2026, 9, 29, 8, 0).toISOString(), order: 4, createdAt: "e" },
    ],
  });

  const view = buildView(state, makeUi(), now);
  const items = Object.fromEntries(view.viewItems.map((item) => [item.key, item]));

  assert.deepEqual(Object.keys(items), ["all", "today", "overdue", "week"]);
  assert.equal(items.all.count, 4);
  assert.equal(items.today.count, 2);
  assert.equal(items.overdue.count, 1);
  assert.equal(items.week.count, 3);
  assert.equal(items.today.label, "今天");
  assert.equal(view.flatTitle, "全部待办");
});

test("buildView 在新视图下给出对应标题", () => {
  const now = atLocal(2026, 9, 29, 15, 0);
  const state = makeState();

  assert.equal(buildView(state, makeUi({ view: { kind: "today" } }), now).flatTitle, "今天");
  assert.equal(buildView(state, makeUi({ view: { kind: "overdue" } }), now).flatTitle, "逾期");
  assert.equal(buildView(state, makeUi({ view: { kind: "week" } }), now).flatTitle, "本周");
  assert.equal(
    buildView(state, makeUi({ view: { kind: "today" }, query: "第三" }), now).flatTitle,
    "搜索结果"
  );
});

test("createEmptyData 的数据文件版本是 3", () => {
  assert.equal(createEmptyData().version, 3);
});

test("repeatPreset 与 repeatFromPreset 来回一致", () => {
  assert.equal(repeatPreset(null), "");
  assert.equal(repeatPreset("daily"), "daily");
  assert.equal(repeatPreset("weekdays"), "weekdays");
  assert.equal(repeatPreset("weekly"), "weekly");
  assert.equal(repeatPreset("monthly"), "monthly");
  assert.equal(repeatPreset("every:3:day"), "every-day");
  assert.equal(repeatPreset("every:2:month"), "every-month");

  assert.equal(repeatFromPreset("", 3), null);
  assert.equal(repeatFromPreset("daily", 9), "daily");
  assert.equal(repeatFromPreset("every-day", 3), "every:3:day");
  assert.equal(repeatFromPreset("every-day"), "every:2:day");
  assert.equal(repeatFromPreset("every-week", 0), "every:2:week");
  assert.equal(repeatFromPreset("every-month", 2.7), "every:2:month");
  assert.equal(repeatFromPreset("没这个", 2), null);
});

test("parseLocalDateTime 与 splitDueForInputs 来回一致", () => {
  const date = parseLocalDateTime("2026-09-30", "18:30");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 8);
  assert.equal(date.getDate(), 30);
  assert.equal(date.getHours(), 18);
  assert.equal(date.getMinutes(), 30);

  const split = splitDueForInputs(date.toISOString());
  assert.deepEqual(split, { date: "2026-09-30", time: "18:30" });
});

test("parseLocalDateTime 缺时刻时按早上九点算，日期非法时返回 null", () => {
  const fallback = parseLocalDateTime("2026-09-30", "");
  assert.equal(fallback.getHours(), 9);
  assert.equal(fallback.getMinutes(), 0);

  assert.equal(parseLocalDateTime("", "09:00"), null);
  assert.equal(parseLocalDateTime("明天", "09:00"), null);
  assert.equal(parseLocalDateTime(null, null), null);
});

test("splitDueForInputs 对空值给默认时刻", () => {
  assert.deepEqual(splitDueForInputs(null), { date: "", time: "09:00" });
  assert.deepEqual(splitDueForInputs("不是时间"), { date: "", time: "09:00" });
});

test("pushSnapshot 超限时丢掉最旧的一份", () => {
  let stack = [];
  for (let index = 0; index < 5; index += 1) {
    stack = pushSnapshot(stack, { label: index }, 3);
  }

  assert.equal(stack.length, 3);
  assert.deepEqual(
    stack.map((item) => item.label),
    [2, 3, 4]
  );
});

test("pushSnapshot 不改动传入的栈", () => {
  const original = [{ label: 0 }];
  const next = pushSnapshot(original, { label: 1 });

  assert.equal(original.length, 1);
  assert.equal(next.length, 2);
  assert.notEqual(next, original);
});

test("pushSnapshot 的上限非法时返回空栈", () => {
  const stack = [{ label: 0 }];

  assert.deepEqual(pushSnapshot(stack, { label: 1 }, 0), []);
  assert.deepEqual(pushSnapshot(stack, { label: 1 }, -3), []);
  assert.deepEqual(pushSnapshot(stack, { label: 1 }, Number.NaN), []);
});

test("pushSnapshot 默认按 UNDO_LIMIT 截断", () => {
  let stack = [];
  for (let index = 0; index < UNDO_LIMIT + 5; index += 1) {
    stack = pushSnapshot(stack, { label: index });
  }

  assert.equal(stack.length, UNDO_LIMIT);
  assert.equal(stack[0].label, 5);
  assert.equal(stack[stack.length - 1].label, UNDO_LIMIT + 4);
});

test("takeSnapshot 空栈返回 null，否则弹出最新一份", () => {
  assert.equal(takeSnapshot([]), null);
  assert.equal(takeSnapshot(null), null);

  const stack = [{ label: "第一步" }, { label: "第二步" }];
  const taken = takeSnapshot(stack);

  assert.equal(taken.snapshot.label, "第二步");
  assert.equal(taken.rest.length, 1);
  assert.equal(taken.rest[0].label, "第一步");
  // rest 必须是新数组，否则 store 里接着压栈会把原来的栈也改掉。
  assert.notEqual(taken.rest, stack);
  assert.equal(stack.length, 2);
});

test("cloneSnapshot 抠出来的快照不受后续改动影响", () => {
  const data = {
    groups: [{ id: "g1", name: "待处理" }],
    tasks: [{ id: "t1", text: "买牛奶" }],
  };
  const snapshot = cloneSnapshot(data);

  data.groups[0].name = "改过了";
  data.tasks.push({ id: "t2", text: "顺手加的" });

  assert.equal(snapshot.groups[0].name, "待处理");
  assert.equal(snapshot.tasks.length, 1);
  assert.notEqual(snapshot.groups, data.groups);
  assert.notEqual(snapshot.tasks[0], data.tasks[0]);
});

test("formatBytes 按 1024 进位，字节那档不带小数", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(undefined), "0 B");

  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GB");
});

test("toMarkdown 空数据只有标题与导出时间", () => {
  const now = new Date(2026, 8, 29, 16, 4);

  const text = toMarkdown({ groups: [], tasks: [] }, now);

  assert.equal(text, "# 待办便签\n\n导出时间：2026-09-29 16:04:00\n");
});

test("toMarkdown 按分组顺序与组内手动顺序输出", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [
      { id: "g2", name: "生活", order: 1 },
      { id: "g1", name: "工作", order: 0 },
    ],
    tasks: [
      { id: "t3", groupId: "g1", text: "第三", order: 2, done: false },
      { id: "t1", groupId: "g1", text: "第一", order: 0, done: true },
      { id: "t2", groupId: "g2", text: "第二", order: 1, done: false },
    ],
  };

  const text = toMarkdown(data, now);

  assert.match(text, /## 工作\n\n- \[x\] 第一\n- \[ \] 第三\n\n## 生活\n\n- \[ \] 第二\n/);
});

test("toMarkdown 把到期、重复与图片张数接在正文之后", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [{ id: "g1", name: "工作", order: 0 }],
    tasks: [
      {
        id: "t1",
        groupId: "g1",
        text: "写设计文档",
        order: 0,
        done: false,
        dueAt: new Date(2026, 8, 30, 9, 0).toISOString(),
        repeat: "weekly",
        images: ["attachments/a.png", "attachments/b.png"],
      },
    ],
  };

  const text = toMarkdown(data, now);

  assert.match(text, /- \[ \] 写设计文档 · 到期 09-30 09:00 · 每周 · 2 张图片\n/);
});

test("toMarkdown 的元信息缺项时不留多余的分隔符", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [{ id: "g1", name: "工作", order: 0 }],
    tasks: [
      {
        id: "t1",
        groupId: "g1",
        text: "只有到期",
        order: 0,
        done: false,
        dueAt: new Date(2026, 8, 30, 9, 0).toISOString(),
      },
      { id: "t2", groupId: "g1", text: "什么都没有", order: 1, done: false },
      {
        id: "t3",
        groupId: "g1",
        text: "规则认不出来",
        order: 2,
        done: false,
        repeat: "every:0:day",
      },
    ],
  };

  const text = toMarkdown(data, now);

  assert.match(text, /- \[ \] 只有到期 · 到期 09-30 09:00\n/);
  assert.match(text, /- \[ \] 什么都没有\n/);
  assert.match(text, /- \[ \] 规则认不出来\n/);
});

test("toMarkdown 的续行缩进两个空格", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [{ id: "g1", name: "工作", order: 0 }],
    tasks: [
      { id: "t1", groupId: "g1", text: "第一行\n第二行\n第三行", order: 0, done: false },
    ],
  };

  const text = toMarkdown(data, now);

  assert.match(text, /- \[ \] 第一行\n  第二行\n  第三行\n/);
});

test("toMarkdown 不为空分组起小节", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [
      { id: "g1", name: "空的", order: 0 },
      { id: "g2", name: "有东西", order: 1 },
    ],
    tasks: [{ id: "t1", groupId: "g2", text: "一条", order: 0, done: false }],
  };

  const text = toMarkdown(data, now);

  assert.ok(!text.includes("## 空的"));
  assert.match(text, /## 有东西\n\n- \[ \] 一条\n/);
});

test("toMarkdown 把指向不存在分组的任务放进「未命名」", () => {
  const now = new Date(2026, 8, 29, 16, 4);
  const data = {
    groups: [{ id: "g1", name: "工作", order: 0 }],
    tasks: [
      { id: "t1", groupId: "g1", text: "有家的", order: 0, done: false },
      { id: "t2", groupId: "g-gone", text: "无家的", order: 0, done: false },
    ],
  };

  const text = toMarkdown(data, now);

  assert.match(text, /## 未命名\n\n- \[ \] 无家的\n/);
  assert.ok(text.indexOf("## 工作") < text.indexOf("## 未命名"));
});

function dropState() {
  return {
    groups: [
      { id: "g1", name: "工作", order: 0 },
      { id: "g2", name: "生活", order: 1 },
    ],
    tasks: [
      { id: "a", groupId: "g1", order: 0 },
      { id: "b", groupId: "g1", order: 1 },
      { id: "c", groupId: "g1", order: 2 },
      { id: "x", groupId: "g2", order: 0 },
    ],
  };
}

/** 把 planDrop 的结果还原成某个分组里按新 order 排好的 id 序列。 */
function orderOf(changes, groupId) {
  return changes
    .filter((item) => item.groupId === groupId)
    .sort((a, b) => a.order - b.order)
    .map((item) => item.id);
}

test("planDrop 在同组内往后挪", () => {
  const changes = planDrop(dropState(), { taskId: "a", groupId: "g1", beforeTaskId: "c" });

  assert.deepEqual(orderOf(changes, "g1"), ["b", "a", "c"]);
});

test("planDrop 在同组内往前挪", () => {
  const changes = planDrop(dropState(), { taskId: "c", groupId: "g1", beforeTaskId: "a" });

  assert.deepEqual(orderOf(changes, "g1"), ["c", "a", "b"]);
});

test("planDrop 跨组插到指定行之前，两边都重排", () => {
  const changes = planDrop(dropState(), { taskId: "a", groupId: "g2", beforeTaskId: "x" });

  assert.deepEqual(orderOf(changes, "g2"), ["a", "x"]);
  assert.deepEqual(orderOf(changes, "g1"), ["b", "c"]);
});

test("planDrop 跨组落到末尾", () => {
  const changes = planDrop(dropState(), { taskId: "a", groupId: "g2", beforeTaskId: null });

  assert.deepEqual(orderOf(changes, "g2"), ["x", "a"]);
  assert.deepEqual(orderOf(changes, "g1"), ["b", "c"]);
});

test("planDrop 移到空分组时 order 从 0 开始", () => {
  const state = dropState();
  state.groups.push({ id: "g3", name: "空", order: 2 });

  const changes = planDrop(state, { taskId: "a", groupId: "g3", beforeTaskId: null });

  assert.deepEqual(orderOf(changes, "g3"), ["a"]);
  assert.equal(changes.find((item) => item.id === "a").order, 0);
  assert.deepEqual(orderOf(changes, "g1"), ["b", "c"]);
});

test("planDrop 落点与当前位置一致时什么都不改", () => {
  const state = dropState();

  // 插到自己前面
  assert.deepEqual(planDrop(state, { taskId: "a", groupId: "g1", beforeTaskId: "a" }), []);
  // 拖到自己原来那条下一条之前：位置没变
  assert.deepEqual(planDrop(state, { taskId: "a", groupId: "g1", beforeTaskId: "b" }), []);
  // 已经在末尾又丢到末尾
  assert.deepEqual(planDrop(state, { taskId: "c", groupId: "g1", beforeTaskId: null }), []);
});

test("planDrop 对不存在的任务或分组返回空", () => {
  const state = dropState();

  assert.deepEqual(planDrop(state, { taskId: "nope", groupId: "g1", beforeTaskId: null }), []);
  assert.deepEqual(planDrop(state, { taskId: "a", groupId: "gone", beforeTaskId: null }), []);
});

test("planDrop 的落点指向别的分组时退回末尾", () => {
  const changes = planDrop(dropState(), { taskId: "a", groupId: "g2", beforeTaskId: "b" });

  assert.deepEqual(orderOf(changes, "g2"), ["x", "a"]);
});

test("planDrop 只列出受影响的任务", () => {
  const changes = planDrop(dropState(), { taskId: "a", groupId: "g2", beforeTaskId: null });

  assert.deepEqual(changes.map((item) => item.id).sort(), ["a", "b", "c", "x"]);
  // 没被碰过的分组不出现在结果里
  assert.ok(!changes.some((item) => item.groupId !== "g1" && item.groupId !== "g2"));
});
