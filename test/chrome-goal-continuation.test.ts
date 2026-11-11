import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  type ChromeGoalContinuationTarget,
  chromeGoalContinuationCode,
  continueChromeGoal,
  goalContinuationPrompt,
} from "../src/application/chrome-goal-continuation.js";

const target: ChromeGoalContinuationTarget = {
  goalId: "22222222-2222-4222-8222-222222222222",
  conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
  draft: { token: "draft-test", afterMessageId: "final-test", state: "dispatching" },
  operation: "send",
};

it("preserves the caller cancellation signal without adding a fixed browser deadline", async () => {
  const signal = new AbortController().signal;
  const executor = { beginActivity: vi.fn(), call: vi.fn(), finishActivity: vi.fn() };
  await continueChromeGoal(executor, target, signal);
  expect(executor.call.mock.calls[0]?.[0]).not.toHaveProperty("timeout_ms");
  expect(executor.call.mock.calls[0]?.[1]).toMatchObject({ signal });
  expect(executor.finishActivity).toHaveBeenCalledOnce();
});

function composer(
  initialDraft: string,
  enabled = true,
  tagName = "DIV",
  collapsedUserMessage = false,
) {
  let draft = initialDraft;
  let sent = false;
  const fill = vi.fn(async (value: string) => {
    draft = value;
  });
  const press = vi.fn(async () => {
    sent = true;
    draft = "";
  });
  const visible = () => [1];
  const wait = vi.fn((callback: () => void) => callback());
  const editor = {
    tagName,
    get value() {
      return tagName === "DIV" ? "" : draft;
    },
    get textContent() {
      return tagName === "DIV" ? draft : "";
    },
    getClientRects: visible,
    closest: () => ({ querySelectorAll: () => [] }),
  };
  const message = (id: string, role: string, textContent: string) => ({
    getClientRects: visible,
    getAttribute: (name: string) => (name === "data-message-id" ? id : role),
    textContent:
      role === "user" && collapsedUserMessage ? `${textContent}더 보기간단히` : textContent,
    querySelector: (selector: string) =>
      role === "user" &&
      collapsedUserMessage &&
      selector === '[data-testid="collapsible-user-message-content"]'
        ? { textContent }
        : null,
  });
  const document = {
    querySelector: () => editor,
    querySelectorAll: (selector: string) =>
      selector === "[data-message-id]"
        ? [
            message("final-test", "assistant", "Settled final"),
            ...(sent ? [message("next-user", "user", goalContinuationPrompt(target.goalId))] : []),
          ]
        : [],
  };
  const axGet = vi.fn(
    async (_mode?: "state", _options?: { disableDiffing?: boolean }) =>
      "23 button Description: 프롬프트 보내기, ID: composer-submit-button",
  );
  const tab = {
    url: async () => target.conversationUrl,
    ax: {
      get: axGet,
    },
    playwright: {
      evaluate: vi.fn(async (fn: unknown, arg: unknown) =>
        runInNewContext(`(${String(fn)})(arg)`, { document, arg }),
      ),
      locator: () => ({ fill }),
      getByTestId: () => ({
        press,
        isVisible: async () => true,
        isEnabled: async () => enabled,
        click: async () => {
          throw new Error("Pointer click must not dispatch the prompt");
        },
      }),
    },
  };
  const browser = {
    user: {
      openTabs: async () => [{ url: target.conversationUrl }],
      claimTab: vi.fn(async () => tab),
    },
    tabs: { new: vi.fn(async () => ({ ...tab, goto: vi.fn(), close: vi.fn() })) },
  };
  return {
    browser,
    tab,
    fill,
    axGet,
    press,
    wait,
    run: async (resumePreparedDraft = false) =>
      JSON.parse(
        await runInNewContext(
          `(async () => { ${chromeGoalContinuationCode({ ...target, resumePreparedDraft })} })()`,
          { browser, URL, setTimeout: wait },
        ),
      ),
  };
}

it.each(["DIV", "TEXTAREA", "INPUT"])(
  "reads the actual %s draft before any composer mutation",
  async (tagName) => {
    const occupied = composer("Existing draft", true, tagName);
    expect(await occupied.run()).toEqual({ outcome: "draft_preserved" });
    expect(occupied.fill).not.toHaveBeenCalled();
    expect(occupied.press).not.toHaveBeenCalled();
  },
);

