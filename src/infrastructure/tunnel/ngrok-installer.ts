import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Auth0CliCommand, executeAuth0CliHidden } from "../auth/auth0-cli.js";

const NGROK_RELEASE = {
  version: "3.3.1",
  windowsX64: {
    archive: "ngrok-v3-3.3.1-windows-amd64.zip",
    url: "https://bin.equinox.io/a/cJk8dzafvmN/ngrok-v3-3.3.1-windows-amd64.zip",
    sha256: "c48450904a1266d868b8bab0928560dc54f950cbd963b882882068d753f44030",
  },
} as const;

interface NgrokReleaseDescriptor {
  readonly version: string;
  readonly archive: string;
  readonly url: string;
  readonly sha256: string;
}

export interface NgrokInstallerOptions {
  readonly dataDirectory: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly architecture?: NodeJS.Architecture;
  readonly extract?: (archivePath: string, destination: string) => Promise<void>;
  readonly command?: Auth0CliCommand;
  readonly release?: NgrokReleaseDescriptor;
}

/** Installs one checksum-pinned official ngrok archive in OmniCodex's data directory. */
export class NgrokInstaller {
  readonly #dataDirectory: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #architecture: NodeJS.Architecture;
  readonly #extract: (archivePath: string, destination: string) => Promise<void>;
  readonly #release: NgrokReleaseDescriptor;

  constructor(options: NgrokInstallerOptions) {
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#architecture = options.architecture ?? process.arch;
    this.#release = options.release ?? {
      version: NGROK_RELEASE.version,
      ...NGROK_RELEASE.windowsX64,
    };
    const command = options.command ?? executeAuth0CliHidden;
    this.#extract =
      options.extract ??
      (async (archivePath, destination) => {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const result = await command(
          join(systemRoot, "System32", "tar.exe"),
          ["-xf", archivePath, "-C", destination],
          { timeoutMs: 60_000 },
        );
        if (result.exitCode !== 0) throw new Error("ngrok archive extraction failed");
      });
  }

  async ensure(explicitPath?: string): Promise<string> {
    if (explicitPath !== undefined) {
      const candidate = resolve(explicitPath);
      await access(candidate);
      return candidate;
    }
    if (process.platform !== "win32") throw new Error("ngrok auto-install requires Windows");
    if (this.#architecture !== "x64") {
      throw new Error(`Unsupported Windows architecture for pinned ngrok: ${this.#architecture}`);
    }
    const executable = join(
      this.#dataDirectory,
      "bin",
      "ngrok",
      this.#release.version,
      "ngrok.exe",
    );
    try {
      await access(executable);
      return executable;
    } catch {
      // Install the pinned copy below.
    }
    const working = await mkdtemp(join(tmpdir(), "Codex-OmniCodex-Ngrok-"));
    try {
      const archive = await downloadPinnedNgrok(this.#fetch, this.#release.url);
      const digest = createHash("sha256").update(archive).digest("hex");
      if (digest !== this.#release.sha256) throw new Error("ngrok archive checksum mismatch");
      const archivePath = join(working, this.#release.archive);
      await writeFile(archivePath, archive, { mode: 0o600 });
      const extracted = join(working, "extracted");
      await mkdir(extracted, { recursive: true });
      await this.#extract(archivePath, extracted);
      const source = join(extracted, "ngrok.exe");
      await access(source);
      await mkdir(dirname(executable), { recursive: true });
      const staged = `${executable}.${process.pid}.tmp`;
      await copyFile(source, staged);
      await rename(staged, executable);
      return executable;
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }
}

async function downloadPinnedNgrok(
  fetchImpl: typeof globalThis.fetch,
  value: string,
): Promise<Buffer> {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "bin.equinox.io" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("ngrok download left the official distribution boundary");
  }
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { Accept: "application/zip", "User-Agent": "OmniCodex" },
  });
  if (!response.ok) throw new Error(`ngrok download failed (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 50 * 1024 * 1024) {
    throw new Error("ngrok archive exceeded the safety limit");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 50 * 1024 * 1024) throw new Error("ngrok archive exceeded the safety limit");
  return archive;
}

export function pinnedNgrokRelease(): Readonly<typeof NGROK_RELEASE> {
  return NGROK_RELEASE;
}
