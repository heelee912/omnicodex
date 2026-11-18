import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  findStockExecutable,
  prepareDesktopRuntime,
  readStockVersion,
  stockManagedRoot,
} from "./stock-codex-executable.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_DESKTOP_WAIT_MS = 15_000;
const PROCESS_INSPECTION_INTERVAL_MS = 2_000;
const RECORD_POLL_INTERVAL_MS = 250;

if (isDirectEntrypoint(process.argv[1])) {
  await main(process.argv.slice(2));
}

export function isDirectEntrypoint(entryPath, modulePath = fileURLToPath(import.meta.url)) {
  if (typeof entryPath !== "string") return false;
  const entry = actualPath(entryPath);
  const module = actualPath(modulePath);
  return process.platform === "win32"
    ? entry.toLowerCase() === module.toLowerCase()
    : entry === module;
}

function actualPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export async function main(
  args,
  {
    findExecutable = findStockExecutable,
    prepareRuntime = prepareDesktopRuntime,
    inspectProcesses = inspectDesktopProcesses,
    startDesktopServer = bridgeDesktopAppServer,
    attachDesktopServer = attachToDesktopAppServer,
    acquireStartupLock = acquireDesktopStartupLock,
    spawnProcess = spawn,
    currentPid = process.pid,
  } = {},
) {
  // Desktop startup policy expects one JSON result, not a persistent stdio connection.
  const printsStartupConfig = args.includes("--print-startup-config");
  if (printsStartupConfig || !args.includes("app-server") || !usesStdio(args)) {
    const stockExecutable = await findExecutable();
    const child = spawnProcess(stockExecutable, args, {
      windowsHide: true,
      stdio: "inherit",
      env: childEnvironment(),
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    child.once("error", (error) => {
      console.error(error);
      process.exitCode = 1;
    });
    return;
  }
  const initialProcesses = await inspectProcesses();
  if (!isDesktopLauncher(initialProcesses, currentPid)) {
    await attachDesktopServer(initialProcesses);
    return;
  }
  const lock = await acquireStartupLock();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await lock.release();
  };
  try {
    const currentProcesses = await inspectProcesses();
    if (hasDesktopOwnedAppServer(currentProcesses)) {
      await release();
      await attachDesktopServer(currentProcesses);
      return;
    }
    const executable = await findExecutable();
    const startup = await waitForDesktopStartupState({
      initialProcesses: currentProcesses,
      executablePath: executable,
      inspectProcesses,
    });
    if (startup.action === "attach") {
      await release();
      await attachDesktopServer(startup.processes);
      return;
    }
    const owner = desktopLauncherOwner(startup.processes, currentPid);
    if (!owner) throw new Error("Desktop launcher ownership changed before runtime staging");
    const runtime = await prepareRuntime(executable, owner);
    await startDesktopServer(runtime.executable, args, false, {
      onDesktopReady: runtime.activate,
      onStartupFinished: release,
    });
  } finally {
    await release();
  }
}

function usesStdio(values) {
  const index = values.indexOf("--listen");
  if (values.includes("--stdio")) return true;
  if (index >= 0) return values[index + 1] === "stdio://";
  const assignedListen = values.find((value) => value.startsWith("--listen="));
  return assignedListen === undefined || assignedListen === "--listen=stdio://";
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  return env;
}

async function attachToDesktopAppServer(initialProcesses) {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const directory = join(codexHome, "shared-app-server");
  const { record, socket } = await waitForDesktopAppServerPipe({
    initialProcesses,
    readRecords: () => readDesktopAppServerRecords(directory),
    inspectProcesses: inspectDesktopProcesses,
    connectPipe: connectToPipe,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  socket.once("close", () => lines.close());
  socket.pipe(process.stdout);
  let initialized = false;
  try {
    for await (const line of lines) {
      if (!initialized) {
        const request = JSON.parse(line);
        if (request.method !== "initialize" || request.id === undefined) {
          throw new Error("App Server client must initialize first");
        }
        const params = request.params ?? {};
        const capabilities = params.capabilities ?? {};
        socket.write(
          `${JSON.stringify({
            ...request,
            params: {
              ...params,
              clientInfo: {
                ...params.clientInfo,
                name: record.routerProtocolVersion === 2 ? "codex-native" : "omnicodex",
              },
              capabilities: {
                ...capabilities,
                extensions: {
                  ...capabilities.extensions,
                  "omnicodex/thread-owner-key": record.instanceNonce,
                },
              },
            },
          })}\n`,
        );
        initialized = true;
      } else {
        socket.write(`${line}\n`);
      }
    }
  } finally {
    socket.destroy();
  }
}

/** Only Desktop's own launcher may create the primary server. */
export function isDesktopLauncher(processes, nodePid) {
  return desktopLauncherOwner(processes, nodePid) !== undefined;
}

function desktopLauncherOwner(processes, nodePid) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const node = byPid.get(nodePid);
  const launcher = byPid.get(node?.parentPid);
  const desktop = byPid.get(launcher?.parentPid);
  return lowerName(node) === "node.exe" &&
    isStockBridgeNode(node) &&
    lowerName(launcher) === "omnicodexdesktopengine.exe" &&
    !hasLostOrReusedParent(node, launcher) &&
    !hasLostOrReusedParent(launcher, desktop) &&
    isDesktopMainProcess(desktop)
    ? desktop
    : undefined;
}

/** Reject stale records, PID reuse, and servers not owned by the running Desktop. */
export function desktopAppServerCandidates(records, processes, now = Date.now()) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const candidates = [];
  for (const { file, record } of records) {
    if (typeof record !== "object" || record === null || record.schemaVersion !== 1) continue;
    if (record.ownerKind !== undefined && record.ownerKind !== "desktop") continue;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
    if (typeof record.instanceNonce !== "string" || !/^[0-9a-f-]{36}$/iu.test(record.instanceNonce))
      continue;
    if (file !== `desktop-app-server-${record.pid}-${record.instanceNonce}.json`) continue;
    if (record.pipeName !== `\\\\.\\pipe\\codex-app-server-${record.pid}-${record.instanceNonce}`)
      continue;
    if (typeof record.executablePath !== "string" || typeof record.appServerVersion !== "string")
      continue;
    if (record.appServerVersion.length === 0 || !Number.isFinite(record.startedAtUnixMs)) continue;
    const server = byPid.get(record.pid);
    if (lowerName(server) !== "codex.exe" || !isAppServer(server)) continue;
    if (
      typeof server.executablePath !== "string" ||
      !sameWindowsPath(server.executablePath, record.executablePath)
    )
      continue;
    if (
      !Number.isFinite(server.startedAtUnixMs) ||
      record.startedAtUnixMs < server.startedAtUnixMs - 1000
    )
      continue;
    if (record.startedAtUnixMs > now + 60_000 || !isDesktopOwnedServer(server, byPid)) continue;
    candidates.push(record);
  }
  return candidates.sort(
    (left, right) => left.startedAtUnixMs - right.startedAtUnixMs || left.pid - right.pid,
  );
}

/** Waits for Desktop's published pipe without starting another app server. */
export async function waitForDesktopAppServerPipe({
  initialProcesses,
  readRecords,
  inspectProcesses,
  connectPipe,
  now = Date.now,
  pause = delay,
  timeoutMs = DEFAULT_DESKTOP_WAIT_MS,
}) {
  const deadline = now() + timeoutMs;
  let processes = initialProcesses;
  let inspectedAt = processes === undefined ? -Infinity : now();
  while (now() < deadline) {
    if (processes === undefined || now() - inspectedAt >= PROCESS_INSPECTION_INTERVAL_MS) {
      processes = await inspectProcesses();
      inspectedAt = now();
    }
    const records = await readRecords();
    for (const record of desktopAppServerCandidates(records, processes, now())) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const socket = await connectPipe(record.pipeName, Math.min(1000, remaining));
      if (socket !== undefined) return { record, socket };
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(RECORD_POLL_INTERVAL_MS, remaining));
  }
  throw new Error(`Codex Desktop app-server pipe was not available within ${timeoutMs}ms`);
}

