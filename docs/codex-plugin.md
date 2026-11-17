# Codex 原生插件

本项目同时提供 Codex 原生插件和原有的 exe、本地服务、浏览器扩展及 DSH 接入。插件是 Codex 中的工具入口，本地程序继续负责连接、断开、配对与存储管理。两者共用同一套数据与浏览器授权，不会再启动一套独立服务。

## 从控制面板安装

1. 在完整便携包中启动 `BrowserControl.exe`。
2. 点击“接入 AI → 安装到 Codex”。此操作使用本机 Codex CLI 注册专属本地插件市场，并安装、启用“浏览器控制”插件。
3. 重启 Codex，或新建可使用本地插件的会话，在插件列表查看“浏览器控制”。
4. 原面板仍用于连接服务和配对浏览器。在扩展中授权要操作的网页后，可以让 Codex 检查连接并读取该网页。

未安装 Codex CLI 时，可以先点击“生成 Codex 插件”，复制插件目录或安装命令，在本机准备好 CLI 后完成安装。该版本已通过 Codex CLI 0.142.1 的实际安装和重复安装验证；旧版 CLI 若没有 `plugin` 命令，需要先更新。

## 原生插件包含什么

- `plugin.json`、`mcp.json`：可移植插件格式，声明本地执行和 stdio MCP。
- `.codex-plugin/plugin.json`、`.mcp.json`：兼容客户端的插件入口。
- `skills/browser-control/SKILL.md`：授权网页、连接与手动断开、读取与操作验证指引。
- `scripts/control.mjs`：查看本机运行位置或打开原控制面板的辅助入口；不启动、停止服务。
- 头像资源与本机运行位置记录。

插件提供 13 个浏览器工具（新增逐字输入 `browser_type_text` 和页面脚本执行 `browser_eval`，均需用户启用调试权限），使用 `browser_control_native` 服务器名称。插件包不复制 exe 或生产依赖，不携带配对密钥；它使用当前数据目录中的固定 Node.js 和 MCP 启动器。完整 exe 和服务文件仍需保留。

插件只连接控制面板已经启动的本地服务，不会自行启动服务或创建监听端口。每次调用都会由本地服务核对 `codex-native` 实例身份、插件端口、配对凭据、扩展连接和暂停状态；失败时返回准确原因。可在面板“AI 接入情况”单独暂停或恢复 Codex 接入，暂停由服务端强制执行并持久保存。

安装程序仅移除旧版中由本项目标记管理的 `browser_control` MCP 小节，避免重复注册；修改前在数据目录中备份。其他 MCP、插件和客户端设置会保留，未标记为本项目管理的手动配置不会被移除。

## 存储与迁移

本机插件市场生成在当前数据目录的 `codex-plugin-marketplace` 下。Codex 自己的插件缓存与启用设置由 Codex 管理。

同一电脑移动程序文件夹后，在新位置打开面板并点击“连接”或生成接入信息，会更新固定运行入口。更改数据存储位置时，缓存、日志、配对信息和生成的插件文件会一起迁移；之后再次点击“安装到 Codex”刷新客户端中的路径，并重启会话。

生成的插件和市场目录包含本机绝对路径，只供当前电脑安装。换电脑请用该电脑上的面板重新生成和安装，不要把它当作公开源码包上传。仓库的 `integrations/codex` 是无个人配置的模板，发布的源码与便携 ZIP 不含生成的本机配置。

## 源码命令

```sh
node scripts/cli.mjs prepare-codex-plugin --json
node scripts/cli.mjs install-codex-plugin --json
```

安装、启用插件不解除用户的手动断开状态，不会自动授权网页，也不会启动本地服务。原有通用 MCP JSON 和 DSH 插件仍可使用。

格式参考：[OpenAI 插件打包规范](https://developers.openai.com/plugins/build/plugins)、[本地 MCP 插件](https://developers.openai.com/plugins/deploy/desktop-only)。本项目使用本地插件市场，不代表已发布到公共插件目录。
