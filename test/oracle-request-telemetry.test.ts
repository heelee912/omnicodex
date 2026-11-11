import { describe, expect, it, vi } from "vitest";
import {
  OracleApprovalTelemetryError,
  OracleChatGptServerApprovalClient,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

describe("Oracle request telemetry through failed evaluations", () => {
  function fixture(fail: boolean) {
    let notify: ((data: unknown) => void) | undefined;
    const stats = (getCount: number) => ({
      scanStartedAtUnixMs: 1000,
      trigger: "queued_request",
      getCount,
      postCount: 0,
      moduleInitializationCount: 0,
      rateLimitCount: 1,
      conversationIds: [],
      requests: [],
    });
    const command = vi.fn(async (_method: string, args: { expression?: string }) => {
      if (args.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION)
        return { result: { value: true } };
      const telemetryId = /"telemetryId":"([a-f0-9-]{36})"/.exec(args.expression ?? "")?.[1];
      if (!telemetryId) throw new Error("unexpected command");
      const emit = (id: string, getCount: number, rateLimit?: unknown) =>
        notify?.(
          JSON.stringify({
            method: "Runtime.consoleAPICalled",
            params: {
              args: [
                { value: "omnicodex-oracle-request-stats-v1" },
                {
                  value: JSON.stringify({
                    telemetryId: id,
                    requestStats: stats(getCount),
                    rateLimit,
                  }),
                },
              ],
            },
          }),
        );
      emit(telemetryId, 1, {
        status: 429,
        operation: "conversation_read",
        retryAtUnixMs: 61000,
        observedAtUnixMs: 1000,
        serverRetryAtUnixMs: 61000,
        responseHeaders: { "retry-after": "60", authorization: "private" },
      });
      emit("00000000-0000-0000-0000-000000000000", 99);
      emit(telemetryId, 2);
      if (fail) throw new Error("CDP command timeout:Runtime.evaluate");
      return {
        result: {
          value: {
            outcome: "ok",
            examined: 0,
            discovered: 0,
            approvalsPending: 0,
            followUpScanRequired: false,
            conversationUrls: [],
            receipts: [],
            errors: [],
            requestStats: stats(2),
          },
        },
      };
    });
    const connectorId = "asdk_app_telemetry";
    const client = new OracleChatGptServerApprovalClient({
      connectorId,
      connectorName: "OmniCodex",
      cdpEndpoint: "http://127.0.0.1:9222",
      transport: {
        adoptOrOpenOwnedApprovalRuntimeTarget: vi.fn(async () => ({
          id: "runtime",
          url: oracleChatGptApprovalRuntimeUrl(connectorId),
        })),
      } as never,
      connectSession: (async (
        _transport: unknown,
        _id: string,
        _signal: AbortSignal,
        callback?: (data: unknown) => void,
      ) => {
        notify = callback;
        return { command, close: vi.fn() };
      }) as never,
    });
    client.requestScan("https://chatgpt.com/c/company");
    return { client, command };
  }

  it("retains the final cumulative count and earlier 429 on timeout without accepting another operation", async () => {
    const { client, command } = fixture(true);
    const error = await client.scan(new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OracleApprovalTelemetryError);
    expect(error).toMatchObject({
      message: "ORACLE_SERVER_APPROVAL_SESSION_FAILED:CDP command timeout:Runtime.evaluate",
      telemetry: {
        requestStats: { getCount: 2, rateLimitCount: 1 },
        rateLimit: {
          status: 429,
          serverRetryAtUnixMs: 61000,
          responseHeaders: { "retry-after": "60" },
        },
      },
    });
    expect(JSON.stringify((error as OracleApprovalTelemetryError).telemetry)).not.toContain(
      "private",
    );
    expect(command).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it("returns only the authoritative success count, without adding interim snapshots", async () => {
    const { client, command } = fixture(false);
    expect(await client.scan(new AbortController().signal)).toMatchObject({
      outcome: "ok",
      requestStats: { getCount: 2 },
    });
    expect(command).toHaveBeenCalledTimes(2);
    await client.stop();
  });
});
