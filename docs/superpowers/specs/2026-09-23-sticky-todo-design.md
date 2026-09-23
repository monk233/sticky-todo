# sticky-todo 设计文档

日期：2026-09-23
状态：已与用户确认

## 1. 背景

现有商业待办软件存在两个问题：需要付费；待办事项不支持添加图片。本项目要实现一款自用的轻量级桌面便签／待办清单软件，替代现有工具，并把数据完全交还给用户（本地纯文本、可自由同步备份）。

## 2. 目标与非目标

### 2.1 目标

1. 桌面端软件，产物体积以 MB 计，越小越好。
2. 支持窗口置顶；支持自定义数据目录；支持自定义待办分组；数据格式简单，方便同步与备份。
3. 待办事项支持勾选完成状态，并显示创建时间与更新时间。
4. 支持多布局展示；支持快捷键操作；支持隐藏已完成任务；支持已完成任务置底；支持隐藏任务操作按钮。
5. 界面美观、布局合理，简约大气；支持明／暗／跟随系统三种主题。
6. 使用 git 初始化项目。

### 2.2 非目标（本期明确不做）

- 不生成 NSIS／MSI 安装包，只交付单文件可执行程序。
- 删除任务时不做附件垃圾回收；后续可另加“清理孤儿附件”功能。
- 不做任务拖拽排序，改用上移／下移操作。
- 不做提醒通知、周期性重复任务、多窗口。
- 切换数据目录时不做数据自动搬迁，只切换指向。
- 不做历史数据导入。

## 3. 技术选型

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 外壳 | Tauri v2 | 使用系统 WebView2，不打包浏览器内核，产物可压到数 MB |
| 后端 | Rust（edition 2021） | Tauri v2 的运行前提 |
| 前端 | 原生 HTML／CSS／JavaScript，ES module 多文件 | 无框架、无构建步骤，产物最小、可读性最好 |
| 前端依赖 | 无运行时依赖；仅一个 devDependency `@tauri-apps/cli` | 避免 npm 依赖树膨胀 |
| 运行时插件 | `tauri-plugin-dialog`、`tauri-plugin-global-shortcut`、`tauri-plugin-autostart` | 分别用于选目录／选图片、全局快捷键、开机自启 |
| release 配置 | `opt-level="s"`、`lto=true`、`strip=true`、`panic="abort"`、`codegen-units=1` | 压缩产物体积 |

体积目标：release 单文件 exe 约 4-7MB。WebView2 运行时由 Windows 11 内置提供，不计入产物。

## 4. 目录结构

```
sticky-todo/
├─ .gitignore
├─ README.md
├─ package.json                     # 仅 devDependency: @tauri-apps/cli
├─ docs/superpowers/specs/2026-09-23-sticky-todo-design.md
├─ src/                             # 前端；tauri.conf.json 的 frontendDist 指向此处
│  ├─ index.html
│  ├─ style.css
│  ├─ theme.js                      # 主题解析与应用
│  ├─ model.js                      # 纯数据投影：过滤、排序、计数、时间格式化
│  ├─ store.js                      # 唯一的可变状态持有者
│  ├─ render.js                     # 把投影结果渲染成 DOM，不含业务规则
│  ├─ events.js                     # 事件绑定与快捷键分发
│  ├─ icons.js                      # 内联 SVG 图标
│  └─ app.js                        # 入口装配
└─ src-tauri/
   ├─ Cargo.toml
   ├─ build.rs
   ├─ tauri.conf.json
   ├─ capabilities/default.json
   ├─ icons/
   └─ src/
      ├─ main.rs                   # 二进制入口，调用 lib.rs
      ├─ lib.rs                    # 插件注册、命令注册、托盘、窗口事件
      ├─ config.rs                 # 应用级配置（仅 dataDir 一个字段）
      ├─ store.rs                  # data.json 的原子读写与校验
      └─ images.rs                 # 图片导入
```

## 5. 数据存储

### 5.1 位置

- **数据目录**：由用户在设置中自定义。默认值取系统应用数据目录下的 `sticky-todo` 文件夹。目录内含 `data.json` 与 `attachments/` 两个条目。
- **应用配置目录**：系统应用配置目录下的 `config.json`，该文件只记录一个字段 `dataDir`。它不随数据同步，因为它描述的是“本机数据在哪”。

因此“备份／同步”的操作定义是：复制整个数据目录。

### 5.2 data.json 结构

```json
{
  "version": 1,
  "settings": {
    "layout": "panel",
    "theme": "system",
    "alwaysOnTop": true,
    "closeToTray": true,
    "hideCompleted": false,
    "completedBottom": false,
    "hideActions": false,
    "showCreatedAt": true,
    "showUpdatedAt": true,
    "globalHotkeyEnabled": true,
    "globalHotkey": "Ctrl+Alt+N"
  },
  "groups": [
    { "id": "g1", "name": "待处理", "order": 0 }
  ],
  "tasks": [
    {
      "id": "t1",
      "groupId": "g1",
      "text": "候选列表的筛选机制有问题",
      "done": false,
      "order": 0,
      "createdAt": "2026-09-23T14:04:00.000Z",
      "updatedAt": "2026-09-23T14:04:00.000Z",
      "images": ["attachments/9f2c1a8b4e6d.png"]
    }
  ]
}
```

