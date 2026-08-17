import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
describe("release package policy", () => {
  it("publishes an explicit clean allowlist with provenance metadata", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg).toMatchObject({
      name: "@heelee912/omnicodex",
      license: "MIT",
      engines: { node: ">=22.12.0" },
      bin: { omnicodex: "./dist/cli.js" },
      publishConfig: { access: "public", provenance: true },
    });
    expect(pkg.files).toEqual([
      "dist",
      "docs",
      "scripts/windows/install.ps1",
      "scripts/windows/uninstall.ps1",
      "README.md",
      "LICENSE",
      "NOTICE",
    ]);
    expect(JSON.stringify(pkg.files)).not.toMatch(
      /(?:test|\.upstream|node_modules|\.env|tmp|secret)/i,
    );
  });
  it("keeps the executable CLI entry and required notices", async () => {
    expect(await readFile(new URL("src/cli.ts", root), "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
    for (const name of [
      "README.md",
      "LICENSE",
      "NOTICE",
      "docs/README.ko.md",
      "docs/README.ja.md",
      "docs/README.zh.md",
    ])
      expect((await readFile(new URL(name, root), "utf8")).length).toBeGreaterThan(100);
  });
  it("contains no publishing lifecycle hook or embedded credential", async () => {
    const pkg = await readFile(new URL("package.json", root), "utf8");
    expect(pkg).not.toMatch(/"(?:prepublish|publish|postpublish)"\s*:/);
    for (const name of [
      "README.md",
      "NOTICE",
      "scripts/windows/install.ps1",
      "scripts/windows/uninstall.ps1",
    ]) {
      const text = await readFile(new URL(name, root), "utf8");
      expect(text).not.toMatch(
        /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|BEGIN (?:RSA |EC )?PRIVATE KEY)/,
      );
    }
  });
});
