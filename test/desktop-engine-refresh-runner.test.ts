import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopEngineRefreshRunner } from "../src/infrastructure/windows/desktop-engine-refresh-runner.js";

describe("DesktopEngineRefreshRunner", () => {
  it("runs the refresh command directly and records its result", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-engine-runner-"));
    try {
      const scriptPath = join(root, "refresh.mjs");
      const logPath = join(root, "refresh.log");
      await writeFile(
        scriptPath,
        "process.stdout.write(JSON.stringify({status:'current',activeExecutablePath:'C:/engine/codex.exe'})+'\\n');\n",
      );
      const runner = new DesktopEngineRefreshRunner({ scriptPath, logPath });
      await expect(runner.refresh()).resolves.toEqual({
        status: "current",
        activeExecutablePath: "C:/engine/codex.exe",
      });
      expect(await readFile(logPath, "utf8")).toContain('"status":"current"');

      await writeFile(
        scriptPath,
        "process.stdout.write(JSON.stringify({status:'deferred',reason:'memory_pressure'})+'\\n');\n",
      );
      await expect(runner.refresh()).resolves.toMatchObject({
        status: "deferred",
        reason: "memory_pressure",
      });

      await writeFile(scriptPath, "process.stderr.write('build-failed\\n'); process.exit(7);\n");
      await expect(runner.refresh()).rejects.toThrow("exited with 7");
      expect(await readFile(logPath, "utf8")).toContain("build-failed");
    } finally {
      const beneathTemp = relative(tmpdir(), root);
      if (beneathTemp !== "" && !beneathTemp.startsWith("..") && !isAbsolute(beneathTemp)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
