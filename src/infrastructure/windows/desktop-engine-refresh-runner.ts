import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRefreshOutcome } from "../../application/engine-build-follower.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { spawnHidden, terminateOwnedHiddenChild } from "./hidden-child-process.js";

export interface DesktopEngineRefreshRunnerOptions {
  readonly scriptPath?: string;
  readonly logPath?: string;
  readonly nodeExecutable?: string;
}

/** Keeps the Desktop stock engine selected without rebuilding codex.exe. */
export class DesktopEngineRefreshRunner {
  readonly #scriptPath: string;
  readonly #logPath: string;
  readonly #nodeExecutable: string;

  constructor(options: DesktopEngineRefreshRunnerOptions = {}) {
    this.#scriptPath = resolve(
      options.scriptPath ??
        fileURLToPath(
          new URL(
            "../../../scripts/windows/desktop-engine/refresh-desktop-engine.mjs",
            import.meta.url,
          ),
        ),
    );
    this.#logPath = resolve(
      options.logPath ?? join(omniCodexDataDirectory(), "logs", "engine-refresh.log"),
    );
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
  }

  async refresh(): Promise<EngineRefreshOutcome> {
    await mkdir(dirname(this.#logPath), { recursive: true });
    const log = await open(this.#logPath, "a");
    try {
      await log.writeFile(`\n${new Date().toISOString()} Desktop engine refresh\n`);
      const child = spawnHidden(this.#nodeExecutable, [this.#scriptPath, "--apply"], {
        stdio: ["ignore", "pipe", log.fd],
      });
      const closed = once(child, "close") as Promise<[number | null, string | null]>;
      void closed.catch(() => undefined);
      if (child.stdout === null) {
        terminateOwnedHiddenChild(child);
        await closed.catch(() => undefined);
        throw new Error("Desktop engine refresh stdout is unavailable");
      }
      const output: Buffer[] = [];
      let outputBytes = 0;
      for await (const chunk of child.stdout) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.length;
        if (outputBytes > 65_536) {
          terminateOwnedHiddenChild(child);
          await closed.catch(() => undefined);
          throw new Error("Desktop engine refresh output is too large");
        }
        output.push(bytes);
      }
      const result = Buffer.concat(output).toString("utf8").trim();
      if (result.length > 0) await log.writeFile(`${result}\n`);
      const [exitCode, signal] = await closed;
      if (exitCode !== 0) {
        throw new Error(
          `Desktop engine refresh exited with ${exitCode ?? signal ?? "unknown"}; inspect ${this.#logPath}`,
        );
      }
      const outcome = JSON.parse(result) as unknown;
      if (
        typeof outcome !== "object" ||
        outcome === null ||
        !("status" in outcome) ||
        !["current", "deferred", "busy", "installed"].includes(String(outcome.status)) ||
        ("activeExecutablePath" in outcome && typeof outcome.activeExecutablePath !== "string")
      ) {
        throw new Error("Desktop engine refresh returned an invalid result");
      }
      return outcome as EngineRefreshOutcome;
    } finally {
      await log.close();
    }
  }
}
