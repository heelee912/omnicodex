import { hkdfSync, randomBytes as nodeRandomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { WindowsDpapiSecretStore } from "../windows/windows-dpapi-secret-store.js";
import {
  loadOmniCodexConfig,
  type OmniCodexConfig,
  omniCodexConfigPath,
  omniCodexDataDirectory,
  saveOmniCodexConfig,
} from "./omnicodex-config-store.js";

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_NAME = "internal-integrity-master-v1";
const HKDF_SALT = Buffer.from("OmniCodex internal integrity HKDF-SHA-256 v1", "utf8");
const REFERENCE_PATTERN = /^dpapi:v1:[A-Za-z0-9_-]{43}$/;

export type OmniCodexInternalIntegrityDomain = "direct-schedule-v1" | "durable-mcp-events-v1";

export interface OmniCodexInternalIntegritySecretStore {
  put(name: string, secret: string): Promise<string>;
  get(reference: string): Promise<string>;
  remove(reference: string): Promise<void>;
}

export interface OmniCodexInternalIntegrityKeyOptions {
  readonly configPath?: string;
  readonly secretStore?: OmniCodexInternalIntegritySecretStore;
  readonly loadConfig?: () => Promise<OmniCodexConfig>;
  readonly saveConfig?: (config: OmniCodexConfig) => Promise<void>;
  readonly randomBytes?: (size: number) => Buffer;
}

/**
 * Holds the DPAPI-unwrapped process-local master and exposes only domain-separated
 * derivatives. Call dispose when a short-lived CLI operation no longer needs it.
 */
export class OmniCodexInternalIntegrityKeys {
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new Error("OmniCodex internal integrity master must be exactly 32 bytes");
    }
    this.#masterKey = Buffer.from(masterKey);
  }

  derive(domain: OmniCodexInternalIntegrityDomain): Buffer {
    if (domain !== "direct-schedule-v1" && domain !== "durable-mcp-events-v1") {
      throw new Error("Unsupported OmniCodex internal integrity-key domain");
    }
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.#masterKey,
        HKDF_SALT,
        Buffer.from(`OmniCodex internal integrity key\0${domain}`, "utf8"),
        MASTER_KEY_BYTES,
      ),
    );
  }

  dispose(): void {
    this.#masterKey.fill(0);
  }
}

/** Creates the master once for an existing installation, or unwraps the existing one. */
export async function ensureOmniCodexInternalIntegrityKeys(
  options: OmniCodexInternalIntegrityKeyOptions = {},
): Promise<OmniCodexInternalIntegrityKeys> {
  const ports = createPorts(options);
  const original = await ports.loadConfig();
  const existingReference = original.internal?.integrityMasterKeyRef;
  if (existingReference !== undefined) {
    return keysFromStoredReference(ports.secretStore, existingReference);
  }

  const masterKey = ports.randomBytes(MASTER_KEY_BYTES);
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_BYTES) {
    if (Buffer.isBuffer(masterKey)) masterKey.fill(0);
    throw new Error("OmniCodex internal integrity random source returned an invalid key");
  }
  const encodedMaster = masterKey.toString("base64url");
  let createdReference: string | undefined;
  try {
    createdReference = await ports.secretStore.put(MASTER_KEY_NAME, encodedMaster);
    assertDpapiReference(createdReference);
    const updated: OmniCodexConfig = {
      ...original,
      internal: { integrityMasterKeyRef: createdReference },
    };
    try {
      await ports.saveConfig(updated);
      const readback = await ports.loadConfig();
      if (!isDeepStrictEqual(readback, updated)) {
        throw new Error("OmniCodex internal integrity-key config readback differed");
      }
      const persistedKeys = await keysFromStoredReference(ports.secretStore, createdReference);
      return persistedKeys;
    } catch (error) {
      try {
        await ports.saveConfig(original);
        const rollbackReadback = await ports.loadConfig();
        if (!isDeepStrictEqual(rollbackReadback, original)) {
          throw new Error("OmniCodex internal integrity-key config rollback differed");
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "OmniCodex internal integrity-key migration and config rollback both failed",
        );
      }
      try {
        await ports.secretStore.remove(createdReference);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OmniCodex internal integrity-key migration rolled back but secret cleanup failed",
        );
      }
      createdReference = undefined;
      throw error;
    }
  } finally {
    masterKey.fill(0);
  }
}

/** Unwraps an already-initialized master and fails closed when migration has not run. */
export async function loadOmniCodexInternalIntegrityKeys(
  options: OmniCodexInternalIntegrityKeyOptions = {},
): Promise<OmniCodexInternalIntegrityKeys> {
  const ports = createPorts(options);
  const config = await ports.loadConfig();
  const reference = config.internal?.integrityMasterKeyRef;
  if (reference === undefined) {
    throw new Error("OmniCodex internal integrity master is not initialized");
  }
  return keysFromStoredReference(ports.secretStore, reference);
}

function createPorts(options: OmniCodexInternalIntegrityKeyOptions) {
  const configPath = resolve(options.configPath ?? omniCodexConfigPath());
  return {
    loadConfig: options.loadConfig ?? (() => loadOmniCodexConfig(configPath)),
    saveConfig: options.saveConfig ?? ((config) => saveOmniCodexConfig(config, configPath)),
    secretStore:
      options.secretStore ??
      new WindowsDpapiSecretStore({ directory: join(omniCodexDataDirectory(), "secrets") }),
    randomBytes: options.randomBytes ?? nodeRandomBytes,
  };
}

async function keysFromStoredReference(
  secretStore: OmniCodexInternalIntegritySecretStore,
  reference: string,
): Promise<OmniCodexInternalIntegrityKeys> {
  assertDpapiReference(reference);
  const encodedMaster = await secretStore.get(reference);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedMaster)) {
    throw new Error("OmniCodex internal integrity master encoding is invalid");
  }
  const masterKey = Buffer.from(encodedMaster, "base64url");
  if (masterKey.length !== MASTER_KEY_BYTES || masterKey.toString("base64url") !== encodedMaster) {
    masterKey.fill(0);
    throw new Error("OmniCodex internal integrity master must be exactly 32 bytes");
  }
  try {
    return new OmniCodexInternalIntegrityKeys(masterKey);
  } finally {
    masterKey.fill(0);
  }
}

function assertDpapiReference(reference: string): void {
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new Error("OmniCodex internal integrity master requires a CurrentUser DPAPI reference");
  }
}
