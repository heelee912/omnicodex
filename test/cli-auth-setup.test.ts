import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  Auth0ManagementProvisioner,
  type Auth0ManagementRequester,
} from "../src/infrastructure/auth/auth0-management-provisioner.js";

const root = new URL("../", import.meta.url);

function commandBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

class RecordingRejectingRequester implements Auth0ManagementRequester {
  readonly calls: Array<{ tenantOrigin: string; path: string; init: RequestInit }> = [];

  async request<T>(tenantOrigin: string, path: string, init: RequestInit): Promise<T> {
    this.calls.push({ tenantOrigin, path, init });
    throw new Error("Unexpected Auth0 Management API request");
  }
}

describe("Auth0 setup CLI", () => {
  it("pre-provisions an explicit audience without stopping the daemon or changing local config", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const setup = commandBlock(
      source,
      'auth\n  .command("setup")',
      'auth\n  .command("dcr-clients")',
    );

    expect(source).toContain("interface AuthSetupOptions extends JsonOptions {");
    expect(source).toContain("  readonly audience?: string;");
    expect(setup).toContain('"--audience <url>"');
    expect(setup).toContain("const baseAudience = options.audience ?? config.auth.audience;");
    expect(setup).toContain("new URL(config.gateway.fullPath, new URL(baseAudience).origin).href");
    expect(setup).toContain('apiName: audience === baseAudience ? "OmniCodex" : "OmniCodex Full"');
    expect(setup).not.toContain("requireStoppedDaemon");
    expect(setup).not.toContain("saveOmniCodexConfig");
    expect(setup).not.toContain("requestDaemonControl");
  });

  it("keeps explicit targets behind the existing credential-free HTTPS audience boundary", async () => {
    const requester = new RecordingRejectingRequester();
    const provisioner = new Auth0ManagementProvisioner({ requester });

    await expect(
      provisioner.provision({
        tenantOrigin: "https://owner.us.auth0.com/",
        audience: "http://future.example/mcp",
      }),
    ).rejects.toThrow("Auth0 audience must be a credential-free HTTPS URL");
    expect(requester.calls).toHaveLength(0);
  });
});
