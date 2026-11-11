import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AtomicReleasePointer,
  HealthyOmniCodexRelease,
  ReleaseAdmissionDrain,
  ReleaseObservation,
  ReleaseStateSnapshots,
  StagedOmniCodexRelease,
} from "../../application/release-transition-controller.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { computeReleasePackageDigest } from "./npm-release-source.js";
import {
  type ActiveOmniCodexReleasePointer,
  StableReleaseLauncher,
} from "./stable-release-launcher.js";

interface SnapshotManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly candidateVersion: string;
  readonly files: readonly SnapshotFile[];
}

interface SnapshotFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface HealthyRegistry {
  readonly schemaVersion: 1;
  readonly releases: readonly HealthyOmniCodexRelease[];
}

/** Captures and restores the exact config plus DPAPI ciphertext files. */
export class LocalReleaseStateSnapshots implements ReleaseStateSnapshots {
  readonly #dataDirectory: string;
  readonly #snapshotsDirectory: string;

  constructor(dataDirectory = omniCodexDataDirectory()) {
    this.#dataDirectory = resolve(dataDirectory);
    this.#snapshotsDirectory = join(this.#dataDirectory, "snapshots");
  }

  async captureFor(staged: StagedOmniCodexRelease): Promise<string> {
    const id = `${Date.now()}-${randomUUID()}`;
    const snapshotData = join(this.#snapshotsDirectory, id, "data");
    await mkdir(snapshotData, { recursive: true });
    await copyFile(join(this.#dataDirectory, "config.json"), join(snapshotData, "config.json"));
    if (await exists(join(this.#dataDirectory, "secrets"))) {
      await cp(join(this.#dataDirectory, "secrets"), join(snapshotData, "secrets"), {
        recursive: true,
        errorOnExist: true,
      });
    }
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      id,
      candidateVersion: staged.version,
      files: await hashTree(snapshotData),
    };
    await atomicJsonWrite(join(this.#snapshotsDirectory, id, "manifest.json"), manifest);
    return id;
  }

  async restore(snapshotId: string): Promise<void> {
    const { directory } = await this.#verified(snapshotId);
    const sourceConfig = join(directory, "config.json");
    const sourceSecrets = join(directory, "secrets");
    const nonce = randomUUID();
    const configPath = join(this.#dataDirectory, "config.json");
    const configTemporary = `${configPath}.${nonce}.restore`;
    const configBackup = `${configPath}.${nonce}.backup`;
    const secretsPath = join(this.#dataDirectory, "secrets");
    const secretsTemporary = `${secretsPath}.${nonce}.restore`;
    const secretsBackup = `${secretsPath}.${nonce}.backup`;
    await copyFile(sourceConfig, configTemporary);
    if (await exists(sourceSecrets)) await cp(sourceSecrets, secretsTemporary, { recursive: true });
    else await mkdir(secretsTemporary, { recursive: true });
    let secretsMoved = false;
    let configBackedUp = false;
    try {
      await copyFile(configPath, configBackup);
      configBackedUp = true;
      if (await exists(secretsPath)) {
        await rename(secretsPath, secretsBackup);
        secretsMoved = true;
      }
      await rename(secretsTemporary, secretsPath);
      await rename(configTemporary, configPath);
      await Promise.all([
        rm(configBackup, { force: true }),
        rm(secretsBackup, { recursive: true, force: true }),
      ]);
    } catch (error) {
      await rm(secretsPath, { recursive: true, force: true }).catch(() => undefined);
      if (secretsMoved) await rename(secretsBackup, secretsPath).catch(() => undefined);
      if (configBackedUp) await rename(configBackup, configPath).catch(() => undefined);
      throw error;
    } finally {
      await Promise.all([
        rm(configTemporary, { force: true }),
        rm(configBackup, { force: true }),
        rm(secretsTemporary, { recursive: true, force: true }),
        rm(secretsBackup, { recursive: true, force: true }),
      ]);
    }
  }

  async assertCompatible(snapshotId: string, release: HealthyOmniCodexRelease): Promise<void> {
    const { directory } = await this.#verified(snapshotId);
    const config = parseObject(await readFile(join(directory, "config.json"), "utf8"));
    const packageJson = parseObject(
      await readFile(join(release.releasePath, "package.json"), "utf8"),
    );
    if (config.schemaVersion !== 1 || packageJson.version !== release.version) {
      throw new Error("Retained release is incompatible with its state snapshot");
    }
    if (
      release.sourceCommit !== undefined ||
      release.integrity !== undefined ||
      release.packageDigest !== undefined
    ) {
      const identity = await readReleaseIdentity(release.releasePath);
      if (
        identity === undefined ||
        identity.sourceCommit !== release.sourceCommit ||
        identity.integrity !== release.integrity ||
        identity.packageDigest !== release.packageDigest
      ) {
        throw new Error("Retained release supply-chain identity changed after validation");
      }
    }
  }

  async #verified(snapshotId: string): Promise<{ readonly directory: string }> {
    if (!/^[0-9]+-[0-9a-f-]{36}$/.test(snapshotId)) throw new Error("Invalid state snapshot id");
    const root = join(this.#snapshotsDirectory, snapshotId);
    assertContained(this.#snapshotsDirectory, root);
    const manifest = validateSnapshotManifest(
      parseObject(await readFile(join(root, "manifest.json"), "utf8")),
    );
    if (manifest.id !== snapshotId) throw new Error("State snapshot identity mismatch");
    const directory = join(root, "data");
    const actual = await hashTree(directory);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
      throw new Error("State snapshot integrity mismatch");
    }
    return { directory };
  }
}

export interface LocalReleasePointerOptions {
  readonly dataDirectory?: string;
  readonly launcher?: StableReleaseLauncher;
  readonly deactivate?: () => Promise<void>;
  readonly restoreState?: (snapshotId: string) => Promise<void>;
  readonly activate?: (pointer: ActiveOmniCodexReleasePointer) => Promise<void>;
}

/** Atomic pointer plus an append-preserving healthy rollback registry. */
export class LocalReleasePointer implements AtomicReleasePointer {
  readonly #dataDirectory: string;
  readonly #launcher: StableReleaseLauncher;
  readonly #deactivate: () => Promise<void>;
  readonly #restoreState: (snapshotId: string) => Promise<void>;
  readonly #activate: (pointer: ActiveOmniCodexReleasePointer) => Promise<void>;

  constructor(options: LocalReleasePointerOptions = {}) {
    this.#dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
    this.#launcher =
      options.launcher ?? new StableReleaseLauncher({ dataDirectory: this.#dataDirectory });
    this.#deactivate = options.deactivate ?? (async () => undefined);
    this.#restoreState = options.restoreState ?? (async () => undefined);
    this.#activate = options.activate ?? (async () => undefined);
  }

  get registryPath(): string {
    return join(this.#dataDirectory, "healthy-releases.json");
  }

  async current(): Promise<HealthyOmniCodexRelease | undefined> {
    try {
      const active = await this.#launcher.readActive();
      return {
        version: active.version,
        releasePath: active.releasePath,
        stateSnapshotId: active.stateSnapshotId,
        ...(active.sourceCommit === undefined ? {} : { sourceCommit: active.sourceCommit }),
        ...(active.integrity === undefined ? {} : { integrity: active.integrity }),
        ...(active.packageDigest === undefined ? {} : { packageDigest: active.packageDigest }),
      };
    } catch {
      return undefined;
    }
  }

  async switchTo(
    releasePath: string,
    stateSnapshotId: string,
    rollbackStateSnapshotId: string,
  ): Promise<void> {
    if (stateSnapshotId.length === 0 || rollbackStateSnapshotId.length === 0) {
      throw new Error("Release state snapshot ids must be non-empty");
    }
    const previous = await this.#launcher.readActive();
    const absolute = resolve(releasePath);
    const packageJson = parseObject(await readFile(join(absolute, "package.json"), "utf8"));
    if (typeof packageJson.version !== "string") throw new Error("Release version is unavailable");
    const identity = await readReleaseIdentity(absolute);
    let deactivated = false;
    try {
      await this.#deactivate();
      deactivated = true;
      await this.#restoreState(stateSnapshotId);
      const pointer = await this.#launcher.switchActive({
        version: packageJson.version,
        releasePath: absolute,
        cliScript: join(absolute, "dist", "cli.js"),
        daemonScript: join(absolute, "dist", "daemon.js"),
        stateSnapshotId,
        ...(identity === undefined ? {} : identity),
      });
      await this.#activate(pointer);
    } catch (error) {
      if (!deactivated) throw error;
      try {
        await this.#deactivate().catch(() => undefined);
        await this.#restoreState(rollbackStateSnapshotId);
        const restored = await this.#launcher.switchActive({
          version: previous.version,
          releasePath: previous.releasePath,
          cliScript: previous.cliScript,
          daemonScript: previous.daemonScript,
          stateSnapshotId: rollbackStateSnapshotId,
          ...(previous.sourceCommit === undefined ? {} : { sourceCommit: previous.sourceCommit }),
          ...(previous.integrity === undefined ? {} : { integrity: previous.integrity }),
          ...(previous.packageDigest === undefined
            ? {}
            : { packageDigest: previous.packageDigest }),
        });
        await this.#activate(restored);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Release activation failed and exact rollback could not be completed",
        );
      }
      throw error;
    }
  }

  async markHealthy(release: HealthyOmniCodexRelease): Promise<void> {
    const registry = await this.#readRegistry();
    const releases = [
      release,
      ...registry.releases.filter((candidate) => candidate.releasePath !== release.releasePath),
    ];
    await atomicJsonWrite(this.registryPath, {
      schemaVersion: 1,
      releases,
    } satisfies HealthyRegistry);
  }

  async retainedHealthy(): Promise<readonly HealthyOmniCodexRelease[]> {
    return (await this.#readRegistry()).releases;
  }

  async retainAtLeastTwoPrior(activePath: string): Promise<void> {
    const registry = await this.#readRegistry();
    if (!registry.releases.some((release) => release.releasePath === resolve(activePath))) {
      throw new Error("Active release is absent from the healthy rollback registry");
    }
    // Retention is deliberately non-destructive. Releases are never pruned by
    // the transition path, so every available prior release remains recoverable.
  }

  async #readRegistry(): Promise<HealthyRegistry> {
    try {
      const value = parseObject(await readFile(this.registryPath, "utf8"));
      if (value.schemaVersion !== 1 || !Array.isArray(value.releases)) {
        throw new Error("Invalid healthy release registry");
      }
      return {
        schemaVersion: 1,
        releases: value.releases.map(validateHealthyRelease),
      };
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return { schemaVersion: 1, releases: [] };
      throw error;
    }
  }
}

export class CallbackReleaseAdmissionDrain implements ReleaseAdmissionDrain {
  readonly #beginCallback: () => Promise<void>;
  readonly #awaitCallback: () => Promise<void>;
  readonly #resumeCallback: () => Promise<void>;

  constructor(callbacks: {
    readonly begin: () => Promise<void>;
    readonly awaitDrained: () => Promise<void>;
    readonly resume: () => Promise<void>;
  }) {
    this.#beginCallback = callbacks.begin;
    this.#awaitCallback = callbacks.awaitDrained;
    this.#resumeCallback = callbacks.resume;
  }

  begin(): Promise<void> {
    return this.#beginCallback();
  }

  awaitDrained(): Promise<void> {
    return this.#awaitCallback();
  }

  resume(): Promise<void> {
    return this.#resumeCallback();
  }
}

export class CallbackReleaseObservation implements ReleaseObservation {
  readonly #observeCallback: (releasePath: string) => Promise<void>;

  constructor(observe: (releasePath: string) => Promise<void>) {
    this.#observeCallback = observe;
  }

  observe(releasePath: string): Promise<void> {
    return this.#observeCallback(releasePath);
  }
}

async function hashTree(root: string): Promise<SnapshotFile[]> {
  const result: SnapshotFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        result.push({
          path: relative(root, absolute).replaceAll("\\", "/"),
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else throw new Error("State snapshot contains a non-regular filesystem entry");
    }
  };
  await visit(root);
  return result;
}

function validateSnapshotManifest(value: Record<string, unknown>): SnapshotManifest {
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.candidateVersion !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Invalid state snapshot manifest");
  }
  const files = value.files.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      entry.path.includes("..") ||
      isAbsolute(entry.path) ||
      typeof entry.sizeBytes !== "number" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Invalid state snapshot file record");
    }
    return entry as unknown as SnapshotFile;
  });
  return { schemaVersion: 1, id: value.id, candidateVersion: value.candidateVersion, files };
}

function validateHealthyRelease(value: unknown): HealthyOmniCodexRelease {
  if (
    !isObject(value) ||
    typeof value.version !== "string" ||
    typeof value.releasePath !== "string" ||
    !isAbsolute(value.releasePath) ||
    typeof value.stateSnapshotId !== "string" ||
    value.stateSnapshotId.length === 0 ||
    (value.sourceCommit === undefined) !== (value.integrity === undefined) ||
    (value.sourceCommit === undefined) !== (value.packageDigest === undefined) ||
    (value.sourceCommit !== undefined &&
      (typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit))) ||
    (value.integrity !== undefined &&
      (typeof value.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity))) ||
    (value.packageDigest !== undefined &&
      (typeof value.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.packageDigest)))
  ) {
    throw new Error("Invalid healthy release record");
  }
  return {
    version: value.version,
    releasePath: resolve(value.releasePath),
    stateSnapshotId: value.stateSnapshotId,
    ...(value.sourceCommit === undefined ? {} : { sourceCommit: value.sourceCommit }),
    ...(value.integrity === undefined ? {} : { integrity: value.integrity }),
    ...(value.packageDigest === undefined ? {} : { packageDigest: value.packageDigest }),
  };
}

