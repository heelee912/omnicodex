import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeReleasePackageDigest,
  NpmReleaseSource,
  NpmReleaseValidator,
  type ReleaseCommandRunner,
} from "../src/infrastructure/release/npm-release-source.js";

const temporaryDirectories: string[] = [];
const sourceCommit = "1".repeat(40);
const repository = "https://github.com/heelee912/omnicodex";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("NpmReleaseSource", () => {
  it("stages an exact no-script npm package with integrity, provenance, signature audit, and SBOM", async () => {
    const dataDirectory = await temporaryDirectory();
    const npmCliScript = join(dataDirectory, "npm-cli.js");
    await writeFile(npmCliScript, "// fixture", "utf8");
    const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const runner = fixtureRunner("1.2.3", integrity);
    const source = new NpmReleaseSource({
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: sourceCommit,
      runner,
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, sourceCommit),
    });

    const staged = await source.stage("1.2.3");
    expect(staged).toMatchObject({
      version: "1.2.3",
      integrity,
      sourceCommit,
      provenanceAvailable: true,
    });
    expect(await readFile(join(staged.releasePath, "dist", "cli.js"), "utf8")).toContain("cli");
    expect(runner.calls.some((args) => args.includes("--ignore-scripts"))).toBe(true);
    expect(runner.calls.some((args) => args.includes("signatures"))).toBe(true);
    expect(runner.calls.some((args) => args.includes("sbom"))).toBe(true);
  });

  it("runs candidate checks and reuses one real runtime probe across three gates", async () => {
    const dataDirectory = await temporaryDirectory();
    const releasePath = join(dataDirectory, "release");
    await mkdir(join(releasePath, "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(releasePath, "dist", "cli.js"), "// cli", "utf8"),
      writeFile(join(releasePath, "dist", "daemon.js"), "// daemon", "utf8"),
      writeFile(
        join(releasePath, "package.json"),
        JSON.stringify({ name: "@heelee912/omnicodex", version: "1.2.3" }),
        "utf8",
      ),
    ]);
    const packageDigest = await computeReleasePackageDigest(releasePath);
    await writeFile(
      join(releasePath, ".omnicodex-release.json"),
      JSON.stringify({
        schemaVersion: 3,
        packageName: "@heelee912/omnicodex",
        version: "1.2.3",
        integrity: "sha512-Zml4dHVyZQ==",
        sourceCommit,
        provenanceUrl: "https://registry.npmjs.org/-/npm/v1/attestations/demo",
        signatureAuditPassed: true,
        sbomDigest: "a".repeat(64),
        packageDigest,
        cliScript: "dist/cli.js",
        daemonScript: "dist/daemon.js",
      }),
      "utf8",
    );
    const calls: string[][] = [];
    const runner: ReleaseCommandRunner = {
      run: async (_executable, args) => {
        calls.push([...args]);
        const stdout = args.includes("probe")
          ? JSON.stringify({
              ok: true,
              protectedFilesUnchanged: true,
              unknownModelEffectCount: 0,
              fullToolCount: 12,
              uniqueToolNames: 12,
              readTool: "read",
            })
          : args.includes("status")
            ? JSON.stringify({ configured: true })
            : "help";
        return { code: 0, stdout: `${stdout}\n`, stderr: "" };
      },
    };
    const staged = {
      version: "1.2.3",
      releasePath,
      integrity: "sha512-Zml4dHVyZQ==",
      sourceCommit,
      provenanceAvailable: true,
      sbomDigest: "a".repeat(64),
      packageDigest,
    };
    const validator = new NpmReleaseValidator({ dataDirectory, runner });
    await validator.runSelfChecks(staged);
    await validator.dryRunStateMigration(staged);
    await validator.runGuardSelfTest(staged);
    await validator.runProtocolContractTests(staged);
    await validator.runShadowRuntimeProbe(staged);
    expect(calls.filter((args) => args.includes("probe"))).toHaveLength(1);
  });

  it("rejects provenance that names a different Git commit before package activation", async () => {
    const dataDirectory = await temporaryDirectory();
    const npmCliScript = join(dataDirectory, "npm-cli.js");
    await writeFile(npmCliScript, "// fixture", "utf8");
    const integrity = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
    const source = new NpmReleaseSource({
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: sourceCommit,
      runner: fixtureRunner("1.2.3", integrity),
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, sourceCommit, "2".repeat(40)),
    });

    await expect(source.stage("1.2.3")).rejects.toThrow("expected GitHub commit");
  });

  it("rejects an npm signature audit that reports an invalid package signature", async () => {
    const dataDirectory = await temporaryDirectory();
    const npmCliScript = join(dataDirectory, "npm-cli.js");
    await writeFile(npmCliScript, "// fixture", "utf8");
    const integrity = `sha512-${Buffer.alloc(64, 11).toString("base64")}`;
    const source = new NpmReleaseSource({
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: sourceCommit,
      runner: fixtureRunner("1.2.3", integrity, { invalid: [{ name: "dependency" }], missing: [] }),
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, sourceCommit),
    });

    await expect(source.stage("1.2.3")).rejects.toThrow("signature audit");
  });

  it("never reuses a retained version staged from a different source commit", async () => {
    const dataDirectory = await temporaryDirectory();
    const npmCliScript = join(dataDirectory, "npm-cli.js");
    await writeFile(npmCliScript, "// fixture", "utf8");
    const integrity = `sha512-${Buffer.alloc(64, 13).toString("base64")}`;
    const first = new NpmReleaseSource({
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: sourceCommit,
      runner: fixtureRunner("1.2.3", integrity),
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, sourceCommit),
    });
    await first.stage("1.2.3");
    const second = new NpmReleaseSource({
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: "2".repeat(40),
      runner: fixtureRunner("1.2.3", integrity),
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, "2".repeat(40)),
    });

    await expect(second.stage("1.2.3")).rejects.toThrow("retained release");
  });

  it("rechecks registry provenance and package bytes before reusing a retained release", async () => {
    const dataDirectory = await temporaryDirectory();
    const npmCliScript = join(dataDirectory, "npm-cli.js");
    await writeFile(npmCliScript, "// fixture", "utf8");
    const integrity = `sha512-${Buffer.alloc(64, 17).toString("base64")}`;
    const options = {
      dataDirectory,
      npmCliScript,
      expectedSourceCommit: sourceCommit,
      runner: fixtureRunner("1.2.3", integrity),
      fetchImplementation: fixtureRegistryFetch("1.2.3", integrity, sourceCommit),
    };
    const staged = await new NpmReleaseSource(options).stage("1.2.3");
    await writeFile(join(staged.releasePath, "dist", "cli.js"), "// tampered", "utf8");

    await expect(new NpmReleaseSource(options).stage("1.2.3")).rejects.toThrow("retained release");
  });
});

