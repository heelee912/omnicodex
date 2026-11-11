import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig } from "./config.mjs";
import { stateFile, withCredentialLock, writePrivate } from "./state.mjs";

const helper = fileURLToPath(new URL("./windows-dpapi.ps1", import.meta.url));
const authClaim = "https://api.openai.com/auth";

export function protectSecret(operation, input) {
  if (
    process.platform !== "win32" ||
    !["protect", "unprotect"].includes(operation) ||
    !process.env.SystemRoot ||
    !isAbsolute(process.env.SystemRoot)
  ) {
    return Promise.reject(
      new Error("Windows CurrentUser DPAPI is required; no plaintext fallback is available."),
    );
  }
  return new Promise((resolve, reject) => {
    const executable = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const controller = new AbortController();
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        operation,
      ],
      {
        windowsHide: true,
        shell: false,
        signal: controller.signal,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Windows credential protection timed out."));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1_048_576) {
        controller.abort();
        reject(new Error("Windows credential protection returned invalid data."));
      }
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows credential protection could not start."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output) resolve(output);
      else reject(new Error("Windows credential protection failed."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function tokenClaims(token) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 131_072 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new Error();
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!claims || Array.isArray(claims) || typeof claims !== "object") throw new Error();
    return claims;
  } catch {
    throw new Error("OAuth response included an invalid access token.");
  }
}

function validSecret(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 131_072 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validateCredential(config, value) {
  assertConfig(config);
  if (
    !value ||
    value.binding !== config.binding ||
    value.accountId !== config.workspaceId ||
    !validSecret(value.accessToken) ||
    !validSecret(value.refreshToken) ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.refreshPending !== "boolean"
  ) {
    throw new Error("Stored OAuth credential does not match this registration; sign in again.");
  }
  const access = tokenClaims(value.accessToken);
  if (
    access[authClaim]?.chatgpt_account_id !== config.workspaceId ||
    !Number.isFinite(access.exp) ||
    value.expiresAt > access.exp * 1000
  ) {
    throw new Error("OAuth access token does not match the configured workspace or expiry.");
  }
  return value;
}

export function credentialFromTokens(config, tokens, previous) {
  assertConfig(config);
  const access = tokenClaims(tokens?.access_token);
  // The access token, never an unverified id_token, determines the resource workspace.
  if (access[authClaim]?.chatgpt_account_id !== config.workspaceId) {
    throw new Error("OAuth completed in a different workspace from the configured connector.");
  }
  const ttl = tokens.expires_in;
  if (!Number.isFinite(access.exp) || (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0))) {
    throw new Error("OAuth response included an invalid expiration.");
  }
  const expiresAt = Math.min(
    access.exp * 1000,
    ttl === undefined ? Infinity : Date.now() + ttl * 1000,
  );
  if (expiresAt <= Date.now()) throw new Error("OAuth access token is already expired.");
  if (previous) validateCredential(config, previous);
  return validateCredential(config, {
    binding: config.binding,
    accountId: config.workspaceId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt,
    refreshPending: false,
  });
}

export async function saveCredential(config, state, credential) {
  validateCredential(config, credential);
  const ciphertext = await protectSecret("protect", JSON.stringify(credential));
  await writePrivate(state, "oauth.dpapi", ciphertext);
}

export async function readCredential(config, state) {
  let plaintext;
  try {
    const ciphertext = await readFile(await stateFile(state, "oauth.dpapi"), "utf8");
    plaintext = await protectSecret("unprotect", ciphertext);
  } catch {
    throw new Error(
      "Encrypted OAuth credential is unavailable; run this connector's dedicated login.",
    );
  }
  let credential;
  try {
    credential = JSON.parse(plaintext);
  } catch {
    throw new Error("Encrypted OAuth credential is invalid; sign in again.");
  }
  return validateCredential(config, credential);
}

export async function requestTokens(config, parameters, fetcher = fetch, signal) {
  assertConfig(config);
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetcher(config.tokenUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...parameters, client_id: config.clientId }),
    });
  } catch {
    throw new Error("OAuth token request failed; it was not retried. Sign in again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OAuth token request failed (HTTP ${response.status}); sign in again.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("OAuth token endpoint returned invalid data; sign in again.");
  }
}

export function credentialProvider(config, state, { fetcher = fetch } = {}) {
  assertConfig(config);
  let pending;
  const obtain = () =>
    withCredentialLock(state, async () => {
      const stored = await readCredential(config, state);
      if (stored.refreshPending)
        throw new Error("Previous OAuth refresh has an uncertain outcome; sign in again.");
      if (stored.expiresAt > Date.now() + 180_000) return stored;
      // Persist the no-replay barrier BEFORE sending a possibly rotating refresh token.
      await saveCredential(config, state, { ...stored, refreshPending: true });
      const tokens = await requestTokens(
        config,
        {
          grant_type: "refresh_token",
          refresh_token: stored.refreshToken,
        },
        fetcher,
      );
      const renewed = credentialFromTokens(config, tokens, stored);
      await saveCredential(config, state, renewed);
      return renewed;
    });
  return () => {
    pending ??= obtain().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
