import {
  type ChromeGoalContinuationTarget,
  goalContinuationPrompt,
} from "../../application/chrome-goal-continuation.js";
import { normalizeChatGptConversationUrl } from "./chatgpt-conversation-route.js";
import {
  ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION,
  ORACLE_RATE_LIMIT_RESPONSE_HEADERS,
} from "./oracle-chatgpt-server-approval-script.js";
import { ORACLE_GOAL_CONVERSATION_SOURCE } from "./oracle-goal-conversation.js";

/** Fixed ordinary-Chat operation on the existing authenticated native request client. */
const CONTINUE = `async function oracleContinueGoal(connectorId, target, prompt) {
  const currentAccount = () => ${ORACLE_CHATGPT_ACCOUNT_SOURCE_EXPRESSION};
  const accountSourceId = currentAccount();
  const matchesAccount = () => target.accountSourceId === undefined || currentAccount() === target.accountSourceId;
  if (!matchesAccount()) return { outcome: "account_source_mismatch" };
  const runtimeKey = "__omnicodexOracleServerApprovalV2:" + connectorId;
  const runtime = globalThis[runtimeKey];
  const localRetryPacingMs = 30_000;
  const persistCooldown = () => {
    const durable = JSON.parse(localStorage.getItem(runtimeKey) || "null");
    if (durable && typeof durable === "object") {
      durable.backoffUntil = runtime.backoffUntil;
      durable.backoffMs = runtime.backoffMs;
      durable.lastRateLimit = runtime.lastRateLimit;
      localStorage.setItem(runtimeKey, JSON.stringify(durable));
    }
  };
  let sendAccepted = false;
  let provenUnsent = false;
  if (accountSourceId !== null && runtime?.lastRateLimit?.accountSourceId &&
      runtime.lastRateLimit.accountSourceId !== accountSourceId) {
    runtime.backoffUntil = 0;
    runtime.backoffMs = localRetryPacingMs;
    runtime.lastRateLimit = null;
  }
  // Retire previously accumulated local pacing, never a server deadline.
  if (runtime?.lastRateLimit?.observedAtUnixMs != null &&
      ["local_backoff", "server_retry_after"].includes(runtime.lastRateLimit.backoffSource)) {
    const retryAt = Math.max(Number(runtime.lastRateLimit.observedAtUnixMs) + localRetryPacingMs,
      Number(runtime.lastRateLimit.serverRetryAtUnixMs) || 0);
    if (Number(runtime.backoffUntil) > retryAt) {
      runtime.backoffUntil = retryAt;
      runtime.backoffMs = localRetryPacingMs;
      runtime.lastRateLimit = { ...runtime.lastRateLimit, retryAtUnixMs: retryAt,
        localBackoffMs: localRetryPacingMs,
        backoffSource: Number(runtime.lastRateLimit.serverRetryAtUnixMs) >= retryAt
          ? "server_retry_after" : "local_backoff" };
      persistCooldown();
    }
  }
  const execute = async () => {
  const client = runtime?.requestClient;
  const module = runtime?.module;
  if (!client?.safeGet || !client?.safePost || !client?.request || !module) return { outcome: "runtime_not_ready" };
  if (Number(runtime.backoffUntil) > Date.now()) return { outcome: "rate_limited" };
  const project = ${ORACLE_GOAL_CONVERSATION_SOURCE};
  const conversationId = new URL(target.conversationUrl).pathname.slice(3);
  const clientMessageId = target.draft.token;
  const key = "__omnicodexGoalDispatches:" + connectorId;
  // A durable client identity supplements the server's dispatching claim. A
  // lost HTTP/CDP response must not turn into another user message on restart.
  let journal;
  try { journal = JSON.parse(localStorage.getItem(key) || "{}"); }
  catch { throw new Error("ORACLE_GOAL_DISPATCH_STORAGE_UNAVAILABLE"); }
  if (!journal || typeof journal !== "object" || Array.isArray(journal))
    throw new Error("ORACLE_GOAL_DISPATCH_STORAGE_INVALID");
  // A prior journal entry is uncertain delivery, even if this invocation's
  // first read fails. Only a newly claimed, unjournaled send can be retried.
  provenUnsent = target.operation === "send" && target.draft.state === "dispatching" &&
    !journal[clientMessageId];
  const statusOf = value => [value?.status, value?.statusCode, value?.response?.status, value?.cause?.status]
    .find(status => Number.isInteger(status) && status >= 100 && status <= 599);
  const coolDown = (value, operation) => {
    if (statusOf(value) !== 429) return;
    const observedAtUnixMs = Date.now();
    const responseHeaders = {};
    for (const name of ${JSON.stringify(ORACLE_RATE_LIMIT_RESPONSE_HEADERS)}) {
      const header = value?.headers?.get?.(name) ?? value?.response?.headers?.get?.(name)
        ?? value?.headers?.[name] ?? value?.response?.headers?.[name];
      if (typeof header === "string") responseHeaders[name] = header;
    }
    const retryAfter = responseHeaders["retry-after"]?.trim();
    const deadline = !retryAfter ? NaN : /^\\d+(?:\\.\\d+)?$/.test(retryAfter)
      ? observedAtUnixMs + Math.ceil(Number(retryAfter) * 1000) : Date.parse(retryAfter);
    const serverRetryAtUnixMs = Number.isSafeInteger(deadline) && deadline >= 0
      ? Math.max(observedAtUnixMs, deadline) : undefined;
    const localBackoffMs = localRetryPacingMs;
    runtime.backoffUntil = Math.max(Number(runtime.backoffUntil) || 0,
      observedAtUnixMs + localBackoffMs, serverRetryAtUnixMs ?? 0);
    runtime.backoffMs = localRetryPacingMs;
    runtime.lastRateLimit = { status: 429, operation, retryAtUnixMs: runtime.backoffUntil,
      ...(accountSourceId === null ? {} : { accountSourceId }),
      observedAtUnixMs, localBackoffMs, statusEvidence: "http_status", responseHeaders,
      backoffSource: serverRetryAtUnixMs !== undefined && serverRetryAtUnixMs >= observedAtUnixMs + localBackoffMs
        ? "server_retry_after" : "local_backoff",
      ...(serverRetryAtUnixMs === undefined ? {} : { serverRetryAtUnixMs }) };
    persistCooldown();
  };
  const read = async () => {
    if (!matchesAccount()) throw new Error("ORACLE_GOAL_ACCOUNT_SOURCE_MISMATCH");
    const path = "/conversations/" + encodeURIComponent(conversationId);
    const conversation = await client.safeGet(path, {
      // Continuation only needs the current branch head, the active turn's
      // Goal result and the explicit parent id leading to its checkpoint.
      // The native mapping contains the entire historical conversation and
      // grows without bound on long-running Pro tasks.
      parameters: { query: { include_has_versions: true, num_turns: 1 } },
      disableAutomaticRetry: true,
    }).catch(error => { coolDown(error, "goal_current_turn_read"); throw error; });
    if (!matchesAccount()) throw new Error("ORACLE_GOAL_ACCOUNT_SOURCE_MISMATCH");
    if (conversation?.conversation_id !== undefined && conversation.conversation_id !== conversationId)
      throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
    if (conversation?.id !== undefined && conversation.id !== conversationId)
      throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
    return conversation;
  };
  const inspect = conversation => {
    if (conversation?.conversation_id !== conversationId) return "conversation_changed";
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const persisted = messages.find(message => message.id === clientMessageId);
    if (persisted) {
      return persisted.author?.role === "user" && persisted.content?.content_type === "text" &&
        persisted.content.parts?.length === 1 && persisted.content.parts[0] === prompt
        ? "sent" : "conversation_changed";
    }
    // A dispatching draft without either its exact persisted message or the
    // renderer journal claim never crossed the final pre-send boundary. This
    // is the only uncertain dispatch that can safely return to ready.
    if (target.operation === "inspect" && target.draft.state === "dispatching" &&
        !journal[clientMessageId]) return "send_not_started";
    const projection = project(conversationId, conversation, connectorId);
    // The exact connector's real tool result is required, never assistant prose
    // or an OAuth identity shared by unrelated ChatGPT accounts.
    const results = projection.goals.filter(goal => goal.goalId === target.goalId)
      .sort((a, b) => b.revision - a.revision);
    if (!results.length) return "goal_binding_unverified";
    if (results[0].state !== "active") return "superseded";
    // A paginated native branch can omit the older anchor while still
    // exposing its newer exact head. Resolve that stale draft as superseded
    // before requiring the anchor body, otherwise it remains ready forever.
    if (projection.current?.id !== target.draft.afterMessageId) return "superseded";
    const anchor = messages.find(message => message.id === target.draft.afterMessageId);
    if (!anchor) return "anchor_not_visible";
    const completedAssistant = projection.current.authorRole === "assistant" &&
      projection.current.status === "finished_successfully" &&
      projection.current.endTurn === true &&
      (projection.current.channel === undefined || projection.current.channel === "final");
    const idleUserRecovery = target.draft.resumeIdleUserTurn === true &&
      projection.current.authorRole === "user" &&
      projection.current.status === "finished_successfully";
    const idleIncompleteRecovery = target.draft.resumeIdleIncompleteTurn === true &&
      projection.current.authorRole === "assistant" &&
      projection.current.status === "finished_successfully" &&
      projection.current.endTurn !== true;
    if (!completedAssistant && !idleUserRecovery && !idleIncompleteRecovery) return "generating";
    if (conversation.is_read_only === true) return "conversation_read_only";
    const model = conversation.default_model_slug;
    if (typeof model !== "string" || !model) return "model_settings_unavailable";
    return "ready";
  };
  const branchToolMetadata = conversation => {
    const messages = conversation.messages;
    const anchor = messages.find(message => message.id === target.draft.afterMessageId);
    const ancestors = project(conversationId, conversation, connectorId).current?.ancestorMessageIds;
    // Explicit native parent edges outrank arrival order and unrelated branches.
    const byId = new Map(messages.map(message => [message.id, message]));
    const branchMessages = Array.isArray(ancestors)
      ? ancestors.map(id => byId.get(id))
      : messages.slice(0, messages.indexOf(anchor)).reverse();
    const metadata = {};
    // Native Chat uses system_hints for connector/plugin selection as well as
    // selected_sources. Preserve actual selections, including explicit clears.
    for (const field of ["selected_sources", "system_hints"]) {
      const selected = branchMessages.find(message =>
        message?.author?.role === "user" && Array.isArray(message.metadata?.[field]));
      if (selected !== undefined) metadata[field] = selected.metadata[field];
    }
    return metadata;
  };
  const initial = await read();
  const initialOutcome = inspect(initial);
  if (initialOutcome !== "ready" || target.operation === "inspect") return { outcome: initialOutcome };
  if (target.draft.state !== "dispatching") throw new Error("ORACLE_GOAL_DISPATCH_NOT_CLAIMED");
  if (journal[clientMessageId]) return { outcome: "send_unconfirmed" };
  const requirements = await module.Eo(false, "none", 1);
  const [proof, turnstile] = await Promise.all([
    module.Uo.getEnforcementToken(requirements, { forceSync: true }),
    module.zo.getEnforcementToken(requirements),
  ]);
  await module.Fo("conversation");
  // ChatGPT Pro prepares the exact turn before the streaming request. Skipping
  // this contract can persist the user message without ever starting a model
  // turn. Prepare against the current parent, then prove that the branch and
  // settings still match before sending.
  const beforePrepare = await read();
  const beforePrepareOutcome = inspect(beforePrepare);
  if (beforePrepareOutcome !== "ready") return { outcome: beforePrepareOutcome };
  const beforePrepareAnchor = beforePrepare.messages.find(
    message => message.id === target.draft.afterMessageId,
  );
  const conversationMode = beforePrepare.gizmo_id
    ? { kind: "gizmo_interaction", gizmo_id: beforePrepare.gizmo_id }
    : { kind: "primary_assistant" };
  const prepareToolMetadata = branchToolMetadata(beforePrepare);
  const prepareBody = {
    action: "next", conversation_id: conversationId,
    parent_message_id: beforePrepare.current_node, model: beforePrepare.default_model_slug,
    client_prepare_state: "none", timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: conversationMode,
    ...(prepareToolMetadata.system_hints === undefined
      ? {} : { system_hints: prepareToolMetadata.system_hints }),
    ...(beforePrepare.gizmo_id ? { gizmo_id: beforePrepare.gizmo_id } : {}),
    ...(beforePrepare.conversation_origin == null
      ? {} : { conversation_origin: beforePrepare.conversation_origin }),
    ...(beforePrepare.is_do_not_remember == null
      ? {} : { is_do_not_remember: beforePrepare.is_do_not_remember }),
    ...(typeof beforePrepareAnchor?.metadata?.thinking_effort === "string"
      ? { thinking_effort: beforePrepareAnchor.metadata.thinking_effort } : {}),
    supports_buffering: true, supported_encodings: ["v1"],
  };
  let prepared;
  if (!matchesAccount()) return { outcome: "account_source_mismatch" };
  try {
    prepared = await client.safePost("/f/conversation/prepare", {
      requestBody: prepareBody, authOption: 1, disableAutomaticRetry: true,
    });
  } catch (error) {
    coolDown(error, "goal_prepare");
    const status = statusOf(error);
    return {
      outcome: status === 429 ? "rate_limited" : "send_rejected",
      error: "ORACLE_GOAL_PREPARE_HTTP_" + (status ?? "UNKNOWN"),
    };
  }
  const conduitToken = typeof prepared?.conduit_token === "string" && prepared.conduit_token
    ? prepared.conduit_token : undefined;
  const conversation = await read();
  const freshOutcome = inspect(conversation);
  if (freshOutcome !== "ready") return { outcome: freshOutcome };
  const messages = conversation.messages;
  const anchor = messages.find(message => message.id === target.draft.afterMessageId);
  const toolMetadata = branchToolMetadata(conversation);
  const outgoing = [];
  if (Array.isArray(conversation.disabled_tool_ids) && conversation.disabled_tool_ids.length) {
    outgoing.push({ id: crypto.randomUUID(), author: { role: "system" },
      content: { content_type: "text", parts: [""] },
      metadata: { disable_tool_ids: conversation.disabled_tool_ids } });
  }
  outgoing.push({ id: clientMessageId, author: { role: "user" }, create_time: Date.now() / 1000,
    content: { content_type: "text", parts: [prompt] },
    metadata: {
      ...toolMetadata,
      serialization_metadata: { custom_symbol_offsets: [] },
    } });
  const body = {
    action: "next", messages: outgoing, conversation_id: conversationId,
    parent_message_id: conversation.current_node, model: conversation.default_model_slug,
    ...(toolMetadata.system_hints === undefined
      ? {} : { system_hints: toolMetadata.system_hints }),
    client_prepare_state: "success", timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    conversation_mode: conversation.gizmo_id
      ? { kind: "gizmo_interaction", gizmo_id: conversation.gizmo_id }
      : { kind: "primary_assistant" },
    ...(conversation.gizmo_id ? { gizmo_id: conversation.gizmo_id } : {}),
    ...(conversation.conversation_origin == null ? {} : { conversation_origin: conversation.conversation_origin }),
    ...(conversation.is_do_not_remember == null ? {} : { is_do_not_remember: conversation.is_do_not_remember }),
    ...(typeof anchor.metadata?.thinking_effort === "string"
      ? { thinking_effort: anchor.metadata.thinking_effort } : {}),
    supports_buffering: true, supported_encodings: ["v1"],
  };
  // Recheck/claim without yielding, including competing executions in this
  // same renderer. Never store a token or the conversation text in the journal.
  try { journal = JSON.parse(localStorage.getItem(key) || "{}"); }
  catch { throw new Error("ORACLE_GOAL_DISPATCH_STORAGE_UNAVAILABLE"); }
  if (journal[clientMessageId]) return { outcome: "send_unconfirmed" };
  if (!matchesAccount()) return { outcome: "account_source_mismatch" };
  provenUnsent = false;
  journal[clientMessageId] = { conversationId, afterMessageId: target.draft.afterMessageId };
  localStorage.setItem(key, JSON.stringify(journal));
  let response;
  try {
    response = await client.request("post", "/f/conversation", {
      requestBody: body,
      additionalHeaders: {
        ...module.Ao(requirements, turnstile, proof, null, null,
          globalThis.SentinelSDK?.timing?.() ?? "[1,null]"),
        ...(conduitToken === undefined ? {} : { "x-conduit-token": conduitToken }),
      },
      authOption: 1, disableAutomaticRetry: true,
    });
  } catch (error) {
    coolDown(error, "goal_send");
    const status = statusOf(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      delete journal[clientMessageId];
      localStorage.setItem(key, JSON.stringify(journal));
      return { outcome: "send_rejected", error: "ORACLE_GOAL_SEND_HTTP_" + status };
    }
    throw new Error("ORACLE_GOAL_SEND_UNCONFIRMED", { cause: error });
  }
  if (!response || response.status < 200 || response.status >= 300 || typeof response.status !== "number") {
    coolDown(response, "goal_send");
    try { await response?.body?.cancel?.(); } catch {}
    if (response?.status >= 400 && response.status < 500 && response.status !== 408) {
      delete journal[clientMessageId];
      localStorage.setItem(key, JSON.stringify(journal));
      return { outcome: "send_rejected", error: "ORACLE_GOAL_SEND_HTTP_" + response.status };
    }
    throw new Error("ORACLE_GOAL_SEND_HTTP_" + (response?.status ?? "UNKNOWN"));
  }
  // Drain the accepted native stream rather than cancelling generation when
  // the CDP call returns. Completion is still proven by persisted readback.
  sendAccepted = true;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const drain = (async () => { try { while (!(await reader.read()).done) {} } finally { reader.releaseLock(); } })();
    runtime.drains ??= new Set();
    runtime.drains.add(drain);
    void drain.catch(() => {}).finally(() => runtime.drains.delete(drain));
  }
  const outcome = inspect(await read());
  return { outcome: outcome === "sent" || outcome === "superseded" ? outcome : "send_unconfirmed" };
  };
  try {
    const result = await execute();
    return { ...result, ...(runtime?.lastRateLimit == null ? {} : { rateLimit: runtime.lastRateLimit }) };
  } catch (error) {
    if (error?.message === "ORACLE_GOAL_ACCOUNT_SOURCE_MISMATCH")
      return { outcome: sendAccepted ? "send_unconfirmed" : "account_source_mismatch" };
    if (runtime?.lastRateLimit?.retryAtUnixMs > Date.now() &&
        [error?.status, error?.statusCode, error?.response?.status, error?.cause?.status].includes(429)) {
      return { outcome: "rate_limited", error: String(error?.message ?? error), rateLimit: runtime.lastRateLimit };
    }
    if (provenUnsent) return { outcome: "send_not_started", error: String(error?.message ?? error) };
    throw error;
  }
}`;

