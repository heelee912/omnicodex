import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnHidden, terminateOwnedHiddenChild } from "../windows/hidden-child-process.js";
import type { Auth0ManagementRequester } from "./auth0-management-provisioner.js";

const AUTH0_CLI_RELEASE = {
  version: "1.32.0",
  windows: {
    x64: {
      archive: "auth0-cli_1.32.0_Windows_x86_64.zip",
      sha256: "375750cae75aa7ce0039733779b4f9cd15aa5c9b8894c2d599c81016dd7ec1b5",
      executableSha256: "763da481a9a65128729dda7f24e0ed7d86499c18dd6ba8e69ad7a46aec2213f5",
    },
    arm64: {
      archive: "auth0-cli_1.32.0_Windows_arm64.zip",
      sha256: "09cae2649437626e1b515d91954ed134edb13da16f882958d7945a6edef2be52",
      executableSha256: "b8f50631feee04c6930913ac9679ed9838f73fa74667ab881bd62adf8a2d9b20",
    },
  },
} as const;

export interface Auth0CliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type Auth0CliCommand = (
  executable: string,
  args: readonly string[],
  options?: {
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly onStdout?: (stdout: string) => void;
    readonly onStderr?: (stderr: string) => void;
  },
) => Promise<Auth0CliCommandResult>;

export interface Auth0CliInstallerOptions {
  readonly dataDirectory: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly architecture?: NodeJS.Architecture;
  readonly extract?: (archivePath: string, destination: string) => Promise<void>;
  readonly command?: Auth0CliCommand;
}

/** Downloads one pinned official Auth0 CLI release and verifies its published SHA-256. */
export class Auth0CliInstaller {
  readonly #dataDirectory: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #architecture: NodeJS.Architecture;
  readonly #extract: (archivePath: string, destination: string) => Promise<void>;

  constructor(options: Auth0CliInstallerOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#architecture = options.architecture ?? process.arch;
    const command = options.command ?? executeAuth0CliHidden;
    this.#extract =
      options.extract ??
      (async (archivePath, destination) => {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const tar = join(systemRoot, "System32", "tar.exe");
        const result = await command(tar, ["-xf", archivePath, "-C", destination], {
          timeoutMs: 60_000,
        });
        if (result.exitCode !== 0) throw new Error("Auth0 CLI archive extraction failed");
      });
  }

  async ensure(explicitPath?: string): Promise<string> {
    if (explicitPath !== undefined) {
      const candidate = resolve(explicitPath);
      await access(candidate);
      return candidate;
    }
    if (process.platform !== "win32") throw new Error("Auth0 CLI auto-install requires Windows");
    const release =
      this.#architecture === "arm64"
        ? AUTH0_CLI_RELEASE.windows.arm64
        : this.#architecture === "x64"
          ? AUTH0_CLI_RELEASE.windows.x64
          : undefined;
    if (release === undefined)
      throw new Error(`Unsupported Windows architecture: ${this.#architecture}`);
    const executable = join(
      this.#dataDirectory,
      "bin",
      "auth0",
      AUTH0_CLI_RELEASE.version,
      "auth0.exe",
    );
    try {
      await access(executable);
      if ((await sha256File(executable)) === release.executableSha256) return executable;
      throw new Error("Installed Auth0 CLI checksum mismatch");
    } catch {
      // Install the pinned copy below.
    }
    const working = await mkdtemp(join(tmpdir(), "Codex-OmniCodex-Auth0-"));
    try {
      const archivePath = join(working, release.archive);
      const archive = await downloadPinnedArchive(
        this.#fetch,
        `https://github.com/auth0/auth0-cli/releases/download/v${AUTH0_CLI_RELEASE.version}/${release.archive}`,
      );
      const digest = createHash("sha256").update(archive).digest("hex");
      if (digest !== release.sha256) throw new Error("Auth0 CLI archive checksum mismatch");
      await writeFile(archivePath, archive, { mode: 0o600 });
      const extracted = join(working, "extracted");
      await mkdir(extracted, { recursive: true });
      await this.#extract(archivePath, extracted);
      const source = join(extracted, "auth0.exe");
      await access(source);
      if ((await sha256File(source)) !== release.executableSha256) {
        throw new Error("Extracted Auth0 CLI checksum mismatch");
      }
      await mkdir(dirname(executable), { recursive: true });
      const staged = `${executable}.${process.pid}.tmp`;
      await copyFile(source, staged);
      await rename(staged, executable);
      if ((await sha256File(executable)) !== release.executableSha256) {
        throw new Error("Installed Auth0 CLI checksum mismatch");
      }
      return executable;
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }
}

export interface Auth0CliManagementClientOptions {
  readonly executablePath: string;
  readonly command?: Auth0CliCommand;
  readonly openDeviceUrl?: (url: URL) => void;
}

export interface Auth0CliTenant {
  readonly domain: string;
  readonly name?: string;
}

/** Uses Auth0 CLI's OS-keyring-backed user session without reading its tokens. */
export class Auth0CliManagementClient implements Auth0ManagementRequester {
  readonly #executable: string;
  readonly #command: Auth0CliCommand;
  readonly #openDeviceUrl: (url: URL) => void;