function isDesktopOwnedServer(server, byPid) {
  const parent = byPid.get(server.parentPid);
  if (hasLostOrReusedParent(server, parent)) return false;
  if (isDesktopMainProcess(parent)) return true;
  if (lowerName(parent) !== "node.exe" || !isStockBridgeNode(parent)) return false;
  const launcher = byPid.get(parent.parentPid);
  const desktop = byPid.get(launcher?.parentPid);
  return (
    lowerName(launcher) === "omnicodexdesktopengine.exe" &&
    !hasLostOrReusedParent(parent, launcher) &&
    !hasLostOrReusedParent(launcher, desktop) &&
    isDesktopMainProcess(desktop)
  );
}

function hasDesktopOwnedAppServer(processes) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  return processes.some(
    (entry) =>
      lowerName(entry) === "codex.exe" && isAppServer(entry) && isDesktopOwnedServer(entry, byPid),
  );
}

/** Do not start a second server while a previous stock server is still exiting. */
export async function waitForDesktopStartupState({
  initialProcesses,
  executablePath,
  inspectProcesses,
  now = Date.now,
  pause = delay,
  timeoutMs = DEFAULT_DESKTOP_WAIT_MS,
}) {
  const deadline = now() + timeoutMs;
  let processes = initialProcesses;
  while (true) {
    if (hasDesktopOwnedAppServer(processes)) return { action: "attach", processes };
    if (!hasOrphanedStockAppServer(processes, executablePath))
      return { action: "start", processes };
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(`Previous Codex app-server did not exit within ${timeoutMs}ms`);
    await pause(Math.min(PROCESS_INSPECTION_INTERVAL_MS, remaining));
    processes = await inspectProcesses();
  }
}