function fixtureRunner(
  version: string,
  integrity: string,
  signatureAudit: Record<string, unknown> = { invalid: [], missing: [] },
): ReleaseCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_executable, args) => {
      calls.push([...args]);
      const prefix = args[args.indexOf("--prefix") + 1] as string;
      if (args.includes("install")) {
        const packageRoot = join(prefix, "node_modules", "@heelee912", "omnicodex");
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await Promise.all([
          writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: "@heelee912/omnicodex", version }),
            "utf8",
          ),
          writeFile(join(packageRoot, "dist", "cli.js"), "// cli", "utf8"),
          writeFile(join(packageRoot, "dist", "daemon.js"), "// daemon", "utf8"),
          writeFile(
            join(prefix, "package-lock.json"),
            JSON.stringify({
              packages: {
                "node_modules/@heelee912/omnicodex": { version, integrity },
              },
            }),
            "utf8",
          ),
        ]);
      }
      return {
        code: 0,
        stdout: args.includes("sbom")
          ? JSON.stringify({ bomFormat: "CycloneDX" })
          : args.includes("signatures")
            ? JSON.stringify(signatureAudit)
            : "{}",
        stderr: "",
      };
    },
  };
}

function fixtureRegistryFetch(
  version: string,
  integrity: string,
  commit: string,
  provenanceCommit = commit,
): typeof fetch {
  return async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    if (url.pathname.startsWith("/-/npm/v1/attestations/")) {
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          {
            name: `pkg:npm/%40heelee912/omnicodex@${version}`,
            digest: { sha512: Buffer.from(integrity.slice(7), "base64").toString("hex") },
          },
        ],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            externalParameters: { workflow: { repository } },
            resolvedDependencies: [
              {
                uri: `git+${repository}.git@refs/tags/v${version}`,
                digest: { gitCommit: provenanceCommit },
              },
            ],
          },
        },
      };
      return new Response(
        JSON.stringify({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: {
                mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
                verificationMaterial: { tlogEntries: [{}] },
                dsseEnvelope: {
                  payloadType: "application/vnd.in-toto+json",
                  payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
                  signatures: [{ sig: "fixture" }],
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        name: "@heelee912/omnicodex",
        version,
        gitHead: commit,
        repository: { type: "git", url: `git+${repository}.git` },
        dist: {
          integrity,
          attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/demo" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-npm-release-"));
  temporaryDirectories.push(directory);
  return directory;
}