  constructor(options: Auth0CliManagementClientOptions) {
    this.#executable = resolve(options.executablePath);
    this.#command = options.command ?? executeAuth0CliHidden;
    this.#openDeviceUrl = options.openDeviceUrl ?? openAuth0DeviceUrl;
  }

  async login(tenantOrigin: string | undefined, scopes: readonly string[]): Promise<void> {
    const args = ["login", "--scopes", scopes.join(","), "--no-input", "--no-color"];
    if (tenantOrigin !== undefined) {
      args.splice(1, 0, "--domain", auth0TenantHost(tenantOrigin));
    }
    let deviceUrlOpened = false;
    const handleDeviceOutput = (output: string) => {
      if (deviceUrlOpened) return;
      const deviceUrl = findAuth0DeviceUrl(output);
      if (deviceUrl === undefined) return;
      deviceUrlOpened = true;
      this.#openDeviceUrl(deviceUrl);
    };
    const result = await this.#command(this.#executable, args, {
      timeoutMs: 600_000,
      onStdout: handleDeviceOutput,
      onStderr: handleDeviceOutput,
    });
    if (result.exitCode !== 0) throw new Error("Auth0 CLI login failed");
  }

  async listTenants(): Promise<readonly Auth0CliTenant[]> {
    const result = await this.#command(
      this.#executable,
      ["tenants", "list", "--json", "--no-input", "--no-color"],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) throw new Error("Auth0 CLI tenant discovery failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Auth0 CLI returned invalid tenant JSON");
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : isObject(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : undefined;
    if (rows === undefined) throw new Error("Auth0 CLI returned invalid tenant JSON");
    const tenants = rows.map((row) => {
      if (!isObject(row) || typeof row.domain !== "string") {
        throw new Error("Auth0 CLI returned invalid tenant JSON");
      }
      const domain = auth0TenantHost(`https://${row.domain}/`);
      return {
        domain,
        ...(typeof row.name === "string" && row.name.length > 0 ? { name: row.name } : {}),
      };
    });
    if (new Set(tenants.map((tenant) => tenant.domain)).size !== tenants.length) {
      throw new Error("Auth0 CLI returned duplicate tenants");
    }
    return tenants;
  }

  async request<T>(tenantOrigin: string, path: string, init: RequestInit): Promise<T> {
    const tenant = auth0TenantHost(tenantOrigin);
    const url = new URL(path, "https://management.invalid/api/v2/");
    if (!url.pathname.startsWith("/api/v2/")) throw new Error("Invalid Auth0 Management API path");
    const method = (init.method ?? (init.body === undefined ? "GET" : "POST")).toLowerCase();
    if (!["get", "post", "put", "patch", "delete"].includes(method)) {
      throw new Error("Unsupported Auth0 Management API method");
    }
    const args = [
      "api",
      method,
      url.pathname.slice("/api/v2/".length),
      "--tenant",
      tenant,
      "--no-input",
      "--no-color",
    ];
    for (const [key, value] of url.searchParams) args.push("--query", `${key}=${value}`);
    const stdin = typeof init.body === "string" ? init.body : undefined;
    const result = await this.#command(this.#executable, args, {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Auth0 CLI Management API request failed (${result.exitCode})`);
    }
    const output = result.stdout.trim();
    if (output === "") return {} as T;
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error("Auth0 CLI returned invalid Management API JSON");
    }
  }
}

