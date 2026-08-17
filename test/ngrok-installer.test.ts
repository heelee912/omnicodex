import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NgrokInstaller,
  pinnedNgrokRelease,
} from "../src/infrastructure/tunnel/ngrok-installer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("NgrokInstaller", () => {
  it("accepts an explicit executable without downloading", async () => {
    const root = await temporaryDirectory();
    const executable = join(root, "ngrok.exe");
    await writeFile(executable, "test");
    const fetch = vi.fn();

    await expect(
      new NgrokInstaller({ dataDirectory: root, fetch }).ensure(executable),
    ).resolves.toBe(executable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the pinned archive", async () => {
    const root = await temporaryDirectory();
    const fetch = vi.fn(async () => new Response("wrong", { status: 200 }));

    await expect(
      new NgrokInstaller({ dataDirectory: root, fetch, extract: vi.fn() }).ensure(),
    ).rejects.toThrow("checksum mismatch");
  });

  it("installs an injected checksum-pinned fixture atomically", async () => {
    const root = await temporaryDirectory();
    const archive = Buffer.from("fixture-archive");
    const release = {
      version: "test",
      archive: "ngrok-test.zip",
      url: "https://bin.equinox.io/a/test/ngrok-test.zip",
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    const installer = new NgrokInstaller({
      dataDirectory: root,
      release,
      fetch: async () => new Response(archive, { status: 200 }),
      extract: async (_archivePath, destination) =>
        writeFile(join(destination, "ngrok.exe"), "binary"),
    });

    const installed = await installer.ensure();
    expect(installed).toBe(join(root, "bin", "ngrok", "test", "ngrok.exe"));
    await expect(installer.ensure()).resolves.toBe(installed);
  });

  it("pins the official Windows archive and checksum", () => {
    const release = pinnedNgrokRelease();
    expect(release.version).toBe("3.3.1");
    expect(release.windowsX64.url).toMatch(/^https:\/\/bin\.equinox\.io\//);
    expect(release.windowsX64.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omnicodex-ngrok-installer-"));
  temporaryDirectories.push(path);
  return path;
}
