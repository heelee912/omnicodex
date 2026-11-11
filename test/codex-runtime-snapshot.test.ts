import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { snapshotManagedCodexRuntime } from "../src/infrastructure/runtime/codex-runtime-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-package-test-"));
  roots.push(root);
  const source = join(root, "installed");
  await mkdir(source);
  for (const name of [
    "codex.exe",
    "codex-code-mode-host.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
    "extra.dll",
  ]) {
    await writeFile(join(source, name), name);
  }
  const candidate: RuntimeCandidate = {
    executablePath: join(source, "codex.exe"),
    canonicalPath: join(source, "codex.exe"),
    source: "managed_install",
    buildSha256: createHash("sha256").update("codex.exe").digest("hex"),
  };
  return { root, source, candidate };
}

it("keeps a complete generation usable when an updater removes installed sidecars", async () => {
  const { root, source, candidate } = await fixture();
  const snapshot = await snapshotManagedCodexRuntime(candidate, join(root, "owned"), "win32");
  await unlink(join(source, "codex-code-mode-host.exe"));
  await writeFile(join(source, "codex.exe"), "new generation");
  expect(await readFile(snapshot.executablePath, "utf8")).toBe("codex.exe");
  expect(
    await readFile(join(dirname(snapshot.executablePath), "codex-code-mode-host.exe"), "utf8"),
  ).toBe("codex-code-mode-host.exe");
  expect(await readFile(join(dirname(snapshot.executablePath), "extra.dll"), "utf8")).toBe(
    "extra.dll",
  );
  expect(snapshot.buildSha256).toBe(candidate.buildSha256);
});

it("rejects an incomplete installed package before starting its executable", async () => {
  const { root, source, candidate } = await fixture();
  await unlink(join(source, "codex-code-mode-host.exe"));
  await expect(
    snapshotManagedCodexRuntime(candidate, join(root, "owned"), "win32"),
  ).rejects.toThrow("CODEX_RUNTIME_PACKAGE_INCOMPLETE");
});

it("rejects a binary replaced since discovery", async () => {
  const { root, source, candidate } = await fixture();
  await writeFile(join(source, "codex.exe"), "different version");
  await expect(
    snapshotManagedCodexRuntime(candidate, join(root, "owned"), "win32"),
  ).rejects.toThrow("CODEX_RUNTIME_PACKAGE_CHANGED");
});

it("reuses one owned package for repeated preparation of the same generation", async () => {
  const { root, candidate } = await fixture();
  const owned = join(root, "owned");
  const first = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  const second = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  expect(second.executablePath).toBe(first.executablePath);
  expect(await readdir(owned)).toHaveLength(1);
});

it("publishes one package when the same generation is prepared concurrently", async () => {
  const { root, candidate } = await fixture();
  const owned = join(root, "owned");
  const [first, second] = await Promise.all([
    snapshotManagedCodexRuntime(candidate, owned, "win32"),
    snapshotManagedCodexRuntime(candidate, owned, "win32"),
  ]);
  expect(second.executablePath).toBe(first.executablePath);
  expect(await readdir(owned)).toHaveLength(1);
});

it("pins a new generation when a sidecar changes without changing codex.exe", async () => {
  const { root, source, candidate } = await fixture();
  const owned = join(root, "owned");
  const first = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  await writeFile(join(source, "codex-code-mode-host.exe"), "updated sidecar");
  const second = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  expect(second.executablePath).not.toBe(first.executablePath);
  expect(
    await readFile(join(dirname(first.executablePath), "codex-code-mode-host.exe"), "utf8"),
  ).toBe("codex-code-mode-host.exe");
  expect(
    await readFile(join(dirname(second.executablePath), "codex-code-mode-host.exe"), "utf8"),
  ).toBe("updated sidecar");
});

it("refuses a damaged owned package instead of silently reusing it", async () => {
  const { root, candidate } = await fixture();
  const owned = join(root, "owned");
  const first = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  await writeFile(join(dirname(first.executablePath), "extra.dll"), "damaged");
  await expect(snapshotManagedCodexRuntime(candidate, owned, "win32")).rejects.toThrow(
    "CODEX_RUNTIME_PACKAGE_CHANGED",
  );
});

it("uses one staged Desktop generation without copying a second OmniCodex package", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-desktop-stage-test-"));
  roots.push(root);
  const source = join(root, "release");
  const owned = join(root, "engine-generations");
  await mkdir(source);
  for (const name of [
    "codex.exe",
    "codex-code-mode-host.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
  ]) {
    await writeFile(join(source, name), name);
  }
  const stageScript = join(
    process.cwd(),
    "scripts",
    "windows",
    "desktop-engine",
    "stage-engine.mjs",
  );
  const selected = execFileSync(
    process.execPath,
    [stageScript, source, owned, "codex-cli 0.165.0-alpha.1.2"],
    { encoding: "utf8" },
  ).trim();
  const candidate: RuntimeCandidate = {
    executablePath: selected,
    canonicalPath: selected,
    source: "managed_install",
    buildSha256: createHash("sha256").update("codex.exe").digest("hex"),
  };
  const runtime = await snapshotManagedCodexRuntime(candidate, owned, "win32");
  expect(runtime.executablePath).toBe(selected);
  expect(await readdir(owned)).toHaveLength(1);
  await writeFile(join(dirname(selected), "codex-code-mode-host.exe"), "changed");
  await expect(snapshotManagedCodexRuntime(candidate, owned, "win32")).rejects.toThrow(
    "CODEX_RUNTIME_PACKAGE_CHANGED",
  );
  expect(await readdir(owned)).toHaveLength(1);
});