export async function executeAuth0CliHidden(
  executable: string,
  args: readonly string[],
  options: {
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly onStdout?: (stdout: string) => void;
    readonly onStderr?: (stderr: string) => void;
  } = {},
): Promise<Auth0CliCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawnHidden(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, exitCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectCommand(error);
      else resolveCommand({ stdout, stderr, exitCode: exitCode ?? -1 });
    };
    const timer = setTimeout(() => {
      terminateOwnedHiddenChild(child);
      finish(new Error("Auth0 CLI command timed out"));
    }, options.timeoutMs ?? 30_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        terminateOwnedHiddenChild(child);
        finish(new Error("Auth0 CLI output exceeded the safety limit"));
        return;
      }
      try {
        options.onStdout?.(stdout);
      } catch {
        terminateOwnedHiddenChild(child);
        finish(new Error("Auth0 CLI device login handoff failed"));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 256 * 1024) {
        terminateOwnedHiddenChild(child);
        finish(new Error("Auth0 CLI error output exceeded the safety limit"));
        return;
      }
      try {
        options.onStderr?.(stderr);
      } catch {
        terminateOwnedHiddenChild(child);
        finish(new Error("Auth0 CLI device login handoff failed"));
      }
    });
    child.once("error", () => finish(new Error("Auth0 CLI process failed to start")));
    child.once("close", (code) => finish(undefined, code ?? -1));
    if (options.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(options.stdin, "utf8");
  });
}

async function downloadPinnedArchive(
  fetchImpl: typeof globalThis.fetch,
  initialUrl: string,
): Promise<Buffer> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (
      current.protocol !== "https:" ||
      ![
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
      ].includes(current.hostname)
    ) {
      throw new Error("Auth0 CLI download redirect left the GitHub release boundary");
    }
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { Accept: "application/octet-stream", "User-Agent": "OmniCodex" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error("Auth0 CLI download redirect lacked a location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Auth0 CLI download failed (${response.status})`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 100 * 1024 * 1024) {
      throw new Error("Auth0 CLI archive exceeded the safety limit");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 100 * 1024 * 1024) {
      throw new Error("Auth0 CLI archive exceeded the safety limit");
    }
    return buffer;
  }
  throw new Error("Auth0 CLI download exceeded the redirect limit");
}

function auth0TenantHost(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Auth0 tenant must be a credential-free HTTPS origin");
  }
  return url.hostname;
}

function findAuth0DeviceUrl(stdout: string): URL | undefined {
  const match = stdout.match(/https:\/\/auth0\.auth0\.com\/activate\?user_code=[A-Z0-9-]{4,32}/);
  if (match === null) return undefined;
  const url = new URL(match[0]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth0.auth0.com" ||
    url.pathname !== "/activate" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => key !== "user_code") ||
    !/^[A-Z0-9-]{4,32}$/.test(url.searchParams.get("user_code") ?? "")
  ) {
    throw new Error("Auth0 CLI returned an invalid device login URL");
  }
  return url;
}

function openAuth0DeviceUrl(url: URL): void {
  if (process.platform !== "win32") {
    throw new Error("Auth0 device login browser handoff requires Windows");
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const child = spawnHidden(
    join(systemRoot, "System32", "rundll32.exe"),
    ["url.dll,FileProtocolHandler", url.href],
    { stdio: "ignore" },
  );
  child.unref();
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function pinnedAuth0CliRelease(): Readonly<typeof AUTH0_CLI_RELEASE> {
  return AUTH0_CLI_RELEASE;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
