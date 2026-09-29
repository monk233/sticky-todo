# sticky-todo 撤销设计文档

日期：2026-09-29
状态：待实现

## 1. 背景与目标

删除任务、删除分组、改正文、勾选完成目前都是就地改内存里的数据，再走 300 毫秒防抖写盘。任何一次误操作都只能靠手改 `data.json` 挽回，而写盘早已发生，改文件的风险比误操作本身还大。删除分组的确认是「点两次」，但删除单条任务连这层都没有：`Delete` 与 `Backspace` 是直接调用。

### 目标

1. 任意一次改动分组或任务的操作都能撤回一步，包括快捷键触发的删除。
2. 覆盖全部会改动 `groups` / `tasks` 的动作：新建、改正文、勾选、删除、上下移动、换组、设置与清除到期、增删图片、分组的增删改与移动。
3. 两个入口：`Ctrl + Z`，以及最近一次操作后 toast 上的「撤销」按钮。
4. 撤销只作用于分组与任务，不把设置类改动一起吞掉。

### 非目标

- 不做重做（`Ctrl + Shift + Z` / `Ctrl + Y`）。
- 不做跨会话撤销。撤销栈只在内存里，退出程序即清空。
- 不做文件级撤销：撤销恢复的是任务对图片的引用，已经删掉的图片文件找不回来。
- 不做历史面板或按时间轴浏览的版本记录。
- 不撤销设置项：主题、布局、显示开关、快捷键、更新偏好改动都不入栈。

## 2. 方案：整份快照

两种做法，选快照：

| 做法 | 说明 |
| --- | --- |
| 反向操作 | 每个动作配一个 undo 函数 |
| 整份快照 | 改动前把分组与任务整份拷一份压进栈 |

选快照的理由：

1. 要覆盖 15 个以上的动作。反向操作得逐个写反演，漏一个就是 bug，将来加新动作时还容易忘记补，而这类遗漏在测试里很难发现。
2. 数据本体是纯 JSON，没有二进制。快照只含 `groups` 与 `tasks`，不含 `settings`，也不含图片文件本身，体积就是文本量级。
3. 快照与渲染层无关：store 恢复数据后调一次 `notify()`，渲染层照常全量重建 DOM，不需要 diff。

代价是每次改动多一次深拷贝。数据量在几万条任务以下时可以忽略。

### 快照内容

```js
{
  groups: [...],
  tasks: [...],
  activeGroupId: "g-1",
  cursorTaskId: "t-9",
}
```

带上 `activeGroupId` 与 `cursorTaskId`：撤销掉一条被删除的任务之后，光标要落回这条任务上，而不是停在别处或指向一个已经不存在的 id。

### 栈

```js
const UNDO_LIMIT = 50;
const undoStack = []; // [{ label, snapshot }]
```

- 上限 50 步，超出丢掉最旧的一份。
- `label` 记这次改动的人话名字（「删除待办」「勾选完成」），撤销后回显给用户。

### 压栈时机

统一收在 store 里，每个会改动 `groups` / `tasks` 的动作在动手**之前**调用：

```js
pushUndo(label);
```

内部逻辑：

1. `applyingUndo` 为真时直接返回 —— 撤销本身不再入栈。
2. 用 `cloneSnapshot` 拷一份 `{ groups, tasks, activeGroupId, cursorTaskId }` 压栈，超限截断。

三条纪律：

- **压栈必须在「确认要改」之后、真正改之前。** 例如 `moveTask` 在边界上直接 `return`，越界的那次不该留下一步空的撤销。
- **一次操作只压一份。** 删除分组会连带删掉分组里的任务，那只压一份；勾选完成会顺带排出下一条重复任务，也只压一份。
- **没有变化就不压。** `commitEdit` 里正文没变时不压栈，否则方向键走一圈就能把栈塞满。

### 撤销

```js
undo();
```

1. 弹出栈顶，恢复 `groups` / `tasks` / `activeGroupId` / `cursorTaskId`。
2. 清掉与这批数据绑定的编辑态：`editingTaskId`、`editingGroupId`、`confirmDeleteGroupId`、`dueEditorTaskId`。否则撤销后可能出现「编辑一条已经不存在的任务」的状态。
3. `scheduleSave()` 再 `notify()`。`scheduleSave` 会顺手刷新提醒计划与托盘摘要，撤销掉一条带到期时间的任务后通知不会继续留着。
4. toast「已撤销：<label>」。

栈空时什么都不做，只提示「没有可撤销的操作」。

### 清栈

`reload()` 时清空，这覆盖了切换数据目录与手动重新加载两种入口。不清栈的后果是把上一个数据目录的 `groups` / `tasks` 恢复到当前目录里。

## 3. 界面

### 快捷键

`Ctrl + Z`（同时接受 `Cmd + Z`），加在 `handleKeyDown` 的非输入态分支里。输入框聚焦时那个函数会提前 `return`，所以编辑正文、到期面板、搜索框里都不会被接管；设置面板打开时也不触发。

两处不接管：

- `ui.editingTaskId` 不为空时。输入框里的 `Ctrl + Z` 应该由浏览器做文本撤销，否则用户想撤回刚敲的几个字，结果整条任务被回退掉。
- 焦点在 `due-editor` 的日期或时刻输入框里时，同理。

