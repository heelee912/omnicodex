import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

function windowsProcessStartedAt(pid) {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const startedAt = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const timestamp = Date.parse(startedAt);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireRefreshLock(lockPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = randomUUID();
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, startedAt: Date.now() }));
      } finally {
        await handle.close();
      }
      return nonce;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      const info = await stat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs < 60_000) return undefined;
    }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        const startedAt =
          process.platform === "win32" ? windowsProcessStartedAt(owner.pid) : undefined;
        if (
          startedAt === undefined ||
          !Number.isSafeInteger(owner.startedAt) ||
          startedAt <= owner.startedAt
        ) {
          return undefined;
        }
      } catch (error) {
        if (error?.code !== "ESRCH") return undefined;
      }
    }
    try {
      await rename(lockPath, `${lockPath}.stale.${randomUUID()}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

export async function releaseRefreshLock(lockPath, nonce) {
  const current = JSON.parse(await readFile(lockPath, "utf8"));
  if (current.nonce !== nonce) throw new Error("Engine refresh lock ownership changed");
  await unlink(lockPath);
}
