# OmniCodex Product Requirements Document

**Status:** Normative product contract  
**Repository:** `heelee912/omnicodex`  
**npm package:** `omnicodex`  
**Primary platform:** Windows with the Codex desktop application installed  
**Document authority:** This file is the single product and acceptance source of truth

## 1. Product decision

OmniCodex is a Windows-local TypeScript and Node.js gateway that exposes the
complete callable native tool surface of the installed Codex runtime as an
authenticated remote Streamable HTTP MCP service.

An external AI is the primary controller. An ordinary tool call executes the
requested native capability without asking a Codex model to decide what to do.
Only a caller-selected tool with `modelEffect: model` and
`invokesModel: true` may invoke a Codex model. An unclassified target cannot
execute. The gateway never silently promotes an ordinary call into a model
call.

The installed runtime is authoritative for what is callable. Documentation and
reference repositories guide translation and testing. They never justify
advertising a capability that the live runtime does not expose.

## 2. Safety priority and non-interference invariant

Preserving the user's running Codex app, Codex authentication, configuration,
plugins, MCP registrations, provider choices, and existing task continuity is
the highest-priority invariant. It overrides convenience, diagnostic speed,
feature breadth, update speed, and release schedule.

OmniCodex and its development process must never:

- terminate, restart, suspend, inject into, log out, or automate the existing
  Codex desktop app process;
- modify, replace, truncate, migrate, chmod, take ownership of, or write beside
  the user's Codex `auth.json`, `config.toml`, provider configuration, plugin
  configuration, connector configuration, MCP configuration, or app package;
- mutate shared Codex task state except for the exact persistent task operation
  explicitly selected by the authenticated caller;
- register OmniCodex as an MCP server in the user's Codex app;
- modify the installed Codex app package or any binary below its package or
  installation directories;
- reuse the desktop app's process as the OmniCodex child runtime;
- treat a successful probe as permission to change user-owned Codex state.

Before the first real Codex child-process probe, OmniCodex must implement and
pass a non-interference guard. The guard:

1. resolves the relevant Codex authentication and configuration files without
   opening them for write;
2. records path, existence, size, last-write time, file identity when available,
   and SHA-256 bytes for regular files;
3. records the running Codex desktop process and installed package identities
   without signaling or controlling either one;
4. starts a durable OmniCodex action ledger before any child launch and records
   every process created, signal sent, protected path opened, and shared-state
   mutation attempted by OmniCodex;
5. launches every OmniCodex-owned runtime with process-only overrides and
   redirects ordinary-call cache, log, temporary, and database writes to an
   OmniCodex-owned writable state directory;
6. rechecks protected files, the desktop app, the installed package, login
   continuity, and the action ledger after each probe;
7. fails closed on any protected byte change, any signal or control action
   directed at the desktop app, any OmniCodex-caused logout, or any shared task
   mutation beyond an exact explicit caller request.

The guard stores hashes only. It never logs file content. A path that cannot be
read is recorded as `unverifiable` and blocks runtime probing until it becomes
verifiable. There is no best-effort bypass. Explicit persistent task operations
are the only authorized changes to shared Codex task state. Their effects must
match the caller's exact request and must not change configuration or
authentication state.

A desktop PID or package identity change is not, by itself, proof that
OmniCodex caused interference. Windows Store servicing and the owner may restart
the app independently. Such a transition invalidates the baseline: OmniCodex
enters `BASELINE_INVALIDATED`, stops admitting new execution, correlates the OS
package and process event timeline with its action ledger, proves it sent no
signal and wrote no protected path, revalidates login and normal app use, then
takes a new baseline. If causality cannot be excluded, the gateway remains
blocked and reports the evidence. It never hides a transition merely because it
appears unrelated.

## 3. Users and jobs

### 3.1 Owner-operator

The owner is the Windows user who installs and runs OmniCodex. The owner needs
to initialize Auth0, select a remote adapter, start or stop the gateway, inspect
redacted health information, perform safe updates, and prove that the Codex app
continues to work normally.

### 3.2 External AI client

The external AI is an OAuth-authorized MCP client such as Web ChatGPT. It needs
to discover a stable compatibility surface even when the native catalog is
large. It must also be able to enumerate and call every live native tool through
the full surface.

### 3.3 Maintainer and release operator

The maintainer needs deterministic local tests, actual Windows E2E evidence,
safe rollback, a complete source adoption ledger, GitHub Windows CI, a
self-hosted GUI test lane, npm provenance, an SBOM, and reproducible release
artifacts.

## 4. Goals and measurable success

| Goal | Release metric |
| --- | --- |
| Complete live coverage | 100% of runtime-advertised tools map to a first-class `/mcp/full` tool or a lossless generic call route. No advertised tool is silently omitted. |
| No model use for ordinary calls | Actual model-provider request count and model usage are both exactly zero across the ordinary-call E2E suite. |
| Explicit model boundary | Every model-capable tool has `modelEffect: model` and `invokesModel: true`. An unknown target cannot run. A model target runs only when the caller explicitly selects it. |
| Codex continuity | Guarded Codex auth and configuration files are byte-identical before and after every probe and E2E suite. The pre-existing Codex app process and login remain usable. |
| Native fidelity | Function, custom, freeform, tool-search, namespace, and unknown tool forms round-trip without input loss. Native text, structured data, image, audio, resource, progress, cancellation, and error meaning are preserved. |
| Remote security | Every remote request passes exact OAuth resource binding, token validation, scope validation, and stable owner-subject authorization before MCP session creation. |
| Operational recovery | A child crash, unhealthy candidate, failed switch, and package rollback each reach a deterministic healthy or fail-closed state without replaying writes. |
| Real client compatibility | Official MCP Inspector and an actual external ngrok path pass. A real Web ChatGPT Pro connection passes before compatibility is claimed. |
| Release integrity | Windows CI, self-hosted GUI E2E, npm provenance, SBOM, GitHub release, and multilingual documentation are present for the same commit and package bytes. |

Gateway translation overhead is measured separately from native tool duration.
On the reference Windows host the local median overhead target is at most 20 ms
and the local p95 target is at most 75 ms for a no-op direct call. Missing these
latency targets blocks performance claims but does not permit dropping semantic
or security requirements.

## 5. Non-goals

- OmniCodex is not a replacement Codex client or a second desktop app.
- OmniCodex is not a general model proxy.
- OmniCodex does not bundle or redistribute `codex.exe`.
- OmniCodex does not install or update the Codex desktop application.
- OmniCodex does not create lower-level substitute file, shell, browser, or UI
  tools when a requested host-only native capability lacks a callable runtime
  interface.
- OmniCodex does not bypass Windows, enterprise, Auth0, browser, or managed
  policy enforcement.
- OmniCodex does not expose an unauthenticated LAN service.
- OmniCodex does not use a static bearer token as remote client identity.
- OmniCodex does not promise unlimited execution concurrency. It imposes
  bounded execution and memory admission while placing no product limit on the
  number of connected clients.
- OmniCodex does not remove the prior FAM Auth0 resource until the complete live
  OmniCodex E2E gate succeeds and the exact resource is selected for retirement.

## 6. Normative terms

| Term | Exact meaning |
| --- | --- |
| Installed runtime | A discoverable `codex.exe` already installed on Windows. |
| App Server | An OmniCodex-owned `codex.exe app-server` child that communicates through JSON-RPC. |
| Primary App Server | The child used for live discovery, existing-task operations, and explicit model functions. |
| Model-free executor | The verified execution topology used only when a native tool kind lacks a direct callable route. It is connected only to a loopback fake Responses provider. |
| Native tool | A callable App Server method or a callable downstream MCP, app, connector, plugin, host, browser, computer-use, node-repl, shell, file, image, document, or other runtime-advertised tool. |
| Ordinary call | A call whose effective target has `modelEffect: none` and `invokesModel: false`. |
| Explicit model call | A call whose target has `modelEffect: model` and `invokesModel: true` and which the external caller selected directly. |
| Ephemeral thread | A thread created with `ephemeral: true` whose runtime result has `path: null`. It must not appear in the desktop task list. |
| Persistent task | A caller-requested task created through an explicit persistent-state operation and marked with `[OmniCodex]`. Creating it and starting a model turn are separate effects. |
| Catalog revision | An opaque digest of the complete normalized live tool catalog. |
| Direct route | App Server JSON-RPC or downstream protocol invocation that requires no Responses loop. |
| Loopback route | A deterministic local Responses exchange that emits a preselected native tool call without a model. |
| Runtime probe | A bounded invocation against an OmniCodex-owned child. It never means operating the existing desktop app. |
| Drain | Stop admitting applicable new work to one runtime while handling its in-flight calls under the rules in this document. |

The words **must**, **never**, **only**, **before**, **after**, **exactly**, and
**without** are structural requirements.

### 6.1 Optional first-class ChatGPT consent companion

