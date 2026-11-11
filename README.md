# OmniCodex

OmniCodex is a Windows-local, owner-authenticated Streamable HTTP MCP gateway
for the callable tool surface of an already installed Codex runtime, available
to both Web and desktop ordinary Chat. It connects to the Desktop-owned App
Server for native app tools and owns one separate, hidden loopback App Server
shared by tool-execution sessions. These
are two processes, not one process per conversation. It does not control the
Codex desktop app during installation or background maintenance. Explicitly
requested work can use native Computer Use and desktop tools; app launch and
restart use dedicated desktop lifecycle tools. OmniCodex does not modify Codex
authentication/configuration or register itself as an MCP server in the local
Codex app.

OmniCodex exposes two intentional MCP surfaces on the same owner-authenticated
gateway:

- `/mcp` is the bounded compatibility surface for stable discovery and calls.
- `/mcp/full` is the complete native Codex surface, including first-class
  normalized tools with their exact public input schemas. Compatibility
  discovery and invocation routers are not duplicated into this surface.

ChatGPT app registration uses `/mcp/full` when the full product is required;
`/mcp` remains available for clients that intentionally choose the compatibility
surface.

Browser evidence uses four non-interchangeable terms throughout this project:

- Oracle/agbrowser transports a Web GPT request and response only.
- Chrome Use is the Codex Chrome extension connection to the owner's signed-in
  Chrome and is called through `chrome__control_chrome`.
- The Codex in-app browser is a separate surface called through
  `browser__control_in_app_browser`.
- `tab.playwright` is an API bound to a tab selected from one of those two
  first-party surfaces. Standalone Playwright is another execution path; neither
  form is itself a browser surface.

A browser-surface list is **not** a plugin or skill inventory. OmniCodex
refreshes callable Codex host and MCP tools from the installed runtime without
a per-plugin allowlist. To find an installed Codex skill without searching the
filesystem, call `search_native_tools` with `query` and `includeSkills: true`;
the `skills` results come from a fresh Codex `skills/list` read and are marked
non-callable. A skill is instructions, not an MCP tool: its companion app/CLI
must still be installed and available to the execution environment. A newly
installed skill does not become a Chrome or Codex in-app browser surface.

## First install: end-to-end

