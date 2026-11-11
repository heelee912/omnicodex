import { expect, it, vi } from "vitest";
import { chatAccountRateLimitRetryAt } from "../src/application/chat-account-request-coordinator.js";
import {
  DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE,
  DESKTOP_NATIVE_SEND_SOURCE,
  dispatchDesktopChatNativeSend,
  isDesktopNativeSendExpression,
  prepareDesktopChatNativeSend,
  sendDesktopChatNativeMessage,
} from "../src/infrastructure/windows/desktop-chat-native-sender.js";

const input = {
  operationId: "goal-continuation:token",
  conversationUrl: "https://chatgpt.com/c/6aa0402d-d934-83ee-bc94-42b9da04cde3",
  accountSourceId: "chatgpt:account:person",
  prompt: "Continue the Goal",
};
const messages = {
  message: {
    id: "native-generated-id",
    author: { role: "user" },
    content: { content_type: "text", parts: [input.prompt] },
    metadata: { system_hints: ["native-hint"] },
  },
  extraDeveloperInstructionMessages: [],
};

it("classifies only canonical native send cancellation and release expressions", () => {
  for (const action of ["cancel", "release"]) {
    const expression = `(${DESKTOP_NATIVE_SEND_LIFECYCLE_SOURCE})(${JSON.stringify({ attemptId: "5196e1aa-4e2b-4168-996d-19f31b880a22", action })})`;
    expect(isDesktopNativeSendExpression(expression)).toBe(true);
    expect(isDesktopNativeSendExpression(`${expression};arbitrary()`)).toBe(false);
  }
});

