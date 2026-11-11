export const ORACLE_GOAL_BODY_HYDRATION_SOURCE = `async function hydrateGoalBodies(connectorId, recordRequest, conversationId, conversation, requestClient, operation, recoveredMessages = []) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object") return conversation;
    const wanted = new Map();
    const visited = new Set();
    let cursor = conversation.current_node;
    while (typeof cursor === "string" && !visited.has(cursor)) {
      visited.add(cursor);
      const node = mapping[cursor];
      if (!node) break;
      const message = node.message;
      const uri = message?.metadata?.invoked_resource?.resource_uri;
      const parts = typeof uri === "string" ? uri.split("/") : undefined;
      if (message?.author?.role === "tool" && message.author.name === "api_tool.call_tool" &&
          message.status === "finished_successfully" && typeof message.id === "string" &&
          message.content?.text === "" && parts?.length === 4 && parts[1] === connectorId &&
          /^link_[a-z0-9]+$/i.test(parts[2]) &&
          /^omnicodex__goal_(?:create|get|claim_next_step|complete|update)$/.test(parts[3])) wanted.set(message.id, message);
      cursor = node.parent;
    }
    if (wanted.size === 0) return conversation;
    const hydrated = { ...conversation, messages: recoveredMessages.filter(message => wanted.has(message?.id)) };
      // A recovered body may be an authoritative tool error, not a Goal.
      // Confirm exact, unambiguous text independently of successful Goal parsing.
      // Keep the original body untouched; projection alone decides whether it is a Goal.
      const recovered = () => [...wanted].every(([messageId, original]) => {
        const matches = hydrated.messages.filter(candidate => candidate?.id === messageId &&
          candidate?.author?.role === original.author.role && candidate?.author?.name === original.author.name &&
          candidate?.status === original.status &&
          candidate?.metadata?.invoked_resource?.resource_uri === original.metadata.invoked_resource.resource_uri &&
          typeof candidate?.content?.text === "string" && candidate.content.text.length > 0);
        return matches.length > 0 && matches.every(candidate => candidate.content.text === matches[0].content.text);
      });
    if (recovered()) return hydrated;
    recordRequest("GET", "/conversations/" + encodeURIComponent(conversationId), operation, conversationId);
    let page = await requestClient.safeGet("/conversations/" + encodeURIComponent(conversationId), {
      parameters: { query: { include_has_versions: true, num_turns: 1 } }, disableAutomaticRetry: true,
    });
    const cursors = new Set();
    for (;;) {
      if (page?.conversation_id !== undefined && page.conversation_id !== conversationId)
        throw new Error("ORACLE_GOAL_CONVERSATION_MISMATCH");
      if (Array.isArray(page?.messages)) hydrated.messages.push(...page.messages.filter(message => wanted.has(message?.id)));
      if (recovered()) return hydrated;
      const cursor = page?.page_info?.has_previous_page === true ? page.page_info.start_cursor : null;
      if (typeof cursor !== "string" || cursor.length === 0) throw new Error("ORACLE_GOAL_BODY_READBACK_INCOMPLETE");
      if (cursors.has(cursor)) throw new Error("ORACLE_GOAL_BODY_CURSOR_REPEATED");
      cursors.add(cursor);
      recordRequest("GET", "/conversations/" + encodeURIComponent(conversationId) + "/messages", operation, conversationId);
      page = await requestClient.safeGet("/conversations/{conversation_id}/messages", {
        parameters: { path: { conversation_id: conversationId }, query: { before: cursor, include_has_versions: true, num_turns: 1 } },
        disableAutomaticRetry: true,
      });
    }
  }`;
