import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const fileNames = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
];

describe("Desktop engine generation", () => {
  it("stages an immutable generation with version and hashes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "omnicodex-generation-"));
    try {
      const source = join(temporary, "source");
      const root = join(temporary, "generations");
      await mkdir(source);
      const hashes: Record<string, string> = {};
      for (const name of fileNames) {
        const content = `binary:${name}`;
        await writeFile(join(source, name), content);
        hashes[name] = createHash("sha256").update(content).digest("hex");
      }
      const script = join(
        process.cwd(),
        "scripts",
        "windows",
        "desktop-engine",
        "stage-engine.mjs",
      );
      const stage = () =>
        execFileSync(process.execPath, [script, source, root, "codex-cli 0.165.0-alpha.1.2"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      const selected = stage();
      const generationRoot = dirname(dirname(selected));
      const manifest = JSON.parse(
        await readFile(join(generationRoot, "engine-generation.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        codexCliVersion: "0.165.0-alpha.1.2",
        files: hashes,
      });
      expect(manifest.generation).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.stagedAtUnixMs).toBeGreaterThan(0);
      expect(stage()).toBe(selected);
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      const beneathTemp = relative(tmpdir(), temporary);
      if (beneathTemp !== "" && !beneathTemp.startsWith("..") && !isAbsolute(beneathTemp)) {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  });
});
