# OmniCodex reference ledger

Status: normative implementation ledger  
Product contract: [`../PRD.md`](../PRD.md)  
Rule: the installed Codex runtime is the capability source of truth. A reference
repository may supply a translation rule, lifecycle pattern, security test, or
negative example; it may not narrow or change OmniCodex's semantic topology.

## 1. Adoption rules

1. Pin every reviewed upstream to an immutable commit.
2. Record license, exact evidence location, adopted behavior, rejected behavior,
   and the OmniCodex test that proves the decision.
3. Prefer clean implementation against observed protocols. Copy source only
   where the license permits it, the copied region is materially better than a
   clean implementation, and attribution is retained.
4. Never import a model-delegation topology, a low-level replacement for a
   native Codex tool, a write to user-owned Codex configuration, a static
   gateway-agent secret, or a local Codex MCP registration.
5. Unknown upstream behavior is evidence to investigate, not permission to
   guess. Runtime captures and contract tests decide.

## 2. Pinned sources

| Source | Immutable revision | License at revision | Ledger role |
| --- | --- | --- | --- |
| `lidge-jun/opencodex` | `d9de89557c3bd154e5f1508125def7c8789ac8c5` | MIT | Primary Responses tool-form and streaming translation oracle |
| `heelee912/full-access-mcp-public` | `60cc262bb26a0719b62ee654b15fa02bdb267dea` | MIT | Auth0/OIDC threat cases and owner-only remote admission oracle |
| `rebel0789/codexpro` | `bbc789e57012af2f46c005f5d54db17e50e1b7f0` | MIT | Windows/CLI/diagnostic and redaction comparison source |
| `Waishnav/devspace` | `0d9b60c72c2f154ef9fde918ebc9dd1335eba338` | MIT | MCP session, process lifetime, OAuth store, and shutdown comparison source |
| `farion1231/cc-switch` | `878c26f31e012ba32b9772bd080bd4fa9e7d495e` | MIT | Responses compatibility and namespace restoration second oracle |
| `router-for-me/CLIProxyAPI` | `a14dfc779f43aed588e68b31fb34ab5ced700851` | MIT | SSE, concurrency, cancellation, and transport fault fixtures |
| `michael-f-bryan/codex-ollama-proxy` | `febb37af4019cba5bec30c0bf3eef1b5b24752a6` | MIT | Local provider boundary and error-injection fixtures |
| `looplj/axonhub` | `8b708fe9219707c64582ec0d5d509716d7f5f3e5` | Apache-2.0 generally; `llm` portions LGPL-3.0 | Behavior/test inspiration only; no source copying |

The current OpenCodex pin is materialized in this repository's ignored
`.upstream/opencodex` reference cache. The other first-wave repositories remain
locally available under
`C:\Users\Master\Desktop\Projects\주식\work\repository-analysis`. Remaining pins
must be materialized in a separate read-only reference cache before any
line-level adoption.

## 3. OpenCodex

### Evidence map

- `src/bridge.ts`: Responses SSE output item mapping, custom/freeform input,
  `tool_search_call`, namespace restoration, terminal status, and streaming
  boundaries.
- `src/types.ts`: original namespace/name identity, freeform/custom and
  tool-search distinctions, and reversible wire naming.
- `src/adapters/openai-responses.ts`: native Responses tool variants, namespace
  flattening behavior, hosted-tool collision handling, tool-search items, and
  request compatibility edges.
- `src/server/ws-bridge.ts` and `src/server/responses/**`: SSE framing,
  completion/failure/incomplete terminals, and cancellation/error boundaries.
- `tests/**`: translation and round-trip fixtures are the preferred executable
  oracle; production implementation is not copied wholesale.
- `docs/superpowers/plans/2026-08-09-routed-computer-use-browser.md` and
  `docs-site/src/content/docs/guides/codex-integration.md`: routed models use
  `tool_mode: "code_mode_only"`; Browser and Computer Use are tools supplied
  and executed by Codex, not standalone OpenCodex host-tool implementations.
- `src/responses/custom-tool-compat.ts` and
  `src/server/responses-custom-tool-repair.ts`: custom/freeform input repair,
  `ctc_` item identity, canonical no-argument JSON (`"{}"`), and matching
  streaming delta/done events.

