# OmniCodex 中文指南

OmniCodex 将已安装 Codex 运行时的真实工具公开为仅限所有者的认证 MCP。
网页和桌面应用的普通 Chat 均可使用这些工具。安装和后台维护不会自动控制
Codex 桌面应用；明确请求的工作可以使用运行时原生的 Computer Use 和桌面工具，
应用的启动和重启使用专用生命周期工具。OmniCodex 不修改 Codex 认证或配置，
也不会把自身注册到本地 Codex MCP。
源代码及所有者专属部署信息保持私密。请克隆已获授权访问的私有仓库，
再依次运行 `npm ci --ignore-scripts`、`npm run build` 和 `node dist/cli.js`。
Auth0 的精确 resource 与
ChatGPT 应用 URL 都必须指向公开的 `/mcp/full`。Oracle 辅助功能默认 dry-run，只连接明确
配置的 loopback CDP，并且仅处理 Connect 和 Always allow。安全边界与来源归属
请参阅英文 README、PRD 和 reference ledger。
