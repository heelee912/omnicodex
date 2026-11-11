import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = new URL("../scripts/connectors/hosted-mcp/", import.meta.url);
const { loadConfig } = await import(new URL("config.mjs", runtime).href);
const { configPathArgument, installConfig, installedConfigPath, loadInstalledConfig } =
  await import(new URL("config-store.mjs", runtime).href);
const { officialGuides, openOfficialGuide, runSetup } = await import(
  new URL("setup.mjs", runtime).href
);
const registrationEnv = {
  OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "synthetic-setup-client",
  OMNICODEX_HOSTED_OAUTH_AUTHORIZATION_URL: "https://identity.example.invalid/authorize",
  OMNICODEX_HOSTED_OAUTH_TOKEN_URL: "https://identity.example.invalid/token",
  OMNICODEX_HOSTED_OAUTH_CALLBACK_URL: "http://127.0.0.1:37681/oauth/callback",
  OMNICODEX_HOSTED_OAUTH_SCOPES: "openid offline_access synthetic.read",
  OMNICODEX_HOSTED_WORKSPACE_ID: "synthetic-setup-workspace",
  OMNICODEX_HOSTED_CONNECTOR_ID: "synthetic-setup-connector",
  OMNICODEX_HOSTED_LINK_ID: "synthetic-setup-link",
  OMNICODEX_HOSTED_MCP_ENDPOINT: "https://resource.example.invalid/mcp",
};
const config = loadConfig(registrationEnv);
const fields = [
  config.clientId,
  config.authorizationUrl,
  config.tokenUrl,
  config.callbackUrl,
  config.scopes,
  config.workspaceId,
  config.connectorId,
  config.linkId,
  config.endpoint,
];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "hosted-setup-test-"));
  directories.push(home);
  const options = {
    home,
    env: { LOCALAPPDATA: home, XDG_STATE_HOME: home },
    configPath: join(home, "config", "synthetic.json"),
  };
  return { home, options };
}

function questions(answers: string[]) {
  const pending = [...answers];
  const ask = vi.fn(async (_question: string) => {
    const answer = pending.shift();
    if (answer === undefined) throw new Error("Unexpected setup prompt");
    return answer;
  });
  return ask;
}

function scriptEnvironment(path: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, OMNICODEX_HOSTED_CONFIG_PATH: path };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OMNICODEX_HOSTED_") && key !== "OMNICODEX_HOSTED_CONFIG_PATH")
      delete env[key];
  }
  return env;
}

