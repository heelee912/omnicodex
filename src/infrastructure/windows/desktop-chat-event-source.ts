import { join, resolve } from "node:path";
import type { CdpWebSocketFactory, CdpWebSocketLike } from "../chatgpt/chatgpt-cdp-transport.js";
import {
  type OracleConversationNotification,
  oracleConversationUrlsFromCdpEvent,
} from "../chatgpt/oracle-conversation-event-source.js";
import { HiddenChildProcessBoundary } from "./hidden-child-process.js";

export interface DesktopChatDebugEndpoint {
  readonly endpoint: string;
  readonly processId: number;
  readonly startedAtIso: string;
}

export interface DesktopChatEventObservationStatus {
  readonly transport: "desktop_cdp";
  readonly processId: number;
  readonly startedAtIso: string;
  readonly attachedTargetCount: number;
  readonly accountScopeVerified: false;
}

export interface DesktopChatObservedEvent {
  readonly source: DesktopChatDebugEndpoint;
  readonly targetId: string;
  readonly conversationUrl: string;
  readonly notification: OracleConversationNotification;
}

/** Passive desktop transport. It neither evaluates renderer code nor opens ChatGPT sockets. */
export class DesktopChatEventSource {
  readonly #discover: (signal: AbortSignal) => Promise<DesktopChatDebugEndpoint>;
  readonly #fetch: typeof fetch;
  readonly #factory: CdpWebSocketFactory;
  readonly #sockets = new Set<CdpWebSocketLike>();
  #source: DesktopChatDebugEndpoint | undefined;
  #connecting: Promise<boolean> | undefined;
  #stopped = false;
  #generation = 0;
  #lifetime = new AbortController();

  constructor(
    options: {
      readonly discover?: (signal: AbortSignal) => Promise<DesktopChatDebugEndpoint>;
      readonly fetch?: typeof fetch;
      readonly factory?: CdpWebSocketFactory;
    } = {},
  ) {
    this.#discover = options.discover ?? discoverDesktopChatDebugEndpoint;
    this.#fetch = options.fetch ?? fetch;
    this.#factory = options.factory ?? ((url) => new WebSocket(url));
  }

  get status(): DesktopChatEventObservationStatus | undefined {
    return this.#source === undefined
      ? undefined
      : {
          transport: "desktop_cdp",
          processId: this.#source.processId,
          startedAtIso: this.#source.startedAtIso,
          attachedTargetCount: this.#sockets.size,
          accountScopeVerified: false,
        };
  }

  get endpoint(): string | undefined {
    return this.#source?.endpoint;
  }

