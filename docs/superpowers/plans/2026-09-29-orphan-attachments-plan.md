# sticky-todo 孤儿附件清理实现计划

依据：[2026-09-29-orphan-attachments-design.md](../specs/2026-09-29-orphan-attachments-design.md)

前置：无。与其余三项没有代码交集，只碰设置面板与一个新的 Rust 模块。

完成定义：`cargo test` 与 `npm test` 全绿；设计文档第 6.3 节的五项手动验证通过；README 的数据存储一节写明入口与「删除不可恢复」。

## 阶段 1：扫描（`attachments.rs`）

新增 `src-tauri/src/attachments.rs`：

```rust
pub struct OrphanFile { pub name: String, pub size: u64 }
pub struct OrphanScan { pub orphans: Vec<OrphanFile>, pub total_bytes: u64, pub skipped: usize }

fn file_names_of(keep: &[String]) -> HashSet<String>;
pub fn scan(data_dir: &Path, keep: &[String]) -> io::Result<OrphanScan>;
```

`file_names_of` 只取路径的最后一段并统一小写：`attachments/abc.png`、`attachments\abc.png`、`./attachments/abc.png` 都归到 `abc.png`。它只是内部辅助，不导出。

`scan` 只走 `attachments/` 的直接子项：目录不存在返回空结果；扩展名不在 `images::ALLOWED_EXTENSIONS` 里的文件与子目录计入 `skipped`；结果按名字排序。

单测覆盖设计文档第 6.1 节里属于扫描的部分。

验证：`cargo test` 通过。

## 阶段 2：删除（`attachments.rs`）

```rust
pub struct FailedFile { pub name: String, pub reason: String }
pub struct DeleteReport { pub deleted: usize, pub freed_bytes: u64, pub failed: Vec<FailedFile> }

pub fn is_safe_name(name: &str) -> bool;
pub fn delete(data_dir: &Path, keep: &[String], names: &[String]) -> io::Result<DeleteReport>;
```

四层校验按设计文档第 3.2 节的顺序做，任一层不过就记进 `failed` 并继续下一个。目标路径拼完后用 `Path::parent` 复核父目录是否就是 `attachments/`，不依赖字符串判断。

单测覆盖：路径穿越的名字、在 `keep` 里的名字、不存在的名字、部分失败时的统计、`freed_bytes` 与实际体积一致。

验证：`cargo test` 通过。

## 阶段 3：命令与 store

1. `src-tauri/src/lib.rs`：`mod attachments;`、两条命令、加进 `generate_handler!`。
2. `src/store.js`：`ui.orphans` 状态对象（设计文档第 4 节）、`scanOrphans()`、`deleteOrphans()`、二次确认的 3.2 秒计时器。
3. `keep` 的算法：`data.tasks.flatMap((task) => task.images ?? [])` 去重。

验证：`cargo build` 通过；在界面之外先手动调一次两条命令（harness 或临时按钮）。

## 阶段 4：界面

1. `src/render.js`：设置面板里新增「数据」分区，含说明、检查按钮、三种结果状态、两步删除按钮。
2. `src/events.js`：`scan-orphans` / `delete-orphans` 分支。
3. `src/style.css`：结果行、危险按钮（`--danger` / `--danger-soft`）、尺寸文本用 `--text-sm` / `--text-faint`。

验证：`npm test` 无回归；界面里把三种结果状态各走一遍。

## 阶段 5：体积格式化

`src/model.js` 加 `formatBytes(bytes)`，`src/model.test.js` 覆盖 0 / 1023 / 1024 / 1 MB / 1 GB 五个边界。

验证：`npm test` 通过。

## 阶段 6：手动验证与文档

跑设计文档第 6.3 节五项。

README：数据存储一节补上「删任务不删图片，可在设置里清理未引用的图片；清理不可恢复」。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 误删被其它任务共享的图片 | 引用集合取自全量任务而不是某一条；删除前再验一次 `keep`，过期确认过的名字会被拒 |
| 路径穿越删到数据目录外的文件 | 名字白名单（无分隔符、扩展名受支持）+ 拼完后用 `Path::parent` 复核 |
| 扫描到删除之间用户又建了引用 | 删除命令带 `keep` 并在每个文件上重验，杜绝 TOCTOU |
| 一次点击就删，误触代价大 | 两步确认 + 3.2 秒自动回退，与 `deleteGroup` 一致 |
| 大批文件删除中途失败 | 逐个处理，失败记原因不中断，界面显示失败条数 |
| 数据目录在同步盘里，删除会同步出去 | 界面文案写明删除不可恢复；这是用户自己的取舍，程序不额外备份 |
| `formatBytes` 在 0 字节时报 NaN | 单测里显式覆盖 0 |
| 界面把「跳过」的数量显示成 0 时仍然占一行 | 仅在 `skipped > 0` 时渲染那一行 |
