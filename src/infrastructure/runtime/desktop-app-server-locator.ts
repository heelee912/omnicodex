import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { DesktopEngineBuildReader } from "../windows/desktop-engine-build-reader.js";
import type { RecoveredWindowsProcessIdentity } from "../windows/hidden-child-process.js";

let liveDesktopProcessFlight: Promise<readonly RecoveredWindowsProcessIdentity[]> | undefined;

function readLiveDesktopAppServerProcesses(): Promise<readonly RecoveredWindowsProcessIdentity[]> {
  liveDesktopProcessFlight ??= new DesktopEngineBuildReader()
    .readAppServerProcesses()
    .finally(() => {
      liveDesktopProcessFlight = undefined;
    });
  return liveDesktopProcessFlight;
}

interface DesktopAppServerIdentity {
  readonly pid: number;
  readonly executablePath: string;
  readonly appServerVersion: string;
  readonly instanceNonce: string;
}

export type DesktopAppServerEndpoint = DesktopAppServerIdentity & {
  readonly transport: "named_pipe";
  readonly pipeName: string;
};

type DesktopAppServerRecord = DesktopAppServerEndpoint & { readonly startedAtUnixMs: number };

export interface DesktopAppServerLocatorOptions {
  readonly expectedExecutablePath: string;
  readonly codexHome?: string;
  readonly readAppServerProcesses?: () => Promise<readonly RecoveredWindowsProcessIdentity[]>;
  readonly readDirectory?: (path: string) => Promise<string[]>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Discovers only the live app-server process owned by Codex Desktop. */
export class DesktopAppServerLocator {
  readonly #expectedExecutablePath: string;
  readonly #codexHome: string;
  readonly #readAppServerProcesses: () => Promise<readonly RecoveredWindowsProcessIdentity[]>;
  readonly #readDirectory: (path: string) => Promise<string[]>;
  readonly #readTextFile: (path: string) => Promise<string>;

  constructor(options: DesktopAppServerLocatorOptions) {
    this.#expectedExecutablePath = options.expectedExecutablePath;
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#readAppServerProcesses =
      options.readAppServerProcesses ?? readLiveDesktopAppServerProcesses;
    this.#readDirectory = options.readDirectory ?? readdir;
    this.#readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf8"));
  }

  async locate(): Promise<DesktopAppServerEndpoint> {
    const desktopProcesses = await this.#readAppServerProcesses();
    if (desktopProcesses.length === 0) {
      throw new Error("Codex Desktop owns no app-server process");
    }
    const matchingProcesses = desktopProcesses.filter((processIdentity) =>
      sameWindowsPath(processIdentity.executablePath, this.#expectedExecutablePath),
    );
    if (matchingProcesses.length === 0) {
      throw new Error("Codex Desktop app-server executable differs from the selected engine");
    }
    const directory = join(this.#codexHome, "shared-app-server");
    const files = await this.#readDirectory(directory).catch((error: unknown) => {
      throw new Error("Codex Desktop shared app-server directory is unavailable", { cause: error });
    });
    const processesByPid = new Map(matchingProcesses.map((identity) => [identity.pid, identity]));
    const candidates = await Promise.all(
      files
        .filter((file) => /^desktop-app-server-\d+-[0-9a-f-]{36}\.json$/iu.test(file))
        .map(async (file) => {
          const pid = Number(/^desktop-app-server-(\d+)-/iu.exec(file)?.[1]);
          const processIdentity = processesByPid.get(pid);
          if (processIdentity === undefined) return undefined;
          const startedAtUnixMs = Date.parse(processIdentity.startedAtIso);
          if (!Number.isFinite(startedAtUnixMs)) return undefined;
          try {
            return parseRecord(
              JSON.parse(await this.#readTextFile(join(directory, file))) as unknown,
              file,
              processIdentity,
              this.#expectedExecutablePath,
              startedAtUnixMs,
            );
          } catch {
            return undefined;
          }
        }),
    );
    const valid = candidates.filter(
      (record): record is DesktopAppServerRecord => record !== undefined,
    );
    // Pin all OmniCodex clients to the oldest live instance of this Desktop build.
    // New Desktop chats may start additional app servers without splitting their threads.
    valid.sort(
      (left, right) => left.startedAtUnixMs - right.startedAtUnixMs || left.pid - right.pid,
    );
    const selected = valid[0];
    if (selected === undefined) {
      throw new Error("Codex Desktop shared app-server pipe was not published by the live process");
    }
    const identity = {
      pid: selected.pid,
      executablePath: selected.executablePath,
      appServerVersion: selected.appServerVersion,
      instanceNonce: selected.instanceNonce,
    };
    return { ...identity, transport: "named_pipe", pipeName: selected.pipeName };
  }
}

function parseRecord(
  value: unknown,
  file: string,
  processIdentity: RecoveredWindowsProcessIdentity,
  expectedExecutablePath: string,
  processStartedAtUnixMs: number,
): DesktopAppServerRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<DesktopAppServerIdentity> & {
    schemaVersion?: number;
    startedAtUnixMs?: number;
    pipeName?: string;
  };
  if (record.schemaVersion !== 1 || record.pid !== processIdentity.pid) {
    return undefined;
  }
  if (typeof record.executablePath !== "string") return undefined;
  if (!sameWindowsPath(record.executablePath, processIdentity.executablePath)) return undefined;
  if (!sameWindowsPath(record.executablePath, expectedExecutablePath)) return undefined;
  if (typeof record.instanceNonce !== "string" || !/^[0-9a-f-]{36}$/iu.test(record.instanceNonce)) {
    return undefined;
  }
  if (file !== `desktop-app-server-${record.pid}-${record.instanceNonce}.json`) return undefined;
  if (record.pipeName !== `\\\\.\\pipe\\codex-app-server-${record.pid}-${record.instanceNonce}`) {
    return undefined;
  }
  if (typeof record.appServerVersion !== "string" || record.appServerVersion.length === 0) {
    return undefined;
  }
  if (typeof record.startedAtUnixMs !== "number") return undefined;
  if (
    record.startedAtUnixMs < processStartedAtUnixMs ||
    record.startedAtUnixMs > Date.now() + 60_000
  ) {
    return undefined;
  }
  return { ...record, transport: "named_pipe" } as DesktopAppServerRecord;
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}
