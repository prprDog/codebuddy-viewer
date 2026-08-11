# CodeBuddy 积分使用管理系统 - 桌面悬浮列表组件（Win11）

一个基于 Electron 的 Windows 11 桌面悬浮组件，用于实时展示 CodeBuddy 账户的积分（credit）使用情况。窗口呈**半透明磨砂效果**、**始终置顶**（不被其他程序遮挡）、可拖拽、可隐藏到系统托盘。

## 功能特性

- **半透明悬浮窗**：磨砂玻璃质感（`backdrop-filter` 模糊 + 渐变半透明背景）。
- **始终置顶**：默认置顶显示，不会被其他窗口遮挡；可一键切换置顶状态（📌）。
- **积分实时展示**：调用 CodeBuddy 官方接口获取本月积分使用明细、每日用量、积分余额。
- **完整登录集成**：内嵌 CodeBuddy 官方登录页，复用其**微信扫码登录**体系，登录后自动捕获会话并持久化，无需重复登录。
- **托盘常驻**：关闭悬浮窗后隐藏到系统托盘，随时可重新唤出；右键托盘图标可退出。
- **自动刷新**：每 60 秒自动刷新数据，也可手动点击刷新（⟳）。

## 环境要求

- Windows 11
- Node.js（本机使用 nvm 管理的 v18.20.4，见下文）

## 安装与运行

本机已使用 nvm 安装 Node v18.20.4，路径 `D:\Tools\nvm\v18.20.4`。安装依赖前需将其加入 PATH（否则会用到系统旧的 v14）。

```powershell
# 1. 切换到 Node 18（关键：Electron 31 需要较新 Node）
$env:Path = "D:\Tools\nvm\v18.20.4;" + $env:Path

# 2. 安装依赖（Electron 二进制从国内镜像下载，避免网络问题）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install

# 3. 启动应用
npm start
```

> 若 `node_modules/electron/dist` 不存在（二进制未下载成功），手动执行：
> ```powershell
> node node_modules\electron\install.js
> ```

## 使用说明

1. 启动后，悬浮窗默认显示「登录」界面。
2. 点击「**微信扫码登录**」→ 弹出 CodeBuddy 官方登录窗口。
3. 使用微信扫码并确认登录。
4. 登录成功后登录窗口会自动关闭，悬浮窗自动刷新并显示积分使用情况。

### 界面操作

| 图标 | 功能 |
|------|------|
| ⟳ | 手动刷新积分数据 |
| 📌 | 切换「始终置顶」（高亮=置顶中） |
| ✕（左键） | 隐藏到系统托盘 |
| ✕（右键） | 彻底退出应用 |
| 标题栏拖拽 | 移动悬浮窗位置 |

### 托盘

- 左键托盘图标：显示/隐藏悬浮窗。
- 右键托盘图标：显示/隐藏，或「退出」。

## 技术实现

### 鉴权机制（复用 CodeBuddy 登录系统）

通过分析 CodeBuddy 前端 `usercenter` 包（`config-*.js` / `index-*.js`）确认：

- 接口鉴权基于 **Cookie 会话**（`session` / `session_2`），未登录时 APISIX 网关返回 `401`。
- 前端 axios 实例使用 `withCredentials: true` 携带 Cookie，并附加 `X-Client-Platform: web` 请求头。
- 登录失效后跳转到 `/login?platform=usercenter&state=0&redirect_uri=<原页面>`，支持**微信扫码登录**（OIDC）。

本组件据此设计：
1. 登录窗口使用持久分区 `persist:codebuddy` 加载官方登录页，完整走官方扫码流程。
2. 登录成功后检测到导航到 `/profile/*`，自动捕获 `.codebuddy.cn` 域下的全部 Cookie 并写入本地会话文件（`userData/codebuddy-session.json`）。
3. 主进程通过 Node `https` 发起请求时，携带这些 Cookie + `X-Client-Platform: web` 头部，即可通过鉴权。

### 接口