Requirements: Windows, Node.js 24.14.0 or newer, an installed and signed-in Codex
Desktop runtime, and Rust (`rustc.exe` in the current user's `.cargo/bin`) when
the Desktop bridge must be installed or rebuilt. The npm package contains the
launcher source, not a prebuilt `.exe`.

Run these steps in order. Replace every example value; the issuer, audience,
resource, owner subject, and public origin are exact security identities.
No Auth0 tenant, owner subject, OAuth credential, tunnel token, private key,
Codex session, or personal computer path is bundled. Each installer must create
their own Auth0 tenant/application and resource server, choose their own
authenticated HTTPS origin, sign into their own Codex and ChatGPT accounts,
and supply their own values during `init`, `auth`, `tunnel`, and ChatGPT app
registration. Never copy another person's local config, keyring, or `.codex`
data into a package.

1. Install and initialize the owner-only gateway.

   The npm package is not published. Use this public source checkout until a
   separately verified registry release exists:

   ```powershell
   git clone https://github.com/heelee912/omnicodex.git
   Set-Location omnicodex
   npm ci --ignore-scripts
   npm run build
   node dist/cli.js init --help
   ```

   Only after a separately verified npm release is actually published, the
   registry install path will be:

   ```powershell
   npm install --global @heelee912/omnicodex --ignore-scripts
   omnicodex init `
     --issuer https://YOUR_TENANT.us.auth0.com/ `
     --audience https://YOUR_PUBLIC_ORIGIN/mcp/full `
     --resource https://YOUR_PUBLIC_ORIGIN/mcp/full `
     --subject 'auth0|YOUR_OWNER_USER_ID' `
     --allowed-origin https://chatgpt.com `
     --port 8787
   ```

   When running from source, replace `omnicodex` in the remaining commands with
   `node dist/cli.js`.

2. Complete the official Auth0 device login, including tenant MFA when Auth0
   requests it, then provision the dedicated resource server and strict DCR
   grant. The Auth0 CLI refresh credential remains in the Windows keyring.

   ```powershell
   omnicodex auth login --json
   omnicodex auth setup --json
   omnicodex auth status --json
   ```

3. Configure exactly one stable HTTPS ingress. For a reserved ngrok origin,
   pass the token through stdin so it never appears in argv; OmniCodex stores
   only CurrentUser-DPAPI ciphertext and an opaque reference.

   ```powershell
   $env:OMNICODEX_NGROK_TOKEN | omnicodex tunnel set ngrok `
     --url https://YOUR_RESERVED_DOMAIN.ngrok-free.dev `
     --authtoken-stdin --json
   Remove-Item Env:OMNICODEX_NGROK_TOKEN
   ```

4. Start the hidden owned runtime and verify the real local tool surface.

   ```powershell
   omnicodex start --json
   omnicodex doctor --json
   omnicodex runtime probe --json
   ```

5. In the ChatGPT account used by the client, enable **Settings → Security and
   login → Developer mode**, then open **Plugins → +** and register `OmniCodex`
   whose MCP URL is exactly
   `https://YOUR_PUBLIC_ORIGIN/mcp/full`. Select OAuth with Dynamic Client
   Registration. Complete the Auth0 login and consent in that same browser.
   A successful OAuth page is not the end-to-end result: start an ordinary
   Chat with the owner's selected model and reasoning settings, invoke a native
   OmniCodex tool, and verify the complete tool result and final Chat response.
   For desktop ordinary Chat, register the same service in the account signed
   into the desktop app. Use that account's resulting `plugin_asdk_app...` ID
   in the local plugin's `.app.json`, referenced by the manifest's `apps` field.
   Installing a local MCP server in Codex mode does not perform this Chat account
   registration. See the [official local plugin setup](https://developers.openai.com/plugins/build/plugins#create-and-test-a-plugin-locally-with-an-mcp-server).
   Keep Web
   and desktop registrations as independent client bindings to the same service;
   a local plugin card alone does not prove an account-owned app connection.
   Verify Web, desktop, then Web again without replacing either binding. Each
   conversation must retain its own execution context, results, and Goals.

6. Only after the real flow succeeds, enable hidden logon startup.

   ```powershell
   omnicodex autostart enable --json
   omnicodex autostart status --json
   omnicodex autostart test --json
   ```

   `enable` accepts only the exact current-user `\OmniCodex\Gateway` Scheduled
   Task. It never substitutes the `HKCU` Run key; an exact legacy Run value from
   an older development build is migrated only after the Scheduled Task reads
   back successfully. `status` verifies both the task action and the exact hidden
   VBS bytes. `test` invokes that owned `WScript //B //Nologo` path with the
   distinct `manual-test` source and succeeds only after a fresh metadata-only
   launcher receipt reports exit code zero. The Scheduled Task alone supplies
   `scheduled-task`; receipts also bind the observed Windows boot time. Therefore
   only `rebootVerifiedForCurrentBoot: true` can satisfy the reboot gate, and the
   synthetic test cannot be mistaken for it.

Initialization is fail-closed. OAuth issuer, audience/resource, scopes, and the
owner `sub` must match. `auth login` downloads a pinned, checksum-verified
official Auth0 CLI when one is not supplied and uses its Windows-keyring-backed
device login. No Management API token is written to OmniCodex configuration.
OmniCodex binds locally to `127.0.0.1`; remote access
requires an explicitly configured authenticated HTTPS ingress.

Mutable tools expose an optional reserved `omnicodexInvocationId` argument. A
caller that supports it generates one identifier for each intended action and
reuses it only if that action is retried. OmniCodex strips the field before
calling Codex and uses a single durable, owner-bound replay ledger across all
MCP sessions. Concurrent duplicates execute natively once; conflicting reuse is
rejected; and an unknowable write is never replayed after a timeout or restart.
Older clients whose cached schema cannot send the field use a separate durable
five-second fan-out cohort: identical cross-session copies of one provider call
join once, while separate requests in the same session remain separate actions.
Read-only first-class tools need no invocation identifier.

If Auth0 rejects ChatGPT DCR because the tenant client quota is full, review
bounded third-party candidates and delete only one exact fingerprinted stale
client:

```powershell
omnicodex auth dcr-clients --json
omnicodex auth cleanup-dcr --client-id EXACT_ID --fingerprint EXACT_SHA256
omnicodex auth cleanup-dcr --client-id EXACT_ID --fingerprint EXACT_SHA256 --execute --json
```

## Package update and rollback

`update` no longer renames an arbitrary caller-supplied directory. It installs
one exact npm version without lifecycle scripts and requires the exact lowercase
GitHub commit expected for that version. It checks registry integrity and
`gitHead`, the exact repository, npm signature audit results, the SLSA v1 DSSE
subject digest and resolved Git commit, CycloneDX SBOM association, package self-checks, config
parsing, guard and MCP protocol contracts, a deterministic installed-package
file digest, and a real isolated runtime probe. A retained version is never
trusted from its local manifest alone: registry provenance and npm signature
audit run again and its SBOM and package bytes must still match. It then stops
new MCP admission, gives ordinary calls five minutes and explicit model turns
up to 30 minutes, stops only the owned daemon, restores the matching state
snapshot, writes the atomic stable-release pointer, and starts the selected
release with admission still draining. Admission opens only after its protected
MCP endpoint passes observation. Any failure restores the previous snapshot,
pointer, and owned daemon in that order. Retained healthy releases are not
pruned by the transition path.

```powershell
omnicodex update --target-version 1.2.3 --expected-commit EXACT_40_CHAR_SHA --json
omnicodex update --target-version 1.2.3 --expected-commit EXACT_40_CHAR_SHA --execute --json
omnicodex rollback --json
omnicodex rollback --target-version 1.2.2 --execute --json
```

## Optional hosted MCP: guided recipient setup

For the standalone OmniCodex2 hosted bridge, run the interactive wizard from your
installed package root, then explicitly log in:

```powershell
node scripts/connectors/hosted-mcp/setup.mjs
node scripts/connectors/hosted-mcp/oauth-login.mjs
```

The wizard guides **each recipient through THEIR OWN approved public OAuth app
and THEIR OWN hosted workspace/connector/link registration**, collects only
nonsecret fields, and privately installs configuration outside this package.
Login and `scripts/connectors/hosted-mcp/stdio.mjs` read that same configuration;
use the same `--config ABSOLUTE_PER_USER_JSON_PATH` for additional registrations.
It never provisions a provider app, asks for passwords/secrets/tokens, silently
replaces an existing registration, logs in automatically, or restarts anything.

Official background: [connect your plugin in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[MCP server authentication](https://developers.openai.com/plugins/build/auth), and
[MCP OAuth/PKCE](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
These guides are **not** a self-service OAuth-client provisioning route for the
hosted API used by this bridge. Independent public-client support there remains
**unverified**; obtain provider approval or this route is blocked. Never borrow a
first-party/other person's client or registration. See the [hosted connector setup
guide](scripts/connectors/hosted-mcp/README.md) for onboarding, config isolation,
automation overrides, privacy and provider limitations.

## Optional Oracle consent companion

The optional companion attaches only to an explicitly configured loopback
Chrome DevTools endpoint. It never launches, profiles, or terminates Chrome and
never navigates an unrelated tab. The settings reconciler may open and navigate
only its own exact app-settings target. Setup is a dry-run unless `--execute`
is supplied.

```powershell
omnicodex oracle setup --connector-id exact-id --connector-name OmniCodex `
  --run-id exact-run --resource https://mcp.example/mcp/full --surface /mcp/full `
  --cdp-endpoint http://127.0.0.1:9222 --non-interactive
omnicodex oracle status --json
omnicodex oracle test                 # inspect exact app settings; no click
omnicodex oracle test --execute       # settings-first Connect / Always allow only
omnicodex oracle watch --run-id exact-run --standalone
omnicodex oracle watch --run-id exact-run --standalone --execute
omnicodex oracle disable --execute
```

Use `--client-binding web` and `--client-binding desktop` on `oracle setup`,
`status`, `test`, and `disable` to select an independent registration. Setup for
one binding preserves the other. Each connector ID must come from that client's
actual account registration; copying a Web ID into a desktop plugin manifest
does not register the app for a different account.

Run `oracle test --execute` before submitting the Oracle prompt. A disconnected
app has no callable ChatGPT tool namespace, so a conversation-first watcher
cannot create its `Connect` surface and must not substitute a similarly named
connected app. First-time OAuth may still require the owner to finish the
identity-provider login in the browser profile that owns the authorization
transaction; rerunning `oracle test --execute` promotes the recorded exact
Connect attempt only after connected-state readback and then selects the
maximum persistent permission.

The daemon keeps one persistent approval watcher on the isolated Oracle Chrome
through its hidden loopback CDP tunnel. Ordinary Chat requests are correlated
with their originating conversation. After server approval, the runtime can
synchronize that exact conversation in the owner's Chrome and retries deferred
synchronization without repeating the approval. Oracle's per-submission page watcher detects the
existing OmniCodex owner and yields, so manual messages, resumed conversations,
and Oracle-submitted turns share one click owner without duplicate activation.
`oracle watch` remains a bounded diagnostic for one exact submitted run; do not
run it beside the daemon watcher.

Installed Codex runtime transitions are separate from OmniCodex package
updates. They shadow-start and directly probe an exact discovered candidate,
close new admission, drain active calls, switch the listener, observe for ten
minutes, and restore the old runtime if observation fails:

```powershell
omnicodex runtime switch --candidate 'C:\exact\discovered\codex.exe' --json
omnicodex runtime switch --candidate 'C:\exact\discovered\codex.exe' `
  --execute --non-interactive --json
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
- Oversized native text, binary, and `structuredContent` are removed from the inline
  tool result and delivered only through short-lived owner/session-bound
  `resource_link` records; the same authenticated MCP session must read them.
- Browser automation is optional and separate from MCP server authority.

Operational commands include `doctor`, `logs`, `runtime discover`, `runtime probe`,
`runtime switch`, `autostart`, `auth`, `tunnel`, `update`, and `rollback`. Run
`omnicodex --help` for details.

`omnicodex oracle status --activity-only --json` reads the running daemon's
committed event counters through its local control pipe, without external
probes, catalog hydration, or a historical log scan. The response identifies
the writer PID and start time, event counts, approval HTTP totals, and the last
trigger/operation metadata for each event. Counters cover the current writer;
the existing durable log retains earlier operation history. Catalog refresh
completion is counted at the actual refresh operation, independently of joined
synchronization callers.

Documentation: [한국어](docs/README.ko.md) · [日本語](docs/README.ja.md) ·
[中文](docs/README.zh.md) · [source attribution](docs/reference-ledger.md).

## Release policy

This public source repository has a new, independent Git history. It excludes
private historical issue/PRD documents, local sessions and attachments, and the
former private repository's branches, tags, releases and Actions history. The
private archive is not part of this public repository.

The npm package remains `private: true` and unpublished. Its explicit file
allowlist includes runtime code and public setup documentation, not local
configuration, credentials or generated data. Audit
`npm pack --dry-run --ignore-scripts --json` on a clean checkout before any
separately authorized npm release. Maintainers run `npm run check` and
`npm run build`; a GitHub source release does not publish to npm.

For a future npm release, the protected acceptance process requires one
`release-acceptance.json`
artifact whose actual gates all bind the same GitHub commit, package version,
and packed SHA-256. Candidate and released acceptance can be inspected with
`omnicodex acceptance status` and fail-closed with `omnicodex acceptance verify`.
After a real gate succeeds, `omnicodex acceptance record --gate NAME
--source-commit SHA --package-version X.Y.Z --package-sha256 DIGEST --artifact
kind=C:\absolute\result.json --execute` stores only the artifact kind, byte
size, and SHA-256. It is dry-run by default, refuses cross-build mixing, and
does not overwrite different evidence for an already recorded gate.

MIT licensed. This community project is not an official OpenAI product.