The package includes an optional ChatGPT-web consent companion. It may attach
only to an explicitly configured HTTP loopback CDP endpoint and never launches,
terminates, or profiles Chrome. A watch is strongly bound to the exact ChatGPT
connector ID/name, Oracle run ID, session/correlation IDs, and MCP resource and
surface. Only Connect and Always allow are eligible; one-time allowance, generic
confirmation, settings, registration, disconnect, removal, and deletion are never
clicked. Reconnect, stale run/session/DOM, ambiguous controls, and unverifiable
post-action state fail closed. Selection uses accessible role/name first with a
bounded classified fallback. Metadata-only receipts contain timestamp, bound IDs,
selector class, and before/after hashes, never screenshots, prompts, secrets, or
raw page/tool content. Timeout, cancellation, polling, and retry are bounded. The
entrypoint must not register OmniCodex MCP into the local Codex application.

## 7. Bounded contexts and ownership

| Bounded context | Owned decisions |
| --- | --- |
| Runtime Supervision | Binary discovery, process-only configuration, child lifecycle, non-interference guard, probes, health, drain, switch, crash recovery, and runtime rollback. |
| Native Tool Catalog | Discovery, source identity, tool-kind classification, name normalization, schema fallback, catalog revision, and change notification. |
| Execution Routing | Model classification, route choice, execution state, approvals, scheduler lanes, retry, timeout, cancellation, and result mapping. |
| Remote MCP Transport and Auth | Streamable HTTP MCP, sessions, OAuth metadata and validation, protected resources, rate limits, CORS, and redacted audit events. |
| Lifecycle CLI | Initialization, configuration, process lifecycle, diagnostics, autostart, Auth0 operations, tunnel selection, package update, and rollback. |

Domain objects in these contexts perform no filesystem, process, network, time,
or random I/O. Application services depend on ports. Infrastructure adapters
implement those ports. No class or service may be named only `Manager`,
`Handler`, `Processor`, `Util`, `Common`, or `Misc`.

## 8. Runtime source of truth and binary discovery

### 8.1 Source of truth order

The live installed runtime is authoritative in this order:

1. successful App Server `initialize` response;
2. live App Server method and schema discovery responses;
3. live downstream MCP, app, connector, plugin, and host capability responses;
4. the exact `tools` arrays emitted by captured Responses requests;
5. exhaustive lazy `tool_search`, namespace, and pagination discovery;
6. observed successful probes;
7. installed binary version metadata;
8. official documentation;
9. reference repositories and prior observations.

A lower source cannot override a contradictory higher source. A capability seen
in a previous build but absent from one current discovery path enters
`RECONCILING`; it is not removed until every applicable live path above has been
exhausted and the runtime authoritatively reports absence. Login, entitlement,
configuration, permission, or lazy-loading gaps are availability states, not
proof that the capability structurally does not exist. Catalog removal and
`notifications/tools/list_changed` occur only after that reconciliation.

### 8.2 Binary candidate discovery order

Candidates are found in this fixed group order:

1. `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`
2. WindowsApps aliases and then the resolved `PATH` command
3. the absolute path supplied in OmniCodex configuration

Within the first group candidates are sorted by parseable file product version
descending. Ties use last-write time descending and then absolute path ordinal
ascending. WindowsApps and `PATH` resolutions are canonicalized and
deduplicated. The explicit path is last because it is a recovery override under
this product contract. It is never copied.

The first candidate that passes the complete shadow probe becomes eligible.
Failure of one candidate moves to the next candidate in the same group and then
to the next group. No candidate is executed before the non-interference guard is
implemented and its pre-probe snapshot succeeds.

### 8.3 Prior observations

The most recent prior local observation reported Codex
`0.145.0-alpha.30`. A standalone App Server returned `path: null` for
`thread/start` with `ephemeral: true`. Direct `mcpServer/tool/call` executed
`node_repl`. Browser Agent and Computer Use initialized. More than 350
downstream tools were observed and roughly 285 belonged to `codex_apps`. A
synthetic local Responses provider executed a native `shell_command` without a
real model.

These facts select focused regression probes. They are not permanent truth and
must be revalidated once per candidate build. The same probe is not repeated
unless the runtime changed, the relevant configuration changed, or a prior
result is ambiguous.

## 9. Process isolation and configuration topology

### 9.1 Primary App Server

The primary child uses the installed binary and the same logical read-visible
runtime state needed to discover existing tasks, apps, plugins, connectors,
downstream MCP servers, and host tools. Authentication, provider, plugin,
connector, MCP, and user configuration remain read-only by contract. All safety
settings are passed as child-process or thread request overrides. Ordinary-call
cache, log, temporary, and SQLite writes are redirected to OmniCodex-owned
state. Shared Codex task state may change only for the exact persistent
operation explicitly selected by the caller.

The child is started with:

- `approval_policy=never`;
- `danger-full-access`;
- a distinct process identity and standard I/O pipes owned by OmniCodex;
- an OmniCodex correlation identifier;
- no mutation of the desktop app process or package.

The primary child handles:

- initialization and native surface discovery;
- direct App Server JSON-RPC;
- direct downstream MCP and plugin calls;
- existing persistent task read and lifecycle operations;
- explicit `thread/start`, `turn/start`, and multi-agent functions;
- any native operation that can execute directly without a Responses model
  exchange.

### 9.2 Model-free executor

The model-free executor exists only for tool forms that have no direct runtime
RPC or downstream callable path. Its provider base URL is a randomly assigned
`127.0.0.1` port owned by the same gateway process. Its provider credentials are
synthetic and valid nowhere else.

The gateway first probes whether a thread-level provider override can bind one
ephemeral primary-child thread to the loopback fake provider. The probe must
prove that:

- the override affects only that thread;
- the request reaches the loopback provider;
- no request reaches a real model provider;
- the user Codex config remains byte-identical;
- another primary thread retains its normal configuration.

If all conditions pass, the primary child supplies isolated model-free threads.
If any condition is unsupported or unprovable, OmniCodex starts a second App
Server from the same installed binary. The second child receives a
process-only provider override and an OmniCodex-owned runtime directory under
`%LOCALAPPDATA%\OmniCodex\runtime\<instance-id>`. It receives the same
read-visible native tool configuration as the primary without permission to
write protected files and without any real model credential. Its discovered
ordinary-tool catalog must be parity-equal to the primary for every
loopback-required target. A secondary that narrows the native surface is
rejected; OmniCodex never substitutes a low-level replacement tool. It never
replaces the primary child.

There is no fallback from a failed model-free executor to a real provider or a
Codex model. A loopback-required call fails closed with
`MODEL_FREE_EXECUTOR_UNAVAILABLE`.

### 9.3 Deterministic loopback Responses exchange

The loopback provider is a protocol executor rather than a model. For each call:

1. the router creates a random one-use execution nonce and an immutable planned
   native call;
2. the runtime sends a Responses request whose synthetic model identifier
   carries that nonce;
3. the provider rejects an unknown, expired, reused, or mismatched nonce;
4. the provider ignores prompt prose and emits exactly the planned tool call;
5. the runtime executes that native tool;
6. the runtime returns the tool output to the loopback provider;
7. the provider returns a terminal empty model response with no additional call.

The provider cannot select a second tool. More than one emitted tool call,
changed arguments, a missing output, or an unexpected request phase is a
protocol violation. The call fails and the executor enters `FAULTED` until
re-probed.

## 10. Runtime and executor state machines

### 10.0 Absolute no-visible-console invariant

OmniCodex must never open a foreground Command Prompt, PowerShell, Windows
Terminal, or other console window on the user's desktop. This is an absolute
product invariant for initialization, normal operation, recovery, updates,
tunnels, diagnostics, and autostart. Every owned console child uses hidden/no
window process creation. Interactive status and logs are shown only inside the
terminal from which the user explicitly invoked a CLI command; unattended
operation never creates a new visible terminal. A dependency that cannot run
without creating a foreground console is incompatible and must not be launched.

### 10.1 Primary runtime state machine

| Current state | Event | Required next state and action |
| --- | --- | --- |
| `STOPPED` | gateway starts | `DISCOVERING`; take the pre-probe non-interference snapshot. |
| `DISCOVERING` | candidate found | `SHADOW_STARTING`; start an OmniCodex-owned child. |
| `DISCOVERING` | no candidate | `BLOCKED`; expose diagnostics only. |
| `SHADOW_STARTING` | child handshake succeeds | `PROBING`; run the fixed probe suite. |
| `SHADOW_STARTING` | timeout or exit | `REJECTED`; record redacted evidence and try the next candidate. |
| `PROBING` | probes and post-probe guard pass | `READY`; publish the catalog atomically. |
| `PROBING` | probe or guard fails | `REJECTED`; stop only the OmniCodex child and try the next candidate. |
| `READY` | healthier new candidate passes | `DRAINING`; retain the old runtime as rollback target. |
| `READY` | unexpected child exit | `RECOVERING`; reject writes and start the last known healthy candidate. |
| `DRAINING` | eligible work completes | `SWITCHING`; atomically publish the new runtime and catalog pointers. |
| `DRAINING` | non-replayable write remains at deadline | `READY`; abort the update and keep the old runtime. |
| `SWITCHING` | switch-window health passes | new child `READY`; old child `STANDBY` until rollback window ends. |
| `SWITCHING` | new child fails | `ROLLING_BACK`; atomically restore the old runtime and catalog. |
| `ROLLING_BACK` | old child healthy | old child `READY`; reject the new candidate. |
| `RECOVERING` | known healthy child passes | `READY`; rebuild and publish the catalog. |
| `RECOVERING` | no healthy child | `BLOCKED`; fail all execution closed and keep diagnostics available. |
| any active state | desktop PID or package identity changes independently | `BASELINE_INVALIDATED`; stop admission, correlate OS events with the durable action ledger, revalidate protected files, login, and normal app use, then establish a new baseline or enter `BLOCKED`. |

