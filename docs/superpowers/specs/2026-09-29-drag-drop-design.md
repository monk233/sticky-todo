# sticky-todo 拖拽排序与换组设计文档

日期：2026-09-29
状态：待实现

## 1. 背景与目标

任务目前只能靠任务行上的「上移 / 下移」在**同一分组内**调整顺序（`moveTask(id, delta)` 用 `siblingsOf` 过滤同组）。跨分组根本没有入口：`store.js` 里没有任何方法能改一条任务的 `groupId`，想把任务挪到别的分组，只能删掉重建，正文、图片、到期时间、重复规则全部重新来一遍。

### 目标

1. 按住任务行拖动，在同一分组内改变顺序。
2. 把任务拖到另一个分组，改 `groupId` 并按落点插入。
3. 两种布局下都能用：面板布局拖到左栏的分组按钮上，列表布局直接拖到目标分组的小节里。
4. 落点实时可见：拖动时有一个占位条指示将要插入的位置。
5. 拖拽不是唯一途径：上移 / 下移按钮与键盘游标保持原样。

### 非目标

- 不做分组的拖拽排序。分组仍用分组栏上的上移 / 下移。
- 不做多选拖拽。
- 不做跨窗口拖拽。
- 不做「移动到分组」的右键菜单或下拉入口。**这是本期的已知缺口**：降平视图下没有换组的手势途径，见第 4 节。
- 不支持触摸屏的长按拖拽手势。Pointer Events 本身兼容触摸，但不做长按延迟与滚动区分。
- 不做自动滚动之外的边缘加速。

## 2. 硬约束：不能用 HTML5 拖放

原本最省事的做法是 HTML5 的 `draggable` + `dragstart` / `dragover` / `drop`。在 Windows 上用不了。

Tauri 的窗口配置项 `dragDropEnabled` 默认为 `true`，本项目的 `src-tauri/tauri.conf.json` 没有设置它，即取默认值。`tauri-utils` 该字段的文档注释原文：

> Whether the drag and drop is enabled or not on the webview. By default it is enabled.
> **Disabling it is required to use HTML5 drag and drop on the frontend on Windows.**

而这个开关正是「拖文件进窗口导入图片」的依托：`src/events.js` 监听 `tauri://drag-drop` 事件，那是 Tauri 用同一个开关拦截系统文件拖放后转发过来的。

于是两件事在 Windows 上互斥：

| 选择 | 后果 |
| --- | --- |
| 关掉 `dragDropEnabled` | 能用 HTML5 拖放；文件拖放导入图片静默失效（只剩粘贴与文件选择两条入口） |
| 保持默认（本期选择） | 图片拖放照旧；内部拖拽必须自己实现 |

**决定：保持 `dragDropEnabled` 默认值，拖拽用 Pointer Events 手写。** 三张图片入口全部保留，代价是多写一层拖拽状态机。

## 3. 交互定义

### 3.1 状态机

```
idle ──pointerdown──▶ pressed ──移动超过 5px──▶ dragging ──pointerup──▶ 提交
                        │                          │
                        └──pointerup──▶ idle       └──pointercancel / Esc──▶ 取消
```

- `pressed` 只是记下起点，不改任何视觉。**不在这里 `preventDefault()`**，否则单击聚焦与双击进入编辑都会被吃掉。
- 位移超过 5px 才进入 `dragging`。这个阈值负责把「点击」与「拖动」分开，是双击编辑能继续工作的前提。
- `dragging` 期间对行 `setPointerCapture`，指针移出窗口也能收到 `pointerup`。

### 3.2 可拖拽的起点

`li.task` 上的 `pointerdown`，但这些区域按下不启动拖拽：

- `.task__check`（勾选按钮）
- `.task__tools`（日历、图片、编辑、删除按钮）
- `.task__editor`（编辑态的 textarea）
- `.due-editor`（到期与重复面板）
- 整行处于编辑态（`li.task.is-editing`）时，整行都不可拖

### 3.3 拖动中的视觉

| 元素 | 表现 |
| --- | --- |
| 被拖的行 | 加 `.is-dragging`，`opacity: 0.4`，留在原位 |
| 跟随指针的浮层 | `.drag-ghost`：克隆该行的 DOM，`position: fixed`，`pointer-events: none`，`z-index` 70（压过提示条） |
| 插入位置 | `.drop-marker`：一条 2px 的 `--accent` 横线，插在目标 `ul.tasks` 里，当作一个 `li` |
| 侧栏分组落点 | 目标分组按钮加 `.is-drop-target`，描边 + 背景用 `--accent-soft` |

浮层挂在 `body` 下，避免被工作区的滚动容器裁掉。浮层设 `pointer-events: none`，这样 `document.elementFromPoint` 不会命中它。

### 3.4 落点判定

