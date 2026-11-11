const cdpEndpoint = new URL(process.env.OMNICODEX_ORACLE_CDP ?? "http://127.0.0.1:19222");
const conversationId = process.argv[2];
if (!conversationId) throw new Error("conversation id is required");

async function http(path, init) {
  const response = await fetch(new URL(path, cdpEndpoint), init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status}`);
  return response;
}

const created = await http(
  `/json/new?${encodeURIComponent(`https://chatgpt.com/c/${conversationId}`)}`,
  { method: "PUT" },
).then((response) => response.json());
const socket = new WebSocket(created.webSocketDebuggerUrl);
let commandId = 0;
const pending = new Map();
let captured;
let captureResolve;
const capturePromise = new Promise((resolve) => {
  captureResolve = resolve;
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id != null) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method !== "Fetch.requestPaused") return;
  const request = message.params?.request;
  const requestId = message.params?.requestId;
  if (
    requestId &&
    request?.method === "POST" &&
    new URL(request.url).pathname.endsWith("/f/conversation")
  ) {
    captured = JSON.parse(request.postData ?? "null");
    void send("Fetch.failRequest", {
      requestId,
      errorReason: "Aborted",
    }).finally(() => captureResolve());
    return;
  }
  if (requestId) void send("Fetch.continueRequest", { requestId });
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

try {
  await send("Runtime.enable");
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*f/conversation*", requestStage: "Request" }],
  });
  let clicked = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await send("Runtime.evaluate", {
      expression: `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
        };
        const buttons = [...document.querySelectorAll("button")].filter(visible);
        const button = buttons.find((candidate) => {
          const label = [candidate.innerText, candidate.textContent, candidate.getAttribute("aria-label")]
            .filter(Boolean)
            .join(" ")
            .trim();
          if (!/(allow|허용)/i.test(label) || /(deny|거절)/i.test(label)) return false;
          let node = candidate;
          for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
            const text = node.innerText ?? node.textContent ?? "";
            if (/OmniCodex/i.test(text) && /(materializ|파일)/i.test(text)) return true;
          }
          return false;
        });
        if (!button) return { clicked: false, title: document.title, buttonCount: buttons.length };
        button.click();
        return { clicked: true, title: document.title, label: button.innerText ?? button.textContent };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.value?.clicked === true) {
      clicked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!clicked) throw new Error("approval button did not become available");
  await Promise.race([
    capturePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("approval request was not captured")), 30_000),
    ),
  ]);
  const safe = {
    action: captured?.action,
    conversation_id: captured?.conversation_id,
    parent_message_id: captured?.parent_message_id,
    model: captured?.model,
    client_prepare_state: captured?.client_prepare_state,
    timezone_offset_min: captured?.timezone_offset_min,
    timezone: captured?.timezone,
    conversation_mode: captured?.conversation_mode,
    history_and_training_disabled: captured?.history_and_training_disabled,
    is_do_not_remember: captured?.is_do_not_remember,
    conversation_origin: captured?.conversation_origin,
    one_off_model_override: captured?.one_off_model_override,
    thinking_effort: captured?.thinking_effort,
    supports_buffering: captured?.supports_buffering,
    supported_encodings: captured?.supported_encodings,
    messages: captured?.messages,
    topLevelKeys: Object.keys(captured ?? {}),
  };
  console.log(JSON.stringify(safe, null, 2));
} finally {
  try {
    await send("Fetch.disable");
  } catch {}
  socket.close();
  await http(`/json/close/${encodeURIComponent(created.id)}`, { method: "PUT" }).catch(
    () => undefined,
  );
}