Only an OmniCodex-owned child may be stopped. A desktop app process identity is
never a valid stop target.

### 10.2 Model-free executor state machine

| Current state | Event | Required next state and action |
| --- | --- | --- |
| `UNNEEDED` | catalog gains a loopback-required tool | `PROBING_THREAD_OVERRIDE`. |
| `PROBING_THREAD_OVERRIDE` | isolated proof passes | `THREAD_OVERRIDE_READY`. |
| `PROBING_THREAD_OVERRIDE` | unsupported or unprovable | `STARTING_SECONDARY`. |
| `STARTING_SECONDARY` | isolated child starts | `PROBING_SECONDARY`. |
| `PROBING_SECONDARY` | loopback and guard proofs pass | `SECONDARY_READY`. |
| `PROBING_SECONDARY` | any proof fails | `FAULTED`. |
| `THREAD_OVERRIDE_READY` or `SECONDARY_READY` | protocol violation or child failure | `FAULTED`; fail new loopback-required calls. |
| `FAULTED` | bounded re-probe passes | prior ready state. |
| any ready state | runtime switch starts | `DRAINING`; complete eligible calls then rebuild against the candidate. |

Direct ordinary calls remain available when only the model-free executor is
faulted.

## 11. Execution route decision

The router applies these rules in order for every effective target:

1. Resolve the current catalog identity and reject a stale revision when the
   caller required one.
2. Enforce `modelEffect`. An ordinary generic tool cannot target a model tool,
   and an `unknown` target cannot execute until classified.
3. Enforce `stateEffect`; a generic mutating target requires the explicit
   persistent-state gate.
4. Validate the public input against the catalog schema or its fixed fallback.
5. If a direct App Server JSON-RPC method exists, call it.
6. Otherwise if the owning downstream MCP, app, connector, or plugin exposes a
   direct callable protocol, call that protocol.
7. Otherwise if the tool kind is Responses `function`, `custom`, `freeform`,
   `tool_search`, `namespace`, or unknown and the model-free executor is ready,
   use the deterministic loopback exchange.
8. Otherwise return `UNSUPPORTED_NATIVE_ROUTE`.

A direct route always wins over loopback. Similar low-level behavior never
replaces a missing native route. Route choice and effective model classification
are included in redacted operation metadata.

## 12. Thread and task semantics

### 12.1 Ordinary execution

An ordinary call does not create persistent task state. If the native route
requires a thread, the gateway lazily creates an ephemeral thread with:

```json
{
  "ephemeral": true
}
```

`path` is a response assertion, not an input override. The runtime response must
confirm `path: null`. A non-null path is a safety failure. The thread is scoped
to one MCP session and one runtime role. It is never surfaced in the desktop
task list and is discarded when the session ends or the runtime changes.

Caller attempts to set `ephemeral: false`, a task path, or persistent task
metadata through an ordinary tool are rejected with
`PERSISTENCE_NOT_ALLOWED_FOR_ORDINARY_CALL`.

### 12.2 Explicit persistent operations

Model invocation and persistent-state mutation are independent classifications.
`thread/start` creates thread state but does not automatically count as a model
call; its `modelEffect` is established by observed provider traffic for the
installed runtime. `turn/start` invokes a model. Each multi-agent method is
classified by its actual runtime route instead of by its name. Calling a
first-class model tool is the required explicit caller decision. A generic
`app_server_rpc` request for a model-capable method additionally requires
`"allowModelInvocation": true`; a request that mutates shared task state
additionally requires `"allowPersistentStateMutation": true`.

An explicit persistent `thread/start` defaults to `ephemeral: false`. Its title
is normalized to `[OmniCodex] <caller title>`. If no title is supplied, the
gateway uses `[OmniCodex] <UTC timestamp>`. An existing prefix is not duplicated.

`thread/read` and `thread/list` access persistent state without mutating it.
`thread/archive` mutates persistent state but does not invoke a model when the
runtime implements it as a direct lifecycle method. All are ordered by thread
key where applicable. `turn/start` for an existing thread is always a model
call. The caller may explicitly create an ephemeral thread and then start a
model turn in it; the creation and model invocation remain two separately
classified operations, and the thread creation must return `path: null`.

No generic tool can hide a model-capable target behind an ordinary metadata
value.

## 13. Native tool catalog

### 13.1 Catalog identity

Each catalog record has an immutable identity derived from:

```text
kind NUL origin NUL nativeNamespace NUL nativeName
```

The public `toolId` is a lowercase base32 SHA-256 digest of that identity.
Schemas, descriptions, annotations, routes, and health are versioned attributes
and do not change `toolId`.

The catalog revision is a SHA-256 digest of the canonical sorted records. It
changes when a tool is added or removed or when any public schema, metadata,
route, or model classification changes.

### 13.2 Name preservation and collision handling

A native name is preserved only when all conditions hold:

- it matches `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`;
- it does not begin with the reserved `codex__` prefix;
- exactly one live tool has that name;
- it does not collide with a stable compatibility tool.

If any condition fails, every member of the collision set is normalized as:

```text
codex__<encoded-namespace>__<encoded-name>
```

Each encoded segment uses lowercase unpadded base32 over the original UTF-8
bytes and begins with `b32_`. If the full name would exceed 128 characters, the
name segment becomes `h_<first-24-hex-of-SHA256(identity)>`. The full original
identity remains in `_meta.omnicodex`, so normalization remains reversible.

A residual collision appends `__h_<first-12-hex-of-SHA256(identity)>`.
Canonical identity sorting makes the result deterministic across restarts.

### 13.3 Required metadata

Every first-class tool contains:

```json
{
  "_meta": {
    "omnicodex": {
      "toolId": "stable digest",
      "nativeName": "exact original name",
      "nativeNamespace": "exact original namespace",
      "kind": "app_server|function|custom|freeform|tool_search|namespace|mcp|app|connector|plugin|host|unknown",
      "origin": "runtime supplied origin",
      "route": "app_server_rpc|downstream_direct|loopback_responses",
      "modelEffect": "none|model|unknown",
      "invokesModel": false,
      "stateEffect": "none|read|mutate",
      "readOnly": false,
      "destructive": false,
      "retryClass": "read_once|never",
      "catalogRevision": "opaque digest"
    }
  }
}
```

Unknown safety classification defaults to `readOnly: false`,
`destructive: true`, and `retryClass: never`. Unknown model classification is
represented as `modelEffect: unknown` and `invokesModel: null`; it is not
silently converted into either an ordinary or a model tool. Execution and
release remain blocked for that target until a no-provider proof establishes
`none` or observed real-provider traffic establishes `model`.

### 13.4 Exhaustive catalog capture passes

Each candidate build must complete and reconcile all of these passes:

1. App Server initialization, method schemas, and capability discovery;
2. downstream MCP, app, connector, plugin, and host enumeration;
3. Responses-request capture of every exact runtime-emitted `tools` array;
4. recursive `tool_search`, namespace expansion, and every continuation page;
5. comparison with prior-version evidence and targeted probes for every missing
   identity.

The active catalog records the evidence source and availability state for every
identity. Authentication, entitlement, configuration, permission, or transient
loading failures remain visible diagnostic states. They do not reduce the
claimed denominator or become structural absence without authoritative runtime
evidence.

## 14. Tool-kind schemas and fallback schemas

The public schema is the valid native JSON object schema when one is advertised.
Invalid schemas are not repaired silently. The catalog records the validation
error and uses the fixed wrapper for that kind.

| Native kind | Public input schema rule |
| --- | --- |
| JSON function or direct MCP tool | Preserve a valid object schema. If absent or invalid use `{ "type":"object", "properties":{"arguments":{"type":"object","additionalProperties":true}}, "required":["arguments"], "additionalProperties":false }`. |
| Custom or freeform | Exactly `{ "type":"object", "properties":{"input":{"type":"string"}}, "required":["input"], "additionalProperties":false }`. |
| Tool search | Preserve a valid schema. Otherwise require `query` string and allow `limit` integer from 1 through 100 with default 20. |
| Namespace dispatcher | Preserve a valid schema. Otherwise require `toolName` string and `arguments` object. |
| App Server method | Preserve a discovered object params schema. Otherwise require `params`, whose JSON Schema is unconstrained. |
| Unknown | Require `payload` with unconstrained JSON value and allow optional `contentType` string. |

The fallback wrapper is removed before native invocation and restored in
diagnostic metadata. Custom and freeform `input` is never parsed as JSON.
Unknown `payload` preserves JSON scalar, array, object, boolean, and null values.

## 15. MCP transport and session contract

### 15.1 Protocol versions

