import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Runtime-local transport, never a public product tool. Native DynamicTool
// callbacks are serialized by Codex while they await a result. Keep only the
// start/read envelope inside that lock; the original operation runs outside it.
export const CODE_MODE_DISPATCH_NAME = "omnicodex_internal_dynamic_dispatch";
export const CODE_MODE_DISPATCH_SPEC = {
  type: "function",
  name: CODE_MODE_DISPATCH_NAME,
  description: "Transfer a pending native tool invocation within this execution runtime.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "read"] },
      group: { type: "string" },
      tool: { type: "string" },
      arguments: {},
      handle: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  deferLoading: false,
};

export interface DynamicDispatchResponse {
  readonly success: boolean;
  readonly contentItems: readonly {
    readonly type: string;
    readonly text?: string;
    readonly imageUrl?: string;
    readonly audioUrl?: string;
  }[];
}

type Outcome =
  | { state: "done"; response: DynamicDispatchResponse }
  | { state: "failed"; error: Record<string, unknown> };

interface Invocation {
  readonly startKey: string | undefined;
  readonly threadId: string;
  readonly turnId: string;
  readonly group: string;
  readonly controller: AbortController;
  readonly completion: Promise<Outcome>;
  outcome?: Outcome;
}

export class CodeModeParallelDispatch {
  readonly #invocations = new Map<string, Invocation>();
  readonly #starts = new Map<string, { handle: string; arguments: Record<string, unknown> }>();

  async call(
    params: Record<string, unknown>,
    allowedNames: readonly string[],
    invoke: (
      params: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<DynamicDispatchResponse>,
    signal?: AbortSignal,
  ): Promise<DynamicDispatchResponse> {
    const threadId = requiredString(params.threadId, "threadId");
    const turnId = requiredString(params.turnId, "turnId");
    const args = record(params.arguments);
    signal?.throwIfAborted();
    if (args.action === "start") {
      const tool = requiredString(args.tool, "tool");
      if (tool === CODE_MODE_DISPATCH_NAME || !allowedNames.includes(tool)) {
        throw new Error(`Unknown native dynamic tool: ${tool}`);
      }
      const group = requiredString(args.group, "group");
      // A retransmitted native callback is the same invocation, not a new
      // operation. Different call IDs remain independent even for equal input.
      const startKey =
        typeof params.callId === "string" && params.callId.length > 0
          ? JSON.stringify([threadId, turnId, params.callId])
          : undefined;
      const previous = startKey === undefined ? undefined : this.#starts.get(startKey);
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous.arguments, args)) {
          throw new Error("Native dispatch call ID was reused with different arguments");
        }
        return envelope({ state: "pending", handle: previous.handle });
      }
      const originalArguments = startKey === undefined ? undefined : structuredClone(args);
      const handle = randomUUID();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const completion = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return invoke({ ...params, tool, arguments: args.arguments }, controller.signal);
        })
        .then<Outcome, Outcome>(
          (response) => ({ state: "done", response }),
          (error: unknown) => ({ state: "failed", error: serializeError(error) }),
        )
        .finally(() => signal?.removeEventListener("abort", onAbort));
      const invocation: Invocation = { startKey, threadId, turnId, group, controller, completion };
      this.#invocations.set(handle, invocation);
      if (startKey !== undefined && originalArguments !== undefined) {
        this.#starts.set(startKey, { handle, arguments: originalArguments });
      }
      void completion.then((outcome) => {
        invocation.outcome = outcome;
      });
      return envelope({ state: "pending", handle });
    }
    if (args.action !== "read") throw new Error("Unknown native dispatch action");
    const handle = requiredString(args.handle, "handle");
    const invocation = this.#invocations.get(handle);
    if (invocation?.threadId !== threadId || invocation.turnId !== turnId) {
      throw new Error("Native dispatch handle is unavailable in this execution turn");
    }
    const onAbort = () => invocation.controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Observation quantum only: no operation timeout, result TTL, or retry of
    // the original invocation. Each pending read releases Codex's dynamic lock.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome =
        invocation.outcome ??
        (await Promise.race([
          invocation.completion,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 100);
          }),
        ]));
      signal?.throwIfAborted();
      return envelope(outcome ?? { state: "pending", handle });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  cancelGroup(group: string, reason: Error): void {
    for (const invocation of this.#invocations.values()) {
      if (invocation.group === group && invocation.outcome === undefined) {
        invocation.controller.abort(reason);
      }
    }
  }

  finishTurn(turnId: string, reason = new Error("Native execution turn ended")): void {
    for (const [handle, invocation] of this.#invocations) {
      if (invocation.turnId !== turnId) continue;
      if (invocation.outcome === undefined) invocation.controller.abort(reason);
      this.#invocations.delete(handle);
      if (invocation.startKey !== undefined) this.#starts.delete(invocation.startKey);
    }
  }

  close(reason: Error): void {
    for (const invocation of this.#invocations.values()) invocation.controller.abort(reason);
    this.#invocations.clear();
    this.#starts.clear();
  }
}

