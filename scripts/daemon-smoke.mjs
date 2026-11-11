import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import selfsigned from "selfsigned";

const execFileAsync = promisify(execFile);
const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-daemon-e2e-"));
const cliPath = resolve("dist/cli.js");
const certificate = await selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], {
  days: 1,
  keySize: 2048,
  extensions: [
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ],
});
const certificatePath = join(dataDirectory, "loopback-test-ca.pem");
await writeFile(certificatePath, certificate.cert, { encoding: "utf8", mode: 0o600 });
const environment = {
  ...process.env,
  OMNICODEX_DATA_DIR: dataDirectory,
  NODE_EXTRA_CA_CERTS: certificatePath,
};
const ownerSubject = "auth0|e2e-owner";
const audience = "https://omnicodex.invalid.example/mcp";
const resource = audience;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "omnicodex-e2e" };
const identityServer = createServer(
  { key: certificate.private, cert: certificate.cert },
  (request, response) => {
    if (request.url === "/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    response.writeHead(404).end();
  },
);
await new Promise((resolveListen, rejectListen) => {
  identityServer.once("error", rejectListen);
  identityServer.listen(0, "127.0.0.1", resolveListen);
});
const identityAddress = identityServer.address();
if (typeof identityAddress !== "object" || identityAddress === null) {
  throw new Error("Identity test server did not return an address");
}
const issuer = `https://127.0.0.1:${identityAddress.port}/`;
let started = false;

try {
  const initialized = await runCli([
    "init",
    "--issuer",
    issuer,
    "--audience",
    audience,
    "--resource",
    resource,
    "--subject",
    ownerSubject,
    "--jwks-uri",
    `${issuer}jwks.json`,
    "--root",
    process.cwd(),
    "--port",
    "0",
    "--json",
  ]);
  const state = await runCli(["start", "--json"], 240_000);
  started = true;
  if ("controlToken" in state || "controlPipe" in state) {
    throw new Error("Control secret leaked through CLI output");
  }
  const address = requireObject(state.address, "daemon address");
  const port = requireNumber(address.port, "daemon port");
  const metadataResponse = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`,
  );
  if (!metadataResponse.ok) throw new Error(`Metadata returned ${metadataResponse.status}`);
  const metadata = requireObject(await metadataResponse.json(), "protected resource metadata");
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (unauthorized.status !== 401) {
    throw new Error(`Unauthenticated MCP returned ${unauthorized.status}, expected 401`);
  }
  const accessToken = await new SignJWT({
    scope: "omnicodex:full",
    resource,
  })
    .setProtectedHeader({ alg: "RS256", kid: "omnicodex-e2e" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(ownerSubject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "omnicodex-auth-e2e", version: "1.0.0" });
  try {
    await client.connect(transport);
    const authenticatedTools = await client.listTools();
    if (authenticatedTools.tools.length !== 3) {
      throw new Error(
        `Authenticated compatibility surface returned ${authenticatedTools.tools.length} tools`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  const missingScopeToken = await signedToken({
    scope: "openid",
    resource,
    subject: ownerSubject,
  });
  const unapprovedOwnerToken = await signedToken({
    scope: "omnicodex:full",
    resource,
    subject: "auth0|not-the-owner",
  });
  const missingScopeStatus = await initializeStatus(port, missingScopeToken);
  const unapprovedOwnerStatus = await initializeStatus(port, unapprovedOwnerToken);
  if (missingScopeStatus !== 403 || unapprovedOwnerStatus !== 403) {
    throw new Error(
      `Authorization negatives returned scope=${missingScopeStatus}, owner=${unapprovedOwnerStatus}`,
    );
  }
  const status = await runCli(["status", "--json"]);
  const publicState = requireObject(status.state, "public daemon state");
  if (status.running !== true || "controlToken" in publicState || "controlPipe" in publicState) {
    throw new Error("Public status is unsafe or does not report the running daemon");
  }
  const runtime = requireObject(status.runtime, "runtime report");
  const candidates = Array.isArray(runtime.candidates) ? runtime.candidates : [];
  await runCli(["stop", "--json"], 60_000);
  started = false;
  const logs = await runCli(["logs", "--json"]);
  const entries = Array.isArray(logs.entries) ? logs.entries : [];
  const events = entries.flatMap((entry) => {
    const value = requireObject(entry, "operational log entry");
    return typeof value.event === "string" ? [value.event] : [];
  });
  for (const event of ["daemon_starting", "daemon_ready", "daemon_stopping", "daemon_stopped"]) {
    if (!events.includes(event)) throw new Error(`Missing operational event ${event}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      initSaved: initialized.ok === true,
      lifecycle: state.lifecycle,
      pid: state.pid,
      port,
      metadataResource: metadata.resource,
      unauthenticatedStatus: unauthorized.status,
      missingScopeStatus,
      unapprovedOwnerStatus,
      authenticatedMcpSession: true,
      statusRunning: status.running,
      runtimeFound: candidates.length > 0,
      daemonLifecycleOk: true,
      operationalEvents: events,
    })}\n`,
  );
} finally {
  if (started) await runCli(["stop", "--json"], 60_000).catch(() => undefined);
  await new Promise((resolveClose) => identityServer.close(resolveClose));
  await rm(dataDirectory, { force: true, recursive: true });
}

async function runCli(arguments_, timeout = 30_000) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout,
    windowsHide: true,
    shell: false,
  });
  return requireObject(JSON.parse(stdout.trim()), "CLI JSON response");
}

async function signedToken({ scope, resource, subject }) {
  return new SignJWT({ scope, resource })
    .setProtectedHeader({ alg: "RS256", kid: "omnicodex-e2e" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function initializeStatus(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "omnicodex-auth-negative", version: "1.0.0" },
      },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

function requireObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireNumber(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid ${label}`);
  return value;
}
