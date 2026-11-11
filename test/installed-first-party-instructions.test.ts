import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateInstalledFirstPartyAsset } from "../src/application/installed-first-party-instructions.js";

describe("installed first-party asset resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses the active installation pointer and never resurrects a retired asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-assets-"));
    roots.push(root);
    const current = await install(root, "chrome", "2", "control-chrome");
    const retired = await install(root, "chrome", "1", "control-chrome");
    const plugin = join(root, "plugins", "cache", "openai-bundled", "chrome");
    await symlink(join(plugin, "2"), join(plugin, "latest"), "junction");
    await utimes(retired, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    const request = {
      codexHome: root,
      plugins: ["chrome"],
      relativePath: ["skills", "control-chrome", "SKILL.md"],
    };

    expect(await locateInstalledFirstPartyAsset(request)).toBe(current);
    await rm(current);
    await expect(locateInstalledFirstPartyAsset(request)).rejects.toThrow("asset is missing");
  });

  it("finds renamed active plugin packages and follows a later runtime version", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-assets-renamed-plugin-"));
    roots.push(root);
    const versionOne = await install(
      root,
      "renamed-browser-package",
      "runtime-a",
      "control-chrome",
    );
    const plugin = join(root, "plugins", "cache", "openai-bundled", "renamed-browser-package");
    await symlink(join(plugin, "runtime-a"), join(plugin, "latest"), "junction");
    const request = {
      codexHome: root,
      plugins: ["*"],
      relativePath: ["skills", "control-chrome", "SKILL.md"],
    };

    expect(await locateInstalledFirstPartyAsset(request)).toBe(versionOne);

    const versionTwo = await install(
      root,
      "renamed-browser-package",
      "runtime-b",
      "control-chrome",
    );
    await rm(join(plugin, "latest"), { recursive: true, force: true });
    await symlink(join(plugin, "runtime-b"), join(plugin, "latest"), "junction");
    expect(await locateInstalledFirstPartyAsset(request)).toBe(versionTwo);
  });

  it("does not select plugin backup copies when resolving all active package names", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-assets-backup-plugin-"));
    roots.push(root);
    const current = await install(root, "renamed-browser-package", "runtime-a", "control-chrome");
    await install(root, "plugin-backup-stale", "runtime-newer", "control-chrome");

    expect(
      await locateInstalledFirstPartyAsset({
        codexHome: root,
        plugins: ["*"],
        relativePath: ["skills", "control-chrome", "SKILL.md"],
      }),
    ).toBe(current);
  });
});

async function install(
  root: string,
  plugin: string,
  version: string,
  skill: string,
): Promise<string> {
  const directory = join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    plugin,
    version,
    "skills",
    skill,
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  await writeFile(path, "asset", "utf8");
  return path;
}