function hasOrphanedStockAppServer(processes, executablePath) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const managedBin = stockManagedRoot(executablePath).toLowerCase();
  return processes.some((entry) => {
    if (lowerName(entry) !== "codex.exe" || !isAppServer(entry)) return false;
    if (typeof entry.executablePath !== "string") return false;
    const executable = win32.normalize(entry.executablePath).toLowerCase();
    if (!executable.startsWith(`${managedBin}\\`)) return false;
    return hasLostStartupAncestor(entry, byPid);
  });
}

function hasLostStartupAncestor(server, byPid) {
  const node = byPid.get(server.parentPid);
  if (hasLostOrReusedParent(server, node)) return true;
  if (lowerName(node) !== "node.exe" || !isStockBridgeNode(node)) return false;
  const launcher = byPid.get(node.parentPid);
  if (hasLostOrReusedParent(node, launcher)) return true;
  if (lowerName(launcher) !== "omnicodexdesktopengine.exe") return false;
  return hasLostOrReusedParent(launcher, byPid.get(launcher.parentPid));
}

function hasLostOrReusedParent(child, parent) {
  return (
    parent === undefined ||
    (Number.isFinite(parent.startedAtUnixMs) &&
      Number.isFinite(child.startedAtUnixMs) &&
      parent.startedAtUnixMs > child.startedAtUnixMs)
  );
}

