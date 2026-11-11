import { createHash } from "node:crypto";
import type { Auth0ManagementRequester } from "./auth0-management-provisioner.js";

export interface Auth0DcrClientJanitorOptions {
  readonly requester: Auth0ManagementRequester;
}

export interface Auth0DcrClientSummary {
  readonly clientId: string;
  readonly name: string;
  readonly appType?: string;
  readonly callbackOrigins: readonly string[];
  readonly firstParty: boolean;
  readonly tokenEndpointAuthMethod?: string;
  readonly likelyDisposableDcrClient: boolean;
  readonly fingerprint: string;
}

interface Auth0ClientRecord {
  readonly client_id?: unknown;
  readonly name?: unknown;
  readonly app_type?: unknown;
  readonly callbacks?: unknown;
  readonly is_first_party?: unknown;
  readonly token_endpoint_auth_method?: unknown;
}

/**
 * Lists only non-secret Auth0 client metadata and deletes a client only after
 * an exact fingerprint readback. This prevents a stale UI selection or reused
 * client id from deleting an unrelated tenant application.
 */
export class Auth0DcrClientJanitor {
  readonly #requester: Auth0ManagementRequester;

  constructor(options: Auth0DcrClientJanitorOptions) {
    this.#requester = options.requester;
  }

  async list(tenantOrigin: string): Promise<readonly Auth0DcrClientSummary[]> {
    const query = new URLSearchParams({
      page: "0",
      per_page: "100",
      include_totals: "true",
      fields: "client_id,name,app_type,callbacks,is_first_party,token_endpoint_auth_method",
      include_fields: "true",
    });
    const response = await this.#requester.request<unknown>(
      tenantOrigin,
      `/api/v2/clients?${query.toString()}`,
      { method: "GET" },
    );
    const records = clientRecords(response);
    return records
      .map(summarizeClient)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, "en-US") ||
          left.clientId.localeCompare(right.clientId),
      );
  }

  async deleteExact(
    tenantOrigin: string,
    clientId: string,
    expectedFingerprint: string,
  ): Promise<Auth0DcrClientSummary> {
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(clientId)) throw new Error("Invalid Auth0 client id");
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
      throw new Error("Expected client fingerprint must be a SHA-256 digest");
    }
    const record = await this.#requester.request<unknown>(
      tenantOrigin,
      `/api/v2/clients/${encodeURIComponent(clientId)}?fields=client_id%2Cname%2Capp_type%2Ccallbacks%2Cis_first_party%2Ctoken_endpoint_auth_method&include_fields=true`,
      { method: "GET" },
    );
    const summary = summarizeClient(record);
    if (summary.clientId !== clientId) throw new Error("Auth0 client readback id mismatch");
    if (summary.fingerprint !== expectedFingerprint) {
      throw new Error("Auth0 client changed after review; refusing deletion");
    }
    if (!summary.likelyDisposableDcrClient) {
      throw new Error("Auth0 client is not a bounded third-party DCR cleanup candidate");
    }
    await this.#requester.request<unknown>(
      tenantOrigin,
      `/api/v2/clients/${encodeURIComponent(clientId)}`,
      { method: "DELETE" },
    );
    return summary;
  }
}

function clientRecords(value: unknown): readonly Auth0ClientRecord[] {
  const records = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.clients)
      ? value.clients
      : undefined;
  if (records === undefined || !records.every(isObject)) {
    throw new Error("Auth0 returned invalid client metadata");
  }
  return records;
}

function summarizeClient(value: unknown): Auth0DcrClientSummary {
  if (!isObject(value)) throw new Error("Auth0 returned invalid client metadata");
  const record = value as Auth0ClientRecord;
  if (
    typeof record.client_id !== "string" ||
    !/^[A-Za-z0-9_-]{12,128}$/.test(record.client_id) ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    record.name.length > 256 ||
    (record.callbacks !== undefined &&
      (!Array.isArray(record.callbacks) ||
        !record.callbacks.every((item) => typeof item === "string")))
  ) {
    throw new Error("Auth0 returned invalid client metadata");
  }
  const callbacks = (record.callbacks ?? []) as string[];
  const callbackOrigins = [...new Set(callbacks.map(callbackOrigin))].sort();
  const firstParty = record.is_first_party === true;
  const appType = typeof record.app_type === "string" ? record.app_type : undefined;
  const tokenEndpointAuthMethod =
    typeof record.token_endpoint_auth_method === "string"
      ? record.token_endpoint_auth_method
      : undefined;
  const canonical = {
    clientId: record.client_id,
    name: record.name,
    appType: appType ?? null,
    callbackOrigins,
    firstParty,
    tokenEndpointAuthMethod: tokenEndpointAuthMethod ?? null,
  };
  const likelyDisposableDcrClient =
    !firstParty &&
    (tokenEndpointAuthMethod === undefined || tokenEndpointAuthMethod === "none") &&
    callbackOrigins.length > 0 &&
    callbackOrigins.every(isBoundedDcrCallbackOrigin);
  return {
    clientId: record.client_id,
    name: record.name,
    ...(appType === undefined ? {} : { appType }),
    callbackOrigins,
    firstParty,
    ...(tokenEndpointAuthMethod === undefined ? {} : { tokenEndpointAuthMethod }),
    likelyDisposableDcrClient,
    fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

function callbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Auth0 returned an invalid client callback URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Auth0 returned a credential-bearing client callback URL");
  }
  return url.origin;
}

function isBoundedDcrCallbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return (
    url.hostname === "chatgpt.com" ||
    url.hostname.endsWith(".chatgpt.com") ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
