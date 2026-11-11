import { execFileSync } from "node:child_process";
import { join } from "node:path";

// A release build can consume about 5 GB after startup; leave room for active chats.
export const minimumVirtualMb = 12 * 1024;
export const memoryPressureExitCode = 75;

export function readAvailableVirtualMb() {
  if (process.platform !== "win32") throw new Error("Engine build capacity requires Windows");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const availableVirtualKb = Number(
    execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory",
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ).trim(),
  );
  if (!Number.isSafeInteger(availableVirtualKb) || availableVirtualKb < 0) {
    throw new Error("Available Windows virtual memory could not be measured");
  }
  return Math.floor(availableVirtualKb / 1024);
}
