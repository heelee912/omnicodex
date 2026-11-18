import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { compareStockVersions, findStockExecutable, prepareDesktopRuntime, readStockVersion } =
  await import(
    pathToFileURL(resolve("scripts/windows/desktop-engine/stock-codex-executable.mjs")).href
  );
const { main } = await import(
  pathToFileURL(resolve("scripts/windows/desktop-engine/stock-app-server-stdio.mjs")).href
);
const files = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "dependency.dll",
];
const oldVersion = "0.167.0-alpha.4.1";
const newVersion = "0.169.0-alpha.11.1";

async function fakeRuntime(directory: string, version: string) {
  await mkdir(directory, { recursive: true });
  for (const name of files) {
    await writeFile(join(directory, name), name === "codex.exe" ? version : `${name}:${version}`);
  }
}

async function fixture() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "codex-runtime-test-"));
  const installLocation = join(root, "OpenAI.Codex_26.1111.2228.0_x64__test");
  const source = join(installLocation, "app", "resources");
  const managedRoot = join(root, "managed");
  const old = join(managedRoot, "9e1da79431da526b");
  await fakeRuntime(source, newVersion);
  await fakeRuntime(old, oldVersion);
  await writeFile(join(source, "auth.json"), "DO NOT COPY CREDENTIALS");
  await writeFile(join(source, "config.toml"), "DO NOT COPY CONFIG");
  await mkdir(join(source, "profile"));
  await writeFile(join(source, "profile", "secrets"), "DO NOT COPY PROFILE");
  const desktop = {
    pid: 10,
    parentPid: 1,
    name: "ChatGPT.exe",
    executablePath: join(installLocation, "app", "ChatGPT.exe"),
    startedAtUnixMs: 1000,
  };
  const identity = {
    name: "OpenAI.Codex",
    fullName: basename(installLocation),
    installLocation,
    signatureKind: "Store",
    status: "Ok",
    pid: desktop.pid,
    executablePath: desktop.executablePath,
    startedAtUnixMs: desktop.startedAtUnixMs,
  };
  const readVersion = vi.fn(async (executable: string) => readFile(executable, "utf8"));
  const inspectPackage = vi.fn(async () => ({ ...identity }));
  const verifySignatures = vi.fn(async () => undefined);
  const options = { managedRoot, readVersion, inspectPackage, verifySignatures };
  const selected = join(old, "codex.exe");
  return { root, source, old, desktop, identity, options, selected, managedRoot };
}