The first release supports MCP `2025-06-18` and `2025-03-26`. The server selects
the client's supported version during initialization. An unsupported version
receives a JSON-RPC invalid-request error with the supported version list. A
future version is not accepted merely because its string sorts later.

### 15.2 HTTP behavior

The gateway listens on `127.0.0.1:48765` by default. It exposes:

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- `POST /mcp/full`
- `GET /mcp/full`
- `DELETE /mcp/full`

`POST` accepts MCP JSON-RPC and honors `Accept: application/json` and
`text/event-stream`. `GET` opens the server-to-client event stream for an
initialized session. `DELETE` closes only the identified MCP session. Session
requests after a gateway restart receive `SESSION_INVALID` and must initialize
again.

`Mcp-Session-Id` values contain 256 bits of randomness and no user data.
Sessions are bound to the validated issuer, subject, client identifier, resource,
and endpoint surface. They cannot move between `/mcp` and `/mcp/full`.

### 15.3 `/mcp` stable tools

`tools/list` on `/mcp` returns only the stable core:

1. `search_native_tools`
2. `call_native_tool`
3. `app_server_rpc`

Additional stable core tools require a future PRD change. Large live catalogs
never expand this list.

`search_native_tools` input is:

```json
{
  "query": "optional text",
  "namespace": "optional exact namespace",
  "kind": "optional exact kind",
  "modelEffect": "optional none|model|unknown",
  "stateEffect": "optional none|read|mutate",
  "limit": 50,
  "cursor": "optional opaque cursor"
}
```

All fields are optional. `limit` defaults to 50 and ranges from 1 through 200.
Results contain `toolId`, public name, native identity, description, kind,
model effect, derived model flag, state effect, route, current revision, and
next cursor. Omitting the effect filters searches all classifications.

`call_native_tool` accepts exactly one of `toolId` or `name`:

```json
{
  "toolId": "optional stable identity",
  "name": "optional current public name",
  "arguments": {},
  "input": "custom or freeform input only",
  "payload": "unknown-kind payload only",
  "expectedCatalogRevision": "optional",
  "timeoutMs": 60000,
  "ordering": {
    "threadId": "optional",
    "processId": "optional",
    "filePaths": ["optional absolute paths"]
  }
}
```

It rejects targets with `modelEffect: model` or `modelEffect: unknown`. For
custom and freeform tools only `input` is accepted. For unknown tool kinds only
`payload` is accepted after their model effect has been classified as `none`.
Other tools use `arguments`.

`app_server_rpc` input is:

```json
{
  "method": "exact App Server method",
  "params": {},
  "allowModelInvocation": false,
  "allowPersistentStateMutation": false,
  "expectedCatalogRevision": "optional",
  "timeoutMs": 60000
}
```

The default for `allowModelInvocation` is `false`. A model-capable method fails
with `MODEL_INVOCATION_NOT_EXPLICIT` unless it is `true`.
The default for `allowPersistentStateMutation` is `false`. A state-mutating
method fails with `PERSISTENT_STATE_MUTATION_NOT_EXPLICIT` unless it is `true`.
The stable `app_server_rpc` dispatcher advertises `modelEffect: dynamic`,
`invokesModel: null`, and `stateEffect: dynamic` because its effective target is
selected at call time. Before dispatch, the target method must resolve to a
known catalog classification; an unknown classification fails closed.

### 15.4 `/mcp/full`

`tools/list` on `/mcp/full` returns every live first-class catalog tool. Results
are sorted by public name and then `toolId`. The page size defaults to 100 and
the maximum is 500. Its opaque cursor binds the endpoint, owner, filter-free
catalog revision, and last identity. A cursor from an old revision fails with
`CATALOG_CHANGED`; the client restarts listing from the first page.

When the catalog revision changes, every initialized session that declared tool
change support receives `notifications/tools/list_changed`. The next list
returns the complete new view. A client that does not support the notification
still receives revision metadata on every tool.

`tools/call` takes the exact first-class tool schema. It resolves the tool in the
same catalog revision visible at dispatch. A tool removed between admission and
dispatch fails without executing.

## 16. Content, streaming, progress, and error mapping

### 16.1 Content mapping

| Native content | MCP representation |
| --- | --- |
| Text | `TextContent` with bytes decoded only under the declared character encoding. |
| JSON object or array | `structuredContent`; a native textual representation is included only if the native result supplied one. |
| Image | `ImageContent` with exact MIME type and base64 bytes. |
| Audio | `AudioContent` with exact MIME type and base64 bytes. |
| Embedded resource | `EmbeddedResource` when within inline limits. |
| Large file or blob | OAuth-protected `ResourceLink`. |
| Unknown native block | Lossless object in `structuredContent` plus `_meta.omnicodex.nativeContentType`; no invented prose. |

The gateway preserves native content ordering. It does not tokenize base64 as
text when the native result identifies media.

Text larger than 256 KiB and binary content larger than 1 MiB becomes a
protected resource. Smaller content may also become a resource when the total
response would exceed 2 MiB.

### 16.2 Streaming and progress

Native progress events are emitted in source order and keep their native
progress values. MCP progress tokens are mapped per call and never reused
across sessions. Streamable results use SSE event identifiers that increase
within the session. The in-memory resumable event ring retains at most 1,024
events or 10 minutes, whichever expires first.

A reconnect with a valid `Last-Event-ID` replays only retained events for that
same owner and session. A missing event range returns `EVENT_HISTORY_EXPIRED`;
it does not silently skip data.

### 16.3 Error taxonomy

Authentication and admission errors occur before MCP execution:

- `401` for missing or invalid credentials;
- `403` for valid credentials lacking scope, resource binding, or owner access;
- `429` for authentication failure rate limiting;
- `413` for an HTTP body over the configured limit;
- `415` for an unsupported content type.

Authorized MCP failures use JSON-RPC error data with these stable codes:

| Code | Symbol | Meaning |
| --- | --- | --- |
| `-32001` | `RUNTIME_UNAVAILABLE` | No healthy runtime for the route. |
| `-32002` | `NATIVE_TOOL_NOT_FOUND` | Target identity is absent. |
| `-32003` | `SCHEMA_MISMATCH` | Public input failed validation. |
| `-32004` | `UNSUPPORTED_NATIVE_ROUTE` | No faithful callable path exists. |
| `-32005` | `NATIVE_CALL_FAILED` | Native route returned failure. |
| `-32006` | `CANCELLED` | Call was cancelled before completion. |
| `-32007` | `TIMEOUT` | The call reached its deadline. |
| `-32008` | `CATALOG_CHANGED` | The supplied cursor or revision is stale. |
| `-32009` | `OVERLOADED` | Admission or stream backpressure limit was reached. |
| `-32010` | `MODEL_INVOCATION_NOT_EXPLICIT` | A model target was hidden behind an ordinary call. |
| `-32011` | `RESOURCE_EXPIRED` | Protected result resource is absent or expired. |
| `-32012` | `POLICY_BLOCKED` | Windows, enterprise, or managed policy denied the action. |
| `-32013` | `SESSION_INVALID` | Session is absent, expired, restarted, or identity-mismatched. |
| `-32014` | `MODEL_FREE_EXECUTOR_UNAVAILABLE` | Loopback execution cannot be proven safe. |
| `-32015` | `NON_INTERFERENCE_GUARD_FAILED` | Protected Codex continuity could not be proven. |
| `-32016` | `EVENT_HISTORY_EXPIRED` | Requested stream events are no longer retained. |
| `-32017` | `PERSISTENCE_NOT_ALLOWED_FOR_ORDINARY_CALL` | An ordinary call requested persistent task state. |

Native JSON-RPC code, message, and structured data are retained under
`error.data.native` after secret redaction. Stack traces and local secret paths
are never returned remotely. A native tool-level failure becomes an MCP
`isError: true` result when the native protocol defines it as a tool result.
Protocol and routing failures remain JSON-RPC errors.

## 17. Scheduler, ordering, and backpressure

### 17.1 Admission

There is no configured maximum number of TCP connections or MCP sessions.
Execution admission is bounded by:

- 2,048 queued calls globally;
- 64 MiB of serialized queued input globally;
- 128 queued calls per MCP session;
- 8 MiB of serialized queued input per MCP session;
- 2 MiB maximum HTTP request body.

Exceeding a limit returns `OVERLOADED` with a `retryAfterMs` estimate before the
native route begins. Admission is fair by validated owner and then session.

### 17.2 Lanes

| Lane | Fixed behavior |
| --- | --- |
| Independent read | Parallel pool size `max(8, min(64, logicalCpuCount * 4))`. |
| Shell | Dynamic pool with minimum 2 and maximum `min(16, max(2, floor(logicalCpuCount / 2)))`. It changes by one slot no more often than every 30 seconds based on queue delay and recent failure rate. |
| Same thread | FIFO exclusive ordering for the same thread identity. |
| Same process | FIFO exclusive ordering for lifecycle and input operations on the same native process. |
| Same file | FIFO ordering for writes to the canonical path. Reads wait behind an earlier write. Multiple file keys are acquired in ordinal path order to avoid deadlock. |
| Browser, Chrome, Computer Use | One shared global serial lane with round-robin fairness across sessions. |
| Node REPL | One global serial lane. |
| Explicit model | Bounded by the primary runtime's advertised capacity and thread ordering. It never consumes a model-free executor slot. |

