import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closeRuntimeCallSession,
  parseRuntimeCallTimeout,
  parseRuntimeToolArguments,
  requestGoalConversationObservation,
  requestOracleActionCatalogSync,
  runtimeCallRequestOptions,
  transitionOracleResource,
} from "../src/cli.js";

describe("operator catalog synchronization", () => {
  it("sends an exact Goal observation to one authenticated daemon account", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\omni-goal-${randomUUID()}`
        : join(tmpdir(), `omni-goal-${randomUUID()}.sock`);
    const identity = { pid: process.pid, instanceNonce: randomUUID(), startedAtUnixMs: 1 };
    const request = vi.fn();
    const server = createServer((socket) =>
      socket.once("data", (chunk) => {
        request(JSON.parse(String(chunk)));
        socket.end(
          `${JSON.stringify({ ok: true, ...identity, lifecycle: "ready", runtime: { goalObservation: { outcome: "ok", observedGoals: [] } } })}\n`,
        );
      }),
    );
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const conversationUrl = "https://chatgpt.com/c/550e8400-e29b-41d4-a716-446655440000";
      await requestGoalConversationObservation(
        {
          schemaVersion: 1,
          lifecycle: "ready",
          ...identity,
          updatedAtUnixMs: 1,
          controlPipe: pipe,
          controlToken: "test-only",
        },
        "second",
        conversationUrl,
      );
      expect(request).toHaveBeenCalledExactlyOnceWith({
        command: "observe-goal-conversation",
        clientBinding: "second",
        conversationUrl,
        token: "test-only",
        expectedPid: identity.pid,
        expectedInstanceNonce: identity.instanceNonce,
        expectedStartedAtUnixMs: 1,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([
    { state: "current", clientBinding: "web" },
    { state: "already_attempted", clientBinding: "desktop" },
  ] as const)(
    "preserves shared daemon state $state and targets only $clientBinding",
    async ({ state, clientBinding }) => {
      const result = { state, catalogRevision: "a".repeat(64) };
      const request = vi.fn();
      const pipe =
        process.platform === "win32"
          ? `\\\\.\\pipe\\omnicodex-refresh-test-${randomUUID()}`
          : join(tmpdir(), `omni-refresh-${randomUUID()}.sock`);
      const identity = { pid: process.pid, instanceNonce: randomUUID(), startedAtUnixMs: 1 };
      const server = createServer((socket) => {
        socket.once("data", (chunk) => {
          request(JSON.parse(String(chunk)));
          socket.end(
            `${JSON.stringify({
              ok: true,
              ...identity,
              lifecycle: "ready",
              runtime: {
                actionCatalog: { ...result, bindings: { [clientBinding]: result } },
              },
            })}\n`,
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(pipe, resolve));
      try {
        await expect(
          requestOracleActionCatalogSync(
            {
              schemaVersion: 1,
              lifecycle: "ready",
              ...identity,
              updatedAtUnixMs: 1,
              controlPipe: pipe,
              controlToken: "test-only",
            },
            clientBinding,
          ),
        ).resolves.toEqual(result);
        expect(request).toHaveBeenCalledExactlyOnceWith({
          command: "refresh-action-catalog",
          clientBinding,
          token: "test-only",
          expectedPid: identity.pid,
          expectedInstanceNonce: identity.instanceNonce,
          expectedStartedAtUnixMs: identity.startedAtUnixMs,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("preserves an endpoint readiness result when the daemon has no binding receipt yet", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\omnicodex-refresh-test-${randomUUID()}`
        : join(tmpdir(), `omni-refresh-${randomUUID()}.sock`);
    const identity = { pid: process.pid, instanceNonce: randomUUID(), startedAtUnixMs: 1 };
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            ok: true,
            ...identity,
            lifecycle: "ready",
            runtime: {
              actionCatalog: { state: "endpoint_unavailable", bindings: {} },
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      await expect(
        requestOracleActionCatalogSync(
          {
            schemaVersion: 1,
            lifecycle: "ready",
            ...identity,
            updatedAtUnixMs: 1,
            controlPipe: pipe,
            controlToken: "test-only",
          },
          "second",
        ),
      ).resolves.toEqual({ state: "endpoint_unavailable" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ends an operator observation on its deadline without another request", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\omnicodex-refresh-test-${randomUUID()}`
        : join(tmpdir(), `omni-refresh-${randomUUID()}.sock`);
    const abort = new AbortController();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("data", () => abort.abort(new Error("operator deadline")));
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      await expect(
        requestOracleActionCatalogSync(
          {
            schemaVersion: 1,
            lifecycle: "ready",
            pid: process.pid,
            instanceNonce: randomUUID(),
            startedAtUnixMs: 1,
            updatedAtUnixMs: 1,
            controlPipe: pipe,
            controlToken: "test-only",
          },
          "web",
          abort.signal,
        ),
      ).rejects.toThrow("operator deadline");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("runtime call argument parsing", () => {
  it("terminates the remote MCP session before closing the one-shot local client", async () => {
    const events: string[] = [];
    await closeRuntimeCallSession(
      { close: async () => void events.push("client-close") },
      { terminateSession: async () => void events.push("session-delete") },
      true,
    );
    expect(events).toEqual(["session-delete", "client-close"]);
  });

  it("still closes the local client when remote session termination fails", async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      closeRuntimeCallSession(
        { close },
        {
          terminateSession: async () => {
            throw new Error("delete failed");
          },
        },
        true,
      ),
    ).rejects.toThrow("delete failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a complete nested JSON object", () => {
    expect(parseRuntimeToolArguments('{"path":"C:/tmp/file","nested":{"items":[1,2,3]}}')).toEqual({
      path: "C:/tmp/file",
      nested: { items: [1, 2, 3] },
    });
  });

  it.each(["[]", "null", '"value"', "not-json"])("rejects non-object input %s", (value) => {
    expect(() => parseRuntimeToolArguments(value)).toThrow(/JSON/u);
  });

  it("removes the MCP client's hidden 60-second product deadline", () => {
    expect(runtimeCallRequestOptions(undefined)).toEqual({
      timeout: 2_147_483_647,
      resetTimeoutOnProgress: true,
    });
  });

  it("preserves an explicit caller deadline as the total deadline", () => {
    expect(runtimeCallRequestOptions(parseRuntimeCallTimeout("90000"))).toEqual({
      timeout: 90_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 90_000,
    });
  });

  it.each(["0", "-1", "2147483648", "invalid"])(
    "rejects an invalid runtime call timeout %s",
    (value) => {
      expect(() => parseRuntimeCallTimeout(value)).toThrow(/timeout/u);
    },
  );

  it("invalidates resource-bound Oracle evidence when the public MCP URL changes", () => {
    const previousResource = "https://old.example/mcp/full";
    const nextResource = "https://omnicodex.example/mcp/full";
    const transitioned = transitionOracleResource(
      {
        enabled: true,
        connectorId: "asdk_app_exact",
        connectorName: "OmniCodex",
        runId: "run-exact",
        resource: previousResource,
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:19222",
        freshLiveVerification: "verified",
        lastStateVerification: {
          timestamp: "2026-09-04T00:00:00.000Z",
          correlationId: "run-exact",
          resource: previousResource,
          connected: true,
          fullAccess: true,
          stateHash: "a".repeat(64),
        },
        lastActionCatalogVerification: {
          timestamp: "2026-09-04T00:00:00.000Z",
          correlationId: "run-exact",
          verificationSource: "chatgpt_control_plane_catalog",
          daemonPid: 1,
          catalogRevision: "b".repeat(64),
          catalogToolCount: 1,
          catalogPageToolCounts: [1],
          catalogToolNamesSha256: "c".repeat(64),
          catalogContractSha256: "d".repeat(64),
          visibleActionToolCount: 1,
          visibleActionNamesSha256: "c".repeat(64),
          actionSchemaHash: "e".repeat(64),
          verifiedActionNames: ["tool"],
        },
        lastReceipts: [
          {
            timestamp: "2026-09-04T00:00:00.000Z",
            action: "always_allow",
            consentStrength: "full_access",
            evidenceSource: "settings_reconcile",
            correlationId: "run-exact",
            beforeStateHash: "f".repeat(64),
            afterStateHash: "0".repeat(64),
          },
        ],
      },
      nextResource,
    );

    expect(transitioned).toMatchObject({
      connectorId: "asdk_app_exact",
      resource: nextResource,
      freshLiveVerification: "pending",
    });
    expect(transitioned.lastStateVerification).toBeUndefined();
    expect(transitioned.lastActionCatalogVerification).toBeUndefined();
    expect(transitioned.lastReceipts).toBeUndefined();
  });
});
