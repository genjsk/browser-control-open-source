# Changelog

## 1.4.0

- 安装器列出可识别的旧版和完整路径，按所选版本确认升级；安装后显示 Codex 与 DSH 插件版本，并提供对应的更新入口。
- 升级前读取 Windows 的监听状态，避免连接探测失败导致已断开的服务被误拦截。
- 修复 Windows 安装包在系统临时目录不可用时无法打开的问题，安装器会尝试备用位置。
- 原地升级在已有程序目录内创建暂存目录，无需向上一级目录写入。安装器显示端口检查、解压进度、文件替换及清理步骤。
- 修复 Windows 拒绝创建暂存目录时安装器可能反复重试的问题。解包目录以隐藏方式暂存并自动清理，安装失败时记录出错步骤。
- 修复 r5 以管理员身份升级后，新程序文件可能因暂存目录权限而无法正常启动的问题。程序文件继承安装位置的访问权限。
- 全新安装或升级到新位置时，非空目标会自动改为同级的编号目录，并显示最终安装路径。
- Windows 拒绝创建安装暂存目录时，可以通过 UAC 以管理员身份重新打开安装器，并恢复已选的旧版与目标路径。

- 支持多个浏览器或独立浏览器配置用同一服务配对。在控制面板按 AI 接入实例选择浏览器，保存后只路由到该浏览器，离线时停止调用。

- 默认快照只返回主页面简短正文与首批控件，支持按标签搜索、控件和正文翻页，以及按需读取同源子框架。
- 新增 `browser_inspect` 读取单个控件详情。填入操作返回即时值核验结果，`browser_wait` 可按框架等待确认提示。
- 精简 MCP 工具说明和成功回执，保留每次调用的端口、配对及连接核对结果。

## 1.3.0

- 新增 `browser_type_text` 逐字键盘输入：通过 Chrome DevTools Protocol 的 `Input` 能力发送浏览器级按键；普通 ASCII 使用 keydown/keypress/keyup，中文、emoji 等使用文本/IME 输入路径；支持 input、textarea、contenteditable，不自动提交表单。
- 扩展新增 `debugger` 权限，并在设置页提供逐字输入用途说明和明确同意开关；Chrome 调试提示条和新增权限提示会在文档中说明，用户不启用时快速填入不受影响。
- 逐字输入要求目标标签页在前台；暂停、断线、标签页切换、焦点丢失、DevTools 占用或权限拒绝时安全停止，返回已输入字符数和可恢复原因，不重放整段文本。
- 输入文本不写入日志、最近操作或工具结果；成功结果只返回字符数、跳过字符数和核验状态。
- 增加逐字输入单元测试、桥接白名单测试和 Playwright 浏览器验收场景，覆盖受控输入事件、中文/emoji/换行、密码与文件输入拒绝、部分输入中断和调试会话释放。
- 新增 `browser_eval` 高级工具：通过 Chrome DevTools Protocol 在已授权页面主环境执行 JavaScript，可绕过页面 CSP，用于 Monaco、CodeMirror 等只接受真实按键的编辑器；需要单独启用“页面脚本执行”，执行后立即断开调试会话，不自动点击或提交。
- 增加页面脚本执行的独立同意开关、权限说明、桥接白名单和 MCP 工具描述；文档明确脚本可能读取登录态，禁止用于密码、令牌或隐藏敏感字段。
- 浏览器快照恢复为返回全部可交互元素，不再截断为固定 5 个，与既有文档和 1.2.0 变更说明一致。

## 1.2.0

- AI 接入（Codex 原生插件、Codex MCP、通用 MCP、DSH）只连接控制面板管理的本地服务，不再自动启动后台服务或创建监听端口；服务未运行时返回明确提示。
- 每次工具调用由本地服务逐次核对 AI 实例身份、插件端口与当前服务端口、配对凭据归属、扩展连接状态和实例暂停状态；失败时阻断操作并返回具体原因及两端端口。
- 控制面板新增“AI 接入情况”：按实例显示客户端、接入方式、端口、已安装/在线/离线/已暂停状态和最近调用时间，并支持单独暂停、恢复调用；暂停状态持久化且由服务端强制执行。
- 为每类 AI 接入分配稳定身份，身份令牌仅保存在本机数据目录（0600 权限），不写入源码、模板或发布包。
- 区分“服务未启动”“端口不一致”“端口被其他程序占用”“配对信息不匹配”“实例已暂停”“扩展未连接”等诊断，不再把鉴权失败误报为端口占用。
- 移除累计操作次数、每会话调用次数和每日配额等限制；保留单次请求超时，超时和断线不会重放已发出的写入。
- 浏览器快照不再限制可交互元素数量（移除原来 250 个和内部 3000 个上限），大页面也能返回完整元素列表；单次请求超时和大消息保护保持不变。
- 文档说明 DSH 与模型平台仍可能存在的单次超时、上下文和 goal 轮次限制。

## 1.1.0

- Add a native Codex plugin with portable and compatibility manifests, browser workflow guidance and the existing MCP tools.
- Install and enable the plugin through a dedicated local marketplace from the desktop panel.
- Share the existing local runtime, browser authorization and data directory; retain the exe, browser extension and DSH integration.
- Preserve unrelated Codex settings and safely transition only the owned legacy MCP table.
- Relocate generated Codex plugin paths with storage migration and support refreshing the local installation.

## 1.0.4

- Add Copy plugin address above Open plugin directory in the DSH dialog, for installing a local plugin by its directory.

## 1.0.3

- Migrate existing data when changing storage instead of only changing the path.
- Verify every copied file before switching locations and cleaning old data.
- Preserve pairing keys, port settings, logs and cache; relocate generated DSH paths.
- Reject nonempty destinations, overlapping paths and directory links; roll back on verification or configuration failure.
- Prevent reconnection during migration and prevent existing AI sessions from recreating the former directory.
- Exercise migration and reconnection through both the Settings button and the frozen Windows executable.

## 1.0.2

- Open directly into the main interface with the usual local data directory.
- Allow C: and all other writable drives; provide optional storage changes in Settings.
- Keep the current connection when canceling a directory change.
- Fall back to writable application-local storage if the default profile directory is inaccessible.
- Verify default startup, Settings changes, AI integration and the frozen portable build.

## 1.0.1

- Ask for a data directory before first use; Windows refuses C: and junctions resolving to C:.
- Never silently fall back to AppData; canceling directory selection exits without creating application state.
- Settings show, open and change the selected directory; a new computer asks again.
- Keep pairing state, logs, generated integrations and client configuration backups in the selected location.
- Fix AI integration startup when the former default profile directory is inaccessible.
- Test the frozen AI button, connection cycles, explicit selection and relocation with no system Node.js.

## 1.0.0

- Clean open-source layout with no personal paths, credentials or browser data.
- Windows portable package includes the GUI, Node.js and production dependencies.
- Standard per-user data directories on Windows, macOS and Linux.
- Relocatable application files and a stable per-user MCP entry point.
- Three-step onboarding, a single pairing code, port settings and AI integration dialogs.
- Locally generated GPT/Codex configuration and DSH plugin bundle.
- Source/release allowlists, leak checks, hashes and GitHub Actions workflows.
- Original anime icon in the executable, native title bar and taskbar.
