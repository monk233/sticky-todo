# sticky-todo 标签、搜索与视图实现计划

依据：[2026-09-26-tags-search-views-design.md](../specs/2026-09-26-tags-search-views-design.md)

完成定义：`npm test` 与 `cargo test` 全绿，spec 第 8.3 节的十条手动验收逐条通过，README 与版本号同步更新。

## 阶段 0：基线

1. 在仓库根目录执行 `npm test`，确认现有用例全绿。
2. 在 `src-tauri` 执行 `cargo test`，确认现有用例全绿。

任何一条基线不通过，先查清原因再开工，避免把既有问题算到本次改动上。

验证：两条命令的失败数为 0。

## 阶段 1：后端字段与版本

改动 `src-tauri/src/store.rs`：

1. `Task` 结构新增 `#[serde(default)] pub tags: Vec<String>`，放在 `images` 之后。
2. `CURRENT_VERSION` 由 1 改为 2。
3. 修掉因新增字段而编译失败的结构体字面量（测试里的 `Task { .. }` 构造点）。
4. 新增测试 `tags_survive_a_round_trip`：手工写入一份带 `tags` 的 `data.json`，`load` 之后 `save`，再读文件断言 `tags` 与内容都在。
5. 新增测试 `missing_tags_reads_as_empty`：写入不含 `tags` 的任务，断言读出来是空 `Vec`，且再保存不报错。

验证：`cargo test` 全绿；新增两个用例在列表中可见。

## 阶段 2：model.js 纯函数与投影扩展

改动 `src/model.js`：

1. `createEmptyData()` 的 `version` 改为 2。
2. 新增 `resolveView(ui)`：只接受 `group` / `all` / `untagged` / `tag` 四种，`tag` 缺少标签名时回落 `{ kind: "group", tag: "" }`。
3. 新增 `matchTask(task, query)`：`query` 去空白后为空返回 true，否则匹配 `text` 与 `tags` 的子串，大小写不敏感。
4. 新增 `tagCounts(state)`：返回 `Map<标签, 未完成数>`，任务内重复标签只计一次。
5. 新增 `highlight(text, query)`：返回 `[{ text, hit }]`，搜索词按字面量处理（不走正则），空搜索词返回单个非命中片段。
6. 新增 `visibleTasks(state, view, query)`：按视图与搜索词过滤，排序为「分组 order → 组内 sortTasks」，返回 `[{ task, groupName }]`；`hideCompleted` 与 `completedBottom` 叠加生效。
7. 新增 `renameTagInTasks(tasks, from, to, timestamp)` 与 `removeTagFromTasks(tasks, from, timestamp)`：返回新数组，不改入参；替换后同任务内去重；改动的任务写入 `timestamp`；无改动时返回浅拷贝。
8. 扩展 `buildView(state, ui)`：新增 `view`、`query`、`flat`、`flatTasks`、`flatTitle`、`tags`、`viewItems`，现有字段语义不变。

改动 `src/model.test.js`：按 spec 第 8.1 节补齐用例，重点覆盖
`resolveView` 的回落、`matchTask` 的大小写与空词、`visibleTasks` 的三种视图与设置叠加、
`tagCounts` 的重复标签、`highlight` 的首中尾命中与正则元字符、两个批量函数的不改入参与去重。

验证：`npm test` 全绿，新用例逐一通过。

## 阶段 3：store.js 状态与动作

改动 `src/store.js`：

1. `ui` 新增 `view`（默认 `{ kind: "group", tag: "" }`）、`query`、`tagDraft`、`tagEditorTaskId`、`editingTag`、`tagMenu`。
2. `normalizeData` 给每个任务补 `tags: Array.isArray(task.tags) ? task.tags : []`。
3. 新增 `setView(view)`：写入归一化后的视图，把 `cursorTaskId` 设成该视图可见列表的第一条，清空 `editingTaskId` 与 `tagMenu`，并触发渲染。
4. 新增 `setQuery(text)`：写入 `ui.query`，把 `cursorTaskId` 收敛到当前可见结果的第一条或 null。搜索词不进入持久化。
5. 新增 `setTagDraft(text)`、`openTagEditor(taskId)`、`closeTagEditor()`（关闭时清空草稿）。
6. 新增 `addTag(taskId, name)`：去空白、忽略空值、跳过重复，写入后更新 `updatedAt`、`scheduleSave`、保持输入行打开。
7. 新增 `removeTag(taskId, tag)`：从该任务移除，更新 `updatedAt`。
8. 新增 `renameTag(from, to)`：调用 `renameTagInTasks`，替换结果整体写回 `data.tasks`，`scheduleSave` 并给出提示。
9. 新增 `deleteTag(tag)`：调用 `removeTagFromTasks`，写回后提示影响了多少条任务。
10. 新增 `openTagMenu(tag, x, y)`、`closeTagMenu()`；菜单的二次确认状态放在 `ui.tagMenu.confirming`。
11. `cycleTask(delta)` 改为在 `visibleTasks` 的结果上循环，不再按 `activeGroupId` 过滤。
12. 新增 `startRenameTag(tag)`、`commitRenameTag(tag, value)`（供侧栏内联编辑使用，语义比照现有的分组重命名）。
13. 导出以上全部新方法。

验证：`npm run dev` 启动后无控制台报错；此时新函数尚未接线，界面行为应与改动前一致。

## 阶段 4：render.js

改动 `src/render.js`：