async function readReleaseIdentity(releasePath: string): Promise<
  | {
      readonly sourceCommit: string;
      readonly integrity: string;
      readonly packageDigest: string;
    }
  | undefined
> {
  try {
    const manifest = parseObject(
      await readFile(join(releasePath, ".omnicodex-release.json"), "utf8"),
    );
    if (
      manifest.schemaVersion !== 3 ||
      typeof manifest.sourceCommit !== "string" ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
      typeof manifest.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity) ||
      typeof manifest.packageDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.packageDigest)
    ) {
      throw new Error("Release supply-chain manifest is invalid");
    }
    const actualPackageDigest = await computeReleasePackageDigest(releasePath);
    if (actualPackageDigest !== manifest.packageDigest) {
      throw new Error("Release package files changed after validation");
    }
    return {
      sourceCommit: manifest.sourceCommit,
      integrity: manifest.integrity,
      packageDigest: manifest.packageDigest,
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function assertContained(root: string, candidate: string): void {
  const nested = relative(resolve(root), resolve(candidate));
  if (nested.length === 0 || nested.startsWith("..") || isAbsolute(nested)) {
    throw new Error("Path escaped the managed snapshot directory");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(value: unknown): string | undefined {
  return isObject(value) && typeof value.code === "string" ? value.code : undefined;
}