function isStockBridgeNode(entry) {
  return (
    entry?.isStockBridgeNode === true ||
    /[\\/]stock-app-server-stdio\.mjs(?:"|\s|$)/iu.test(entry?.commandLine ?? "")
  );
}

function isAppServer(entry) {
  return (
    entry?.isAppServer === true || /(?:^|\s)app-server(?:\s|$)/u.test(entry?.commandLine ?? "")
  );
}

function isDesktopMainProcess(entry) {
  return (
    lowerName(entry) === "chatgpt.exe" &&
    /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/iu.test(entry?.executablePath ?? "") &&
    entry?.isDesktopRenderer !== true &&
    !/--type=/u.test(entry?.commandLine ?? "")
  );
}

function lowerName(entry) {
  return typeof entry?.name === "string" ? entry.name.toLowerCase() : "";
}

function sameWindowsPath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** The operating system releases this private startup lock when its owner exits. */
export async function acquireDesktopStartupLock({
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  pipeName = desktopStartupLockPipe(codexHome),
  tryAcquire = tryAcquireStartupPipe,
  now = Date.now,
  pause = delay,
  timeoutMs = DEFAULT_DESKTOP_WAIT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const lock = await tryAcquire(pipeName, Math.min(1000, deadline - now()));
    if (lock !== undefined) return lock;
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(RECORD_POLL_INTERVAL_MS, remaining));
  }
  throw new Error(`Codex Desktop app-server startup lock was unavailable within ${timeoutMs}ms`);
}

export function desktopStartupLockPipe(codexHome) {
  const identity = createHash("sha256").update(actualPath(codexHome).toLowerCase()).digest("hex");
  return `\\\\.\\pipe\\omnicodex-desktop-start-${identity.slice(0, 32)}`;
}

function tryAcquireStartupPipe(pipeName, timeoutMs) {
  return new Promise((resolveLock, rejectLock) => {
    const server = createServer((socket) => socket.destroy());
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      rejectLock(new Error("Codex Desktop app-server startup lock bind timed out"));
    }, timeoutMs);
    server.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "EADDRINUSE") resolveLock(undefined);
      else rejectLock(error);
    });
    server.listen(pipeName, () => {
      if (settled) {
        server.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      let released = false;
      resolveLock({
        release: async () => {
          if (released) return;
          released = true;
          await new Promise((resolveRelease, rejectRelease) => {
            server.close((error) => {
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectRelease(error);
              else resolveRelease();
            });
          });
        },
      });
    });
  });
}

export async function readDesktopAppServerRecords(directory) {
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    files
      .filter((file) => /^desktop-app-server-\d+-[0-9a-f-]{36}\.json$/iu.test(file))
      .map(async (file) => {
        try {
          return { file, record: JSON.parse(await readFile(join(directory, file), "utf8")) };
        } catch (error) {
          if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
          throw error;
        }
      }),
  );
  return records.filter(Boolean);
}

export async function inspectDesktopProcesses() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows system directory is unavailable");
  const script = String.raw`
$names = @('ChatGPT.exe', 'codex.exe', 'OmniCodexDesktopEngine.exe', 'node.exe')
$all = @(Get-CimInstance Win32_Process)
$wanted = @{}
foreach ($item in $all) {
  if ($names -contains $item.Name) {
    $wanted[[int]$item.ProcessId] = $true
    $wanted[[int]$item.ParentProcessId] = $true
  }
}
$processes = @($all | Where-Object { $wanted.ContainsKey([int]$_.ProcessId) } | ForEach-Object {
  [pscustomobject]@{
    pid = $_.ProcessId
    parentPid = $_.ParentProcessId
    name = $_.Name
    executablePath = $_.ExecutablePath
    isStockBridgeNode = [bool]($_.Name -ieq 'node.exe' -and $_.CommandLine -match '[\\/]stock-app-server-stdio\.mjs(?:"|\s|$)')
    isAppServer = [bool]($_.Name -ieq 'codex.exe' -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)')
    isDesktopRenderer = [bool]($_.Name -ieq 'ChatGPT.exe' -and $_.CommandLine -match '--type=')
    startedAtUnixMs = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }
  }
})
ConvertTo-Json -InputObject $processes -Compress -Depth 4
`;
  const { stdout } = await execFileAsync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 7000, maxBuffer: 4 * 1024 * 1024 },
  );
  const processes = JSON.parse(stdout);
  if (!Array.isArray(processes))
    throw new Error("Desktop process inspection returned invalid data");
  return processes;
}

