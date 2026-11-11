import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  omniCodexRuntimeInstanceId,
  prepareOmniCodexRuntimeWriteEnvironment,
  removeOmniCodexRuntimeWriteEnvironment,
  sweepOmniCodexRuntimeWriteEnvironments,
} from "../src/infrastructure/runtime/omnicodex-runtime-write-environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OmniCodex runtime write environment", () => {
  it("keeps scratch files per process and pinned engines across restarts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-runtime-env-"));
    temporaryDirectories.push(dataDirectory);

    const environment = await prepareOmniCodexRuntimeWriteEnvironment({
      dataDirectory,
      instanceId: "1234-5678-test",
    });
    const expectedRoot = resolve(dataDirectory, "runtime", "1234-5678-test");
    const engineGenerationsRoot = resolve(dataDirectory, "engine-generations");

    expect(environment).toEqual({
      OMNICODEX_RUNTIME_ROOT: expectedRoot,
      OMNICODEX_ENGINE_GENERATIONS_ROOT: engineGenerationsRoot,
      CODEX_ROLLOUT_TRACE_ROOT: undefined,
      TEMP: join(expectedRoot, "temp"),
      TMP: join(expectedRoot, "temp"),
    });
    await expect(access(join(expectedRoot, "rollout-traces"))).rejects.toThrow();
    expect(environment).not.toHaveProperty("CODEX_HOME");
    expect(environment).not.toHaveProperty("CODEX_SQLITE_HOME");
    await Promise.all(
      Object.values(environment)
        .filter(Boolean)
        .map(async (directory) => {
          expect((await stat(directory as string)).isDirectory()).toBe(true);
        }),
    );
  });

  it("rejects an instance id that could escape the owned runtime root", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-runtime-env-"));
    temporaryDirectories.push(dataDirectory);

    await expect(
      prepareOmniCodexRuntimeWriteEnvironment({ dataDirectory, instanceId: "../shared" }),
    ).rejects.toThrow("runtime instance id is invalid");
  });

  it("derives a stable process-owned id and removes only that exact scratch root", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-runtime-env-"));
    temporaryDirectories.push(dataDirectory);
    const instanceId = omniCodexRuntimeInstanceId({
      pid: 4321,
      startedAtUnixMs: 1_787_949_699_000,
      instanceNonce: "abcdefghijklmnop",
    });
    expect(instanceId).toBe("4321-1787949699000-abcdefghijkl");
    const environment = await prepareOmniCodexRuntimeWriteEnvironment({
      dataDirectory,
      instanceId,
    });
    const marker = join(environment.TEMP as string, "marker.txt");
    const pinnedEngine = join(
      environment.OMNICODEX_ENGINE_GENERATIONS_ROOT as string,
      "pinned.txt",
    );
    await writeFile(marker, "temporary", "utf8");
    await writeFile(pinnedEngine, "retained", "utf8");

    await removeOmniCodexRuntimeWriteEnvironment({ dataDirectory, instanceId });

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(dataDirectory, "runtime", ".retired"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const restarted = await prepareOmniCodexRuntimeWriteEnvironment({
      dataDirectory,
      instanceId: "4322-1787949699001-mnopqrstuvwx",
    });
    expect(restarted.OMNICODEX_ENGINE_GENERATIONS_ROOT).toBe(
      environment.OMNICODEX_ENGINE_GENERATIONS_ROOT,
    );
    await expect(access(pinnedEngine)).resolves.toBeUndefined();
    await expect(stat(resolve(dataDirectory, "runtime"))).resolves.toMatchObject({});
  });

  it("rejects invalid owner identity before deriving a scratch root", () => {
    expect(() =>
      omniCodexRuntimeInstanceId({
        pid: 0,
        startedAtUnixMs: Date.now(),
        instanceNonce: "abcdefghijklmnop",
      }),
    ).toThrow("owner pid is invalid");
    expect(() =>
      omniCodexRuntimeInstanceId({
        pid: 1,
        startedAtUnixMs: Date.now(),
        instanceNonce: "short",
      }),
    ).toThrow("owner nonce is invalid");
  });

  it("serially reclaims only dead-owner generations and preserves live, unknown, and current roots", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-runtime-env-"));
    temporaryDirectories.push(dataDirectory);
    const runtimeRoot = resolve(dataDirectory, "runtime");
    const dead = "4101-1787949699000-abcdefghijkl";
    const live = "4102-1787949699000-abcdefghijkl";
    const unknown = "4103-1787949699000-abcdefghijkl";
    const current = "4104-1787949699000-abcdefghijkl";
    const unrelated = "user-owned-directory";
    for (const name of [dead, live, unknown, current, unrelated]) {
      await mkdir(resolve(runtimeRoot, name), { recursive: true });
      await writeFile(resolve(runtimeRoot, name, "marker.txt"), "scratch", "utf8");
    }

    const result = await sweepOmniCodexRuntimeWriteEnvironments({
      runtimeRoot,
      currentInstanceId: current,
      probeOwnerProcess: (pid) => (pid === 4101 ? "absent" : pid === 4102 ? "alive" : "unknown"),
    });

    expect(result).toMatchObject({ retiredStaleGenerations: 1 });
    await expect(access(resolve(runtimeRoot, dead))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(runtimeRoot, ".retired"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const name of [live, unknown, current, unrelated]) {
      await expect(access(resolve(runtimeRoot, name, "marker.txt"))).resolves.toBeUndefined();
    }
  });
});