| 接口 | 用途 | 参数 |
|------|------|------|
| `POST /billing/meter/get-user-request-usage` | 请求明细（本组件主数据源） | `{startTime, endTime, pageNum, pageSize}` |
| `POST /billing/meter/get-user-daily-usage` | 每日用量汇总 | `{startTime, endTime}` |
| `POST /billing/meter/get-user-resource` | 积分资源/余额 | `{}` |

> 日期范围默认取**本自然月**（`本月1日 00:00:00` ~ `本月最后一天 23:59:59`），与 CodeBuddy「套餐与用量」页一致。

### 积分统计策略（分页）

`get-user-request-usage` 是**分页查询接口**，单页最多返回 **100 条**。若仅查询第一页，当本月请求超过 100 条时会导致积分统计不全。因此本组件采用**全量分页拉取**策略：

1. 主进程循环请求该接口，单页 `pageSize=100`，从第 1 页逐页拉取，直到：
   - 某页返回空数组，或
   - 累计条数 ≥ 接口返回的 `total`
2. 设 **200 页安全上限**（防止异常死循环）。
3. 拉取到的**全量明细**用于统计：
   - **本月请求数**：取接口返回的 `total`
   - **本月消耗积分**：对全量明细的 `credit` 字段求和
4. 悬浮窗**列表只展示最近 30 条**（接口按时间倒序，取全量数据前 30 条即最新记录），与全量统计互不影响。

> 注意：分页拉取会随本月请求量产生多次请求（如 209 条 ≈ 3 次请求）。本组件每 60 秒自动刷新，请留意接口调用频率。

## 项目结构

```
.
├── package.json
├── src/
│   ├── main.js              # 主进程：窗口管理、登录捕获、API 调用、托盘
│   ├── preload.js           # 预加载：安全暴露 IPC 桥接
│   ├── assets/icon.png      # 应用/托盘图标（PNG，随包发布）
│   └── renderer/
│       ├── index.html       # 悬浮窗界面
│       ├── style.css        # 半透明磨砂样式
│       └── renderer.js      # 界面逻辑、登录流程、数据渲染
└── test-api.js              # （可选）API 连通性自测脚本
```

## 打包为 EXE

使用 `electron-builder` 将应用打包为 Windows 可执行文件，方便分享给他人使用。

```powershell
# 使用 Node 18（electron-builder 需较新 Node）
$env:Path = "D:\Tools\nvm\v18.20.4;" + $env:Path

# 打包便携版（单文件 exe，免安装，最方便分享）
npx electron-builder --win portable

# 打包安装包（NSIS 安装向导）与便携版
npm run build
```

打包产物位于 `dist/` 目录：
- `CodeBuddy积分悬浮窗-1.0.0-portable.exe` — 便携版单文件，双击即用
- `win-unpacked/` — 解压版应用目录（可压缩分享，exe 带自定义图标）
- `*.exe`（NSIS 版）— 安装包

> 说明：
> - 若 electron-builder 报 `@noble/hashes` 的 ESM 错误，请降级 `electron-builder@24.9.1`（本工程已固定该版本）。
> - **图标来源统一为 `src/assets/icon.png`**：替换此文件即可同时更新「应用运行时托盘/窗口图标」与「打包后 exe 图标」。
> - `win.signAndEditExecutable: false` 可避免打包时 `rcedit` 报 `Unable to commit changes`；portable exe 的图标由 electron-builder 生成 NSIS 时从 `src/assets/icon.png` 转换而来（已验证生效）。

## 注意事项

- **登录态持久化**：会话 Cookie 保存在 Electron 用户数据目录（`%APPDATA%/codebuddy-credit-widget/codebuddy-session.json`）。Cookie 长期有效，无需每次启动都扫码；失效时应用会自动提示重新登录。
- **网络安全**：请勿泄露会话文件；本应用仅在本机运行，不上传任何数据。
- **接口变动**：若 CodeBuddy 调整接口或鉴权方式，需同步更新 `src/main.js` 中的端点与请求头。

## 已知限制

- 首次登录必须弹出官方登录窗口扫码，无法绕过（符合 CodeBuddy 鉴权要求）。
- 积分统计仅展示「请求明细」列表与基础汇总，更复杂的每日/余额图表如需展开可后续补充。
