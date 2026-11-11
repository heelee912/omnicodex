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

async function executable(path: string, content = path): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

describe("CodexRuntimeDiscovery", () => {
  it("follows the live Desktop engine when an update changes its executable path", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "omnicodex-live-desktop-"));
    temporaryDirectories.push(localAppData);
    const first = join(localAppData, "engine-v1", "codex.exe");
    const second = join(localAppData, "engine-v2", "codex.exe");
    await Promise.all([executable(first), executable(second)]);
    let active = first;
    let reads = 0;
    const discovery = new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      readDesktopExecutablePath: async () => {
        reads += 1;
        return active;
      },
    });
    expect((await discovery.discover()).candidates[0]?.executablePath).toBe(first);
    active = second;
    expect((await discovery.discover()).candidates[0]?.executablePath).toBe(second);
    expect((await discovery.discover(second)).candidates[0]?.executablePath).toBe(second);
    expect(reads).toBe(2);
  });

  it("uses the live Desktop engine even when LOCALAPPDATA cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-live-only-"));
    temporaryDirectories.push(root);
    const desktopExecutable = join(root, "codex.exe");
    await executable(desktopExecutable);
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: {},
      resolveLocalAppData: () => {
        throw new Error("known folder unavailable");
      },
      readDesktopExecutablePath: async () => desktopExecutable,
    }).discover();
    expect(report.candidates[0]?.executablePath).toBe(desktopExecutable);
  });

  it("scans managed installs and WindowsApps from the current account's known folder", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "omnicodex-known-folder-"));
    temporaryDirectories.push(localAppData);
    const managed = join(localAppData, "OpenAI", "Codex", "bin", "build", "codex.exe");
    const shim = join(localAppData, "Microsoft", "WindowsApps", "codex.exe");
    await Promise.all([executable(managed), executable(shim)]);
    let queries = 0;
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: {},
      resolveLocalAppData: () => {
        queries += 1;
        return localAppData;
      },
    }).discover();
    expect(queries).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(report.candidates.map((candidate) => candidate.executablePath)).toEqual([managed, shim]);
  });

  it.each(["win32", "linux"] as const)(
    "preserves explicit LOCALAPPDATA without querying the Windows account on %s",
    async (platform) => {
      const localAppData = await mkdtemp(join(tmpdir(), "omnicodex-explicit-folder-"));
      temporaryDirectories.push(localAppData);
      const report = await new CodexRuntimeDiscovery({
        platform,
        env: { LOCALAPPDATA: localAppData },
        resolveLocalAppData: () => {
          throw new Error("unexpected known folder query");
        },
      }).discover();
      expect(report.warnings).toEqual(["No installed Codex executable was found"]);
    },
  );

  it("does not query a Windows known folder when LOCALAPPDATA is absent outside Windows", async () => {
    let queries = 0;
    const report = await new CodexRuntimeDiscovery({
      platform: "linux",
      env: {},
      resolveLocalAppData: () => {
        queries += 1;
        throw new Error("unexpected known folder query");
      },
    }).discover();
    expect(queries).toBe(0);
    expect(report.candidates).toEqual([]);
    expect(report.warnings).toContain(
      "LOCALAPPDATA is unavailable; managed Codex installation was not scanned",
    );
  });

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

  it("uses the Desktop-selected immutable engine before the stock managed build", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-desktop-engine-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const selected = join(
      localAppData,
      "OmniCodex",
      "engine-generations",
      `codex-${"a".repeat(64)}`,
      "package",
      "codex.exe",
    );
    const stock = join(localAppData, "OpenAI", "Codex", "bin", "stock", "codex.exe");
    await Promise.all([executable(selected, "desktop-build"), executable(stock, "stock-build")]);
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, CODEX_CLI_PATH: selected, PATH: "" },
    }).discover();
    expect(report.candidates.map((candidate) => candidate.executablePath)).toEqual([
      selected,
      stock,
    ]);
    expect(report.candidates[0]?.source).toBe("managed_install");
  });

  it("ignores a Desktop engine override outside the immutable generation store", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-desktop-engine-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const unowned = join(root, "unowned", "codex.exe");
    const stock = join(localAppData, "OpenAI", "Codex", "bin", "stock", "codex.exe");
    await Promise.all([executable(unowned), executable(stock)]);
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, CODEX_CLI_PATH: unowned, PATH: "" },
    }).discover();
    expect(report.candidates.map((candidate) => candidate.executablePath)).toEqual([stock]);
  });

  it("uses the configured OmniCodex data directory for the Desktop engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-custom-engine-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const dataDirectory = join(root, "CustomOmniCodex");
    const selected = join(
      dataDirectory,
      "engine-generations",
      `codex-${"b".repeat(64)}`,
      "package",
      "codex.exe",
    );
    await executable(selected);
    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: {
        LOCALAPPDATA: localAppData,
        OMNICODEX_DATA_DIR: dataDirectory,
        CODEX_CLI_PATH: selected,
        PATH: "",
      },
    }).discover();
    expect(report.candidates.map((candidate) => candidate.executablePath)).toEqual([selected]);
  });

  it("deduplicates different paths that contain the exact same installed build", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-discovery-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const managed = join(localAppData, "OpenAI", "Codex", "bin", "hash", "codex.exe");
    const pathDirectory = join(root, "path");
    const pathExecutable = join(pathDirectory, "codex.exe");
    await Promise.all([
      executable(managed, "same-build"),
      executable(pathExecutable, "same-build"),
    ]);

    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, PATH: pathDirectory },
    }).discover();

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      source: "managed_install",
      buildSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("resolves the native binary behind a global npm Codex PATH installation without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-discovery-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "LocalAppData");
    const npmBin = join(root, "npm-bin");
    const npmRuntime = join(
      npmBin,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    await executable(npmRuntime, "global-npm-codex-build");

    const report = await new CodexRuntimeDiscovery({
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: localAppData, PATH: npmBin },
    }).discover();

    expect(report.candidates).toEqual([
      expect.objectContaining({
        executablePath: npmRuntime,
        canonicalPath: npmRuntime,
        source: "path",
        buildSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
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
