import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { omniCodexDataDirectory } from "../config/omnicodex-config-store.js";

export interface ActiveOmniCodexReleasePointer {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly releasePath: string;
  readonly cliScript: string;
  readonly daemonScript: string;
  readonly stateSnapshotId: string;
  readonly sourceCommit?: string;
  readonly integrity?: string;
  readonly packageDigest?: string;
  readonly activatedAtUnixMs: number;
}

export interface StableReleaseLauncherStatus {
  readonly launcherPath: string;
  readonly pointerPath: string;
  readonly active: ActiveOmniCodexReleasePointer;
}

export interface StableReleaseLauncherOptions {
  readonly dataDirectory?: string;
  readonly nowUnixMs?: () => number;
}

/**
 * Maintains one version-independent launcher and an atomically replaced release
 * pointer. The launcher contains no package dependency and never invokes a
 * shell, so scheduled startup survives package-directory replacement.
 */
export class StableReleaseLauncher {
  readonly #dataDirectory: string;
  readonly #nowUnixMs: () => number;

  constructor(options: StableReleaseLauncherOptions = {}) {
    this.#dataDirectory = resolve(options.dataDirectory ?? omniCodexDataDirectory());
    this.#nowUnixMs = options.nowUnixMs ?? Date.now;
  }

