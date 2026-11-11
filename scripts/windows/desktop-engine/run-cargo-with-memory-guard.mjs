import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { readAvailableVirtualMb } from "./engine-build-capacity.mjs";

const lowVirtualMb = 2048;
const emergencyVirtualMb = 1024;

export class EngineBuildMemoryPressure extends Error {
  constructor(availableVirtualMb) {
    super(`Engine build stopped for memory safety: ${availableVirtualMb} MB free virtual memory`);
    this.availableVirtualMb = availableVirtualMb;
  }
}

export async function runCargoWithMemoryGuard(
  cargo,
  args,
  { cwd, env, readAvailableMb = readAvailableVirtualMb, pollIntervalMs = 5000 },
) {
  const child = spawn(cargo, args, { cwd, env, windowsHide: true, stdio: "inherit" });
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  let lowMemorySamples = 0;
  let safetyError;

  const monitor = setInterval(() => {
    if (child.exitCode !== null || child.signalCode !== null || safetyError) return;
    try {
      const availableMb = readAvailableMb();
      lowMemorySamples = availableMb < lowVirtualMb ? lowMemorySamples + 1 : 0;
      if (availableMb >= emergencyVirtualMb && lowMemorySamples < 2) return;
      safetyError = new EngineBuildMemoryPressure(availableMb);
    } catch (error) {
      safetyError = new Error("Engine build memory could not be measured", { cause: error });
    }

    if (!safetyError) return;
    try {
      execFileSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      child.kill();
      safetyError = new AggregateError([safetyError, error], "Engine build could not stop cleanly");
    }
  }, pollIntervalMs);

  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (safetyError) reject(safetyError);
        else if (code !== 0) reject(new Error(`Engine Cargo build exited with ${code ?? signal}`));
        else resolve();
      });
    });
  } finally {
    clearInterval(monitor);
  }
}
