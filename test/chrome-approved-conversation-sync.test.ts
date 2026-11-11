import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  chromeApprovedConversationSyncCode,
  synchronizeApprovedChromeConversation,
} from "../src/application/chrome-approved-conversation-sync.js";

const target = {
  conversationUrl: "https://chatgpt.com/c/6a99c621-cf78-83e8-ad6e-9b1aca804f0b",
  pendingMessageId: "pending-message",
};

async function run(
  options: {
    draft?: string;
    attached?: boolean;
    laterMessage?: boolean;
    approvalVisible?: boolean;
    pendingId?: string;
    standaloneApproval?: boolean;
    userMessageId?: string;
    urls?: string[];
    navigateDuringRead?: boolean;
    responding?: boolean;
    respondDuringRead?: boolean;
  } = {},
) {
  const reload = vi.fn();
  let responding = options.responding ?? false;
  const visible = () => [1];
  const pending = {
    getClientRects: visible,
    getAttribute: () => options.pendingId ?? target.pendingMessageId,
    textContent:
      options.approvalVisible === false ? "File attached" : "Allow file materialization?",
  };
  const composer = {
    tagName: "DIV",
    value: "",
    getClientRects: visible,
    textContent: options.draft ?? "",
    closest: () => ({
      querySelectorAll: (selector: string) =>
        selector === 'input[type="file"]' && options.attached ? [{ files: [1] }] : [],
    }),
  };
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector === "h2") return options.approvalVisible === false ? [] : [pending];
      const anchor = options.standaloneApproval
        ? {
            ...pending,
            getAttribute: (name: string) => (name === "data-message-id" ? "origin-user" : "user"),
            textContent: "Attach the file",
          }
        : pending;
      return options.laterMessage
        ? [anchor, { ...pending, getAttribute: () => "later-user-message" }]
        : [anchor];
    },
    querySelector: (selector: string) =>
      selector === '[data-testid="stop-button"]' ? (responding ? {} : null) : composer,
  };
  let currentUrl = target.conversationUrl;
  const tab = {
    url: async () => currentUrl,
    reload,
    playwright: {
      evaluate: async (fn: unknown, arg: string) => {
        const snapshot = runInNewContext(`(${String(fn)})(arg)`, { document, arg });
        if (options.navigateDuringRead) currentUrl = "https://chatgpt.com/";
        if (options.respondDuringRead) responding = true;
        return snapshot;
      },
    },
  };
  const browser = {
    user: {
      openTabs: vi.fn(async () =>
        (options.urls ?? [target.conversationUrl]).map((url) => ({ url })),
      ),
      claimTab: vi.fn(async () => tab),
    },
  };
  const result = await runInNewContext(
    `(async () => { ${chromeApprovedConversationSyncCode({ ...target, ...(options.userMessageId === undefined ? {} : { userMessageId: options.userMessageId }) })} })()`,
    { browser, URL },
  );
  return { result: JSON.parse(result), reload, browser };
}

