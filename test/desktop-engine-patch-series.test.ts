import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts/windows/desktop-engine/apply-patch-series.mjs",
);
const prepareScript = resolve(dirname(script), "prepare-engine-source.mjs");
const buildScript = resolve(dirname(script), "build-engine-package.mjs");

function run(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

describe("Desktop engine patch series", () => {
  it("applies a verified patch to a matching clean checkout and rejects a changed hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-engine-patch-test-"));
    try {
      const source = join(root, "source");
      const patches = join(root, "patches");
      const sourceFile = join(source, "codex-rs", "core", "src", "example.rs");
      await mkdir(dirname(sourceFile), { recursive: true });
      await mkdir(patches);
      run("git", ["-C", source, "init", "-q"]);
      await writeFile(sourceFile, "fn example() -> bool { false }\n");
      run("git", ["-C", source, "add", "."]);
      run("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base",
      ]);
      const upstreamCommit = run("git", ["-C", source, "rev-parse", "HEAD"]);
      run("git", ["-C", source, "tag", "rust-v0.1.0", upstreamCommit]);
      run("git", ["-C", source, "remote", "add", "origin", "https://github.com/openai/codex.git"]);
      await writeFile(sourceFile, "fn example() -> bool { true }\n");
      const patch = execFileSync("git", ["-C", source, "diff", "--binary", "--full-index"], {
        windowsHide: true,
      });
      await writeFile(sourceFile, "fn example() -> bool { false }\n");
      await writeFile(join(patches, "01-example.patch"), patch);
      const manifestPath = join(patches, "patch-series.json");
      const manifest = {
        schemaVersion: 1,
        upstreamCommit,
        upstreamTag: "rust-v0.1.0",
        codexCliVersion: "0.1.0",
        patches: [
          {
            file: "01-example.patch",
            sha256: createHash("sha256").update(patch).digest("hex"),
            files: 1,
          },
        ],
      };
      await writeFile(manifestPath, JSON.stringify(manifest));

      expect(
        JSON.parse(run(process.execPath, [script, source, manifestPath, "--check"])),
      ).toMatchObject({
        mode: "checked",
        changedFiles: 1,
      });
      await writeFile(join(source, "codex-rs", "unrelated.txt"), "later upstream change\n");
      run("git", ["-C", source, "add", "."]);
      run("git", [
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "later",
      ]);
      expect(() => run(process.execPath, [script, source, manifestPath, "--check"])).toThrow();
      expect(
        JSON.parse(run(process.execPath, [script, source, manifestPath, "--check", "--forward"])),
      ).toMatchObject({ mode: "checked", changedFiles: 1 });
      run("git", ["-C", source, "tag", "rust-v0.2.0"]);
      const forwardBuildRoot = join(root, "forward-builds");
      const forward = JSON.parse(
        run(process.execPath, [
          prepareScript,
          source,
          "rust-v0.2.0",
          manifestPath,
          forwardBuildRoot,
        ]),
      );
      expect(forward.patchBaseCommit).toBe(upstreamCommit);
      expect(
        JSON.parse(
          run(process.execPath, [
            buildScript,
            forward.checkout,
            manifestPath,
            join(root, "forward-target"),
            join(root, "forward-package"),
            "--check",
          ]),
        ),
      ).toMatchObject({ codexCliVersion: "0.2.0" });
      run("git", ["-C", source, "worktree", "remove", "--force", forward.checkout]);
      expect(
        JSON.parse(run(process.execPath, [script, source, manifestPath, "--forward"])),
      ).toMatchObject({
        mode: "applied",
        changedFiles: 1,
      });
      expect(await readFile(sourceFile, "utf8")).toContain("true");
      await writeFile(sourceFile, "fn example() -> bool { true } // unrelated local edit\n");

      const buildRoot = join(root, "builds");
      const prepared = JSON.parse(
        run(process.execPath, [prepareScript, source, "rust-v0.1.0", manifestPath, buildRoot]),
      );
      const marker = JSON.parse(
        await readFile(join(prepared.checkout, "engine-source-prepared.json"), "utf8"),
      );
      expect(marker.sourceDiffSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(marker.sourceDiffSha256).toBe(prepared.sourceDiffSha256);
      expect(marker.changedPaths).toEqual([
        {
          path: "codex-rs/core/src/example.rs",
          sha256: createHash("sha256")
            .update(await readFile(join(prepared.checkout, "codex-rs/core/src/example.rs")))
            .digest("hex"),
        },
      ]);
      expect(marker.sourceDiffSha256).toBe(
        createHash("sha256")
          .update(run("git", ["-C", prepared.checkout, "diff", "--binary", "--full-index", "HEAD"]))
          .digest("hex"),
      );
      expect(
        await readFile(join(prepared.checkout, "codex-rs/core/src/example.rs"), "utf8"),
      ).toContain("true");
      expect(
        JSON.parse(
          run(process.execPath, [
            buildScript,
            prepared.checkout,
            manifestPath,
            join(root, "target"),
            join(root, "package"),
            "--check",
          ]),
        ),
      ).toMatchObject({ codexCliVersion: "0.1.0" });
      await writeFile(
        join(prepared.checkout, "codex-rs/core/src/example.rs"),
        "fn example() -> bool { false }\n",
      );
      expect(() =>
        run(process.execPath, [
          buildScript,
          prepared.checkout,
          manifestPath,
          join(root, "target"),
          join(root, "package"),
          "--check",
        ]),
      ).toThrow();
      expect(relative(buildRoot, resolve(prepared.checkout))).toMatch(/^b-[a-f0-9]{8}$/u);
      run("git", ["-C", source, "worktree", "remove", "--force", prepared.checkout]);

      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          patches: [{ ...manifest.patches[0], sha256: "0".repeat(64) }],
        }),
      );
      expect(() => run(process.execPath, [script, source, manifestPath, "--forward"])).toThrow();

      expect(() =>
        run(process.execPath, [prepareScript, source, "rust-v0.1.0", manifestPath, buildRoot]),
      ).toThrow();
      expect(await readdir(buildRoot)).toEqual([]);
      expect(
        run("git", ["-C", source, "worktree", "list", "--porcelain"]).match(/^worktree /gmu),
      ).toHaveLength(1);
    } finally {
      const withinTemp = relative(tmpdir(), root);
      if (withinTemp !== "" && !withinTemp.startsWith("..") && !isAbsolute(withinTemp)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
