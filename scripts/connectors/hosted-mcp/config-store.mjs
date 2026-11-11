import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, loadConfig } from "./config.mjs";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const registrationFields = Object.freeze({
  clientId: "OMNICODEX_HOSTED_OAUTH_CLIENT_ID",
  authorizationUrl: "OMNICODEX_HOSTED_OAUTH_AUTHORIZATION_URL",
  tokenUrl: "OMNICODEX_HOSTED_OAUTH_TOKEN_URL",
  callbackUrl: "OMNICODEX_HOSTED_OAUTH_CALLBACK_URL",
  scopes: "OMNICODEX_HOSTED_OAUTH_SCOPES",
  workspaceId: "OMNICODEX_HOSTED_WORKSPACE_ID",
  connectorId: "OMNICODEX_HOSTED_CONNECTOR_ID",
  linkId: "OMNICODEX_HOSTED_LINK_ID",
  endpoint: "OMNICODEX_HOSTED_MCP_ENDPOINT",
});

export function configPathArgument(argv = process.argv.slice(2)) {
  if (!argv.length) return undefined;
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) {
    throw new Error("Usage: node <hosted-mcp script> [--config ABSOLUTE_PER_USER_JSON_PATH]");
  }
  return argv[1];
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function canonical(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("The installed configuration path cannot be resolved.");
    const parent = dirname(path);
    if (parent === path) throw new Error("The installed configuration path cannot be resolved.");
    return join(await canonical(parent), basename(path));
  }
}

export async function installedConfigPath({
  env = process.env,
  configPath,
  home = homedir(),
  platform = process.platform,
  sourceRoot = packageRoot,
} = {}) {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, "OmniCodex", "hosted-mcp", "config")
      : join(
          env.XDG_STATE_HOME || join(home, ".local", "state"),
          "omnicodex",
          "hosted-mcp",
          "config",
        );
  const requested =
    configPath ?? env.OMNICODEX_HOSTED_CONFIG_PATH ?? (base && join(base, "registration.json"));
  if (
    typeof requested !== "string" ||
    !isAbsolute(requested) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(basename(requested))
  ) {
    throw new Error("Installed configuration requires an absolute per-user .json file path.");
  }
  const [directory, userHome, source] = await Promise.all([
    canonical(resolve(dirname(requested))),
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
      "Installed configuration must use a dedicated per-user directory outside the source/package tree.",
    );
  }
  return join(directory, basename(requested));
}

function privateInfo(info, directory = false) {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  ) {
    throw new Error(
      "Installed configuration must use private regular files/directories, never links.",
    );
  }
  if (
    process.platform !== "win32" &&
    (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Installed configuration permissions must be private to the current OS user.");
  }
}

async function verifyDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory)
    throw new Error("Installed configuration directory changed.");
  privateInfo(await lstat(directory), true);
}

export function windowsAclFailureKind(stderr) {
  const value = String(stderr);
  const kind = /Access is denied|UnauthorizedAccessException|permission denied/iu.test(value)
    ? "access_denied"
    : /Cannot find path|ItemNotFoundException/iu.test(value)
      ? "path_missing"
      : /Set-Acl|SetSecurityInfo/iu.test(value)
        ? "set_acl_failed"
        : /Get-Acl|GetSecurityInfo/iu.test(value)
          ? "get_acl_failed"
          : "other";
  const id = /FullyQualifiedErrorId\s*:\s*([A-Za-z][A-Za-z0-9_.-]{0,79})/iu.exec(value)?.[1];
  return id === undefined ? kind : `${kind}:${id}`;
}