  async ensureConnected(
    onEvent: (event: DesktopChatObservedEvent) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (this.#stopped) throw new Error("DESKTOP_CHAT_EVENTS_STOPPED");
    if (this.#source !== undefined) return false;
    if (this.#connecting !== undefined) {
      await this.#connecting;
      return false;
    }
    const connecting = this.#connect(
      onEvent,
      AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(15_000)]),
    );
    this.#connecting = connecting;
    try {
      return await connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(
    onEvent: (event: DesktopChatObservedEvent) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    const source = await this.#discover(signal);
    signal.throwIfAborted();
    const endpoint = new URL(source.endpoint);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      !Number.isSafeInteger(source.processId) ||
      source.processId <= 0
    )
      throw new Error("DESKTOP_CHAT_DEBUG_ENDPOINT_INVALID");
    const response = await this.#fetch(new URL("/json/list", endpoint), {
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`DESKTOP_CHAT_DEBUG_INVENTORY_HTTP_${response.status}`);
    const inventory: unknown = await response.json();
    if (!Array.isArray(inventory)) throw new Error("DESKTOP_CHAT_DEBUG_INVENTORY_INVALID");
    const targets = inventory.filter((target) => {
      if (target?.type !== "page" || typeof target.url !== "string") return false;
      try {
        const url = new URL(target.url);
        return url.protocol === "app:" && url.hostname === "-" && url.pathname === "/index.html";
      } catch {
        return false;
      }
    });
    if (targets.length === 0) throw new Error("DESKTOP_CHAT_DEBUG_TARGET_MISSING");
    const generation = ++this.#generation;
    const pendingEvents: DesktopChatObservedEvent[] = [];
    const invalidate = () => {
      if (generation !== this.#generation) return;
      this.#disconnect();
    };
    try {
      for (const target of targets) {
        signal.throwIfAborted();
        if (
          typeof target.id !== "string" ||
          !target.id ||
          typeof target.webSocketDebuggerUrl !== "string"
        )
          throw new Error("DESKTOP_CHAT_DEBUG_TARGET_INVALID");
        const url = new URL(target.webSocketDebuggerUrl);
        if (
          url.protocol !== "ws:" ||
          url.hostname !== endpoint.hostname ||
          url.port !== endpoint.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== `/devtools/page/${target.id}`
        )
          throw new Error("DESKTOP_CHAT_DEBUG_TARGET_ORIGIN_INVALID");
        const socket = this.#factory(url.href);
        this.#sockets.add(socket);
        await new Promise<void>((resolveConnection, reject) => {
          let finished = false;
          const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolveConnection();
          };
          const abort = () => {
            finish(new Error("DESKTOP_CHAT_DEBUG_CONNECT_ABORTED", { cause: signal.reason }));
            invalidate();
          };
          signal.addEventListener("abort", abort, { once: true });
          const disconnected = () => {
            finish(new Error("DESKTOP_CHAT_DEBUG_CONNECTION_CLOSED"));
            invalidate();
          };
          socket.addEventListener("close", disconnected);
          socket.addEventListener("error", disconnected);
          socket.addEventListener(
            "open",
            () => {
              if (generation === this.#generation && !signal.aborted)
                socket.send(JSON.stringify({ id: 1, method: "Network.enable", params: {} }));
            },
            { once: true },
          );
          socket.addEventListener("message", ({ data }) => {
            if (generation !== this.#generation || typeof data !== "string") return;
            let message: { id?: unknown; error?: unknown };
            try {
              message = JSON.parse(data);
            } catch {
              return;
            }
            if (message?.id === 1) {
              if (message.error !== undefined) {
                finish(
                  new Error("DESKTOP_CHAT_DEBUG_NETWORK_ENABLE_FAILED", { cause: message.error }),
                );
                invalidate();
              } else {
                finish();
              }
              return;
            }
            oracleConversationUrlsFromCdpEvent(
              data,
              (conversationUrl, notification) => {
                const event = { source, targetId: target.id, conversationUrl, notification };
                if (this.#source === source) onEvent(event);
                else pendingEvents.push(event);
              },
              { includeProgressRequestIdentity: true },
            );
          });
          if (signal.aborted) abort();
        });
      }
      const current = await this.#discover(signal);
      signal.throwIfAborted();
      if (
        current.endpoint !== source.endpoint ||
        current.processId !== source.processId ||
        current.startedAtIso !== source.startedAtIso
      )
        throw new Error("DESKTOP_CHAT_DEBUG_PROCESS_CHANGED_DURING_CONNECT");
      if (generation !== this.#generation || this.#stopped)
        throw new Error("DESKTOP_CHAT_DEBUG_CONNECTION_CLOSED");
      this.#source = source;
      for (const event of pendingEvents) {
        if (generation !== this.#generation) break;
        onEvent(event);
      }
      return true;
    } catch (error) {
      invalidate();
      throw error;
    }
  }

  #disconnect(): void {
    this.#generation++;
    this.#source = undefined;
    const sockets = [...this.#sockets];
    this.#sockets.clear();
    for (const socket of sockets) socket.close();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#lifetime.abort();
    this.#disconnect();
    await this.#connecting?.catch(() => undefined);
  }
}

/** Reads installed-package ownership and the live loopback listener; never starts or patches the app. */
export async function discoverDesktopChatDebugEndpoint(
  signal: AbortSignal,
): Promise<DesktopChatDebugEndpoint> {
  signal.throwIfAborted();
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || !systemRoot)
    throw new Error("DESKTOP_CHAT_DEBUG_WINDOWS_REQUIRED");
  const children = new HiddenChildProcessBoundary();
  const child = children.spawnHidden(
    join(resolve(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(DESKTOP_CHAT_DEBUG_DISCOVERY, "utf16le").toString("base64"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolveEndpoint, reject) => {
    let stdout = "";
    let stderr = "";
    const abort = () => children.terminateOwnedHiddenChild(child);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (code !== 0) {
        reject(new Error(`DESKTOP_CHAT_DEBUG_DISCOVERY_FAILED: ${stderr.trim()}`));
        return;
      }
      try {
        resolveEndpoint(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    if (signal.aborted) abort();
  });
}

const DESKTOP_CHAT_DEBUG_DISCOVERY = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
$package=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if($null -eq $package){throw 'DESKTOP_PACKAGE_NOT_INSTALLED'}
$executable=[IO.Path]::GetFullPath((Join-Path $package.InstallLocation 'app\ChatGPT.exe'))
$running=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $executable -and $_.CommandLine -notmatch '--type=' })
if($running.Count -ne 1){throw 'DESKTOP_MAIN_PROCESS_NOT_UNIQUE'}
$main=$running[0]
if($main.CommandLine -notmatch '(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)'){throw 'DESKTOP_DEBUG_OPTION_MISSING'}
$port=[int]$Matches[1]
if($port -lt 1024 -or $port -gt 65535){throw 'DESKTOP_DEBUG_PORT_INVALID'}
$lines=& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp
if($lines|Select-String -Pattern "^\s*TCP\s+(?:0\.0\.0\.0|\[::\]):$port\s"){throw 'DESKTOP_DEBUG_NON_LOOPBACK_LISTENER'}
if(-not ($lines|Select-String -Pattern "^\s*TCP\s+127\.0\.0\.1:$port\s+\S+\s+LISTENING\s+$($main.ProcessId)\s*$")){throw 'DESKTOP_DEBUG_OWNER_NOT_VERIFIED'}
@{endpoint="http://127.0.0.1:$port";processId=[int]$main.ProcessId;startedAtIso=([DateTime]$main.CreationDate).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