约定：

- `layout` 取值 `panel` 或 `list`；`theme` 取值 `light`、`dark` 或 `system`。
- 时间一律存 UTC ISO8601 字符串，展示时转本地时区。
- `updatedAt` 在文本变更、完成状态变更、图片增删时更新；`createdAt` 不变。
- `images` 存相对数据目录的路径，使用正斜杠。
- `order` 为分组内／分组间的排序键，整数，允许重排后整体重编号。
- 加载时按 `version` 做迁移判断。当前只有版本 1，遇到更高版本拒绝写入并提示。
- 反序列化时使用 `#[serde(default)]`，缺失字段取默认值，保证旧文件可读。
- 未识别的额外字段在保存时保留（前端用原始对象展开，后端用 `serde_json::Value` 透传未知顶层字段）。

### 5.3 写入策略

- 原子写：先写同目录下 `data.json.tmp`，`fsync` 后 `rename` 覆盖 `data.json`。
- 前端在状态变更后 300ms 防抖调用 `save_data`。
- 保存失败时前端弹出提示，保留内存状态不丢，下一次变更重试。
- 首次运行且 `data.json` 不存在时，写入包含一个默认分组“待办”的空数据文件。

## 6. IPC 命令接口

前端不直接使用文件系统插件，所有文件操作都经由下列命令，capability 只授予这些命令所需的最小权限。

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `get_bootstrap` | 无 | `{ dataDir, defaultDataDir, appVersion }` | 启动时取初始信息 |
| `set_data_dir` | `path: string` | `{ dataDir }` | 切换数据目录；不搬迁数据；随后前端重新加载 |
| `load_data` | 无 | `{ state, warnings: string[] }` | 读文件、校验、补默认值；损坏时返回可读错误 |
| `save_data` | `state` | `{ savedAt }` | 原子写入 |
| `import_image` | `source: string` | `{ relPath: string }` | 按本地路径复制图片进 `attachments/`，内容哈希命名，已存在则复用 |
| `import_image_bytes` | `bytes: number[]`、`ext: string` | `{ relPath: string }` | 按字节写入，供剪贴板粘贴图片使用 |
| `open_data_dir` | 无 | 无 | 用系统文件管理器打开数据目录 |
| `get_autostart` | 无 | `bool` | 查询当前自启状态 |
| `set_autostart` | `enabled: bool` | 无 | 写入或移除自启项 |
| `set_global_hotkey` | `accel: string` | `{ ok: boolean }` | 重新注册全局快捷键；失败返回 `ok=false` |
| `set_always_on_top` | `enabled: bool` | 无 | 窗口置顶 |

## 7. 前端模块边界

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `model.js` | 纯函数：`view(state, uiState) => { groups, tasks, counts }`，负责过滤、排序、计数、时间格式化 | 无 |
| `store.js` | 持有唯一状态对象；提供增删改分组与任务的函数；防抖持久化；订阅变更通知 | 调用 IPC 命令 |
| `render.js` | 纯函数：接收 `model.js` 的投影结果与 `uiState`，输出 DOM；不含业务规则 | 不依赖 `store.js`，不发起 IPC |
| `events.js` | 事件委托绑定、快捷键分发、编辑态管理 | `store.js`、`render.js` |
| `theme.js` | 解析 `light`/`dark`/`system`，写入 `document.documentElement` 的 `data-theme`，监听 `prefers-color-scheme` | 无 |
| `icons.js` | 内联 SVG 字符串常量 | 无 |
| `app.js` | 启动装配：取 bootstrap、加载数据、首次渲染、注册全局监听 | 上述全部 |

`model.js` 与 `theme.js` 不接触 DOM 与 IPC，因此可以用 `node:test` 直接测试，不需要任何测试环境依赖。

## 8. 界面设计

### 8.1 面板布局（`layout = panel`）

- 左侧：分组侧栏。每项显示分组名与未完成任务数；底部有“添加分组”按钮与设置入口。
- 右侧：当前分组的任务列表。顶部为分组标题与操作按钮（新增任务、设置）。
- 任务行：复选框、文本、图片缩略图行、时间信息行、悬浮显示的操作按钮（编辑／删除）。
- 勾选态：文本加删除线并降低不透明度。

### 8.2 紧凑列表布局（`layout = list`）

- 单列。所有分组按 `order` 依次排列，每个分组是可折叠的标题栏 + 其下任务。
- 适合把窗口拉窄挂在桌面一侧。

### 8.3 设置面板

包含四组：

1. 显示：布局方式（面板／列表）、隐藏已完成任务、已完成任务置于底部、隐藏任务操作按钮、显示创建时间、显示更新时间。
2. 外观：主题（明／暗／跟随系统）。
3. 数据：数据目录路径显示、更改目录按钮、打开数据目录按钮。
4. 系统：窗口置顶开关、开机自启开关、关闭按钮隐藏到托盘开关、全局快捷键开关与当前按键显示。