it("preserves the native-created ID and complete message for durable preparation", async () => {
  const evaluate = vi.fn(async () => ({ ok: true, value: messages }));
  const readAccountSourceId = vi.fn(async () => input.accountSourceId);
  const prepared = await prepareDesktopChatNativeSend(
    input,
    { evaluate, readAccountSourceId },
    new AbortController().signal,
  );
  expect(prepared.clientUserMessageId).toBe(messages.message.id);
  expect(prepared.nativeMessages).toBe(messages);
  expect(readAccountSourceId).toHaveBeenCalledTimes(2);
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("propagates cancellation after preparation without entering native dispatch", async () => {
  const controller = new AbortController();
  const evaluate = vi.fn(async () => ({ ok: true, value: messages }));
  const context = { evaluate, readAccountSourceId: async () => input.accountSourceId };
  const prepared = await prepareDesktopChatNativeSend(input, context, controller.signal);
  const reason = new Error("caller cancelled before dispatch");
  controller.abort(reason);
  await expect(
    dispatchDesktopChatNativeSend(prepared, context, controller.signal),
  ).rejects.toMatchObject({ message: reason.message, nativeDispatchNotStarted: true });
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("dispatches the stored native object without adding model or effort overrides", async () => {
  const evaluate = vi.fn(async (_expression: string) => ({ ok: true, value: true }));
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  expect(
    await dispatchDesktopChatNativeSend(
      prepared,
      { evaluate, readAccountSourceId: async () => input.accountSourceId },
      new AbortController().signal,
    ),
  ).toEqual({
    threadId: input.conversationUrl.split("/").at(-1),
    clientUserMessageId: messages.message.id,
    accepted: true,
  });
  expect(evaluate.mock.calls[0]?.[0]).toContain(JSON.stringify(messages));
});

it("propagates active-conversation rejection without retrying", async () => {
  const evaluate = vi.fn(async () => ({ ok: true, value: false }));
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  expect(
    (
      await dispatchDesktopChatNativeSend(
        prepared,
        { evaluate, readAccountSourceId: async () => input.accountSourceId },
        new AbortController().signal,
      )
    ).accepted,
  ).toBe(false);
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("does not dispatch another account or a changed native message identity", async () => {
  const evaluate = vi.fn();
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  await expect(
    dispatchDesktopChatNativeSend(
      prepared,
      { evaluate, readAccountSourceId: async () => "chatgpt:other:person" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("ACCOUNT_CHANGED");
  await expect(
    dispatchDesktopChatNativeSend(
      { ...prepared, clientUserMessageId: "invented" },
      { evaluate, readAccountSourceId: async () => input.accountSourceId },
      new AbortController().signal,
    ),
  ).rejects.toThrow("MESSAGE_INVALID");
  expect(evaluate).not.toHaveBeenCalled();
});

function nativeRenderer(beforeFetch?: () => Promise<void>) {
  const scopeToken = { id: Symbol("AppScope") };
  const node = {};
  const state = new Map<unknown, unknown>([
    ["Steer", "steering-task"],
    ["Status", false],
    ["Lock", false],
    ["Block", false],
    ["Config", { slug: "selected-native-model", thinkingEffort: "selected-native-effort" }],
    ["Hints", ["native-hint"]],
  ]);
  const scope = {
    query: { getOrFetch: vi.fn(async () => ({})) },
    scope: scopeToken,
    node,
    chain: new Map([[scopeToken.id, node]]),
    get: (key: unknown) => state.get(key),
    set: (key: unknown, _id: unknown, value: unknown) => state.set(key, value),
  };
  const root: Record<string, unknown> = {};
  const start = vi.fn(async (_scope: unknown, _options: unknown) => null);
  const build = vi.fn(() => messages);
  const module: Record<string, unknown> = {
    registry: {},
    token: scopeToken,
    init: () => {},
    factory: build,
    start,
    busy: (value: unknown) => value,
  };
  for (const key of ["Steer", "Status", "Lock", "Block", "Config", "Hints"])
    module[key.toLowerCase()] = key;
  const source =
    "Registry=query(App,({get:g,scope:s})=>{return{queryKey:[`chatgpt-system-hints`,`plugins`]}});export{Registry as registry}" +
    "App=token(`AppScope`);async function Send(s,{conversationId:c,messageMetadata:m,parentMessageId:p,prompt:t}){let steer=s.get(Steer,c),active=Busy(s.get(Status,c));if(s.get(Lock,c)||s.get(Block,c)||active&&steer==null)return!1;let cfg=s.get(Config,c);s.set(Lock,c,!0);try{await Start(s,{conversationId:c,isTemporaryChat:!1,messageMetadata:m,model:cfg.slug,parentMessageId:p,prompt:t,steeringAsyncTaskId:steer??void 0,systemHints:s.get(Hints,c),thinkingEffort:cfg.thinkingEffort})}finally{s.set(Lock,c,!1)}return!0}var Boot=x(()=>{});async function Start(s,{}){let value=provided??Build({attachments:[]});}export{App as token,Boot as init,Start as start,Build as factory,Busy as busy,Steer as steer,Status as status,Lock as lock,Block as block,Config as config,Hints as hints}";
  const fiber = { memoizedState: { memoizedState: { current: scope } } };
  const document = {
    querySelectorAll: (selector: string) =>
      selector === "*" ? [{ __reactFiber$native: fiber }] : [{ src: "app://-/assets/changed.js" }],
  };
  const evaluate = async (expression: string) =>
    new Function(
      "globalThis",
      "document",
      "performance",
      "location",
      "fetch",
      "importer",
      `return (${expression.replace("import(url.href)", "importer(url.href)")})`,
    )(
      root,
      document,
      { getEntriesByType: () => [] },
      { href: "app://-/index.html", host: "-" },
      async () => {
        await beforeFetch?.();
        return {
          ok: true,
          text: async () =>
            source.replace("export{App as token", "export{Registry as registry,App as token"),
        };
      },
      async () => module,
    );
  return {
    query: scope.query,
    root,
    state,
    start,
    build,
    evaluate,
    context: { evaluate, readAccountSourceId: async () => input.accountSourceId },
  };
}

it("prepares and starts an ordinary ChatGPT turn behind one dispatch boundary", async () => {
  const f = nativeRenderer();
  const beforeDispatch = vi.fn(async () => {
    expect(f.start).not.toHaveBeenCalled();
  });
  await expect(
    sendDesktopChatNativeMessage(input, f.context, new AbortController().signal, beforeDispatch),
  ).resolves.toEqual({
    threadId: input.conversationUrl.split("/").at(-1),
    clientUserMessageId: messages.message.id,
    accepted: true,
  });
  expect(beforeDispatch).toHaveBeenCalledTimes(1);
  expect(f.build).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("does not report a persisted-only native message as a successful turn start", async () => {
  const f = nativeRenderer();
  f.state.set("Block", true);
  await expect(
    sendDesktopChatNativeMessage(input, f.context, new AbortController().signal),
  ).rejects.toThrow("DESKTOP_NATIVE_SEND_REJECTED");
  expect(f.start).not.toHaveBeenCalled();
});

it("discovers renamed exports and preserves the native model, effort, hints, steering and cleanup", async () => {
  const f = nativeRenderer();
  const signal = new AbortController().signal;
  const prepared = await prepareDesktopChatNativeSend(input, f.context, signal);
  expect((await dispatchDesktopChatNativeSend(prepared, f.context, signal)).accepted).toBe(true);
  expect(f.start).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      model: "selected-native-model",
      thinkingEffort: "selected-native-effort",
      systemHints: ["native-hint"],
      steeringAsyncTaskId: "steering-task",
      userCompletionMessages: messages,
    }),
  );
  expect(f.build).toHaveBeenCalledTimes(1);
  expect(f.state.get("Lock")).toBe(false);
});

it("retains native active checks and finally cleanup after a dispatch failure", async () => {
  const f = nativeRenderer();
  const signal = new AbortController().signal;
  const prepared = await prepareDesktopChatNativeSend(input, f.context, signal);
  f.state.set("Block", true);
  expect((await dispatchDesktopChatNativeSend(prepared, f.context, signal)).accepted).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
  f.state.set("Block", false);
  f.start.mockRejectedValue(new Error("native request failed"));
  await expect(dispatchDesktopChatNativeSend(prepared, f.context, signal)).rejects.toThrow(
    "native request failed",
  );
  expect(f.state.get("Lock")).toBe(false);
  expect(DESKTOP_NATIVE_SEND_SOURCE).not.toContain("f87238153a19");
});

it.each(["Headers", "record"])(
  "preserves native dispatch Retry-After from %s through the renderer boundary",
  async (format) => {
    const f = nativeRenderer();
    const signal = new AbortController().signal;
    const prepared = await prepareDesktopChatNativeSend(input, f.context, signal);
    f.start.mockRejectedValue(
      Object.assign(new Error("native request rejected"), {
        response: {
          status: 429,
          headers:
            format === "Headers" ? new Headers({ "Retry-After": "120" }) : { "Retry-After": "120" },
        },
      }),
    );
    const result = await dispatchDesktopChatNativeSend(prepared, f.context, signal).catch(
      (error: unknown) => error,
    );
    expect(result).toMatchObject({
      message: "native request rejected",
      response: { status: 429 },
      headers: { "retry-after": "120" },
    });
    expect(chatAccountRateLimitRetryAt(result, 1_000_000)).toBe(1_120_000);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.state.get("Lock")).toBe(false);
  },
);

it("cancels during renderer discovery before the native invocation begins", async () => {
  let release!: () => void;
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = nativeRenderer(async () => {
    entered();
    await gate;
  });
  const controller = new AbortController();
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  const pending = dispatchDesktopChatNativeSend(prepared, f.context, controller.signal);
  await fetching;
  const reason = new Error("cancel during module discovery");
  controller.abort(reason);
  release();
  await expect(pending).rejects.toMatchObject({
    message: reason.message,
    nativeDispatchNotStarted: true,
  });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.state.get("Lock")).toBe(false);
  expect((f.root.__omnicodexDesktopNativeSendOperations as Map<string, unknown>).size).toBe(0);
});

it("retains uncertainty when cancellation arrives after native invocation", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = nativeRenderer();
  f.start.mockImplementation(async () => {
    entered();
    await gate;
    return null;
  });
  const controller = new AbortController();
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  const pending = dispatchDesktopChatNativeSend(prepared, f.context, controller.signal);
  await started;
  const reason = new Error("cancel after native invocation");
  controller.abort(reason);
  release();
  await expect(pending).rejects.toBe(reason);
  expect(reason).not.toHaveProperty("nativeDispatchNotStarted");
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.state.get("Lock")).toBe(false);
});

it("awaits the native cached registry and cancels before sending if it is still loading", async () => {
  let release!: () => void;
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = nativeRenderer();
  f.query.getOrFetch.mockImplementation(async () => {
    entered();
    await gate;
    return {};
  });
  const controller = new AbortController();
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  const pending = dispatchDesktopChatNativeSend(prepared, f.context, controller.signal);
  await loading;
  expect(f.start).not.toHaveBeenCalled();
  controller.abort(new Error("registry loading cancelled"));
  release();
  await expect(pending).rejects.toMatchObject({ nativeDispatchNotStarted: true });
  expect(f.query.getOrFetch).toHaveBeenCalledTimes(1);
  expect(f.start).not.toHaveBeenCalled();
});

it("preserves registry errors without entering native send", async () => {
  const f = nativeRenderer();
  f.query.getOrFetch.mockRejectedValue(
    Object.assign(new Error("native registry rate limited"), { status: 429 }),
  );
  const prepared = { ...input, clientUserMessageId: messages.message.id, nativeMessages: messages };
  await expect(
    dispatchDesktopChatNativeSend(prepared, f.context, new AbortController().signal),
  ).rejects.toMatchObject({
    message: "native registry rate limited",
    status: 429,
    nativeDispatchNotStarted: true,
  });
  expect(f.start).not.toHaveBeenCalled();
});

it("invalidates previous renderer discovery contracts and reuses only the same source", async () => {
  const fetch = vi.fn(async () => {});
  const f = nativeRenderer(fetch);
  f.root.__omnicodexDesktopNativeSender = Promise.resolve({
    body: "old contract without registry",
  });
  const signal = new AbortController().signal;
  const prepared = await prepareDesktopChatNativeSend(input, f.context, signal);
  expect((await dispatchDesktopChatNativeSend(prepared, f.context, signal)).accepted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  const current = f.root.__omnicodexDesktopNativeSender as {
    signature: string;
    promise: Promise<unknown>;
  };
  f.root.__omnicodexDesktopNativeSender = {
    signature: `${current.signature}old`,
    promise: current.promise,
  };
  expect((await dispatchDesktopChatNativeSend(prepared, f.context, signal)).accepted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
