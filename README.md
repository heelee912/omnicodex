# OmniCodex

OmniCodex is a Windows-local, owner-authenticated Streamable HTTP MCP gateway
for the callable tool surface of an already installed Codex runtime. It owns a
separate hidden child runtime and never registers itself in the Codex desktop
app, modifies Codex authentication/configuration, or controls the desktop app.

## Install and configure

Requirements: Windows, Node.js 22.12 or newer, and an installed Codex runtime.

```powershell
npm install --global @heelee912/omnicodex
omnicodex init --issuer https://tenant.example/ --audience https://mcp.example `
  --resource https://mcp.example --subject owner-sub
omnicodex auth login             # official Auth0 device flow; refresh token stays in Windows keyring
omnicodex auth setup             # idempotently creates the dedicated API and strict DCR grant
omnicodex start
omnicodex status
omnicodex runtime probe --json  # isolated hidden runtime + full-surface live check
```

Initialization is fail-closed. OAuth issuer, audience/resource, scopes, and the
owner `sub` must match. `auth login` downloads a pinned, checksum-verified
official Auth0 CLI when one is not supplied and uses its Windows-keyring-backed
device login. No Management API token is written to OmniCodex configuration.
OmniCodex binds locally to `127.0.0.1`; remote access
requires an explicitly configured authenticated HTTPS ingress.

## Optional Oracle consent companion

The optional companion attaches only to an explicitly configured loopback
Chrome DevTools endpoint. It never launches, profiles, navigates, or terminates
Chrome. Setup is a dry-run unless `--execute` is supplied.

```powershell
omnicodex oracle setup --connector-id exact-id --connector-name OmniCodex `
  --run-id exact-run --resource https://mcp.example/mcp --surface /mcp/full `
  --cdp-endpoint http://127.0.0.1:9222 --non-interactive
omnicodex oracle status --json
omnicodex oracle test                 # no click
omnicodex oracle test --execute       # Connect / Always allow only
omnicodex oracle disable --execute
```

It is bound to the exact app, run, session, resource, and surface. General,
one-time, destructive, stale, ambiguous, or reconnected confirmations fail
closed. Receipts contain identifiers and state hashes only—never prompts,
screenshots, secrets, or raw tool content.

## Architecture and safety

- The installed runtime is the authority for callable tools.
- Ordinary calls do not silently become model calls.
- Protected Codex files are read-only and hash-checked by the non-interference guard.
- Owned console children use hidden/no-window creation.
- OAuth resource, issuer, scope, and owner subject are checked before MCP sessions.
- Browser automation is optional and separate from MCP server authority.

Operational commands include `doctor`, `logs`, `runtime discover`, `runtime probe`, `autostart`,
`auth`, `tunnel`, `update`, and `rollback`. Run `omnicodex --help` for details.

Documentation: [한국어](docs/README.ko.md) · [日本語](docs/README.ja.md) ·
[中文](docs/README.zh.md) · [source attribution](docs/reference-ledger.md).

## Release policy

Maintainers run `npm run check`, `npm run build`, and `npm pack --dry-run`.
Publishing is intentionally separate: `npm publish --provenance --access public`
must run only from the protected GitHub release workflow after review. No local
release script publishes, pushes, deploys, or changes GitHub state.

MIT licensed. This community project is not an official OpenAI product.
