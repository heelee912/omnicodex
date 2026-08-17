import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WindowsDpapiSecretStore } from "../src/infrastructure/windows/windows-dpapi-secret-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WindowsDpapiSecretStore", () => {
  it("persists only ciphertext and returns an opaque reference", async () => {
    const directory = await temporaryDirectory();
    const store = new WindowsDpapiSecretStore({
      directory,
      systemRoot: "C:\\Windows",
      protect: async (secret) => Buffer.from(`protected:${secret}`, "utf8").toString("base64"),
      unprotect: async (ciphertext) =>
        Buffer.from(ciphertext, "base64")
          .toString("utf8")
          .replace(/^protected:/, ""),
    });
    const secret = "ngrok-secret-that-never-reaches-config";
    const reference = await store.put("ngrok-authtoken", secret);
    expect(reference).toMatch(/^dpapi:v1:[A-Za-z0-9_-]{43}$/);
    const id = reference.slice("dpapi:v1:".length);
    const ciphertext = await readFile(join(directory, `${id}.dpapi`), "utf8");
    expect(ciphertext).not.toContain(secret);
    await expect(store.get(reference)).resolves.toBe(secret);
    await store.remove(reference);
    await expect(store.get(reference)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid references and weak secrets without touching disk", async () => {
    const directory = await temporaryDirectory();
    const store = new WindowsDpapiSecretStore({
      directory,
      systemRoot: "C:\\Windows",
      protect: async () => "cHJvdGVjdGVk",
      unprotect: async () => "never",
    });
    await expect(store.put("weak", "short")).rejects.toThrow("bounded");
    await expect(store.get("dpapi:v1:../escape")).rejects.toThrow("Invalid");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-dpapi-"));
  temporaryDirectories.push(directory);
  return directory;
}