it("resumes only an exactly matching draft with durable proof that no activation occurred", async () => {
  const prompt = goalContinuationPrompt(target.goalId);
  const owned = composer(prompt);
  expect(await owned.run(true)).toEqual({ outcome: "sent" });
  expect(owned.fill).not.toHaveBeenCalled();
  expect(owned.press).toHaveBeenCalledTimes(1);
  for (const [text, prepared] of [
    [prompt, false],
    ["User changed the draft", true],
  ] as const) {
    const other = composer(text);
    expect(await other.run(prepared)).toEqual({ outcome: "draft_preserved" });
    expect(other.fill).not.toHaveBeenCalled();
    expect(other.press).not.toHaveBeenCalled();
  }
});

it("continues the same conversation in a temporary view when another session owns its tab", async () => {
  const occupied = composer("");
  occupied.browser.user.claimTab.mockRejectedValueOnce(
    new Error("Tab 123 is already part of browser session other-session"),
  );
  expect(await occupied.run()).toEqual({ outcome: "sent" });
  expect(occupied.browser.tabs.new).toHaveBeenCalledOnce();
  const temporary = await occupied.browser.tabs.new.mock.results[0]?.value;
  expect(temporary.goto).toHaveBeenCalledWith(target.conversationUrl);
  expect(temporary.close).toHaveBeenCalledOnce();
  expect(occupied.press).toHaveBeenCalledOnce();
});

it("does not substitute a tab for unrelated browser failures", async () => {
  const disconnected = composer("");
  disconnected.browser.user.claimTab.mockRejectedValueOnce(new Error("Browser disconnected"));
  await expect(disconnected.run()).rejects.toThrow("Browser disconnected");
  expect(disconnected.browser.tabs.new).not.toHaveBeenCalled();
  expect(disconnected.press).not.toHaveBeenCalled();
});

it("waits for the new view's composer when the final answer has hydrated first", async () => {
  const loading = composer("");
  loading.browser.user.claimTab.mockRejectedValueOnce(
    new Error("Tab 123 is already part of browser session other-session"),
  );
  loading.tab.playwright.evaluate.mockResolvedValueOnce({
    present: true,
    sent: false,
    advanced: false,
    composer: false,
    draft: "",
    attachments: true,
    busy: false,
  });
  expect(await loading.run()).toEqual({ outcome: "sent" });
  expect(loading.press).toHaveBeenCalledOnce();
});

it("closes the temporary view after an uncertain activation without sending twice", async () => {
  const uncertain = composer("");
  uncertain.browser.user.claimTab.mockRejectedValueOnce(
    new Error("Tab 123 is already part of browser session other-session"),
  );
  uncertain.press.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  await expect(uncertain.run()).rejects.toThrow("Lost acknowledgement");
  const temporary = await uncertain.browser.tabs.new.mock.results[0]?.value;
  expect(temporary.close).toHaveBeenCalledOnce();
  expect(uncertain.press).toHaveBeenCalledOnce();
});

it("acknowledges the actual sent text when the user bubble also contains collapse controls", async () => {
  const collapsed = composer("", true, "DIV", true);
  expect(await collapsed.run()).toEqual({ outcome: "sent" });
  expect(collapsed.press).toHaveBeenCalledOnce();
});

it("does not treat an identical preexisting user message as this dispatch's receipt", async () => {
  const manual = composer("");
  // Populate a user bubble before the dispatcher observes this conversation.
  await manual.press();
  manual.press.mockClear();
  expect(await manual.run()).toEqual({ outcome: "superseded" });
  expect(manual.fill).not.toHaveBeenCalled();
  expect(manual.press).not.toHaveBeenCalled();
});

it("does not claim another caller's matching message arriving while the composer settles", async () => {
  const racing = composer("");
  racing.browser.user.claimTab.mockRejectedValueOnce(
    new Error("Tab 123 is already part of browser session other-session"),
  );
  const insert = racing.press.getMockImplementation();
  racing.wait.mockImplementation((callback) => {
    void insert?.();
    callback();
    return undefined;
  });
  expect(await racing.run()).toEqual({ outcome: "superseded" });
  expect(racing.fill).not.toHaveBeenCalled();
  expect(racing.press).not.toHaveBeenCalled();
});