describe("update-aware Desktop whole-runtime staging", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("publishes one complete runtime without credentials and leaves the old generation byte-unchanged", async () => {
    const before = await Promise.all(files.map((name) => readFile(join(f.old, name))));
    const prepare = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
    const directory = dirname(prepare.executable);
    expect(directory).not.toBe(f.old);
    expect(basename(dirname(directory))).toMatch(/^desktop-runtime-/u);
    expect((await readdir(directory)).sort()).toEqual([...files].sort());
    expect((await readdir(dirname(directory))).sort()).toEqual(["desktop-runtime.json", "runtime"]);
    for (const name of files) {
      expect(await readFile(join(directory, name))).toEqual(await readFile(join(f.source, name)));
    }
    expect(await Promise.all(files.map((name) => readFile(join(f.old, name))))).toEqual(before);
    expect(await findStockExecutable(f.options)).toBe(f.selected);
    await prepare.activate();
    expect(await findStockExecutable(f.options)).toBe(prepare.executable);
    // Gateway's independent flat managed-root scan cannot preselect this runtime.
    expect(
      await readFile(join(dirname(directory), "codex.exe"), "utf8").catch(() => undefined),
    ).toBeUndefined();
    expect(await readdir(f.managedRoot)).toHaveLength(2);
    expect(f.options.inspectPackage).toHaveBeenCalledWith(f.desktop);
    expect(f.options.verifySignatures).toHaveBeenCalledWith(
      files.filter((name) => name.endsWith(".exe")).map((name) => join(f.source, name)),
    );
  });

  it("does not expose a partial copy or a complete but not-yet-initialized Desktop runtime", async () => {
    const copy = vi.fn(async (source: string, destination: string, flags: number) => {
      await copyFile(source, destination, flags);
      expect(await findStockExecutable(f.options)).toBe(f.selected);
      const directories = await readdir(f.managedRoot);
      const visible = await Promise.all(
        directories.map(async (name) =>
          readFile(join(f.managedRoot, name, "codex.exe"), "utf8").catch(() => undefined),
        ),
      );
      expect(visible.filter(Boolean)).toEqual([oldVersion]);
    });
    const prepared = await prepareDesktopRuntime(f.selected, f.desktop, { ...f.options, copy });
    expect(copy).toHaveBeenCalledTimes(files.length);
    expect(await findStockExecutable(f.options)).toBe(f.selected);
    await prepared.activate();
    expect(await findStockExecutable(f.options)).toBe(prepared.executable);
  });

  it.each([false, true])(
    "reuses an existing complete generation (ready=%s) without copying",
    async (ready) => {
      const first = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
      if (ready) await first.activate();
      const copy = vi.fn(async () => {
        throw new Error("must not copy");
      });
      const second = await prepareDesktopRuntime(f.selected, f.desktop, { ...f.options, copy });
      expect(second.executable).toBe(first.executable);
      expect(copy).not.toHaveBeenCalled();
      await second.activate();
      expect(await findStockExecutable(f.options)).toBe(first.executable);
      expect(await readdir(f.managedRoot)).toHaveLength(2);
    },
  );

  it.each(files.filter((name) => name.endsWith(".exe")))(
    "fails closed on an incomplete newer bundle missing %s without publication",
    async (name) => {
      await rm(join(f.source, name));
      await expect(prepareDesktopRuntime(f.selected, f.desktop, f.options)).rejects.toThrow();
      expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
      expect(await findStockExecutable(f.options)).toBe(f.selected);
    },
  );

  it("fails before executing the package when Authenticode verification fails", async () => {
    await expect(
      prepareDesktopRuntime(f.selected, f.desktop, {
        ...f.options,
        verifySignatures: async () => {
          throw new Error("Invalid Desktop runtime signature");
        },
      }),
    ).rejects.toThrow("signature");
    expect(f.options.readVersion).not.toHaveBeenCalled();
    expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
  });

  it.each(["copy", "source", "dll-added", "version", "package"])(
    "cleans pending staging and fails without publication on %s mismatch",
    async (mismatch) => {
      const copy = async (source: string, destination: string, flags: number) => {
        await copyFile(source, destination, flags);
        if (basename(source) !== "codex.exe") return;
        if (mismatch === "copy") await writeFile(destination, "corrupted copy");
        if (mismatch === "source") await writeFile(source, "changed package binary");
        if (mismatch === "dll-added")
          await writeFile(join(f.source, "added.dll"), "new dependency");
        if (mismatch === "package") f.identity.fullName = "OpenAI.Codex_changed";
      };
      const readVersion = async (path: string) => {
        if (
          mismatch === "version" &&
          basename(dirname(dirname(path))).startsWith(".desktop-runtime-")
        ) {
          return "0.168.0";
        }
        return f.options.readVersion(path);
      };
      await expect(
        prepareDesktopRuntime(f.selected, f.desktop, { ...f.options, copy, readVersion }),
      ).rejects.toThrow();
      expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
      expect(await findStockExecutable(f.options)).toBe(f.selected);
    },
  );

  it("reuses an equal-version package only when every executable and DLL matches", async () => {
    for (const name of files) await copyFile(join(f.old, name), join(f.source, name));
    const result = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
    expect(result.executable).toBe(f.selected);
    await result.activate();
    expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
  });

  it.each([oldVersion, "0.167.0-alpha.4.1+build"])(
    "stages same-version %s when a sidecar differs",
    async (version) => {
      await writeFile(join(f.source, "codex.exe"), version);
      const result = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
      expect(result.executable).not.toBe(f.selected);
      await result.activate();
      expect(await findStockExecutable(f.options)).toBe(result.executable);
    },
  );

  it("fails closed on a running package older than the selected managed runtime", async () => {
    await writeFile(join(f.source, "codex.exe"), "0.166.0-alpha.9");
    await expect(prepareDesktopRuntime(f.selected, f.desktop, f.options)).rejects.toThrow(
      "older than the selected managed",
    );
    expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
  });

  it.each(["pid", "start", "path", "registration", "signatureKind", "status"])(
    "rejects a mismatched or untrusted running package identity: %s",
    async (mismatch) => {
      if (mismatch === "pid") f.identity.pid++;
      if (mismatch === "start") f.identity.startedAtUnixMs++;
      if (mismatch === "path")
        f.identity.executablePath = join(f.root, "user-controlled", "ChatGPT.exe");
      if (mismatch === "registration") f.identity.installLocation = f.root;
      if (mismatch === "signatureKind") f.identity.signatureKind = "Developer";
      if (mismatch === "status") f.identity.status = "Modified";
      await expect(prepareDesktopRuntime(f.selected, f.desktop, f.options)).rejects.toThrow(
        "trusted registered AppX",
      );
      expect(f.options.readVersion).not.toHaveBeenCalled();
      expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
    },
  );

  it("rejects a non-regular sidecar without publishing a generation", async () => {
    const sidecar = join(f.source, "codex-command-runner.exe");
    await rm(sidecar);
    await mkdir(sidecar);
    await expect(prepareDesktopRuntime(f.selected, f.desktop, f.options)).rejects.toThrow(
      "non-symlink file",
    );
    expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
  });

  it("rejects a linked resources directory from another package", async () => {
    const external = join(f.root, "other-package");
    await mkdir(external);
    await rm(f.source, { recursive: true });
    await symlink(external, f.source, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareDesktopRuntime(f.selected, f.desktop, f.options)).rejects.toThrow(
      "non-symlink directory",
    );
    expect(await readdir(f.managedRoot)).toEqual([basename(f.old)]);
  });

  it("preserves a tampered generation but stages a fresh package instead of reusing it", async () => {
    const staged = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
    await staged.activate();
    await writeFile(join(dirname(staged.executable), "codex-command-runner.exe"), "wrong build");
    expect(await findStockExecutable(f.options)).toBe(f.selected);
    const repaired = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
    expect(repaired.executable).not.toBe(staged.executable);
    expect(
      await readFile(join(dirname(staged.executable), "codex-command-runner.exe"), "utf8"),
    ).toBe("wrong build");
    expect(await findStockExecutable(f.options)).toBe(f.selected);
    await repaired.activate();
    expect(await findStockExecutable(f.options)).toBe(repaired.executable);
    expect(await readdir(f.managedRoot)).toHaveLength(3);
  });

  it("stages only for the exact owning Desktop and activates only after its successful initialization", async () => {
    const launcher = {
      pid: 20,
      parentPid: f.desktop.pid,
      name: "OmniCodexDesktopEngine.exe",
      startedAtUnixMs: 2000,
    };
    const node = {
      pid: 30,
      parentPid: launcher.pid,
      name: "node.exe",
      isStockBridgeNode: true,
      startedAtUnixMs: 3000,
    };
    const inventory = [
      {
        ...f.desktop,
        pid: 100,
        executablePath: join(f.root, "OpenAI.Codex_newest", "app", "ChatGPT.exe"),
      },
      f.desktop,
      launcher,
      node,
    ];
    const prepareRuntime = vi.fn((executable: string, owner: typeof f.desktop) =>
      prepareDesktopRuntime(executable, owner, f.options),
    );
    const release = vi.fn(async () => undefined);
    await main(["app-server"], {
      currentPid: node.pid,
      inspectProcesses: async () => inventory,
      findExecutable: () => findStockExecutable(f.options),
      prepareRuntime,
      acquireStartupLock: async () => ({ release }),
      startDesktopServer: async (
        executable: string,
        _args: string[],
        _aux: boolean,
        callbacks: { onDesktopReady: () => Promise<void>; onStartupFinished: () => Promise<void> },
      ) => {
        expect(executable).not.toBe(f.selected);
        expect(await findStockExecutable(f.options)).toBe(f.selected);
        await callbacks.onDesktopReady();
        expect(await findStockExecutable(f.options)).toBe(executable);
        await callbacks.onStartupFinished();
      },
    });
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(f.selected, f.desktop);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed Desktop launch inactive, releases the lock, and reuses it next time", async () => {
    const launcher = { pid: 20, parentPid: 10, name: "OmniCodexDesktopEngine.exe" };
    const node = { pid: 30, parentPid: 20, name: "node.exe", isStockBridgeNode: true };
    const release = vi.fn(async () => undefined);
    await expect(
      main(["app-server"], {
        currentPid: node.pid,
        inspectProcesses: async () => [f.desktop, launcher, node],
        findExecutable: () => findStockExecutable(f.options),
        prepareRuntime: (executable: string, owner: typeof f.desktop) =>
          prepareDesktopRuntime(executable, owner, f.options),
        acquireStartupLock: async () => ({ release }),
        startDesktopServer: async () => {
          throw new Error("launch failed");
        },
      }),
    ).rejects.toThrow("launch failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(await findStockExecutable(f.options)).toBe(f.selected);
    const retry = await prepareDesktopRuntime(f.selected, f.desktop, f.options);
    expect(await readdir(f.managedRoot)).toHaveLength(2);
    await retry.activate();
    expect(await findStockExecutable(f.options)).toBe(retry.executable);
  });

  it.each([
    ["--version"],
    ["app-server", "--print-startup-config"],
    ["app-server", "--listen=ws://localhost:1"],
  ])("never stages or inspects Desktop for generic invocation %j", async (...args: string[]) => {
    const prepareRuntime = vi.fn();
    const inspectProcesses = vi.fn();
    await main(args, {
      findExecutable: async () => f.selected,
      prepareRuntime,
      inspectProcesses,
      spawnProcess: () => ({ once: vi.fn() }),
    });
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(inspectProcesses).not.toHaveBeenCalled();
  });

  it("never stages for auxiliary attach or an already-running Desktop appserver", async () => {
    for (const owned of [false, true]) {
      const launcher = { pid: 20, parentPid: 10, name: "OmniCodexDesktopEngine.exe" };
      const node = { pid: 30, parentPid: 20, name: "node.exe", isStockBridgeNode: true };
      const prepareRuntime = vi.fn();
      const findExecutable = vi.fn();
      const attachDesktopServer = vi.fn();
      await main(["app-server"], {
        currentPid: owned ? node.pid : 999,
        inspectProcesses: async () => [
          f.desktop,
          launcher,
          node,
          { pid: 40, parentPid: 30, name: "codex.exe", isAppServer: true },
        ],
        prepareRuntime,
        findExecutable,
        attachDesktopServer,
        acquireStartupLock: async () => ({ release: async () => undefined }),
      });
      expect(attachDesktopServer).toHaveBeenCalledTimes(1);
      expect(prepareRuntime).not.toHaveBeenCalled();
      expect(findExecutable).not.toHaveBeenCalled();
    }
  });
});

describe("Codex runtime versions", () => {
  it.each([
    [newVersion, oldVersion, 1],
    ["0.169.0-alpha.11.1", "0.169.0-alpha.9.9", 1],
    ["0.169.0", newVersion, 1],
    ["0.169.0+build", "0.169.0", 0],
    ["0.169.0-alpha.1", "0.169.0-alpha.1.2", -1],
  ])("orders %s against %s", (left, right, expected) => {
    expect(compareStockVersions(left, right)).toBe(expected);
  });

  it("reads the actual --version protocol without launching a Codex runtime", async () => {
    // Node's output deliberately is not a codex-cli version.
    await expect(readStockVersion(process.execPath)).rejects.toThrow("no valid version");
  });
});
