const cdpEndpoint = new URL(process.env.OMNICODEX_ORACLE_CDP ?? "http://127.0.0.1:19222");
const assetPath = process.argv[2];
const action = process.argv[3];
const conversationId = process.argv[4];
const targetUrl = process.env.OMNICODEX_ORACLE_TARGET_URL ?? "https://chatgpt.com/api/auth/session";
const navigateAfterCreate = process.env.OMNICODEX_ORACLE_NAVIGATE_AFTER_CREATE === "1";
const enableRuntime = process.env.OMNICODEX_ORACLE_SKIP_RUNTIME_ENABLE !== "1";

async function request(path, init) {
  const response = await fetch(new URL(path, cdpEndpoint), init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status}`);
  return response;
}

const created = await request(
  `/json/new?${encodeURIComponent(
    navigateAfterCreate
      ? "about:blank?omnicodex_target=00000000-0000-4000-8000-000000000001"
      : targetUrl,
  )}`,
  { method: "PUT" },
).then((response) => response.json());
const socket = new WebSocket(created.webSocketDebuggerUrl);
let commandId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
try {
  if (enableRuntime) await send("Runtime.enable");
  if (navigateAfterCreate) await send("Page.navigate", { url: targetUrl });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await send("Runtime.evaluate", {
      expression:
        "document.readyState === 'complete' && document.body?.innerText?.includes('accessToken')",
      returnByValue: true,
    });
    if (ready.result?.value === true) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const expression = `(${async function inspect(
    requestedAssetPath,
    requestedAction,
    requestedConversationId,
  ) {
    let path = requestedAssetPath;
    if (!path) {
      const html = await fetch("/").then((response) => response.text());
      const matches = [...html.matchAll(/\/cdn\/assets\/[A-Za-z0-9_-]+\.js/g)].map(
        (match) => match[0],
      );
      for (const candidate of [...new Set(matches)]) {
        const text = await fetch(candidate).then((response) => response.text());
        if (text.includes("sentinel/chat-requirements/prepare")) {
          path = candidate;
          break;
        }
      }
    }
    if (!path) return { error: "asset_not_found" };
    if (
      ["finalize", "conversation", "pending", "models", "recent", "approve"].includes(
        requestedAction,
      ) &&
      !document.getElementById("client-bootstrap")
    ) {
      const html = await fetch("/").then((response) => response.text());
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const bootstrap = parsed.getElementById("client-bootstrap")?.textContent;
      if (!bootstrap) return { error: "client_bootstrap_not_found" };
      const script = document.createElement("script");
      script.id = "client-bootstrap";
      script.type = "application/json";
      script.textContent = bootstrap;
      document.head.appendChild(script);
    }
    const module = await import(path);
    if (requestedAction === "source") {
      const source = await fetch(path).then((response) => response.text());
      const patterns = [" as z$", "Ud as ", "z$=", "z$: ", "z$:", "safeGet", "safePost"];
      const safeGetIndex = source.indexOf("safeGet");
      const initializerIndex = source.lastIndexOf("=e((()=>{", safeGetIndex);
      const exportTail = source.slice(Math.max(0, source.length - 250_000));
      return {
        path,
        initializerSnippet:
          initializerIndex < 0
            ? ""
            : source.slice(Math.max(0, initializerIndex - 200), initializerIndex + 1_000),
        wExports: [...exportTail.matchAll(/(?:^|,)W as ([A-Za-z0-9$_]+)/g)].map(
          (match) => match[1],
        ),
        matches: patterns.map((pattern) => {
          const index = source.indexOf(pattern);
          return {
            pattern,
            index,
            snippet: index < 0 ? "" : source.slice(Math.max(0, index - 800), index + 1_200),
          };
        }),
      };
    }
    if (requestedAction === "approve") {
      module.No();
      const readConversation = () =>
        module.z$.safeGet(`/conversations/${encodeURIComponent(requestedConversationId)}`, {
          parameters: { query: { include_has_versions: true, num_turns: 1 } },
        });
      const conversation = await readConversation();
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const pending = messages.find(
        (message) =>
          message?.id === conversation.current_node &&
          message?.metadata?.jit_plugin_data?.from_server?.type === "confirm_action",
      );
      if (!pending) return { outcome: "no_pending_confirm_action" };
      const actions = pending.metadata.jit_plugin_data.from_server.body?.actions ?? [];
      const splitActions = actions.flatMap((candidate) =>
        Array.isArray(candidate?.split_action_options)
          ? candidate.split_action_options.map((option) => option?.action).filter(Boolean)
          : [],
      );
      const selected =
        splitActions.find(
          (candidate) => candidate?.type === "allow" && candidate?.remember_answer === true,
        ) ??
        actions.find((candidate) => candidate?.type === "always_allow")?.always_allow ??
        actions.find((candidate) => candidate?.type === "allow")?.allow;
      const targetMessageId = selected?.target_message_id;
      if (typeof targetMessageId !== "string" || targetMessageId.length === 0) {
        return { outcome: "pending_action_has_no_target" };
      }
      const alreadyPersisted = messages.some((message) => {
        const fromClient = message?.metadata?.jit_plugin_data?.from_client;
        return (
          (fromClient?.type === "allow" || fromClient?.type === "always_allow") &&
          fromClient?.target_message_id === targetMessageId
        );
      });
      if (alreadyPersisted) return { outcome: "already_persisted", targetMessageId };
      const target = messages.find((message) => message?.id === targetMessageId);
      if (!target) return { outcome: "target_message_missing", targetMessageId };

      const action = selected?.type === "always_allow" ? "always_allow" : "allow";
      const actionData = {
        ...(action === "allow" ? { remember_answer: false } : {}),
        ...selected,
        target_message_id: targetMessageId,
        type: action,
      };
      const clientMessageId = crypto.randomUUID();
      const clientMessage = {
        author: {
          metadata: {},
          name: pending.author?.name ?? "api_tool.call_tool",
          role: "tool",
        },
        channel: null,
        content: { content_type: "text", parts: [""] },
        create_time: Date.now() / 1_000,
        end_turn: null,
        id: clientMessageId,
        metadata: { jit_plugin_data: { from_client: actionData } },
        recipient: "all",
        status: "finished_successfully",
        update_time: null,
        weight: 1,
      };
      const body = {
        action: "next",
        messages: [clientMessage],
        conversation_id: requestedConversationId,
        ...(conversation.conversation_origin == null
          ? {}
          : { conversation_origin: conversation.conversation_origin }),
        ...(conversation.is_do_not_remember == null
          ? {}
          : { is_do_not_remember: conversation.is_do_not_remember }),
        // The first-party responder appends the client approval as a child of
        // the pending server confirm_action message. The target message id is
        // carried inside jit_plugin_data.from_client, not used as the branch
        // parent for ordinary JIT approvals.
        parent_message_id: pending.id,
        model: conversation.default_model_slug,
        client_prepare_state: "N/A",
        timezone_offset_min: -540,
        timezone: "Asia/Seoul",
        ...(conversation.gizmo_id == null
          ? {}
          : {
              conversation_mode: {
                kind: "gizmo_interaction",
                gizmo_id: conversation.gizmo_id,
              },
              gizmo_id: conversation.gizmo_id,
            }),
        thinking_effort: pending.metadata?.thinking_effort ?? "standard",
        supports_buffering: true,
        supported_encodings: ["v1"],
      };

      const requirements = await module.Eo(false, "none", 1);
      const [proofToken, turnstileToken] = await Promise.all([
        module.Uo.getEnforcementToken(requirements, { forceSync: true }),
        module.zo.getEnforcementToken(requirements),
      ]);
      await module.Fo("conversation");
      const timing = window.SentinelSDK?.timing?.() ?? "[1,null]";
      let response;
      try {
        response = await module.z$.request("post", "/f/conversation", {
          requestBody: body,
          additionalHeaders: {
            ...module.Ao(requirements, turnstileToken, proofToken, null, null, timing),
          },
          authOption: 1,
          disableAutomaticRetry: true,
        });
      } catch (error) {
        return {
          outcome: "request_rejected",
          name: error?.name,
          message: error?.message,
          status: error?.status,
          code: error?.code,
          detail: error?.detail,
          json: error?.json,
        };
      }
      const responseText = await response.text();
      let readback;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        readback = await readConversation();
        const currentMessages = Array.isArray(readback.messages) ? readback.messages : [];
        const persisted = currentMessages.some((message) => {
          const fromClient = message?.metadata?.jit_plugin_data?.from_client;
          return (
            message?.id === clientMessageId &&
            (fromClient?.type === "allow" || fromClient?.type === "always_allow") &&
            fromClient?.target_message_id === targetMessageId
          );
        });
        const finalMarker = currentMessages.some(
          (message) =>
            message?.author?.role === "assistant" &&
            JSON.stringify(message?.content ?? {}).includes("OMNICODEX_ORACLE_PRESUBSCRIBE_OK"),
        );
        if (persisted && finalMarker) {
          return {
            outcome: "completed",
            responseStatus: response.status,
            clientMessageId,
            targetMessageId,
            currentNode: readback.current_node,
            persisted,
            finalMarker,
            streamDone: responseText.includes('"type":"done"') || responseText.includes("[DONE]"),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const currentMessages = Array.isArray(readback?.messages) ? readback.messages : [];
      return {
        outcome: "readback_incomplete",
        responseStatus: response.status,
        clientMessageId,
        targetMessageId,
        currentNode: readback?.current_node,
        persisted: currentMessages.some((message) => message?.id === clientMessageId),
        finalMarker: currentMessages.some(
          (message) =>
            message?.author?.role === "assistant" &&
            JSON.stringify(message?.content ?? {}).includes("OMNICODEX_ORACLE_PRESUBSCRIBE_OK"),
        ),
        streamDone: responseText.includes('"type":"done"') || responseText.includes("[DONE]"),
      };
    }
    if (requestedAction === "conversation") {
      module.No();
      const conversation = await module.z$.safeGet(
        `/conversations/${encodeURIComponent(requestedConversationId)}`,
        { parameters: { query: { include_has_versions: true, num_turns: 1 } } },
      );
      return {
        conversationKeys: Object.keys(conversation),
        mappingType: conversation.mapping?.constructor?.name,
        mappingSize: conversation.mapping?.size,
        currentNode: conversation.current_node,
        model: conversation.default_model_slug,
        messages: (Array.isArray(conversation.messages)
          ? conversation.messages.map((node) => [node?.id, node])
          : Object.entries(conversation.mapping ?? conversation.mapping$?.() ?? {})
        ).map(([nodeId, node]) => ({
          nodeId,
          parent: node?.parent,
          children: node?.children,
          messageId: (node?.message ?? node)?.id,
          role: (node?.message ?? node)?.author?.role,
          name: (node?.message ?? node)?.author?.name,
          status: (node?.message ?? node)?.status,
          recipient: (node?.message ?? node)?.recipient,
          jitServerType: (node?.message ?? node)?.metadata?.jit_plugin_data?.from_server?.type,
          jitServerActions: (
            node?.message ?? node
          )?.metadata?.jit_plugin_data?.from_server?.body?.actions?.map((action) => ({
            type: action?.type,
            keys: Object.keys(action ?? {}),
            payload: action?.allow ?? action?.always_allow ?? action?.deny ?? action?.approve,
            targetMessageId:
              action?.allow?.target_message_id ??
              action?.always_allow?.target_message_id ??
              action?.deny?.target_message_id,
          })),
          jitClientType: (node?.message ?? node)?.metadata?.jit_plugin_data?.from_client?.type,
          targetMessageId: (node?.message ?? node)?.metadata?.jit_plugin_data?.from_client
            ?.target_message_id,
          workingTurnId: (node?.message ?? node)?.metadata?.working_turn_id,
          turnExchangeId: (node?.message ?? node)?.metadata?.turn_exchange_id,
          messageKeys: Object.keys(node?.message ?? node ?? {}),
          authorKeys: Object.keys((node?.message ?? node)?.author ?? {}),
          contentType: (node?.message ?? node)?.content?.content_type,
          metadataKeys: Object.keys((node?.message ?? node)?.metadata ?? {}),
          metadataParentId: (node?.message ?? node)?.metadata?.parent_id,
          resolvedModel: (node?.message ?? node)?.metadata?.resolved_model_slug,
        })),
      };
    }
    if (requestedAction === "pending") {
      module.No();
      const conversation = await module.z$.safeGet(
        `/conversations/${encodeURIComponent(requestedConversationId)}`,
        { parameters: { query: { include_has_versions: true, num_turns: 1 } } },
      );
      const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const message = messages.find((candidate) => candidate?.id === conversation.current_node);
      const fromServer = message?.metadata?.jit_plugin_data?.from_server;
      return {
        currentNode: conversation.current_node,
        asyncStatus: conversation.async_status,
        defaultModelSlug: conversation.default_model_slug,
        conversationOrigin: conversation.conversation_origin,
        isTemporaryChat: conversation.is_temporary_chat,
        isDoNotRemember: conversation.is_do_not_remember,
        messageKeys: Object.keys(message ?? {}),
        author: message?.author,
        contentType: message?.content?.content_type,
        contentPreview:
          typeof message?.content?.text === "string"
            ? message.content.text.slice(0, 1_000)
            : Array.isArray(message?.content?.parts)
              ? message.content.parts
                  .filter((part) => typeof part === "string")
                  .join("\n")
                  .slice(0, 1_000)
              : undefined,
        status: message?.status,
        recipient: message?.recipient,
        metadataKeys: Object.keys(message?.metadata ?? {}),
        metadataParentId: message?.metadata?.parent_id,
        workingTurnId: message?.metadata?.working_turn_id,
        turnExchangeId: message?.metadata?.turn_exchange_id,
        messageModelSlug: message?.metadata?.model_slug,
        messageDefaultModelSlug: message?.metadata?.default_model_slug,
        thinkingEffort: message?.metadata?.thinking_effort,
        initialText: message?.metadata?.initial_text,
        finishedText: message?.metadata?.finished_text,
        summarizationHeadline: message?.metadata?.summarization_headline,
        permissions: message?.metadata?.permissions,
        fromServerKeys: Object.keys(fromServer ?? {}),
        fromServerType: fromServer?.type,
        bodyKeys: Object.keys(fromServer?.body ?? {}),
        codexMcpElicitation: fromServer?.body?.codex_mcp_elicitation,
        actions: fromServer?.body?.actions,
        clientResponses: messages
          .map((candidate) => candidate?.metadata?.jit_plugin_data?.from_client)
          .filter(Boolean),
      };
    }
    if (requestedAction === "models") {
      module.No();
      const result = await module.z$.safeGet("/models", {});
      const models = Array.isArray(result?.models) ? result.models : [];
      return {
        keys: Object.keys(result ?? {}),
        requestSource: Function.prototype.toString.call(module.z$.request).slice(0, 2_000),
        safePostSource: Function.prototype.toString.call(module.z$.safePost).slice(0, 2_000),
        models: models
          .filter((candidate) =>
            [candidate?.slug, candidate?.model_slug, candidate?.request_model_slug].some(
              (value) => typeof value === "string" && value.includes("5-6"),
            ),
          )
          .map((candidate) => ({
            slug: candidate?.slug,
            modelSlug: candidate?.model_slug,
            requestModelSlug: candidate?.request_model_slug,
            title: candidate?.title,
            defaultThinkingEffort: candidate?.default_thinking_effort,
            thinkingEfforts: candidate?.thinking_efforts,
          })),
      };
    }
    if (requestedAction === "recent") {
      module.No();
      module.go?.();
      const result = await module.z$.safeGet("/conversations", {
        parameters: { query: { offset: 0, limit: 50, order: "updated" } },
      });
      return {
        keys: Object.keys(result ?? {}),
        items: (Array.isArray(result?.items) ? result.items : []).map((candidate) => ({
          id: candidate?.id,
          title: candidate?.title,
          updateTime: candidate?.update_time,
          currentNode: candidate?.current_node,
          model: candidate?.default_model_slug,
        })),
      };
    }
    if (requestedAction === "finalize") {
      module.No();
      const requirements = await module.Eo(false, "none", 1);
      return {
        path,
        proofSolverReady: typeof module.Uo?.getEnforcementToken === "function",
        turnstileSolverReady: typeof module.zo?.getEnforcementToken === "function",
        requirements: {
          persona: requirements?.persona,
          tokenLength: requirements?.token?.length ?? 0,
          prepareTokenLength: requirements?.prepare_token?.length ?? 0,
          turnstileRequired: requirements?.turnstile?.required === true,
          proofRequired: requirements?.proofofwork?.required === true,
          soRequired: requirements?.so?.required === true,
        },
      };
    }
    const interesting = [];
    for (const [key, value] of Object.entries(module)) {
      let source = "";
      try {
        source = typeof value === "function" ? Function.prototype.toString.call(value) : "";
      } catch {}
      const prototypeNames =
        typeof value === "function" && value.prototype
          ? Object.getOwnPropertyNames(value.prototype)
          : [];
      const objectConstructorPrototypeNames =
        value && typeof value === "object" && value.constructor?.prototype
          ? Object.getOwnPropertyNames(value.constructor.prototype)
          : [];
      const valueName = typeof value === "function" ? value.name : value?.constructor?.name;
      if (
        /^(qMt|iMt|dMt|uMt|eMt|ONt|ANt|XNt|tMt|kNt|WMt|wNt|sPt|n1|G\$|RNt|LNt|UNt)$/u.test(
          valueName ?? "",
        ) ||
        source.includes("getEnforcementToken") ||
        source.includes("chat-requirements") ||
        prototypeNames.includes("getEnforcementToken") ||
        objectConstructorPrototypeNames.includes("getEnforcementToken") ||
        ["Ao", "Ap", "Do", "Eo", "Fo", "Mo", "jo", "No", "go", "ho", "Uo", "z$", "zo"].includes(key)
      ) {
        interesting.push({
          key,
          valueName,
          source: source.slice(0, 400),
          prototypeNames,
          objectConstructorPrototypeNames,
          objectKeys:
            value && typeof value === "object" ? Object.keys(value).slice(0, 30) : undefined,
          objectMethods:
            value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .filter(([, member]) => typeof member === "function")
                    .slice(0, 10)
                    .map(([name, member]) => [
                      name,
                      Function.prototype.toString.call(member).slice(0, 1200),
                    ]),
                )
              : undefined,
        });
      }
    }
    return { path, exportCount: Object.keys(module).length, interesting };
  }})(${JSON.stringify(assetPath ?? "")}, ${JSON.stringify(action ?? "")}, ${JSON.stringify(conversationId ?? "")})`;
  const evaluated = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  process.stdout.write(`${JSON.stringify(evaluated.result?.value, null, 2)}\n`);
} finally {
  socket.close();
  await request(`/json/close/${created.id}`, { method: "PUT" }).catch(() => undefined);
}