  get launcherPath(): string {
    return join(this.#dataDirectory, "bin", "omnicodex-launcher.mjs");
  }

  get pointerPath(): string {
    return join(this.#dataDirectory, "active-release.json");
  }

  async ensureBootstrap(
    cliScript: string,
    version: string,
    options: { readonly activateCurrent?: boolean } = {},
  ): Promise<StableReleaseLauncherStatus> {
    const absoluteCli = resolve(cliScript);
    const releasePath = resolve(dirname(absoluteCli), "..");
    const daemonScript = join(releasePath, "dist", "daemon.js");
    await Promise.all([access(absoluteCli), access(daemonScript)]);
    let active = await this.readActive().catch(() => undefined);
    if (
      active === undefined ||
      (options.activateCurrent === true && active.releasePath !== releasePath)
    ) {
      active = pointerFor({
        version,
        releasePath,
        cliScript: absoluteCli,
        daemonScript,
        stateSnapshotId: "bootstrap",
        activatedAtUnixMs: this.#nowUnixMs(),
      });
      await atomicJsonWrite(this.pointerPath, active);
    }
    await this.#writeLauncher();
    return { launcherPath: this.launcherPath, pointerPath: this.pointerPath, active };
  }

  async readActive(): Promise<ActiveOmniCodexReleasePointer> {
    return validatePointer(JSON.parse(await readFile(this.pointerPath, "utf8")));
  }

  async switchActive(
    release: Omit<ActiveOmniCodexReleasePointer, "schemaVersion" | "activatedAtUnixMs">,
  ): Promise<ActiveOmniCodexReleasePointer> {
    const pointer = pointerFor({ ...release, activatedAtUnixMs: this.#nowUnixMs() });
    await Promise.all([access(pointer.cliScript), access(pointer.daemonScript)]);
    await atomicJsonWrite(this.pointerPath, pointer);
    return validatePointer(JSON.parse(await readFile(this.pointerPath, "utf8")));
  }

  async #writeLauncher(): Promise<void> {
    const pointerPath = JSON.stringify(this.pointerPath);
    const diagnosticDirectory = JSON.stringify(join(this.#dataDirectory, "logs"));
    const diagnosticPath = JSON.stringify(
      join(this.#dataDirectory, "logs", "autostart-launcher.jsonl"),
    );
    const script = [
      "#!/usr/bin/env node",
      'import { appendFile, mkdir, readFile } from "node:fs/promises";',
      'import { uptime } from "node:os";',
      'import { isAbsolute, join, relative, resolve } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      `const pointerPath = ${pointerPath};`,
      `const diagnosticDirectory = ${diagnosticDirectory};`,
      `const diagnosticPath = ${diagnosticPath};`,
      'const pointer = JSON.parse(await readFile(pointerPath, "utf8"));',
      'if (pointer?.schemaVersion !== 1 || !isAbsolute(pointer.releasePath) || !isAbsolute(pointer.cliScript)) throw new Error("Invalid OmniCodex active release pointer");',
      "const rel = relative(resolve(pointer.releasePath), resolve(pointer.cliScript));",
      'if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !rel.replaceAll("\\\\", "/").endsWith("dist/cli.js")) throw new Error("Active OmniCodex CLI escaped its release root");',
      'const boundaryUrl = pathToFileURL(join(pointer.releasePath, "dist", "infrastructure", "windows", "hidden-child-process.js"));',
      "const { configureDefaultHiddenChildActionLedger, spawnHidden } = await import(boundaryUrl.href);",
      "const requestedArgs = process.argv.slice(2);",
      'const launchSource = ["scheduled-task", "manual-test"].includes(process.env.OMNICODEX_AUTOSTART_SOURCE ?? "") ? process.env.OMNICODEX_AUTOSTART_SOURCE : "interactive";',
      'const actionLedgerPath = launchSource === "scheduled-task" ? join(diagnosticDirectory, "autostart-action-ledger-scheduled-task.jsonl") : join(diagnosticDirectory, "autostart-action-ledger-" + launchSource + "-" + process.pid + "-" + Date.now() + ".jsonl");',
      "configureDefaultHiddenChildActionLedger(actionLedgerPath);",
      "const childEnvironment = { ...process.env };",
      "const launchStartedAt = new Date().toISOString();",
      "const bootedAtUnixMs = Date.now() - Math.floor(uptime() * 1_000);",
      'const safeErrorCode = (error) => { const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN"; return /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN"; };',
      "const runOnce = () => new Promise((resolveRun) => {",
      '  const child = spawnHidden(process.execPath, [pointer.cliScript, ...requestedArgs], { stdio: "inherit", env: childEnvironment });',
      '  child.once("error", (error) => resolveRun({ code: null, signal: null, spawnErrorCode: safeErrorCode(error) }));',
      '  child.once("exit", (code, signal) => resolveRun({ code, signal, spawnErrorCode: null }));',
      "});",
      "const attempts = 1;",
      "const result = await runOnce();",
      'const diagnostic = { timestamp: new Date().toISOString(), startedAt: launchStartedAt, source: launchSource, bootedAtUnixMs, event: result.code === 0 ? "autostart_succeeded" : "autostart_failed", attempts, exitCode: result.code, signal: result.signal, spawnErrorCode: result.spawnErrorCode, pointerVersion: pointer.version, pointerSourceCommit: pointer.sourceCommit ?? null, pointerIntegrity: pointer.integrity ?? null, pointerPackageDigest: pointer.packageDigest ?? null, pointerActivatedAtUnixMs: pointer.activatedAtUnixMs };',
      'await mkdir(diagnosticDirectory, { recursive: true }).then(() => appendFile(diagnosticPath, JSON.stringify(diagnostic) + "\\n", { encoding: "utf8", mode: 0o600 })).catch(() => undefined);',
      "process.exit(result.code ?? (result.signal === null ? 1 : 128));",
      "",
    ].join("\n");
    await atomicTextWrite(this.launcherPath, script);
  }
}

function pointerFor(
  value: Omit<ActiveOmniCodexReleasePointer, "schemaVersion">,
): ActiveOmniCodexReleasePointer {
  return validatePointer({ schemaVersion: 1, ...value });
}

function validatePointer(value: unknown): ActiveOmniCodexReleasePointer {
  if (!isObject(value) || value.schemaVersion !== 1)
    throw new Error("Invalid active release pointer");
  if (
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
    typeof value.releasePath !== "string" ||
    typeof value.cliScript !== "string" ||
    typeof value.daemonScript !== "string" ||
    typeof value.stateSnapshotId !== "string" ||
    value.stateSnapshotId.length === 0 ||
    typeof value.activatedAtUnixMs !== "number" ||
    !Number.isSafeInteger(value.activatedAtUnixMs)
  ) {
    throw new Error("Invalid active release pointer");
  }
  const releasePath = resolve(value.releasePath);
  const cliScript = resolve(value.cliScript);
  const daemonScript = resolve(value.daemonScript);
  if (
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
    throw new Error("Invalid active release supply-chain identity");
  }
  assertContainedReleaseFile(releasePath, cliScript, "dist/cli.js");
  assertContainedReleaseFile(releasePath, daemonScript, "dist/daemon.js");
  return {
    schemaVersion: 1,
    version: value.version,
    releasePath,
    cliScript,
    daemonScript,
    stateSnapshotId: value.stateSnapshotId,
    ...(value.sourceCommit === undefined ? {} : { sourceCommit: value.sourceCommit }),
    ...(value.integrity === undefined ? {} : { integrity: value.integrity }),
    ...(value.packageDigest === undefined ? {} : { packageDigest: value.packageDigest }),
    activatedAtUnixMs: value.activatedAtUnixMs,
  };
}

function assertContainedReleaseFile(root: string, file: string, suffix: string): void {
  if (!isAbsolute(root) || !isAbsolute(file)) throw new Error("Release paths must be absolute");
  const candidate = relative(root, file);
  if (
    candidate.length === 0 ||
    candidate.startsWith("..") ||
    isAbsolute(candidate) ||
    !candidate.replaceAll("\\", "/").endsWith(suffix)
  ) {
    throw new Error("Release executable escaped its release root");
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await atomicTextWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicTextWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
