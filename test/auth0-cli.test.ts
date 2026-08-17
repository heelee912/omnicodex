import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Auth0CliCommand,
  Auth0CliInstaller,
  Auth0CliManagementClient,
  pinnedAuth0CliRelease,
} from "../src/infrastructure/auth/auth0-cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Auth0 CLI boundary", () => {
  it("accepts an explicit existing official CLI without downloading", async () => {
    const root = await temporaryDirectory();
    const executable = join(root, "auth0.exe");
    await writeFile(executable, "test");
    const fetch = vi.fn();

    const resolved = await new Auth0CliInstaller({ dataDirectory: root, fetch }).ensure(executable);

    expect(resolved).toBe(executable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an archive whose bytes do not match the pinned official checksum", async () => {
    const root = await temporaryDirectory();
    const extract = vi.fn();
    const fetch = vi.fn(async () => new Response("not-the-official-archive", { status: 200 }));

    await expect(
      new Auth0CliInstaller({ dataDirectory: root, fetch, extract }).ensure(),
    ).rejects.toThrow("checksum mismatch");
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects a redirect outside the bounded GitHub release hosts", async () => {
    const root = await temporaryDirectory();
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/auth0.zip" },
        }),
    );

    await expect(
      new Auth0CliInstaller({ dataDirectory: root, fetch, extract: vi.fn() }).ensure(),
    ).rejects.toThrow("GitHub release boundary");
  });

  it("uses device login scopes and keeps Management API JSON out of argv", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const command: Auth0CliCommand = async (_executable, args, options) => {
      calls.push({ args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
      return {
        stdout: args[0] === "api" ? JSON.stringify({ ok: true }) : "",
        stderr: "",
        exitCode: 0,
      };
    };
    const client = new Auth0CliManagementClient({
      executablePath: "C:\\managed\\auth0.exe",
      command,
    });

    await client.login("https://tenant.us.auth0.com/", ["read:resource_servers"]);
    const body = JSON.stringify({ name: "OmniCodex", marker: "body-only-value" });
    await expect(
      client.request("https://tenant.us.auth0.com/", "/api/v2/resource-servers?x=1", {
        method: "POST",
        body,
      }),
    ).resolves.toEqual({ ok: true });

    expect(calls[0]?.args).toEqual([
      "login",
      "--domain",
      "tenant.us.auth0.com",
      "--scopes",
      "read:resource_servers",
      "--no-input",
      "--no-color",
    ]);
    expect(calls[1]?.args).toEqual([
      "api",
      "post",
      "resource-servers",
      "--tenant",
      "tenant.us.auth0.com",
      "--no-input",
      "--no-color",
      "--query",
      "x=1",
    ]);
    expect(calls[1]?.args.join(" ")).not.toContain("body-only-value");
    expect(calls[1]?.stdin).toBe(body);
  });

  it("supports first login before a tenant is configured and discovers exact tenants", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const client = new Auth0CliManagementClient({
      executablePath: "C:\\managed\\auth0.exe",
      command: async (_executable, args) => {
        mutableCalls.push([...args]);
        return {
          stdout:
            args[0] === "tenants"
              ? JSON.stringify([{ name: "Owner", domain: "owner.us.auth0.com" }])
              : "",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await client.login(undefined, ["read:resource_servers"]);
    await expect(client.listTenants()).resolves.toEqual([
      { name: "Owner", domain: "owner.us.auth0.com" },
    ]);
    expect(mutableCalls[0]).toEqual([
      "login",
      "--scopes",
      "read:resource_servers",
      "--no-input",
      "--no-color",
    ]);
    expect(mutableCalls[1]).toEqual(["tenants", "list", "--json", "--no-input", "--no-color"]);
  });

  it("opens only the bounded Auth0 device URL emitted by the hidden CLI", async () => {
    const opened: URL[] = [];
    const client = new Auth0CliManagementClient({
      executablePath: "C:\\managed\\auth0.exe",
      openDeviceUrl: (url) => opened.push(url),
      command: async (_executable, _args, options) => {
        options?.onStderr?.(
          "Open the following URL in a browser: https://auth0.auth0.com/activate?user_code=ABCD-EFGH",
        );
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    await client.login(undefined, ["read:resource_servers"]);
    expect(opened.map((url) => url.href)).toEqual([
      "https://auth0.auth0.com/activate?user_code=ABCD-EFGH",
    ]);
  });

  it("does not expose Auth0 CLI stderr in a failed management exception", async () => {
    const secret = "secret-access-token-that-must-not-leak";
    const client = new Auth0CliManagementClient({
      executablePath: "C:\\managed\\auth0.exe",
      command: async () => ({ stdout: "", stderr: secret, exitCode: 7 }),
    });

    const failure = await client
      .request("https://tenant.us.auth0.com/", "/api/v2/tenants/settings", { method: "GET" })
      .catch((error: unknown) => String(error));
    expect(failure).toContain("(7)");
    expect(failure).not.toContain(secret);
  });

  it("rejects a tenant origin with a non-default port", async () => {
    const client = new Auth0CliManagementClient({
      executablePath: "C:\\managed\\auth0.exe",
      command: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
    });

    await expect(client.login("https://tenant.us.auth0.com:8443/", [])).rejects.toThrow(
      "credential-free HTTPS origin",
    );
  });

  it("pins the exact Windows release artifact and digest", () => {
    const release = pinnedAuth0CliRelease();
    expect(release.version).toBe("1.32.0");
    expect(release.windows.x64.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.windows.arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.windows.x64.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.windows.arm64.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omnicodex-auth0-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}
