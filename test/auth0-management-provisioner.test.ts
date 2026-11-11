import { describe, expect, it } from "vitest";
import { Auth0ManagementProvisioner } from "../src/infrastructure/auth/auth0-management-provisioner.js";

describe("Auth0ManagementProvisioner", () => {
  it("creates the dedicated API, strict DCR user grant, and proves readback", async () => {
    const calls: Array<{ url: URL; method: string; body?: unknown; authorization: string | null }> =
      [];
    let resourceCreated = false;
    let grantCreated = false;
    let dcrEnabled = false;
    const fetchStub: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method,
        ...(body === undefined ? {} : { body }),
        authorization: headers.get("Authorization"),
      });
      if (url.pathname === "/api/v2/resource-servers" && method === "GET") {
        return jsonResponse(resourceCreated ? [resourceServer()] : []);
      }
      if (url.pathname === "/api/v2/resource-servers" && method === "POST") {
        resourceCreated = true;
        return jsonResponse(resourceServer(), 201);
      }
      if (url.pathname === "/api/v2/client-grants" && method === "GET") {
        return jsonResponse(grantCreated ? [clientGrant()] : []);
      }
      if (url.pathname === "/api/v2/client-grants" && method === "POST") {
        grantCreated = true;
        return jsonResponse(clientGrant(), 201);
      }
      if (url.pathname === "/api/v2/tenants/settings" && method === "PATCH") {
        dcrEnabled = true;
        return jsonResponse(settings());
      }
      if (url.pathname === "/api/v2/tenants/settings" && method === "GET") {
        return jsonResponse(dcrEnabled ? settings() : { flags: {} });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    };
    const provisioner = new Auth0ManagementProvisioner({
      managementToken: "m".repeat(64),
      fetch: fetchStub,
    });

    await expect(
      provisioner.provision({
        tenantOrigin: "https://owner.us.auth0.com",
        audience: "https://owner.ngrok.app/mcp",
      }),
    ).resolves.toEqual({
      resourceServerId: "api_omnicodex",
      audience: "https://owner.ngrok.app/mcp",
      scope: "omnicodex:full",
      signingAlgorithm: "RS256",
      offlineAccess: true,
      dynamicClientRegistration: true,
      dynamicClientRegistrationSecurityMode: "strict",
      defaultUserGrant: true,
    });
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.authorization === `Bearer ${"m".repeat(64)}`)).toBe(true);
    expect(calls[1]?.body).toMatchObject({
      identifier: "https://owner.ngrok.app/mcp",
      signing_alg: "RS256",
      allow_offline_access: true,
      subject_type_authorization: {
        user: { policy: "require_client_grant" },
        client: { policy: "deny_all" },
      },
    });
    expect(calls[3]?.body).toEqual({
      default_for: "third_party_clients",
      audience: "https://owner.ngrok.app/mcp",
      scope: ["omnicodex:full"],
      subject_type: "user",
    });
    expect(calls[4]?.body).toEqual({
      flags: { enable_dynamic_client_registration: true },
      dynamic_client_registration_security_mode: "strict",
    });
  });

  it("does not accept a weak management token or non-HTTPS tenant", async () => {
    expect(() => new Auth0ManagementProvisioner({ managementToken: "short" })).toThrow(
      "short-lived",
    );
    const provisioner = new Auth0ManagementProvisioner({ managementToken: "m".repeat(64) });
    await expect(
      provisioner.provision({
        tenantOrigin: "http://owner.us.auth0.com",
        audience: "https://owner.ngrok.app/mcp",
      }),
    ).rejects.toThrow("HTTPS origin");
  });

  it("rejects tenant origins with a non-default port", async () => {
    const provisioner = new Auth0ManagementProvisioner({
      requester: { request: async <T>() => ({}) as T },
    });

    await expect(
      provisioner.provision({
        tenantOrigin: "https://owner.us.auth0.com:8443/",
        audience: "https://owner.ngrok.app/mcp",
      }),
    ).rejects.toThrow("credential-free HTTPS origin");
  });
});

function resourceServer() {
  return {
    id: "api_omnicodex",
    name: "OmniCodex",
    identifier: "https://owner.ngrok.app/mcp",
    signing_alg: "RS256",
    allow_offline_access: true,
    scopes: [{ value: "omnicodex:full", description: "Full owner-authorized OmniCodex access" }],
  };
}

function clientGrant() {
  return {
    id: "cgr_omnicodex",
    audience: "https://owner.ngrok.app/mcp",
    scope: ["omnicodex:full"],
    default_for: "third_party_clients",
    subject_type: "user",
  };
}

function settings() {
  return {
    flags: { enable_dynamic_client_registration: true },
    dynamic_client_registration_security_mode: "strict",
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
