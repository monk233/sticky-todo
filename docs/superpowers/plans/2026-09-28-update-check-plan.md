# sticky-todo 检查更新与自动更新实现计划

依据：[2026-09-28-update-check-design.md](../specs/2026-09-28-update-check-design.md)

完成定义：`cargo test` 与 `npm test` 全绿，端到端验证覆盖「检查 → 下载 → 校验 → 覆盖自身 → 重启」，两条失败路径（校验不过、目录只读）行为符合设计，README 与版本号同步。

## 阶段 1：`update.rs` 的纯函数

新增 `src-tauri/src/update.rs`，先只写不碰网络、不碰进程的部分：

1. `compare_versions(current, remote) -> Ordering`：逐段数值比较，缺段补 0，非数字段按 0，`v` 前缀去掉。
2. `ReleaseInfo` 结构与 `parse_release(json: &str) -> Result<ReleaseInfo, UpdateError>`：读 `tag_name`、`body`、`assets` 里名为 `sticky-todo.exe` 的 `browser_download_url` / `size` / `digest`。
3. `sha256_in_digest(digest: Option<&str>) -> Option<String>`：把 `sha256:abc…` 拆成裸十六进制。
4. `build_install_script(new_exe, target_exe, result_file, pid) -> String`：生成 cmd 脚本内容，路径一律加双引号。
5. `parse_install_result(text: &str) -> InstallOutcome`：`ok` / `failed:原因` / 空 / 解析不出来。

`src-tauri/src/update.rs` 内联单元测试覆盖设计文档第 8.1 节列出的每一类输入。

验证：`cargo test` 通过，新增用例在列表里可见。

## 阶段 2：网络、下载与安装

继续写 `update.rs` 的副作用部分：

1. `check(endpoint, current_version) -> Result<Option<ReleaseInfo>, UpdateError>`：`ureq` GET，超时 15 秒，404 视为「没有发布」而不是错误。
2. `download(url, dest_part, expected_sha, on_progress)`：流式写入 `.part`，边写边算 SHA-256，边回调进度；校验不过就删除文件并返回错误。
3. `install(new_exe, target_exe, result_file)`：复制到 `%TEMP%`、写脚本、`cmd /c` 无窗口启动。
4. `update_dir(data_dir) -> PathBuf`、`cleanup_partials(dir)`、`read_last_result(dir)`、`clear_last_result(dir)`。
5. `Cargo.toml` 加 `ureq`（rustls）；记录编译时间与产物体积增量。

`config.rs` 加 `auto_check_update: bool`（默认 `true`）与读写；`lib.rs` 加 `get_update_prefs` / `set_auto_check_update` 命令。

验证：`cargo test` 通过；实测一次真实 GitHub 请求（当前版本 1.3.0、远端 v1.1.0）应得到「已是最新」的结论。

## 阶段 3：命令与启动行为

`lib.rs`：

1. 注册 `check_update`、`download_update`、`install_update`、`open_releases_page`，进度通过 `app.emit("app://update-progress", …)` 上报。
2. 启动时：清理 `updates/` 里的 `.part`；读 `last-install.txt`，`failed:` 时把内容塞进 `get_bootstrap` 的返回值（或单独命令）供前端提示。
3. 托盘菜单加「检查更新」，点击后向前端发 `app://check-update` 事件。
4. `open_releases_page` 用 `cmd /c start` 打开 Release 页（不新增插件）。

验证：`cargo test` 通过；`cargo build --release` 成功，体积增量记录在案。

## 阶段 4：前端

1. `store.js`：`ui.update = { status, current, remote, progress, path, verified, error, checkedAt, autoCheck }`；`checkUpdate()`、`downloadUpdate()`、`installUpdate()`、`setAutoCheck(bool)`、`openReleases()`；监听 `app://update-progress`。
2. 自动检查排期：`init()` 里延迟 8 秒首查，之后 `setInterval` 6 小时；开关关闭时清掉定时器。
3. `render.js`：设置面板「更新」分区（当前版本、自动检查开关、检查按钮、状态行、更新并重启、打开 Releases 页）；侧栏设置图标上的小圆点。
4. `events.js`：`check-update`、`download-update`、`install-update`、`open-releases`、`toggle-auto-check` 分支。
5. `icons.js` 加 `refresh`、`download`；`style.css` 加对应样式（走现有变量）。

验证：`npm test` 通过；`npm run dev`（或 harness）里手动走一遍界面，状态行各阶段文案正确。

## 阶段 5：端到端验证

写 `.ui-check/mock-update-server.js`：按 `STICKY_TODO_UPDATE_ENDPOINT` 的约定返回一份假的 `releases/latest` JSON，并托管一个「新版本 exe」文件（就用当前构建产物，摘要按真实值给）。

验证项：

1. 正常路径：应用到目录 A，mock 源给出更高版本 → 界面出现「更新并重启」→ 点击 → 进程退出 → 脚本替换 → 新 exe 启动 → 版本号变成新版本。
2. 校验失败：mock 源故意给错摘要 → 下载后删除文件、状态行报错、不执行替换。
3. 只读目录：把 exe 放进只读目录再触发更新 → 替换失败 → 重启后出现「请手动替换」提示，原 exe 仍可运行。
4. 离线：把端点指向一个不存在的地址 → 只记录失败原因，不弹窗。
5. 开关：关掉自动检查后启动不再自动请求（用 mock 服务器的请求日志确认）。

## 阶段 6：文档与交付

1. README：功能清单加「检查更新与自动更新」；说明更新来自 GitHub Releases、校验只防损坏不防篡改、放在只读目录时无法自动替换。
2. 版本号 1.3.0 → 1.4.0（`package.json`、`Cargo.toml`、`tauri.conf.json`）。
3. `cargo build --release`，记录新体积。
4. 提交，之后由用户决定是否 push 并打 tag 触发 CI 发布。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 自替换把程序弄成打不开 | 脚本用 `move /y` 覆盖而不是先删；原 exe 在失败时保持不动；失败写 `last-install.txt` 并在下次启动提示 |
| 更新后版本号没变导致反复提示 | CI 加「tag 与 `Cargo.toml` 版本一致」的检查 |
| `ureq` 让产物体积明显变大 | 阶段 2 实测；超过 300 KB 就改用「前端 fetch + IPC 传字节」的备选方案 |
| 国内网络访问 GitHub 不稳 | 检查失败静默降级并显示原因；设置面板提供「打开 Releases 页面」的手动兜底 |
| 更新打断正在输入的正文 | 只在用户点击后替换；下载阶段不弹窗、不夺焦点 |
| 数据目录在同步盘里，`.part` 被同步出去 | 下载与安装的中间文件都写在 `updates/` 并由启动清理；替换用的临时 exe 放 `%TEMP%` |
