# sticky-todo 导出 Markdown 设计文档

日期：2026-09-29
状态：待实现

## 1. 背景与目标

数据全在本地，格式是纯 JSON。备份与迁移的办法是「复制整个数据目录」，这对程序本身够用，但 `data.json` 不是给人看的：想打印一份、贴进聊天窗口、或者搬到别的工具里，都得先手工整理。

### 目标

1. 一键把全部待办导出成 Markdown 文件，放在用户选定的位置。
2. 分组、勾选状态、到期时间、重复规则、图片张数都体现在文本里。
3. 生成文本是纯函数，可以单元测试。
4. 用户选择路径用系统原生保存对话框，取消时不写任何文件。

### 非目标

- 不做导入。导出的文本不打算再被程序读回来。
- 不做 CSV、JSON、HTML、PDF 等其它格式。
- 不导出图片文件本身，只在任务行上标注张数。
- 不做「只导出当前视图」或「只导出未完成」。一律导出全部任务。
- 不做导出内容的模板自定义。

## 2. 输出格式

```markdown
# 待办便签

导出时间：2026-09-29 16:04

## 工作

- [ ] 写设计文档 · 到期 09-30 09:00 · 每周 · 2 张图片
- [ ] 整理收件箱
- [x] 回复邮件 · 到期 09-28 09:00

## 生活

- [ ] 买牛奶
```

规则：

1. 标题固定为 `# 待办便签`，下面一行 `导出时间：` 加 `formatFullStamp` 的结果。
2. 每个分组一个 `## ` 小节。分组按 `sortGroups` 的顺序（`order` 升序，同序按名称）。
3. 组内任务按 `sortTasks(tasks, false)`：只按手动 `order`，忽略 `completedBottom` 设置。导出结果应当稳定，不随界面上的显示开关变化。
4. 同样忽略 `hideCompleted`：已完成的任务照常输出，用 `- [x]`。
5. 任务行开头是 `- [ ] ` 或 `- [x] `，接着是正文。
6. 元信息附在正文之后，用 ` · `（空格、中点、空格）分隔，顺序固定为：到期 → 重复 → 图片。
   - 到期：`到期 ` + `formatStamp(dueAt)`（同年省略年份，与界面一致）。
   - 重复：`repeatLabel(repeat)`，规则认不出来时不输出这一段。
   - 图片：`N 张图片`，`N` 为 `images` 长度，为 0 时不输出。
7. 空分组不输出小节。整个数据里没有任务时，只输出标题与导出时间。
8. `groupId` 指向已不存在的分组时，这些任务归到 `## 未命名` 小节，排在所有分组之后。
9. 正文里的换行（Shift + Enter 敲出来的）保留，续行缩进两个空格，使其留在同一个列表项里。
10. 正文不转义。自用工具，正文里出现 Markdown 元字符的概率低，转义会把可读性弄得更差。

## 3. 接口

### 3.1 纯函数

`model.js` 新增：

```js
export function toMarkdown(data, now = new Date()) -> string
```

只读 `data.groups` 与 `data.tasks`，不碰设置以外的任何东西，不碰 DOM。

### 3.2 后端命令

```rust
#[tauri::command]
async fn export_text(
    app: AppHandle,
    content: String,
    default_name: String,
) -> Result<Option<String>, String>;
```

流程：

1. 用 `app.dialog().file()` 打开原生保存对话框，`set_file_name(default_name)`，过滤器依次是 `Markdown (*.md)` 与 `文本 (*.txt)`。
2. 用户取消 → 返回 `Ok(None)`，不写文件。
3. 用户选了路径 → 以 UTF-8 无 BOM 写入，返回路径字符串。写失败时返回错误文案。

对话框的调用方式照抄 `pick_directory`：回调加 `std::sync::mpsc::channel`，命令是 `async` 的。

**为什么写文件在后端**：`capabilities/default.json` 只授了 `core:default`，前端没有文件系统权限；项目既有的约定写在那个文件里 —— 「所有文件操作都经由应用自身的命令完成」。保存对话框同样只能用 Rust 侧的 `tauri-plugin-dialog`，前端没有该插件的权限。

### 3.3 store

```js
async function exportMarkdown();
```

1. `toMarkdown(data)` 生成文本。
2. 默认文件名 `待办便签-YYYY-MM-DD.md`，日期取本地当天。
3. `invoke("export_text", { content, defaultName })`。
4. 返回路径时 toast `已导出到 <路径>`；返回 `null`（用户取消）时什么都不提示；抛错时 toast `导出失败：<原因>`。

不做「未保存的改动先落盘」这一步：导出的内容是内存里的当前状态，比磁盘上的新，这正是用户想导出的东西。

## 4. 界面

设置面板的「数据」分区里加一行，与孤儿附件清理并排：

- 按钮「导出为 Markdown」（`data-action="export-markdown"`）。
- 说明：`把全部分组与待办导出成一个 Markdown 文件，图片只记张数。`

导出过程中按钮置灰（`ui.exporting = true`），完成后恢复。

## 5. 测试策略

### 5.1 前端单元测试（`model.test.js`）

- 空数据 → 只有标题与导出时间两行。
- 分组顺序与组内顺序符合 `sortGroups` / `sortTasks`。
- 已完成任务输出 `- [x]`，未完成输出 `- [ ]`。
- 三种元信息各自的拼接；只有到期时不留多余的 ` · `。
- 重复规则认不出来（例如 `every:0:day`）时不输出重复段。
- 图片张数为 0 时不输出图片段，为 2 时输出 `2 张图片`。
- 正文含换行时续行缩进两个空格。
- 空分组不产生小节。
- 指向不存在分组的任务落在末尾的 `## 未命名` 里。
- `now` 参数决定导出时间的文本，测试里传固定时间。

### 5.2 Rust 单元测试

`export_text` 的对话框部分不可单测。把「写入文件」这一段拆出来：

```rust
pub fn write_text(path: &Path, content: &str) -> io::Result<()>
```

单测覆盖：正常写入、内容为中文时按 UTF-8 落盘、父目录不存在时报错。写入辅助函数与对话框命令一起放在 `src-tauri/src/lib.rs`，单独拆一个模块没有好处。

### 5.3 手动验证

1. 有中文与换行正文的数据 → 导出 → 用记事本打开，内容与预览一致、无乱码。
2. 保存对话框里点取消 → 不产生文件、不弹提示。
3. 导出到只读目录 → 报错提示，不静默失败。
4. 导出后把 `.md` 拖进任意 Markdown 阅读器 → 勾选框与列表层级正确。
5. 空数据（没有任何分组）→ 导出的文件只有两行，不报错。

## 6. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/model.js` | `toMarkdown` |
| `src/model.test.js` | 第 5.1 节的用例 |
| `src-tauri/src/lib.rs` | `export_text` 命令、`write_text` 与单测、注册命令 |
| `src/store.js` | `exportMarkdown`、`ui.exporting` |
| `src/render.js` | 设置面板「数据」分区的导出行 |
| `src/events.js` | `export-markdown` 分支 |
| `src/style.css` | 按钮与说明行样式 |
| `README.md` | 功能清单与数据存储一节 |

## 7. 待办清单（实现顺序）

1. `model.js` 的 `toMarkdown` 与 `model.test.js` 用例，跑 `npm test`。
2. `export_text` 命令与写入辅助函数、单测，跑 `cargo test`。
3. `store.js` 的 `exportMarkdown`。
4. `render.js` / `events.js` / `style.css`：设置面板里的入口。
5. 手动验证第 5.3 节。
6. README。