### Adopt

- Preserve `function`, `custom`, `freeform`, `tool_search`, `namespace`, and
  previously unknown tool discriminators instead of collapsing all tools into
  JSON functions.
- Preserve opaque custom/freeform input as a string.
- Restore native namespace and native name from an explicit identity map, never
  by ambiguous string parsing.
- Treat Responses streaming item IDs, call IDs, partial arguments, output
  items, progress, completion, failure, and incomplete terminals as distinct
  protocol state.
- Emit canonical argument/input delta and done events for function and custom
  calls, preserve `ctc_` custom-call identity, and serialize a no-argument
  function call as `"{}"` rather than an empty or absent value.
- Preserve `tool_search` identity and namespace metadata across request,
  selection, execution, and response repair.
- Turn OpenCodex regression fixtures into OmniCodex round-trip contract tests,
  with attribution.

### Reject

- The general model-provider proxy, provider routing, account pool, model alias,
  or model selection topology. OmniCodex ordinary execution is not an alternate
  model request.
- Any adapter that drops unsupported native tools to satisfy a weaker provider.
  OmniCodex must expose the installed runtime's full surface.
- Treating OpenCodex as an independent Browser, Computer Use, shell, or file
  implementation. Those capabilities remain owned by the installed Codex
  executor and its connected MCP tools.
- Any mutation of user Codex configuration, shims, or provider state.

### Proof required in OmniCodex

`function`, `custom`, `freeform`, `tool_search`, `namespace`, unknown tool
payloads, partial UTF-8/SSE chunks, media blocks, errors, and terminal states
must round-trip through the model-free execution driver without a real provider
request.

The pinned implementation has been reflected in
`test/responses-loopback-driver.test.ts`, including canonical function
arguments and custom-input delta/done ordering.

## 4. Full Access MCP Public

### Evidence map

- `src/oidcGatewayAuth.ts`: OIDC issuer, audience, scope, signature, token-time,
  JWKS, and failure-path handling.
- `src/remoteGatewayMcpServer.ts`, `src/gatewayIndex.ts`, and
  `src/remoteGatewaySettings.ts`: remote MCP admission and published endpoint
  organization.
- `src/remoteGatewayQueue.ts`: remote queue behavior to compare against
  Streamable HTTP backpressure.
- `src/localBridgeAuditTrail.ts`: audit-event vocabulary and redaction ideas.
- `src/chatGptMcpApproval*.ts` and
  `src/chromeRemoteDebuggingApproval*.ts`: evidence for the separate
  ChatGPT-web client/UI approval layer. This is outside MCP server authority
  but is an official companion path when scoped to the exact OmniCodex app.
- `src/windows*.ts`, `src/workspaceFileAccess.ts`, and
  `src/localWorkstationRuntime.ts`: low-level workstation implementation,
  explicitly not OmniCodex's execution core.

### Adopt

- Owner-only OIDC validation threat cases: exact issuer, audience/resource,
  scope membership, signature algorithm, `kid`, expiry/not-before, JWKS
  rotation, and fixed owner `sub`.
- Uniform authentication failures and redacted operational events.
- Authenticated remote deployment as an explicit security boundary.

### Reject

- Low-level Windows, filesystem, shell, desktop, or browser tools where the
  installed Codex runtime already provides the native tool.
- Long-polling workstation-agent topology, static bridge secrets, and generic
  unscoped userscripts or approval watchers.
- The claim that server-side auto-approval can suppress a remote MCP client's
  own confirmation UI. Host-runtime approval and ChatGPT-web UI approval are
  separate layers and require separate implementations.

### Proof required in OmniCodex

The Auth0 suite must reject wrong issuer, resource/audience, scope, `sub`,
algorithm, signature, time window, and rotated keys before creating an MCP
session. No token or raw tool data may enter logs.

## 5. CodexPro

### Evidence map

- `src/config.ts`, `src/profileStore.ts`, and `src/redact.ts`: configuration
  parsing, profile isolation, and diagnostic redaction.
- `src/http.ts`, `src/stdio.ts`, and `src/server.ts`: CLI/server transport
  composition.
- `src/codexSessions.ts`: Codex session artifact access as implemented by that
  project; comparison only.
