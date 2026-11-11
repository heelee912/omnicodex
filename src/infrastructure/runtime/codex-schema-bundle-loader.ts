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
  readonly #options: {
    readonly includeExperimental: boolean;
    readonly cache: boolean;
    readonly timeoutMs?: number;
  };
  #cached: Record<string, unknown> | undefined;
  #cachedIdentity = "";

  constructor(candidate: RuntimeCandidate, options: CodexSchemaBundleLoaderOptions = {}) {
    this.#candidate = candidate;
    this.#options = {
      includeExperimental: options.includeExperimental ?? true,
      cache: options.cache ?? true,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: positiveDuration(options.timeoutMs) }),
    };
  }

  async loadClientRequestSchema(): Promise<Record<string, unknown>> {
    const identity = this.#candidate.buildSha256;
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
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });
    await new Promise<void>((resolveGenerate, rejectGenerate) => {
      const timer =
        this.#options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              terminateOwnedHiddenChild(child);
              rejectGenerate(
                new Error(
                  `Codex App Server schema generation timed out after ${this.#options.timeoutMs}ms`,
                ),
              );
            }, this.#options.timeoutMs);
      child.once("error", (error) => {
        if (timer !== undefined) clearTimeout(timer);
        rejectGenerate(error);
      });
      child.once("close", (code, signal) => {
        if (timer !== undefined) clearTimeout(timer);
        if (code === 0) {
          resolveGenerate();
          return;
        }
        rejectGenerate(
          new Error(
            `Codex App Server schema generation failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.join("").trim()}`,
          ),
        );
      });
    });
  }
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  return value;
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