1. 重写 `renderSidebar`：品牌行 → 搜索框（`data-action="search"`，值取 `view.query`）→ 固定视图项（`data-action="select-view"`）→ 分组区段（标题 + 添加分组 + 现有分组项）→ 标签区段（没有标签时不渲染）→ 底栏只留设置入口。
2. 新增 `renderFlatWorkspace(view, ctx)`：单列、标题取 `view.flatTitle`、按 `view.flatTasks` 渲染，空结果给出对应文案。
3. 扩展 `renderTask`：正文按 `highlight` 结果拼接文本节点与 `<mark>`；降平时显示分组徽章；显示标签胶囊（`data-action="select-tag"`）与移除按钮（`data-action="remove-tag"`）；工具区新增标签按钮（`data-action="add-tag"`）；`ui.tagEditorTaskId` 匹配时在正文下方渲染标签输入行（`data-action="tag-editor"`，值取 `ui.tagDraft`）。
4. 新增 `renderTagMenu(ctx)`：`ui.tagMenu` 非空时渲染浮层，两个动作项，删除项按 `confirming` 切换文案。
5. 侧栏标签项在 `ui.editingTag` 匹配时渲染内联输入框（`data-action="tag-rename-editor"`）。
6. `renderApp` 在 `view.flat` 为真时走扁平列表分支。
7. 启用「隐藏任务操作按钮」时，标签胶囊不出移除按钮，标签按钮同样隐藏。

验证：`npm run dev` 下能看到视图列表、搜索框、标签胶囊；`npm test` 无回归。

## 阶段 5：events.js

改动 `src/events.js`：

1. `handleClick` 的 switch 补入：`select-view`、`select-tag`、`add-tag`、`remove-tag`、`tag-menu-rename`、`tag-menu-delete`、`tag-rename-editor`、`search`、`tag-editor`（后两者与现有 `editor` 一样直接 return）。
2. 新增 `contextmenu` 委托：命中带 `data-tag` 的标签项时 `preventDefault` 并打开菜单，其余位置关闭菜单。
3. 新增 `input` 委托：`data-action="search"` 调 `setQuery`，`data-action="tag-editor"` 调 `setTagDraft`。
4. `handleKeyDown` 的输入框分支补入两种新输入框：搜索框内 `Esc` 清空搜索词并移出焦点；标签输入行内 `Enter` 提交标签并清空草稿、`Esc` 关闭输入行。
5. 新增 `Ctrl + F`：聚焦搜索框并全选。
6. 通用焦点记忆：`beforeRender` 记录 `document.activeElement` 的 `{ action, id, start, end }`（只处理 `search` 与 `tag-editor`），`afterRender` 按 `[data-action][data-id]` 找回并恢复选区；任务编辑器与分组名输入框的既有逻辑不动。
7. `SCROLLABLE` 选择器加入侧栏新的滚动容器。
8. 点击侧栏以外区域时关闭标签菜单；菜单打开时按 `Esc` 先关菜单。

验证：`npm run dev` 下连续输入不会被夺焦；`Ctrl + F` 可用；搜索框内 `Esc` 清空；标签输入行 `Enter` 后输入框清空且保持焦点；右键标签弹出菜单，点外部与 `Esc` 都能关。

## 阶段 6：style.css

改动 `src/style.css`：新增侧栏搜索框、区段标题、视图项、标签项、标签胶囊、分组徽章、扁平列表、标签输入行、右键菜单、`mark` 的样式。颜色与尺寸一律取自现有变量，不写死颜色。

验证：

1. 十套主题 × 明暗两种模式逐套目视，检查标签胶囊、分组徽章、命中高亮、菜单浮层的对比度。
2. 窗口拉到最小宽度 340px，侧栏不破版、不出现横向滚动条。
3. 面板与列表两种布局各看一遍。

## 阶段 7：文档、版本与验收

1. 更新 `README.md`：功能清单补标签、搜索与视图；快捷键表补 `Ctrl + F`；数据存储一节补 `tags` 字段与版本说明；主题无关的既有描述不动。
2. 逐条执行 spec 第 8.3 节的十条手动验收，记录结果。
3. 三处版本号由 1.1.0 提到 1.2.0：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。
4. 在 `src-tauri` 执行 `cargo build --release`，记录新产物体积；与 README 中的 4,118,528 字节对比，若变化超过 1% 就更新 README 的说明。

验证：`npm test`、`cargo test`、`cargo build --release` 全部成功；README 的描述与实际行为逐条对得上。

## 提交策略

每个阶段一个提交，沿用仓库现有的中文 conventional 前缀：

1. `feat: 任务支持标签字段，数据文件版本升到 2`
2. `feat: 视图与筛选的纯函数投影`
3. `feat: 视图、搜索与标签的状态与动作`
4. `feat: 侧栏视图列表、扁平列表与标签界面`
5. `feat: 搜索、标签的事件与焦点恢复`
6. `style: 标签与视图相关组件样式`
7. `docs: README 补齐标签与视图说明` 与 `chore: 版本号提升到 1.2.0`

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 全量重建 DOM 导致新增输入框失焦 | 阶段 5 的通用焦点记忆是专门对策；验收时在搜索框连续输入 30 个字符检查不丢焦点与光标 |
| 后端丢字段 | 阶段 1 先用测试锁住 `tags` 往返，后续任何阶段发现标签"自己消失"，先看这一层 |
| 中文输入法组字期间跳动 | 按 spec 先接受；若实测干扰明显，改成 `compositionend` 之后再过滤，作为独立小改动 |
| 扁平视图与光标语义不一致 | 阶段 3 就把 `cycleTask` 切到 `visibleTasks`，不要等阶段 6 才发现方向键跳到看不见的任务上 |
| 逐套主题下新组件对比度不足 | 阶段 6 的验证要求覆盖全部十套主题，不能只看默认主题 |
| 搜索每键全量投影的开销 | 按当前数据规模预期无感；若实测卡顿，再加一帧合并，不在本期实现 |