每帧（`pointermove` 里做节流）用 `document.elementFromPoint(clientX, clientY)` 取当前指针下的元素，按顺序尝试：

1. `closest("button.group")` → 侧栏分组按钮，落到该分组末尾。这一类落点**不插占位条**，改用 `.is-drop-target` 高亮。侧栏不与列表区域重叠，先判它不影响其余几类。
2. `closest("li.task")` → 与目标行的中线比较：指针在上半部插到它前面，下半部插到它后面。占位条移到该行之前或之后。
3. `closest("ul.tasks")` → 插到列表末尾（列表非空时是最后一个行之后）。
4. `closest("section.section[data-id]")` → 列表布局里空分组的小节。占位条插到该小节内部。
5. 以上都不匹配 → 隐藏占位条，本次松手视为取消。

面板布局的右栏里没有别的分组，第 1 类是这种布局下唯一的换组途径。

### 3.5 提交

`pointerup` 时按占位条的位置算：

- `groupId` = 占位条所在 `ul.tasks` / `section` / 分组按钮对应的分组 id
- `beforeTaskId` = 占位条的**下一个** `li.task` 的 id；没有下一个则为 `null`（插到末尾）

没有任何落点（占位条未显示）时直接取消，不改数据。

调用：

```js
store.dropTask(taskId, { groupId, beforeTaskId });
```

换组成功时 toast `已移动到「分组名」。`；同组内排序不提示。

### 3.6 取消

- `pointercancel`（系统抢占指针、原生拖拽启动等）
- 拖动中按下 `Esc`
- 指针释放时没有落点

取消时移除所有拖拽类与浮层，数据不动。

### 3.7 自动滚动

指针进入工作区滚动容器上下边缘 36px 以内时启动 `requestAnimationFrame` 循环，每帧最多滚动 20px，速度按指针离边缘的距离线性增长（刚越过 36px 那条线时为 0）。指针离开边缘、结束拖拽、`pointercancel` 时都要停掉循环。滚动之后行都挪了位，落点要按指针当前位置重算一遍。

### 3.8 与既有交互的冲突处理

| 冲突 | 处理 |
| --- | --- |
| 单击聚焦（`focus-task`） | 未超过阈值就松手时，事件照常冒泡，`handleClick` 不受影响 |
| 双击进入编辑 | 同上：两次「按下—松开」都在阈值内，不会进入 `dragging` |
| 拖动时选中文本 | 进入 `dragging` 时给 `body` 加 `.is-dragging`，CSS 里 `user-select: none`；并调一次 `window.getSelection().removeAllRanges()` |
| 缩略图触发原生图片拖拽 | 任务缩略图的 `img` 加 `draggable="false"`。否则原生的图片拖放启动时会触发 `pointercancel`，拖到一半凭空中断 |
| 键盘游标移动 | 拖拽不改变光标；提交后把光标设为被拖的任务 |
| 上移 / 下移按钮 | 保留，与拖拽共用同一套重排逻辑 |
| 编辑态与到期面板 | 打开时对应行不可拖，见 3.2 |

## 4. 视图规则

| 视图 | 排序 | 换组 |
| --- | --- | --- |
| 分组视图 · 面板布局 | 支持（同组内） | 支持（拖到侧栏分组按钮） |
| 分组视图 · 列表布局 | 支持（同组内） | 支持（拖到目标小节） |
| 降平视图（全部待办 / 今天 / 逾期 / 本周） | 不支持 | 不支持 |
| 搜索结果（任何视图下） | 不支持 | 不支持 |

**降平视图下整体禁用拖拽**，`pointerdown` 直接不进入 `pressed` 状态。理由：降平列表的顺序由 `dueAt` 升序决定，与 `order` 无关；拖一行到新位置，界面不会跟着动，用户会认为功能坏了。只允许换组也不合适 —— 落点还得靠行位置表达，而行的位置本身不表达分组归属（分组只写在徽章里）。

折叠的分组小节不能作为落点，占位条跳过它。

**已知缺口**：降平视图下没有换组的手势途径，面板布局下换组必须拖到左栏。需要更轻的入口时，可另做「移动到」菜单，本期不做。

## 5. 数据与接口

### 5.1 纯函数（`model.js`）

```js
export function planDrop(state, { taskId, groupId, beforeTaskId }) -> [{ id, groupId, order }]
```

返回**所有受影响任务**的新 `{ id, groupId, order }` 三元组，由 store 按 id 套用。受影响范围包括源分组与目标分组（跨组时两边都要重排），保证每个分组内的 `order` 重新连续为 `0..n-1`。

不返回整个任务对象，只返回定位所需的最小字段，测试里比对起来清楚。

边界：

- `taskId` 不存在 → 返回空数组。
- `beforeTaskId` 等于 `taskId`，或落点就是当前位置 → 返回空数组（不制造无变化的一步撤销）。
- `groupId` 指向不存在的分组 → 返回空数组。
- 目标分组为空 → 该任务 `order` 为 0。

