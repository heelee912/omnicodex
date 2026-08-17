import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRuntimeDiscovery } from "../src/infrastructure/windows/codex-runtime-discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function executable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "codex-test");
}

describe("CodexRuntimeDiscovery", () => {
  it("orders managed installs before shims, PATH, and explicit fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-discovery-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const managedV1 = join(localAppData, "OpenAI", "Codex", "bin", "hash-v1", "codex.exe");
    const managedV2 = join(localAppData, "OpenAI", "Codex", "bin", "hash-v2", "codex.exe");
    const windowsApps = join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
    const pathDir = join(root, "path");
    const pathExe = join(pathDir, "codex.exe");
    const explicit = join(root, "explicit.exe");
    await Promise.all([
      executable(managedV1),
      executable(managedV2),
      executable(windowsApps),
      executable(pathExe),
      executable(explicit),
    ]);

    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, PATH: pathDir },
      explicitPath: explicit,
      readProductVersion: async (path) =>
        path === managedV1 ? "1.0.0" : path === managedV2 ? "2.0.0" : undefined,
    }).discover();

    expect(report.warnings).toEqual([]);
    expect(report.candidates.map((candidate) => candidate.source)).toEqual([
      "managed_install",
      "managed_install",
      "windows_apps",
      "path",
      "explicit",
    ]);
    expect(report.candidates[0]?.productVersion).toBe("2.0.0");
    expect(report.candidates[1]?.productVersion).toBe("1.0.0");
  });

  it("deduplicates a managed executable that is also on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-discovery-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const managed = join(localAppData, "OpenAI", "Codex", "bin", "hash", "codex.exe");
    await executable(managed);

    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: {
        LOCALAPPDATA: localAppData,
        PATH: join(localAppData, "OpenAI", "Codex", "bin", "hash"),
      },
    }).discover();

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.source).toBe("managed_install");
  });

  it("reports missing managed roots without starting any process", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-discovery-"));
    temporaryDirectories.push(root);
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: join(root, "missing"), PATH: "" },
    }).discover();

    expect(report.candidates).toEqual([]);
    expect(report.warnings).toContain("No installed Codex executable was found");
  });
});
