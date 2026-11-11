import { ORACLE_GOAL_CONVERSATION_SOURCE } from "./oracle-goal-conversation.js";

const ORACLE_APPROVAL_RUNTIME_QUERY = "omnicodex_oracle_runtime";

export const ORACLE_RATE_LIMIT_RESPONSE_HEADERS = [
  "retry-after",
  "x-request-id",
  "cf-ray",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
] as const;

export const ORACLE_CHATGPT_APPROVAL_RUNTIME_READY_EXPRESSION = `(() => {
  if (document.readyState !== "complete") return false;
  if (location.origin !== "https://chatgpt.com") return false;
  if (location.pathname === "/auth/error")
    return "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED";
  if (location.pathname !== "/api/auth/session") return false;
  try {
    const session = JSON.parse(document.body?.innerText ?? "");
    return typeof session?.accessToken === "string" && session.accessToken.length > 0
      ? true
      : "ORACLE_SERVER_APPROVAL_RUNTIME_AUTHENTICATION_REQUIRED";
  } catch {
    return "ORACLE_SERVER_APPROVAL_RUNTIME_SESSION_DOCUMENT_INVALID";
  }
})()`;

/** Read the existing authenticated runtime's principal, never its credential. No HTTP. */
export const ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION = `(() => {
  try {
    if (location.origin !== "https://chatgpt.com" || location.pathname !== "/api/auth/session") return null;
    const session = JSON.parse(document.body.innerText);
    const encoded = session.accessToken?.split(".")[1];
    if (!encoded) return null;
    const claims = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")));
    const auth = claims["https://api.openai.com/auth"];
    const accountId = auth?.chatgpt_account_id ?? auth?.account_id;
    const userId = auth?.user_id ?? auth?.chatgpt_user_id;
    if (typeof accountId !== "string" || !accountId || accountId.includes(":") ||
        typeof userId !== "string" || !userId || userId.includes(":")) return null;
    if (session.account?.id && session.account.id !== accountId) return null;
    return "chatgpt:" + accountId + ":" + userId;
  } catch { return null; }
})()`;

export function oracleChatGptApprovalRuntimeUrl(connectorId: string): string {
  assertConnectorId(connectorId);
  const url = new URL("https://chatgpt.com/api/auth/session");
  url.searchParams.set(ORACLE_APPROVAL_RUNTIME_QUERY, connectorId);
  return url.toString();
}

export function isOracleChatGptApprovalRuntimeUrl(value: string, connectorId: string): boolean {
  try {
    return value === oracleChatGptApprovalRuntimeUrl(connectorId);
  } catch {
    return false;
  }
}

/**
 * Runs inside one daemon-owned, signed-in Oracle ChatGPT page. It uses the
 * first-party ChatGPT request client and the first-party JIT approval response
 * shape discovered from the currently installed renderer. No access token or
 * cookie leaves the browser process.
 */