function envelope(value: unknown): DynamicDispatchResponse {
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Native dispatch requires ${field}`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native dispatch arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function serializeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return { ...value, name: value.name, message: value.message };
  }
  return { name: "Error", message: String(value) };
}

/** Preserve original callable names/catalog and the native dynamic JS result. */
export function withParallelDynamicTools(
  code: string,
  names: readonly string[],
  group: string,
  neverFullAccess = false,
): string {
  if (names.length === 0 && !neverFullAccess) return code;
  const pragma = code.match(/^([ \t]*\/\/ @exec:[^\r\n]*(?:\r?\n|$))/)?.[0] ?? "";
  const body = code.slice(pragma.length);
  return `${pragma}
await (async (__nativeTools, __nativeCatalog, __nativeGlobal) => {
  const __dispatch = __nativeTools[${JSON.stringify(CODE_MODE_DISPATCH_NAME)}];
  const __names = new Set(${JSON.stringify(names)});
  const __functions = new Map();
  const __tools = new Proxy(__nativeTools, {
    get(target, name) {
      // This wrapper is enabled only by the owned never/full-access runtime.
      // Escalation grants nothing there; execute once with its existing rights.
      if (${JSON.stringify(neverFullAccess)} && name === "exec_command" && typeof target[name] === "function") {
        if (!__functions.has(name)) __functions.set(name, (args) => {
          if (args !== null && typeof args === "object" && !Array.isArray(args) && args.sandbox_permissions === "require_escalated") {
            args = { ...args, sandbox_permissions: "use_default" };
            delete args.justification;
            delete args.prefix_rule;
          }
          return Reflect.apply(target[name], target, [args]);
        });
        return __functions.get(name);
      }
      if (!__names.has(name)) return Reflect.get(target, name);
      if (!__functions.has(name)) __functions.set(name, async (args) => {
        let outcome = JSON.parse(await __dispatch({action: "start", group: ${JSON.stringify(group)}, tool: name, arguments: args}));
        const handle = outcome.handle;
        while (outcome.state === "pending") outcome = JSON.parse(await __dispatch({action: "read", handle}));
        if (outcome.state === "failed") throw Object.assign(new Error(outcome.error.message), outcome.error);
        return outcome.response.contentItems.map(item => {
          if (item.type === "inputText") return item.text;
          if (item.type === "inputImage") return item.imageUrl;
          if (item.type === "inputAudio") return item.audioUrl;
          return "";
        }).filter(value => typeof value === "string" && value.trim().length > 0).join("\\n");
      });
      return __functions.get(name);
    }
  });
  const __catalog = __nativeCatalog.filter(tool => tool.name !== ${JSON.stringify(CODE_MODE_DISPATCH_NAME)});
  const __global = new Proxy(__nativeGlobal, {
    get(target, name) {
      if (name === "tools") return __tools;
      if (name === "ALL_TOOLS") return __catalog;
      if (name === "globalThis") return __global;
      return Reflect.get(target, name);
    }
  });
  await (async (tools, ALL_TOOLS, globalThis) => {
${body}
  })(__tools, __catalog, __global);
})(tools, ALL_TOOLS, globalThis);
`;
}
