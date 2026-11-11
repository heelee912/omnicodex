import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import {
  assertNewConfig,
  configPathArgument,
  installConfig,
  registrationFields,
} from "./config-store.mjs";

// Official documentation only, checked at implementation time. None is a public-client provisioning URL.
export const officialGuides = Object.freeze([
  Object.freeze({
    title: "OpenAI: connect and test YOUR plugin in ChatGPT",
    url: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
  }),
  Object.freeze({
    title: "OpenAI: authentication for YOUR MCP server (not this bridge's client approval)",
    url: "https://developers.openai.com/plugins/build/auth",
  }),
  Object.freeze({
    title: "MCP: OAuth authorization and PKCE requirements",
    url: "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization",
  }),
]);

export async function openOfficialGuide(url) {
  if (!officialGuides.some((guide) => guide.url === url))
    throw new Error("Only the listed official documentation may be opened.");
  let executable;
  let args;
  if (process.platform === "win32") {
    if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))
      throw new Error("Open the printed documentation manually.");
    executable = join(process.env.SystemRoot, "System32", "rundll32.exe");
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    args = [url];
  } else {
    executable = "xdg-open";
    args = [url];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      signal: AbortSignal.timeout(10_000),
    });
    child.on("error", () =>
      reject(new Error("Browser could not open; use the printed official link manually.")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Browser could not open; use the printed official link manually.")),
    );
  });
}

const prompts = Object.freeze({
  clientId: "YOUR approved public/native OAuth client ID (not a client secret): ",
  authorizationUrl: "Authorization HTTPS URL supplied for YOUR approved app: ",
  tokenUrl: "Token HTTPS URL supplied for YOUR approved app: ",
  callbackUrl: "Exact registered loopback callback (http://127.0.0.1:PORT/path): ",
  scopes: "Approved space-separated scopes (include openid and offline_access): ",
  workspaceId: "YOUR workspace ID (access-token workspace, not display name): ",
  connectorId: "YOUR exact hosted connector ID (not display name): ",
  linkId: "YOUR exact connected link ID: ",
  endpoint: "Hosted MCP HTTPS endpoint approved for YOUR registration: ",
});

const yes = (value) => typeof value === "string" && /^(?:y|yes)$/i.test(value.trim());

export async function runSetup({
  ask,
  write = (text) => process.stdout.write(`${text}\n`),
  openLink = openOfficialGuide,
  options = {},
} = {}) {
  if (typeof ask !== "function")
    throw new Error("Interactive setup requires a terminal question handler.");
  const env = options.env ?? process.env;
  if (Object.values(registrationFields).some((name) => Object.hasOwn(env, name))) {
    throw new Error(
      "Unset all nine hosted registration environment fields before interactive setup; the wizard never imports environment registration values.",
    );
  }
  const target = await assertNewConfig(options);
  write("OmniCodex hosted MCP setup: YOUR app, YOUR workspace, YOUR connector and link.");
  write(
    "This wizard saves only nonsecret registration fields locally. Never enter a password, client secret, access/refresh token or authorization code here or in chat.",
  );
  write(
    "It does not create an OAuth app, perform login, call hosted services, or restart anything.",
  );
  officialGuides.forEach((guide, index) => {
    write(`${index + 1}. ${guide.title}\n${guide.url}`);
  });
  write(
    "The OpenAI guides explain adding YOUR MCP server to ChatGPT and server-side OAuth. They do NOT establish permission for an independent OAuth client to call the hosted resource used by this bridge.",
  );
  write(
    "Independent public-client support is UNVERIFIED. No verified self-service hosted OAuth app provisioning link is available here. Obtain YOUR OWN client approval, endpoints and hosted permissions from your provider/admin through its official support process. Do not borrow a first-party or someone else's client.",
  );
  const choice = (
    await ask(
      "Open one listed official guide in your browser? Enter 1, 2 or 3, or Enter for none: ",
    )
  ).trim();
  if (["1", "2", "3"].includes(choice)) {
    try {
      await openLink(officialGuides[Number(choice) - 1].url);
    } catch {
      write("Browser could not open. Use the printed official documentation manually.");
    }
  } else if (choice) {
    write("No valid guide selection; nothing was opened.");
  }
  if (
    !yes(
      await ask(
        "Do you already have provider approval for YOUR OWN independent public/native client, PKCE S256, refresh tokens and hosted connector permissions? [y/N]: ",
      ),
    )
  ) {
    write(
      "Stopped without saving. Request that approval first; if your provider does not support it, this hosted route cannot be used.",
    );
    return { installed: false, reason: "provider_approval_required" };
  }
  write(
    "Register/connect YOUR hosted OmniCodex2 MCP service in YOUR workspace using the provider's supported process. Record exact connector/link IDs, the resource endpoint and access-token workspace. The catalog must include codex__omnicodex__session_identity.",
  );
  if (
    !yes(
      await ask(
        "Have you completed YOUR OWN hosted registration and obtained those exact IDs (not copied or similarly named)? [y/N]: ",
      ),
    )
  ) {
    write("Stopped without saving. Complete your own hosted registration first.");
    return { installed: false, reason: "hosted_registration_required" };
  }
  let config;
  while (!config) {
    const registrationEnv = {};
    for (const [key, name] of Object.entries(registrationFields)) {
      registrationEnv[name] = (await ask(prompts[key])).trim();
    }
    try {
      config = loadConfig(registrationEnv);
    } catch {
      write(
        "Registration validation failed. Use nonempty IDs, credential-free HTTPS endpoints, an exact registered 127.0.0.1 HTTP callback with port/path, and scopes including openid and offline_access. No values were saved or echoed.",
      );
      if (!yes(await ask("Re-enter the nine nonsecret registration fields? [y/N]: ")))
        return { installed: false, reason: "invalid_registration" };
    }
  }
  write(`Private configuration destination: ${target}`);
  write(
    "Credentials will remain separate in Windows CurrentUser DPAPI storage. Existing configurations are never replaced.",
  );
  if (
    !yes(
      await ask(
        "Confirm all fields belong to YOUR approved app/registration and save this new configuration? [y/N]: ",
      ),
    )
  ) {
    write("Cancelled without saving.");
    return { installed: false, reason: "cancelled" };
  }
  const path = await installConfig(config, options);
  write(`Installed nonsecret registration configuration: ${path}`);
  write(
    "Next, explicitly run node scripts/connectors/hosted-mcp/oauth-login.mjs, then configure your MCP host to launch node with scripts/connectors/hosted-mcp/stdio.mjs (absolute script path). Both read this installed configuration automatically.",
  );
  write(
    "If you selected --config or OMNICODEX_HOSTED_CONFIG_PATH, supply that SAME path to login and the MCP host. Do not set partial registration environment overrides. No login or runtime was started by setup.",
  );
  return { installed: true, path };
}

export async function setupMain() {
  const configPath = configPathArgument();
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Setup requires an interactive terminal; automation should use all nine explicit registration environment fields.",
    );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runSetup({ ask: (question) => terminal.question(question), options: { configPath } });
  } finally {
    terminal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupMain().catch(() => {
    process.stderr.write(
      "Hosted setup did not complete. Use an interactive terminal, unset registration overrides, and choose a new private per-user --config path outside the package; existing registration files are never overwritten.\n",
    );
    process.exitCode = 1;
  });
}