function connectToPipe(pipeName, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect(pipeName);
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!connected) socket.destroy();
      resolve(connected ? socket : undefined);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    socket.once("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

export function closeDesktopInput(lines, input = process.stdin) {
  lines?.close();
  input.pause();
}

// Native 0.169 can put literal LF in a Desktop resume string. This is deliberately
// not a general JSON repair path: require an id-first success envelope and a live,
// exact Desktop-owned resume before retaining anything across a line boundary.
export const STOCK_STDOUT_LIMITS = Object.freeze({
  maxChars: 32 * 1024 * 1024,
  maxBytes: 48 * 1024 * 1024,
  maxFragments: 32,
  timeoutMs: 10_000,
});

function stdoutFailure(reason) {
  // Never include native text, identifiers, JSON.parse errors, or error causes.
  return new Error(`Stock stdout rejected (${reason})`);
}

function parseStockJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function resumePrefixId(line) {
  // Bound header work independently of the (potentially very large) string body.
  const header =
    /^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*("(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*,\s*"result"\s*:\s*\{/u.exec(
      line.slice(0, 4096),
    );
  return header === null ? undefined : parseStockJson(header[1]);
}

class StockJsonScanner {
  inString = false;
  escaped = false;
  unicode = 0;
  stack = [];

  scan(text) {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      const code = text.charCodeAt(index);
      if (this.inString) {
        if (code < 0x20) throw stdoutFailure("control-character");
        if (this.unicode > 0) {
          if (!/[0-9a-f]/iu.test(char)) throw stdoutFailure("invalid-escape");
          this.unicode--;
        } else if (this.escaped) {
          this.escaped = false;
          if (char === "u") this.unicode = 4;
          else if (!'"\\/bfnrt'.includes(char)) throw stdoutFailure("invalid-escape");
        } else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
      } else {
        if (code < 0x20 && char !== "\t") throw stdoutFailure("control-character");
        if (char === '"') this.inString = true;
        else if (char === "{" || char === "[") {
          if (this.stack.length >= 256) throw stdoutFailure("nesting-budget");
          this.stack.push(char);
        } else if (char === "}" || char === "]") {
          if (this.stack.pop() !== (char === "}" ? "{" : "["))
            throw stdoutFailure("invalid-structure");
        }
      }
    }
  }

  get canEscapeLf() {
    return this.inString && !this.escaped && this.unicode === 0;
  }
}

