import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop engine refresh lock", () => {
  it("allows one builder and recovers a stale interrupted builder", async () => {
    const { acquireRefreshLock, releaseRefreshLock } = (await import(
      new URL("../scripts/windows/desktop-engine/engine-refresh-lock.mjs", import.meta.url).href
    )) as {
      acquireRefreshLock(path: string): Promise<string | undefined>;
      releaseRefreshLock(path: string, nonce: string): Promise<void>;
    };
    const root = await mkdtemp(join(tmpdir(), "omnicodex-refresh-lock-"));
    const lockPath = join(root, "engine-refresh.lock");
    try {
      const first = await acquireRefreshLock(lockPath);
      expect(first).toMatch(/^[a-f0-9-]{36}$/u);
      if (!first) throw new Error("First refresh lock was not acquired");
      expect(await acquireRefreshLock(lockPath)).toBeUndefined();
      await releaseRefreshLock(lockPath, first);

      await writeFile(lockPath, JSON.stringify({ pid: 0, nonce: "interrupted" }));
      const second = await acquireRefreshLock(lockPath);
      expect(second).toMatch(/^[a-f0-9-]{36}$/u);
      if (!second) throw new Error("Stale refresh lock was not recovered");
      expect(
        (await readdir(root)).some((name) => name.startsWith("engine-refresh.lock.stale.")),
      ).toBe(true);
      await releaseRefreshLock(lockPath, second);

      if (process.platform === "win32") {
        await writeFile(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            nonce: "reused-process-id",
            startedAt: Date.now() - 24 * 60 * 60 * 1000,
          }),
        );
        const reusedPid = await acquireRefreshLock(lockPath);
        expect(reusedPid).toMatch(/^[a-f0-9-]{36}$/u);
        if (!reusedPid) throw new Error("Reused process ID kept a stale refresh lock");
        await releaseRefreshLock(lockPath, reusedPid);
      }

      await writeFile(lockPath, "incomplete");
      expect(await acquireRefreshLock(lockPath)).toBeUndefined();
      const old = new Date(Date.now() - 61_000);
      await utimes(lockPath, old, old);
      const recovered = await acquireRefreshLock(lockPath);
      expect(recovered).toMatch(/^[a-f0-9-]{36}$/u);
      if (!recovered) throw new Error("Incomplete refresh lock was not recovered");
      await releaseRefreshLock(lockPath, recovered);
    } finally {
      const beneathTemp = relative(tmpdir(), root);
      if (beneathTemp !== "" && !beneathTemp.startsWith("..") && !isAbsolute(beneathTemp)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