An operation acquires every required keyed lane before dispatch. If acquisition
cannot complete by its deadline, it fails without partial execution.

### 17.3 Default timeouts

| Class | Default | Maximum caller value |
| --- | --- | --- |
| Catalog and read | 60 seconds | 5 minutes |
| Shell and background process start | 10 minutes | 60 minutes |
| Browser, Chrome, Computer Use | 5 minutes | 30 minutes |
| Node REPL | 2 minutes | 10 minutes |
| Explicit model turn | 30 minutes | 120 minutes |

The CLI may configure lower defaults. It cannot exceed these maxima without a
future PRD change.

### 17.4 Cancellation

A queued call is removed immediately. An active call receives the native
cancellation signal when supported. The gateway waits up to five seconds for
acknowledgment. If cancellation cannot be confirmed, the client receives
`CANCELLED` with `nativeCancellationConfirmed: false` and any late result is
suppressed from that client. The gateway does not kill the shared primary App
Server to cancel one call.

A write whose cancellation is unconfirmed remains tracked until the native
route terminates so ordering is not released early. Cancellation never implies
rollback.

### 17.5 Retry

Only a catalog-classified read-only and non-destructive call can retry. It may
retry once after an unexpected runtime restart only when no content or progress
has been emitted and the native route never acknowledged a state-changing
phase. Writes, destructive calls, unknown classifications, explicit model
calls, browser input, process input, and calls with partial output never retry.

### 17.6 Slow consumers

Each SSE stream may buffer 1 MiB or 256 unsent events. The producer is paused
when possible. If the native producer cannot pause and the limit remains
exceeded for 15 seconds, the gateway requests cancellation and closes the
stream with `OVERLOADED`. A state-changing operation remains internally tracked
to completion even after the client disconnects.

## 18. Approval behavior

Every eligible child or thread is launched with `approval_policy=never` and
`danger-full-access` through process-only or request-only overrides. If a native
protocol still emits an approval request, the gateway selects the strongest
affirmative response represented by that protocol.

Approval has two distinct enforcement layers:

1. The host-runtime layer is owned by the gateway. It answers the installed
   App Server's documented command, file-change, legacy, and permission
   approval requests with the strongest affirmative response supported by the
   advertised schema (`acceptForSession`, `approved_for_session`, or a
   session-scoped requested permission grant).
2. A remote MCP client may independently show its own confirmation UI. The
   server cannot suppress that UI. For the supported ChatGPT-web distribution
   path, OmniCodex therefore includes an app-name-scoped companion approval
   adapter derived from the proven CodexPro automation behavior. It selects
   “remember in this conversation” and the strongest visible affirmative
   action for OmniCodex dialogs only. Other MCP clients need an equivalent
   client-side policy or adapter.

Neither layer weakens managed policy. An OS or enterprise denial returns
`POLICY_BLOCKED`. An approval shape that cannot be interpreted safely also
returns `POLICY_BLOCKED`; it is never guessed or treated as user input.

## 19. OAuth and Auth0 security contract

### 19.1 Dedicated Auth0 resource

The existing Auth0 tenant is reused. `auth setup` creates or validates one
dedicated OmniCodex API. It has one required permission:

```text
omnicodex:full
```

The Auth0 API identifier is the configured audience. The configured public MCP
resource URI maps one-to-one to that API identifier. Reusing an unrelated API
audience is forbidden.

### 19.2 Metadata

The public ingress exposes unauthenticated standards metadata at:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp/full`

Each document identifies the exact resource URI, Auth0 authorization server,
supported bearer method, and `omnicodex:full` scope. Authorization-server
metadata is fetched from the exact configured issuer. OmniCodex does not forge
or rewrite Auth0 metadata.

### 19.3 Authorization flow and DCR

Authorization Code with PKCE is required. Only `S256` is accepted. The client
requests `offline_access` when it needs refresh tokens. Implicit flow, password
grant, and PKCE `plain` are unsupported.

Dynamic Client Registration is enabled and tested where the Auth0 tenant policy
permits it. A dynamically registered client must be public with:

- token endpoint authentication method `none`;
- grant types `authorization_code` and `refresh_token`;
- response type `code`;
- exact HTTPS redirect URIs;
- no wildcard redirect URI;
- no client-supplied privileged scope beyond `omnicodex:full`.

If tenant policy prevents DCR, `auth status` reports
`externalPrerequisite: auth0_dcr_disabled`. Static public-client setup may be
used for development but does not satisfy the release DCR gate.

### 19.4 Token validation

Every request validates all conditions before MCP session lookup:

1. compact JWS structure with no critical unsupported header;
2. `RS256` algorithm only;
3. signature against the issuer's HTTPS JWKS;
4. known `kid`;
5. exact normalized issuer including trailing slash;
6. audience array containing the dedicated audience;
7. request resource URI exactly matching the endpoint metadata;
8. configured audience-to-resource binding;
9. `omnicodex:full` in the space-delimited scope claim;
10. non-expired `exp`;
11. valid `nbf` and `iat` when present;
12. maximum 60-second clock tolerance;
13. registered `azp` or `client_id` when that claim is present;
14. stable owner identity allowlist match on exact `issuer + NUL + sub`.

Email, display name, IP address, or client ID never substitutes for owner
subject authorization. Tokens with `alg: none`, HS algorithms, missing `kid`,
wrong issuer, wrong audience, wrong resource binding, missing scope, expired
time, future `nbf`, invalid signature, or unapproved subject fail closed.

JWKS is cached for 10 minutes. An unknown `kid` causes exactly one immediate
refresh. Refresh failure never falls back to a stale unknown key. Previously
known unexpired keys may remain usable until cache expiry. The JWKS rotation
acceptance test covers overlap and retirement.

### 19.5 Owner allowlist

The initial owner completes an interactive Auth0 login. The validated stable
`sub` and issuer pair is proposed for the allowlist. Noninteractive setup
requires an explicit `--owner-sub` and exact issuer. Adding or removing an owner
is an authenticated local CLI action and updates DPAPI-protected state
atomically.

## 20. Secrets, resources, logging, and abuse controls

### 20.1 Secret storage

Windows Credential Manager is the primary secret store. Credential target names
use `OmniCodex/<purpose>/<installation-id>`. DPAPI CurrentUser encrypted storage
is the fallback only when Credential Manager is unavailable. Non-secret config
contains opaque secret references.

Secrets are accepted from an interactive masked prompt or standard input.
Secret command-line flags are forbidden because command lines are observable.
Environment-provided secrets exist for one process and are not persisted unless
the caller explicitly selects storage.

### 20.2 Protected result resources

Large results are encrypted at rest with AES-256-GCM. The per-installation key
is protected by DPAPI CurrentUser. Files live under
`%LOCALAPPDATA%\OmniCodex\cache\resources`.

Resource identifiers contain 256 random bits. A resource is bound to issuer,
owner subject, originating MCP session, MIME type, and digest. Default lifetime
is 10 minutes. A resource may be fetched repeatedly by the same authorized
owner and session until expiry. Expired files are deleted during access and
startup cleanup. Local filesystem paths are never returned to remote clients.

### 20.3 CORS and host checks

The default CORS allowlist is empty. `Access-Control-Allow-Origin: *` is never
emitted. Configured origins are exact scheme, host, and port triples. Requests
with an unrecognized `Origin` are rejected before authentication. Host and
forwarded-host validation use the configured public URL and trusted adapter
identity. Arbitrary forwarded headers are ignored.

### 20.4 Rate limits

Authentication failures use a token bucket per source address with burst 20 and
refill 10 per minute. A valid token for an unapproved subject also uses a bucket
per issuer-subject digest with burst 10 and refill 5 per minute. Responses use a
uniform body that does not reveal whether issuer, signature, scope, or owner
authorization failed.

Authorized execution has no request-rate product quota. It remains subject to
the scheduler admission limits.

### 20.5 Logs

Operations logs contain timestamp, correlation ID, owner-subject digest,
endpoint, public tool identity, route, duration, byte counts, state transition,
and redacted outcome. They never contain:

- raw arguments or results;
- OAuth tokens, cookies, authorization codes, or refresh tokens;
- Auth0 management credentials;
- Codex authentication or configuration content;
- command-line secret values;
- private file content;
- image or audio bytes.

Logs roll at 1 MiB. Ten files are retained for no more than seven days.
`omnicodex logs` applies a second redaction pass before display.

## 21. Local endpoints and readiness

| Endpoint | Exposure | Behavior |
| --- | --- | --- |
| `/healthz` | Loopback and adapters | Returns only `ok` when the gateway process responds. No version or dependency details. |
| `/readyz` | Loopback only by default | Returns structured redacted readiness for guard, runtime, catalog, auth, and selected adapter. |
| OAuth protected-resource metadata | Public | Unauthenticated standards metadata only. |
| `/resources/<opaque-id>` | Public with OAuth | Serves an owner-bound unexpired resource. |
| `/mcp` and `/mcp/full` | Public with OAuth | MCP surfaces defined above. |

Metrics are disabled by default. Enabling them requires a loopback-only endpoint
and never includes native argument or result labels.

## 22. Configuration and data paths

The implementation uses these fixed per-user paths:

```text
%LOCALAPPDATA%\OmniCodex\
  config\config.json
  state\state.json
  state\events.jsonl
  run\gateway.pid
  run\gateway.lock
  runtime\<instance-id>\
  cache\resources\
  logs\
  releases\<version>\
  current\
