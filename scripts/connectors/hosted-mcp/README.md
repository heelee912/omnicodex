# OmniCodex2 hosted MCP connector (opt-in)

This standalone stdio bridge uses the OpenAI-style hosted MCP catalog dialect. It
has **no bundled account, OAuth client, workspace, connector, link, tunnel or
endpoint registration**. Every recipient must use **their own approved public
OAuth app and their own hosted registration**, including their workspace and
connected link. Setup guides you and installs your nonsecret configuration; it
does not provision provider resources, log in, start a tunnel or restart anything.

## Guided first install

Requirements: Node >=24.14.0, a private OS user profile, and Windows CurrentUser
DPAPI / Windows PowerShell for credential use. Non-Windows login/stdio fail
closed; setup never substitutes plaintext credentials or another login.

From your installed package root, in an interactive terminal:

```powershell
node scripts/connectors/hosted-mcp/setup.mjs
# After the wizard saves YOUR approved registration, explicitly log in:
node scripts/connectors/hosted-mcp/oauth-login.mjs
```

The wizard prints official documentation, optionally opens **only a guide you
explicitly select**, and explains how to obtain your own provider approval and
hosted connector/link registration. It stops without writing if you have not
obtained these. It prompts for only nine **nonsecret** fields: public client ID,
authorization/token/callback URLs, approved scopes, workspace/connector/link IDs
and hosted MCP endpoint. Never enter a password, client secret, token or callback
code in the wizard or chat. Secrets are handled only by browser OAuth and separate
CurrentUser DPAPI storage.

Official guides (not OAuth-client provisioning links):

