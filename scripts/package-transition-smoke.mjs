import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseTransitionController } from "../dist/application/release-transition-controller.js";
import {
  LocalReleasePointer,
  LocalReleaseStateSnapshots,
} from "../dist/infrastructure/release/local-release-runtime.js";
import { computeReleasePackageDigest } from "../dist/infrastructure/release/npm-release-source.js";
import { StableReleaseLauncher } from "../dist/infrastructure/release/stable-release-launcher.js";

const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-package-transition-"));
const events = [];
try {
  await mkdir(join(dataDirectory, "secrets"), { recursive: true });
  await Promise.all([
    writeFile(join(dataDirectory, "config.json"), '{"schemaVersion":1,"marker":"before"}\n'),
    writeFile(join(dataDirectory, "secrets", "owner.bin"), "cipher-before"),
  ]);
  const oldReleasePath = await releaseFixture(dataDirectory, "1.2.2", false);
  const candidateReleasePath = await releaseFixture(dataDirectory, "1.2.3", true);
  const packageDigest = await computeReleasePackageDigest(candidateReleasePath);
  const staged = {
    version: "1.2.3",
    releasePath: candidateReleasePath,
    integrity: `sha512-${Buffer.alloc(64, 23).toString("base64")}`,
    sourceCommit: "1".repeat(40),
    provenanceAvailable: true,
    sbomDigest: "2".repeat(64),
    packageDigest,
  };
  const launcher = new StableReleaseLauncher({ dataDirectory });
  await launcher.ensureBootstrap(join(oldReleasePath, "dist", "cli.js"), "1.2.2");
  const snapshots = new LocalReleaseStateSnapshots(dataDirectory);
  const pointer = new LocalReleasePointer({
    dataDirectory,
    launcher,
    deactivate: async () => void events.push("daemon:deactivate"),
    restoreState: async (snapshotId) => {
      events.push(`state:restore:${snapshotId}`);
      await snapshots.restore(snapshotId);
    },
    activate: async (active) => void events.push(`daemon:activate:${active.version}:draining`),
  });
  await pointer.markHealthy({
    version: "1.2.2",
    releasePath: oldReleasePath,
    stateSnapshotId: "bootstrap",
  });
  const controller = new ReleaseTransitionController({
    source: {
      stage: async () => staged,
      discard: async () => void events.push("candidate:discard"),
    },
    validator: {
      verifyPackageIdentity: async () => verifyCandidate(candidateReleasePath, packageDigest),
      verifyRegistryIntegrity: async () => verifyCandidate(candidateReleasePath, packageDigest),
      verifySignatureAndProvenance: async () => undefined,
      verifySbomAssociation: async () => undefined,
      runSelfChecks: async () => undefined,
      dryRunStateMigration: async () => undefined,
      runGuardSelfTest: async () => undefined,
      runProtocolContractTests: async () => undefined,
      runShadowRuntimeProbe: async () => undefined,
    },
    snapshots,
    drain: {
      begin: async () => void events.push("admission:draining"),
      awaitDrained: async () => void events.push("admission:drained"),
      resume: async () => void events.push("admission:open"),
    },
    pointer,
    observation: {
      observe: async (releasePath) => {
        const active = await pointer.current();
        if (active?.releasePath !== releasePath) throw new Error("Observed pointer mismatch");
        events.push(`observe:${active.version}`);
      },
    },
  });

  const updated = await controller.update("1.2.3");
  await Promise.all([
    writeFile(join(dataDirectory, "config.json"), '{"schemaVersion":1,"marker":"changed"}\n'),
    writeFile(join(dataDirectory, "secrets", "owner.bin"), "cipher-changed"),
  ]);
  const rolledBack = await controller.rollback("1.2.2");
  const restoredConfig = await readFile(join(dataDirectory, "config.json"), "utf8");
  const restoredSecret = await readFile(join(dataDirectory, "secrets", "owner.bin"), "utf8");
  const active = await pointer.current();
  if (
    updated.active.version !== "1.2.3" ||
    rolledBack.active.version !== "1.2.2" ||
    active?.version !== "1.2.2" ||
    !restoredConfig.includes('"marker":"before"') ||
    restoredSecret !== "cipher-before"
  ) {
    throw new Error("Package transition smoke did not restore the exact release and state");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      updateVersion: updated.active.version,
      rollbackVersion: rolledBack.active.version,
      packageDigest,
      stateRestored: true,
      secretCiphertextRestored: true,
      events,
      eventDigest: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
    })}\n`,
  );
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}

async function releaseFixture(dataDirectory, version, withManifest) {
  const releasePath = join(dataDirectory, "fixtures", version);
  await mkdir(join(releasePath, "dist"), { recursive: true });
  await Promise.all([
    writeFile(join(releasePath, "package.json"), JSON.stringify({ version })),
    writeFile(join(releasePath, "dist", "cli.js"), `// cli ${version}\n`),
    writeFile(join(releasePath, "dist", "daemon.js"), `// daemon ${version}\n`),
  ]);
  if (withManifest) {
    const packageDigest = await computeReleasePackageDigest(releasePath);
    await writeFile(
      join(releasePath, ".omnicodex-release.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        sourceCommit: "1".repeat(40),
        integrity: `sha512-${Buffer.alloc(64, 23).toString("base64")}`,
        packageDigest,
      })}\n`,
    );
  }
  return releasePath;
}

async function verifyCandidate(releasePath, expectedDigest) {
  const actualDigest = await computeReleasePackageDigest(releasePath);
  if (actualDigest !== expectedDigest) throw new Error("Candidate package digest changed");
}
