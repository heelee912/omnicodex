import {
  inspectWindowsProcessesByNames,
  type RecoveredWindowsProcessIdentity,
} from "./hidden-child-process.js";

type InspectDesktopProcesses = (
  names: readonly string[],
) => Promise<readonly RecoveredWindowsProcessIdentity[]>;

/** Reads the engine actually owned by the desktop app, without starting or attaching to it. */
export class DesktopEngineBuildReader {
  readonly #inspect: InspectDesktopProcesses;

  constructor(inspect: InspectDesktopProcesses = inspectWindowsProcessesByNames) {
    this.#inspect = inspect;
  }

  async readExecutablePath(): Promise<string | undefined> {
    return (await this.readAppServerProcesses())[0]?.executablePath;
  }

  async readAppServerProcess(): Promise<RecoveredWindowsProcessIdentity | undefined> {
    const processes = await this.readAppServerProcesses();
    return processes.length === 1 ? processes[0] : undefined;
  }

  async readAppServerProcesses(): Promise<readonly RecoveredWindowsProcessIdentity[]> {
    const processes = await this.#inspect([
      "ChatGPT.exe",
      "codex.exe",
      "OmniCodexDesktopEngine.exe",
      "node.exe",
    ]);
    const desktopPids = new Set(
      processes
        .filter(
          (app) =>
            app.name.toLowerCase() === "chatgpt.exe" &&
            /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/iu.test(app.executablePath) &&
            !/--type=/u.test(app.commandLine),
        )
        .map((app) => app.pid),
    );
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const owned = processes.filter((engine) => {
      if (engine.name.toLowerCase() !== "codex.exe") return false;
      if (!/(?:^|\s)app-server(?:\s|$)/u.test(engine.commandLine)) return false;
      if (desktopPids.has(engine.parentPid)) return true;
      const node = byPid.get(engine.parentPid);
      if (
        node?.name.toLowerCase() !== "node.exe" ||
        !/[\\/]stock-app-server-stdio\.mjs(?:"|\s)/iu.test(node.commandLine)
      )
        return false;
      const bridge = byPid.get(node.parentPid);
      return (
        bridge?.name.toLowerCase() === "omnicodexdesktopengine.exe" &&
        desktopPids.has(bridge.parentPid)
      );
    });
    return owned.sort(
      (left, right) =>
        Date.parse(right.startedAtIso) - Date.parse(left.startedAtIso) || right.pid - left.pid,
    );
  }
}