### toast 按钮

`ui.toasts` 的条目加可选字段 `undo: true`。渲染层在该条目里多挂一个 `data-action="undo"` 的按钮，文案「撤销」。

- 只有**最新一条**且 `undo` 为真的 toast 显示按钮。否则连做三次操作后屏幕上会并排出现三个撤销按钮，点哪个都不明确。
- 按钮与快捷键走同一个 `store.undo()`。
- toast 4.2 秒后消失，按钮随之消失；快捷键不受这个时间窗限制。

## 4. 接口

`store.js` 新增：

| 名字 | 说明 |
| --- | --- |
| `pushUndo(label)` | 内部使用，改动前压快照 |
| `undo()` | 弹出并恢复，返回是否真的撤销了 |

返回值对象里增加 `undo`。

`model.js` 新增三个纯函数，让栈的行为可测（`store.js` 本身没有测试，它依赖 `invoke`）：

| 名字 | 签名 | 说明 |
| --- | --- | --- |
| `cloneSnapshot` | `(value) -> 深拷贝` | `structuredClone`，老环境退回 JSON 一趟 |
| `pushSnapshot` | `(stack, snapshot, limit) -> 新数组` | 压栈，超限丢最旧 |
| `takeSnapshot` | `(stack) -> { snapshot, rest } \| null` | 弹栈，空栈返回 null |

## 5. 压栈一览

| 动作 | label | 备注 |
| --- | --- | --- |
| `addTask` | 新建待办 | |
| `commitEdit` | 修改正文 | 正文真变了才压 |
| `toggleTask` | 勾选完成 / 取消完成 | 随带生成的重复任务合并为一份 |
| `removeTask` | 删除待办 | `silent: true` 的内部清理不压 |
| `moveTask` | 移动待办 | |
| `dropTask` | 移动待办 | 拖拽换组与换序，见拖拽设计文档 |
| `addImages` | 添加图片 | |
| `removeImage` | 移除图片 | |
| `setDue` | 设置到期 | |
| `setRepeat` | 设置重复 | |
| `clearDue` | 清除到期 | |
| `snoozeTask` | 延后提醒 | 从通知点「延后」时触发 |
| `addGroup` | 新建分组 | |
| `renameGroup` | 重命名分组 | 名字没变不压 |
| `moveGroup` | 移动分组 | |
| `deleteGroup` | 删除分组 | 连带的任务算在同一份里 |

不压栈：`selectGroup`、`setCursor`、`startEdit`、`cancelEdit`、`toggleCollapse`、`setView`、`setQuery`，以及所有 `updateSetting` 及其衍生（主题、布局、显示开关、快捷键、更新偏好、自动检查）。

## 6. 测试策略

### 6.1 前端单元测试

`model.test.js` 覆盖两个纯函数：

- 压栈超过上限时丢掉最旧一份，栈长度稳定在上限。
- 空栈弹出返回 null。
- 快照与外层对象是深拷贝关系：压栈后继续改原对象，快照内容不变。
- `takeSnapshot` 返回的 `rest` 不共享原数组的引用。

### 6.2 手动验证

1. 删一条带图片和到期时间的任务 → toast 上点「撤销」→ 任务带着全部字段回到原位。
2. 连按三次上移后按 `Ctrl + Z` → 回退一步（三次上移是三份快照，这与文本编辑器的行为不同，是有意的取舍）。
3. 编辑正文时按 `Ctrl + Z` → 走 textarea 自己的撤销，整条任务没有被回退。
4. 删除一个含多条任务的分组 → 一次撤销把它们全部带回来。
5. 连续操作 60 次后，只有最近 50 步可撤销。
6. 栈空时按 `Ctrl + Z` → 只提示，不报错、不产生空操作。
7. 切换数据目录后按 `Ctrl + Z` → 不会把上一个目录的数据恢复进来。
8. 撤销一条**已完成**的重复任务 → 生成出来的下一条也一起消失。

### 6.3 已知取舍

连续同类操作各占一步，撤销需要按同样多次。合并的规则（同类操作且间隔短就覆盖上一步）会让行为更聪明也更难预料，本期不做。

## 7. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/model.js` | `cloneSnapshot` / `pushSnapshot` / `takeSnapshot` 与上限常量 |
| `src/model.test.js` | 上述纯函数用例 |
| `src/store.js` | 快照栈、`pushUndo`、`undo`、各动作接线、`reload` 清栈 |
| `src/events.js` | `Ctrl + Z` 分支、`undo` 动作分支 |
| `src/render.js` | 最新一条 toast 上的撤销按钮 |
| `src/style.css` | toast 按钮样式，走现有变量 |
| `README.md` | 功能清单与快捷键表 |

## 8. 待办清单（实现顺序）

1. `model.js` 的两个纯函数与 `model.test.js` 用例，跑 `npm test`。
2. `store.js`：栈、`pushUndo` 接线到上表全部动作、`undo()`、`reload` 清栈。
3. `events.js`：`Ctrl + Z` 与 `undo` 动作分支。
4. `render.js` / `style.css`：toast 上的撤销按钮。
5. 手动验证第 6.2 节的八项。
6. README。
