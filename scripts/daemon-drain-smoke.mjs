#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observeProtectedFile } from "../dist/infrastructure/safety/protected-file-snapshot.js";
import { spawnHidden } from "../dist/infrastructure/windows/hidden-child-process.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-live-drain-"));
const resolvedTemporary = resolve(dataDirectory);
const resolvedSystemTemporary = resolve(tmpdir());
const nestedTemporary = relative(resolvedSystemTemporary, resolvedTemporary);
if (
  nestedTemporary.length === 0 ||
  nestedTemporary.startsWith("..") ||
  isAbsolute(nestedTemporary) ||
  !resolvedTemporary.includes("omnicodex-live-drain-")
) {
  throw new Error("Refusing to use an unverified live-smoke directory");
}
const cliScript = join(repository, "dist", "cli.js");
const protectedTargets = [
  { logicalName: "codex-auth", path: join(process.env.USERPROFILE ?? "", ".codex", "auth.json") },
  {
    logicalName: "codex-config",
    path: join(process.env.USERPROFILE ?? "", ".codex", "config.toml"),
  },
];
const protectedBefore = await Promise.all(protectedTargets.map(observeProtectedFile));
let state;
try {
  await writeFile(
    join(dataDirectory, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectRoot: repository,
        gateway: {
          host: "127.0.0.1",
          port: 0,
          path: "/mcp",
          fullPath: "/mcp/full",
          allowedOrigins: [],
        },
        auth: {
          issuer: "https://shadow.invalid/",
          audience: "https://shadow.invalid/mcp",
          resource: "https://shadow.invalid/mcp",
          requiredScopes: ["omnicodex:full"],
          allowedSubjects: ["auth0|shadow-owner"],
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const start = await runHidden(process.execPath, [cliScript, "start", "--json"], {
    ...process.env,
    OMNICODEX_DATA_DIR: dataDirectory,
  });
  if (start.code !== 0) throw commandError("start", start);
  state = JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"));
  assertOwnedReadyState(state);

  const draining = await control(state, "begin-drain");
  if (draining.runtime?.admission !== "draining") throw new Error("drain admission did not close");
  const drained = await control(state, "await-drained", 10_000);
  if (drained.runtime?.activeMcpRequests !== 0) throw new Error("active MCP requests remained");
  const resumed = await control(state, "resume-admission");
  if (resumed.runtime?.admission !== "open") throw new Error("MCP admission did not reopen");

  const previousPid = state.pid;
  const restarted = await runHidden(
    process.execPath,
    [cliScript, "restart", "--drain-timeout", "10000", "--json"],
    {
      ...process.env,
      OMNICODEX_DATA_DIR: dataDirectory,
    },
  );
  if (restarted.code !== 0) throw commandError("restart", restarted);
  state = JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"));
  assertOwnedReadyState(state);
  if (state.pid === previousPid)
    throw new Error("restart did not replace the owned daemon process");

  const origin = `http://${state.address.host}:${state.address.port}`;
  const metadata = await fetch(
    `${origin}/.well-known/oauth-protected-resource${state.address.fullPath}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  const unauthorized = await fetch(`${origin}${state.address.fullPath}`, {
    headers: { Accept: "text/event-stream" },
    signal: AbortSignal.timeout(5_000),
  });
  if (metadata.status !== 200 || unauthorized.status !== 401) {
    throw new Error("protected MCP observation failed");
  }

  const stop = await runHidden(
    process.execPath,
    [cliScript, "stop", "--drain-timeout", "10000", "--json"],
    {
      ...process.env,
      OMNICODEX_DATA_DIR: dataDirectory,
    },
  );
  if (stop.code !== 0) throw commandError("stop", stop);
  const protectedAfter = await Promise.all(protectedTargets.map(observeProtectedFile));
  const protectedFilesUnchanged = protectedBefore.every((before, index) => {
    const after = protectedAfter[index];
    return (
      after !== undefined &&
      before.logicalName === after.logicalName &&
      before.status === after.status &&
      before.sha256 === after.sha256 &&
      before.sizeBytes === after.sizeBytes
    );
  });
  if (!protectedFilesUnchanged) throw new Error("Codex protected files changed during drain smoke");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      lifecycle: "stopped",
      releasePath: state.releasePath,
      drain: {
        admissionClosed: true,
        activeRequests: 0,
        admissionReopened: true,
        gracefulRestart: true,
        gracefulStop: true,
      },
      endpoint: { metadata: 200, unauthenticatedMcp: 401 },
      protectedFilesUnchanged,
      visibleConsoleCreated: false,
    })}\n`,
  );
} finally {
  if (state !== undefined) {
    await control(state, "stop").catch(() => undefined);
    await waitForControlClose(state, 5_000).catch(() => undefined);
  }
  await rm(resolvedTemporary, { recursive: true, force: true });
}

async function runHidden(executable, args, env) {
  const child = spawnHidden(executable, args, {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    if (stdout.length < 65_536) stdout += chunk.toString().slice(0, 65_536 - stdout.length);
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 65_536) stderr += chunk.toString().slice(0, 65_536 - stderr.length);
  });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return { code, stdout, stderr };
}

function control(state, command, timeoutMs) {
  return new Promise((resolveControl, rejectControl) => {
    const socket = connect(state.controlPipe);
    socket.setEncoding("utf8");
    let input = "";
    const timer = setTimeout(
      () => {
        socket.destroy();
        rejectControl(new Error(`control timeout: ${command}`));
      },
      (timeoutMs ?? 2_000) + 2_000,
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectControl(error);
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          command,
          token: state.controlToken,
          expectedPid: state.pid,
          expectedInstanceNonce: state.instanceNonce,
          expectedStartedAtUnixMs: state.startedAtUnixMs,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      const response = JSON.parse(input.slice(0, newline));
      if (
        response.pid !== state.pid ||
        response.instanceNonce !== state.instanceNonce ||
        response.startedAtUnixMs !== state.startedAtUnixMs ||
        response.ok !== true
      ) {
        rejectControl(new Error("control ownership proof failed"));
        return;
      }
      resolveControl(response);
    });
  });
}

async function waitForControlClose(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let closed = 0;
  while (Date.now() < deadline) {
    if (
      await control(state, "status").then(
        () => true,
        () => false,
      )
    )
      closed = 0;
    else closed += 1;
    if (closed >= 3) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("owned daemon control channel remained open");
}

function assertOwnedReadyState(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.lifecycle !== "ready" ||
    typeof value.pid !== "number" ||
    typeof value.instanceNonce !== "string" ||
    typeof value.controlToken !== "string" ||
    typeof value.controlPipe !== "string" ||
    typeof value.releasePath !== "string" ||
    value.address?.host !== "127.0.0.1" ||
    typeof value.address?.port !== "number"
  ) {
    throw new Error("daemon state did not prove an owned ready runtime");
  }
}

function commandError(operation, result) {
  const detail = (result.stderr || result.stdout).trim().slice(0, 2_048);
  return new Error(`${operation} failed (exit=${result.code})${detail ? `: ${detail}` : ""}`);
}
