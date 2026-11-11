import { describe, expect, it } from "vitest";
import {
  installValidatedRelease,
  rotateReferencedSecret,
  type SecretReferenceStore,
} from "../src/application/lifecycle-transactions.js";

describe("lifecycle transactions", () => {
  it("stores only opaque secret references and preserves bounded rotation overlap", async () => {
    const values = new Map<string, string>();
    const store: SecretReferenceStore = {
      put: async (name, secret) => {
        values.set(name, secret);
        return `wincred:${name}:2`;
      },
      remove: async (reference) => void values.delete(reference),
    };
    const secret = "never-persist-this-management-token";
    const state = await rotateReferencedSecret(store, "auth0-management", secret, {
      activeReference: "wincred:auth0-management:1",
    });
    expect(state).toEqual({
      activeReference: "wincred:auth0-management:2",
      previousReference: "wincred:auth0-management:1",
    });
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it("shadow-validates before atomic switch and rolls back the exact previous release", async () => {
    const events: string[] = [];
    const adapter = {
      stage: async (version: string) => {
        events.push(`stage:${version}`);
        return "releases/new";
      },
      validate: async (path: string) => void events.push(`validate:${path}`),
      current: async () => "releases/old",
      switchAtomically: async (path: string) => {
        events.push(`switch:${path}`);
        throw new Error("unhealthy switch");
      },
      rollback: async (path: string) => void events.push(`rollback:${path}`),
    };
    await expect(installValidatedRelease(adapter, "1.2.3")).rejects.toThrow("unhealthy switch");
    expect(events).toEqual([
      "stage:1.2.3",
      "validate:releases/new",
      "switch:releases/new",
      "rollback:releases/old",
    ]);
  });
});
