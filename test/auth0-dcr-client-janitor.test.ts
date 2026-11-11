import { describe, expect, it, vi } from "vitest";
import { Auth0DcrClientJanitor } from "../src/infrastructure/auth/auth0-dcr-client-janitor.js";
import type { Auth0ManagementRequester } from "../src/infrastructure/auth/auth0-management-provisioner.js";

const tenant = "https://tenant.example.auth0.com/";

describe("Auth0DcrClientJanitor", () => {
  it("lists only non-secret metadata and marks bounded third-party DCR clients", async () => {
    const request = vi.fn(async (_tenant: string, _path: string, _init: RequestInit) => ({
      clients: [
        {
          client_id: "chatgpt_public_client_123",
          name: "ChatGPT MCP",
          app_type: "native",
          callbacks: ["https://chatgpt.com/aip/oauth/callback"],
          is_first_party: false,
          token_endpoint_auth_method: "none",
          client_secret: "must-never-be-observed",
        },
        {
          client_id: "tenant_dashboard_client_1",
          name: "Tenant dashboard",
          callbacks: ["https://manage.auth0.com/callback"],
          is_first_party: true,
          token_endpoint_auth_method: "client_secret_post",
        },
      ],
      total: 2,
    }));
    const janitor = new Auth0DcrClientJanitor({ requester: genericRequester(request) });

    const clients = await janitor.list(tenant);

    expect(clients).toHaveLength(2);
    expect(clients.find((client) => client.clientId === "chatgpt_public_client_123")).toMatchObject(
      {
        callbackOrigins: ["https://chatgpt.com"],
        likelyDisposableDcrClient: true,
        firstParty: false,
      },
    );
    expect(clients.find((client) => client.clientId === "tenant_dashboard_client_1")).toMatchObject(
      {
        likelyDisposableDcrClient: false,
        firstParty: true,
      },
    );
    expect(JSON.stringify(clients)).not.toContain("must-never-be-observed");
    expect(String(request.mock.calls[0]?.[1])).toContain("fields=");
  });

  it("deletes only after exact fingerprint readback", async () => {
    const record = {
      client_id: "chatgpt_public_client_123",
      name: "ChatGPT MCP",
      app_type: "native",
      callbacks: ["https://chatgpt.com/aip/oauth/callback"],
      is_first_party: false,
      token_endpoint_auth_method: "none",
    };
    const request = vi.fn(async (_tenant: string, path: string) => {
      if (path.startsWith("/api/v2/clients?")) return { clients: [record] };
      if (path.includes("?fields=")) return record;
      return {};
    });
    const janitor = new Auth0DcrClientJanitor({ requester: genericRequester(request) });
    const [candidate] = await janitor.list(tenant);
    if (candidate === undefined) throw new Error("candidate missing");

    await expect(
      janitor.deleteExact(tenant, candidate.clientId, candidate.fingerprint),
    ).resolves.toMatchObject({ clientId: candidate.clientId });
    expect(request).toHaveBeenLastCalledWith(tenant, `/api/v2/clients/${candidate.clientId}`, {
      method: "DELETE",
    });
  });

  it("refuses deletion when metadata changed or the client is first-party", async () => {
    const request = vi.fn(async (_tenant: string, _path: string, _init: RequestInit) => ({
      client_id: "tenant_dashboard_client_1",
      name: "Tenant dashboard",
      callbacks: ["https://chatgpt.com/aip/oauth/callback"],
      is_first_party: true,
      token_endpoint_auth_method: "none",
    }));
    const janitor = new Auth0DcrClientJanitor({ requester: genericRequester(request) });

    await expect(
      janitor.deleteExact(tenant, "tenant_dashboard_client_1", "0".repeat(64)),
    ).rejects.toThrow("changed after review");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function genericRequester(
  request: (tenantOrigin: string, path: string, init: RequestInit) => Promise<unknown>,
): Auth0ManagementRequester {
  return {
    request: async <T>(tenantOrigin: string, path: string, init: RequestInit) =>
      (await request(tenantOrigin, path, init)) as T,
  };
}
