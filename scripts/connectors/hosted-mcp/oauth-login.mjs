import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { assertConfig } from "./config.mjs";
import { configPathArgument, loadInstalledConfig } from "./config-store.mjs";
import {
  credentialFromTokens,
  protectSecret,
  requestTokens,
  saveCredential,
} from "./oauth-credential.mjs";
import { prepareState, withCredentialLock } from "./state.mjs";

export function createOAuthAttempt(config, exchange) {
  assertConfig(config);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = new URL(config.callbackUrl);
  const authorize = new URL(config.authorizationUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: config.scopes,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    allowed_workspace_id: config.workspaceId,
  }).toString();
  let consumed = false;
  return {
    authorizationUrl: authorize.href,
    async handle({ method, host, url: target }) {
      const reject = {
        status: 400,
        message: "Invalid OAuth callback.",
        complete: false,
        success: false,
      };
      if (
        method !== "GET" ||
        host !== callback.host ||
        typeof target !== "string" ||
        !target.startsWith("/") ||
        target.startsWith("//") ||
        target.includes("#") ||
        target.split("?")[0] !== callback.pathname
      )
        return reject;
      let url;
      try {
        url = new URL(target, callback.origin);
      } catch {
        return reject;
      }
      if (url.origin !== callback.origin || url.pathname !== callback.pathname) return reject;
      const keys = [...url.searchParams.keys()];
      if (keys.length !== new Set(keys).size) return reject;
      const received = Buffer.from(url.searchParams.get("state") || "", "utf8");
      const expected = Buffer.from(state, "utf8");
      if (received.length !== expected.length || !timingSafeEqual(received, expected) || consumed)
        return reject;
      const code = url.searchParams.get("code");
      const error = url.searchParams.has("error");
      if (error || !code || code.length > 8192 || !/^[\x21-\x7e]+$/.test(code)) {
        consumed = true;
        return { ...reject, complete: true };
      }
      // Consume before any await; neither concurrent callbacks nor failed exchanges can replay a code.
      consumed = true;
      try {
        await exchange({ code, verifier, redirectUri: config.callbackUrl });
        return {
          status: 200,
          message: "OmniCodex hosted OAuth connected. You may close this tab.",
          complete: true,
          success: true,
        };
      } catch {
        return {
          status: 400,
          message: "OAuth setup failed. Run a new login attempt.",
          complete: true,
          success: false,
        };
      }
    },
  };
}

export async function runLogin(config) {
  config ??= await loadInstalledConfig({ configPath: configPathArgument() });
  // Check DPAPI before opening a listener or asking the recipient to authorize anything.
  await protectSecret("protect", "connector-protection-check");
  const state = await prepareState(config);
  await withCredentialLock(
    state,
    () =>
      new Promise((resolve, reject) => {
        let finished = false;
        let timer;
        let exchanging;
        const controller = new AbortController();
        const attempt = createOAuthAttempt(config, ({ code, verifier, redirectUri }) => {
          exchanging = (async () => {
            const tokens = await requestTokens(
              config,
              {
                grant_type: "authorization_code",
                code,
                code_verifier: verifier,
                redirect_uri: redirectUri,
              },
              fetch,
              controller.signal,
            );
            controller.signal.throwIfAborted();
            await saveCredential(config, state, credentialFromTokens(config, tokens));
          })();
          return exchanging;
        });
        const finish = async (success) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          controller.abort();
          server.close();
          server.closeAllConnections();
          // Keep the credential lock until any aborted exchange/write has actually settled.
          await exchanging?.catch(() => {});
          if (success) resolve();
          else
            reject(new Error("Hosted OAuth login failed or timed out. Start a new login attempt."));
        };
        const server = createServer(async (request, response) => {
          const result = await attempt.handle({
            method: request.method,
            host: request.headers.host,
            url: request.url,
          });
          response
            .writeHead(result.status, {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy": "default-src 'none'",
              "Referrer-Policy": "no-referrer",
              Connection: "close",
            })
            .end(result.message, () => {
              if (result.complete) void finish(result.success);
            });
        });
        server.headersTimeout = 10_000;
        server.requestTimeout = 15_000;
        server.on("error", () => {
          void finish(false);
        });
        timer = setTimeout(() => {
          void finish(false);
        }, 10 * 60_000);
        const callback = new URL(config.callbackUrl);
        server.listen(Number(callback.port), "127.0.0.1", () => {
          // Interactive setup output only: never sent to the optional connection audit log.
          process.stdout.write(
            `Open this URL in your browser for YOUR OAuth app and workspace:\n${attempt.authorizationUrl}\n`,
          );
        });
      }),
  );
  process.stdout.write("Hosted OAuth credential saved with Windows CurrentUser DPAPI.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLogin().catch(() => {
    process.stderr.write(
      "Hosted OAuth setup failed. Run node scripts/connectors/hosted-mcp/setup.mjs first; use the same --config path and unset partial registration overrides. Check your approved registration and Windows DPAPI state; no fallback login was used.\n",
    );
    process.exitCode = 1;
  });
}
