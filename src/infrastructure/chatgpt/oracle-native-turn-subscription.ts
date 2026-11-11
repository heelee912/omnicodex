const TURN_TOPIC = /^(?:conversation-turn-|conv-turn-low-ttl-)[A-Za-z0-9-]+$/u;

// Recover a known interrupted turn through the native subscribe protocol.
// The existing event source consumes the reply's catchups; this operation
// never reads a conversation or approves an action itself.
const RECOVER = String.raw`async function oracleRecoverNativeTurn(topicId) {
  const client = globalThis.__omnicodexNativeTurnSubscriptions?.client;
  if (!client?.isTransportOpen) throw new Error("ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN");
  const reply = await client.sendCommand({ type: "subscribe", topic_id: topicId, offset: "0" });
  if (reply.type !== "subscribe" || reply.topic_id !== topicId)
    throw new Error("ORACLE_NATIVE_TURN_RECOVERY_REPLY_INVALID");
  return { topicId, state: reply.recovered === true ? "recovered" : "history_unavailable",
    recovered: reply.recovered === true, catchupCount: reply.catchups?.length ?? 0 };
}`;

export function oracleNativeTurnRecoveryExpression(topicId: string): string {
  if (!TURN_TOPIC.test(topicId)) throw new Error("ORACLE_NATIVE_TURN_TOPIC_INVALID");
  return `(${RECOVER})(${JSON.stringify(topicId)})`;
}

