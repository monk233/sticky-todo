# sticky-todo 拖拽排序与换组实现计划

依据：[2026-09-29-drag-drop-design.md](../specs/2026-09-29-drag-drop-design.md)

前置：**撤销**。`dropTask` 要在改动前调 `pushUndo("移动待办")`，拖拽是本项目里最容易拖错位置的手势，没有回退不该上线。

完成定义：`npm test` 全绿；设计文档第 6.2 节的十二项与第 6.3 节的两项验证通过；README 更新，并把降平视图下的限制写清楚。

## 阶段 0：先确认硬约束

在真机上花几分钟验证设计文档第 2 节的前提，结论会决定后面所有实现：

1. 当前 `tauri.conf.json`（未设置 `dragDropEnabled`）下，把文件拖进窗口导入图片仍然工作。
2. 同一份配置下，HTML5 的 `draggable="true"` + `dragstart` 是否真的不触发（预期不触发）。
3. 任务缩略图上的 `img` 在拖动时会不会启动原生图片拖拽（预期会，所以要加 `draggable="false"`）。

验证：三项各自的结论记进设计文档的注释或本计划的备注里。若第 2 项与预期相反（HTML5 DnD 可用），停下来找用户确认是否改走原生方案 —— 那会改变整个实现。

## 阶段 1：`planDrop` 纯函数

`src/model.js` 新增：

```js
export function planDrop(state, { taskId, groupId, beforeTaskId });
```

返回 `[{ id, groupId, order }]`。实现要点：

- 复用 `sortTasks(tasks, false)` 取手动顺序，不要自己写比较函数。
- 源分组与目标分组都要重排，各自重新编号为 `0..n-1`。
- 先把被拖的任务从源列表摘掉，再插进目标列表的指定位置，最后统一编号。
- 三类空结果：`taskId` / `groupId` 不存在；`beforeTaskId` 等于 `taskId`；落点与当前位置相同。

`src/model.test.js` 覆盖设计文档第 6.1 节的九类用例。

验证：`npm test` 通过。

## 阶段 2：`store.dropTask`

`src/store.js`：

1. `dropTask(taskId, { groupId, beforeTaskId })`：`planDrop` → 空结果直接返回 → `pushUndo("移动待办")` → 逐个套用 → 更新 `updatedAt` → 设光标 → `scheduleSave()` + `notify()` → 换组时 toast。
2. 返回值里导出 `dropTask`。

此时还没有拖拽界面，用一个临时的调用点验证数据正确（例如在控制台里调，或临时给上移按钮加一个「移到下一个分组」的分支，验证完删掉）。

验证：手工构造几次跨组与组内移动，检查 `data.json` 里的 `order` 连续、`groupId` 正确。

## 阶段 3：拖拽层的最小组件

新增 `src/dragdrop.js`：

```js
export function createDragLayer({ host, store, enabled });
```

这一阶段只做同组内排序：

1. `pointerdown` 命中 `li.task` 且不在排除区域内时进入 `pressed`，记下起点与 `pointerId`。
2. `pointermove` 位移超过 5px → `dragging`：`setPointerCapture`、原行加 `.is-dragging`、创建 `.drag-ghost` 跟随指针、`body` 加 `.is-dragging`。
3. 落点只认 `closest("ul.tasks")` 与 `closest("li.task")`，占位条 `.drop-marker` 只在本列表内移动。
4. `pointerup` 读占位条位置算 `beforeTaskId`，调 `store.dropTask`。
5. `pointercancel` 与 `Esc` 取消。

验证：`npm run dev` 或 harness 里拖同一分组内的任务，顺序变化正确且刷新后保持。

## 阶段 4：跨组与侧栏落点

1. 落点判定按设计文档第 3.4 节的顺序补齐 `section.section[data-id]` 与 `button.group[data-action="select-group"]`。
2. 侧栏落点用 `.is-drop-target` 高亮，不插占位条。
3. 折叠的分组小节跳过（`section.section.is-collapsed` 不作为落点）。
4. 自动滚动：设计文档第 3.7 节，`requestAnimationFrame` 循环要有明确的启停点，全部取消路径都要停。
5. `enabled()` 由 `events.js` 提供：降平视图与搜索态返回 `false`。

验证：列表布局下跨组拖动、面板布局下拖到左栏、空分组作为落点、拖到边缘自动滚动。逐项确认 `data.json`。

## 阶段 5：样式与主题

`src/style.css` 加 `.is-dragging`、`.drag-ghost`、`.drop-marker`、`.is-drop-target`、`body.is-dragging`。全部走现有变量：`--task-bg`、`--task-border`、`--task-radius`、`--accent`、`--accent-soft`、`--shadow-panel`、`--duration-fast`、`--ease-out`。

验证：十套主题下各拖一次，重点看「方块世界」「石木村庄」「下界岩浆」这三套 —— 它们的圆角归零、字号只有 12 / 24 两档，写死的像素值会破相。

## 阶段 6：接线、验证与文档

1. `src/events.js`：装配拖拽层、`Esc` 取消分支（拖动中吞掉这次按键，不再往下传）。
2. `src/render.js`：缩略图 `img` 加 `draggable="false"`。
3. `src/events.js`：装配 `createDragLayer`（装配点在这里，`app.js` 不动）。
4. 跑设计文档第 6.2 节十二项与第 6.3 节两项。
5. README：功能清单加拖拽；目录结构加 `src/dragdrop.js`；把「降平视图下不可拖拽」「面板布局靠拖到左栏换组」写进已知限制。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 加上 HTML5 拖放，把文件拖放导入图片弄失效 | 保持 `dragDropEnabled` 默认值，全程用 Pointer Events；阶段 0 先验证这条前提 |
| 拖拽吃掉单击与双击编辑 | 5px 阈值；`pressed` 阶段不 `preventDefault`；阶段 6 专门验证第 7 项 |
| 缩略图的原生拖拽让手势中途断掉 | `draggable="false"`，并在阶段 0 确认症状确实存在 |
| 落点判定在长列表里抖动 | 占位条只在落点变化时才移动 DOM；`elementFromPoint` 每帧最多调一次（`pointermove` 里按 `requestAnimationFrame` 节流） |
| 浮层跟随有拖影 | 浮层用 `transform: translate3d()` 定位，不用改 `top` / `left` |
| 拖拽中途数据变化（提醒触发、更新下载完）导致行被重建 | 拖拽期间渲染层照常重建，但状态机只持有 `taskId` 与 DOM 引用；每次 `pointermove` 重新取占位条容器即可。渲染重建后若目标容器消失，取消这次拖拽 |
| 三套像素主题下浮层破相 | 阶段 5 逐主题过一遍，样式全走变量，不写死圆角与字号 |
| 多指同时按（触摸屏） | 只认第一个 `pointerId`，其余 `pointerdown` 直接忽略 |
| 拖到一半松手落在非法位置 | 没有落点就取消，不改数据；不做「插到最近位置」的猜测 |
| 降平视图下用户反复尝试拖动却没有反馈 | README 写明；若体验上确实难受，另做「移动到」入口（本期不做） |