- `chatgpt_agbrowse_bridge.py::_app_use_approval_refs` and the Oracle
  `promptComposer` patch: adopt the behavior, not project branding. The logic
  locates a dialog by configured app name, selects the conversation-memory
  option when present, and activates the strongest affirmative action. The
  OmniCodex implementation must remain configurable and exact-app scoped.
- `src/guard.ts`, `src/fsOps.ts`, `src/bashOps.ts`, and `src/workspaceOps.ts`:
  guard and low-level tool implementations used as negative/quality comparison.
- `scripts/**`, `DOMAIN_SETUP.md`, and `PUBLIC_LAUNCH_CHECKLIST.md`: deployment,
  domain, and release checklist patterns.

### Adopt

- Defensive Windows path normalization, configuration validation, redacted
  diagnostics, package CLI ergonomics, and release checklist ideas when they
  survive OmniCodex tests.

### Reject

- Codex transcript/artifact scraping as a substitute for live App Server RPC.
- Independent shell/filesystem/workspace tools as a substitute for the native
  Codex tool surface.
- Any workflow in which another agent asks a Codex model to perform the
  external AI's ordinary tool call.

## 6. DevSpace

### Evidence map

- `src/mcp-sessions.ts`: MCP session lifecycle and cleanup.
- `src/process-sessions.ts`, `src/process-platform.ts`, and
  `src/server-shutdown.ts`: child-process ownership, termination boundaries,
  and shutdown sequencing.
- `src/oauth-provider.ts` and `src/oauth-store.ts`: OAuth persistence and refresh
  comparison.
- `src/local-agent-runtime.ts` and `src/local-agent-adapters.ts`: local agent
  delegation topology, used as a negative boundary for ordinary OmniCodex
  execution.
- Adjacent `*.test.ts` files: lifecycle and recovery fixtures worth porting as
  behavior tests.

### Adopt

- Explicit MCP session ownership, child-process lifetime state, graceful drain,
  shutdown idempotency, and OAuth-store tests.

### Reject

- Local-agent task delegation or an agent loop as the execution mechanism for
  ordinary native tools.
- Workspace database, review checkpoint, or UI machinery that is not required
  by the OmniCodex gateway contract.

## 7. Secondary oracles

### CC Switch

Use only after the pinned source is locally materialized. Compare namespace
collision restoration and Responses compatibility fixtures against OpenCodex.
Disagreement triggers a runtime capture; neither project wins by reputation.

### CLIProxyAPI and codex-ollama-proxy

Port behavior-level fixtures for fragmented SSE, client disconnect,
cancellation races, provider unavailability, concurrent requests, and error
mapping. Do not import their model-proxy topology.

### AxonHub

Because the pinned tree has mixed licensing, inspect behavior and public tests
only. Do not copy source, fixtures containing protectable expression, schemas,
or generated artifacts. Recreate any useful scenario from the protocol
requirement and document the independent test.

## 8. Decision matrix

| Concern | Selected source or authority | Decision |
| --- | --- | --- |
| Actual callable surface | Installed Codex runtime capture | Exclusive authority |
| Direct App Server RPC | Installed runtime schemas/probes | Implement cleanly |
| Responses tool forms | OpenCodex + runtime capture | Port semantics/tests, not proxy topology |
| Namespace collision | OpenCodex; CC Switch second oracle | Deterministic reversible identity map |
| Host execution | Installed Codex runtime | No low-level replacement |
| Owner authentication | Auth0 standards + FAM threat cases | Clean implementation with `jose` |
| Remote transport | MCP specification and SDK | Streamable HTTP, standards first |
| Sessions/process lifetime | Runtime evidence + DevSpace tests | Port lifecycle properties |
| Windows CLI/diagnostics | Product contract + CodexPro comparisons | Clean implementation |
| Approval | Codex App Server protocol | Strongest affirmative for host prompts |
| Client confirmation UI | External client behavior | Observe and document; never falsify |
| Model invocation | Runtime provider-traffic evidence | Explicit tools only |

## 9. Change procedure

