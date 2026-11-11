import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOmniCodexConfig,
  type OmniCodexConfig,
  saveOmniCodexConfig,
} from "../src/infrastructure/config/omnicodex-config-store.js";
import {
  ensureOmniCodexInternalIntegrityKeys,
  loadOmniCodexInternalIntegrityKeys,
  type OmniCodexInternalIntegritySecretStore,
} from "../src/infrastructure/config/omnicodex-internal-integrity-key.js";
import { WindowsDpapiSecretStore } from "../src/infrastructure/windows/windows-dpapi-secret-store.js";

const temporaryDirectories: string[] = [];
const reference = `dpapi:v1:${"A".repeat(43)}`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OmniCodex internal integrity keys", () => {
  it("creates one DPAPI-backed master and derives stable, separated 32-byte keys", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "config.json");
    await saveOmniCodexConfig(validConfig(), configPath);
    const store = new MemorySecretStore();
    const first = await ensureOmniCodexInternalIntegrityKeys({
      configPath,
      secretStore: store,
      randomBytes: (size) => Buffer.alloc(size, 0x5a),
    });
    const schedule = first.derive("direct-schedule-v1");
    const events = first.derive("durable-mcp-events-v1");
    first.dispose();

    const persisted = await readFile(configPath, "utf8");
    expect(persisted).toContain(reference);
    expect(persisted).not.toContain(Buffer.alloc(32, 0x5a).toString("base64url"));
    expect(await loadOmniCodexConfig(configPath)).toEqual({
      ...validConfig(),
      internal: { integrityMasterKeyRef: reference },
    });
    expect(store.putCalls).toBe(1);
    expect(schedule).toHaveLength(32);
    expect(events).toHaveLength(32);
    expect(schedule.equals(events)).toBe(false);

    const reloaded = await loadOmniCodexInternalIntegrityKeys({ configPath, secretStore: store });
    expect(reloaded.derive("direct-schedule-v1")).toEqual(schedule);
    reloaded.dispose();
    const ensuredAgain = await ensureOmniCodexInternalIntegrityKeys({
      configPath,
      secretStore: store,
    });
    ensuredAgain.dispose();
    expect(store.putCalls).toBe(1);
  });

  it("rejects a DPAPI payload that is not canonically encoded as exactly 32 bytes", async () => {
    const config: OmniCodexConfig = {
      ...validConfig(),
      internal: { integrityMasterKeyRef: reference },
    };
    const store = new MemorySecretStore();
    store.values.set(reference, Buffer.alloc(31, 7).toString("base64url"));
    await expect(
      loadOmniCodexInternalIntegrityKeys({
        loadConfig: async () => config,
        saveConfig: async () => undefined,
        secretStore: store,
      }),
    ).rejects.toThrow("encoding is invalid");
  });

  it("restores the original config before removing a newly-created secret on readback failure", async () => {
    const original = validConfig();
    let current = original;
    let corruptNextReadback = true;
    const store = new MemorySecretStore();
    await expect(
      ensureOmniCodexInternalIntegrityKeys({
        loadConfig: async () => {
          if (current.internal !== undefined && corruptNextReadback) {
            corruptNextReadback = false;
            return { ...current, projectRoot: "C:\\unexpected" };
          }
          return current;
        },
        saveConfig: async (config) => {
          current = config;
        },
        secretStore: store,
        randomBytes: (size) => Buffer.alloc(size, 0x19),
      }),
    ).rejects.toThrow("readback differed");
    expect(current).toEqual(original);
    expect(store.values.has(reference)).toBe(false);
    expect(store.removeCalls).toBe(1);
  });

  it("retains the DPAPI secret when config rollback itself cannot be proven", async () => {
    const original = validConfig();
    let current = original;
    let saveCalls = 0;
    const store = new MemorySecretStore();
    await expect(
      ensureOmniCodexInternalIntegrityKeys({
        loadConfig: async () =>
          current.internal === undefined ? current : { ...current, projectRoot: "C:\\unexpected" },
        saveConfig: async (config) => {
          saveCalls += 1;
          if (saveCalls === 2) throw new Error("rollback write failed");
          current = config;
        },
        secretStore: store,
        randomBytes: (size) => Buffer.alloc(size, 0x29),
      }),
    ).rejects.toThrow("migration and config rollback both failed");
    expect(store.values.has(reference)).toBe(true);
    expect(store.removeCalls).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "migrates a legacy config through real CurrentUser DPAPI and reopens the same key",
    async () => {
      const directory = await temporaryDirectory();
      const configPath = join(directory, "config.json");
      const secretsDirectory = join(directory, "secrets");
      await saveOmniCodexConfig(validConfig(), configPath);
      const secretStore = new WindowsDpapiSecretStore({ directory: secretsDirectory });

      const created = await ensureOmniCodexInternalIntegrityKeys({ configPath, secretStore });
      const expectedScheduleKey = created.derive("direct-schedule-v1");
      created.dispose();

      const migrated = await loadOmniCodexConfig(configPath);
      expect(migrated).toEqual({
        ...validConfig(),
        internal: {
          integrityMasterKeyRef: expect.stringMatching(/^dpapi:v1:[A-Za-z0-9_-]{43}$/),
        },
      });
      expect(
        (await readdir(secretsDirectory)).filter((name) => name.endsWith(".dpapi")),
      ).toHaveLength(1);

      const reopened = await loadOmniCodexInternalIntegrityKeys({ configPath, secretStore });
      expect(reopened.derive("direct-schedule-v1")).toEqual(expectedScheduleKey);
      reopened.dispose();

      const ensuredAgain = await ensureOmniCodexInternalIntegrityKeys({ configPath, secretStore });
      expect(ensuredAgain.derive("direct-schedule-v1")).toEqual(expectedScheduleKey);
      ensuredAgain.dispose();
      expect(
        (await readdir(secretsDirectory)).filter((name) => name.endsWith(".dpapi")),
      ).toHaveLength(1);
    },
    30_000,
  );
});

class MemorySecretStore implements OmniCodexInternalIntegritySecretStore {
  readonly values = new Map<string, string>();
  putCalls = 0;
  removeCalls = 0;

  async put(_name: string, secret: string): Promise<string> {
    this.putCalls += 1;
    this.values.set(reference, secret);
    return reference;
  }

  async get(secretReference: string): Promise<string> {
    const value = this.values.get(secretReference);
    if (value === undefined) throw new Error("missing secret");
    return value;
  }

  async remove(secretReference: string): Promise<void> {
    this.removeCalls += 1;
    this.values.delete(secretReference);
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-integrity-key-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validConfig(): OmniCodexConfig {
  return {
    schemaVersion: 1,
    projectRoot: "C:\\work",
    gateway: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      fullPath: "/mcp/full",
      allowedOrigins: ["https://chatgpt.com"],
    },
    auth: {
      issuer: "https://owner.example/",
      audience: "https://omnicodex.example/",
      resource: "https://omnicodex.example/",
      requiredScopes: ["omnicodex:full"],
      allowedSubjects: ["auth0|owner"],
      jwksUri: "https://owner.example/.well-known/jwks.json",
    },
  };
}
