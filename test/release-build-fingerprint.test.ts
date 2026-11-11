import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeOmniCodexReleaseFingerprint,
  isSameOmniCodexReleaseBuild,
} from "../src/infrastructure/release/release-build-fingerprint.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OmniCodex executable release identity", () => {
  it("changes only when an executable release artifact changes", async () => {
    const root = await fixture();
    const first = await computeOmniCodexReleaseFingerprint(root);

    await writeFile(join(root, "dist", "ignored.d.ts"), "export type Ignored = true;\n", "utf8");
    await writeFile(join(root, "dist", "ignored.js.map"), "{}\n", "utf8");
    await expect(computeOmniCodexReleaseFingerprint(root)).resolves.toBe(first);

    await writeFile(join(root, "dist", "daemon.js"), "export const build = 2;\n", "utf8");
    const second = await computeOmniCodexReleaseFingerprint(root);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });

  it("recognizes the exact running build and rejects legacy or changed state", async () => {
    const root = await fixture();
    const fingerprint = await computeOmniCodexReleaseFingerprint(root);
    expect(
      isSameOmniCodexReleaseBuild(
        { releasePath: root, releaseFingerprint: fingerprint },
        root,
        fingerprint,
      ),
    ).toBe(true);
    expect(isSameOmniCodexReleaseBuild({ releasePath: root }, root, fingerprint)).toBe(false);
    expect(
      isSameOmniCodexReleaseBuild(
        { releasePath: root, releaseFingerprint: "0".repeat(64) },
        root,
        fingerprint,
      ),
    ).toBe(false);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-release-fingerprint-"));
  roots.push(root);
  await mkdir(join(root, "dist", "nested"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n', "utf8");
  await writeFile(join(root, "dist", "daemon.js"), "export const build = 1;\n", "utf8");
  await writeFile(join(root, "dist", "nested", "tool.js"), "export const tool = true;\n", "utf8");
  return root;
}
