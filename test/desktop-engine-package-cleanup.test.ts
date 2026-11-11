import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { removeInstalledBuildPackage } from "../scripts/windows/desktop-engine/remove-installed-build-package.mjs";

describe("Desktop engine build package cleanup", () => {
  it("removes only a verified intermediate package after the installed engine exists elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-package-cleanup-"));
    try {
      const packageRoot = join(root, "packages");
      const packageDirectory = join(packageRoot, "b-aaaaaaaa");
      const unrelatedDirectory = join(root, "unrelated");
      const installedDirectory = join(root, "engine-generations", "codex-active", "package");
      await Promise.all([
        mkdir(packageDirectory, { recursive: true }),
        mkdir(unrelatedDirectory),
        mkdir(installedDirectory, { recursive: true }),
      ]);
      const installed = join(installedDirectory, "codex.exe");
      const unrelated = join(unrelatedDirectory, "codex.exe");
      await Promise.all([
        writeFile(join(packageDirectory, "codex.exe"), "build"),
        writeFile(installed, "installed"),
        writeFile(unrelated, "unrelated"),
      ]);

      await expect(
        removeInstalledBuildPackage(root, unrelatedDirectory, installed),
      ).rejects.toThrow("outside its package root");
      await access(unrelated);
      await expect(
        removeInstalledBuildPackage(root, packageDirectory, join(packageDirectory, "codex.exe")),
      ).rejects.toThrow("Installed engine must remain outside the build package");
      await access(join(packageDirectory, "codex.exe"));
      await removeInstalledBuildPackage(root, packageDirectory, installed);
      await expect(access(packageDirectory)).rejects.toThrow();
      await access(installed);
    } finally {
      const beneathTemp = relative(tmpdir(), root);
      if (beneathTemp !== "" && !beneathTemp.startsWith("..") && !isAbsolute(beneathTemp)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
