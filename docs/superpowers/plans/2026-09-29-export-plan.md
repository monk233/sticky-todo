# sticky-todo 导出 Markdown 实现计划

依据：[2026-09-29-export-design.md](../specs/2026-09-29-export-design.md)

前置：无。与其余三项没有代码交集，只碰 `model.js` 的一个新纯函数、一条新命令与设置面板。

完成定义：`cargo test` 与 `npm test` 全绿；设计文档第 5.3 节的五项手动验证通过；README 的功能清单与数据存储一节更新。

## 阶段 1：文本生成

`src/model.js` 新增：

```js
export function toMarkdown(data, now = new Date());
```

按设计文档第 2 节的十条规则实现。几处实现要点：

- 复用现有的 `sortGroups` / `sortTasks` / `formatStamp` / `formatFullStamp` / `repeatLabel`，不要另写一份排序。
- 元信息先收集成数组再 `join(" · ")`，避免拼接出多余的 ` · `。
- 正文换行：`text.split(/\r?\n/)` 后首行接在 `- [ ] ` 之后，其余行前加两个空格，再用 `\n` 连起来。
- 整体用数组收集行，最后一次 `join("\n")`，不做反复的字符串相加。

`src/model.test.js` 覆盖设计文档第 5.1 节的十类用例，`now` 参数传固定时间。

验证：`npm test` 通过。

## 阶段 2：写文件与保存对话框

`src-tauri/src/lib.rs`：

1. `fn write_text(path: &Path, content: &str) -> io::Result<()>`：UTF-8 无 BOM 写入。
2. `#[tauri::command] async fn export_text(app, content, default_name) -> Result<Option<String>, String>`：
   照抄 `pick_directory` 的写法 —— `app.dialog().file()`，`set_file_name`，两个 `add_filter`，回调里 `std::sync::mpsc::channel` 回传。
   用户取消返回 `Ok(None)`；选中路径调 `write_text`，返回路径字符串。
3. 加进 `generate_handler!`。

`write_text` 的单测覆盖：正常写入、中文内容按 UTF-8 落盘、父目录不存在时报错。

验证：`cargo test` 通过；`cargo build --release` 成功，记录体积增量（预期可忽略，只有标准库的 `fs::write`）。

## 阶段 3：store 与界面

1. `src/store.js`：`ui.exporting`、`exportMarkdown()`（设计文档第 3.3 节），默认文件名 `待办便签-YYYY-MM-DD.md`（本地日期）。
2. `src/render.js`：设置面板「数据」分区里的导出行。
3. `src/events.js`：`export-markdown` 分支。
4. `src/style.css`：按钮与说明行样式。

验证：`npm test` 无回归；界面里导出一次，文件出现在选定位置。

## 阶段 4：手动验证与文档

跑设计文档第 5.3 节五项。其中第 4 项（拖进 Markdown 阅读器检查层级）优先用系统里的任意编辑器或预览器看一眼。

README：功能清单加「导出为 Markdown」；数据存储一节说明导出的是文本、不含图片文件。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 中文乱码 | 明确按 UTF-8 无 BOM 写入；单测里放一段中文内容并读回来比对 |
| 保存对话框在 async 命令里卡住线程 | 与 `pick_directory` 完全同构：回调 + `mpsc::channel` + `recv()` |
| 静默覆盖已有文件 | 交给系统原生保存对话框自带的覆盖确认，代码里不额外判断 |
| 导出内容与界面显示不一致 | 设计文档写明：导出忽略 `hideCompleted` 与 `completedBottom`，一律完整、按手动顺序 |
| 任务很多时文本拼接慢 | 收集成数组后一次 `join`，不用 `+=` 累加 |
| 正文里的 Markdown 元字符破坏结构 | 本期不转义，作为已知取舍写进 README；换行已按列表项缩进处理 |
| 导出时数据尚未落盘 | 导出的是内存里的当前状态，比磁盘新，这正是期望行为；不强制先 `flush()` |
| 用户在对话框里点了保存但目录只读 | `write_text` 返回错误，界面 toast「导出失败：<原因>」，不静默失败 |