export function oracleGoalContinuationExpression(
  connectorId: string,
  target: ChromeGoalContinuationTarget,
): string {
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(value);
  if (
    !/^asdk_app_[a-z0-9]+$/iu.test(connectorId) ||
    !target ||
    normalizeChatGptConversationUrl(target.conversationUrl) !== target.conversationUrl ||
    (target.accountSourceId !== undefined &&
      !/^chatgpt:[^:]+:[^:]+$/u.test(target.accountSourceId)) ||
    !identifier(target.goalId) ||
    !identifier(target.draft?.afterMessageId) ||
    !identifier(target.draft?.token) ||
    !["inspect", "send"].includes(target.operation) ||
    !["ready", "prepared", "dispatching", "sent", "cancelled"].includes(target.draft.state)
  )
    throw new Error("ORACLE_GOAL_TARGET_INVALID");
  const input = {
    goalId: target.goalId,
    conversationUrl: target.conversationUrl,
    ...(target.accountSourceId === undefined ? {} : { accountSourceId: target.accountSourceId }),
    draft: {
      token: target.draft.token,
      afterMessageId: target.draft.afterMessageId,
      state: target.draft.state,
      ...(target.draft.resumeIdleUserTurn === true ? { resumeIdleUserTurn: true } : {}),
      ...(target.draft.resumeIdleIncompleteTurn === true ? { resumeIdleIncompleteTurn: true } : {}),
    },
    operation: target.operation,
  };
  return `(${CONTINUE})(${JSON.stringify(connectorId)},${JSON.stringify(input)},${JSON.stringify(goalContinuationPrompt(target.goalId))})`;
}

export function isOracleGoalContinuationExpression(value: unknown, connectorId: string): boolean {
  const prefix = `(${CONTINUE})(${JSON.stringify(connectorId)},`;
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith(")")) return false;
  try {
    const args = JSON.parse(`[${value.slice(prefix.length, -1)}]`);
    return args.length === 2 && value === oracleGoalContinuationExpression(connectorId, args[0]);
  } catch {
    return false;
  }
}