// Uses the renderer's existing PubSub client and WebSocket. This operation
// neither fetches conversations nor submits approvals or model turns.
const SUBSCRIBE = String.raw`async function oracleSubscribeNativeTurn(topicId) {
  const subscriptionStartedAtUnixMs = Date.now();
  const key = "__omnicodexNativeTurnSubscriptions";
  const state = globalThis[key] ??= { client: null, loading: null, topics: new Map() };
  const releaseListeners = () => {
    state.releaseHandoff?.();
    state.releaseHandoff = null;
    state.releaseControl?.();
    state.releaseControl = null;
    state.controlSocket = null;
    for (const release of state.topics.values()) release();
    state.topics.clear();
  };
  if (topicId === null) {
    releaseListeners();
    return { state: "stopped" };
  }
  // The renderer can replace its native client after a disconnect. Reacquire
  // it through the cached export without repeatedly fetching immutable assets.
  if (state.client?.isTransportOpen === false) {
    releaseListeners();
    state.client = null;
  }
  if (state.topics.has(topicId)) return { topicId, state: "subscribed", offset: state.client.getTopic(topicId).offset };
  if (!state.client) {
    // Asset URLs are content-addressed. Retrying a subscription must not
    // download and scan the same immutable modules again. Keep only the
    // discovered export name (or absence), not copies of asset bodies.
    const assetExports = state.assetExports ??= new Map();
    // Renderer state already belongs to the signed-in account. Keep failed
    // asset attempts here too so socket reconnects respect the same deadline.
    const assetFailures = state.assetFailures ??= new Map();
    state.loading ??= (async () => {
      // A client-side navigation can remove the initial preload links while
      // the entry modules remain loaded. The renderer's entry manifest keeps
      // their current build URLs; do not depend on transient DOM links alone.
      const entry = globalThis.__reactRouterManifest?.entry;
      const candidates = [entry?.module, ...(Array.isArray(entry?.imports) ? entry.imports : []),
        ...Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map(node => node.href)];
      const paths = [...new Set(candidates.filter(path => typeof path === "string")
        .map(path => path.startsWith("/cdn/assets/") ? "https://chatgpt.com" + path : path)
        .filter(path => /^https:\/\/chatgpt\.com\/cdn\/assets\/[A-Za-z0-9_-]+\.js$/.test(path)))];
      for (const path of paths) {
        if (!assetExports.has(path)) {
          const previousFailure = assetFailures.get(path);
          if (previousFailure && Date.now() < previousFailure.retryAtUnixMs)
            throw previousFailure;
          const response = await fetch(path);
          if (!response.ok) {
            const error = new Error("ORACLE_PUBSUB_ASSET_HTTP_" + response.status);
            error.status = response.status;
            error.assetUrl = path;
            if (response.status === 429) {
              const now = Date.now();
              const retryAfter = response.headers?.get("retry-after") ?? null;
              const value = retryAfter?.trim();
              const seconds = value && /^\d+$/.test(value) ? Number(value) : NaN;
              const deadline = Number.isFinite(seconds) ? now + seconds * 1000
                : value ? Date.parse(value) : NaN;
              error.retryAfter = retryAfter;
              error.retryAtUnixMs = Number.isFinite(deadline) ? Math.max(now, deadline) : now + 30_000;
              error.backoffSource = Number.isFinite(deadline) ? "retry_after" : "local_backoff";
              assetFailures.set(path, error);
            }
            throw error;
          }
          assetFailures.delete(path);
          const source = await response.text();
          const symbol = source.match(/pubsub-client\x60\),([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(e=>new /)?.[1];
          if (!symbol) { assetExports.set(path, null); continue; }
          const exports = source.slice(source.lastIndexOf("export{"));
          const alias = exports.match(new RegExp("(?:[,\\{])" + symbol + " as ([A-Za-z_$][\\w$]*)[,}]"))?.[1];
          if (!alias) throw new Error("ORACLE_NATIVE_PUBSUB_EXPORT_MISSING");
          assetExports.set(path, alias);
        }
        const alias = assetExports.get(path);
        if (alias === null) continue;
        const module = await import(path);
        const client = module[alias]();
        state.recoveryClient = client;
        if (!client.isTransportOpen) throw new Error("ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN");
        state.client = client;
        return;
      }
      throw new Error("ORACLE_NATIVE_PUBSUB_CLIENT_MISSING");
    })().finally(() => { state.loading = null; });
    await state.loading;
  }
  if (topicId === undefined) {
    // Native early handoff controls are unbatched socket events, not messages
    // on the conversations topic. Observe the existing transport as well.
    if (state.releaseControl && state.controlSocket !== state.client.ws) {
      state.releaseControl();
      state.releaseControl = null;
    }
    if (!state.releaseControl) {
      const receive = ({ data }) => {
        let event;
        try { event = JSON.parse(data); } catch { return; }
        if (event?.type !== "conversation-turn-handoff-control") return;
        const payload = event.payload;
        if (typeof payload?.conversation_id !== "string" ||
            typeof payload?.turn_exchange_id !== "string" ||
            payload.topic_id !== "conversation-turn-" + payload.turn_exchange_id ||
            !/^[A-Za-z0-9-]+$/.test(payload.turn_exchange_id)) return;
        void oracleSubscribeNativeTurn(payload.topic_id).catch(error => {
          console.error("ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED", String(error));
        });
      };
      const socket = state.client.ws;
      const disconnected = () => console.error("ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED",
        "ORACLE_NATIVE_PUBSUB_TRANSPORT_NOT_OPEN");
      socket.addEventListener("message", receive);
      socket.addEventListener("close", disconnected);
      state.controlSocket = socket;
      state.releaseControl = () => {
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", disconnected);
      };
    }
    const conversations = state.client.getTopic("conversations");
    state.releaseHandoff ??= conversations.onMessage(event => {
      if (event?.type !== "conversation-update" || event.payload?.update_type !== "stream-handoff") return;
      const options = event.payload?.update_content?.options;
      if (!Array.isArray(options)) return;
      for (const option of options) {
        if (option?.type !== "subscribe_ws_topic" || typeof option.topic_id !== "string" ||
            !/^(?:conversation-turn-|conv-turn-low-ttl-)[A-Za-z0-9-]+$/.test(option.topic_id)) continue;
        void oracleSubscribeNativeTurn(option.topic_id).catch(error => {
          console.error("ORACLE_NATIVE_TURN_SUBSCRIPTION_FAILED", String(error));
        });
      }
    });
    // onMessage only installs a listener. Native subscribe is idempotent for
    // a topic already owned by the UI; never unsubscribe that shared topic.
    await conversations.subscribe();
    if (!state.client.isTransportOpen || conversations.state !== 0)
      throw new Error("ORACLE_NATIVE_CONVERSATIONS_SUBSCRIPTION_NOT_READY");
    return { state: "listening", transportOpen: state.client.isTransportOpen,
      conversationsTopicState: conversations.state, subscriptionStartedAtUnixMs };
  }
  const topic = state.client.getTopic(topicId);
  let subscription;
  const releaseSubscription = topic.onSubscribe(value => { subscription = value; });
  const owned = topic.state !== 0;
  let release = () => {};
  const finish = () => {
    state.topics.delete(topicId);
    release();
    if (owned) topic.unsubscribe();
  };
  release = topic.onMessage(event => {
    if (event?.type === "conversation-turn-stream" && event.payload?.type === "done") finish();
  });
  state.topics.set(topicId, finish);
  try {
    await topic.subscribe({ includeAllHistory: true });
    return { topicId, state: "subscribed", offset: topic.offset, subscription };
  } catch (error) {
    state.topics.delete(topicId);
    release();
    throw error;
  } finally {
    releaseSubscription();
  }
}`;

