import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Selects the ordinary Codex binary maintained by Desktop after each update. */
export async function findStockExecutable() {
  const managedRoot = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "OpenAI",
    "Codex",
    "bin",
  );
  const entries = await readdir(managedRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(managedRoot, entry.name, "codex.exe");
        const metadata = await stat(path).catch(() => undefined);
        return metadata?.isFile() ? { path, modifiedAt: metadata.mtimeMs } : undefined;
      }),
  );
  const available = candidates.filter(Boolean);
  for (const candidate of available) {
    try {
      candidate.version = await readStockVersion(candidate.path);
    } catch {
      candidate.version = undefined;
    }
  }
  const versionOrder = new Intl.Collator("en", { numeric: true });
  const latest = available.sort(
    (left, right) =>
      versionOrder.compare(right.version ?? "", left.version ?? "") ||
      right.modifiedAt - left.modifiedAt,
  )[0];
  if (!latest?.version) throw new Error("No usable Codex Desktop executable was found");
  return assertExecutable(latest.path);
}

export async function readStockVersion(executable) {
  const output = await execFileAsync(executable, ["--version"], {
    windowsHide: true,
    timeout: 5000,
  });
  const version = /^codex-cli ([0-9][a-z0-9.+-]*)$/iu.exec(output.stdout.trim())?.[1];
  if (!version) throw new Error(`Codex executable has no valid version: ${executable}`);
  return version;
}

async function assertExecutable(path) {
  const absolute = resolve(path);
  if (!(await stat(absolute)).isFile())
    throw new Error(`Codex executable is not a file: ${absolute}`);
  if (win32.normalize(absolute).toLowerCase() === win32.normalize(process.execPath).toLowerCase()) {
    throw new Error("Codex executable selection resolves to the OmniCodex bridge");
  }
  return absolute;
}