```

`config.json` is UTF-8 JSON with an explicit schema version. It contains no
secret. Durable state writes use temp-file, flush, and atomic replace. The event
journal contains only redacted lifecycle facts and is compacted after a valid
state snapshot.

Configuration precedence is:

1. explicit CLI option;
2. `OMNICODEX_*` environment value;
3. `config.json`;
4. the defaults in this PRD.

Secrets do not follow this precedence unless supplied through standard input or
a credential-store reference.

The gateway lock is per Windows user. A second start is idempotent when the
recorded process is healthy and returns a conflict when the lock is stale but
cannot be safely reconciled.

## 23. CLI contract

### 23.1 Common behavior

The package executable is `omnicodex`. Every command supports `--json`.
Interactive commands support `--non-interactive`. In JSON mode stdout contains
one JSON result object. Progress and diagnostics go to stderr and contain no
secret. Commands are idempotent where stated.

Common exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | Invalid command or option. |
| `3` | Required configuration absent. |
| `4` | Authentication or authorization failure. |
| `5` | Installed runtime unavailable. |
| `6` | Gateway or dependency unhealthy. |
| `7` | Lifecycle conflict or lock conflict. |
| `8` | Selected external executable or service unavailable. |
| `9` | Externally blocked release prerequisite or partial migration. |

### 23.2 Commands

| Command | Exact default behavior |
| --- | --- |
| `npx @heelee912/omnicodex init` | Runs the setup wizard. It creates OmniCodex-owned directories, writes non-secret config, creates an installation ID, configures Auth0, selects ngrok, and runs local non-runtime diagnostics. It does not start a Codex child until the non-interference guard exists and passes. |
| `omnicodex start` | Acquires the user lock, validates config and secrets, takes the guard snapshot, starts OmniCodex children, then starts the selected adapter. Repeating it against a healthy process succeeds without starting another process. |
| `omnicodex stop` | Stops admission, drains under the update rules, stops only OmniCodex-owned children and adapter, and releases the lock. It never targets the desktop app. |
| `omnicodex restart` | Performs `stop` and `start` while preserving validated config and state. It aborts if a non-replayable write cannot drain. |
| `omnicodex status` | Read-only. Reports process, guard, runtime, catalog revision, auth, adapter, URL, and update state in redacted form. |
| `omnicodex doctor` | Read-only. Checks paths, permissions, binary candidates, config schema, credential references, Auth0 metadata, adapter executable, scheduled task definition, ports, and non-interference readiness. It does not launch Codex. |
| `omnicodex logs` | Shows redacted rolling logs. `--follow`, `--since`, and `--limit` are supported. |
| `omnicodex autostart enable` | Creates or replaces the exact current-user Scheduled Task defined below. |
| `omnicodex autostart disable` | Deletes only that exact Scheduled Task after verifying its action points to OmniCodex. |
| `omnicodex auth setup` | Creates or validates the dedicated Auth0 API, PKCE client/DCR policy, scope, resource mapping, and owner allowlist. |
| `omnicodex auth status` | Read-only validation of issuer metadata, JWKS, audience, resource, scope, DCR capability, owner allowlist, and credential references. |
| `omnicodex auth rotate` | Rotates OmniCodex local signing, state, and resource-encryption key material. It rotates stored Auth0 administration credentials only when the tenant API supports an atomic replacement. Old material remains through a bounded overlap and is then revoked. |
| `omnicodex auth migrate-fam` | Defaults to a no-change plan. Execution requires `--execute`, exact FAM resource ID, and passing OmniCodex live-E2E evidence ID. It removes only the selected FAM resource and related clients proven to belong to it. |
| `omnicodex tunnel set ngrok` | Selects ngrok and validates executable, credential reference, public URL, and forwarding target. |
| `omnicodex tunnel set cloudflare` | Selects a named Cloudflare Tunnel. Quick tunnels do not satisfy release because their URL is unstable. |
| `omnicodex tunnel set tailscale` | Selects Tailscale Funnel and verifies authenticated Tailscale state and HTTPS capability. |
| `omnicodex tunnel set direct` | Selects the separate direct HTTPS ingress adapter and requires certificate, private-key credential reference, public host, and explicit bind address. |
| `omnicodex update` | Stages and verifies an OmniCodex package release, probes it, scans installed Codex candidates without installing Codex, drains the active version, and atomically switches. |
| `omnicodex rollback` | Selects the most recent retained healthy OmniCodex version, drains current work, switches the launcher pointer, and restores the matching compatible state snapshot. |

### 23.3 Noninteractive initialization

`init --non-interactive` requires explicit values for issuer, audience, resource
URI, owner subject, public URL, tunnel, and acceptance of the fixed local paths.
Auth0 management credentials and tunnel credentials arrive through standard
input or existing Credential Manager references. Missing material returns exit
code 3 or 9. The command never guesses a tenant, subject, resource, or public
URL.

### 23.4 Autostart

The Scheduled Task path is `\OmniCodex\Gateway`. It runs only for the current
user at interactive logon. It uses least privilege and stores no Windows
password. The task is hidden and invokes the version-independent OmniCodex
launcher with `start --non-interactive`.

The task is not a Session 0 service. It does not run as SYSTEM. It uses restart
delays of 1, 2, 4, 8, 16, and 30 seconds then remains at 30 seconds for at most
five minutes. Persistent failure leaves the task stopped and records a redacted
diagnostic.

## 24. Remote adapters

The gateway itself always binds only to `127.0.0.1`. Remote exposure belongs to
one supervised ingress adapter.

### 24.1 ngrok

ngrok is the default live adapter. It forwards the configured HTTPS domain to
`http://127.0.0.1:48765`. Release requires a stable reserved HTTPS domain.
Credentials are stored by reference. The adapter's public URL must equal the
OAuth protected-resource configuration.

### 24.2 Cloudflare Tunnel

Cloudflare uses a named tunnel and an exact hostname route to the loopback
gateway. Tunnel credentials remain in Credential Manager or the provider's
protected per-user store. A transient quick-tunnel URL is development-only.

### 24.3 Tailscale Funnel

Tailscale Funnel exposes the loopback port through the current user's
authenticated tailnet identity. Readiness requires Funnel support, HTTPS, and
the configured stable public name.

### 24.4 Direct HTTPS

Direct HTTPS is a separate minimal ingress process. It may bind only the
operator-configured address. The gateway remains loopback-only. The adapter
requires TLS 1.2 or later, an exact certificate chain, a private-key credential
reference, host validation, and the same request size limits. Plain HTTP is
forbidden.

Every adapter forwards only to the loopback gateway and sends a mutually
authenticated internal adapter identity. An unhealthy adapter makes remote
readiness false without stopping the local gateway.

## 25. Runtime and package updates

### 25.1 Installed Codex runtime change

OmniCodex never invokes a Codex installer. It detects a newly installed binary
candidate and performs:

1. pre-probe non-interference snapshot;
2. shadow start with process-only overrides;
3. initialize probe;
4. schema and full-catalog probe;
5. representative direct tool probe;
6. model-free loopback proof;
7. browser initialization probe;
8. computer-use initialization probe;
9. post-probe non-interference verification;
10. drain;
11. atomic active-pointer and catalog switch;
12. 10-minute rollback observation window.

Failure before switching leaves the old runtime active. Failure during the
observation window rolls back. The old child is stopped only after the window
and only if it is OmniCodex-owned.

### 25.2 OmniCodex package update

`omnicodex update` resolves the desired npm release. It verifies registry
integrity, package signature and provenance when available, SBOM association,
package name, version, and expected GitHub release commit. It extracts into a
new `%LOCALAPPDATA%\OmniCodex\releases\<version>` directory. It never overwrites
the active release in place.

The staged release runs lint-equivalent self-checks, config migration dry-run,
guard self-test, protocol contract tests, and a shadow runtime probe. State
migration writes a new versioned snapshot and leaves the old snapshot intact.
The version-independent launcher pointer changes atomically after drain.

At least two prior healthy releases and their compatible state snapshots are
retained. Rollback never downgrades user Codex files because OmniCodex never
owns them.

### 25.3 Drain defaults

Read admission moves to the candidate after it is ready. Existing reads receive
five minutes to finish. Explicit model turns receive 30 minutes. A
non-replayable write prevents switch until it completes or its caller cancels
it. At the deadline OmniCodex aborts the update rather than killing the primary
runtime or replaying the write.

## 26. Reference adoption matrix

