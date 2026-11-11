import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceDependencyLocator } from "../src/infrastructure/windows/workspace-dependency-locator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("WorkspaceDependencyLocator", () => {
  it("returns only verified paths from the installed bundle manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-workspace-runtime-"));
    temporaryDirectories.push(root);
    const paths = [
      ["dependencies", "native", "git", "cmd", "git.exe"],
      ["dependencies", "node", "bin", "node.exe"],
      ["dependencies", "node", "node_modules", ".keep"],
      ["dependencies", "bin", "fallback", "pnpm.cmd"],
      ["dependencies", "python", "python.exe"],
      ["dependencies", "bin", "override", ".keep"],
    ];
    for (const segments of paths) {
      const path = join(root, ...segments);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "", "utf8");
    }
    await writeFile(
      join(root, "runtime.json"),
      `${JSON.stringify({ bundleVersion: "26.test" })}\n`,
      "utf8",
    );

    const result = await new WorkspaceDependencyLocator({ runtimeRoot: root }).locate();
    expect(result).toMatchObject({
      bundleVersion: "26.test",
      runtimeRoot: root,
      manifestPath: join(root, "runtime.json"),
      nodePackages: join(root, "dependencies", "node", "node_modules"),
      pythonPackages: join(root, "dependencies", "python"),
    });
  });

  it("fails when a required bundled dependency is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-workspace-runtime-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "runtime.json"), '{"bundleVersion":"26.test"}\n', "utf8");
    await expect(new WorkspaceDependencyLocator({ runtimeRoot: root }).locate()).rejects.toThrow();
  });
});