### 8.4 窗口行为

- 窗口置顶由 `alwaysOnTop` 控制，默认开启。
- 托盘图标常驻，右键菜单含：显示／隐藏窗口、新建任务、新建分组、退出。
- 点击关闭按钮的行为由 `closeToTray` 控制：为 `true` 时隐藏到托盘，为 `false` 时退出进程。默认 `true`。

## 9. 快捷键

### 9.1 应用内（窗口聚焦时生效）

| 按键 | 功能 |
| --- | --- |
| `↑` | 上一个任务 |
| `↓` | 下一个任务 |
| `←` | 上一个分组 |
| `→` | 下一个分组 |
| `Ctrl + N` | 新建任务并进入编辑 |
| `Space` | 切换当前任务完成状态 |
| `Enter` | 进入编辑／确认编辑 |
| `Delete` | 删除当前任务 |
| `Esc` | 取消编辑／关闭设置面板 |

编辑态下不响应方向键与 `Space`，只有 `Enter`、`Esc` 生效。

### 9.2 全局

- 默认 `Ctrl + Alt + N`：显示窗口并聚焦新建任务输入框。
- 开关为 `globalHotkeyEnabled`；关闭时不注册该快捷键。
- 注册失败（被其它程序占用）时，命令返回 `ok=false`，设置面板显示“已被占用”提示；不阻断其它功能。

## 10. 图片支持

- 入口一：文件拖放。使用 Tauri 的 `onDragDropEvent` 拿本地路径，走 `import_image`。不使用 HTML5 `dataTransfer.files`，因为 WebView2 下拿不到可用的本地路径。
- 入口二：剪贴板粘贴（`Ctrl + V`）。用浏览器的 `clipboardData.files` 取到 `File` 对象，转成字节后走 `import_image_bytes`。
- 入口三：点击任务行的“添加图片”按钮，用 `dialog` 插件选文件，走 `import_image`。
- 处理：计算文件内容哈希，以 `<hash>.<ext>` 存入数据目录的 `attachments/`；若同名文件已存在则直接复用，不重复复制。
- 展示：任务行下方显示缩略图，限制高度；点击后在应用内放大预览。
- 限制：单文件上限 20MB，仅接受常见图片扩展名（png／jpg／jpeg／gif／webp／bmp）。超限或非图片返回错误提示，不写入。

## 11. 测试策略

### 11.1 Rust 单元测试（`cargo test`）

- `store.rs`：原子写在写入中断后原文件仍完整；损坏 JSON 返回可读错误而不 panic；`version` 高于当前时拒绝写入；缺失字段补默认值；未知顶层字段在往返后保留。
- `images.rs`：哈希命名稳定；重复内容复用同一路径；非法扩展名被拒；超过体积上限被拒；源文件不存在时返回错误。
- `config.rs`：`dataDir` 读写往返；配置文件损坏时回退到默认目录。

### 11.2 前端单元测试（`node --test`）

- `model.js`：过滤（隐藏已完成）、排序（已完成置底）、分组任务计数、时间格式化对 UTC 输入输出本地时间、空分组与空数据集的退化情况。
- `theme.js`：`system` 模式在 `prefers-color-scheme` 变化时切换 `data-theme`。

### 11.3 手动验收清单

逐条对应第 2.1 节需求：

1. `cargo build --release` 产出单文件 exe，体积记录在 README 中；双击可运行，不依赖额外安装。
2. 窗口置顶开关生效（切换后被其它窗口覆盖／保持在前）。设置中更改数据目录后，`data.json` 出现在新目录；再次启动仍指向新目录。
3. 勾选任务后 `done` 变为 `true` 且 `updatedAt` 刷新，界面同时显示创建与更新时间。
4. 布局在面板与列表间切换生效并持久化；`↑↓←→`／`Ctrl+N`／`Space`／`Delete`／`Esc` 行为与第 9 节一致；隐藏已完成、已完成置底、隐藏操作按钮三个开关均生效。
5. 三种主题切换正常，跟随系统时改动系统主题界面即时跟随。
6. `git log` 存在初始提交，`.gitignore` 排除了 `target/`、`node_modules/`、`dist/`。

补充手动项：托盘菜单四项可用；关闭按钮按 `closeToTray` 取值分别隐藏与退出；强制结束进程后重新启动数据无损坏；禁用／改键后全局快捷键行为正确。

## 12. 待办清单（实现顺序）

1. 项目骨架：`git init`、`.gitignore`、`README.md`、`package.json`、`src-tauri` 配置与图标。
2. Rust 后端：`config.rs`、`store.rs`、`images.rs` 及其单元测试。
3. IPC 命令层与插件注册、托盘、窗口事件。
4. 前端骨架：`index.html`、`style.css`（三主题变量）、`theme.js`。
5. 前端状态与渲染：`model.js`、`store.js`、`render.js` 及其单元测试。
6. 交互：`events.js` 快捷键与编辑态、图片粘贴与拖放。
7. 设置面板与系统集成开关。
8. 打包体积优化与手动验收，记录体积与用法到 README。