- [OpenAI: connect and test your plugin in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI: authentication for your MCP server](https://developers.openai.com/plugins/build/auth)
- [MCP: OAuth authorization and PKCE requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

The OpenAI guides describe registering **your MCP server in ChatGPT** and that
server's OAuth, not approval for an independent public OAuth client to call the
hosted resource used by this bridge. **There is no verified self-service hosted
OAuth app provisioning link supplied here.** Request your own client provisioning,
public-client/PKCE approval, exact endpoints and hosted connector permissions from
your provider/admin through its official support process. Then register/connect
your service in your own workspace, record exact connector/link IDs (not labels),
and obtain the workspace and resource endpoint from that registration. Register
the exact `http://127.0.0.1:PORT/path` callback you choose, including its port/path.

## Provider prerequisite / known limitation

**Independent/arbitrary OAuth client support for the OpenAI hosted resource is
unverified.** Installing configuration or registering an MCP server in ChatGPT
does not grant this bridge hosted API access. The source adapter used a
pre-existing client and a private hosted API dialect; it provides no evidence that
independently registered apps can obtain the required connector scopes or invoke
that API. If your provider does not approve your independent client for this
resource, **this route is blocked**. Do not substitute a first-party/borrowed
client, another person's registration, copied credentials or another account's
link. No live provider interoperability is claimed by the synthetic tests.

This bridge implements authorization code + PKCE S256 with refresh tokens for
public/native clients, not dynamic client registration. A provider that requires
a confidential client/client secret is unsupported. Scope approval must include
`openid`, `offline_access` and the connector permissions your provider requires.
The wizard validates registration shape locally; it cannot verify provider
approval or account ownership and never calls a provider to check them.

The dialect uses `ChatGPT-Account-Id`, the `codex` product header, catalog metadata
`connector_id`, `link_id`, `_codex_apps.resource_uri`, and a JWT access-token claim
`https://api.openai.com/auth.chatgpt_account_id` (the namespace is a JSON key,
not a discovery endpoint). Opaque access tokens and unrelated provider dialects
are unsupported. Access claims are decoded for workspace/expiry checks, **not
locally signature-verified**. Tokens are accepted only from the explicitly trusted
HTTPS token endpoint or CurrentUser DPAPI state; the resource validates bearer
tokens. An `id_token` cannot override an access-token workspace mismatch. The
catalog must expose `codex__omnicodex__session_identity` and continuation metadata.
No tunnel ID is used, imported or auto-discovered.

## Installed configuration and multiple registrations

The wizard validates with `loadConfig`, asks before saving, then atomically
publishes a new private `registration.json` file. **Existing files are never
replaced**, even by concurrent setup. Nothing is written inside the package.
Default configuration path:

- Windows: `%LOCALAPPDATA%/OmniCodex/hosted-mcp/config/registration.json`.
- Other OS setup: `${XDG_STATE_HOME:-~/.local/state}/omnicodex/hosted-mcp/config/registration.json`.

Both `oauth-login.mjs` and `stdio.mjs` automatically read this same configuration.
Configure your MCP host to launch `node` with the **absolute script path** to
`scripts/connectors/hosted-mcp/stdio.mjs` in your installation. No registration
environment variables are needed for a default wizard installation. Stdout is
reserved for newline-delimited JSON-RPC, and importing a module starts nothing.

For another independent registration, choose a new absolute private JSON path:

```powershell
# Pick YOUR path in a dedicated directory within YOUR user profile, outside this package.
$registration = Join-Path $env:LOCALAPPDATA 'OmniCodex/hosted-mcp/config/second.json'
node scripts/connectors/hosted-mcp/setup.mjs --config "$registration"
node scripts/connectors/hosted-mcp/oauth-login.mjs --config "$registration"
# Supply --config "$registration" to the stdio command in your MCP host as well.
```

Alternatively, set `OMNICODEX_HOSTED_CONFIG_PATH` to that same absolute path in
both your login shell and MCP host's child environment. `--config PATH` takes
precedence over this path variable. A path must be a JSON file in a dedicated
private directory **inside your OS home and outside (and not containing) the
source/package tree**. Symlink aliases into the package, linked config files,
unsafe POSIX permissions, malformed/missing files, unknown fields and unsupported
schema versions fail closed. No fallback registration or default app is used.
Windows config files are created with a protected current-user-only ACL and that
ACL is verified on load; POSIX files use mode 0600 and owner-only directories.
Keep Windows profile/directory ACLs private; do not use shared, network or synced
folders. The config is nonsecret JSON, not a credential export; do not share its
account/registration metadata unnecessarily.

To change a registration, create a **new** config path and run its dedicated login.
Do not overwrite a config while connector/login processes might be using it.
Credentials are bound to every registration field; another config never inherits
an old account login merely because it shares a display name.

### Explicit environment automation (all or nothing)

A complete explicit registration environment overrides the installed config,
even if the config file is absent. **Any partial override is rejected**, never
merged with installed fields. Set all nine variables below, or unset all nine:

| Variable prefix: `OMNICODEX_HOSTED_` | Value from YOUR approved registration |
| --- | --- |
| `OAUTH_CLIENT_ID` | Your public/native client ID |
| `OAUTH_AUTHORIZATION_URL` | Your authorization HTTPS URL |
| `OAUTH_TOKEN_URL` | Your token HTTPS URL |
| `OAUTH_CALLBACK_URL` | Exact registered `http://127.0.0.1:PORT/path` |
| `OAUTH_SCOPES` | Approved space-separated scopes including `openid offline_access` |
| `WORKSPACE_ID` | Exact access-token workspace |
| `CONNECTOR_ID` | Exact hosted connector ID |
| `LINK_ID` | Exact connected link ID |
| `MCP_ENDPOINT` | Approved hosted MCP HTTPS endpoint |

Authorization/token/resource URLs forbid credentials, query strings, fragments
and whitespace. The interactive wizard refuses registration environment overrides
so it cannot accidentally install inherited account values. Optional
`OMNICODEX_HOSTED_LOG=0/1` and `OMNICODEX_HOSTED_STATE_DIR` are runtime options,
not partial registration overrides, and are never saved in the installed config.

## State, privacy and failure behavior

After you explicitly start login, open its displayed authorization URL yourself,
verify YOUR app/workspace and complete the callback within ten minutes. That URL
is interactive setup output, not an audit record: do not share/capture it in logs.
No provider-supplied error payload or callback code is printed.

All credentials, temporary encrypted files, refresh locks and optional audit logs
are outside the source/package, separate from the installed JSON configuration.
Default credential state on Windows:
`%LOCALAPPDATA%/OmniCodex/hosted-mcp/<registration-sha256>/`.
`OMNICODEX_HOSTED_STATE_DIR` may select a dedicated absolute directory within your
OS home, never inside (or containing) the package. Symlink aliases into the
package and linked state files are rejected. An existing Windows state directory
must already have a protected current-user-only ACL; a new one receives it before
credentials are used. An exact registration marker binds the directory, and an
unmarked directory with existing files or another registration is rejected. POSIX
state must be owner-only, although DPAPI credential use remains Windows-only.

The registration digest binds credentials to client ID, authorization/token/
callback/resource URLs, scopes, workspace, connector and link. Changing any of
these requires a new dedicated login. DPAPI is CurrentUser, never LocalMachine;
protection/decryption failure never falls back to plaintext or another login.
State and PKCE verifier stay in memory until the one-use exact callback; OAuth
codes and refresh requests are not automatically retried. A persisted refresh
barrier forces a fresh login after any uncertain refresh outcome.

`OMNICODEX_HOSTED_LOG=1` enables `connection.log.jsonl` in that state directory;
default `0` writes no audit log. Only time, fixed event/method/outcome labels,
HTTP status, elapsed milliseconds and catalog counts are retained. No tool names,
arguments, responses, tokens, URLs, paths, account IDs or session IDs are logged.
Logs are append-only; disable or prune them yourself when no process uses them.

Locks are exclusive and never automatically stolen based on age/PID. If a process
crashes, first stop all connector/login processes using that state directory,
then remove only `oauth.lock` there and run a fresh login. Never delete a lock
while a process might still own it. To forget credentials, stop those processes
and remove this dedicated credential state directory, not any other application's
auth. Installed configuration can be removed separately when no process uses it.

Requests pin the endpoint/workspace/connector/link, reject ambiguous or changed
tool routes and session IDs, propagate cancellation, and use no alternate local
route. Upstream failures, timeouts, cancellations and rejected identity setup do
not replay tool executions. Execution may have continued after a transport
failure; inspect the hosted service before choosing a new explicit action.
Duplicate stdio request IDs cannot dispatch twice in one process. A failed
catalog/session identity check requires a new connection. No live OAuth, hosted
calls or browser login is needed for the synthetic tests.

```powershell
npm test -- test/hosted-mcp.test.ts test/hosted-mcp-setup.test.ts test/release-package-policy.test.ts
```
