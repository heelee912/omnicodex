export interface Auth0ProvisionSpec {
  readonly tenantOrigin: string;
  readonly audience: string;
  readonly scope?: string;
  readonly apiName?: string;
}

export interface Auth0ProvisionResult {
  readonly resourceServerId: string;
  readonly audience: string;
  readonly scope: string;
  readonly signingAlgorithm: "RS256";
  readonly offlineAccess: true;
  readonly dynamicClientRegistration: true;
  readonly dynamicClientRegistrationSecurityMode: "strict";
  readonly defaultUserGrant: true;
}

export interface Auth0ManagementProvisionerOptions {
  readonly managementToken?: string;
  readonly requester?: Auth0ManagementRequester;
  readonly fetch?: typeof fetch;
}

export interface Auth0ManagementRequester {
  request<T>(tenantOrigin: string, path: string, init: RequestInit): Promise<T>;
}

interface ResourceServer {
  readonly id: string;
  readonly name?: string;
  readonly identifier: string;
  readonly signing_alg?: string;
  readonly allow_offline_access?: boolean;
  readonly scopes?: readonly { readonly value?: string; readonly description?: string }[];
}

interface ClientGrant {
  readonly id: string;
  readonly audience: string;
  readonly scope?: readonly string[];
  readonly default_for?: string;
  readonly subject_type?: string;
}

/**
 * Idempotently provisions only the dedicated OmniCodex Auth0 API and its
 * DCR user grant. The short-lived Management API token is never persisted.
 */
export class Auth0ManagementProvisioner {
  readonly #requester: Auth0ManagementRequester;

  constructor(options: Auth0ManagementProvisionerOptions) {
    if (options.requester !== undefined && options.managementToken !== undefined) {
      throw new Error("Choose either Auth0 CLI or a short-lived Management API token");
    }
    if (options.requester !== undefined) {
      this.#requester = options.requester;
      return;
    }
    const token = options.managementToken;
    if (token === undefined || token.trim().length < 16) {
      throw new Error("Auth0 CLI or a short-lived Management API token is required");
    }
    this.#requester = new BearerManagementRequester(token, options.fetch ?? fetch);
  }

