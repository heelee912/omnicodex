import { normalizeChatGptConversationUrl } from "./chatgpt-conversation-route.js";

export interface OracleGoalResult {
  /** Server-attributed registration after exact invoked-resource verification. */
  readonly connectorId?: string;
  readonly toolName: string;
  readonly goalId: string;
  readonly state: "active" | "paused" | "completed" | "blocked";
  readonly revision: number;
  readonly createdAtUnixMs: number;
}

export function parseOracleGoalConversation(value: unknown): OracleGoalConversation {
  const invalid = (): never => {
    throw new Error("ORACLE_GOAL_CONVERSATION_INVALID");
  };
  const object = (input: unknown): input is Record<string, unknown> =>
    typeof input === "object" && input !== null && !Array.isArray(input);
  const identifier = (input: unknown): input is string =>
    typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(input);
  if (
    !object(value) ||
    typeof value.conversationUrl !== "string" ||
    normalizeChatGptConversationUrl(value.conversationUrl) !== value.conversationUrl ||
    !Array.isArray(value.goals)
  )
    return invalid();
  let source: OracleGoalConversation["source"];
  if (value.source !== undefined) {
    if (
      !object(value.source) ||
      (value.source.kind !== "desktop" && value.source.kind !== "web") ||
      typeof value.source.accountSourceId !== "string" ||
      !/^chatgpt:[^:]+:[^:]+$/.test(value.source.accountSourceId)
    )
      return invalid();
    source = { kind: value.source.kind, accountSourceId: value.source.accountSourceId };
  }
  const goals = value.goals.map((goal): OracleGoalConversation["goals"][number] => {
    if (
      !object(goal) ||
      !identifier(goal.messageId) ||
      typeof goal.goalId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(goal.goalId) ||
      typeof goal.toolName !== "string" ||
      !/^omnicodex__goal_(?:create|get|claim_next_step|complete|update)$/.test(goal.toolName) ||
      (goal.state !== "active" &&
        goal.state !== "paused" &&
        goal.state !== "completed" &&
        goal.state !== "blocked") ||
      typeof goal.revision !== "number" ||
      !Number.isSafeInteger(goal.revision) ||
      goal.revision < 1 ||
      typeof goal.createdAtUnixMs !== "number" ||
      !Number.isSafeInteger(goal.createdAtUnixMs) ||
      goal.createdAtUnixMs < 0
    )
      return invalid();
    return {
      messageId: goal.messageId,
      goalId: goal.goalId,
      toolName: goal.toolName,
      state: goal.state,
      revision: goal.revision,
      createdAtUnixMs: goal.createdAtUnixMs,
    };
  });
  const requestedGoalId = value.requestedGoalId;
  if (
    requestedGoalId !== undefined &&
    (typeof requestedGoalId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestedGoalId) ||
      !goals.some((goal) => goal.goalId === requestedGoalId))
  )
    return invalid();
  const current = value.current;
  if (current === undefined)
    return {
      conversationUrl: value.conversationUrl,
      goals,
      ...(source === undefined ? {} : { source }),
      ...(requestedGoalId === undefined ? {} : { requestedGoalId }),
    };
  if (
    !object(current) ||
    !identifier(current.id) ||
    (current.endTurn !== undefined && typeof current.endTurn !== "boolean") ||
    ["authorRole", "status", "channel"].some(
      (key) => current[key] !== undefined && typeof current[key] !== "string",
    )
  )
    return invalid();
  if (
    current.ancestorMessageIds !== undefined &&
    (!Array.isArray(current.ancestorMessageIds) ||
      current.ancestorMessageIds.some((id) => !identifier(id) || id === current.id) ||
      new Set(current.ancestorMessageIds).size !== current.ancestorMessageIds.length)
  )
    return invalid();
  return {
    conversationUrl: value.conversationUrl,
    ...(source === undefined ? {} : { source }),
    ...(requestedGoalId === undefined ? {} : { requestedGoalId }),
    goals,
    current: {
      id: current.id,
      ...(current.ancestorMessageIds === undefined
        ? {}
        : {
            ancestorMessageIds: current.ancestorMessageIds as string[],
          }),
      ...(current.authorRole === undefined ? {} : { authorRole: current.authorRole as string }),
      ...(current.status === undefined ? {} : { status: current.status as string }),
      ...(current.channel === undefined ? {} : { channel: current.channel as string }),
      ...(current.endTurn === undefined ? {} : { endTurn: current.endTurn as boolean }),
    },
  };
}

