import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ReleaseSource,
  ReleaseValidator,
  StagedOmniCodexRelease,
} from "../../application/release-transition-controller.js";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";
import { spawnHidden, terminateOwnedHiddenChild } from "../windows/hidden-child-process.js";

const PACKAGE_NAME = "@heelee912/omnicodex";
const EXPECTED_REPOSITORY = "https://github.com/heelee912/omnicodex";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const SIGSTORE_BUNDLE_V03 = "application/vnd.dev.sigstore.bundle.v0.3+json";
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ReleaseCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
    },
  ): Promise<ReleaseCommandResult>;
}

export interface NpmReleaseSourceOptions {
  readonly npmCliScript: string;
  readonly expectedSourceCommit?: string;
  readonly nodeExecutable?: string;
  readonly dataDirectory?: string;
  readonly runner?: ReleaseCommandRunner;
  readonly fetchImplementation?: typeof fetch;
}

interface ReleaseManifest {
  readonly schemaVersion: 3;
  readonly packageName: typeof PACKAGE_NAME;
  readonly version: string;
  readonly integrity: string;
  readonly sourceCommit: string;
  readonly provenanceUrl: string;
  readonly signatureAuditPassed: true;
  readonly sbomDigest: string;
  readonly packageDigest: string;
  readonly cliScript: string;
  readonly daemonScript: string;
}

/** Stages an exact npm release without lifecycle scripts or shell execution. */
export class NpmReleaseSource implements ReleaseSource {
  readonly #npmCliScript: string;
  readonly #nodeExecutable: string;
  readonly #releasesDirectory: string;
  readonly #runner: ReleaseCommandRunner;
  readonly #fetch: typeof fetch;
  readonly #expectedSourceCommit: string | undefined;
  readonly #ownedCandidates = new Set<string>();

  constructor(options: NpmReleaseSourceOptions) {
    this.#npmCliScript = resolve(options.npmCliScript);
    this.#nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
    this.#releasesDirectory = join(
      resolve(options.dataDirectory ?? omniCodexDataDirectory()),
      "releases",
    );
    this.#runner = options.runner ?? new HiddenReleaseCommandRunner();
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#expectedSourceCommit = options.expectedSourceCommit;
    if (
      this.#expectedSourceCommit !== undefined &&
      !/^[a-f0-9]{40}$/.test(this.#expectedSourceCommit)
    ) {
      throw new Error("Expected release source commit must be an exact lowercase SHA-1");
    }
  }