const ORACLE_CHATGPT_SERVER_APPROVAL_SCAN_SOURCE = String.raw`async function oracleChatGptServerApprovalScan(connectorId, connectorName, requestedConversationIds, acknowledgedReceiptIds, observationOptions) {
  const accountSourceId = ${ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION};
  const projectGoalConversation = ${ORACLE_GOAL_CONVERSATION_SOURCE};
  const legacyStateKey = "__omnicodexOracleServerApprovalV1";
  const stateKey = "__omnicodexOracleServerApprovalV2:" + connectorId;
  const durableStateKey = stateKey;
  const root = globalThis;
  const requestQueueRevisions = Object.create(null);
  const requestStats = {
    scanStartedAtUnixMs: Date.now(),
    trigger: observationOptions?.observeMessageStructure === true ? "observation"
      : requestedConversationIds.length > 0 ? "queued_request" : "idle",
    getCount: 0, postCount: 0, moduleInitializationCount: 0, rateLimitCount: 0,
    conversationIds: [], requests: [],
  };
  const reportRequestStats = (rateLimit) => {
    if (!observationOptions?.telemetryId) return;
    try {
      // Counts only: never serialize conversation identifiers, URLs, or bodies.
      console.debug("omnicodex-oracle-request-stats-v1", JSON.stringify({
        telemetryId: observationOptions.telemetryId,
        requestStats: {
          scanStartedAtUnixMs: requestStats.scanStartedAtUnixMs, trigger: requestStats.trigger,
          getCount: requestStats.getCount, postCount: requestStats.postCount,
          moduleInitializationCount: requestStats.moduleInitializationCount,
          rateLimitCount: requestStats.rateLimitCount, conversationIds: [], requests: [],
        },
        ...(rateLimit === undefined ? {} : { rateLimit: {
          status: 429, operation: rateLimit.operation,
          retryAtUnixMs: rateLimit.retryAtUnixMs, observedAtUnixMs: rateLimit.observedAtUnixMs,
          serverRetryAtUnixMs: rateLimit.serverRetryAtUnixMs,
          responseHeaders: { "retry-after": rateLimit.responseHeaders?.["retry-after"] },
        } }),
      }));
    } catch { /* Diagnostic delivery cannot affect native work. */ }
  };
  const recordRequest = (method, path, operation, conversationId) => {
    if (method === "GET") requestStats.getCount += 1;
    else if (method === "POST") requestStats.postCount += 1;
    if (conversationId !== undefined && !requestStats.conversationIds.includes(conversationId)) {
      requestStats.conversationIds.push(conversationId);
    }
    const trigger = observationOptions?.observeMessageStructure === true ? "observation"
      : conversationId === undefined ? requestStats.trigger
      : requestedConversationIds.includes(conversationId) ? "queued_request" : "recovery";
    const queueRevision = requestQueueRevisions[conversationId];
    requestStats.requests.push({ method, path: new URL(path, "https://chatgpt.com").pathname,
      operation, trigger, ...(conversationId === undefined ? {} : { conversationId }),
      ...(typeof queueRevision === "string" ? { queueRevision } : {}) });
    reportRequestStats();
  };
  let storageFailure = null;
  const recordStorageFailure = (operation) => {
    storageFailure ??= {
      conversationId: "account",
      operation,
      error: "ORACLE_APPROVAL_DURABILITY_UNAVAILABLE",
      observedAtUnixMs: Date.now(),
    };
  };
  const recordFrom = (value) => {
    const record = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return record;
    for (const [key, entry] of Object.entries(value)) record[key] = entry;
    return record;
  };
  const durable = (() => {
    try {
      if (!root.localStorage || typeof root.localStorage.getItem !== "function") {
        throw new Error("Oracle approval storage is unavailable");
      }
      const parsed = JSON.parse(root.localStorage.getItem(durableStateKey) || "null");
      return parsed &&
        typeof parsed === "object" &&
        (parsed.version === 2 || parsed.version === 3 || parsed.version === 4 || parsed.version === 5 || parsed.version === 6 || parsed.version === 7 || parsed.version === 8)
        ? parsed
        : null;
    } catch {
      recordStorageFailure("oracle_state_read");
      return null;
    }
  })();
  // Migrate the live V1 object once so deploying this fix does not discard the
  // account watermark that the existing Oracle renderer already established.
  const restored = durable || root[legacyStateKey] || null;
  const state = root[stateKey] || {
    module: restored?.module ?? null,
    requestClient: restored?.requestClient ?? null,
    assetPath: typeof restored?.assetPath === "string" ? restored.assetPath : null,
    handled: recordFrom(restored?.handled),
    receiptOutbox: recordFrom(restored?.receiptOutbox),
    inFlight: recordFrom(restored?.inFlight),
    pendingConversations: recordFrom(restored?.pendingConversations),
    pendingConversationRevisions: recordFrom(restored?.pendingConversationRevisions),
    activeConversationRecovery: recordFrom(restored?.activeConversationRecovery),
    confirmedGoalCompletionFinalIds: recordFrom(restored?.confirmedGoalCompletionFinalIds),
    deletedConversations: recordFrom(restored?.deletedConversations),
    expectedApprovals: recordFrom(restored?.expectedApprovals),
    lastScanAt: Number(restored?.lastScanAt ?? restored?.lastHeadScanAt) || 0,
    backoffUntil: Number(restored?.backoffUntil) || 0,
    backoffMs: Number(restored?.backoffMs) || 300_000,
    lastRateLimit: restored?.lastRateLimit ?? null,
    drains: new Set(),
  };
  if (accountSourceId !== null && state.lastRateLimit?.accountSourceId &&
      state.lastRateLimit.accountSourceId !== accountSourceId) {
    state.backoffUntil = 0;
    state.backoffMs = 300_000;
    state.lastRateLimit = null;
  }
  // Do not install an empty runtime after a failed read: it would shadow the
  // durable in-flight identities when storage becomes readable again.
  if (storageFailure === null) root[stateKey] = state;
  if (!state.pendingConversations || typeof state.pendingConversations !== "object") {
    state.pendingConversations = Object.create(null);
  }
  if (!state.pendingConversationRevisions || typeof state.pendingConversationRevisions !== "object") {
    state.pendingConversationRevisions = Object.create(null);
  }
  if (!state.receiptOutbox || typeof state.receiptOutbox !== "object") {
    state.receiptOutbox = Object.create(null);
  }
  if (!state.activeConversationRecovery || typeof state.activeConversationRecovery !== "object") {
    state.activeConversationRecovery = Object.create(null);
  }
  state.confirmedGoalCompletionFinalIds ??= recordFrom(restored?.confirmedGoalCompletionFinalIds);
  state.confirmedGoalCompletionTurnIds ??= recordFrom(restored?.confirmedGoalCompletionTurnIds);
  // Immutable tool bodies belong only to this renderer's account and active
  // recovery lifecycle. Never serialize them into the durable queue.
  if (accountSourceId === null || state.goalBodyAccountSourceId !== accountSourceId) {
    state.goalBodyAccountSourceId = accountSourceId;
    state.goalBodyRecovery = Object.create(null);
  }
  state.goalBodyRecovery ??= Object.create(null);
  if (!state.expectedApprovals || typeof state.expectedApprovals !== "object") {
    state.expectedApprovals = Object.create(null);
  }
  if (!state.deletedConversations || typeof state.deletedConversations !== "object") {
    state.deletedConversations = Object.create(null);
  }
  // The consumer acknowledges only after its authoritative receipt sink commits.
  // Losing a CDP response therefore replays evidence, never the approval action.
  for (const id of acknowledgedReceiptIds) delete state.receiptOutbox[id];
  const persistState = () => {
    for (const id of Object.keys(state.goalBodyRecovery)) {
      if (state.activeConversationRecovery[id]?.awaitingGoalCompletion !== true)
        delete state.goalBodyRecovery[id];
    }
    try {
      if (!root.localStorage || typeof root.localStorage.setItem !== "function") {
        throw new Error("Oracle approval storage is unavailable");
      }
      root.localStorage.setItem(
        durableStateKey,
        JSON.stringify({
          version: 8,
          assetPath: typeof state.assetPath === "string" ? state.assetPath : null,
          handled: state.handled,
          receiptOutbox: state.receiptOutbox,
          inFlight: state.inFlight,
          pendingConversations: state.pendingConversations,
          pendingConversationRevisions: state.pendingConversationRevisions,
          activeConversationRecovery: state.activeConversationRecovery,
          confirmedGoalCompletionFinalIds: state.confirmedGoalCompletionFinalIds,
          confirmedGoalCompletionTurnIds: state.confirmedGoalCompletionTurnIds,
          deletedConversations: state.deletedConversations,
          expectedApprovals: state.expectedApprovals,
          lastScanAt: Number(state.lastScanAt) || 0,
          backoffUntil: Number(state.backoffUntil) || 0,
          backoffMs: Number(state.backoffMs) || 300_000,
          lastRateLimit: state.lastRateLimit ?? null,
        }),
      );
      return true;
    } catch {
      recordStorageFailure("oracle_state_persist");
      return false;
    }
  };
  const errorText = (error) => {
    const name = typeof error?.name === "string" ? error.name : "Error";
    const message = typeof error?.message === "string" ? error.message : String(error);
    return (name + ":" + message).slice(0, 500);
  };
  const rateLimited = (error) =>
    [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status].some(
      (status) => Number(status) === 429,
    ) || /too many requests|rate.?limit|\b429\b/i.test(errorText(error));
  // Only exact request targets and durable unconfirmed submissions are read.
  // Idle or unattributed activity never enumerates the account conversation list.
  const activeScanMs = 5_000;
  const initialRateLimitBackoffMs = 30_000;
  // Local automatic-retry pacing is not a server deadline. Retire persisted
  // exponential waits from the previous runtime. A shared-account cooldown is
  // derivative state: the daemon coordinator separately retains any real
  // Retry-After deadline and applies it before this script is evaluated.
  const legacyAdaptiveLocal = state.lastRateLimit?.adaptiveRetry === true &&
    !(Number(state.lastRateLimit.serverRetryAtUnixMs) > 0);
  const derivativeSharedCooldown = state.lastRateLimit?.operation === "shared_account_cooldown";
  if (state.lastRateLimit?.observedAtUnixMs != null &&
      (legacyAdaptiveLocal || derivativeSharedCooldown)) {
    const serverRetryAtUnixMs = derivativeSharedCooldown
      ? 0 : Number(state.lastRateLimit.serverRetryAtUnixMs) || 0;
    const retryAt = Math.max(Number(state.lastRateLimit.observedAtUnixMs) + initialRateLimitBackoffMs,
      serverRetryAtUnixMs);
    const { adaptiveRetry: _adaptiveRetry, serverRetryAtUnixMs: _serverRetryAtUnixMs,
      ...previousRateLimit } = state.lastRateLimit;
    state.backoffUntil = retryAt;
    state.backoffMs = initialRateLimitBackoffMs;
    state.lastRateLimit = { ...previousRateLimit, retryAtUnixMs: retryAt,
      localBackoffMs: initialRateLimitBackoffMs,
      backoffSource: serverRetryAtUnixMs >= retryAt ? "server_retry_after" : "local_backoff",
      ...(serverRetryAtUnixMs > 0 ? { serverRetryAtUnixMs } : {}) };
    persistState();
  }
  const diagnosticHeaders = (error) => {
    const headers = error?.response?.headers ?? error?.headers ?? error?.cause?.response?.headers ?? error?.cause?.headers;
    const responseHeaders = {};
    for (const name of ${JSON.stringify(ORACLE_RATE_LIMIT_RESPONSE_HEADERS)}) {
      const value = typeof headers?.get === "function"
        ? headers.get(name)
        : Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
      if (typeof value === "string") responseHeaders[name] = value;
    }
    return responseHeaders;
  };
  const responseStatus = (value) => [value?.status, value?.statusCode, value?.response?.status, value?.cause?.status]
    .find((status) => Number.isInteger(status) && status >= 100 && status <= 599);
  const submissionUncertain = (status) => status === undefined || status === 408 || status >= 500;
  const operationFailure = (id, operation, error) => ({
    conversationId: id,
    error: errorText(error),
    ...(responseStatus(error) === undefined ? {} : { status: responseStatus(error) }),
    operation,
    observedAtUnixMs: Date.now(),
    responseHeaders: diagnosticHeaders(error),
  });
  const submissionFailure = (id, response, message) => ({
    conversationId: id,
    error: message ?? "Error:chatgpt_approval_http_" + response.status,
    ...(responseStatus(response) === undefined ? {} : { status: responseStatus(response) }),
    submissionState: submissionUncertain(responseStatus(response)) ? "unknown" : "rejected",
    operation: "approval_submission",
    observedAtUnixMs: Date.now(),
    responseHeaders: diagnosticHeaders(response),
  });
  const markRateLimited = (error, operation, conversationId) => {
    requestStats.rateLimitCount += 1;
    const observedAtUnixMs = Date.now();
    const responseHeaders = diagnosticHeaders(error);
    const retryAfter = responseHeaders["retry-after"]?.trim();
    const parsedDeadline = !retryAfter ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? observedAtUnixMs + Math.ceil(Number(retryAfter) * 1_000)
      : Date.parse(retryAfter);
    const serverRetryAtUnixMs = Number.isSafeInteger(parsedDeadline) && parsedDeadline >= 0
      ? Math.max(observedAtUnixMs, parsedDeadline) : undefined;
    const recovery = state.activeConversationRecovery[conversationId];
    // Repeated automatic readback failure is not fresh user activity. Retain
    // its increasing retry interval in the existing durable recovery record;
    // successful readback replaces/removes that record and resets the interval.
    const localBackoffMs = initialRateLimitBackoffMs;
    if (recovery?.awaitingGoalCompletion === true) {
      recovery.rateLimitBackoffMs = Math.min(1_800_000, Math.max(initialRateLimitBackoffMs,
        (Number(recovery.rateLimitBackoffMs) || 0) * 2));
      recovery.nextReadAt = observedAtUnixMs + recovery.rateLimitBackoffMs;
    }
    const serverWaitMs = serverRetryAtUnixMs === undefined ? 0 : serverRetryAtUnixMs - observedAtUnixMs;
    const waitMs = Math.max(localBackoffMs, serverWaitMs);
    state.backoffUntil = observedAtUnixMs + waitMs;
    state.backoffMs = localBackoffMs;
    state.lastRateLimit = {
      ...(accountSourceId === null ? {} : { accountSourceId }),
      status: 429, operation, retryAtUnixMs: state.backoffUntil, observedAtUnixMs,
      statusEvidence: [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status].some((status) => Number(status) === 429) ? "http_status" : "error_text",
      backoffSource: serverRetryAtUnixMs !== undefined && serverWaitMs >= localBackoffMs ? "server_retry_after" : "local_backoff",
      localBackoffMs, responseHeaders,
      ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }),
    };
    reportRequestStats(state.lastRateLimit);
    persistState();
  };
  const exactStringIn = (value, wantedId, wantedName, depth) => {
    if (depth > 8 || value == null) return false;
    if (typeof value === "string") {
      const normalized = value.trim().toLocaleLowerCase();
      return normalized === wantedId || normalized === wantedName || value.includes(connectorId);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => exactStringIn(entry, wantedId, wantedName, depth + 1));
    }
    if (typeof value === "object") {
      return Object.values(value).some((entry) =>
        exactStringIn(entry, wantedId, wantedName, depth + 1),
      );
    }
    return false;
  };
  const fetchRuntimeText = async (url) => {
    recordRequest("GET", url, "runtime_initialization");
    const response = await fetch(url);
    if (!response.ok) {
      const error = new Error("chatgpt_runtime_http_" + response.status);
      error.status = response.status;
      error.headers = response.headers;
      throw error;
    }
    return response.text();
  };
  const ensureModule = async () => {
    if (state.module && state.requestClient?.safeGet && state.requestClient?.request) {
      return { module: state.module, requestClient: state.requestClient };
    }
    const html = await fetchRuntimeText("/");
    if (!document.getElementById("client-bootstrap")) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const bootstrap = parsed.getElementById("client-bootstrap")?.textContent;
      if (!bootstrap) throw new Error("client_bootstrap_not_found");
      const script = document.createElement("script");
      script.id = "client-bootstrap";
      script.type = "application/json";
      script.textContent = bootstrap;
      document.head.appendChild(script);
    }
    const candidates = [...new Set(
      [...html.matchAll(/\/cdn\/assets\/[A-Za-z0-9_-]+\.js/g)].map((match) => match[0]),
    )];
    if (state.assetPath && !candidates.includes(state.assetPath)) state.assetPath = null;
    const ordered = state.assetPath
      ? [state.assetPath, ...candidates.filter((candidate) => candidate !== state.assetPath)]
      : candidates;
    const contractCandidates = [];
    for (const candidate of ordered) {
      const source = await fetchRuntimeText(candidate);
      if (!source.includes("sentinel/chat-requirements/prepare")) continue;
      // Minified export aliases change independently of the native functions.
      // Resolve each role from this asset's definitions before invoking any
      // initializer; an old callable alias can now be an unrelated function.
      const nativeModule = await import(candidate);
      const exportStart = source.lastIndexOf("export{");
      const exportTail = exportStart < 0 ? "" : source.slice(exportStart + 7);
      const exportedAs = (symbol) => {
        if (!symbol) return undefined;
        const escaped = symbol.replaceAll("$", "\\$");
        return exportTail.match(
          new RegExp("(?:^|,)" + escaped + " as ([A-Za-z0-9$_]+)(?:,|})"),
        )?.[1];
      };
      const enclosingFunction = (anchor) => {
        const index = source.indexOf(anchor);
        if (index < 0) return undefined;
        return [...source.slice(0, index).matchAll(/function ([A-Za-z$_][A-Za-z0-9$_]*)\(/g)].at(-1)?.[1];
      };
      const safeGetIndex = source.indexOf("safeGet(");
      const headerIndex = source.indexOf("OpenAI-Sentinel-Chat-Requirements-Token");
      const requestInitializer = safeGetIndex < 0 ? undefined
        : [...source.slice(0, safeGetIndex).matchAll(/([A-Za-z$_][A-Za-z0-9$_]*)=e\(\(\(\)=>\{/g)].at(-1)?.[1];
      const sentinelInitializer = headerIndex < 0 ? undefined
        : source.slice(headerIndex).match(/([A-Za-z$_][A-Za-z0-9$_]*)=e\(\(\(\)=>\{/ )?.[1];
      const clientSymbol = safeGetIndex < 0 ? undefined : source.slice(safeGetIndex).match(
        /([A-Za-z$_][A-Za-z0-9$_]*)=new [A-Za-z$_][A-Za-z0-9$_]*\(\{includeBusinessAgentPreviewSession:!0,baseUrl:/,
      )?.[1];
      const requirementsSymbol = source.match(
        /function ([A-Za-z$_][A-Za-z0-9$_]*)\([^{}]*\)\{return [A-Za-z$_][A-Za-z0-9$_]*\(\x60finalized\x60,/,
      )?.[1];
      const enforcementPair = source.match(
        /([A-Za-z$_][A-Za-z0-9$_]*)\.getEnforcementToken\(([A-Za-z$_][A-Za-z0-9$_]*),\{forceSync:!0\}\),([A-Za-z$_][A-Za-z0-9$_]*)\.getEnforcementToken\(\2\)/,
      );
      const roles = {
        requestInitializer: exportedAs(requestInitializer),
        sentinelInitializer: exportedAs(sentinelInitializer),
        requestClient: exportedAs(clientSymbol),
        requirements: exportedAs(requirementsSymbol),
        sentinel: exportedAs(enclosingFunction("window.SentinelSDK.token(")),
        headers: exportedAs(enclosingFunction("OpenAI-Sentinel-Chat-Requirements-Token")),
        proof: exportedAs(enforcementPair?.[1]),
        turnstile: exportedAs(enforcementPair?.[3]),
      };
      if (Object.values(roles).some((role) => role === undefined) ||
          [roles.requestInitializer, roles.sentinelInitializer, roles.requirements,
            roles.sentinel, roles.headers].some((role) => typeof nativeModule[role] !== "function")) {
        contractCandidates.push(candidate + ":" + JSON.stringify(roles));
        continue;
      }
      for (const initializer of new Set([roles.requestInitializer, roles.sentinelInitializer])) {
        requestStats.moduleInitializationCount += 1;
        reportRequestStats();
        nativeModule[initializer]();
      }
      const requestClient = nativeModule[roles.requestClient];
      const module = {
        Eo: nativeModule[roles.requirements],
        Fo: nativeModule[roles.sentinel],
        Ao: nativeModule[roles.headers],
        Uo: nativeModule[roles.proof],
        zo: nativeModule[roles.turnstile],
      };
      const valid =
        typeof module.Eo === "function" &&
        typeof module.Fo === "function" &&
        typeof module.Ao === "function" &&
        typeof module.Uo?.getEnforcementToken === "function" &&
        typeof module.zo?.getEnforcementToken === "function" &&
        typeof requestClient?.safeGet === "function" &&
        typeof requestClient?.request === "function";
      if (!valid) {
        contractCandidates.push(candidate + ":initialized_contract_invalid:" + JSON.stringify(roles));
        continue;
      }
      state.assetPath = candidate;
      state.module = module;
      state.requestClient = requestClient;
      return { module, requestClient };
    }
    state.assetPath = null;
    throw new Error(
      "chatgpt_request_contract_changed:" + contractCandidates.join("|").slice(0, 1000),
    );
  };
  const scanStartedAt = Date.now();
  if (observationOptions?.observeGoalsOnly === true) {
    // Additional observers read only the event-nominated conversation. They
    // never drain the primary writer's pending approvals or receipt outbox.
    const result = { requestStats, outcome: "ok", examined: 0, discovered: 0,
      approvalsPending: 0, followUpScanRequired: false, conversationUrls: [], receipts: [], errors: [] };
    const id = requestedConversationIds[0];
    if (storageFailure !== null) return { ...result, outcome: "partial", errors: [storageFailure] };
    const nextScanAtUnixMs = Math.max(Number(state.backoffUntil) || 0,
      (Number(state.lastScanAt) || 0) + activeScanMs);
    if (nextScanAtUnixMs > scanStartedAt) return { ...result, nextScanAtUnixMs,
      outcome: Number(state.backoffUntil) > scanStartedAt ? "partial" : "ok",
      ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit }) };
    state.lastScanAt = scanStartedAt;
    if (!persistState()) return { ...result, outcome: "partial", errors: [storageFailure] };
    try {
      const { requestClient } = await ensureModule();
      // Goal events nominate the current turn. Reading that turn also exposes
      // its explicit parent ids, including the preceding continuation
      // checkpoint, without downloading the conversation's historical mapping.
      const path = "/conversations/" + encodeURIComponent(id);
      recordRequest("GET", path, "goal_observation", id);
      const conversation = await requestClient.safeGet(path, {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      if (conversation?.conversation_id !== undefined && conversation.conversation_id !== id)
        throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
      if (conversation?.id !== undefined && conversation.id !== id)
        throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
      return { ...result, examined: 1,
        goalConversations: [projectGoalConversation(id, conversation, connectorId)] };
    } catch (error) {
      if (rateLimited(error)) markRateLimited(error, "goal_observation");
      return { ...result, outcome: "partial", errors: [operationFailure(id, "goal_observation", error)],
        ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit,
          nextScanAtUnixMs: state.backoffUntil }) };
    }
  }
  if (observationOptions?.observeMessageStructure === true) {
    // A fixed diagnostic operation, not an approval scan or a code evaluator.
    // Never initialize another browser/client, acknowledge receipts, enqueue
    // work, or submit approvals while observing a single existing conversation.
    const id = requestedConversationIds[0];
    const result = { requestStats, outcome: "ok", examined: 0, discovered: 0, approvalsPending: 0,
      followUpScanRequired: false, conversationUrls: [], receipts: [], errors: [] };
    if (storageFailure !== null) return { ...result, outcome: "partial", errors: [storageFailure] };
    const nextScanAtUnixMs = Math.max(Number(state.backoffUntil) || 0,
      (Number(state.lastScanAt) || 0) + activeScanMs);
    if (nextScanAtUnixMs > scanStartedAt) return { ...result,
      outcome: Number(state.backoffUntil) > scanStartedAt ? "partial" : "ok",
      nextScanAtUnixMs,
      ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit }) };
    if (typeof state.requestClient?.safeGet !== "function") return { ...result,
      outcome: "partial", errors: [{ conversationId: id, operation: "message_structure_observation",
        error: "ORACLE_OBSERVATION_EXISTING_CLIENT_UNAVAILABLE" }] };
    state.lastScanAt = scanStartedAt;
    if (!persistState()) return { ...result, outcome: "partial", errors: [storageFailure] };
    try {
      recordRequest("GET", "/conversations/" + encodeURIComponent(id), "message_structure_observation", id);
      const conversation = await state.requestClient.safeGet("/conversations/" + encodeURIComponent(id), {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
      let previousPage;
      if (observationOptions.observePreviousPage === true && conversation.page_info?.has_previous_page === true) {
        const before = conversation.page_info.start_cursor;
        if (typeof before !== "string" || before.length === 0) throw new Error("ORACLE_GOAL_BODY_READBACK_INCOMPLETE");
        recordRequest("GET", "/conversations/" + encodeURIComponent(id) + "/messages", "goal_observation", id);
        const page = await state.requestClient.safeGet("/conversations/{conversation_id}/messages", {
          parameters: { path: { conversation_id: id }, query: { before, include_has_versions: true, num_turns: 1 } }, disableAutomaticRetry: true,
        });
        if (page?.conversation_id !== undefined && page.conversation_id !== id) throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
        previousPage = { messageCount: Array.isArray(page?.messages) ? page.messages.length : 0,
          hasPreviousPage: page?.page_info?.has_previous_page === true,
          cursorAdvanced: typeof page?.page_info?.start_cursor === "string" && page.page_info.start_cursor !== before };
      }
      const currentNode = typeof conversation?.current_node === "string" ? conversation.current_node : undefined;
      const current = currentNode === undefined ? undefined : messages.find((message) => message?.id === currentNode);
      const currentMessage = current === undefined ? undefined : {
        id: currentNode,
        ...(typeof current.author?.role === "string" ? { authorRole: current.author.role } : {}),
        ...(typeof current.status === "string" ? { status: current.status } : {}),
        ...(typeof current.end_turn === "boolean" || current.end_turn === null ? { endTurn: current.end_turn } : {}),
        ...(typeof current.channel === "string" || current.channel === null ? { channel: current.channel } : {}),
        ...(typeof current.metadata?.is_complete === "boolean" ? { isComplete: current.metadata.is_complete } : {}),
        ...(typeof current.metadata?.working_turn_id === "string" ? { workingTurnId: current.metadata.working_turn_id } : {}),
        ...(typeof current.metadata?.turn_exchange_id === "string" ? { turnExchangeId: current.metadata.turn_exchange_id } : {}),
      };
      const canonicalResources = (message) => {
        const candidates = [];
        if (observationOptions.canonicalResourceOrigin === undefined ||
            message?.author?.role !== "tool" || message?.author?.name !== "api_tool.call_tool") return candidates;
        const add = (value, path) => {
          if (typeof value !== "string") return;
          try {
            const parsed = new URL(value);
            if (parsed.origin !== observationOptions.canonicalResourceOrigin ||
                parsed.username !== "" || parsed.password !== "" || parsed.search !== "" ||
                parsed.hash !== "" || parsed.href !== value) return;
            const matched = /^\/resources\/([A-Za-z0-9_-]{43})$/.exec(parsed.pathname);
            if (matched) candidates.push({ path, resourceId: matched[1] });
          } catch { /* Noncanonical attachment values are not resource identities. */ }
        };
        if (Array.isArray(message.metadata?.attachments)) message.metadata.attachments.forEach((attachment, index) =>
          add(attachment?.download_url, '$["metadata"]["attachments"][' + index + ']["download_url"]'));
        add(message.metadata?.invoked_resource?.resource_uri, '$["metadata"]["invoked_resource"]["resource_uri"]');
        return candidates;
      };
      const keys = (value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value) : [];
      const shape = (message) => {
        const invokedGoalResourceUri = message?.metadata?.invoked_resource?.resource_uri;
        const exactGoalResource = typeof invokedGoalResourceUri === "string" &&
          /^\/[A-Za-z0-9_-]+\/link_[a-z0-9]+\/omnicodex__goal_(?:create|get|claim_next_step|complete|update)$/.test(invokedGoalResourceUri);
        const projectedGoal = projectGoalConversation(id, { messages: [message] }, connectorId).goals[0];
        const observedGoal = projectedGoal === undefined ? undefined : (({ messageId, ...goal }) => goal)(projectedGoal);
        const resources = [];
        const containers = [];
        const stack = [{ value: message, path: "$" }];
        while (stack.length > 0) {
          const { value, path } = stack.pop();
          // ChatGPT may encode the complete tool result in content.text/code
          // rather than retain its MCP objects directly. Project JSON keys
          // from that same response; never return the serialized text itself.
          if (typeof value === "string") {
            try {
              const decoded = JSON.parse(value);
              if (decoded && typeof decoded === "object") stack.push({ value: decoded, path: path + "#json" });
            } catch { /* Ordinary prose and non-JSON code have no structural projection. */ }
            continue;
          }
          if (!value || typeof value !== "object") continue;
          if (Array.isArray(value)) {
            for (let i = value.length - 1; i >= 0; i -= 1)
              stack.push({ value: value[i], path: path + "[" + i + "]" });
            continue;
          }
          containers.push({ path, keys: keys(value) });
          if (value.type === "resource_link") resources.push({ path, keys: keys(value), uriType: typeof value.uri });
          for (const [key, child] of Object.entries(value)) {
            stack.push({ value: child, path: path + "[" + JSON.stringify(key) + "]" });
          }
        }
        return { id: typeof message?.id === "string" ? message.id : null,
          ...(exactGoalResource ? { invokedGoalResourceUri } : {}),
          authorRole: typeof message?.author?.role === "string" ? message.author.role : null,
          authorName: typeof message?.author?.name === "string" ? message.author.name : null,
          ...(observedGoal === undefined ? {} : { goalResult: observedGoal }),
          contentType: typeof message?.content?.content_type === "string" ? message.content.content_type : null,
          referencesConnector: exactStringIn(message, connectorId.toLocaleLowerCase(), connectorName.trim().toLocaleLowerCase(), 0),
          topLevelKeys: keys(message), metadataKeys: keys(message?.metadata), containers, resourceLinks: resources,
          ...(observationOptions.canonicalResourceOrigin === undefined ? {} : { canonicalResources: canonicalResources(message) }) };
      };
      let branchStructure;
      if (observationOptions.observeBranchStructure === true) {
        // Diagnose only the already-read current turn. Explicit parent ids
        // preserve its branch shape without downloading the full mapping.
        const native = conversation;
        const mapping = Object.fromEntries(messages.filter(message => typeof message?.id === "string")
          .map(message => [message.id, { message,
            parent: message.parent_id ?? message.metadata?.parent_id ?? null }]));
        const chain = [];
        const seen = new Set();
        let cursor = native.current_node;
        let termination = "invalid_parent";
        while (typeof cursor === "string") {
          if (seen.has(cursor)) { termination = "cycle"; break; }
          seen.add(cursor);
          const node = mapping[cursor];
          if (!node) { termination = "missing_node"; break; }
          chain.push({ nodeId: cursor, messageId: typeof node.message?.id === "string" ? node.message.id : null,
            authorRole: typeof node.message?.author?.role === "string" ? node.message.author.role : null,
            parent: typeof node.parent === "string" ? node.parent : null,
            parentPresent: Object.hasOwn(node, "parent") });
          cursor = node.parent;
          if (cursor === null) { termination = "root"; break; }
        }
        const goalMessageIds = messages.filter(message => projectGoalConversation(id, { messages: [message] }, connectorId).goals.length > 0).map(message => message.id);
        branchStructure = { currentNode: typeof native.current_node === "string" ? native.current_node : null,
          chain, termination, stoppedAt: typeof cursor === "string" ? cursor : null,
          goalNodes: goalMessageIds.map(messageId => ({ messageId,
            nodeIds: Object.keys(mapping).filter(key => mapping[key]?.message?.id === messageId),
            onCurrentBranch: chain.some(node => node.messageId === messageId),
            shapes: Object.values(mapping).filter(node => node?.message?.id === messageId).map(node => {
              const message = node.message;
              let decoded; let jsonValid = false; try { decoded = JSON.parse(message.content?.text); jsonValid = true; } catch {}
              let nested; if (typeof decoded === "string") { try { nested = JSON.parse(decoded); } catch {} }
              return { authorRole: typeof message.author?.role === "string" ? message.author.role : null,
                authorName: typeof message.author?.name === "string" ? message.author.name : null,
                status: typeof message.status === "string" ? message.status : null,
                contentKeys: keys(message.content), textType: typeof message.content?.text,
                textLength: typeof message.content?.text === "string" ? message.content.text.length : 0,
                jsonValid, decodedType: Array.isArray(decoded) ? "array" : decoded === null ? "null" : typeof decoded,
                nestedDecodedKeys: keys(nested),
                decodedKeys: keys(decoded), acceptedGoal: projectGoalConversation(id, { messages: [message] }, connectorId).goals.length > 0 };
            }) })),
          pluralParents: messages.map(message => ({ messageId: typeof message?.id === "string" ? message.id : null,
            parentId: typeof message?.parent_id === "string" ? message.parent_id : null,
            metadataParentId: typeof message?.metadata?.parent_id === "string" ? message.metadata.parent_id : null })) };
      }
      return { ...result, examined: 1, discovered: 1,
        messageStructureObservation: { conversationId: id, conversationKeys: keys(conversation), messages: messages.map(shape),
          ...(previousPage === undefined ? {} : { previousPage }),
          ...(conversation.page_info && typeof conversation.page_info === "object" ? { pageInfo: Object.fromEntries(Object.entries(conversation.page_info).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))) } : {}),
          ...(branchStructure === undefined ? {} : { branchStructure }),
          goalConversation: projectGoalConversation(id, conversation, connectorId),
          ...(currentNode === undefined ? {} : { currentNode }),
          ...(currentMessage === undefined ? {} : { currentMessage }) },
        nextScanAtUnixMs: Math.max(Number(state.backoffUntil) || 0, Date.now() + activeScanMs) };
    } catch (error) {
      if (rateLimited(error)) markRateLimited(error, "message_structure_observation");
      return { ...result, outcome: "partial", examined: 1,
        errors: [{ conversationId: id, operation: "message_structure_observation",
          error: "ORACLE_MESSAGE_STRUCTURE_READ_FAILED",
          ...(responseStatus(error) === undefined ? {} : { status: responseStatus(error) }) }],
        nextScanAtUnixMs: Math.max(Number(state.backoffUntil) || 0, Date.now() + activeScanMs),
        ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit }) };
    }
  }
  const confirmedGoalCompletions = new Set((observationOptions?.goalCompletionReceipts ?? []).filter(id => {
    const incoming = observationOptions?.goalCompletionFinalIds?.[id] ?? [];
    const confirmed = state.confirmedGoalCompletionFinalIds[id];
    const turns = observationOptions?.goalCompletionTurns?.[id] ?? [];
    return (incoming.length > 0 || turns.length > 0) &&
      incoming.every(finalId => confirmed?.includes(finalId)) &&
      turns.every(turn => state.confirmedGoalCompletionTurnIds[id]?.includes(turn.turnId));
  }));
  const duplicateGoalCompletions = new Set((observationOptions?.goalCompletionReceipts ?? []).filter(id => {
    if (confirmedGoalCompletions.has(id)) return true;
    const previous = state.activeConversationRecovery[id];
    if (previous?.awaitingGoalCompletion !== true) return false;
    const incoming = observationOptions?.goalCompletionFinalIds?.[id] ?? [];
    return incoming.every(finalId => previous.finalMessageIds?.includes(finalId)) &&
      (observationOptions?.goalCompletionTurns?.[id] ?? []).every(turn =>
        previous.turns?.some(existing => existing.turnId === turn.turnId && turn.messageIds.every(messageId => existing.messageIds.includes(messageId))));
  }));
  for (const id of requestedConversationIds) {
    const exactApproval = (observationOptions?.expectedApprovals ?? []).some(target => target.conversationId === id);
    if (confirmedGoalCompletions.has(id) && !exactApproval) continue;
    // A delayed final/recovery notification cannot resurrect a confirmed
    // deleted conversation. A new approval or ordinary exact activity can.
    if (state.deletedConversations[id] && !exactApproval &&
        (observationOptions?.recoveryConversationIds?.includes(id) ||
         observationOptions?.goalCompletionReceipts?.includes(id))) continue;
    // Reconnecting to a known Goal is not new conversation activity. Keep
    // confirmed deletions and the existing pending recovery cadence intact.
    if (!exactApproval && observationOptions?.recoveryConversationIds?.includes(id) &&
        (state.deletedConversations[id] || Object.hasOwn(state.pendingConversations, id))) continue;
    delete state.deletedConversations[id];
    // Replayed completion notifications do not make the transcript newer.
    // Preserve the pending revision and paced recovery across reconnects.
    // An independent approval notification still wakes this conversation.
    if (duplicateGoalCompletions.has(id) && Object.hasOwn(state.pendingConversations, id) &&
        !(observationOptions?.expectedApprovals ?? []).some(target => target.conversationId === id)) continue;
    state.pendingConversations[id] = true;
    state.pendingConversationRevisions[id] = crypto.randomUUID();
    // A new exact notification supersedes a quiet-turn recovery delay, but
    // never the shared account cadence or a server-directed rate-limit wait.
    if (state.activeConversationRecovery[id]) state.activeConversationRecovery[id].nextReadAt = 0;
  }
  const freshApprovalIds = new Set();
  for (const target of observationOptions?.expectedApprovals ?? []) {
    const expected = state.expectedApprovals[target.conversationId] ??= Object.create(null);
    if (!Object.hasOwn(expected, target.pendingMessageId) && target.targetMessageIds.some(id => {
      const key = target.conversationId + "\u0000" + target.pendingMessageId + "\u0000" + id;
      return !state.handled[key] && !state.inFlight[key];
    })) freshApprovalIds.add(target.conversationId);
    expected[target.pendingMessageId] = target.targetMessageIds;
  }
  for (const id of observationOptions?.goalCompletionReceipts ?? []) {
    if (state.deletedConversations[id] || duplicateGoalCompletions.has(id)) continue;
    const finals = [...new Set([...(state.activeConversationRecovery[id]?.finalMessageIds ?? []),
      ...(observationOptions?.goalCompletionFinalIds?.[id] ?? [])])];
    const turns = [...(state.activeConversationRecovery[id]?.turns ?? [])];
    for (const turn of observationOptions?.goalCompletionTurns?.[id] ?? []) {
      if (state.confirmedGoalCompletionTurnIds[id]?.includes(turn.turnId)) continue;
      const previous = turns.find(existing => existing.turnId === turn.turnId);
      if (previous) previous.messageIds = [...new Set([...previous.messageIds, ...turn.messageIds])];
      else turns.push({ turnId: turn.turnId, messageIds: [...turn.messageIds] });
    }
    state.activeConversationRecovery[id] = { awaitingGoalCompletion: true, nextReadAt: 0, attempts: 0,
      ...(turns.length === 0 ? {} : { turns }),
      ...(finals.length === 0 ? {} : { finalMessageIds: finals }) };
  }
  // The server-side Goal store is authoritative for whether completion
  // readback remains live. A paused, cancelled, completed, or deleted Goal
  // must not survive indefinitely in this browser-local recovery queue.
  if (Array.isArray(observationOptions?.activeGoalConversationIds)) {
    const activeGoalConversationIds = new Set(observationOptions.activeGoalConversationIds);
    for (const [id, recovery] of Object.entries(state.activeConversationRecovery)) {
      if (recovery?.awaitingGoalCompletion !== true || activeGoalConversationIds.has(id)) continue;
      delete state.activeConversationRecovery[id];
      delete state.goalBodyRecovery[id];
      const expected = state.expectedApprovals[id];
      const hasExpected = expected && typeof expected === "object" && Object.keys(expected).length > 0;
      const hasIncomingExpected = (observationOptions.expectedApprovals ?? [])
        .some(target => target.conversationId === id);
      const hasInFlight = Object.values(state.inFlight)
        .some(pending => pending?.conversationId === id);
      if (!hasExpected && !hasIncomingExpected && !hasInFlight) {
        delete state.pendingConversations[id];
        delete state.pendingConversationRevisions[id];
      }
    }
  }
  // Retire stale durable queue entries from before deletion was observed.
  // Keep uncertain submission identities intact; they are not new work.
  for (const id of Object.keys(state.deletedConversations)) {
    delete state.pendingConversations[id];
    delete state.pendingConversationRevisions[id];
    delete state.activeConversationRecovery[id];
  }
  // Unconfirmed submissions participate in the same durable FIFO as new
  // activity. Appending them after the queue only at selection time lets a
  // continuous stream of new conversations postpone their readback forever.
  for (const pending of Object.values(state.inFlight)) {
    const id = pending?.conversationId;
    if (typeof id !== "string" || state.deletedConversations[id] || Object.hasOwn(state.pendingConversations, id)) continue;
    state.pendingConversations[id] = false;
    state.pendingConversationRevisions[id] = crypto.randomUUID();
  }
  if (requestStats.trigger === "idle" && Object.keys(state.pendingConversations).length > 0) {
    requestStats.trigger = "recovery";
  }
  const queuePersisted = storageFailure === null && persistState();
  if (!queuePersisted || storageFailure !== null) {
    // A storage read failure could conceal an earlier uncertain submission.
    // Do not post another approval. Existing in-memory receipts can still be
    // committed to the daemon sink, which is independent of browser storage.
    return {
      requestStats,
      outcome: "partial", examined: 0, discovered: 0, approvalsPending: 0,
      followUpScanRequired: true, conversationUrls: [],
      receipts: Object.values(state.receiptOutbox), errors: [storageFailure],
      nextScanAtUnixMs: Date.now() + activeScanMs,
    };
  }
  const pendingIds = Object.keys(state.pendingConversations);
  // Snapshot before any await: a later wake must survive this scan's cleanup,
  // including when that wake only queues work during the shared cooldown.
  const pendingRevisions = new Map(
    pendingIds.map((id) => [id, state.pendingConversationRevisions[id]]),
  );
  for (const [id, revision] of pendingRevisions) requestQueueRevisions[id] = revision;
  if (pendingIds.length === 0) {
    return {
      requestStats,
      outcome: "ok", examined: 0, discovered: 0, approvalsPending: 0,
      followUpScanRequired: false, conversationUrls: [], receipts: Object.values(state.receiptOutbox), errors: [],
    };
  }
  const freshApprovalAttempt = freshApprovalIds.size > 0 &&
    !(Number(state.lastRateLimit?.serverRetryAtUnixMs) > scanStartedAt);
  if (Number(state.backoffUntil) > scanStartedAt && !freshApprovalAttempt) {
    return {
      requestStats,
      outcome: "partial",
      examined: 0,
      discovered: 0,
      approvalsPending: 0,
      followUpScanRequired: true,
      conversationUrls: [],
      receipts: Object.values(state.receiptOutbox),
      errors: [{ conversationId: "account", error: "rate_limited_backoff" }],
      nextScanAtUnixMs: state.backoffUntil,
      ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit }),
    };
  }
  const nextAllowedScanAt = (Number(state.lastScanAt) || 0) + activeScanMs;
  if (nextAllowedScanAt > scanStartedAt && !freshApprovalAttempt) {
    return {
      requestStats,
      outcome: "ok",
      examined: 0,
      discovered: 0,
      approvalsPending: 0,
      followUpScanRequired: true,
      conversationUrls: [],
      receipts: Object.values(state.receiptOutbox),
      errors: [],
      nextScanAtUnixMs: nextAllowedScanAt,
    };
  }
  state.lastScanAt = scanStartedAt;
  persistState();
  let runtime;
  try {
    runtime = await ensureModule();
  } catch (error) {
    if (!rateLimited(error)) throw error;
    markRateLimited(error, "runtime_initialization");
    return {
      requestStats,
      outcome: "partial", examined: 0, discovered: 0, approvalsPending: 0,
      followUpScanRequired: true, conversationUrls: [], receipts: Object.values(state.receiptOutbox),
      errors: [{ conversationId: "account", error: "rate_limited_backoff" }],
      nextScanAtUnixMs: state.backoffUntil, rateLimit: state.lastRateLimit,
    };
  }
  const module = runtime.module;
  const requestClient = runtime.requestClient;
  const candidates = pendingIds.map((id) => ({
    id, openRenderer: state.pendingConversations[id] === true,
  }));
  // Admit one conversation per account cadence. Serial concurrency alone
  // still bursts every queued GET into the same scan. The remaining queue is
  // durable and is drained by later scans without a total-work limit.
  const work = candidates.filter(({ id }) => freshApprovalAttempt ? freshApprovalIds.has(id) :
    !(Number(state.activeConversationRecovery[id]?.nextReadAt) > scanStartedAt)).slice(0, 1);
  const conversationUrls = [];
  const goalConversations = [];
  const recordReceipt = (receipt) => {
    state.receiptOutbox[receipt.clientMessageId] = receipt;
  };
  const errors = [];
  const processedIds = new Set();
  const awaitingHydration = new Set();
  let approvalsPending = 0;
  const wantedId = connectorId.toLocaleLowerCase();
  const wantedName = connectorName.trim().toLocaleLowerCase();
  const readConversation = async (conversationId, operation = "approval_scan") => {
    if (operation === "goal_completion_readback") {
      // A completion event names the final in the current turn. That turn's
      // explicit parent ids are sufficient to prove whether the final is on
      // the current branch; the historical mapping is unnecessary and can be
      // thousands of messages on a long-running Pro task.
      const path = "/conversations/" + encodeURIComponent(conversationId);
      recordRequest("GET", path, operation, conversationId);
      const conversation = await requestClient.safeGet(path, {
        parameters: { query: { include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
      if (conversation?.conversation_id !== undefined && conversation.conversation_id !== conversationId)
        throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
      if (conversation?.id !== undefined && conversation.id !== conversationId)
        throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
      return conversation;
    }
    const path = "/conversations/" + encodeURIComponent(conversationId);
    recordRequest("GET", path, operation, conversationId);
    return requestClient.safeGet(path, {
      // An approval is attached to the current turn. Reading older turns can
      // expand a long Pro conversation into thousands of tool messages while
      // adding no approval evidence. Completion readback uses its separate
      // exact-branch path above.
      parameters: { query: { include_has_versions: true, num_turns: 1 } },
      disableAutomaticRetry: true,
    });
  };
  const persistedClientResponse = (messages, clientMessageId, targetMessageId) =>
    messages.find((message) => {
      const fromClient = message?.metadata?.jit_plugin_data?.from_client;
      return (
        (clientMessageId == null || message?.id === clientMessageId) &&
        (fromClient?.type === "allow" || fromClient?.type === "always_allow") &&
        fromClient?.target_message_id === targetMessageId
      );
    });
  const selectAction = (actions) => {
    const split = actions.flatMap((candidate) =>
      Array.isArray(candidate?.split_action_options)
        ? candidate.split_action_options.map((option) => option?.action).filter(Boolean)
        : [],
    );
    return (
      split.find((candidate) => candidate?.type === "allow" && candidate?.remember_answer === true) ??
      actions.find((candidate) => candidate?.type === "always_allow")?.always_allow ??
      actions.find((candidate) => candidate?.type === "allow")?.allow
    );
  };
  const originatingUserAnchor = (messages, pendingId) => {
    const index = messages.findIndex(message => message?.id === pendingId);
    const user = index < 0 ? undefined : messages.slice(0, index).findLast(message =>
      message?.author?.role === "user" && !message?.metadata?.jit_plugin_data?.from_client);
    return typeof user?.id === "string" ? { userMessageId: user.id } : {};
  };
  const approveConversation = async ({ id, openRenderer }) => {
    let conversation;
    try {
      conversation = await readConversation(id, state.activeConversationRecovery[id]?.awaitingGoalCompletion === true ? "goal_completion_readback" : "approval_scan");
    } catch (error) {
      if (rateLimited(error)) markRateLimited(error, "conversation_read", id);
      const failure = operationFailure(id, "conversation_read", error);
      errors.push(failure);
      // A confirmed deletion cannot hydrate on a timer. Preserve uncertain
      // submission identities, but retire this queue revision durably. Fresh
      // exact activity can request a new read without replaying a submission.
      if (failure.status === 404 && /conversation has been deleted/i.test(failure.error) &&
          state.pendingConversationRevisions[id] === pendingRevisions.get(id)) {
        state.deletedConversations[id] = failure;
        delete state.pendingConversations[id];
        delete state.pendingConversationRevisions[id];
        delete state.expectedApprovals[id];
        delete state.activeConversationRecovery[id];
      }
      return;
    }
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const goalConversation = projectGoalConversation(id, conversation, connectorId);
    if (goalConversation.goals.length > 0) goalConversations.push(goalConversation);
    const completionReceipt = state.activeConversationRecovery[id];
    if (completionReceipt?.awaitingGoalCompletion === true) {
      const current = goalConversation.current;
      const expectedFinals = completionReceipt.finalMessageIds;
      const remainingFinals = Array.isArray(expectedFinals) ? expectedFinals.filter(finalId => {
        const final = conversation?.mapping?.[finalId]?.message ?? messages.find(message => message?.id === finalId);
        return !(final?.author?.role === "assistant" && final.status === "finished_successfully" &&
          final.end_turn === true && final.channel === "final" &&
          (current?.id === finalId || current?.ancestorMessageIds?.includes(finalId)));
      }) : undefined;
      const remainingTurns = Array.isArray(completionReceipt.turns) ? completionReceipt.turns.filter(turn => {
        // Native envelope ids are not assumed equal to working_turn_id. Walk
        // actual current-branch parent edges from a final back to an observed
        // message in that envelope, stopping at every intervening user turn.
        const branch = [current?.id, ...(current?.ancestorMessageIds ?? [])];
        return !branch.some(finalId => {
          const final = conversation?.mapping?.[finalId]?.message ??
            messages.find(message => message?.id === finalId);
          if (final?.author?.role !== "assistant" || final.status !== "finished_successfully" || final.end_turn !== true || final.channel !== "final") return false;
          const seen = new Set();
          let cursor = finalId;
          while (typeof cursor === "string" && !seen.has(cursor)) {
            seen.add(cursor);
            const mapped = conversation?.mapping?.[cursor];
            const message = mapped?.message ?? messages.find(candidate => candidate?.id === cursor);
            const node = mapped ?? (message === undefined ? undefined : { message });
            if (!node) return false;
            if (turn.messageIds.includes(cursor) && node.message?.author?.role !== "user") return true;
            if (node.message?.author?.role === "user") return false;
            cursor = mapped && Object.hasOwn(mapped, "parent")
              ? mapped.parent : message?.parent_id ?? message?.metadata?.parent_id;
          }
          return false;
        });
      }) : undefined;
      if (remainingTurns !== undefined) {
        const confirmedTurns = completionReceipt.turns.filter(turn => !remainingTurns.some(remaining => remaining.turnId === turn.turnId));
        if (confirmedTurns.length > 0)
          state.confirmedGoalCompletionTurnIds[id] = [...new Set([...(state.confirmedGoalCompletionTurnIds[id] ?? []), ...confirmedTurns.map(turn => turn.turnId)])];
      }
      const resolved = remainingTurns !== undefined ? remainingTurns.length === 0 && (remainingFinals?.length ?? 0) === 0 : remainingFinals !== undefined ? remainingFinals.length === 0 :
        current?.authorRole === "assistant" && current.status === "finished_successfully" && current.endTurn === true && current.channel === "final";
      if (resolved) {
        if (completionReceipt.turns?.length)
          state.confirmedGoalCompletionTurnIds[id] = [...new Set([...(state.confirmedGoalCompletionTurnIds[id] ?? []), ...completionReceipt.turns.map(turn => turn.turnId)])];
        if (Array.isArray(expectedFinals) && expectedFinals.length > 0)
          state.confirmedGoalCompletionFinalIds[id] = [...new Set([
            ...(state.confirmedGoalCompletionFinalIds[id] ?? []), ...expectedFinals,
          ])];
        delete state.activeConversationRecovery[id];
      } else {
        // Retain this exact unresolved receipt across quiet periods/restarts.
        // Increase its interval instead of polling every two minutes forever
        // or discarding a completion whose transcript may persist later.
        const attempts = (Number(completionReceipt.attempts) || 0) + 1;
        state.activeConversationRecovery[id] = { awaitingGoalCompletion: true, attempts,
          ...(remainingTurns === undefined ? {} : { turns: remainingTurns }),
          ...(remainingFinals === undefined ? {} : { finalMessageIds: remainingFinals }),
          nextReadAt: Date.now() + Math.min(1_800_000, 30_000 * 2 ** Math.min(attempts - 1, 6)) };
        awaitingHydration.add(id);
      }
    }
    const connectorConversation = exactStringIn(messages, wantedId, wantedName, 0);
    const readObservation = requestStats.requests.findLast((request) =>
      request.operation === "approval_scan" && request.conversationId === id);
    if (readObservation) {
      readObservation.messageCount = messages.length;
      readObservation.userMessageCount = messages.filter((message) => message?.author?.role === "user").length;
      readObservation.connectorReferenced = connectorConversation;
    }
    // The user notification can arrive before the new conversation's first
    // messages are visible in the read API. An empty read cannot establish
    // that this exact conversation does not use the connector. Keep its
    // existing durable queue entry for the paced recovery scan. A resolved
    // completion receipt has already established the terminal state.
    if (openRenderer === true && messages.length === 0 && completionReceipt?.awaitingGoalCompletion !== true) {
      awaitingHydration.add(id);
      return;
    }
    const inflightEntries = Object.entries(state.inFlight).filter(
      ([, pending]) => pending?.conversationId === id,
    );
    const pending = messages.find(
      (message) =>
        message?.id === conversation?.current_node &&
        message?.metadata?.jit_plugin_data?.from_server?.type === "confirm_action",
    );
    // Retained completion readbacks are not new renderer work. Historical
    // connector text alone must not reopen an idle mirror on every retry.
    // Keep actual approvals and unacknowledged receipt synchronization intact.
    const completionOnly = completionReceipt?.awaitingGoalCompletion === true &&
      pending === undefined && !state.expectedApprovals[id] && inflightEntries.length === 0 &&
      !Object.values(state.receiptOutbox).some(receipt => receipt.conversationId === id);
    if (openRenderer === true && connectorConversation && !completionOnly) {
      conversationUrls.push("https://chatgpt.com/c/" + id);
    }
    for (const [key, pending] of inflightEntries) {
      const persisted = persistedClientResponse(
        messages,
        pending.clientMessageId,
        pending.targetMessageId,
      );
      if (!persisted) {
        if (pending.failure) errors.push(pending.failure);
        continue;
      }
      delete state.inFlight[key];
      if (!state.handled[key]) {
        state.handled[key] = true;
        recordReceipt({
          conversationId: id,
          conversationUrl: "https://chatgpt.com/c/" + id,
          pendingMessageId: pending.pendingMessageId,
          ...(pending.userMessageId ? { userMessageId: pending.userMessageId } : originatingUserAnchor(messages, pending.pendingMessageId)),
          clientMessageId: pending.clientMessageId,
          targetMessageId: pending.targetMessageId,
          action: pending.action,
          rememberAnswer: pending.rememberAnswer,
          ...(pending.responseStatus === undefined ? {} : { responseStatus: pending.responseStatus }),
        });
        persistState();
      }
    }
    if (!pending) {
      // The native conversation-update notification supplies newly pending
      // approvals. A generating response alone is not approval work and does
      // not authorize a timer to keep rediscovering this conversation.
      if (state.activeConversationRecovery[id]?.awaitingGoalCompletion !== true) delete state.activeConversationRecovery[id];
      return;
    }
    if (state.activeConversationRecovery[id]?.awaitingGoalCompletion === true && !state.expectedApprovals[id]) return;
    if (state.activeConversationRecovery[id]?.awaitingGoalCompletion !== true) delete state.activeConversationRecovery[id];
    const body = pending.metadata.jit_plugin_data.from_server.body ?? {};
    const actions = Array.isArray(body.actions) ? body.actions : [];
    const selected = selectAction(actions);
    const targetMessageId = selected?.target_message_id;
    if (typeof targetMessageId !== "string" || targetMessageId.length === 0) return;
    const expected = state.expectedApprovals[id];
    if (expected && !expected[pending.id]?.includes(targetMessageId)) return;
    const target = messages.find((message) => message?.id === targetMessageId);
    const exactConnector =
      exactStringIn(body, wantedId, wantedName, 0) ||
      exactStringIn(
        { author: target?.author, metadata: target?.metadata, recipient: target?.recipient },
        wantedId,
        wantedName,
        0,
      );
    if (!exactConnector) return;
    approvalsPending += 1;
    const key = id + "\u0000" + pending.id + "\u0000" + targetMessageId;
    if (state.handled[key]) return;
    const alreadyPersisted = persistedClientResponse(messages, null, targetMessageId);
    if (alreadyPersisted) {
      state.handled[key] = true;
      recordReceipt({
        conversationId: id,
        conversationUrl: "https://chatgpt.com/c/" + id,
        pendingMessageId: pending.id,
        ...originatingUserAnchor(messages, pending.id),
        clientMessageId: alreadyPersisted.id,
        targetMessageId,
        action: alreadyPersisted.metadata.jit_plugin_data.from_client.type,
        rememberAnswer:
          alreadyPersisted.metadata.jit_plugin_data.from_client.remember_answer === true,
        responseStatus: 200,
      });
      persistState();
      return;
    }
    if (state.inFlight[key]) return;
    if (!target) {
      errors.push({ conversationId: id, error: "target_message_missing" });
      return;
    }
    const action = selected?.type === "always_allow" ? "always_allow" : "allow";
    const actionData = {
      ...(action === "allow" ? { remember_answer: false } : {}),
      ...selected,
      target_message_id: targetMessageId,
      type: action,
    };
    const clientMessageId = crypto.randomUUID();
    // Native JIT only replays the confirmation for self-targeted Codex
    // elicitations or a thinking-effort change. Ordinary file materialization
    // replies after the confirmation; replaying that message is rejected (422).
    const elicitation = body.codex_mcp_elicitation;
    const confirmationTargets = actions.flatMap((candidate) =>
      candidate?.type === "allow" ? [candidate.allow?.target_message_id]
        : candidate?.type === "always_allow" ? [candidate.always_allow?.target_message_id]
        : candidate?.type === "deny" ? [candidate.deny?.target_message_id] : []);
    const replyToConfirmation = body.approval_reason === "thinking_effort_change" ||
      (elicitation?.kind === "openaiForm" &&
        (elicitation.status == null || elicitation.status === "pending")) ||
      elicitation?.kind === "browserAuth" ||
      (elicitation?.kind === "mcpToolCall" && confirmationTargets.length > 0 &&
        confirmationTargets.every((targetId) => targetId === pending.id));
    // The paginated API returns the active branch root-to-leaf.
    const pendingIndex = messages.indexOf(pending);
    const parentMessageId = replyToConfirmation ? messages[pendingIndex - 1]?.id : pending.id;
    if (typeof parentMessageId !== "string" || parentMessageId.length === 0) {
      errors.push({ conversationId: id, error: "approval_parent_message_missing" });
      return;
    }
    const clientMessage = {
      author: {
        metadata: {},
        name: pending.author?.name ?? "api_tool.call_tool",
        role: "tool",
      },
      channel: null,
      content: { content_type: "text", parts: [""] },
      create_time: Date.now() / 1000,
      end_turn: null,
      id: clientMessageId,
      metadata: {
        jit_plugin_data: { from_client: actionData },
        ...(!replyToConfirmation || pending.metadata?.working_turn_id == null
          ? {}
          : { working_turn_id: pending.metadata.working_turn_id }),
        ...(conversation.gizmo_id == null ? {} : { gizmo_id: conversation.gizmo_id }),
      },
      recipient: "all",
      status: "finished_successfully",
      update_time: null,
      weight: 1,
    };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const bodyForPost = {
      action: "next",
      messages: replyToConfirmation ? [pending, clientMessage] : [clientMessage],
      conversation_id: id,
      ...(conversation.conversation_origin == null
        ? {}
        : { conversation_origin: conversation.conversation_origin }),
      ...(conversation.is_do_not_remember == null
        ? {}
        : { is_do_not_remember: conversation.is_do_not_remember }),
      parent_message_id: parentMessageId,
      ...(typeof conversation.default_model_slug === "string" &&
      conversation.default_model_slug.length > 0
        ? { model: conversation.default_model_slug }
        : {}),
      client_prepare_state: "N/A",
      timezone_offset_min: new Date().getTimezoneOffset(),
      timezone,
      ...(conversation.gizmo_id == null
        ? {}
        : {
            conversation_mode: {
              kind: "gizmo_interaction",
              gizmo_id: conversation.gizmo_id,
            },
            gizmo_id: conversation.gizmo_id,
          }),
      ...(typeof pending.metadata?.thinking_effort === "string" &&
      pending.metadata.thinking_effort.length > 0
        ? { thinking_effort: pending.metadata.thinking_effort }
        : {}),
      supports_buffering: true,
      supported_encodings: ["v1"],
    };
    const requirements = await module.Eo(false, "none", 1);
    const [proofToken, turnstileToken] = await Promise.all([
      module.Uo.getEnforcementToken(requirements, { forceSync: true }),
      module.zo.getEnforcementToken(requirements),
    ]);
    await module.Fo("conversation");
    // Token preparation can take long enough for the owner to advance this
    // conversation from mobile, Web, or Desktop. Posting against the stale
    // confirmation node would create a sibling branch and may make the newer
    // user turns disappear when another client reloads the active branch.
    // Re-read immediately before dispatch and fail open for the user's newer
    // branch: the next account scan will handle any still-current prompt.
    const preDispatchConversation = await readConversation(id, "approval_pre_dispatch");
    const preDispatchMessages = Array.isArray(preDispatchConversation?.messages)
      ? preDispatchConversation.messages
      : [];
    const concurrentlyPersisted = persistedClientResponse(
      preDispatchMessages,
      null,
      targetMessageId,
    );
    if (concurrentlyPersisted) {
      state.handled[key] = true;
      recordReceipt({
        conversationId: id,
        conversationUrl: "https://chatgpt.com/c/" + id,
        pendingMessageId: pending.id,
        ...originatingUserAnchor(messages, pending.id),
        clientMessageId: concurrentlyPersisted.id,
        targetMessageId,
        action: concurrentlyPersisted.metadata.jit_plugin_data.from_client.type,
        rememberAnswer:
          concurrentlyPersisted.metadata.jit_plugin_data.from_client.remember_answer === true,
        responseStatus: 200,
      });
      persistState();
      return;
    }
    if (preDispatchConversation?.current_node !== pending.id) {
      return;
    }
    const timing = root.SentinelSDK?.timing?.() ?? "[1,null]";
    const requestOptions = {
      requestBody: bodyForPost,
      additionalHeaders: {
        ...module.Ao(requirements, turnstileToken, proofToken, null, null, timing),
      },
      authOption: 1,
      disableAutomaticRetry: true,
    };
    const submission = {
      conversationId: id,
      pendingMessageId: pending.id,
      ...originatingUserAnchor(messages, pending.id),
      clientMessageId,
      targetMessageId,
      action,
      rememberAnswer: actionData.remember_answer === true || action === "always_allow",
    };
    // Persist identity before dispatch. Losing the response (or this evaluator)
    // cannot erase a possibly committed submission and trigger another POST.
    // Preparation and the fresh conversation read above both yield. Another
    // scan may have claimed this same confirmation in the meantime. Recheck
    // and claim without an await between them so only one scan can submit it.
    if (state.handled[key] || state.inFlight[key]) return;
    state.inFlight[key] = submission;
    if (!persistState()) {
      // No request was submitted. Retain the pending conversation for recovery,
      // but do not leave a fabricated uncertain in-flight approval behind.
      delete state.inFlight[key];
      errors.push({ ...storageFailure, conversationId: id, operation: "approval_intent_persist", submissionState: "rejected" });
      return;
    }
    let response;
    try {
      recordRequest("POST", "/f/conversation", "approval_submission", id);
      response = await requestClient.request("post", "/f/conversation", requestOptions);
    } catch (error) {
      const failure = submissionFailure(id, error, errorText(error));
      if (failure.status !== undefined) submission.responseStatus = failure.status;
      if (submissionUncertain(responseStatus(error))) submission.failure = failure;
      else delete state.inFlight[key];
      if (rateLimited(error)) markRateLimited(error, "approval_submission");
      errors.push(failure);
      persistState();
      return;
    }
    if (responseStatus(response) !== undefined) submission.responseStatus = response.status;
    if (responseStatus(response) === undefined || response.status < 200 || response.status >= 300) {
      const failure = submissionFailure(id, response);
      // A rejected request is not accepted. A timeout or upstream failure may
      // still have committed: preserve its identity for readback, never repost
      // merely because a successful response was not received.
      if (submissionUncertain(responseStatus(response))) submission.failure = failure;
      else delete state.inFlight[key];
      persistState();
      if (response.status === 429) markRateLimited(response, "approval_submission");
      errors.push(failure);
      try { await response.body?.cancel?.(); } catch {}
      return;
    }
    state.inFlight[key] = submission;
    persistState();
    if (response.body?.getReader) {
      const drain = (async () => {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
          }
        } catch {}
      })();
      state.drains.add(drain);
      drain.finally(() => state.drains.delete(drain));
    }
    // One immediate readback is enough. If the accepted response has not been
    // persisted yet, retain its identity in inFlight and reconcile it on the
    // next paced scan. Polling the whole conversation 40 times in ten seconds
    // consumed the account's request budget while a long Pro turn was running.
    {
      const readback = await readConversation(id, "approval_readback");
      const currentMessages = Array.isArray(readback?.messages) ? readback.messages : [];
      const persisted = persistedClientResponse(
        currentMessages,
        clientMessageId,
        targetMessageId,
      );
      if (persisted) {
        delete state.inFlight[key];
        state.handled[key] = true;
        recordReceipt({
          conversationId: id,
          conversationUrl: "https://chatgpt.com/c/" + id,
          pendingMessageId: pending.id,
        ...originatingUserAnchor(messages, pending.id),
          clientMessageId,
          targetMessageId,
          action,
          rememberAnswer: submission.rememberAnswer,
          responseStatus: response.status,
        });
        persistState();
        return;
      }
    }
  };
  for (const candidate of work) {
    if (Number(state.backoffUntil) > Date.now() && !(freshApprovalAttempt && freshApprovalIds.has(candidate.id))) break;
    try {
      await approveConversation(candidate);
    } catch (error) {
      if (rateLimited(error)) markRateLimited(error, "approval_or_readback");
      errors.push(operationFailure(candidate.id, "approval_or_readback", error));
    }
    processedIds.add(candidate.id);
  }
  const retryIds = new Set(errors.map((entry) => entry.conversationId));
  for (const id of processedIds) {
    const awaitingReadback = Object.values(state.inFlight).some(
      (pending) => pending?.conversationId === id,
    );
    if (!retryIds.has(id) && !awaitingReadback && !awaitingHydration.has(id) && state.pendingConversationRevisions[id] === pendingRevisions.get(id)) {
      delete state.pendingConversations[id];
      delete state.pendingConversationRevisions[id];
      delete state.expectedApprovals[id];
      delete state.activeConversationRecovery[id];
    } else if (Object.hasOwn(state.pendingConversations, id)) {
      // A failing or newly updated conversation must not starve other queued
      // conversations. Move only the processed entry, retaining its revision.
      const pending = state.pendingConversations[id];
      delete state.pendingConversations[id];
      state.pendingConversations[id] = pending;
    }
  }
  // A single successful probe does not prove account recovery: different
  // conversations can alternate between 200 and 429. Retain the escalation
  // through one full cooldown after retry admission, including page reloads.
  const lastRetryAt = Number(state.lastRateLimit?.retryAtUnixMs) || 0;
  const recoveryWindowMs = Math.max(
    initialRateLimitBackoffMs,
    lastRetryAt - (Number(state.lastRateLimit?.observedAtUnixMs) || lastRetryAt),
  );
  if (errors.length === 0 && processedIds.size > 0 &&
      Number(state.backoffUntil) <= Date.now() &&
      (state.lastRateLimit == null || Date.now() >= lastRetryAt + recoveryWindowMs)) {
    state.backoffUntil = 0;
    state.backoffMs = initialRateLimitBackoffMs;
    state.lastRateLimit = null;
  }
  persistState();
  if (storageFailure !== null) errors.push(storageFailure);
  const receipts = Object.values(state.receiptOutbox);
  const pendingReadTimes = Object.keys(state.pendingConversations).map(id => Number(state.activeConversationRecovery[id]?.nextReadAt) || Date.now() + activeScanMs);
  return {
    requestStats,
    outcome: storageFailure !== null || (errors.length > 0 && receipts.length === 0) ? "partial" : "ok",
    examined: work.length,
    discovered: candidates.length,
    approvalsPending,
    followUpScanRequired: Object.values(state.inFlight).some(pending => !state.deletedConversations[pending?.conversationId]) || Object.keys(state.pendingConversations).length > 0,
    conversationUrls: [...new Set(conversationUrls)],
    ...(goalConversations.length === 0 ? {} : { goalConversations }),
    receipts,
    errors,
    nextScanAtUnixMs: Math.max(Number(state.backoffUntil) || 0, Date.now() + activeScanMs,
      pendingReadTimes.length > 0 ? Math.min(...pendingReadTimes) : 0),
    ...(state.lastRateLimit == null ? {} : { rateLimit: state.lastRateLimit }),
  };
}`;