/** Consume only primary native stdout, retaining at most one verified resume. */
export async function receiveStockStdout(
  input,
  router,
  { signal, onMessage = () => undefined, ...overrides } = {},
) {
  const limits = { ...STOCK_STDOUT_LIMITS, ...overrides };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let lineBytes = Buffer.alloc(0);
  let pieceBytes = 0;
  let fragments = [];
  let fragmentCount = 0;
  let retainedBytes = 0;
  let retainedChars = 0;
  let pending;
  let scanner;
  let timer;
  let deadline;
  let timedOut = false;
  const clear = () => {
    clearTimeout(timer);
    lineBytes = Buffer.alloc(0);
    fragments = [];
    pending = undefined;
    scanner = undefined;
    pieceBytes = retainedBytes = retainedChars = fragmentCount = 0;
  };
  const cancel = () => {
    clear();
    input.destroy();
  };
  const acceptLine = async (bytes) => {
    let line;
    try {
      line = decoder.decode(bytes);
    } catch {
      throw stdoutFailure("invalid-utf8");
    }
    const separator = pending === undefined ? 0 : 2; // JSON escape, not raw LF.
    if (retainedChars + separator + line.length > limits.maxChars)
      throw stdoutFailure("character-budget");
    const crlf = line.endsWith("\r");
    if ((crlf ? line.slice(0, -1) : line).includes("\r")) throw stdoutFailure("control-character");
    const message = parseStockJson(line);
    if (pending === undefined && message !== undefined) {
      await router.receiveServer(line);
      await onMessage();
      return;
    }
    if (pending === undefined) {
      const id = resumePrefixId(line);
      pending = router.selectPendingDesktopResume(id);
      if (pending === undefined) throw stdoutFailure("not-desktop-resume");
      scanner = new StockJsonScanner();
      deadline = performance.now() + limits.timeoutMs;
      timer = setTimeout(() => {
        timedOut = true;
        clear();
        input.destroy(stdoutFailure("timeout"));
      }, limits.timeoutMs);
    } else {
      if (performance.now() >= deadline) throw stdoutFailure("timeout");
      // A separate response/notification must never be swallowed as resume text.
      if (
        message !== null &&
        typeof message === "object" &&
        ["id", "method", "jsonrpc"].some((key) => Object.hasOwn(message, key))
      )
        throw stdoutFailure("intervening-envelope");
    }
    if (++fragmentCount > limits.maxFragments) throw stdoutFailure("fragment-budget");
    if (crlf) line = line.slice(0, -1);
    scanner.scan(line);
    if (performance.now() >= deadline) throw stdoutFailure("timeout");
    if (crlf && scanner.inString) throw stdoutFailure("control-character");
    if (separator > 0) fragments.push("\\n");
    fragments.push(line);
    retainedBytes += bytes.length + separator;
    retainedChars += line.length + separator;
    if (scanner.canEscapeLf) return;
    if (scanner.inString || scanner.stack.length !== 0) throw stdoutFailure("incomplete-json");
    const restored = fragments.join("");
    const response = parseStockJson(restored);
    if (
      response === null ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      response.id !== pending.id ||
      response.result?.thread?.id !== pending.threadId ||
      Object.keys(response).some((key) => !["id", "result", "jsonrpc"].includes(key)) ||
      (Object.hasOwn(response, "jsonrpc") && response.jsonrpc !== "2.0") ||
      router.selectPendingDesktopResume(pending.id) !== pending
    )
      throw stdoutFailure("invalid-resume-response");
    if (performance.now() >= deadline) throw stdoutFailure("timeout");
    clear();
    await router.receiveServer(restored);
    await onMessage();
  };
  if (signal?.aborted) {
    cancel();
    return;
  }
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of input) {
      if (signal?.aborted) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        if (signal?.aborted) return;
        const lf = buffer.indexOf(0x0a, offset);
        const end = lf === -1 ? buffer.length : lf;
        const length = end - offset;
        if (retainedBytes + pieceBytes + length + (pending === undefined ? 0 : 2) > limits.maxBytes)
          throw stdoutFailure("byte-budget");
        // Geometric storage also bounds allocation metadata for tiny chunk splits.
        if (pieceBytes + length > lineBytes.length) {
          const capacity = Math.min(
            limits.maxBytes,
            Math.max(64 * 1024, pieceBytes + length, lineBytes.length * 2),
          );
          const grown = Buffer.allocUnsafe(capacity);
          lineBytes.copy(grown, 0, 0, pieceBytes);
          lineBytes = grown;
        }
        buffer.copy(lineBytes, pieceBytes, offset, end);
        pieceBytes += length;
        if (lf === -1) break;
        const bytes = lineBytes.subarray(0, pieceBytes);
        pieceBytes = 0;
        await acceptLine(bytes);
        offset = lf + 1;
      }
    }
    if (timedOut) throw stdoutFailure("timeout");
    if (!signal?.aborted && (pending !== undefined || pieceBytes > 0))
      throw stdoutFailure("truncated-eof");
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    clear();
  }
}