it("uses the freshly observed accessibility index and rejects missing or ambiguous send controls", async () => {
  const fresh = composer("");
  fresh.axGet.mockResolvedValue("812 button Description: Send prompt, ID: composer-submit-button");
  expect(await fresh.run()).toEqual({ outcome: "sent" });
  expect(fresh.press).toHaveBeenCalledExactlyOnceWith("Enter");
  for (const state of [
    "812 button Description: Some other action, ID: other-button",
    "812 button ID: composer-submit-button\n813 button ID: composer-submit-button",
  ]) {
    const ambiguous = composer("");
    ambiguous.axGet.mockResolvedValue(state);
    expect(await ambiguous.run()).toEqual({ outcome: "inserted_not_sent" });
    expect(ambiguous.press).not.toHaveBeenCalled();
  }
});

it("requests a complete accessibility tree when the default snapshot is a diff", async () => {
  const repeated = composer("");
  repeated.axGet.mockImplementation(async (_mode, options) =>
    options?.disableDiffing
      ? "270 button Description: 프롬프트 보내기, ID: composer-submit-button"
      : "~\t270 button Description: 프롬프트 보내기, ID: composer-submit-button",
  );
  expect(await repeated.run()).toEqual({ outcome: "sent" });
  expect(repeated.press).toHaveBeenCalledExactlyOnceWith("Enter");
});

it("does not activation after a user changes the draft during accessibility inspection", async () => {
  const changed = composer("");
  changed.axGet.mockImplementation(async () => {
    await changed.fill("User changed the draft");
    return "23 button ID: composer-submit-button";
  });
  expect(await changed.run()).toEqual({ outcome: "inserted_not_sent" });
  expect(changed.press).not.toHaveBeenCalled();
});

it("waits for a freshly filled composer before its single send activation", async () => {
  const delayed = composer("");
  const send = delayed.press.getMockImplementation();
  let inputHandled = false;
  delayed.wait.mockImplementation((callback) => {
    if (delayed.fill.mock.calls.length > 0) inputHandled = true;
    callback();
  });
  delayed.press.mockImplementation(async () => {
    if (inputHandled) await send?.();
  });
  expect(await delayed.run()).toEqual({ outcome: "sent" });
  expect(delayed.press).toHaveBeenCalledOnce();
});

it("preserves a draft changed while the newly filled input settles", async () => {
  const changed = composer("");
  changed.wait.mockImplementation((callback) => {
    if (changed.fill.mock.calls.length > 0) void changed.fill("User replacement");
    callback();
  });
  expect(await changed.run()).toEqual({ outcome: "inserted_not_sent" });
  expect(changed.press).not.toHaveBeenCalled();
});

it("keeps the activity alive for asynchronous send acknowledgement without activationing again", async () => {
  const delayed = composer("");
  const send = delayed.press.getMockImplementation();
  delayed.press.mockImplementation(async () => {});
  delayed.wait.mockImplementation((callback) => {
    if (delayed.press.mock.calls.length > 0) void send?.();
    callback();
  });
  expect(await delayed.run()).toEqual({ outcome: "sent" });
  expect(delayed.press).toHaveBeenCalledOnce();

  const unconfirmed = composer("");
  unconfirmed.press.mockImplementation(async () => {});
  expect(await unconfirmed.run()).toEqual({ outcome: "send_unconfirmed" });
  expect(unconfirmed.press).toHaveBeenCalledOnce();
});

it("distinguishes proven pre-activation failure from a activation with an unknown result", async () => {
  const disabled = composer("", false);
  expect(await disabled.run()).toEqual({ outcome: "inserted_not_sent" });
  expect(disabled.fill).toHaveBeenCalledOnce();
  expect(disabled.press).not.toHaveBeenCalled();
  const uncertain = composer("", true);
  uncertain.press.mockRejectedValueOnce(new Error("Connection lost during activation"));
  await expect(uncertain.run()).rejects.toThrow("Connection lost during activation");
  expect(uncertain.press).toHaveBeenCalledOnce();
});
