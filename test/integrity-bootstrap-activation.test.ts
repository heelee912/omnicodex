import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("internal integrity bootstrap activation ordering", () => {
  it("repairs a legacy config inside the daemon before durable signed state opens", async () => {
    const source = await readFile(new URL("src/daemon.ts", root), "utf8");
    const ensure = source.indexOf("await ensureOmniCodexInternalIntegrityKeys()");
    const schedules = source.indexOf("await DirectScheduleStore.open(");
    const events = source.indexOf("DurableMcpEventStore.open(");

    expect(ensure).toBeGreaterThanOrEqual(0);
    expect(schedules).toBeGreaterThan(ensure);
    expect(events).toBeGreaterThan(ensure);
    expect(source).not.toContain("await loadOmniCodexInternalIntegrityKeys()");
  });

  it("commits the bootstrap before every direct daemon process activation", async () => {
    const source = await readFile(new URL("src/cli.ts", root), "utf8");
    const block = sourceBlock(
      source,
      "async function launchDaemon(",
      "async function launchThroughScheduledTaskWhenEnabled(",
    );

    expect(block.indexOf("await ensureInternalIntegrityKeysInitialized();")).toBeGreaterThanOrEqual(
      0,
    );
    expect(block.indexOf("child = spawnHidden(")).toBeGreaterThan(
      block.indexOf("await ensureInternalIntegrityKeysInitialized();"),
    );
  });

  it("commits the bootstrap before triggering the independent Scheduled Task", async () => {
    const source = await readFile(new URL("src/cli.ts", root), "utf8");
    const block = sourceBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled(",
      "async function waitForDaemon(",
    );
    const preparation =
      /await\s+withDaemonLifecycleLock\(ensureInternalIntegrityKeysInitialized,\s*\{\s*waitOnContention:\s*true,?\s*\}\s*\);/u.exec(
        block,
      );
    const ensure = preparation?.index ?? -1;
    const launch = block.indexOf("await manager.launch();");

    expect(ensure).toBeGreaterThanOrEqual(0);
    expect(launch).toBeGreaterThan(ensure);
  });

  it("migrates before a release snapshot can capture legacy keyless config", async () => {
    const source = await readFile(new URL("src/cli.ts", root), "utf8");
    const block = sourceBlock(source, "async function createReleaseController(", "function emit(");
    const ensure = block.indexOf("await ensureInternalIntegrityKeysInitialized();");
    const snapshots = block.indexOf("new LocalReleaseStateSnapshots(dataDirectory)");
    const activation = block.indexOf("await launchDaemon(active.daemonScript");

    expect(ensure).toBeGreaterThanOrEqual(0);
    expect(snapshots).toBeGreaterThan(ensure);
    expect(activation).toBeGreaterThan(snapshots);
  });

  it("migrates before autostart installation, manual test, or scheduled launch", async () => {
    const source = await readFile(new URL("src/cli.ts", root), "utf8");
    const block = sourceBlock(source, "const autostart = program", "const auth = program");
    const activationGuard = block.indexOf(
      'action === "enable" || action === "test" || action === "launch"',
    );
    const ensure = block.indexOf(
      "await withDaemonLifecycleLock(ensureInternalIntegrityKeysInitialized);",
      activationGuard,
    );
    const action = block.indexOf("await manager[action]();", ensure);

    expect(activationGuard).toBeGreaterThanOrEqual(0);
    expect(ensure).toBeGreaterThan(activationGuard);
    expect(action).toBeGreaterThan(ensure);
  });
});
