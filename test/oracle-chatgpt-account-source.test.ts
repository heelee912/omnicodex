import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { desktopChatPrincipal } from "../src/infrastructure/chatgpt/desktop-chat-api-client.js";
import { ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION } from "../src/infrastructure/chatgpt/oracle-chatgpt-server-approval-script.js";
import { desktopChatAccountSourceId } from "../src/infrastructure/windows/desktop-chat-completion.js";

function token(auth: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url")}.signature`;
}

function read(session: unknown, pathname = "/api/auth/session") {
  const fetch = vi.fn(() => {
    throw new Error("unexpected HTTP");
  });
  const value = runInNewContext(ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION, {
    location: { origin: "https://chatgpt.com", pathname },
    document: { body: { innerText: JSON.stringify(session) } },
    atob,
    fetch,
  });
  expect(fetch).not.toHaveBeenCalled();
  return value;
}

describe("Oracle authenticated account source", () => {
  it.each([
    { chatgpt_account_id: "account-A", user_id: "user-A" },
    { account_id: "account-B", chatgpt_user_id: "user-B" },
  ])("matches the native Desktop principal without returning the token", (auth) => {
    const accessToken = token(auth);
    const value = read({ accessToken });
    expect(value).toBe(desktopChatAccountSourceId(desktopChatPrincipal(accessToken)));
    expect(value).not.toContain(accessToken);
  });

  it.each([
    {},
    { accessToken: "invalid" },
    { accessToken: token({ chatgpt_account_id: "A" }) },
    { accessToken: token({ chatgpt_account_id: "A:B", user_id: "U" }) },
    { accessToken: token({ chatgpt_account_id: "A", user_id: "U" }), account: { id: "B" } },
  ])("does not guess a principal from incomplete or contradictory metadata", (session) => {
    expect(read(session)).toBeNull();
  });

  it("does not read another page as an authenticated runtime", () => {
    expect(
      read({ accessToken: token({ account_id: "A", user_id: "U" }) }, "/c/example"),
    ).toBeNull();
  });
});
