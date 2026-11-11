import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
describe("release package policy", () => {
  it("publishes a scoped public package with an explicit file allowlist", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pkg).toMatchObject({
      name: "@heelee912/omnicodex",
      license: "MIT",
      engines: { node: ">=24.14.0" },
      bin: { omnicodex: "./dist/cli.js" },
      private: false,
      publishConfig: { access: "public" },
    });
    expect(pkg.files).toEqual([
      "dist",
      "docs/README.ko.md",
      "docs/README.ja.md",
      "docs/README.zh.md",
      "docs/reference-ledger.md",
      "scripts/connectors/hosted-mcp/config.mjs",
      "scripts/connectors/hosted-mcp/config-store.mjs",
      "scripts/connectors/hosted-mcp/setup.mjs",
      "scripts/connectors/hosted-mcp/state.mjs",
      "scripts/connectors/hosted-mcp/audit.mjs",
      "scripts/connectors/hosted-mcp/hosted-connector.mjs",
      "scripts/connectors/hosted-mcp/oauth-credential.mjs",
      "scripts/connectors/hosted-mcp/oauth-login.mjs",
      "scripts/connectors/hosted-mcp/stdio.mjs",
      "scripts/connectors/hosted-mcp/windows-dpapi.ps1",
      "scripts/connectors/hosted-mcp/windows-private-config.ps1",
      "scripts/connectors/hosted-mcp/windows-private-state.ps1",
      "scripts/connectors/hosted-mcp/README.md",
      "scripts/oracle/*.mjs",
      "scripts/oracle/*.ps1",
      "scripts/oracle/a1_capacity_catcher.py",
      "scripts/oracle/install-managed-caddy.py",
      "scripts/oracle/oracle-browser-profile.py",
      "scripts/oracle/provision-a1-network.py",
      "scripts/oracle/*.service",
      "scripts/oracle/*.sh",
      "scripts/oracle/*.timer",
      "scripts/windows/desktop-engine",
      "scripts/windows/install.ps1",
      "scripts/windows/start-omnicodex2-tunnel.ps1",
      "scripts/windows/uninstall.ps1",
      "README.md",
      "LICENSE",
      "NOTICE",
    ]);
    expect(JSON.stringify(pkg.files)).not.toMatch(
      /(?:test|\.upstream|node_modules|\.env|tmp|secret)/i,
    );
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("scripts/oracle");
    expect(JSON.stringify(pkg.files)).not.toMatch(/(?:__pycache__|\.pyc|history|ISSUE_LOG)/i);
  });
  it("ships only portable hosted connector runtime, never account state", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).not.toContain("scripts/connectors/hosted-mcp");
    expect(pkg.files).not.toContain("scripts/connectors/hosted-mcp/registration.json");
    const paths = pkg.files.filter((path) => path.startsWith("scripts/connectors/hosted-mcp/"));
    expect(paths).toHaveLength(13);
    for (const path of paths) {
      expect(path).not.toMatch(
        /(?:\*|oauth\.dpapi|registration\.json|\.jsonl|\.lock|\.tmp|\.test\.)/,
      );
      const text = await readFile(new URL(path, root), "utf8");
      expect(text).not.toMatch(
        /(?:asdk_app_[a-f0-9]{24,}|link_[a-f0-9]{24,}|tunnel_[a-f0-9]{24,}|app_[A-Za-z0-9]{20,}|[A-Z]:\\Users\\|[A-Z]:\/Users\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
      );
      expect(text).not.toMatch(
        /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|BEGIN (?:RSA |EC )?PRIVATE KEY)/,
      );
    }
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
      "scripts/oracle/install-backhaul-user.sh",
      "scripts/oracle/install-ip-ingress.sh",
      "scripts/windows/install.ps1",
      "scripts/windows/uninstall.ps1",
    ]) {
      const text = await readFile(new URL(name, root), "utf8");
      expect(text).not.toMatch(
        /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|BEGIN (?:RSA |EC )?PRIVATE KEY)/,
      );
    }
  });
  it("keeps private release workflows out of the public source repository", async () => {
    for (const name of [
      ".github/workflows/release.yml",
      ".github/workflows/real-windows-e2e.yml",
    ]) {
      await expect(readFile(new URL(name, root), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const ci = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
    expect(ci).toContain("npm audit --omit=dev --audit-level=high");
    expect(ci).not.toMatch(/npm publish|gh release create|id-token: write/);
  });
});
