import { describe, expect, it } from "vitest";
import { selectOracleGoalClient } from "../src/application/oracle-goal-client-routing.js";

const conversationUrl = "https://chatgpt.com/c/conversation-one";
const accountA = "chatgpt:account-a:user-a";
const accountB = "chatgpt:account-b:user-b";

function candidate(id: string, accountSourceId?: string, observed = false, primary = false) {
  return {
    client: { id, ...(accountSourceId === undefined ? {} : { accountSourceId }) },
    conversationUrls: new Set(observed ? [conversationUrl] : []),
    primary,
  };
}

describe("selectOracleGoalClient", () => {
  it("prefers the verified originating registration over the same-account primary", () => {
    const web = { ...candidate("web", accountA, true, true), connectorId: "asdk_app_web" };
    const second = { ...candidate("omnicodex2", accountA, true), connectorId: "asdk_app_second" };
    const target = { accountSourceId: accountA, conversationUrl, connectorId: second.connectorId };
    expect(selectOracleGoalClient(target, [web, second])).toBe(second.client);
    expect(selectOracleGoalClient(target, [web])).toBeUndefined();
    expect(
      selectOracleGoalClient(target, [
        web,
        { ...second, client: { id: "other", accountSourceId: accountB } },
      ]),
    ).toBeUndefined();
    // Existing Goals without provenance retain their successful primary route.
    expect(
      selectOracleGoalClient({ accountSourceId: accountA, conversationUrl }, [web, second]),
    ).toBe(web.client);
  });
  it("uses only the requested verified account and prefers its observed conversation", () => {
    const wrongAccount = candidate("wrong", accountB, true, true);
    const unverified = candidate("registered-only", undefined, true, true);
    const matchingPrimary = candidate("matching-primary", accountA, false, true);
    const matchingObserved = candidate("matching-observed", accountA, true);
    expect(
      selectOracleGoalClient({ accountSourceId: accountA, conversationUrl }, [
        wrongAccount,
        unverified,
        matchingPrimary,
        matchingObserved,
      ]),
    ).toBe(matchingObserved.client);
  });

  it("prefers the primary among matching observed clients, then the first matching observer", () => {
    const first = candidate("first", accountA, true);
    const primary = candidate("primary", accountA, true, true);
    const target = { accountSourceId: accountA, conversationUrl };
    expect(selectOracleGoalClient(target, [first, primary])).toBe(primary.client);
    expect(selectOracleGoalClient(target, [first, { ...primary, primary: false }])).toBe(
      first.client,
    );
  });

  it("falls back to a matching primary and then the first matching account only", () => {
    const wrong = candidate("wrong", accountB, false, true);
    const first = candidate("first", accountA);
    const primary = candidate("primary", accountA, false, true);
    const target = { accountSourceId: accountA, conversationUrl };
    expect(selectOracleGoalClient(target, [wrong, first, primary])).toBe(primary.client);
    expect(selectOracleGoalClient(target, [wrong, first, { ...primary, primary: false }])).toBe(
      first.client,
    );
  });

  it("does not substitute a registered or different-account client when the account is missing", () => {
    expect(
      selectOracleGoalClient({ accountSourceId: accountA, conversationUrl }, [
        candidate("registered", undefined, true, true),
        candidate("other-account", accountB, true),
      ]),
    ).toBeUndefined();
  });

  it("prefers an observed conversation over a primary when no account was assigned", () => {
    const observer = candidate("observer", accountB, true);
    expect(
      selectOracleGoalClient({ conversationUrl }, [
        candidate("primary", accountA, false, true),
        observer,
      ]),
    ).toBe(observer.client);
  });

  it("does not choose an unassigned target claimed by different verified accounts", () => {
    expect(
      selectOracleGoalClient({ conversationUrl }, [
        candidate("first", accountA, true, true),
        candidate("second", accountB, true),
      ]),
    ).toBeUndefined();
  });

  it("allows multiple observations belonging to the same verified account", () => {
    const primary = candidate("primary", accountA, true, true);
    expect(
      selectOracleGoalClient({ conversationUrl }, [candidate("first", accountA, true), primary]),
    ).toBe(primary.client);
  });

  it("uses a primary or a sole candidate only when no conversation was observed", () => {
    const first = candidate("first", accountA);
    const primary = candidate("primary", accountB, false, true);
    expect(selectOracleGoalClient({ conversationUrl }, [first, primary])).toBe(primary.client);
    expect(selectOracleGoalClient({ conversationUrl }, [first])).toBe(first.client);
    expect(
      selectOracleGoalClient({ conversationUrl }, [first, { ...primary, primary: false }]),
    ).toBeUndefined();
    expect(selectOracleGoalClient({ conversationUrl }, [])).toBeUndefined();
  });
});