  async provision(spec: Auth0ProvisionSpec): Promise<Auth0ProvisionResult> {
    const tenantOrigin = auth0TenantOrigin(spec.tenantOrigin);
    const audience = requiredHttpsUrl(spec.audience, "Auth0 audience");
    const scope = spec.scope ?? "omnicodex:full";
    if (!/^[A-Za-z0-9:_-]{1,280}$/.test(scope)) throw new Error("Invalid Auth0 API scope");
    const apiName = spec.apiName ?? "OmniCodex";

    let resourceServer = await this.#findResourceServer(tenantOrigin, audience);
    if (resourceServer === undefined) {
      resourceServer = await this.#request<ResourceServer>(
        tenantOrigin,
        "/api/v2/resource-servers",
        {
          method: "POST",
          body: JSON.stringify({
            name: apiName,
            identifier: audience,
            signing_alg: "RS256",
            allow_offline_access: true,
            token_lifetime: 3600,
            scopes: [{ value: scope, description: "Full owner-authorized OmniCodex access" }],
            subject_type_authorization: {
              user: { policy: "require_client_grant" },
              client: { policy: "deny_all" },
            },
          }),
        },
      );
    } else {
      await this.#request<ResourceServer>(
        tenantOrigin,
        `/api/v2/resource-servers/${encodeURIComponent(resourceServer.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: apiName,
            signing_alg: "RS256",
            allow_offline_access: true,
            token_lifetime: 3600,
            scopes: [{ value: scope, description: "Full owner-authorized OmniCodex access" }],
            subject_type_authorization: {
              user: { policy: "require_client_grant" },
              client: { policy: "deny_all" },
            },
          }),
        },
      );
    }

    await this.#ensureDefaultUserGrant(tenantOrigin, audience, scope);
    await this.#request<Record<string, unknown>>(tenantOrigin, "/api/v2/tenants/settings", {
      method: "PATCH",
      body: JSON.stringify({
        flags: { enable_dynamic_client_registration: true },
        dynamic_client_registration_security_mode: "strict",
      }),
    });

    const verifiedResource = await this.#findResourceServer(tenantOrigin, audience);
    const verifiedGrants = await this.#findDefaultUserGrants(tenantOrigin, audience);
    const settings = await this.#request<Record<string, unknown>>(
      tenantOrigin,
      "/api/v2/tenants/settings",
      { method: "GET" },
    );
    if (
      verifiedResource === undefined ||
      verifiedResource.signing_alg !== "RS256" ||
      verifiedResource.allow_offline_access !== true ||
      !verifiedResource.scopes?.some((item) => item.value === scope)
    ) {
      throw new Error("Auth0 resource-server readback did not match OmniCodex requirements");
    }
    if (
      verifiedGrants.length !== 1 ||
      !verifiedGrants[0]?.scope?.includes(scope) ||
      verifiedGrants[0].subject_type !== "user"
    ) {
      throw new Error("Auth0 DCR default user grant readback failed");
    }
    const flags = isObject(settings.flags) ? settings.flags : {};
    if (
      flags.enable_dynamic_client_registration !== true ||
      settings.dynamic_client_registration_security_mode !== "strict"
    ) {
      throw new Error("Auth0 strict Dynamic Client Registration readback failed");
    }
    return {
      resourceServerId: verifiedResource.id,
      audience,
      scope,
      signingAlgorithm: "RS256",
      offlineAccess: true,
      dynamicClientRegistration: true,
      dynamicClientRegistrationSecurityMode: "strict",
      defaultUserGrant: true,
    };
  }

  async #findResourceServer(
    tenantOrigin: string,
    audience: string,
  ): Promise<ResourceServer | undefined> {
    const query = new URLSearchParams({ identifiers: audience });
    const servers = await this.#request<unknown>(
      tenantOrigin,
      `/api/v2/resource-servers?${query.toString()}`,
      { method: "GET" },
    );
    const list = arrayResult<ResourceServer>(servers, "resource servers");
    const exact = list.filter((item) => item.identifier === audience);
    if (exact.length > 1) throw new Error("Auth0 returned duplicate resource servers");
    return exact[0];
  }

  async #ensureDefaultUserGrant(
    tenantOrigin: string,
    audience: string,
    scope: string,
  ): Promise<void> {
    const grants = await this.#findDefaultUserGrants(tenantOrigin, audience);
    if (grants.length > 1) throw new Error("Auth0 returned duplicate default user grants");
    const existing = grants[0];
    if (existing === undefined) {
      await this.#request<ClientGrant>(tenantOrigin, "/api/v2/client-grants", {
        method: "POST",
        body: JSON.stringify({
          default_for: "third_party_clients",
          audience,
          scope: [scope],
          subject_type: "user",
        }),
      });
      return;
    }
    if (existing.scope?.length === 1 && existing.scope[0] === scope) return;
    await this.#request<ClientGrant>(
      tenantOrigin,
      `/api/v2/client-grants/${encodeURIComponent(existing.id)}`,
      { method: "PATCH", body: JSON.stringify({ scope: [scope] }) },
    );
  }

  async #findDefaultUserGrants(tenantOrigin: string, audience: string): Promise<ClientGrant[]> {
    const query = new URLSearchParams({ audience, page: "0", per_page: "100" });
    const result = await this.#request<unknown>(
      tenantOrigin,
      `/api/v2/client-grants?${query.toString()}`,
      { method: "GET" },
    );
    return arrayResult<ClientGrant>(result, "client grants").filter(
      (item) =>
        item.audience === audience &&
        item.default_for === "third_party_clients" &&
        item.subject_type === "user",
    );
  }

  async #request<T>(tenantOrigin: string, path: string, init: RequestInit): Promise<T> {
    return this.#requester.request<T>(tenantOrigin, path, init);
  }
}

class BearerManagementRequester implements Auth0ManagementRequester {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async request<T>(tenantOrigin: string, path: string, init: RequestInit): Promise<T> {
    const response = await this.#fetch(new URL(path, tenantOrigin), {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    const body = await response.text();
    if (body.length > 1_048_576) throw new Error("Auth0 Management API response was too large");
    if (!response.ok) {
      throw new Error(
        `Auth0 Management API request failed (${response.status})${safeErrorSuffix(body)}`,
      );
    }
    if (body.length === 0) return {} as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error("Auth0 Management API returned invalid JSON");
    }
  }
}

function auth0TenantOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Auth0 tenant must be a credential-free HTTPS origin");
  }
  return url.origin;
}

function requiredHttpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url.href.replace(/\/$/, "");
}

function arrayResult<T>(value: unknown, label: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isObject(value) && Array.isArray(value.items)) return value.items as T[];
  throw new Error(`Auth0 returned an invalid ${label} response`);
}

function safeErrorSuffix(value: string): string {
  const safe = value
    .replaceAll(/(?:eyJ|token|secret|password)[A-Za-z0-9_.=:+/-]{8,}/gi, "[redacted]")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 512);
  return safe.length === 0 ? "" : `: ${safe}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