export interface OracleGoalConversation {
  readonly conversationUrl: string;
  /** Latest exact Goal id named by a user message on the current native branch. */
  readonly requestedGoalId?: string;
  /** Locally verified native task status; never accepted from the remote projection. */
  readonly nativeTaskStatus?: "active" | "idle";
  /** Captured locally before native read; never accepted from a remote tool result. */
  readonly checkpoint?: {
    readonly goalId: string;
    readonly revision: number;
    readonly settledMessageId?: string;
  };
  /** Present only after the source account and conversation have been verified. */
  readonly source?: { readonly kind: "desktop" | "web"; readonly accountSourceId: string };
  readonly goals: readonly (OracleGoalResult & { readonly messageId: string })[];
  readonly current?: {
    readonly id: string;
    /** Native parent edges from this current branch, nearest ancestor first; never arrival order. */
    readonly ancestorMessageIds?: readonly string[];
    readonly authorRole?: string;
    readonly status?: string;
    readonly endTurn?: boolean;
    readonly channel?: string;
  };
}

/** Fixed projection executed in the existing signed-in request client. No additional request. */
export const ORACLE_GOAL_CONVERSATION_SOURCE = `function projectGoalConversation(conversationId, conversation, connectorId) {
  let messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  if (conversation?.mapping && typeof conversation.mapping === "object") {
    const projectedMessages = messages;
    const branch = [];
    const visited = new Set();
    let id = conversation.current_node;
    while (typeof id === "string" && !visited.has(id)) {
      visited.add(id);
      const node = conversation.mapping[id];
      if (!node) break;
      if (node.message) {
        const message = node.message;
        // Some native branch responses retain tool identity but omit its text.
        // Hydrate only an exact matching result; branch edges and attribution
        // remain those returned by the native mapping.
        const matches = message.author?.role === "tool" && message.author?.name === "api_tool.call_tool" &&
          message.content?.text === "" ? projectedMessages.filter(candidate =>
          candidate?.id === message.id && candidate?.author?.role === message.author?.role &&
          candidate?.author?.name === message.author?.name && candidate?.status === message.status &&
          candidate?.metadata?.invoked_resource?.resource_uri === message.metadata?.invoked_resource?.resource_uri &&
          typeof candidate?.content?.text === "string" && candidate.content.text.length > 0) : [];
        const text = matches[0]?.content.text;
        branch.push(matches.length > 0 && matches.every(candidate => candidate.content.text === text)
          ? { ...message, content: { ...message.content, text } } : message);
      }
      id = node.parent;
    }
    messages = branch.reverse();
  }
  const goals = [];
  for (const message of messages) {
    if (message?.author?.role !== "tool" || message?.author?.name !== "api_tool.call_tool" ||
        message?.status !== "finished_successfully" || typeof message.id !== "string") continue;
    const path = message.metadata?.invoked_resource?.resource_uri;
    if (typeof path !== "string") continue;
    const parts = path.split("/");
    if (parts.length !== 4 || parts[0] !== "" || parts[1] !== connectorId ||
        !/^link_[a-z0-9]+$/i.test(parts[2]) ||
        !["omnicodex__goal_create", "omnicodex__goal_get", "omnicodex__goal_claim_next_step", "omnicodex__goal_complete", "omnicodex__goal_update"].includes(parts[3])) continue;
    let decoded;
    try { decoded = JSON.parse(message.content?.text); } catch { continue; }
    const goal = parts[3] === "omnicodex__goal_claim_next_step" ? decoded?.goal : decoded;
    if (!goal || typeof goal !== "object" || Array.isArray(goal) ||
        typeof goal.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(goal.id) ||
        !["active", "paused", "completed", "blocked"].includes(goal.state) || !Number.isSafeInteger(goal.revision) || goal.revision < 1 ||
        !Number.isSafeInteger(goal.createdAtUnixMs) || goal.createdAtUnixMs < 0 || !Array.isArray(goal.steps)) continue;
    goals.push({ messageId: message.id, toolName: parts[3], goalId: goal.id, state: goal.state,
      revision: goal.revision, createdAtUnixMs: goal.createdAtUnixMs });
  }
  const observedGoalIds = new Map(goals.map(goal => [goal.goalId.toLowerCase(), goal.goalId]));
  let requestedGoalId;
  for (let index = messages.length - 1; index >= 0 && requestedGoalId === undefined; index -= 1) {
    const message = messages[index];
    if (message?.author?.role !== "user") continue;
    const content = message.content;
    const text = [typeof content?.text === "string" ? content.text : "",
      ...(Array.isArray(content?.parts) ? content.parts.filter(part => typeof part === "string") : [])].join("\\n");
    const matches = [...new Set((text.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/ig) ?? [])
      .map(id => observedGoalIds.get(id.toLowerCase())).filter(Boolean))];
    if (matches.length === 1) requestedGoalId = matches[0];
  }
  let current = messages.find(message => typeof message?.id === "string" && message.id === conversation?.current_node);
  // Pro can leave current_node on a trailing thinking preamble after its
  // final answer has persisted. Resolve only an unambiguous final from that
  // exact native turn, never the array tail or an older completed answer.
  if (current?.metadata?.is_thinking_preamble_message === true &&
      typeof current.metadata.working_turn_id === "string" && current.metadata.working_turn_id.length > 0) {
    const finals = messages.filter(message => message?.author?.role === "assistant" &&
      message.status === "finished_successfully" && message.end_turn === true && message.channel === "final" &&
      typeof message.id === "string" && message.metadata?.working_turn_id === current.metadata.working_turn_id &&
      (current.metadata.turn_exchange_id === undefined || message.metadata?.turn_exchange_id === current.metadata.turn_exchange_id));
    if (finals.length === 1) current = finals[0];
  }
  // Only explicit parent edges establish ancestry. Array order, clocks and
  // native turn identifiers cannot prove that a candidate follows a checkpoint.
  const ancestors = [];
  const seen = new Set(current === undefined ? [] : [current.id]);
  let nodeId = current?.id;
  while (typeof nodeId === "string") {
    const mapped = conversation?.mapping?.[nodeId];
    const node = mapped?.message ?? messages.find(message => message?.id === nodeId);
    // Mapping nodes can deliberately contain no message. Their explicit
    // parent edges still carry the current branch across a checkpoint.
    // An explicit null parent ends that branch, even if message metadata has
    // an older conflicting edge.
    const parent = mapped && Object.hasOwn(mapped, "parent")
      ? mapped.parent : node?.parent_id ?? node?.metadata?.parent_id;
    if (typeof parent !== "string") break;
    if (seen.has(parent)) { ancestors.length = 0; break; }
    seen.add(parent);
    ancestors.push(parent);
    nodeId = parent;
  }
  return { conversationUrl: "https://chatgpt.com/c/" + conversationId, goals,
    ...(requestedGoalId === undefined ? {} : { requestedGoalId }),
    ...(current === undefined ? {} : { current: {
      id: current.id,
      ...(ancestors.length === 0 ? {} : { ancestorMessageIds: ancestors }),
      ...(typeof current.author?.role === "string" ? { authorRole: current.author.role } : {}),
      ...(typeof current.status === "string" ? { status: current.status } : {}),
      ...(typeof current.end_turn === "boolean" ? { endTurn: current.end_turn } : {}),
      ...(typeof current.channel === "string" ? { channel: current.channel } : {}),
    } }) };
}`;
