# sticky-todo 孤儿附件清理设计文档

日期：2026-09-29
状态：待实现

## 1. 背景与目标

图片按 SHA-256 内容哈希存进数据目录的 `attachments/`，任务只在 `images` 数组里记相对路径（`attachments/<哈希>.<扩展名>`）。删除任务、移除图片都只改 JSON，不碰磁盘上的文件。

这是有意的设计：同一张图可能被多条任务引用（哈希相同就复用同一个文件），删任务时顺手删文件会连带毁掉别处的图。代价是 `attachments/` 只增不减 —— 导入过又删掉的任务，图片会永久留着，用户只能手动进目录对比。原设计文档（2026-09-23）把这一点写成「删除任务时不做附件垃圾回收；后续可另加『清理孤儿附件』功能」，本设计就是那一步。

### 目标

1. 找出 `attachments/` 里不再被任何任务引用的图片。
2. 删除前先给出清单与占用体积，用户确认后才真删。
3. 删除过程逐个进行，单个文件失败不影响其余的，失败原因回报到界面。

### 非目标

- **不做自动清理。** 启动时或删除任务时后台静默删文件，误删无法挽回；判断引用要扫全量任务，放在删除路径上也不划算。
- 不把文件移进系统回收站。需要额外依赖，本期直接删除，界面上明确告知不可恢复。
- 不清理 `updates/`、`themes/` 或数据目录下的其它内容。范围只有 `attachments/`。
- 不做「导出孤儿文件到别处」或「打包备份」。
- 不处理子目录。`attachments/` 下的子目录整块跳过。

## 2. 谁来判断「孤儿」

磁盘事实在后端，引用事实在前端（只有前端持有完整的 `data.tasks`）。分工：

- 前端把自己知道的引用集合传给后端：`data.tasks.flatMap((task) => task.images ?? [])`，去重后是形如 `attachments/abc.png` 的字符串数组。
- 后端扫描 `attachments/` 目录，把每个文件名还原成同样的相对路径形式，与引用集合求差集。

不让后端解析 `data.json`：后端要的是「当前内存里的引用」，而内存里的状态可能还没落盘（`save_data` 有 300 毫秒防抖），读文件会读到旧数据。

不让前端判断文件是否存在：前端没有文件系统权限。

## 3. 后端

新增 `src-tauri/src/attachments.rs`，与 `images.rs` 并列，只依赖文件系统，可单测。

两条命令。

### 3.1 扫描

```rust
pub struct OrphanFile {
    pub name: String,   // 只有文件名，例如 "abc.png"
    pub size: u64,
}

pub struct OrphanScan {
    pub orphans: Vec<OrphanFile>,
    pub total_bytes: u64,
    pub skipped: usize, // 跳过的非图片文件数
}

#[tauri::command]
fn scan_orphan_attachments(
    state: State<'_, AppState>,
    keep: Vec<String>,
) -> Result<OrphanScan, String>;
```

规则：

- `attachments/` 不存在时返回空的 `OrphanScan`，不报错。
- 只处理扩展名在 `images::ALLOWED_EXTENSIONS` 里的文件。其它文件既不算孤儿也不删除，计入 `skipped`。
- 子目录整块跳过，也计入 `skipped`。
- 引用集合先归一化再比对：`\` 换成 `/`，去掉前导 `./`，大小写不敏感（Windows 上文件系统不区分大小写，哈希与扩展名本身已在导入时规范成小写）。
- 结果按文件名排序，让界面上的顺序稳定。

### 3.2 删除

```rust
pub struct DeleteReport {
    pub deleted: usize,
    pub freed_bytes: u64,
    pub failed: Vec<FailedFile>, // { name, reason }
}