### 5.2 store

```js
function dropTask(taskId, { groupId, beforeTaskId });
```

1. `planDrop` 算新定位；结果为空则直接返回。
2. `pushUndo("移动待办")` —— 在改动之前，见撤销设计文档。
3. 按结果逐个套用 `groupId` / `order`，被拖的任务更新 `updatedAt`。
4. `ui.cursorTaskId = taskId`。
5. `scheduleSave()` + `notify()`。
6. 若 `groupId` 变了，toast 提示新分组名。

### 5.3 事件层

拖拽状态机与落点计算放进新文件 `src/dragdrop.js`，由 `events.js` 在装配时接上：

```js
export function createDragLayer({ host, store, enabled });
```

- `enabled()` 由 `events.js` 提供：读 `store.getUi().view` 与当前布局，判断这次是否允许拖拽（第 4 节）。
- 内部自己注册 `pointerdown` / `pointermove` / `pointerup` / `pointercancel` 监听。整个应用只装配一次，所以不提供解绑。
- 拆成独立文件是因为 `events.js` 已经 800 多行，而拖拽有自己完整的状态与 DOM 生命周期操作。

`Esc` 取消挂在既有的 `handleKeyDown` 里：拖动中优先处理，吞掉这次按键。

## 6. 测试策略

### 6.1 前端单元测试（`model.test.js`）

- 同组内向后移动：`order` 重新连续，其余任务顺移。
- 同组内向前移动：同上。
- 跨组移动到指定行之前：源分组与目标分组的 `order` 都变为连续。
- 跨组移动到末尾（`beforeTaskId` 为 `null`）。
- 移动到空分组：目标任务 `order` 为 0，源分组不留空洞。
- `beforeTaskId` 指向自己 → 返回空数组。
- 落点与当前位置相同（拖到自己原来的下一条之前）→ 返回空数组。
- 不存在的 `taskId` / `groupId` → 返回空数组。
- 返回值只含受影响的 id，不含未受影响的任务。

### 6.2 手动验证

1. 列表布局下把任务从一个分组拖到另一个分组的中间 → 落点、`order`、分组徽章都正确。
2. 拖到空分组的小节里 → 成为该分组唯一一条。
3. 面板布局下拖到左栏分组按钮 → 移入该分组末尾，toast 报出新分组名。
4. 同组内上下调整顺序 → 刷新后顺序不变（说明写进了 `order`）。
5. 拖动中按 `Esc` → 回到原位，数据不变。
6. 拖动到工作区边缘 → 列表自动滚动。
7. 单击、双击一个任务 → 聚焦与进入编辑都照常，没有被拖拽吃掉。
8. 拖动时指针经过缩略图 → 拖拽不中断。
9. 降平视图（全部待办）下按住任务 → 不启动拖拽。
10. 拖完按 `Ctrl + Z` → 回到拖动前的位置与分组。
11. 十套主题下检查拖拽态：占位条、浮层、侧栏落点高亮都看得清，三套像素主题不破相。
12. 折叠某分组后拖动 → 折叠的小节不作为落点。

### 6.3 真机确认项

- WebView2 上 `setPointerCapture` 后 `pointerup` 一定收到（拖出窗口再松手）。
- 任务缩略图加上 `draggable="false"` 后，拖动中途不再出现 `pointercancel`。

## 7. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/model.js` | `planDrop` |
| `src/model.test.js` | 第 6.1 节的用例 |
| `src/store.js` | `dropTask` |
| `src/dragdrop.js` | 新增：状态机、落点判定、浮层与占位条、自动滚动 |
| `src/events.js` | 装配拖拽层、`Esc` 取消分支 |
| `src/render.js` | 缩略图 `draggable="false"` |
| `src/style.css` | `.is-dragging` / `.drag-ghost` / `.drop-marker` / `.is-drop-target` / `body.is-dragging`，全部走现有变量 |
| `src/app.js` | 不改动 —— 装配点在 `events.js` |
| `README.md` | 功能清单、目录结构、已知限制 |

`src-tauri/tauri.conf.json` **不改动**。

## 8. 待办清单（实现顺序）

1. `model.js` 的 `planDrop` 与 `model.test.js` 用例，跑 `npm test`。
2. `store.js` 的 `dropTask`，先用上移 / 下移按钮之外的路径手动调一次确认数据正确。
3. `dragdrop.js`：状态机与同组内排序（先不跨组），手动验证排序。
4. `dragdrop.js`：跨组落点与侧栏落点，手动验证换组。
5. `style.css`：四种拖拽态的样式，逐主题过一遍。
6. `events.js` / `app.js` 接线、`Esc` 取消。
7. 手动验证第 6.2 节十二项与第 6.3 节两项。
8. README。