describe("approved Chrome conversation synchronization", () => {
  it("uses a fresh native turn for each retry while preserving its browser session", async () => {
    const completed = new Set<string>();
    const executor = {
      beginActivity: vi.fn(async (activity: string) => {
        expect(completed.has(activity)).toBe(false);
      }),
      call: vi.fn(async () => ({ isError: true, content: [] })),
      finishActivity: vi.fn(async (activity: string) => {
        completed.add(activity);
      }),
    };
    await synchronizeApprovedChromeConversation(executor, target);
    await synchronizeApprovedChromeConversation(executor, target);
    expect(completed.size).toBe(2);
    expect(executor.finishActivity.mock.calls).toEqual(executor.beginActivity.mock.calls);
    const calls = executor.call.mock.calls as unknown as [
      unknown,
      { callerSessionId: string; activityBinding: string },
    ][];
    expect(calls[0]?.[1].callerSessionId).toBe(calls[1]?.[1].callerSessionId);
    expect(calls[0]?.[1].activityBinding).not.toBe(calls[1]?.[1].activityBinding);
  });
  it.each([false, true])(
    "releases native tab ownership after completion or failure (%s)",
    async (fail) => {
      const order: string[] = [];
      const executor = {
        beginActivity: vi.fn(async () => {
          order.push("begin");
        }),
        call: vi.fn(async () => {
          order.push("call");
          if (fail) throw new Error("browser unavailable");
          return "ok";
        }),
        finishActivity: vi.fn(async () => {
          order.push("finish");
        }),
      };
      const operation = synchronizeApprovedChromeConversation(executor, target);
      if (fail) await expect(operation).rejects.toThrow("browser unavailable");
      else await expect(operation).resolves.toBe("ok");
      expect(order).toEqual(["begin", "call", "finish"]);
      expect(executor.finishActivity.mock.calls).toEqual(executor.beginActivity.mock.calls);
    },
  );
  it("reloads the exact stale approval once without another approval click or server request", async () => {
    const { result, reload, browser } = await run();
    expect(result.outcome).toBe("refreshed");
    expect(reload).toHaveBeenCalledOnce();
    expect(browser.user.openTabs).toHaveBeenCalledOnce();
    expect(browser.user.claimTab).toHaveBeenCalledOnce();
  });
  it("forwards cancellation while still completing the native activity", async () => {
    const abort = new AbortController();
    const executor = {
      beginActivity: vi.fn(async () => {}),
      call: vi.fn(async (_args: unknown, context: { signal?: AbortSignal }) => {
        expect(_args).not.toHaveProperty("timeout_ms");
        expect(context.signal).toBe(abort.signal);
        abort.abort(new Error("watcher stopped"));
        throw abort.signal.reason;
      }),
      finishActivity: vi.fn(async () => {}),
    };
    await expect(
      synchronizeApprovedChromeConversation(executor, target, abort.signal),
    ).rejects.toThrow("watcher stopped");
    expect(executor.finishActivity.mock.calls).toEqual(executor.beginActivity.mock.calls);
  });
  it.each([{ responding: true }, { respondDuringRead: true }])(
    "preserves a response resumed behind a stale approval card %j",
    async (options) => {
      const { result, reload } = await run(options);
      expect(result.outcome).toBe("response_in_progress");
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it("matches a separate approval card to its originating user message", async () => {
    const { result, reload } = await run({
      standaloneApproval: true,
      userMessageId: "origin-user",
    });
    expect(result.outcome).toBe("refreshed");
    expect(reload).toHaveBeenCalledOnce();
  });
  it.each([
    {},
    { userMessageId: "other-user" },
    { userMessageId: "origin-user", laterMessage: true },
  ])(
    "retains an unmatched visible approval instead of falsely completing synchronization %j",
    async (options) => {
      const { result, reload } = await run({ standaloneApproval: true, ...options });
      expect(result.outcome).toBe("approval_identity_unresolved");
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it("recognizes a completed response with no approval card", async () => {
    const { result, reload } = await run({ approvalVisible: false });
    expect(result.outcome).toBe("approval_not_visible");
    expect(reload).not.toHaveBeenCalled();
  });
  it.each([{ draft: "Unsent note" }, { attached: true }])(
    "preserves unsent input %j",
    async (options) => {
      const { result, reload } = await run(options);
      expect(result.outcome).toBe("draft_preserved");
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it.each([{ laterMessage: true }, { pendingId: "another-operation" }])(
    "leaves a newer or completed operation untouched %j",
    async (options) => {
      const { result, reload } = await run(options);
      expect(result.outcome).toBe("approval_identity_unresolved");
      expect(reload).not.toHaveBeenCalled();
    },
  );
  it.each([[], [target.conversationUrl, target.conversationUrl]])(
    "does not create tabs or choose an ambiguous target %j",
    async (...urls) => {
      const { reload, browser } = await run({ urls: urls as string[] });
      expect(reload).not.toHaveBeenCalled();
      expect(browser.user.claimTab).not.toHaveBeenCalled();
    },
  );
  it("preserves a tab navigated by the owner during readback", async () => {
    const { result, reload } = await run({ navigateDuringRead: true });
    expect(result.outcome).toBe("conversation_changed");
    expect(reload).not.toHaveBeenCalled();
  });
  it("rejects untrusted routes and message selectors before browser access", () => {
    expect(() =>
      chromeApprovedConversationSyncCode({ ...target, conversationUrl: "https://example.com/" }),
    ).toThrow();
    expect(() =>
      chromeApprovedConversationSyncCode({ ...target, pendingMessageId: '"] *' }),
    ).toThrow();
  });
});