export interface OracleMessageStructureObservationOptions {
  readonly observeMessageStructure: true;
  readonly observeBranchStructure?: true;
  readonly observePreviousPage?: true;
  readonly canonicalResourceOrigin?: string;
}

export interface OracleExpectedApproval {
  readonly conversationId: string;
  readonly pendingMessageId: string;
  readonly targetMessageIds: readonly string[];
}

export interface OracleApprovalScanOptions {
  readonly telemetryId?: string;
  readonly observePreviousPage?: true;
  readonly observeGoalsOnly?: true;
  readonly observeMessageStructure?: true;
  readonly observeBranchStructure?: true;
  readonly canonicalResourceOrigin?: string;
  readonly expectedApprovals?: readonly OracleExpectedApproval[];
  /** Known Goal URLs restored after startup/reconnect, not fresh native activity. */
  readonly recoveryConversationIds?: readonly string[];
  /** Authoritative active Goal conversations for this connector and account. */
  readonly activeGoalConversationIds?: readonly string[];
  readonly goalCompletionReceipts?: readonly string[];
  /** Exact final identities supplied by a native final-message notification. */
  readonly goalCompletionFinalIds?: Readonly<Record<string, readonly string[]>>;
  readonly goalCompletionTurns?: Readonly<
    Record<string, readonly { readonly turnId: string; readonly messageIds: readonly string[] }[]>
  >;
}