An upstream update is never consumed by floating branch name. Update this
ledger with the new commit, license diff, behavior diff, and affected
OmniCodex tests first. Then update implementation and fixtures in a separate
change. If the installed runtime disagrees with an upstream reference, the live
runtime wins and the discrepancy is retained here as evidence.

## 10. Live implementation evidence (2026-08-01)

The first runtime boundary is now implemented in the local source tree:

- Foreground CMD, PowerShell, Windows Terminal, and console creation is an
  absolute non-interference violation. Owned runtime and future tunnel children
  must use hidden/no-window process creation; unattended operation may not open
  a terminal on the user's desktop.
- The former product-version probe launched `powershell.exe` during discovery.
  It was removed because even a nominally hidden console executable can flash
  on some Windows hosts. Candidate ordering now uses read-only file metadata
  unless a non-process metadata reader is supplied. All child creation is
  confined to `hidden-child-process.ts`, and a source-wide regression test
  rejects direct `child_process` imports or console-host executables elsewhere.
- `CodexRuntimeDiscovery` scans the app-managed `%LOCALAPPDATA%\\OpenAI\\Codex\\bin`
  installation first, then WindowsApps/PATH, then an explicit path. It only
  reads metadata and never starts Codex during discovery.
- `CodexAppServerProcess` owns a separate `codex app-server --stdio` child with
  process-only `approval_policy="never"` and
  `sandbox_mode="danger-full-access"` overrides. A live smoke probe against
  `codex-cli 0.146.0-alpha.9.2` completed `initialize` and read-only
  `thread/list`; the child exited under OmniCodex ownership and the desktop
  app was not attached to or restarted.
- `JsonlRpcClient` accepts the App Server's observed JSON-lines responses even
  when the response omits the `jsonrpc` member, while preserving notifications
  and server-initiated approval requests.
- `NativeToolCatalog` calls the live `mcpServerStatus/list` endpoint. The
  installed runtime currently advertised 5 downstream servers and 79 tools in
  the probe. Names and original metadata are retained; collisions and invalid
  names use deterministic `codex__<server>__<tool>` identities.
- `NativeToolExecutor` calls `mcpServer/tool/call` directly and creates one
  `ephemeral: true` thread only when the caller did not provide a thread id.
  `omnicodex.app_server_rpc` exposes every App Server method as an escape hatch;
  model-backed methods require `invokesModel=true`.
- `StreamableHttpGateway` is loopback-bound, session-aware Streamable HTTP MCP
  with mandatory caller-supplied authorization and no wildcard CORS. The
  `JwtBearerAuthorizer` verifies issuer, audience/resource, signature/time,
  allowlisted `sub`, scopes, and a separate failure rate limit without logging
  tokens or tool payloads.

The host approval boundary now uses the installed runtime's generated
experimental App Server schema as the primary oracle. Current and legacy
command/file approvals, plus requested permission grants, are mapped to their
documented session-scoped affirmative forms. Unknown server-initiated requests
remain fail-closed. The ChatGPT companion adapter is separately app-name scoped
and polls only visible OmniCodex dialogs; it does not change or overstate MCP
server authority.

Verification at this point: TypeScript typecheck, production build, 13 Vitest
files, and 48 tests pass. Auth0 tenant provisioning, tunnel configuration,
external-client E2E, runtime update shadowing, and full browser/Computer Use
coverage remain later acceptance stages; they are not claimed by this local
slice.

## 11. Oracle/ChatGPT consent watcher adoption (2026-08-17)

`codexpro-automation` (MIT, copyright ventianima-lab) and its Oracle 0.17.1
`promptComposer` patch were inspected as behavior oracles. OmniCodex independently
adopts only the bounded Connect/Always-allow sequence, not that project's process
supervisor, browser-profile lifecycle, app registration, or generic confirmation
automation. The companion binds the exact connector ID/name, Oracle run/session,
correlation ID, MCP resource, and MCP surface; stale identity or DOM fails closed.

The non-secret successful reference run `20260816T063703Z-b6f30c4c2826` used app
`DevSpace-AutoApproval-E2E-20260816` and session
`oracle-codexpro-automation-b6f30c4c28`. This proves the reference workflow, not
OmniCodex. A fresh OmniCodex live rerun remains pending. No Chrome, Codex, OCI,
network, or process operation was performed during this adoption.
