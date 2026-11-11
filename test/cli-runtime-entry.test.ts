import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("shows CLI help without resolving a data directory at import time", async () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["LOCALAPPDATA", "OMNICODEX_DATA_DIR", "SYSTEMROOT"].includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--help"],
    { windowsHide: true, shell: false, env },
  );
  expect(result.stdout).toContain("Authenticated MCP access");
  expect(result.stderr).not.toContain("LOCALAPPDATA");
});

it("initializes runtime timeout constants before parsing the real CLI entry point", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-cli-entry-"));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "runtime", "call", "unused", "--timeout", "1000", "--help"],
      {
        windowsHide: true,
        shell: false,
        env: { ...process.env, LOCALAPPDATA: root },
      },
    );
    expect(result.stdout).toContain("runtime call");
    expect(result.stderr).not.toContain("before initialization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
