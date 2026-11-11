import { createHash } from "node:crypto";

const prefix = "OMNICODEX_HOSTED_";
const identifier = /^[A-Za-z0-9_-]{1,256}$/;
const configurations = new WeakSet();

export function assertConfig(config) {
  if (!configurations.has(config)) throw new Error("Use a complete validated hosted registration.");
}

function required(env, name) {
  const value = env[prefix + name];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`Set ${prefix}${name} to your own registration value.`);
  }
  return value;
}

function httpsEndpoint(value, name) {
  if (!/^[\x21-\x7e]+$/.test(value))
    throw new Error(`Invalid ${name}; whitespace/control characters are forbidden.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}; an explicit HTTPS URL is required.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}; credentials, query strings and fragments are forbidden.`);
  }
  return url.href;
}

export function loadConfig(env = process.env) {
  const config = {};
  for (const [key, name] of Object.entries({
    clientId: "OAUTH_CLIENT_ID",
    workspaceId: "WORKSPACE_ID",
    connectorId: "CONNECTOR_ID",
    linkId: "LINK_ID",
  })) {
    const value = required(env, name);
    if (!identifier.test(value)) throw new Error(`Invalid ${prefix}${name}.`);
    config[key] = value;
  }
  config.authorizationUrl = httpsEndpoint(
    required(env, "OAUTH_AUTHORIZATION_URL"),
    "authorization URL",
  );
  config.tokenUrl = httpsEndpoint(required(env, "OAUTH_TOKEN_URL"), "token URL");
  config.endpoint = httpsEndpoint(required(env, "MCP_ENDPOINT"), "MCP endpoint");
  const callbackValue = required(env, "OAUTH_CALLBACK_URL");
  let callback;
  try {
    callback = new URL(callbackValue);
  } catch {
    throw new Error("Invalid OAuth callback URL.");
  }
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    !callback.port ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    !/^\/[A-Za-z0-9/_-]+$/.test(callback.pathname) ||
    callback.href !== callbackValue
  ) {
    throw new Error("OAuth callback must be an exact http://127.0.0.1:PORT/path URL.");
  }
  config.callbackUrl = callback.href;
  const scopes = required(env, "OAUTH_SCOPES");
  if (!/^[A-Za-z0-9._:/-]+(?: [A-Za-z0-9._:/-]+)*$/.test(scopes)) {
    throw new Error("Invalid OAuth scope list.");
  }
  const scopeSet = new Set(scopes.split(" "));
  if (!scopeSet.has("openid") || !scopeSet.has("offline_access")) {
    throw new Error("OAuth scopes must include openid and offline_access.");
  }
  config.scopes = [...scopeSet].sort().join(" ");
  const logging = env[`${prefix}LOG`] ?? "0";
  if (logging !== "0" && logging !== "1") throw new Error("OMNICODEX_HOSTED_LOG must be 0 or 1.");
  // Bind encrypted credentials to the entire registration, not just the workspace.
  config.binding = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  config.logging = logging === "1";
  configurations.add(config);
  return Object.freeze(config);
}