export function oracleNativeTurnSubscriptionExpression(topicId?: string | null): string {
  if (topicId != null && !TURN_TOPIC.test(topicId))
    throw new Error("ORACLE_NATIVE_TURN_TOPIC_INVALID");
  return `(${SUBSCRIBE})(${topicId === undefined ? "" : JSON.stringify(topicId)})`;
}

// A native client that exhausts its retry limit can retain its connect lock.
// Reinitializing it adds another first-party presence listener. Reload only an
// existing, hidden, empty home page instead, after the host admits the account.
const RECOVER_HOME = `async function oracleRecoverNativeHome(reload) {
  if (location.origin !== "https://chatgpt.com" || location.pathname !== "/" ||
      document.visibilityState !== "hidden") return { state: "ineligible" };
  const composer = document.querySelector('#prompt-textarea');
  if ((composer?.value ?? composer?.textContent ?? "").trim() ||
      document.querySelector('[data-testid="stop-button"]')) return { state: "ineligible" };
  const state = globalThis.__omnicodexNativeTurnSubscriptions;
  const client = state?.recoveryClient ?? state?.client;
  const socket = client?.ws;
  const maximum = socket?._options?.maxRetries;
  if (client?.isTransportOpen !== false || socket?.readyState !== 3 ||
      !Number.isFinite(maximum) || maximum < 1 || socket.retryCount < maximum ||
      socket._connectLock !== true) return { state: "ineligible" };
  if (!reload) return { state: "eligible" };
  location.reload();
  return { state: "reloading" };
}`;

// Keep the existing guard and reload expression intact. Only its fixed,
// non-reloading diagnostic adds primitive observations of the same conditions.
const DIAGNOSE_HOME = `async function oracleDiagnoseNativeHome() {
  const eligibility = (${RECOVER_HOME})(false);
  let diagnostics = { observed: false };
  try {
    const state = globalThis.__omnicodexNativeTurnSubscriptions;
    const client = state?.recoveryClient ?? state?.client;
    const socket = client?.ws;
    const transportOpen = client?.isTransportOpen;
    const readyState = socket?.readyState;
    const maximum = socket?._options?.maxRetries;
    const retries = socket?.retryCount;
    diagnostics = {
      observed: true,
      hidden: document.visibilityState === "hidden",
      clientPresent: client !== undefined && client !== null,
      transportOpenKnown: typeof transportOpen === "boolean",
      transportOpen: transportOpen === true,
      socketPresent: socket !== undefined && socket !== null,
      socketReadyStateKnown: Number.isFinite(readyState),
      socketReadyState: Number.isFinite(readyState) ? readyState : 0,
      maxRetriesKnown: Number.isFinite(maximum),
      maxRetries: Number.isFinite(maximum) ? maximum : 0,
      retryCountKnown: Number.isFinite(retries),
      retryCount: Number.isFinite(retries) ? retries : 0,
      connectLocked: socket?._connectLock === true,
    };
  } catch {
    // Observation failure must not change the original eligibility result.
  }
  return { ...await eligibility, diagnostics };
}`;

export function oracleNativeHomeRecoveryExpression(reload: boolean): string {
  return reload === false ? `(${DIAGNOSE_HOME})()` : `(${RECOVER_HOME})(${reload})`;
}

export function isOracleNativeTurnSubscriptionExpression(value: unknown): boolean {
  if (
    value === oracleNativeHomeRecoveryExpression(false) ||
    value === oracleNativeHomeRecoveryExpression(true)
  )
    return true;
  if (typeof value === "string" && value.startsWith(`(${RECOVER})(`) && value.endsWith(")")) {
    try {
      const topic: unknown = JSON.parse(value.slice(RECOVER.length + 3, -1));
      return typeof topic === "string" && value === oracleNativeTurnRecoveryExpression(topic);
    } catch {
      return false;
    }
  }
  if (typeof value !== "string" || !value.startsWith(`(${SUBSCRIBE})(`) || !value.endsWith(")"))
    return false;
  try {
    const argument = value.slice(SUBSCRIBE.length + 3, -1);
    const topic: unknown = argument === "" ? undefined : JSON.parse(argument);
    return (
      (topic == null || typeof topic === "string") &&
      value === oracleNativeTurnSubscriptionExpression(topic)
    );
  } catch {
    return false;
  }
}
