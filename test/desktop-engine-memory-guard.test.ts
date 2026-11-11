import { describe, expect, it } from "vitest";
import { runCargoWithMemoryGuard } from "../scripts/windows/desktop-engine/run-cargo-with-memory-guard.mjs";

describe.skipIf(process.platform !== "win32")("Desktop engine memory guard", () => {
  it("stops only its spawned build when free virtual memory stays low", async () => {
    await expect(
      runCargoWithMemoryGuard(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        env: process.env,
        readAvailableMb: () => 1500,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow("Engine build stopped for memory safety: 1500 MB");
  }, 15_000);

  it("stops immediately at emergency memory pressure", async () => {
    let samples = 0;
    await expect(
      runCargoWithMemoryGuard(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        env: process.env,
        readAvailableMb: () => {
          samples += 1;
          return 800;
        },
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow("Engine build stopped for memory safety: 800 MB");
    expect(samples).toBe(1);
  }, 15_000);

  it("keeps a successful build when free virtual memory is sufficient", async () => {
    await expect(
      runCargoWithMemoryGuard(process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: process.env,
        readAvailableMb: () => 4000,
        pollIntervalMs: 100,
      }),
    ).resolves.toBeUndefined();
  }, 15_000);
});
