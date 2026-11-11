import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "../safety/canonical-json.js";

export interface CodexModelMetadataSnapshot {
  readonly rawModel: Readonly<Record<string, unknown>>;
  readonly fetchedAt?: unknown;
  readonly clientVersion?: unknown;
  readonly etag?: unknown;
  readonly modelDigest: string;
  readonly cachePath: string;
}

export interface CodexModelMetadataSourceLike {
  read(modelId: string): Promise<CodexModelMetadataSnapshot>;
}

export interface CodexModelMetadataSourceOptions {
  readonly codexHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

/**
 * Reads the installed Codex model descriptor verbatim. The loopback provider
 * must advertise the same model contract as the runtime it is attached to;
 * maintaining a second hand-written descriptor silently changes tool and
 * protocol behavior after Codex updates.
 */
export class CodexModelMetadataSource implements CodexModelMetadataSourceLike {
  readonly #cachePath: string;

  constructor(options: CodexModelMetadataSourceOptions = {}) {
    const env = options.env ?? process.env;
    const configuredHome = options.codexHome ?? env.CODEX_HOME;
    const codexHome =
      configuredHome === undefined
        ? join(resolve(options.homeDirectory ?? homedir()), ".codex")
        : resolveRequiredPath(configuredHome, "Codex home");
    this.#cachePath = join(codexHome, "models_cache.json");
  }

  async read(modelId: string): Promise<CodexModelMetadataSnapshot> {
    const normalizedModelId = modelId.trim();
    if (normalizedModelId.length === 0) {
      throw new Error("Codex model id is required");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#cachePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Failed to read Codex model metadata from ${this.#cachePath}`, {
        cause: error,
      });
    }
    if (!isObject(parsed) || !Array.isArray(parsed.models)) {
      throw new Error(`Codex model metadata cache is invalid: ${this.#cachePath}`);
    }

    const matches = parsed.models.filter(
      (entry): entry is Record<string, unknown> =>
        isObject(entry) && entry.slug === normalizedModelId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Codex model metadata expected exactly one ${normalizedModelId} descriptor but found ${matches.length}`,
      );
    }

    const matchedModel = matches[0];
    if (matchedModel === undefined) {
      throw new Error(`Codex model metadata did not contain ${normalizedModelId}`);
    }
    const rawModel = deepFreeze(structuredClone(matchedModel));
    return Object.freeze({
      rawModel,
      ...(parsed.fetched_at === undefined
        ? {}
        : { fetchedAt: deepFreeze(structuredClone(parsed.fetched_at)) }),
      ...(parsed.client_version === undefined
        ? {}
        : { clientVersion: deepFreeze(structuredClone(parsed.client_version)) }),
      ...(parsed.etag === undefined ? {} : { etag: deepFreeze(structuredClone(parsed.etag)) }),
      modelDigest: createHash("sha256").update(canonicalJson(rawModel), "utf8").digest("hex"),
      cachePath: this.#cachePath,
    });
  }
}

function resolveRequiredPath(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
  return resolve(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
