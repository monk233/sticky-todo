import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  attachmentPath,
  buildView,
  createEmptyData,
  formatAccelerator,
  formatFullStamp,
  formatStamp,
  groupCounts,
  highlight,
  matchTask,
  removeTagFromTasks,
  renameTagInTasks,
  resolveView,
  sortGroups,
  sortTasks,
  tagCounts,
  tasksForGroup,
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
        tags: ["工作", "评审"],
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
        tags: ["工作"],
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
        tags: [],
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
    view: { kind: "group", tag: "" },
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

test("createEmptyData 的数据文件版本是 2", () => {
  assert.equal(createEmptyData().version, 2);
});

test("resolveView 只认四种视图，其余回落到分组视图", () => {
  assert.deepEqual(resolveView(undefined), { kind: "group", tag: "" });
  assert.deepEqual(resolveView({ view: { kind: "all" } }), { kind: "all", tag: "" });
  assert.deepEqual(resolveView({ view: { kind: "untagged" } }), { kind: "untagged", tag: "" });
  assert.deepEqual(resolveView({ view: { kind: "tag", tag: " 工作 " } }), {
    kind: "tag",
    tag: "工作",
  });
  assert.deepEqual(resolveView({ view: { kind: "tag", tag: "   " } }), { kind: "group", tag: "" });
  assert.deepEqual(resolveView({ view: { kind: "tag" } }), { kind: "group", tag: "" });
  assert.deepEqual(resolveView({ view: { kind: "没这个" } }), { kind: "group", tag: "" });
});

test("matchTask 匹配正文与标签，大小写不敏感", () => {
  const task = { text: "Fix Login", tags: ["前端"] };
  assert.equal(matchTask(task, ""), true);
  assert.equal(matchTask(task, "   "), true);
  assert.equal(matchTask(task, "login"), true);
  assert.equal(matchTask(task, "LOGIN"), true);
  assert.equal(matchTask(task, "前端"), true);
  assert.equal(matchTask(task, "端"), true);
  assert.equal(matchTask(task, "后端"), false);
  assert.equal(matchTask({ text: "x", images: ["attachments/abc123.png"] }, "abc123"), false);
});

test("tagCounts 的清单含已完成任务的标签，计数只算未完成", () => {
  const counts = tagCounts(makeState());
  assert.equal(counts.get("工作"), 1);
  assert.equal(counts.get("评审"), 1);
  assert.equal(counts.has(""), false);
});

test("tagCounts 对同一任务里的重复标签只计一次", () => {
  const state = makeState({
    tasks: [{ id: "t", groupId: "g1", done: false, tags: ["a", " a ", "a", "b"] }],
  });
  const counts = tagCounts(state);
  assert.equal(counts.get("a"), 1);
  assert.equal(counts.get("b"), 1);
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
  const rows = visibleTasks(makeState(), { kind: "all", tag: "" }, "");
  assert.deepEqual(
    rows.map((row) => row.task.id),
    ["t1", "t2", "t3"]
  );
  assert.equal(rows[0].groupName, "待处理");
  assert.equal(rows[2].groupName, "进行中");
});

test("visibleTasks 的 untagged 视图只剩没有标签的任务", () => {
  const rows = visibleTasks(makeState(), { kind: "untagged", tag: "" }, "");
  assert.deepEqual(
    rows.map((row) => row.task.id),
    ["t3"]
  );
});

test("visibleTasks 的 tag 视图按标签筛选", () => {
  const rows = visibleTasks(makeState(), { kind: "tag", tag: "工作" }, "");
  assert.deepEqual(
    rows.map((row) => row.task.id),
    ["t1", "t2"]
  );
});

test("visibleTasks 叠加隐藏已完成与搜索词", () => {
  const hidden = makeState({ settings: { ...DEFAULT_SETTINGS, hideCompleted: true } });
  assert.deepEqual(
    visibleTasks(hidden, { kind: "all", tag: "" }, "").map((row) => row.task.id),
    ["t1", "t3"]
  );
  assert.deepEqual(
    visibleTasks(makeState(), { kind: "group", tag: "" }, "第三条").map((row) => row.task.id),
    ["t3"]
  );
  assert.deepEqual(
    visibleTasks(makeState(), { kind: "tag", tag: "工作" }, "第二条").map((row) => row.task.id),
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
    visibleTasks(state, { kind: "all", tag: "" }, "").map((row) => row.task.id),
    ["a-open", "a-done", "b-open", "b-done"]
  );
});

test("renameTagInTasks 批量改名、同任务内去重，且不改动入参", () => {
  const tasks = [
    { id: "t1", tags: ["工作", "评审"], updatedAt: "旧" },
    { id: "t2", tags: ["评审"], updatedAt: "旧" },
  ];
  const next = renameTagInTasks(tasks, "工作", "评审", "新");

  assert.deepEqual(next[0].tags, ["评审"]);
  assert.equal(next[0].updatedAt, "新");
  assert.equal(next[1], tasks[1]);
  assert.deepEqual(tasks[0].tags, ["工作", "评审"]);
});

test("renameTagInTasks 对空目标名、同名替换、空源名都不做改动", () => {
  const tasks = [{ id: "t1", tags: ["工作"] }];
  assert.deepEqual(renameTagInTasks(tasks, "工作", "", "新")[0].tags, ["工作"]);
  assert.deepEqual(renameTagInTasks(tasks, "工作", "  ", "新")[0].tags, ["工作"]);
  assert.deepEqual(renameTagInTasks(tasks, "工作", "工作", "新")[0].tags, ["工作"]);
  assert.deepEqual(renameTagInTasks(tasks, "", "别的", "新")[0].tags, ["工作"]);
});

test("removeTagFromTasks 只动带这个标签的任务", () => {
  const tasks = [
    { id: "t1", tags: ["工作", "评审"], updatedAt: "旧" },
    { id: "t2", tags: ["私人"], updatedAt: "旧" },
  ];
  const next = removeTagFromTasks(tasks, "工作", "新");

  assert.deepEqual(next[0].tags, ["评审"]);
  assert.equal(next[0].updatedAt, "新");
  assert.equal(next[1], tasks[1]);
  assert.deepEqual(removeTagFromTasks(tasks, "", "新")[0].tags, ["工作", "评审"]);
});

test("buildView 的分组视图保持原样，不给扁平列表", () => {
  const view = buildView(makeState(), makeUi());

  assert.equal(view.flat, false);
  assert.equal(view.flatTasks, null);
  assert.equal(view.groups.find((item) => item.group.id === "g1").active, true);
  assert.equal(view.viewItems[0].active, false);
  assert.equal(view.viewItems[1].active, false);
});

test("buildView 在标签视图下给出扁平列表与标题，并标出当前项", () => {
  const view = buildView(makeState(), makeUi({ view: { kind: "tag", tag: "工作" } }));

  assert.equal(view.flat, true);
  assert.equal(view.flatTitle, "标签「工作」");
  assert.deepEqual(
    view.flatTasks.map((row) => row.task.id),
    ["t1", "t2"]
  );
  assert.equal(view.tags.find((item) => item.tag === "工作").active, true);
  assert.equal(view.tags.find((item) => item.tag === "评审").active, false);
  assert.equal(view.groups.every((item) => item.active === false), true);
  assert.deepEqual(
    view.tags.map((item) => item.tag),
    ["工作", "评审"]
  );
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
    makeUi({ activeGroupId: null, view: { kind: "all", tag: "" } })
  );

  assert.equal(view.flat, true);
  assert.deepEqual(view.flatTasks, []);
  assert.deepEqual(view.tags, []);
  assert.equal(view.viewItems[0].active, true);
});
