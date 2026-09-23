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
  sortGroups,
  sortTasks,
  tasksForGroup,
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