async function privateWindowsConfig(path, operation) {
  if (process.platform !== "win32") return;
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) {
    throw new Error("Windows private configuration protection is unavailable.");
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
        fileURLToPath(new URL("./windows-private-config.ps1", import.meta.url)),
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
    child.on("error", () => reject(new Error("Windows private configuration protection failed.")));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Windows configuration ACL is not private to the current user (${windowsAclFailureKind(diagnostic)}).`,
            ),
          ),
    );
    child.stdin.end(path);
  });
}

export async function assertNewConfig(options = {}) {
  const path = await installedConfigPath(options);
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return path;
    throw new Error("Installed configuration cannot be inspected.");
  }
  throw new Error(
    "An installed configuration already exists. Use a different --config path; it was not overwritten.",
  );
}

export async function installConfig(config, options = {}) {
  assertConfig(config);
  const path = await assertNewConfig(options);
  const directory = dirname(path);
  await verifyDirectory(directory, true);
  const registration = Object.fromEntries(
    Object.keys(registrationFields).map((key) => [key, config[key]]),
  );
  const temporary = join(directory, `.registration-${randomBytes(16).toString("hex")}.tmp`);
  let file;
  let created = false;
  try {
    file = await open(temporary, "wx", 0o600);
    created = true;
    await file.writeFile(`${JSON.stringify({ version: 1, registration }, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await privateWindowsConfig(temporary, "protect");
    await verifyDirectory(directory);
    // An atomic no-replace publication: rename would silently overwrite a racing setup.
    await link(temporary, path);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("An installed configuration already exists; it was not overwritten.");
    const kind =
      error instanceof Error ? /\(([A-Za-z0-9_.:-]{1,100})\)/u.exec(error.message)?.[1] : undefined;
    throw new Error(
      `Installed configuration could not be saved privately; no fallback location was used${kind === undefined ? "." : ` (${kind}).`}`,
    );
  } finally {
    await file?.close();
    if (created) await unlink(temporary);
  }
  return path;
}

function parseRegistration(text, env) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("Installed configuration is malformed; run setup with a new config path.");
  }
  const keys = Object.keys(registrationFields);
  if (
    !document ||
    Array.isArray(document) ||
    typeof document !== "object" ||
    Object.keys(document).sort().join(",") !== "registration,version" ||
    document.version !== 1 ||
    !document.registration ||
    Array.isArray(document.registration) ||
    typeof document.registration !== "object" ||
    Object.keys(document.registration).sort().join(",") !== [...keys].sort().join(",") ||
    keys.some((key) => typeof document.registration[key] !== "string")
  ) {
    throw new Error(
      "Installed configuration has an invalid schema; no credentials or extra fields are allowed.",
    );
  }
  const registrationEnv = Object.fromEntries(
    Object.entries(registrationFields).map(([key, name]) => [name, document.registration[key]]),
  );
  return loadConfig({
    ...registrationEnv,
    ...(Object.hasOwn(env, "OMNICODEX_HOSTED_LOG")
      ? { OMNICODEX_HOSTED_LOG: env.OMNICODEX_HOSTED_LOG }
      : {}),
  });
}

export async function loadInstalledConfig(options = {}) {
  const env = options.env ?? process.env;
  const supplied = Object.values(registrationFields).filter((name) => Object.hasOwn(env, name));
  if (supplied.length) {
    if (supplied.length !== Object.keys(registrationFields).length) {
      throw new Error(
        "Partial hosted registration environment override is forbidden. Set all nine registration fields or unset all of them to use installed config.",
      );
    }
    // A full explicit environment is the only alternative to installed configuration; never merge.
    return loadConfig(env);
  }
  const path = await installedConfigPath(options);
  let file;
  let text;
  try {
    await verifyDirectory(dirname(path));
    const before = await lstat(path);
    privateInfo(before);
    await privateWindowsConfig(path, "verify");
    if (before.size > 65_536) throw new Error("Invalid configuration size.");
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    privateInfo(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 65_536)
      throw new Error("Configuration changed.");
    text = await file.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("Invalid configuration size.");
  } catch {
    throw new Error(
      "Installed hosted configuration is missing or unsafe. Run node scripts/connectors/hosted-mcp/setup.mjs (with the same --config path if selected).",
    );
  } finally {
    await file?.close();
  }
  return parseRegistration(text, env);
}
