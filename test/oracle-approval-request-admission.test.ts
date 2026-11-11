import { afterEach, expect, it, vi } from "vitest";
import { ChatAccountRequestCoordinator } from "../src/application/chat-account-request-coordinator.js";
import { OracleChatGptServerApprovalClient } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION,
  oracleChatGptApprovalRuntimeUrl,
  oracleChatGptServerApprovalScanExpression,
} from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";

const connector = "asdk_app_admission";
const key = `__omnicodexOracleServerApprovalV2:${connector}`;
const root = globalThis as typeof globalThis & Record<string, unknown>;
afterEach(() => {
  delete root[key];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(serverDeadline?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const safeGet = vi.fn().mockRejectedValue({ status: 429, message: "Too many requests" });
  root[key] = {
    module: {},
    requestClient: { safeGet, request: vi.fn() },
    handled: {},
    inFlight: {},
    backoffUntil: serverDeadline ?? 3_400_000,
    backoffMs: 3_600_000,
    lastRateLimit: {
      observedAtUnixMs: 999_000,
      retryAtUnixMs: serverDeadline ?? 3_400_000,
      backoffSource: serverDeadline === undefined ? "local_backoff" : "server_retry_after",
      localBackoffMs: serverDeadline === undefined ? 2_401_000 : 30_000,
      // Only the old adaptive policy is migrated. Ordinary persisted native
      // observations, including server deadlines, must retain their wait.
      ...(serverDeadline === undefined
        ? { adaptiveRetry: true }
        : { serverRetryAtUnixMs: serverDeadline }),
    },
  };
  return safeGet;
}

function run(fresh: boolean) {
  const expression = oracleChatGptServerApprovalScanExpression(
    connector,
    "OmniCodex",
    ["chat"],
    [],
    fresh
      ? {
          expectedApprovals: [
            { conversationId: "chat", pendingMessageId: "pending", targetMessageIds: ["tool"] },
          ],
        }
      : undefined,
  );
  return new Function(`return ${expression}`)() as Promise<{ nextScanAtUnixMs: number }>;
}

it("admits a newly observed approval immediately but does not replay it during local retry pacing", async () => {
  const safeGet = setup();
  await run(true);
  expect(safeGet).toHaveBeenCalledTimes(1);
  await run(true);
  expect(safeGet).toHaveBeenCalledTimes(1);
});

it("does not let a fresh approval shorten the server Retry-After deadline", async () => {
  const safeGet = setup(1_600_000);
  expect((await run(true)).nextScanAtUnixMs).toBe(1_600_000);
  expect(safeGet).not.toHaveBeenCalled();
});

it("retires a restored 40-minute local delay instead of carrying it into the next deployment", async () => {
  const safeGet = setup();
  expect((await run(false)).nextScanAtUnixMs).toBe(1_029_000);
  expect(safeGet).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(29_000);
  await run(false);
  expect(safeGet).toHaveBeenCalledOnce();
});

it("shares repeated renderer 429s with the account-wide backoff instead of retrying every 30 seconds", async () => {
  const safeGet = setup();
  const state = root[key] as Record<string, unknown>;
  state.backoffUntil = 0;
  state.lastRateLimit = null;
  const account = "chatgpt:A:U";
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "A", user_id: "U" },
    }),
  ).toString("base64url");
  vi.stubGlobal("location", { origin: "https://chatgpt.com", pathname: "/api/auth/session" });
  vi.stubGlobal("document", {
    body: { innerText: JSON.stringify({ accessToken: `test.${claims}.test` }) },
  });
  const coordinator = new ChatAccountRequestCoordinator();
  const command = vi.fn(async (_method: string, params: { expression: string }) => ({
    result: {
      value:
        params.expression === ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION
          ? true
          : params.expression === ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION
            ? account
            : await new Function(`return ${params.expression}`)(),
    },
  }));
  const client = new OracleChatGptServerApprovalClient({
    connectorId: connector,
    connectorName: "OmniCodex",
    cdpEndpoint: "http://127.0.0.1:9222",
    accountCooldown: {
      read: (id) => coordinator.readCooldown(id),
      observe: (id, snapshot) => coordinator.observeCooldown(id, snapshot),
    },
    transport: {
      adoptOrOpenOwnedApprovalRuntimeTarget: async () => ({
        id: "runtime",
        url: oracleChatGptApprovalRuntimeUrl(connector),
      }),
    } as never,
    connectSession: async () => ({ command, close: vi.fn() }) as never,
  });
  const observe = () =>
    client.observeGoalConversation("https://chatgpt.com/c/chat", new AbortController().signal);
  try {
    await observe();
    await vi.advanceTimersByTimeAsync(30_000);
    await observe();
    expect(safeGet).toHaveBeenCalledTimes(2);
    expect(await coordinator.readCooldown(account)).toMatchObject({ retryAtUnixMs: 1_090_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await observe()).nextScanAtUnixMs).toBe(1_090_000);
    const otherRequest = vi.fn(async () => "unexpected");
    await expect(coordinator.run(account, otherRequest, undefined, "report")).rejects.toMatchObject(
      {
        retryAtUnixMs: 1_090_000,
      },
    );
    expect(otherRequest).not.toHaveBeenCalled();
    expect(safeGet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await observe();
    expect(await coordinator.readCooldown(account)).toMatchObject({ retryAtUnixMs: 1_210_000 });
    expect(safeGet).toHaveBeenCalledTimes(3);
  } finally {
    await client.stop();
  }
});