export function oracleChatGptServerApprovalScanExpression(
  connectorId: string,
  connectorName: string,
  conversationIds: readonly string[] = [],
  acknowledgedReceiptIds: readonly string[] = [],
  observationOptions?: OracleApprovalScanOptions,
): string {
  assertConnectorId(connectorId);
  if (
    observationOptions?.telemetryId !== undefined &&
    !/^[a-f0-9-]{36}$/u.test(observationOptions.telemetryId)
  )
    throw new Error("ORACLE_APPROVAL_TELEMETRY_ID_INVALID");
  if (connectorName.trim().length === 0 || connectorName.length > 200) {
    throw new Error("CHATGPT_CONNECTOR_NAME_INVALID");
  }
  if (conversationIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(id))) {
    throw new Error("CHATGPT_CONVERSATION_ID_INVALID");
  }
  if (acknowledgedReceiptIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(id))) {
    throw new Error("CHATGPT_APPROVAL_RECEIPT_ID_INVALID");
  }
  if (
    observationOptions !== undefined &&
    (observationOptions === null ||
      Object.keys(observationOptions).some(
        (key) =>
          key !== "telemetryId" &&
          key !== "observeGoalsOnly" &&
          key !== "observeMessageStructure" &&
          key !== "observeBranchStructure" &&
          key !== "observePreviousPage" &&
          key !== "canonicalResourceOrigin" &&
          key !== "expectedApprovals" &&
          key !== "recoveryConversationIds" &&
          key !== "activeGoalConversationIds" &&
          key !== "goalCompletionReceipts" &&
          key !== "goalCompletionFinalIds" &&
          key !== "goalCompletionTurns",
      ) ||
      (observationOptions.observeGoalsOnly !== undefined &&
        observationOptions.observeGoalsOnly !== true) ||
      (observationOptions.observeGoalsOnly === true &&
        (conversationIds.length !== 1 ||
          acknowledgedReceiptIds.length !== 0 ||
          observationOptions.observeMessageStructure !== undefined ||
          observationOptions.canonicalResourceOrigin !== undefined ||
          observationOptions.expectedApprovals !== undefined ||
          observationOptions.recoveryConversationIds !== undefined ||
          observationOptions.activeGoalConversationIds !== undefined ||
          observationOptions.goalCompletionReceipts !== undefined ||
          observationOptions.goalCompletionFinalIds !== undefined)) ||
      (observationOptions.observeMessageStructure !== undefined &&
        observationOptions.observeMessageStructure !== true) ||
      (observationOptions.observePreviousPage !== undefined &&
        (observationOptions.observePreviousPage !== true ||
          observationOptions.observeMessageStructure !== true)) ||
      (observationOptions.observeBranchStructure !== undefined &&
        (observationOptions.observeBranchStructure !== true ||
          observationOptions.observeMessageStructure !== true)) ||
      (observationOptions.observeMessageStructure === true &&
        (conversationIds.length !== 1 ||
          acknowledgedReceiptIds.length !== 0 ||
          observationOptions.expectedApprovals !== undefined ||
          observationOptions.recoveryConversationIds !== undefined ||
          observationOptions.activeGoalConversationIds !== undefined ||
          observationOptions.goalCompletionReceipts !== undefined ||
          observationOptions.goalCompletionFinalIds !== undefined)) ||
      (observationOptions.canonicalResourceOrigin !== undefined &&
        observationOptions.observeMessageStructure !== true))
  ) {
    throw new Error("ORACLE_MESSAGE_STRUCTURE_OBSERVATION_INVALID");
  }
  if (observationOptions?.expectedApprovals !== undefined) {
    const validId = (id: unknown): id is string =>
      typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(id);
    if (
      !Array.isArray(observationOptions.expectedApprovals) ||
      observationOptions.expectedApprovals.some(
        (target) =>
          target === null ||
          typeof target !== "object" ||
          !conversationIds.includes(target.conversationId) ||
          !validId(target.pendingMessageId) ||
          !Array.isArray(target.targetMessageIds) ||
          target.targetMessageIds.length === 0 ||
          !target.targetMessageIds.every(validId),
      )
    )
      throw new Error("ORACLE_APPROVAL_EVENT_TARGET_INVALID");
  }
  if (
    observationOptions?.recoveryConversationIds !== undefined &&
    (!Array.isArray(observationOptions.recoveryConversationIds) ||
      observationOptions.recoveryConversationIds.some((id) => !conversationIds.includes(id)))
  )
    throw new Error("ORACLE_RECOVERY_CONVERSATION_ID_INVALID");
  if (
    observationOptions?.activeGoalConversationIds !== undefined &&
    (!Array.isArray(observationOptions.activeGoalConversationIds) ||
      observationOptions.activeGoalConversationIds.some(
        (id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(id),
      ))
  )
    throw new Error("ORACLE_ACTIVE_GOAL_CONVERSATION_ID_INVALID");
  if (
    observationOptions?.goalCompletionReceipts !== undefined &&
    (!Array.isArray(observationOptions.goalCompletionReceipts) ||
      observationOptions.goalCompletionReceipts.some((id) => !conversationIds.includes(id)))
  )
    throw new Error("ORACLE_GOAL_COMPLETION_RECEIPT_INVALID");
  if (observationOptions?.goalCompletionTurns !== undefined) {
    const turns = observationOptions.goalCompletionTurns;
    const identifier = (value: unknown) =>
      typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(value);
    if (
      !turns ||
      typeof turns !== "object" ||
      Array.isArray(turns) ||
      Object.entries(turns).some(
        ([id, entries]) =>
          !observationOptions.goalCompletionReceipts?.includes(id) ||
          !Array.isArray(entries) ||
          entries.length === 0 ||
          entries.some(
            (turn) =>
              !turn ||
              !identifier(turn.turnId) ||
              !Array.isArray(turn.messageIds) ||
              !turn.messageIds.every(identifier),
          ),
      )
    )
      throw new Error("ORACLE_GOAL_COMPLETION_RECEIPT_INVALID");
  }
  if (observationOptions?.goalCompletionFinalIds !== undefined) {
    const finals = observationOptions.goalCompletionFinalIds;
    if (
      finals === null ||
      typeof finals !== "object" ||
      Array.isArray(finals) ||
      Object.entries(finals).some(
        ([id, values]) =>
          !observationOptions.goalCompletionReceipts?.includes(id) ||
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some(
            (value) =>
              typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(value),
          ),
      )
    )
      throw new Error("ORACLE_GOAL_COMPLETION_RECEIPT_INVALID");
  }
  if (observationOptions?.canonicalResourceOrigin !== undefined) {
    let origin: URL;
    try {
      origin = new URL(observationOptions.canonicalResourceOrigin);
    } catch {
      throw new Error("ORACLE_MESSAGE_STRUCTURE_RESOURCE_ORIGIN_INVALID");
    }
    if (
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.origin !== observationOptions.canonicalResourceOrigin
    ) {
      throw new Error("ORACLE_MESSAGE_STRUCTURE_RESOURCE_ORIGIN_INVALID");
    }
  }
  return `(${ORACLE_CHATGPT_SERVER_APPROVAL_SCAN_SOURCE})(${JSON.stringify(connectorId)},${JSON.stringify(connectorName)},${JSON.stringify(conversationIds)},${JSON.stringify(acknowledgedReceiptIds)}${observationOptions === undefined ? "" : `,${JSON.stringify(observationOptions)}`})`;
}

export function isOracleChatGptServerApprovalScanExpression(
  value: unknown,
  connectorId: string,
  connectorName: string,
): boolean {
  if (typeof value !== "string") return false;
  const prefix = `(${ORACLE_CHATGPT_SERVER_APPROVAL_SCAN_SOURCE})(${JSON.stringify(connectorId)},${JSON.stringify(connectorName)},`;
  if (!value.startsWith(prefix) || !value.endsWith(")")) return false;
  try {
    const args: unknown = JSON.parse(`[${value.slice(prefix.length, -1)}]`);
    return (
      Array.isArray(args) &&
      (args.length === 2 || args.length === 3) &&
      args
        .slice(0, 2)
        .every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string")) &&
      value ===
        oracleChatGptServerApprovalScanExpression(
          connectorId,
          connectorName,
          args[0],
          args[1],
          args[2],
        )
    );
  } catch {
    return false;
  }
}

function assertConnectorId(connectorId: string): void {
  if (!/^asdk_app_[a-z0-9]+$/iu.test(connectorId)) {
    throw new Error("CHATGPT_CONNECTOR_ID_INVALID");
  }
}
