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
| `lidge-jun/opencodex` | `357acee62458684bc027e9d524e95bd066df3a43` | MIT | Primary Responses tool-form and streaming translation oracle |
| `heelee912/full-access-mcp-public` | `60cc262bb26a0719b62ee654b15fa02bdb267dea` | MIT | Auth0/OIDC threat cases and owner-only remote admission oracle |
| `rebel0789/codexpro` | `bbc789e57012af2f46c005f5d54db17e50e1b7f0` | MIT | Windows/CLI/diagnostic and redaction comparison source |
| `Waishnav/devspace` | `0d9b60c72c2f154ef9fde918ebc9dd1335eba338` | MIT | MCP session, process lifetime, OAuth store, and shutdown comparison source |
| `farion1231/cc-switch` | `878c26f31e012ba32b9772bd080bd4fa9e7d495e` | MIT | Responses compatibility and namespace restoration second oracle |
| `router-for-me/CLIProxyAPI` | `a14dfc779f43aed588e68b31fb34ab5ced700851` | MIT | SSE, concurrency, cancellation, and transport fault fixtures |
| `michael-f-bryan/codex-ollama-proxy` | `febb37af4019cba5bec30c0bf3eef1b5b24752a6` | MIT | Local provider boundary and error-injection fixtures |
| `looplj/axonhub` | `8b708fe9219707c64582ec0d5d509716d7f5f3e5` | Apache-2.0 generally; `llm` portions LGPL-3.0 | Behavior/test inspiration only; no source copying |

The first four repositories are locally available under
`C:\Users\Master\Desktop\Projects\주식\work\repository-analysis`. The remaining
pins are review inputs and must be materialized in a separate read-only
reference cache before any line-level adoption.

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
- Turn OpenCodex regression fixtures into OmniCodex round-trip contract tests,
  with attribution.

### Reject

- The general model-provider proxy, provider routing, account pool, model alias,
  or model selection topology. OmniCodex ordinary execution is not an alternate
  model request.
- Any adapter that drops unsupported native tools to satisfy a weaker provider.
  OmniCodex must expose the installed runtime's full surface.
- Any mutation of user Codex configuration, shims, or provider state.

### Proof required in OmniCodex

`function`, `custom`, `freeform`, `tool_search`, `namespace`, unknown tool
payloads, partial UTF-8/SSE chunks, media blocks, errors, and terminal states
must round-trip through the model-free execution driver without a real provider
request.

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
  `src/chromeRemoteDebuggingApproval*.ts`: evidence of client/UI-side approval
  automation, explicitly outside OmniCodex's server authority.
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
- Long-polling workstation-agent topology, static bridge secrets, userscripts,
  Chrome approval watchers, and ChatGPT approval automation.
- The claim that server-side auto-approval can suppress a remote MCP client's
  own confirmation UI. OmniCodex controls host runtime approvals only.

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
