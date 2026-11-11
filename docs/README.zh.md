# OmniCodex 中文指南

OmniCodex 将已安装 Codex 运行时的真实工具公开为仅限所有者的认证 MCP。
网页和桌面应用的普通 Chat 均可使用这些工具。安装和后台维护不会自动控制
Codex 桌面应用；明确请求的工作可以使用运行时原生的 Computer Use 和桌面工具，
应用的启动和重启使用专用生命周期工具。OmniCodex 不修改 Codex 认证或配置，
也不会把自身注册到本地 Codex MCP。
本源码仓库现已公开，但 npm 包尚未发布，`package.json` 仍为 `private: true`。
准备 Windows、Node.js 24.14.0 或更高版本、Git 和已登录的 Codex Desktop，
从公开仓库克隆源码，依次运行 `npm ci --ignore-scripts`、`npm run build`
和 `node dist/cli.js init --help`。每位使用者必须配置自己的 Auth0 应用与 API、
HTTPS 隧道以及 Codex/ChatGPT 账号；包内不包含个人凭据。
可选的 OmniCodex2 hosted 连接器请参阅
[安装指南](../scripts/connectors/hosted-mcp/README.md)。安全边界和完整步骤见
[英文 README](../README.md) 与 [reference ledger](reference-ledger.md)。