The following pins and licenses were verified on 2026-07-25 from the local
read-only clones where available and the public GitHub commit API otherwise.
Reference code is not copied unless the later reference ledger records the
exact file, license, and adopted behavior. Behavior can be independently
reimplemented. AxonHub code is never copied.

| Source | Full pinned commit | Verified license | Adopted behavior | Explicit exclusion |
| --- | --- | --- | --- | --- |
| `lidge-jun/opencodex` | `357acee62458684bc027e9d524e95bd066df3a43` | MIT | Responses round-trip framing and translator semantics for function, custom, freeform, events, and result correlation. | Configuration mutation topology and provider replacement architecture. |
| `heelee912/full-access-mcp-public` | `60cc262bb26a0719b62ee654b15fa02bdb267dea` | MIT | OIDC validation behavior only: issuer, audience, resource, scope, JWKS, and fail-closed boundaries. | Low-level replacement tools, long-poll queue, local agent loop, and UI approval automation. |
| `rebel0789/codexpro` | `bbc789e57012af2f46c005f5d54db17e50e1b7f0` | MIT | Windows path discovery, CLI diagnostics, tunnel lifecycle, and release diagnostics. | Its high-level replacement file, shell, and workspace tool surface. |
| `Waishnav/devspace` | `0d9b60c72c2f154ef9fde918ebc9dd1335eba338` | MIT | MCP session, OAuth, durable lifecycle, process session, and cleanup behavior. | Local-agent adapters, subagents, and replacement workspace tools. |
| `farion1231/cc-switch` | `878c26f31e012ba32b9772bd080bd4fa9e7d495e` | MIT | Namespace, custom, tool-search, history, reasoning, SSE, UTF-8 boundary, and media conversion behavior as an oracle. | Provider switching and any user Codex configuration mutation. |
| `looplj/axonhub` | `8b708fe9219707c64582ec0d5d509716d7f5f3e5` | Apache-2.0 generally; `llm/` is LGPL-3.0; `llm/bedrock/` has separate notice | Behavior oracle for translation completeness and edge cases only. | All source-code copying, especially LGPL-3.0 content. |
| `router-for-me/CLIProxyAPI` | `a14dfc779f43aed588e68b31fb34ab5ced700851` | MIT | SSE termination, disconnect, concurrent stream, and usage edge cases as an oracle. | Credential reuse, model proxy architecture, and code not separately adopted in the ledger. |
| `bharat2808/codex-ollama-proxy` | `febb37af4019cba5bec30c0bf3eef1b5b24752a6` | MIT | Responses SSE, tool result, generated-image persistence, and concurrency edges as an oracle. | Provider substitution and user Codex configuration mutation. |

## 27. Phased implementation deliverables

### Phase 0: Contract and evidence ledger

- Save this PRD as the first repository content change.
- Create `docs/reference-ledger.md` as the next repository file.
- Record full pins, licenses, adopted files or behaviors, and exclusions.
- No runtime execution is permitted in this phase.

**Exit:** PRD is decision-complete. Reference ledger is exact. No other product
file predates them.

### Phase 1: Domain model and non-interference guard

- Create the five bounded contexts.
- Implement values for runtime identity, tool identity, model classification,
  route, safety classification, catalog revision, and lifecycle state.
- Implement auth/config/process snapshot ports and Windows read-only adapters.
- Implement guard comparison and fail-closed result.
- Implement process-only override construction without launching Codex.

**Exit:** lint and unit tests pass. Fixture tests prove a one-byte config change,
mtime-only change, missing file, unverifiable file, and app-process continuity
change all block probing.

### Phase 2: Runtime supervision and discovery

- Implement ordered binary discovery.
- Launch only OmniCodex-owned App Server children.
- Implement initialization, schema discovery, shadow probes, health, catalog
  publication, drain, switch, recovery, and rollback.
- Verify guard before and after every probe.

**Exit:** actual Windows discovery and initialization pass without changing
guarded files or the existing app process.

### Phase 3: Catalog and direct routes

- Merge App Server methods and all downstream advertised tools.
- Implement stable identities, deterministic names, fallback schemas, and
  `tools/list_changed`.
- Implement direct App Server and downstream calls.

**Exit:** every advertised tool maps to `/mcp/full` or a generic route. Direct
representative calls pass.

### Phase 4: Model-free executor

- Probe thread-level provider isolation.
- Implement the isolated secondary fallback.
- Implement the deterministic nonce-bound Responses loop.
- Instrument provider routing and usage.

**Exit:** every relevant tool kind round-trips. Ordinary E2E shows zero real
provider requests and zero model usage.

### Phase 5: Scheduler and MCP transport

- Implement lanes, fairness, admission, timeout, cancellation, retry, and slow
  consumer behavior.
- Implement `/mcp`, `/mcp/full`, sessions, paging, SSE replay, content mapping,
  protected resources, and error taxonomy.

**Exit:** unit, contract, integration, and official MCP Inspector tests pass.

### Phase 6: Auth0 and remote adapters

- Implement protected-resource metadata and exact token validation.
- Implement owner allowlist, Credential Manager, DPAPI fallback, DCR, PKCE,
  offline access, rate limiting, and CORS.
- Implement ngrok, Cloudflare, Tailscale, and direct adapters.

**Exit:** auth negative matrix, JWKS rotation, DCR, ngrok external E2E, and
resource ownership tests pass.

### Phase 7: CLI and unattended lifecycle

- Implement all CLI commands, JSON output, noninteractive paths, Scheduled Task,
  redacted logs, package staging, update, and rollback.

**Exit:** command contract tests and actual user-logon autostart E2E pass.

### Phase 8: Actual native surface E2E

- Exercise actual shell, file, background process, browser, Chrome, Computer
  Use, node REPL, plugin, app, connector, image, audio, document, resource, and
  generic routes as advertised.
- Exercise existing task read, explicit creation, continuation, and archive.
- Prove desktop app and login continuity throughout.

**Exit:** the exhaustive Windows matrix passes with retained evidence.

### Phase 9: External client and release

- Pass official MCP Inspector through the live ngrok URL.
- Pass actual Web ChatGPT Pro registration and calls.
- Run GitHub Windows CI and self-hosted GUI E2E.
- Publish SBOM, npm provenance, npm package, GitHub release, and English,
  Korean, Japanese, and Chinese documentation from the same commit.

**Exit:** every release gate passes. Only then may FAM decommission be executed.

## 28. Exhaustive acceptance matrix

