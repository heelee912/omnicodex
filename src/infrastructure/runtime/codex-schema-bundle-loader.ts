import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AppServerSchemaSource } from "../../application/app-server-method-catalog.js";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import { spawnHidden, terminateOwnedHiddenChild } from "../windows/hidden-child-process.js";

export interface CodexSchemaBundleLoaderOptions {
  readonly includeExperimental?: boolean;
  readonly cache?: boolean;
  readonly timeoutMs?: number;
}

/** Loads protocol truth from the installed binary without copying the binary or user config. */
export class CodexSchemaBundleLoader implements AppServerSchemaSource {
  readonly #candidate: RuntimeCandidate;
  readonly #options: Required<CodexSchemaBundleLoaderOptions>;
  #cached: Record<string, unknown> | undefined;
  #cachedIdentity = "";

  constructor(candidate: RuntimeCandidate, options: CodexSchemaBundleLoaderOptions = {}) {
    this.#candidate = candidate;
    this.#options = {
      includeExperimental: options.includeExperimental ?? true,
      cache: options.cache ?? true,
      timeoutMs: options.timeoutMs ?? 60_000,
    };
  }

  async loadClientRequestSchema(): Promise<Record<string, unknown>> {
    const identity = `${this.#candidate.canonicalPath}\n${this.#candidate.modifiedAtUnixMs ?? ""}`;
    if (this.#options.cache && this.#cached !== undefined && this.#cachedIdentity === identity) {
      return structuredClone(this.#cached);
    }

    const generatedRoot = await mkdtemp(join(tmpdir(), "omnicodex-app-server-schema-"));
    try {
      await this.#generate(generatedRoot);
      const raw = await readFile(join(generatedRoot, "ClientRequest.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed) || !Array.isArray(parsed.oneOf)) {
        throw new Error("Generated Codex ClientRequest schema is invalid");
      }
      this.#cached = parsed;
      this.#cachedIdentity = identity;
      return structuredClone(parsed);
    } finally {
      await removeGeneratedDirectory(generatedRoot);
    }
  }

  async #generate(outputDirectory: string): Promise<void> {
    const args = ["app-server", "generate-json-schema"];
    if (this.#options.includeExperimental) {
      args.push("--experimental");
    }
    args.push("--out", outputDirectory);
    const child = spawnHidden(this.#candidate.executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OMNICODEX_SCHEMA_GENERATOR: "1",
      },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 16_384) {
        stderr += chunk.toString().slice(0, 16_384 - stderr.length);
      }
    });
    await new Promise<void>((resolveGenerate, rejectGenerate) => {
      const timer = setTimeout(() => {
        terminateOwnedHiddenChild(child);
        rejectGenerate(new Error("Codex App Server schema generation timed out"));
      }, this.#options.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectGenerate(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolveGenerate();
          return;
        }
        rejectGenerate(
          new Error(
            `Codex App Server schema generation failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.trim()}`,
          ),
        );
      });
    });
  }
}

async function removeGeneratedDirectory(directory: string): Promise<void> {
  const canonicalTemp = await realpath(tmpdir());
  const canonicalDirectory = await realpath(directory);
  const relation = relative(canonicalTemp, canonicalDirectory);
  if (
    relation.length === 0 ||
    relation.startsWith("..") ||
    resolve(canonicalDirectory) === resolve(canonicalTemp)
  ) {
    throw new Error("Refusing to remove a schema directory outside the system temporary root");
  }
  await rm(canonicalDirectory, { force: true, recursive: true });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
