# OmniCodex 中文指南

OmniCodex 将已安装 Codex 运行时的真实工具公开为仅限所有者的认证 MCP。
网页和桌面应用的普通 Chat 均可使用这些工具。安装和后台维护不会自动控制
Codex 桌面应用；明确请求的工作可以使用运行时原生的 Computer Use 和桌面工具，
应用的启动和重启使用专用生命周期工具。OmniCodex 不修改 Codex 认证或配置，
也不会把自身注册到本地 Codex MCP。
本源码和 scoped npm 包用于公开发布。请准备 Windows、Node.js 24.14.0
或更高版本及已登录的 Codex Desktop。确认 npm 已提供 `0.1.0` 后运行
`npm install --global @heelee912/omnicodex --ignore-scripts`；若尚未发布，
可克隆公开源码并运行 `npm ci --ignore-scripts` 与 `npm run build`。
每位使用者须配置自己的 Auth0 应用与 API、HTTPS 隧道和 Codex/ChatGPT
账号；包内不包含个人凭据。
可选的 OmniCodex2 hosted 连接器请参阅
[安装指南](../scripts/connectors/hosted-mcp/README.md)。安全边界和完整步骤见
[英文 README](../README.md) 与 [reference ledger](reference-ledger.md)。
