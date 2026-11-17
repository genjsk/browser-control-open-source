# Browser Control

[English](README.en.md) · [快速开始](#windows-三步开始) · [迁移到新电脑](docs/portability.md) · [AI 接入](docs/integrations.md) · [开发](CONTRIBUTING.md)

让支持 MCP 的 AI 操作**你明确授权的浏览器标签页**。浏览器扩展执行读取、点击、输入和截图，本地服务连接 AI，桌面面板控制连接与断开。

支持 Codex 原生插件、GPT / Codex 本地 MCP 会话、DeepSeek Harness，以及可运行本地 stdio MCP 服务的客户端。无需在本项目中填写模型 API Key。

<img src="assets/browser-control-128.png" width="96" alt="Browser Control mascot">

## Windows 三步开始

**从本仓库 Releases 下载 `browser-control-版本-win32-x64.zip`。解压完整文件夹后双击 `BrowserControl.exe`。**

Windows 便携包包含 Python 界面、Node.js 和服务依赖，不需要先安装 Python、Node.js 或 npm。不要只复制 exe；旁边的 `_internal`、`runtime`、`bridge`、`extension` 等目录也是程序的一部分。

打开后直接进入主界面，默认使用本机数据目录（Windows 为 `%LOCALAPPDATA%/BrowserControl`）。**设置 → 更改存储位置**可改到 C、D、E 等任意可写磁盘；“打开数据目录”可查看缓存、日志和配对数据。默认位置不可写时使用程序内的 `.local/state`，界面会显示当前位置。

更改位置会把缓存、日志、配对信息和设置一起迁移，逐个校验文件后再清理旧数据，浏览器配对和端口会保留。请先关闭使用浏览器工具的 AI 客户端；迁移后在“接入 AI”更新配置并重启客户端。目标文件夹已有内容时不会覆盖。

1. **连接**：在控制面板点击“连接”。
2. **配对浏览器**：打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”。在面板点“配对浏览器 → 打开扩展文件夹”，选择该文件夹；再复制配对码，粘贴到扩展的“连接设置”。
3. **接入 AI**：面板中点击“接入 AI → 安装到 Codex”，安装原生插件后重启 Codex 或新建会话。也可复制通用 MCP JSON 或生成 DSH 插件。然后到目标网页点击扩展图标 → “允许 AI 操作当前网页”。

逐字键盘输入是可选能力：需要在扩展设置中勾选同意，并接受扩展的 Chrome `debugger` 权限。更新扩展后若 `chrome://extensions` 提示新增“调试程序”权限，需要手动接受；不启用时仍可使用快速填入。

Codex 原生插件与 exe 共用本地服务，原面板和本地运行模块完整保留。安装方式与目录迁移见 [Codex 插件说明](docs/codex-plugin.md)。

第一次可对 AI 说：

> 先检查 browser_control 的连接，再读取我已授权的网页，告诉我页面标题和有哪些可操作按钮。

原有浏览器控制插件若占用了同一端口，请先断开旧版；也可在新面板“设置”中修改端口并重新配对。

## 可以做什么

| 功能 | 工具 |
| --- | --- |
| 检查连接、查看授权标签页 | `browser_status`、`browser_tabs` |
| 读取正文、交互元素与同源框架 | `browser_snapshot` |
| 点击、填写、下拉选择、复选框和合成按键 | `browser_click`、`browser_fill`、`browser_press_key` |
| 逐字键盘输入（需启用调试权限） | `browser_type_text` |
| 滚动、切换授权页面、同源导航、刷新 | `browser_scroll`、`browser_select_tab`、`browser_navigate` |
| 等待页面条件、截图 | `browser_wait`、`browser_screenshot` |

AI 应按“读取快照 → 操作 → 再读取验证”的方式工作。页面变化后过期元素标识会被拒绝；断线或超时不会重放写入动作。

`browser_type_text` 需要目标标签页在前台（先 `browser_select_tab`），并在扩展设置中明确启用逐字输入。控件此前未聚焦时，输入从值末尾开始；已聚焦时保留当前光标或选区，输入会替换选区。只支持文本类 input（text/search/email/url/tel）、textarea 和 contenteditable，数字/日期等专用控件和密码/文件框会被拒绝。它对普通 ASCII 发送浏览器级 keydown/keypress/keyup，对中文、emoji 等走文本/IME 输入路径；单行输入框中的换行会被跳过，textarea 和 contenteditable 中的换行会作为文本输入，不会按 Enter 自动提交表单。输入失败时返回已输入字符数并要求重新读取页面，不会自动重放整段文本；成功结果只返回字符数与核验状态，不记录、不回显输入文本。若页面要求真实物理键盘或用户激活，仍可能拒绝自动化输入。

## 连接、暂停和断开

- **只有控制面板能启动服务**：面板“连接”启动，面板“断开”停止。Codex、DSH 和其他 MCP 客户端只通过 stdio 转发请求，**不会**自行启动后台服务；服务未运行时工具会返回“本地服务未启动”，提示你打开面板点击“连接”。
- **面板“断开”**：停止本地服务，阻止 AI 自动重启；需要时再点击“连接”。GPT 和 DSH 若共用服务，会一起断开。
- **扩展“暂停”**：服务保持连接，暂不执行网页操作。
- **扩展“撤销”**：移除单个标签页授权。跳转到其他来源时也会撤销该页面授权。
- 关闭控制面板窗口不会自动停止服务。浏览器重连后保持暂停，不自动恢复旧任务。

## AI 接入情况

面板中的“AI 接入情况”会为每个已安装的接入实例显示 AI 客户端、实例与接入方式、端口、状态（已安装／在线／离线／已暂停）和最近调用时间。选中实例后可单独“暂停调用”或“恢复调用”，暂停由本地服务强制执行，其他实例不受影响；暂停状态会保存，实例下次连接仍然生效。

安装记录与 MCP 会话在线状态分开显示：只有最近仍有 MCP 会话心跳的实例才算在线，客户端关闭或失联后显示为离线。每类接入（通用 MCP、Codex MCP、Codex 原生插件、DSH）使用独立身份，令牌只保存在本机数据目录中。

每次浏览器工具调用前，本地服务都会核对实例身份、插件端口与当前服务端口、配对凭据归属、扩展连接和暂停状态，核对通过后工具结果包含 `verification`（端口一致、配对已验证等）。核对失败时不会执行浏览器操作，并返回具体原因与两端端口；不会返回配对码或密钥原文。

浏览器操作不设累计次数、会话次数或每日配额上限，可以持续调用直到任务完成、用户停止、服务断开或实例被暂停。浏览器快照会返回页面全部可交互元素，不再截断为固定数量。单次请求仍有超时，超时或断线不会自动重放写入操作。

## 其他系统与源码运行

| 环境 | 使用方式 | 验证范围 |
| --- | --- | --- |
| Windows 10/11 x64 | Releases 便携 ZIP 或源码 | 本地端到端验证；CI 提供 Windows 检查 |
| macOS / Linux | Node.js 22+ 源码 CLI；浏览器使用 Chrome / Chromium | 提供跨系统路径实现与 CI 服务测试；未在本次本地实机验证 GUI |
| Windows ARM / 其他架构 | 使用相应架构 Node.js 源码运行 | 未提供预编译桌面包 |

```sh
npm ci --cache .local/npm-cache
npm start
```

`npm start` 启动本机服务并打开配对说明。`npm run stop` 断开；`npm run status` 查询。也可以运行 `Start.cmd`（Windows）或 `sh start.sh`（macOS/Linux）。

## 可迁移设计

源代码不包含个人绝对路径；启动后使用本机数据目录，用户可从设置更改位置。C 盘和其他磁盘都可以使用，不需要在启动时选择目录。

配对密钥、日志、端口设置、客户端配置备份和生成的 AI 配置都在当前数据目录中，**不在源码或发布包内**。自定义位置由程序旁的 `.local/storage-location.json` 记录；换电脑自动使用该电脑的默认位置，再重新配对，不复制旧密钥或浏览器登录数据。

同一台电脑移动完整程序文件夹后，打开新位置的程序并点“连接／接入 AI”即可更新运行路径。升级时选择原数据目录可保留配对；AI 使用数据目录内的固定启动入口。浏览器中已加载的未打包扩展需指向新位置。

详细说明见 [迁移与数据存储](docs/portability.md)。

## 限制与隐私

只操作用户授权的普通 HTTP/HTTPS 页面。首版不支持浏览器内部页、跨域 iframe、系统文件选择器、验证码处理和封闭 Shadow DOM。`browser_fill` 和 `browser_press_key` 派发的是 DOM/合成事件（`isTrusted=false`），部分需要可信输入的网站无法使用。`browser_type_text` 通过 Chrome 调试协议模拟浏览器级输入，会在调试期间显示提示条；它仍不是操作系统硬件键盘，要求用户激活或物理键盘的页面可以拒绝，工具会返回“页面拒绝自动输入”一类错误，不会绕过网站保护。

密码、一次性验证码与标记为私密的字段不会作为普通快照字段返回；截图仍可能包含可见的个人信息。`browser_type_text` 的输入文本不会写入扩展日志、最近操作或工具结果，成功时只返回字符数和核验状态。网页文字及截图作为工具结果会进入所连接的 AI 会话，**本机通信不代表数据永远不会发送给模型服务**。

本插件和本地服务不限制累计调用次数；单次请求超时、等待上限和失联处理仍然保留。DSH 与模型平台自身的单次工具超时、上下文窗口、输出长度或 goal 自动续行轮数不属于本插件设置，详见 [AI 接入说明](docs/integrations.md#dsh-与模型平台限制)。

本地服务只监听 `127.0.0.1`，需要配对凭据，并拒绝普通网页来源的直接控制请求。更多边界见 [SECURITY.md](SECURITY.md)。

Windows 便携包构建：

```sh
python -m pip install -r requirements-build.txt
python scripts/build-gui.py
npm run package:portable
```

源码包：`npm run package:source`。产物位于 `release/`，带 SHA-256 校验文件。构建时只复制发布白名单，检查是否混入配对密钥、浏览器配置或个人路径。GitHub Actions 可在打版本标签后构建并发布 Windows 包，见 [发布说明](docs/releasing.md)。

## 许可证

项目使用 [MIT](LICENSE)。头像为本项目生成的原创 AI 图像，随项目按 MIT 提供；第三方依赖保留其各自许可证。便携包中的 Node.js 许可证随包分发。说明见 [第三方许可](third_party/README.md)。