#[tauri::command]
fn delete_orphan_attachments(
    state: State<'_, AppState>,
    keep: Vec<String>,
    names: Vec<String>,
) -> Result<DeleteReport, String>;
```

逐个文件处理，任一文件不通过校验就记进 `failed` 并继续下一个，不中断整批：

1. 名字安全检查：非空、不超过 255 字节、不含 `/` 与 `\`、不是 `.` 或 `..`、扩展名在白名单里。这一层挡住 `..\..\data.json` 这类构造。
2. 目标路径的父目录必须就是 `attachments/`（拼完后用 `Path::parent` 复核，不依赖字符串判断）。
3. 文件必须存在。
4. **名字必须确实不在 `keep` 里。** 这条是给「扫描到删除之间数据变了」兜底的：用户确认的是扫描时看到的那批文件，删除时再验一次，避免多删。
5. 删除并累加 `freed_bytes`。失败（占用中、权限不足）记 `reason`。

`names` 为空时直接返回零值报告。

## 4. 界面

设置面板里新增一个「数据」分区，与「显示」「外观」并列（`section.settings__group` + `h3`）。

分区内容：

- 一行说明：「图片删掉任务后仍留在数据目录里，可以在这里清理不再被引用的那些。」
- 按钮「检查未引用的图片」（`data-action="scan-orphans"`）。

点完按结果分三种样子：

| 结果 | 界面 |
| --- | --- |
| 没有孤儿 | 「没有未引用的图片。」，按钮回到可点状态 |
| 有孤儿 | 「发现 N 个未引用的图片，共 X MB。」+ 「删除这些文件」+「重新检查」 |
| 失败 | 错误文案，按钮回到可点状态 |

删除按钮沿用「点两次」的确认模式（和 `deleteGroup` 一致）：第一次点变「再点一次确认删除」，3.2 秒内没有第二次点击就退回原状。第二次点击才真正调用删除命令。

跳过的非图片文件在结果行下面补一句「另有 N 个文件不是图片，已跳过。」（仅在 `skipped > 0` 时出现）。

删除完成后 toast：`已清理 N 个文件，释放 X MB。`；有失败项时改为 `已清理 N 个文件，M 个失败。` 并附第一条失败原因。

### ui 状态

```js
ui.orphans = {
  status: "idle", // idle | scanning | ready | deleting
  files: [],      // [{ name, size }]
  totalBytes: 0,
  skipped: 0,
  confirming: false,
  error: "",
};
```

`confirming` 的 3.2 秒回退计时器与 `deleteGroup` 用同一套写法。

## 5. 数据量展示

`model.js` 加纯函数 `formatBytes(bytes)`：按 KB / MB / GB 取一位小数，`< 1024` 字节显示为 `N B`。放 model 是为了可单测，与 `formatStamp` 同一层。

## 6. 测试策略

### 6.1 Rust 单元测试（`attachments.rs`）

- 目录不存在时扫描返回空，不报错。
- 全部文件都被引用 → 孤儿数为 0。
- 部分被引用 → 只列出未引用的那些，`total_bytes` 等于它们之和。
- 同一张图被两条任务引用 → 仍然算被引用。
- 非图片扩展名（`.txt`、`.db`）与子目录被跳过并计入 `skipped`。
- 引用路径写成 `attachments\abc.png` 或 `./attachments/abc.png` 时仍能匹配上。
- 删除：`..\..\data.json`、`a/b.png`、`..`、空字符串全部被拒，且目标文件不受影响。
- 删除：名字在 `keep` 里时被拒（`failed` 里带原因），文件仍在磁盘上。
- 删除：不存在的名字记入 `failed`，同批次其它文件照常删除。
- 删除：`freed_bytes` 等于实际删掉的文件体积之和。

### 6.2 前端单元测试

`model.test.js` 覆盖 `formatBytes` 的边界：0、1023、1024、1 MB、1 GB。

### 6.3 手动验证

1. 导入两张图，删掉其中一条任务 → 检查 → 只列出那一张的哈希文件。
2. 同一张图挂在两条任务上，删掉其中一条 → 检查 → 不列出它。
3. 点两次删除 → 文件消失，`data.json` 与其它任务不受影响。
4. 二次确认不点第二次、等 3.2 秒 → 按钮退回原状，文件还在。
5. 用别处的任务引用被删掉的那张图（手改 `data.json` 造出「引用了不存在的文件」的状态）→ 界面显示裂图，但不影响清理流程本身。

## 7. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/attachments.rs` | 新增：扫描、删除、名字校验与单测 |
| `src-tauri/src/lib.rs` | 注册两条命令 |
| `src/model.js` | `formatBytes` |
| `src/model.test.js` | `formatBytes` 用例 |
| `src/store.js` | `scanOrphans` / `deleteOrphans`、`ui.orphans` |
| `src/render.js` | 设置面板的「数据」分区 |
| `src/events.js` | `scan-orphans` / `delete-orphans` 分支 |
| `src/style.css` | 分区的结果行与危险按钮样式 |
| `README.md` | 数据存储一节补上清理入口与「不可恢复」的说明 |

## 8. 待办清单（实现顺序）

1. `attachments.rs`：扫描与删除两条路径 + 单测，`cargo test`。
2. `lib.rs` 注册命令；`store.js` 状态与两个方法。
3. `render.js` / `events.js` / `style.css`：设置面板里的分区与两步确认。
4. `model.js` 的 `formatBytes` 与用例。
5. 手动验证第 6.3 节。
6. README。