describe("installed hosted registration isolation", () => {
  it("atomically installs only normalized nonsecret registration and automatically loads it", async () => {
    const { options } = await fixture();
    const path = await installConfig(config, options);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["registration", "version"]);
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.registration).sort()).toEqual([
      "authorizationUrl",
      "callbackUrl",
      "clientId",
      "connectorId",
      "endpoint",
      "linkId",
      "scopes",
      "tokenUrl",
      "workspaceId",
    ]);
    expect(await loadInstalledConfig(options)).toEqual(config);
    expect(await readdir(dirname(path))).toEqual(["synthetic.json"]);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    }
  });

  it("selects a default outside source and supports named configurations for distinct registrations", async () => {
    const { options, home } = await fixture();
    const defaults = { home, env: options.env };
    const defaultPath = await installConfig(config, defaults);
    expect(await installedConfigPath(defaults)).toBe(defaultPath);
    expect(defaultPath.startsWith(home)).toBe(true);
    expect(defaultPath.endsWith("registration.json")).toBe(true);
    expect(await loadInstalledConfig(defaults)).toEqual(config);
    const second = loadConfig({
      ...registrationEnv,
      OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "synthetic-other-client",
      OMNICODEX_HOSTED_LINK_ID: "synthetic-other-link",
    });
    const secondOptions = { ...options, configPath: join(home, "named", "other.json") };
    const path = await installConfig(second, secondOptions);
    const selected = await loadInstalledConfig({
      home,
      env: { ...options.env, OMNICODEX_HOSTED_CONFIG_PATH: path },
    });
    expect(selected.binding).toBe(second.binding);
    expect(selected.binding).not.toBe(config.binding);
    expect(
      (
        await loadInstalledConfig({
          ...secondOptions,
          env: { ...options.env, OMNICODEX_HOSTED_CONFIG_PATH: defaultPath },
        })
      ).binding,
    ).toBe(second.binding);
    expect(await loadInstalledConfig(defaults)).toEqual(config);
  });

  it("never merges partial registration overrides, including empty/undefined fields", async () => {
    const { options } = await fixture();
    await installConfig(config, options);
    for (const value of ["synthetic-other", "", undefined]) {
      await expect(
        loadInstalledConfig({
          ...options,
          env: { ...options.env, OMNICODEX_HOSTED_OAUTH_CLIENT_ID: value },
        }),
      ).rejects.toThrow(/Partial/);
    }
    expect(
      (
        await loadInstalledConfig({
          ...options,
          env: { ...options.env, OMNICODEX_HOSTED_LOG: "1" },
        })
      ).logging,
    ).toBe(true);
    await expect(
      loadInstalledConfig({ ...options, env: { ...options.env, OMNICODEX_HOSTED_LOG: "yes" } }),
    ).rejects.toThrow(/LOG/);
  });

  it("allows only a full explicit validated environment to bypass a missing/malformed file", async () => {
    const { options } = await fixture();
    expect(await loadInstalledConfig({ ...options, env: registrationEnv })).toEqual(config);
    await installConfig(config, options);
    await writeFile(options.configPath, "synthetic-malformed-json", { mode: 0o600 });
    expect(await loadInstalledConfig({ ...options, env: registrationEnv })).toEqual(config);
    await expect(
      loadInstalledConfig({
        ...options,
        env: {
          ...registrationEnv,
          OMNICODEX_HOSTED_OAUTH_TOKEN_URL: "http://unsafe.example.invalid",
        },
      }),
    ).rejects.toThrow(/Invalid/);
    await expect(loadInstalledConfig(options)).rejects.toThrow(/malformed/);
  });

  it("fails closed on missing configuration without creating state or falling back", async () => {
    const { options, home } = await fixture();
    await expect(loadInstalledConfig(options)).rejects.toThrow(/setup\.mjs/);
    expect(await readdir(home)).toEqual([]);
    await expect(
      loadInstalledConfig({
        ...options,
        env: { ...options.env, OMNICODEX_HOSTED_CONFIG_PATH: "" },
        configPath: undefined,
      }),
    ).rejects.toThrow(/absolute/);
  });

  it("rejects malformed versions, extra/secret fields, missing fields, invalid values and arrays", async () => {
    const { options } = await fixture();
    await installConfig(config, options);
    const original = JSON.parse(await readFile(options.configPath, "utf8"));
    const missing = { ...original.registration };
    delete missing.clientId;
    for (const document of [
      [],
      null,
      { ...original, version: 2 },
      { ...original, token: "synthetic-forbidden" },
      {
        ...original,
        registration: { ...original.registration, clientSecret: "synthetic-forbidden" },
      },
      { version: 1, registration: missing },
      { ...original, registration: { ...original.registration, clientId: 1 } },
      {
        ...original,
        registration: {
          ...original.registration,
          tokenUrl: "https://user:pass@example.invalid/token",
        },
      },
    ]) {
      await writeFile(options.configPath, JSON.stringify(document), { mode: 0o600 });
      await expect(loadInstalledConfig(options)).rejects.toThrow();
    }
    await writeFile(options.configPath, "x".repeat(65_537));
    await expect(loadInstalledConfig(options)).rejects.toThrow(/unsafe/);
  });

  it("does not overwrite existing files, even when two setup processes race", async () => {
    const { options } = await fixture();
    const other = loadConfig({
      ...registrationEnv,
      OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "synthetic-racing-client",
    });
    const results = await Promise.allSettled([
      installConfig(config, options),
      installConfig(other, options),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const original = await readFile(options.configPath, "utf8");
    await expect(installConfig(other, options)).rejects.toThrow(/not overwritten/);
    expect(await readFile(options.configPath, "utf8")).toBe(original);
    expect(await readdir(dirname(options.configPath))).toEqual(["synthetic.json"]);
    expect([config.binding, other.binding]).toContain((await loadInstalledConfig(options)).binding);
  });

  it("rejects source, outside-user, relative and aliased package paths before writing", async () => {
    const { home, options } = await fixture();
    const sourceRoot = join(home, "synthetic-package");
    await mkdir(sourceRoot);
    const alias = join(home, "package-alias");
    await symlink(sourceRoot, alias, process.platform === "win32" ? "junction" : "dir");
    for (const configPath of [
      "relative.json",
      join(sourceRoot, "config", "registration.json"),
      join(alias, "config", "registration.json"),
      join(home, "..", "outside-user", "registration.json"),
      join(home, "registration.json"),
      join(home, "config", "oauth.dpapi"),
    ]) {
      await expect(installConfig(config, { ...options, sourceRoot, configPath })).rejects.toThrow();
    }
    expect(await readdir(sourceRoot)).toEqual([]);
  });

  it("rejects hardlinked configuration and unsafe existing POSIX permissions", async () => {
    const { home, options } = await fixture();
    await installConfig(config, options);
    const outside = join(home, "unrelated-synthetic.json");
    await link(options.configPath, outside);
    await expect(loadInstalledConfig(options)).rejects.toThrow(/unsafe/);
    await rm(outside);
    if (process.platform !== "win32") {
      await chmod(options.configPath, 0o644);
      await expect(loadInstalledConfig(options)).rejects.toThrow(/unsafe/);
      await chmod(options.configPath, 0o600);
      await chmod(dirname(options.configPath), 0o755);
      await expect(loadInstalledConfig(options)).rejects.toThrow(/unsafe/);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "rejects valid JSON with inherited Windows ACLs instead of accepting shared configuration",
    async () => {
      const { options } = await fixture();
      await installConfig(config, options);
      const inheritedPath = join(dirname(options.configPath), "inherited.json");
      await writeFile(inheritedPath, await readFile(options.configPath, "utf8"));
      await expect(loadInstalledConfig({ ...options, configPath: inheritedPath })).rejects.toThrow(
        /unsafe/,
      );
      expect(await loadInstalledConfig(options)).toEqual(config);
    },
  );

  it("accepts one explicit config argument and rejects ambiguous/unknown CLI arguments", () => {
    expect(configPathArgument([])).toBeUndefined();
    expect(configPathArgument(["--config", "synthetic.json"])).toBe("synthetic.json");
    for (const argv of [
      ["--config"],
      ["--config", ""],
      ["--unknown", "synthetic.json"],
      ["--config", "a.json", "--config", "b.json"],
    ])
      expect(() => configPathArgument(argv)).toThrow(/Usage/);
  });
});

describe("recipient-friendly setup wizard", () => {
  it("prints verified official docs, distinguishes server auth from hosted client approval, and stops without approval", async () => {
    const { options, home } = await fixture();
    const ask = questions(["", "n"]);
    const write = vi.fn();
    const openLink = vi.fn();
    expect(await runSetup({ ask, write, openLink, options })).toMatchObject({
      installed: false,
      reason: "provider_approval_required",
    });
    const output = write.mock.calls.flat().join("\n");
    expect(officialGuides.map((guide: { url: string }) => guide.url)).toEqual([
      "https://developers.openai.com/plugins/deploy/connect-chatgpt",
      "https://developers.openai.com/plugins/build/auth",
      "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization",
    ]);
    for (const guide of officialGuides) expect(output).toContain(guide.url);
    expect(output).toContain("UNVERIFIED");
    expect(output).toContain("No verified self-service");
    expect(output).toContain("Never enter a password");
    expect(openLink).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(await readdir(home)).toEqual([]);
  });

  it("opens only the exact guide explicitly selected, never arbitrary user URLs", async () => {
    const { options } = await fixture();
    const openLink = vi.fn(async () => {});
    await runSetup({ ask: questions(["2", "n"]), write: vi.fn(), openLink, options });
    expect(openLink).toHaveBeenCalledExactlyOnceWith(officialGuides[1].url);
    for (const choice of ["yes", "https://untrusted.example.invalid", "0", "4", ""]) {
      openLink.mockClear();
      await runSetup({ ask: questions([choice, "n"]), write: vi.fn(), openLink, options });
      expect(openLink).not.toHaveBeenCalled();
    }
    await expect(openOfficialGuide("https://untrusted.example.invalid")).rejects.toThrow(/Only/);
  });

  it("requires an independently owned hosted registration before collecting fields", async () => {
    const { options, home } = await fixture();
    const ask = questions(["", "yes", "no"]);
    expect(await runSetup({ ask, write: vi.fn(), options })).toMatchObject({
      installed: false,
      reason: "hosted_registration_required",
    });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(await readdir(home)).toEqual([]);
  });

  it("prompts for exactly nine nonsecret fields and saves only after explicit confirmation", async () => {
    const { options } = await fixture();
    const ask = questions(["", "yes", "yes", ...fields, "yes"]);
    const write = vi.fn();
    const openLink = vi.fn();
    expect(await runSetup({ ask, write, openLink, options })).toMatchObject({
      installed: true,
      path: options.configPath,
    });
    expect(ask).toHaveBeenCalledTimes(13);
    expect(await loadInstalledConfig(options)).toEqual(config);
    expect(openLink).not.toHaveBeenCalled();
    const output = write.mock.calls.flat().join("\n");
    expect(output).toContain("oauth-login.mjs");
    expect(output).toContain("stdio.mjs");
    expect(output).toContain("SAME path");
    expect(await readdir(dirname(options.configPath))).toEqual(["synthetic.json"]);
  });

  it("validates with loadConfig before writing and allows cancellation", async () => {
    const { options, home } = await fixture();
    const invalid = [...fields];
    invalid[2] = "http://unsafe.example.invalid/token";
    expect(
      await runSetup({ ask: questions(["", "y", "y", ...invalid, "n"]), write: vi.fn(), options }),
    ).toMatchObject({ installed: false, reason: "invalid_registration" });
    expect(await readdir(home)).toEqual([]);
    expect(
      await runSetup({ ask: questions(["", "y", "y", ...fields, "n"]), write: vi.fn(), options }),
    ).toMatchObject({ installed: false, reason: "cancelled" });
    expect(await readdir(home)).toEqual([]);
  });

  it("never silently replaces a registration or imports partial environment registration", async () => {
    const { options } = await fixture();
    const ask = vi.fn();
    await expect(
      runSetup({
        ask,
        options: {
          ...options,
          env: { ...options.env, OMNICODEX_HOSTED_OAUTH_CLIENT_ID: "synthetic-env" },
        },
      }),
    ).rejects.toThrow(/Unset all nine/);
    await installConfig(config, options);
    await expect(runSetup({ ask, options })).rejects.toThrow(/not overwritten/);
    expect(ask).not.toHaveBeenCalled();
    expect(await loadInstalledConfig(options)).toEqual(config);
  });

  it("makes both runtime entrypoints fail closed on the selected missing/malformed file before OAuth or hosted calls", async () => {
    const { options } = await fixture();
    const execute = promisify(execFile);
    for (const script of ["oauth-login.mjs", "stdio.mjs"]) {
      const result = await execute(
        process.execPath,
        [fileURLToPath(new URL(script, runtime)), "--config", options.configPath],
        {
          env: scriptEnvironment(options.configPath),
          windowsHide: true,
          timeout: 10_000,
        },
      ).then(
        () => {
          throw new Error("Unexpected runtime startup");
        },
        (error) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("setup.mjs");
    }
    await installConfig(config, options);
    await writeFile(options.configPath, "malformed-synthetic-registration", { mode: 0o600 });
    for (const script of ["oauth-login.mjs", "stdio.mjs"]) {
      const result = await execute(process.execPath, [fileURLToPath(new URL(script, runtime))], {
        env: scriptEnvironment(options.configPath),
        windowsHide: true,
        timeout: 10_000,
      }).then(
        () => {
          throw new Error("Unexpected runtime startup");
        },
        (error) => error,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("setup.mjs");
    }
  });
});