export async function bridgeDesktopAppServer(
  executable,
  desktopArgs,
  auxiliary,
  {
    onStartupFinished,
    onDesktopReady,
    readVersion = readStockVersion,
    loadBridgeModules = () =>
      Promise.all([
        import("./application/policy-documentation-service.js"),
        import("./infrastructure/runtime/stdio-app-server-router.js"),
      ]),
  } = {},
) {
  const [{ PolicyDocumentationService }, { attachOmniClientSocket, StdioAppServerRouter }] =
    await loadBridgeModules();
  // Keep Desktop's native stdio origin; its local verification and browser host depend on it.
  const stock = spawn(executable, desktopArgs, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment(),
  });
  if (stock.pid === undefined || stock.stdin === null || stock.stdout === null) {
    throw new Error("Codex Desktop App Server did not expose stdio pipes");
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const directory = join(codexHome, "shared-app-server");
  const nonce = randomUUID();
  const pipeName = `\\\\.\\pipe\\codex-app-server-${stock.pid}-${nonce}`;
  const recordPath = join(directory, `desktop-app-server-${stock.pid}-${nonce}.json`);
  const peers = new Set();
  let stopped = false;
  let published = false;
  let diagnostic = "";
  let desktopLines;
  let publishFlight;
  let stopFlight;
  const stdoutAbort = new AbortController();
  const router = new StdioAppServerRouter({
    sendServer: (line) => stock.stdin.write(`${line}\n`),
    sendDesktop: (line) => process.stdout.write(`${line}\n`),
    policyDocumentation: new PolicyDocumentationService(codexHome),
    ownerKey: nonce,
  });
  const pipe = createServer((socket) => {
    if (stopped) return socket.destroy();
    peers.add(socket);
    attachOmniClientSocket(
      socket,
      router,
      () => peers.delete(socket),
      (error) => console.error(`OmniCodex connection rejected: ${error}`),
    );
  });
  const stop = () => {
    if (stopFlight) return stopFlight;
    stopped = true;
    stdoutAbort.abort();
    // A dead stock child must not leave Desktop waiting on a live stdio bridge.
    closeDesktopInput(desktopLines);
    for (const peer of peers) peer.destroy();
    pipe.close();
    stock.stdin.end();
    if (stock.exitCode === null) stock.kill();
    // A version read or atomic rename may still be in flight when stock exits.
    // Let it settle before removing the record so a dead server cannot publish
    // a stale owner after cleanup.
    stopFlight = (async () => {
      await publishFlight?.catch(() => undefined);
      await rm(`${recordPath}.tmp`, { force: true }).catch(() => undefined);
      await rm(recordPath, { force: true }).catch(() => undefined);
      await onStartupFinished?.();
    })();
    return stopFlight;
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  const parentPid = process.ppid;
  const parentWatch = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") void stop();
    }
  }, 2000);
  parentWatch.unref();
  stock.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096);
  });
  stock.once("exit", (code) => {
    if (!stopped) {
      console.error(`Codex Desktop App Server exited (${code ?? "unknown"}): ${diagnostic}`);
      process.exitCode = code ?? 1;
      void stop();
    }
  });
  stock.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    void stop();
  });
  const publish = async () => {
    if (published || stopped || !router.ready) return;
    const flight = (async () => {
      const version = await readVersion(executable);
      if (stopped) return;
      await mkdir(directory, { recursive: true });
      const record = {
        schemaVersion: 1,
        pid: stock.pid,
        pipeName,
        executablePath: executable,
        appServerVersion: version,
        instanceNonce: nonce,
        routerProtocolVersion: 2,
        ownerKind: auxiliary ? "auxiliary" : "desktop",
        startedAtUnixMs: Date.now(),
      };
      const temporary = `${recordPath}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      if (stopped) return;
      await rename(temporary, recordPath);
      if (stopped) return;
      published = true;
      await onDesktopReady?.();
      await onStartupFinished?.();
    })();
    publishFlight = flight;
    try {
      await flight;
    } finally {
      if (publishFlight === flight) publishFlight = undefined;
    }
  };
  try {
    await new Promise((resolveListen, rejectListen) => {
      pipe.once("error", rejectListen);
      pipe.listen(pipeName, () => {
        pipe.off("error", rejectListen);
        resolveListen();
      });
    });
    desktopLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    void receiveStockStdout(stock.stdout, router, {
      signal: stdoutAbort.signal,
      onMessage: publish,
    }).catch(() => {
      console.error(
        "Codex Desktop App Server output failed (invalid or incomplete stock response)",
      );
      process.exitCode = 1;
      void stop();
    });
    for await (const line of desktopLines) router.receiveDesktop(line);
  } finally {
    await stop();
  }
}
