import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig } from "./config.mjs";
import { windowsAclFailureKind } from "./config-store.mjs";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const states = new WeakSet();
const names = new Set(["oauth.dpapi", "oauth.lock", "connection.log.jsonl"]);

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function canonical(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw new Error("State directory could not be resolved.");
    return join(await canonical(parent), relative(parent, path));
  }
}

async function verifyWindowsStateDirectory(directory, operation) {
  if (process.platform !== "win32") return;
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) {
    throw new Error("Windows private state protection is unavailable.");
  }
  await new Promise((resolve, reject) => {
    let diagnostic = "";
    const child = spawn(
      join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-private-state.ps1", import.meta.url)),
        operation,
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        signal: AbortSignal.timeout(15_000),
      },
    );
    child.stderr.on("data", (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-2048);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Windows private state protection failed.")));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Windows state directory ACL is not private to the current user (${windowsAclFailureKind(diagnostic)}).`,
            ),
          ),
    );
    child.stdin.end(directory);
  });
}

async function requireRegistrationBinding(directory, binding) {
  const marker = join(directory, "registration.binding");
  const entries = await readdir(directory);
  if (!entries.includes("registration.binding")) {
    if (entries.length)
      throw new Error(
        "Unmarked state directory contains existing data; use a new dedicated directory.",
      );
    const file = await open(marker, "wx", 0o600);
    try {
      await file.writeFile(`${binding}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const info = await lstat(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128) {
    throw new Error("Invalid state registration marker.");
  }
  if ((await readFile(marker, "utf8")) !== `${binding}\n`) {
    throw new Error("State directory belongs to a different registration.");
  }
}

export async function prepareState(
  config,
  {
    env = process.env,
    platform = process.platform,
    home = homedir(),
    sourceRoot = packageRoot,
  } = {},
) {
  assertConfig(config);
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, "OmniCodex", "hosted-mcp")
      : join(env.XDG_STATE_HOME || join(home, ".local", "state"), "omnicodex", "hosted-mcp");
  if (!base) throw new Error("A per-user state directory is required.");
  const requested = env.OMNICODEX_HOSTED_STATE_DIR || join(base, config.binding);
  if (!isAbsolute(requested)) throw new Error("The state directory must be absolute.");
  const [directory, userHome, source] = await Promise.all([
    canonical(resolve(requested)),
    canonical(resolve(home)),
    canonical(resolve(sourceRoot)),
  ]);
  if (
    directory === userHome ||
    !inside(userHome, directory) ||
    inside(source, directory) ||
    inside(directory, source)
  ) {
    throw new Error(
      "State must be in a dedicated per-user directory outside the source/package tree.",
    );
  }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if ((await realpath(directory)) !== directory)
    throw new Error("State directory changed while opening.");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("State directory must not be a file or link.");
  if (platform === "win32")
    await verifyWindowsStateDirectory(directory, created ? "protect" : "verify");
  else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("State directory must be private to the current OS user.");
  }
  await requireRegistrationBinding(directory, config.binding);
  const state = Object.freeze({ directory });
  states.add(state);
  return state;
}

export async function stateFile(state, name) {
  if (!states.has(state) || !names.has(name)) throw new Error("Invalid connector state file.");
  if ((await realpath(state.directory)) !== state.directory)
    throw new Error("State directory changed.");
  const path = join(state.directory, name);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error("Connector state must use private regular files, not links.");
    }
    if (
      process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    ) {
      throw new Error("Connector state files must be private to the current OS user.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return path;
}

export async function writePrivate(state, name, value) {
  const path = await stateFile(state, name);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  let file;
  let created = false;
  try {
    file = await open(temporary, "wx", 0o600);
    created = true;
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await stateFile(state, name);
    await rename(temporary, path);
  } finally {
    await file?.close();
    if (created)
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

export async function withCredentialLock(state, action) {
  const path = await stateFile(state, "oauth.lock");
  let lock;
  try {
    lock = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        "OAuth state is locked. Stop all connector/login processes before manual lock recovery.",
      );
    }
    throw new Error("OAuth state lock could not be created.");
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await lock.sync();
    return await action();
  } finally {
    await lock.close();
    await unlink(path);
  }
}
