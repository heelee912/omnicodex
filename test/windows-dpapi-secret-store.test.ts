import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HiddenChildProcessBoundary } from "../src/infrastructure/windows/hidden-child-process.js";
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
  it("drains a large native stderr stream without exposing its contents", async () => {
    const directory = await temporaryDirectory();
    const code = [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stderr.write('private-marker'.repeat(20_000));",
      "  process.stdout.end('cHJvdGVjdGVk');",
      "});",
    ].join("\n");
    const childProcesses = new HiddenChildProcessBoundary((_executable, _args, options) =>
      spawn(process.execPath, ["-e", code], options),
    );
    const store = new WindowsDpapiSecretStore({
      directory,
      systemRoot: "C:\\Windows",
      childProcesses,
      timeoutMs: 5_000,
    });
    await expect(store.put("synthetic", "synthetic-secret-long-enough")).resolves.toMatch(
      /^dpapi:v1:[A-Za-z0-9_-]{43}$/u,
    );
  });

  it("bounds a stalled owned bridge instead of waiting forever", async () => {
    const directory = await temporaryDirectory();
    const childProcesses = new HiddenChildProcessBoundary((_executable, _args, options) =>
      spawn(
        process.execPath,
        ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
        options,
      ),
    );
    const store = new WindowsDpapiSecretStore({
      directory,
      systemRoot: "C:\\Windows",
      childProcesses,
      timeoutMs: 100,
    });
    await expect(store.put("synthetic", "synthetic-secret-long-enough")).rejects.toThrow(
      "DPAPI bridge timed out",
    );
  });

  it("rejects an invalid bridge deadline before launching a child", async () => {
    const directory = await temporaryDirectory();
    expect(
      () => new WindowsDpapiSecretStore({ directory, systemRoot: "C:\\Windows", timeoutMs: 0 }),
    ).toThrow("DPAPI bridge timeout must be a positive safe integer");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-dpapi-"));
  temporaryDirectories.push(directory);
  return directory;
}