| Area | Required test | Passing evidence |
| --- | --- | --- |
| Repository sequence | Git history and tree inspection | `PRD.md` is first content change. `docs/reference-ledger.md` is second file. |
| Static quality | lint and typecheck | Zero errors on release commit. |
| Domain | unit tests | State transitions, tool identities, names, model and state effects, safety defaults, route rules, and retry rules pass. |
| Guard | unit and actual Windows tests | Auth/config hashes, size, mtime, identity, desktop/package observations, and the durable OmniCodex action ledger reconcile. Protected changes and Omni-caused interference fail closed. |
| Independent app update | actual Windows event replay | An unrelated Store/app restart produces `BASELINE_INVALIDATED`, stops admission, proves no OmniCodex signal or protected write, revalidates login and app usability, and renews the baseline without a false interference claim. |
| App continuity | concurrent desktop use | Existing Codex app stays running, authenticated, and usable before, during, and after OmniCodex child probes. |
| Config noninterference | byte comparison | Guarded Codex config and auth files are byte-identical before and after every suite. |
| Discovery | actual App Server | Initialize and live schemas are recorded from an OmniCodex-owned child. |
| Catalog completeness | contract check | App Server, downstream, captured Responses `tools` arrays, lazy search/namespaces, pagination, and prior evidence reconcile; every identity maps to a first-class full-catalog tool or stable generic call. |
| Availability gap | negative live fixtures | Login, entitlement, permission, configuration, and lazy-load failures remain diagnosed availability states and never silently reduce the catalog denominator. |
| Catalog change | runtime fixture and live change | Revision changes exactly once and active sessions receive `notifications/tools/list_changed`. |
| Name normalization | property tests | Invalid Unicode, reserved prefix, long name, duplicate name, and hash collision fixtures are stable and reversible through metadata. |
| Function tool | round trip | Structured arguments and structured result are byte-semantically equal. |
| Custom tool | round trip | Opaque UTF-8 `input` returns without JSON coercion. |
| Freeform tool | round trip | Newlines, Unicode, and embedded JSON text remain exact. |
| Tool search | round trip | Query, results, and continuation preserve native meaning. |
| Namespace tool | round trip | Nested tool selection and arguments reach the intended native target. |
| Unknown tool | round trip | Scalar, array, object, boolean, and null payload fixtures remain lossless or fail explicitly. |
| Streaming | contract and live | Ordered text, structured, progress, and terminal events survive SSE chunk boundaries and UTF-8 splits. |
| Media | contract and live | Image and audio bytes, MIME type, and order match source digests. |
| Resource | contract and live | Large result becomes an encrypted owner-bound link. Wrong owner, wrong session, and expiry fail. |
| Error mapping | contract | Native tool error, JSON-RPC error, policy denial, timeout, cancellation, stale catalog, and overload map to fixed codes. |
| Direct route priority | route test | A tool with both routes always uses direct RPC and emits no loopback request. |
| Zero-model ordinary proof | instrumented actual E2E | Real model-provider endpoint requests equal 0. Model usage equals 0. Only local nonce-bound loopback HTTP appears when required. |
| Model boundary | negative test | Generic ordinary call to a model target fails before runtime dispatch. |
| Unknown model effect | negative and classification tests | An unclassified target advertises `modelEffect: unknown`, cannot execute, and blocks release until provider-traffic evidence classifies it. |
| Explicit model | actual turn | First-class `turn/start` invokes the Codex model only after explicit selection and produces real usage evidence. |
| Ephemeral thread | actual App Server and desktop inspection | Input sends only `ephemeral: true`; the response returns `path: null` and no desktop task appears. |
| Persistent task | actual app inspection | Explicit creation produces exactly one visible `[OmniCodex]` task. Continue and archive affect only that task. |
| Existing task | actual lifecycle | Read, continue, and archive operate on the selected existing task with correct model and persistence classification. |
| Approval | actual policy test | Supported prompts receive strongest affirmative. Managed denial is returned and not bypassed. |
| Read concurrency | load test | Independent reads overlap up to configured capacity. |
| Key ordering | deterministic load test | Same thread, process, and file operations complete dispatch in FIFO order. |
| Fair serial UI lane | multi-client load | Browser, Chrome, and Computer Use run one at a time without session starvation. |
| Node REPL | multi-client load | Calls are globally serial and preserve runtime ordering. |
| Backpressure | slow-client test | Memory remains bounded. Producer pauses or the stream closes with `OVERLOADED`. |
| Retry | crash injection | Eligible read retries exactly once before output. Write and partial-output calls never retry. |
| Cancellation | queued and active tests | Queued work never starts. Active native cancellation status is reported accurately. |
| Runtime crash | process fault injection | External writes are not replayed. A known healthy runtime returns or execution fails closed. |
| Shadow update | good and bad candidate | Bad candidate never becomes active. Good candidate drains and switches atomically. |
| Runtime rollback | switch-window fault | Old healthy runtime and catalog return atomically. |
| Package update | staged release test | Integrity, provenance, SBOM, dry migration, probe, drain, and pointer switch pass. |
| Package rollback | incompatible candidate | Prior package and state snapshot return without touching Codex files. |
| Auth missing token | external request | Uniform `401`. No MCP session created. |
| Auth algorithm | negative JWTs | `none`, HS256, wrong RS algorithm, missing `kid`, and unsupported critical headers fail. |
| Auth issuer | negative JWT | Near-match and trailing-slash mismatch fail. |
| Auth audience/resource | negative JWT and request | Wrong audience, wrong resource URL, and mismatched configured binding fail. |
| Auth scope | negative JWT | Missing or substring-only scope fails. |
| Auth time | negative JWT | Expired and not-yet-valid tokens fail with bounded skew. |
| Auth signature | negative JWT | Tampered signature fails. |
| Owner | valid unapproved token | Uniform `403`. No session created. |
| JWKS rotation | two-key E2E | New `kid` refreshes once. Overlap works. Retired key fails after cache expiry. |
| DCR and PKCE | actual Auth0 | Public client registration, exact redirect, S256, code exchange, refresh, and `offline_access` pass. |
| Auth rate limit | burst test | Buckets enforce stated rates without identity leakage. |
| CORS and host | negative HTTP tests | Wildcard is absent. Unknown origin and forwarded host fail. |
| Secret storage | Windows integration | Credential Manager is used or DPAPI fallback is explicit. No secret appears in config, process args, logs, or test artifacts. |
| ngrok | external network E2E | Stable HTTPS URL exposes metadata and both MCP surfaces with Auth0. |
| Cloudflare | adapter contract and smoke | Named tunnel routes to loopback and preserves public resource URI. |
| Tailscale | adapter contract and smoke | Funnel HTTPS path passes when entitlement is available. |
| Direct HTTPS | adapter integration | TLS, certificate, host validation, and loopback forwarding pass. |
| Official Inspector | local and ngrok | Initialization, list paging, call, progress, cancellation, SSE, and resources pass on both surfaces. |
| Web ChatGPT Pro | actual web client | Registration, OAuth, discovery, ordinary call, media/resource call, and explicit model call pass. |
| GitHub CI | hosted Windows | Clean checkout passes lint, unit, contract, integration, packaging, and SBOM checks. |
| GUI E2E | self-hosted Windows | Browser, Chrome, Computer Use, app continuity, and visible-task tests pass. |
| npm release | registry evidence | Published package digest matches staged artifact and includes provenance. |
| GitHub release | release evidence | Tag, commit, checksums, SBOM, package digest, notes, and multilingual docs agree. |
| FAM retirement | post-release controlled action | Only the exact FAM API and related owned clients are removed after OmniCodex live evidence is accepted. |

## 29. Actual Web ChatGPT Pro experiment

Documentation does not determine final host compatibility. Actual behavior is
authoritative.

After every preceding local, Auth0, Inspector, and ngrok gate passes, the
release operator must:

1. use the real Web ChatGPT Pro interface and the user-described
   “매우 높음” connection path available to that account;
2. register the exact live ngrok OmniCodex protected resource;
3. complete Auth0 Authorization Code with PKCE;
4. verify the stable `/mcp` tools appear;
5. use `search_native_tools` and call an ordinary native read;
6. call an ordinary native write selected for the test and verify zero Codex
   model request or usage;
7. enumerate `/mcp/full` or the host-supported equivalent and prove large
   catalog access through actual behavior;
8. receive streaming progress and one media or protected-resource result;
9. explicitly select one `invokesModel: true` operation and verify model usage;
10. verify the expected `[OmniCodex]` persistent task appears only for the
    explicit persistent case;
11. repeat with missing scope and an unapproved subject and verify denial;
12. confirm the existing desktop app remains logged in and usable.

The evidence records UTC time, account capability, UI path, public resource,
catalog revision, redacted request and result summaries, provider request
counts, model usage, and screenshots without secrets.

If Web ChatGPT exposes no registration path, the result is
`externalPrerequisite: web_chatgpt_registration_unavailable`. It does not reduce
the product goal and cannot be called a pass.

## 30. Release, rollback, and FAM decommission rules

A release claim requires every applicable acceptance row to pass for the same
Git commit and package digest. A mocked Auth0 tenant, mocked tunnel, mocked
Codex runtime, or mocked web client cannot satisfy an actual gate.

Publishing order is:

1. complete tests and evidence;
2. generate SBOM and checksums;
3. create signed version tag;
4. publish npm with provenance;
5. verify registry digest;
6. create GitHub release pointing to that digest;
7. re-run install and smoke tests from public artifacts;
8. record final live evidence.

A failed public-artifact smoke test marks the release withdrawn and invokes
package rollback. It does not trigger any Codex app operation.

FAM decommission is a separate post-release transaction. It requires:

- passing OmniCodex actual Web ChatGPT and external MCP evidence;
- exact FAM Auth0 API identifier;
- a no-change preview;
- proof that every selected client belongs only to FAM;
- an export of non-secret resource metadata;
- explicit `--execute`;
- post-delete verification that OmniCodex and unrelated Auth0 resources remain.

Ambiguity aborts decommission. Unrelated resources are never modified.

## 31. Assumptions and external prerequisites

### 31.1 Fixed implementation assumptions

- The gateway implementation language is TypeScript on Node.js.
- The package supports Node.js 22 or later on Windows.
- The gateway is per-user and runs in the interactive user's security context.
- The installed Codex runtime remains externally owned.
- The runtime may change its experimental App Server protocol. Live discovery
  and versioned adapters handle this without loosening safety.
- The stable local port is `48765` unless explicitly configured.
- ngrok is the default release adapter.
- The external owner is represented by an exact Auth0 issuer and `sub` pair.

### 31.2 Unresolved external prerequisites

These are not implementation choices and cannot be fabricated:

- Auth0 tenant administrator access capable of creating the dedicated API,
  permission, client policy, and DCR configuration;
- a stable ngrok domain and credential or equivalent selected adapter authority;
- Web ChatGPT Pro entitlement and an available MCP registration path;
- GitHub authorization for `heelee912/omnicodex`;
- npm authorization to publish the `omnicodex` package with provenance;
- a GitHub Actions Windows runner and a self-hosted interactive Windows GUI
  runner;
- installed and authenticated native apps required for browser, Chrome,
  Computer Use, connector, and plugin E2E;
- externally managed policy allowing the requested native operations.

An unavailable prerequisite blocks only its dependent acceptance and release
claim. It never authorizes a simulated pass or a narrower product.

## 32. Decision closure

This PRD leaves no product-default, route-selection, persistence, model-use,
security, naming, scheduling, update, rollback, CLI, adapter, or release
decision to the implementer. A live runtime may report a capability absent or
unsupported. In that case the fixed behavior is to preserve evidence, expose
the gap through the catalog or diagnostic result, and fail that route
explicitly. The implementer may not replace it with a semantically different
tool.

Any future change to a fixed decision requires an explicit PRD revision and
must rebuild every dependent test and release conclusion.
