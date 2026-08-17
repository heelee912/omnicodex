import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SecretReferenceStore } from "../../application/lifecycle-transactions.js";
import {
  HiddenChildProcessBoundary,
  type OwnedHiddenChildProcess,
} from "./hidden-child-process.js";

const referencePrefix = "dpapi:v1:";
const maximumSecretBytes = 64 * 1024;
const maximumCiphertextBytes = 128 * 1024;

export interface ReadableSecretReferenceStore extends SecretReferenceStore {
  get(reference: string): Promise<string>;
}

export interface WindowsDpapiSecretStoreOptions {
  readonly directory: string;
  readonly systemRoot?: string;
  readonly childProcesses?: HiddenChildProcessBoundary;
  readonly protect?: (secret: string) => Promise<string>;
  readonly unprotect?: (ciphertext: string) => Promise<string>;
  readonly timeoutMs?: number;
}

/**
 * Stores only CurrentUser-DPAPI ciphertext on disk. Plaintext enters the fixed
 * PowerShell bridge over stdin and is never placed in argv, environment,
 * configuration, state, or diagnostics.
 */
export class WindowsDpapiSecretStore implements ReadableSecretReferenceStore {
  readonly #directory: string;
  readonly #protect: (secret: string) => Promise<string>;
  readonly #unprotect: (ciphertext: string) => Promise<string>;

  constructor(options: WindowsDpapiSecretStoreOptions) {
    this.#directory = resolve(options.directory);
    const childProcesses = options.childProcesses ?? new HiddenChildProcessBoundary();
    const executable = windowsPowerShellPath(options.systemRoot ?? process.env.SystemRoot);
    const timeoutMs = options.timeoutMs ?? 15_000;
    this.#protect =
      options.protect ??
      ((secret) => runDpapiBridge(childProcesses, executable, protectScript, secret, timeoutMs));
    this.#unprotect =
      options.unprotect ??
      ((ciphertext) =>
        runDpapiBridge(childProcesses, executable, unprotectScript, ciphertext, timeoutMs));
  }

  async put(_name: string, secret: string): Promise<string> {
    assertBoundedSecret(secret);
    const ciphertext = await this.#protect(secret);
    assertCiphertext(ciphertext);
    const id = randomBytes(32).toString("base64url");
    const path = this.#pathForId(id);
    const temporaryPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    await mkdir(this.#directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${ciphertext}\n`, {
        encoding: "ascii",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return `${referencePrefix}${id}`;
  }

  async get(reference: string): Promise<string> {
    const id = parseReference(reference);
    const ciphertext = (await readFile(this.#pathForId(id), "ascii")).trim();
    assertCiphertext(ciphertext);
    const secret = await this.#unprotect(ciphertext);
    assertBoundedSecret(secret);
    return secret;
  }

  async remove(reference: string): Promise<void> {
    const id = parseReference(reference);
    await rm(this.#pathForId(id), { force: true });
  }

  #pathForId(id: string): string {
    return join(this.#directory, `${id}.dpapi`);
  }
}

function windowsPowerShellPath(systemRoot: string | undefined): string {
  if (systemRoot === undefined || systemRoot.length === 0)
    throw new Error("SystemRoot is unavailable for the DPAPI bridge");
  const root = resolve(systemRoot);
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseReference(reference: string): string {
  if (!reference.startsWith(referencePrefix)) throw new Error("Unsupported secret reference");
  const id = reference.slice(referencePrefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Invalid DPAPI secret reference");
  return id;
}

function assertBoundedSecret(secret: string): void {
  const length = Buffer.byteLength(secret, "utf8");
  if (length < 16 || length > maximumSecretBytes || secret.includes("\0"))
    throw new Error("Secret must be a bounded non-empty UTF-8 value");
}

function assertCiphertext(ciphertext: string): void {
  if (
    ciphertext.length === 0 ||
    ciphertext.length > maximumCiphertextBytes ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)
  )
    throw new Error("DPAPI ciphertext is invalid");
}

async function runDpapiBridge(
  childProcesses: HiddenChildProcessBoundary,
  executable: string,
  script: string,
  input: string,
  timeoutMs: number,
): Promise<string> {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const child = childProcesses.spawnHidden(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodedScript,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: minimalPowerShellEnvironment(process.env) },
  );
  return collectBridgeResult(childProcesses, child, input, timeoutMs);
}

function collectBridgeResult(
  childProcesses: HiddenChildProcessBoundary,
  child: OwnedHiddenChildProcess,
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let outputTooLarge = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) rejectResult(error);
      else resolveResult(stdout.toString("utf8"));
    };
    const timeout = setTimeout(() => {
      childProcesses.terminateOwnedHiddenChild(child);
      finish(new Error("DPAPI bridge timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = Buffer.from(chunk);
      if (stdout.length + next.length > maximumCiphertextBytes) {
        outputTooLarge = true;
        childProcesses.terminateOwnedHiddenChild(child);
        return;
      }
      stdout = Buffer.concat([stdout, next]);
    });
    child.once("error", () => finish(new Error("DPAPI bridge failed to start")));
    child.once("close", (code) => {
      if (outputTooLarge) finish(new Error("DPAPI bridge output exceeded its limit"));
      else if (code !== 0) finish(new Error("DPAPI bridge failed"));
      else finish();
    });
    if (child.stdin === null) {
      finish(new Error("DPAPI bridge stdin is unavailable"));
      return;
    }
    child.stdin.end(input, "utf8");
  });
}

function minimalPowerShellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    SystemRoot: env.SystemRoot,
    WINDIR: env.WINDIR,
    TEMP: env.TEMP,
    TMP: env.TMP,
  };
}

const protectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const unprotectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($encoded)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;

/** Constant-time helper used by live credential checks without logging either value. */
export function secretValuesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
