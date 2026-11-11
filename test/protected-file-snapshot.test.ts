import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeProtectedFile } from "../src/infrastructure/safety/protected-file-snapshot.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-protected-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("observeProtectedFile", () => {
  it("records only metadata, identity, and SHA-256 for a regular file", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, "auth.json");
    const contents = Buffer.from('{"token":"secret-never-logged"}', "utf8");
    await writeFile(filePath, contents);

    const observation = await observeProtectedFile({
      logicalName: "auth",
      path: filePath,
    });

    expect(observation.status).toBe("present");
    expect(observation.sizeBytes).toBe(String(contents.byteLength));
    expect(observation.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    expect(JSON.stringify(observation)).not.toContain("secret-never-logged");
    expect(observation.fileIdentity).toMatch(/^\d+:\d+$/);
  });

  it("detects a one-byte change even when the size is unchanged", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = join(directory, "config.toml");
    await writeFile(filePath, "mode=a", "utf8");
    const before = await observeProtectedFile({ logicalName: "config", path: filePath });

    await writeFile(filePath, "mode=b", "utf8");
    const after = await observeProtectedFile({ logicalName: "config", path: filePath });

    expect(before.status).toBe("present");
    expect(after.status).toBe("present");
    expect(after.sizeBytes).toBe(before.sizeBytes);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it("represents a missing file without treating it as readable content", async () => {
    const directory = await createTemporaryDirectory();
    const observation = await observeProtectedFile({
      logicalName: "missing",
      path: join(directory, "missing.toml"),
    });
    expect(observation).toMatchObject({
      logicalName: "missing",
      status: "missing",
    });
    expect(observation.sha256).toBeUndefined();
  });

  it("fails closed for a directory", async () => {
    const directory = await createTemporaryDirectory();
    const nested = join(directory, "not-a-file");
    await mkdir(nested);
    const observation = await observeProtectedFile({
      logicalName: "config",
      path: nested,
    });
    expect(observation).toMatchObject({
      status: "unverifiable",
      errorCode: "NOT_REGULAR_FILE",
    });
  });
});