  async stage(version: string): Promise<StagedOmniCodexRelease> {
    assertReleaseVersion(version);
    if (this.#expectedSourceCommit === undefined) {
      throw new Error("An exact expected source commit is required to stage an npm release");
    }
    await Promise.all([access(this.#npmCliScript), access(this.#nodeExecutable)]);
    await mkdir(this.#releasesDirectory, { recursive: true });
    const finalInstallRoot = join(this.#releasesDirectory, version);
    const finalPackageRoot = packageRoot(finalInstallRoot);
    const registry = await this.#registryMetadata(version, this.#expectedSourceCommit);
    try {
      const retained = await readManifest(finalPackageRoot);
      if (
        retained.version !== version ||
        retained.sourceCommit !== this.#expectedSourceCommit ||
        retained.integrity !== registry.integrity ||
        retained.provenanceUrl !== registry.provenanceUrl ||
        retained.packageDigest !== (await computeReleasePackageDigest(finalPackageRoot)) ||
        retained.sbomDigest !==
          sha256(await readFile(join(finalInstallRoot, "sbom.cdx.json"), "utf8"))
      ) {
        throw new Error("Retained release does not match the requested source commit");
      }
      await verifyLockedIntegrity(finalInstallRoot, version, registry.integrity);
      const signatureAudit = await this.#runNpm([
        "--prefix",
        finalInstallRoot,
        "audit",
        "signatures",
        "--json",
      ]);
      assertSignatureAudit(signatureAudit.stdout);
      return stagedFromManifest(finalPackageRoot, retained);
    } catch (error) {
      if (await pathExists(finalInstallRoot)) {
        throw new Error("Existing retained release failed exact manifest verification", {
          cause: error,
        });
      }
    }
    const stagingRoot = join(this.#releasesDirectory, `.${version}.${randomUUID()}.stage`);
    try {
      await mkdir(stagingRoot, { recursive: false });
      await this.#runNpm([
        "--prefix",
        stagingRoot,
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--package-lock=true",
        "--save-exact",
        `${PACKAGE_NAME}@${version}`,
      ]);
      const stagedPackageRoot = packageRoot(stagingRoot);
      const installedPackage = parseObject(
        await readFile(join(stagedPackageRoot, "package.json"), "utf8"),
      );
      if (installedPackage.name !== PACKAGE_NAME || installedPackage.version !== version) {
        throw new Error("Installed package identity did not match the requested release");
      }
      await verifyLockedIntegrity(stagingRoot, version, registry.integrity);
      const signatureAudit = await this.#runNpm([
        "--prefix",
        stagingRoot,
        "audit",
        "signatures",
        "--json",
      ]);
      assertSignatureAudit(signatureAudit.stdout);
      const sbom = await this.#runNpm([
        "--prefix",
        stagingRoot,
        "sbom",
        "--sbom-format",
        "cyclonedx",
      ]);
      const sbomObject = parseObject(sbom.stdout);
      const canonicalSbom = `${JSON.stringify(sbomObject, null, 2)}\n`;
      const sbomDigest = sha256(canonicalSbom);
      await writeFile(join(stagingRoot, "sbom.cdx.json"), canonicalSbom, {
        encoding: "utf8",
        mode: 0o600,
      });
      const packageDigest = await computeReleasePackageDigest(stagedPackageRoot);
      const manifest: ReleaseManifest = {
        schemaVersion: 3,
        packageName: PACKAGE_NAME,
        version,
        integrity: registry.integrity,
        sourceCommit: this.#expectedSourceCommit,
        provenanceUrl: registry.provenanceUrl,
        signatureAuditPassed: true,
        sbomDigest,
        packageDigest,
        cliScript: "dist/cli.js",
        daemonScript: "dist/daemon.js",
      };
      await writeFile(
        join(stagedPackageRoot, ".omnicodex-release.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(stagingRoot, finalInstallRoot);
      this.#ownedCandidates.add(finalPackageRoot);
      return stagedFromManifest(finalPackageRoot, manifest);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async discard(staged: StagedOmniCodexRelease): Promise<void> {
    if (!this.#ownedCandidates.delete(resolve(staged.releasePath))) return;
    const installRoot = resolve(staged.releasePath, "..", "..", "..");
    assertContained(this.#releasesDirectory, installRoot);
    await rm(installRoot, { recursive: true, force: true });
  }

  async #registryMetadata(
    version: string,
    expectedSourceCommit: string,
  ): Promise<{ readonly integrity: string; readonly provenanceUrl: string }> {
    const url = new URL(
      `/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
      "https://registry.npmjs.org",
    );
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`npm registry metadata failed (${response.status})`);
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) {
      throw new Error("npm registry metadata exceeded the safety limit");
    }
    const metadata = parseObject(body);
    const dist = isObject(metadata.dist) ? metadata.dist : undefined;
    const attestations = isObject(dist?.attestations) ? dist.attestations : undefined;
    if (
      metadata.name !== PACKAGE_NAME ||
      metadata.version !== version ||
      metadata.gitHead !== expectedSourceCommit ||
      normalizeRepository(metadata.repository) !== EXPECTED_REPOSITORY ||
      typeof dist?.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity) ||
      typeof attestations?.url !== "string"
    ) {
      throw new Error("npm release omitted exact integrity or provenance metadata");
    }
    const provenance = new URL(attestations.url);
    if (
      provenance.protocol !== "https:" ||
      provenance.origin !== "https://registry.npmjs.org" ||
      provenance.username ||
      provenance.password ||
      provenance.search ||
      provenance.hash
    ) {
      throw new Error("npm provenance URL left the HTTPS boundary");
    }
    await this.#verifyProvenance(provenance, version, dist.integrity, expectedSourceCommit);
    return { integrity: dist.integrity, provenanceUrl: provenance.href };
  }

  async #verifyProvenance(
    url: URL,
    version: string,
    integrity: string,
    expectedSourceCommit: string,
  ): Promise<void> {
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`npm provenance retrieval failed (${response.status})`);
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) {
      throw new Error("npm provenance response exceeded the safety limit");
    }
    const root = parseObject(body);
    if (!Array.isArray(root.attestations)) {
      throw new Error("npm provenance response omitted attestations");
    }
    const expectedSubject = `pkg:npm/%40heelee912/omnicodex@${version}`;
    const expectedSha512 = integritySha512Hex(integrity);
    const verified = root.attestations.some((candidate) => {
      if (!isObject(candidate) || candidate.predicateType !== SLSA_PROVENANCE_V1) return false;
      const bundle = isObject(candidate.bundle) ? candidate.bundle : undefined;
      const envelope = isObject(bundle?.dsseEnvelope) ? bundle.dsseEnvelope : undefined;
      if (
        bundle?.mediaType !== SIGSTORE_BUNDLE_V03 ||
        envelope?.payloadType !== "application/vnd.in-toto+json" ||
        typeof envelope.payload !== "string" ||
        !Array.isArray(envelope.signatures) ||
        envelope.signatures.length === 0 ||
        !isObject(bundle.verificationMaterial)
      ) {
        return false;
      }
      const statement = decodeDsseStatement(envelope.payload);
      if (statement.predicateType !== SLSA_PROVENANCE_V1 || !Array.isArray(statement.subject)) {
        return false;
      }
      const subjectMatches = statement.subject.some(
        (subject) =>
          isObject(subject) &&
          subject.name === expectedSubject &&
          isObject(subject.digest) &&
          subject.digest.sha512 === expectedSha512,
      );
      const predicate = isObject(statement.predicate) ? statement.predicate : undefined;
      const buildDefinition = isObject(predicate?.buildDefinition)
        ? predicate.buildDefinition
        : undefined;
      const externalParameters = isObject(buildDefinition?.externalParameters)
        ? buildDefinition.externalParameters
        : undefined;
      const workflow = isObject(externalParameters?.workflow)
        ? externalParameters.workflow
        : undefined;
      const repositoryMatches = normalizeRepository(workflow?.repository) === EXPECTED_REPOSITORY;
      const dependencyMatches =
        Array.isArray(buildDefinition?.resolvedDependencies) &&
        buildDefinition.resolvedDependencies.some(
          (dependency) =>
            isObject(dependency) &&
            normalizeRepositoryReference(dependency.uri) === EXPECTED_REPOSITORY &&
            isObject(dependency.digest) &&
            dependency.digest.gitCommit === expectedSourceCommit,
        );
      return subjectMatches && repositoryMatches && dependencyMatches;
    });
    if (!verified) {
      throw new Error("npm provenance did not bind the package to the expected GitHub commit");
    }
  }

  async #runNpm(args: readonly string[]): Promise<ReleaseCommandResult> {
    const result = await this.#runner.run(this.#nodeExecutable, [this.#npmCliScript, ...args], {
      timeoutMs: 180_000,
    });
    if (result.code !== 0) throw boundedCommandError("npm release command", result);
    return result;
  }
}

export interface NpmReleaseValidatorOptions {
  readonly runner?: ReleaseCommandRunner;
  readonly nodeExecutable?: string;
  readonly dataDirectory?: string;
}

/** Runs the candidate package itself for all executable validation gates. */
export class NpmReleaseValidator implements ReleaseValidator {
  readonly #runner: ReleaseCommandRunner;
  readonly #nodeExecutable: string;
  readonly #dataDirectory: string;
  readonly #runtimeProbe = new Map<string, Promise<Record<string, unknown>>>();

  constructor(options: NpmReleaseValidatorOptions = {}) {
    this.#runner = options.runner ?? new HiddenReleaseCommandRunner();
    this.#nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
    this.#dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
  }

  async verifyPackageIdentity(staged: StagedOmniCodexRelease): Promise<void> {
    const manifest = await readManifest(staged.releasePath);
    const packageJson = parseObject(
      await readFile(join(staged.releasePath, "package.json"), "utf8"),
    );
    if (
      packageJson.name !== PACKAGE_NAME ||
      packageJson.version !== staged.version ||
      manifest.version !== staged.version ||
      manifest.sourceCommit !== staged.sourceCommit ||
      manifest.packageDigest !== staged.packageDigest
    ) {
      throw new Error("Staged package identity verification failed");
    }
    await Promise.all([
      access(join(staged.releasePath, manifest.cliScript)),
      access(join(staged.releasePath, manifest.daemonScript)),
    ]);
  }

  async verifyRegistryIntegrity(staged: StagedOmniCodexRelease): Promise<void> {
    const manifest = await readManifest(staged.releasePath);
    if (
      manifest.integrity !== staged.integrity ||
      manifest.packageDigest !== staged.packageDigest ||
      (await computeReleasePackageDigest(staged.releasePath)) !== staged.packageDigest
    )
      throw new Error("Release integrity changed after stage");
  }

  async verifySignatureAndProvenance(staged: StagedOmniCodexRelease): Promise<void> {
    const manifest = await readManifest(staged.releasePath);
    if (
      !staged.provenanceAvailable ||
      manifest.signatureAuditPassed !== true ||
      manifest.sourceCommit !== staged.sourceCommit ||
      !/^[a-f0-9]{40}$/.test(staged.sourceCommit)
    ) {
      throw new Error("Release signature or provenance verification is unavailable");
    }
  }

  async verifySbomAssociation(staged: StagedOmniCodexRelease): Promise<void> {
    const installRoot = resolve(staged.releasePath, "..", "..", "..");
    const sbom = await readFile(join(installRoot, "sbom.cdx.json"), "utf8");
    if (sha256(sbom) !== staged.sbomDigest) throw new Error("Release SBOM digest mismatch");
  }

  async runSelfChecks(staged: StagedOmniCodexRelease): Promise<void> {
    await this.#runCandidate(staged, ["--help"]);
  }

  async dryRunStateMigration(staged: StagedOmniCodexRelease): Promise<void> {
    const result = await this.#runCandidate(staged, ["status", "--json"]);
    parseObject(lastJsonLine(result.stdout));
  }

  async runGuardSelfTest(staged: StagedOmniCodexRelease): Promise<void> {
    const probe = await this.#probe(staged);
    if (probe.protectedFilesUnchanged !== true || probe.unknownModelEffectCount !== 0) {
      throw new Error("Candidate guard self-test failed");
    }
  }

  async runProtocolContractTests(staged: StagedOmniCodexRelease): Promise<void> {
    const probe = await this.#probe(staged);
    if (
      typeof probe.fullToolCount !== "number" ||
      probe.fullToolCount <= 0 ||
      probe.uniqueToolNames !== probe.fullToolCount
    ) {
      throw new Error("Candidate MCP protocol contract failed");
    }
  }

  async runShadowRuntimeProbe(staged: StagedOmniCodexRelease): Promise<void> {
    const probe = await this.#probe(staged);
    if (probe.ok !== true || typeof probe.readTool !== "string") {
      throw new Error("Candidate shadow runtime probe failed");
    }
  }

  async #probe(staged: StagedOmniCodexRelease): Promise<Record<string, unknown>> {
    let probe = this.#runtimeProbe.get(staged.releasePath);
    if (probe === undefined) {
      probe = this.#runCandidate(staged, ["runtime", "probe", "--json"]).then((result) =>
        parseObject(lastJsonLine(result.stdout)),
      );
      this.#runtimeProbe.set(staged.releasePath, probe);
    }
    return probe;
  }

  async #runCandidate(
    staged: StagedOmniCodexRelease,
    args: readonly string[],
  ): Promise<ReleaseCommandResult> {
    const manifest = await readManifest(staged.releasePath);
    const result = await this.#runner.run(
      this.#nodeExecutable,
      [join(staged.releasePath, manifest.cliScript), ...args],
      { env: { ...process.env, OMNICODEX_DATA_DIR: this.#dataDirectory }, timeoutMs: 180_000 },
    );
    if (result.code !== 0) throw boundedCommandError("candidate release check", result);
    return result;
  }
}

export class HiddenReleaseCommandRunner implements ReleaseCommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<ReleaseCommandResult> {
    const child = spawnHidden(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    let outputError: Error | undefined;
    const append = (current: string, chunk: Buffer | string): string => {
      const value = chunk.toString();
      if (
        Buffer.byteLength(current, "utf8") + Buffer.byteLength(value, "utf8") >
        MAX_COMMAND_OUTPUT_BYTES
      ) {
        outputError = new Error("Release command output exceeded the safety limit");
        terminateOwnedHiddenChild(child);
        return current;
      }
      return current + value;
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        terminateOwnedHiddenChild(child);
        reject(new Error("Release command timed out; the exact owned child was terminated"));
      }, options.timeoutMs ?? 180_000);
    });
    try {
      const code = await Promise.race([
        new Promise<number | null>((resolveExit, rejectExit) => {
          child.once("error", rejectExit);
          child.once("close", resolveExit);
        }),
        timeout,
      ]);
      if (outputError !== undefined) throw outputError;
      return { code, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

async function readManifest(releasePath: string): Promise<ReleaseManifest> {
  const value = parseObject(await readFile(join(releasePath, ".omnicodex-release.json"), "utf8"));
  if (
    value.schemaVersion !== 3 ||
    value.packageName !== PACKAGE_NAME ||
    typeof value.version !== "string" ||
    typeof value.integrity !== "string" ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    typeof value.provenanceUrl !== "string" ||
    value.signatureAuditPassed !== true ||
    typeof value.sbomDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sbomDigest) ||
    typeof value.packageDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.packageDigest) ||
    value.cliScript !== "dist/cli.js" ||
    value.daemonScript !== "dist/daemon.js"
  ) {
    throw new Error("Invalid staged release manifest");
  }
  return value as unknown as ReleaseManifest;
}

function stagedFromManifest(
  releasePath: string,
  manifest: ReleaseManifest,
): StagedOmniCodexRelease {
  return {
    version: manifest.version,
    releasePath,
    integrity: manifest.integrity,
    sourceCommit: manifest.sourceCommit,
    provenanceAvailable: manifest.provenanceUrl.length > 0 && manifest.signatureAuditPassed,
    sbomDigest: manifest.sbomDigest,
    packageDigest: manifest.packageDigest,
  };
}

export async function computeReleasePackageDigest(root: string): Promise<string> {
  const packageRoot = resolve(root);
  const records: Array<{ readonly path: string; readonly size: number; readonly sha256: string }> =
    [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(packageRoot, absolute).replaceAll("\\", "/");
      if (relativePath === ".omnicodex-release.json") continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("Release package contains a non-regular entry");
      const metadata = await stat(absolute);
      if (metadata.size > 64 * 1024 * 1024) {
        throw new Error("Release package file exceeded the safety limit");
      }
      totalBytes += metadata.size;
      if (totalBytes > 512 * 1024 * 1024) {
        throw new Error("Release package exceeded the safety limit");
      }
      const bytes = await readFile(absolute);
      const afterRead = await stat(absolute);
      if (
        bytes.byteLength !== metadata.size ||
        afterRead.size !== metadata.size ||
        afterRead.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error("Release package changed while hashing");
      }
      records.push({
        path: relativePath,
        size: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await visit(packageRoot);
  return createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex");
}

function packageRoot(installRoot: string): string {
  return join(installRoot, "node_modules", "@heelee912", "omnicodex");
}

async function verifyLockedIntegrity(
  installRoot: string,
  version: string,
  integrity: string,
): Promise<void> {
  const lock = parseObject(await readFile(join(installRoot, "package-lock.json"), "utf8"));
  const packages = isObject(lock.packages) ? lock.packages : undefined;
  const locked = packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!isObject(locked) || locked.version !== version || locked.integrity !== integrity) {
    throw new Error("Installed package lock did not match registry integrity");
  }
}

function assertContained(root: string, candidate: string): void {
  const nested = relative(resolve(root), resolve(candidate));
  if (nested.length === 0 || nested.startsWith("..") || isAbsolute(nested)) {
    throw new Error("Release path escaped the managed releases directory");
  }
}

function assertReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid OmniCodex release version");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertSignatureAudit(value: string): void {
  const audit = parseObject(value);
  if (
    !Array.isArray(audit.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit.missing) ||
    audit.missing.length !== 0
  ) {
    throw new Error("npm signature audit reported missing or invalid signatures");
  }
}

function integritySha512Hex(integrity: string): string {
  const encoded = integrity.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    throw new Error("npm integrity was not a canonical SHA-512 digest");
  }
  return digest.toString("hex");
}

function decodeDsseStatement(payload: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error("npm provenance DSSE payload was not canonical base64");
  }
  const decoded = Buffer.from(payload, "base64");
  if (decoded.length === 0 || decoded.length > 2 * 1024 * 1024) {
    throw new Error("npm provenance DSSE payload exceeded the safety limit");
  }
  return parseObject(decoded.toString("utf8"));
}

function normalizeRepository(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : isObject(value) ? value.url : undefined;
  if (typeof raw !== "string") return undefined;
  const normalized = raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) {
      return undefined;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeRepositoryReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeRepository(value.replace(/@refs\/[^#?]+$/, ""));
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function lastJsonLine(value: string): string {
  const line = value
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) throw new Error("Candidate command returned no JSON");
  return line;
}

function boundedCommandError(operation: string, result: ReleaseCommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().slice(0, 2_048);
  return new Error(
    `${operation} failed (exit=${result.code ?? "null"})${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
