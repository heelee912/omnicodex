import type { RuntimeCandidate } from "../domain/runtime.js";
import { CodexAppServerProcess } from "../infrastructure/runtime/codex-app-server-process.js";
import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";
import {
  ResponsesLoopbackDriver,
  type ResponsesNestedToolMetadata,
  type ResponsesSelectedToolCall,
  type ResponsesToolExecutionResult,
} from "../infrastructure/runtime/responses-loopback-driver.js";
import { answerAppServerApprovalRequest } from "./app-server-request-handler.js";

export interface ResponsesRuntimeExecutorOptions {
  readonly cwd?: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly turnTimeoutMs?: number;
  readonly onDiagnostic?: (message: JsonObject) => void;
}

interface TurnWaiter {
  readonly timer: NodeJS.Timeout;
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

/**
 * Owns a separate App Server child whose provider is a loopback Responses
 * driver. `turn/start` is used only as the native tool execution protocol;
 * the provider never calls or emulates a model.
 */
export class ResponsesRuntimeExecutor {
  readonly #candidate: RuntimeCandidate;
  readonly #options: Required<
    Pick<ResponsesRuntimeExecutorOptions, "model" | "providerId" | "turnTimeoutMs">
  > &
    ResponsesRuntimeExecutorOptions;
  readonly #driver = new ResponsesLoopbackDriver();
  readonly #turnWaiters = new Map<string, TurnWaiter>();
  readonly #completedTurns = new Map<string, JsonObject>();
  #nestedTools: readonly ResponsesNestedToolMetadata[] = [];
  #nestedMcpToolNames = new Set<string>();
  #executionThreadId: string | undefined;
  #process: CodexAppServerProcess | undefined;
  #serialTail: Promise<void> = Promise.resolve();

  constructor(candidate: RuntimeCandidate, options: ResponsesRuntimeExecutorOptions = {}) {
    this.#candidate = candidate;
    this.#options = {
      ...options,
      model: options.model ?? "gpt-5.6-sol",
      providerId: options.providerId ?? "omnicodex_loopback",
      turnTimeoutMs: options.turnTimeoutMs ?? 120_000,
    };
  }

  get snapshot() {
    return {
      ...this.#driver.snapshot,
      nestedTools: this.#nestedTools.map((tool) => ({ ...tool })),
    };
  }

  get running(): boolean {
    return this.#process !== undefined;
  }

  async start(): Promise<void> {
    if (this.#process !== undefined) {
      return;
    }
    await this.#driver.start();
    const providerId = this.#options.providerId;
    const process = new CodexAppServerProcess(this.#candidate, {
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      env: { OMNICODEX_LOOPBACK_API_KEY: this.#driver.apiKey },
      configOverrides: [
        // The desktop app starts its App Server with this process-local feature.
        // It activates the installed code-mode host without changing config.toml.
        "features.code_mode_host=true",
        `model_provider=${tomlString(providerId)}`,
        `model_providers.${providerId}.name=${tomlString("OmniCodex Loopback")}`,
        `model_providers.${providerId}.base_url=${tomlString(this.#driver.baseUrl)}`,
        `model_providers.${providerId}.wire_api=${tomlString("responses")}`,
        `model_providers.${providerId}.requires_openai_auth=true`,
        `model_providers.${providerId}.env_http_headers={ ${tomlString("X-OmniCodex-Loopback-Key")} = ${tomlString("OMNICODEX_LOOPBACK_API_KEY")} }`,
        `model_providers.${providerId}.supports_standalone_web_search=true`,
        `model_providers.${providerId}.supports_websockets=false`,
        "features.image_generation=true",
        "features.standalone_web_search=true",
      ],
      requestTimeoutMs: this.#options.turnTimeoutMs,
      onNotification: (message) => this.#onNotification(message),
      onServerRequest: (message) => answerAppServerApprovalRequest(message),
    });
    try {
      await process.start();
      this.#process = process;
      await this.#waitForMcpCatalogStability();
      await this.refreshCatalog();
      await this.#refreshSkillBoundCatalog();
      await this.#discoverNestedTools();
    } catch (error) {
      this.#process = undefined;
      await process.stop().catch(() => undefined);
      await this.#driver.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const process = this.#process;
    this.#process = undefined;
    const error = new Error("Responses runtime executor stopped");
    this.#driver.cancelActiveToolCall(error);
    for (const [turnId, waiter] of this.#turnWaiters) {
      this.#turnWaiters.delete(turnId);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#completedTurns.clear();
    this.#nestedTools = [];
    this.#nestedMcpToolNames.clear();
    this.#executionThreadId = undefined;
    if (process !== undefined) {
      await process.stop().catch(() => undefined);
    }
    await this.#driver.stop().catch(() => undefined);
  }

  async refreshCatalog(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#runTurn();
    });
  }

  async call(selection: ResponsesSelectedToolCall): Promise<ResponsesToolExecutionResult> {
    return this.#enqueue(async () => {
      const result = await this.#runTurn(selection);
      if (result === undefined) {
        throw new Error("Responses runtime did not return a native tool result");
      }
      return result;
    });
  }

  async callNested(name: string, argumentsValue: unknown, freeform: boolean): Promise<unknown> {
    const normalizedArguments =
      freeform && isObject(argumentsValue) && typeof argumentsValue.input === "string"
        ? argumentsValue.input
        : argumentsValue;
    const script = [
      '// @exec: {"max_output_tokens": 120000}',
      `const __name = ${JSON.stringify(name)};`,
      `const __args = ${jsonLiteral(normalizedArguments)};`,
      "const __result = await tools[__name](__args);",
      `text(${JSON.stringify(nestedResultMarker)} + JSON.stringify(__result ?? null));`,
    ].join("\n");
    const result = await this.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: script,
    });
    return parseMarkedExecResult(result.output, nestedResultMarker);
  }

  async callMcp(server: string, tool: string, argumentsValue: unknown): Promise<unknown> {
    const nestedName = `mcp__${nestedToolSegment(server)}__${nestedToolSegment(tool)}`;
    if (!this.#nestedMcpToolNames.has(nestedName)) {
      throw new Error(
        `Codex runtime did not advertise downstream tool ${server}/${tool} as ${nestedName}`,
      );
    }
    return this.callNested(nestedName, argumentsValue, false);
  }

  async #runTurn(
    selection?: ResponsesSelectedToolCall,
    inputOverride?: readonly JsonObject[],
  ): Promise<ResponsesToolExecutionResult | undefined> {
    const process = this.#process;
    if (process === undefined) {
      throw new Error("Responses runtime executor is not running");
    }
    const threadId = await this.#ensureExecutionThread(process);
    const prepared = selection === undefined ? undefined : this.#driver.prepareToolCall(selection);
    try {
      const turnResponse = await process.client.request<unknown>("turn/start", {
        threadId,
        input: inputOverride ?? [
          {
            type: "text",
            text:
              selection === undefined
                ? "Capture the native tool catalog and complete."
                : "Execute the tool call already selected by the OmniCodex loopback driver.",
          },
        ],
      });
      const turnId = nestedString(turnResponse, "turn", "id");
      if (turnId === undefined) {
        throw new Error("Codex App Server did not return an executor turn id");
      }
      const turnCompletion = this.#waitForTurn(turnId);
      if (prepared === undefined) {
        await turnCompletion;
        return undefined;
      }
      const [toolResult] = await Promise.all([prepared.completion, turnCompletion]);
      return toolResult;
    } catch (error) {
      this.#driver.cancelActiveToolCall(toError(error));
      throw error;
    }
  }

  async #refreshSkillBoundCatalog(): Promise<void> {
    const runtimeProcess = this.#process;
    if (runtimeProcess === undefined) {
      throw new Error("Responses runtime executor is not running");
    }
    const response = await runtimeProcess.client.request<unknown>("skills/list", {
      cwds: [this.#options.cwd ?? process.cwd()],
      forceReload: false,
    });
    const imagegen = enabledSystemSkill(response, "imagegen");
    if (imagegen === undefined) return;
    await this.#enqueue(async () => {
      await this.#runTurn(undefined, [
        {
          type: "text",
          text: "Capture the native tools activated by this installed system skill.",
        },
        { type: "skill", name: imagegen.name, path: imagegen.path },
      ]);
    });
  }

  async #discoverNestedTools(): Promise<void> {
    const result = await this.call({
      kind: "custom",
      namespace: "functions",
      name: "exec",
      arguments: [
        '// @exec: {"max_output_tokens": 30000}',
        'const __direct = ALL_TOOLS.filter((tool) => !tool.name.startsWith("mcp__"));',
        'const __mcpToolNames = ALL_TOOLS.filter((tool) => tool.name.startsWith("mcp__")).map((tool) => tool.name);',
        "text(JSON.stringify({ total: ALL_TOOLS.length, tools: __direct, mcpToolNames: __mcpToolNames }));",
      ].join("\n"),
    });
    const value = parseJsonExecResult(result.output);
    if (!isObject(value) || !Array.isArray(value.tools)) {
      throw new Error("Codex functions.exec did not return the direct ALL_TOOLS catalog");
    }
    const nestedToolsByName = new Map<string, ResponsesNestedToolMetadata>();
    for (const item of value.tools) {
      if (
        !isObject(item) ||
        typeof item.name !== "string" ||
        typeof item.description !== "string"
      ) {
        continue;
      }
      nestedToolsByName.set(item.name, { name: item.name, description: item.description });
    }
    const nestedTools = [...nestedToolsByName.values()];
    if (nestedTools.length === 0) {
      throw new Error("Codex ALL_TOOLS catalog was empty");
    }
    this.#nestedTools = nestedTools.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    );
    this.#nestedMcpToolNames = new Set(
      Array.isArray(value.mcpToolNames)
        ? value.mcpToolNames.filter((name): name is string => typeof name === "string")
        : [],
    );
  }

  async #ensureExecutionThread(process: CodexAppServerProcess): Promise<string> {
    if (this.#executionThreadId !== undefined) {
      return this.#executionThreadId;
    }
    const threadResponse = await process.client.request<unknown>("thread/start", {
      approvalPolicy: "never",
      baseInstructions:
        "Execute only the exact tool call selected by the OmniCodex loopback driver.",
      cwd: this.#options.cwd ?? null,
      developerInstructions: "No inference is performed in this thread.",
      ephemeral: true,
      experimentalRawEvents: true,
      model: this.#options.model,
      modelProvider: this.#options.providerId,
      sandbox: "danger-full-access",
      serviceName: "omnicodex",
    });
    const threadId = nestedString(threadResponse, "thread", "id");
    if (threadId === undefined) {
      throw new Error("Codex App Server did not return an ephemeral executor thread id");
    }
    this.#executionThreadId = threadId;
    return threadId;
  }

  async #waitForMcpCatalogStability(): Promise<void> {
    const process = this.#process;
    if (process === undefined) {
      throw new Error("Responses runtime executor is not running");
    }
    let previousSignature = "";
    let stableSamples = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await process.client.request<unknown>("mcpServerStatus/list", {
        detail: "full",
        limit: 1_000,
      });
      const statuses = isObject(response) && Array.isArray(response.data) ? response.data : [];
      const signature = statuses
        .filter((item): item is Record<string, unknown> => isObject(item))
        .map((item) => {
          const name = typeof item.name === "string" ? item.name : "unknown";
          const toolCount = isObject(item.tools) ? Object.keys(item.tools).length : 0;
          return `${name}:${toolCount}`;
        })
        .sort((left, right) => left.localeCompare(right, "en"))
        .join("|");
      if (signature.length > 0 && signature === previousSignature) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return;
        }
      } else {
        stableSamples = 0;
        previousSignature = signature;
      }
      await delay(250);
    }
  }

  #waitForTurn(turnId: string): Promise<JsonObject> {
    const completed = this.#completedTurns.get(turnId);
    if (completed !== undefined) {
      this.#completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#turnWaiters.delete(turnId);
        reject(new Error(`Responses executor turn timed out: ${turnId}`));
      }, this.#options.turnTimeoutMs);
      this.#turnWaiters.set(turnId, { timer, resolve, reject });
    });
  }

  #onNotification(message: JsonObject): void {
    this.#options.onDiagnostic?.(message);
    if (message.method !== "turn/completed") {
      return;
    }
    const turnId = nestedString(message.params, "turn", "id");
    if (turnId === undefined) {
      return;
    }
    const waiter = this.#turnWaiters.get(turnId);
    if (waiter === undefined) {
      this.#completedTurns.set(turnId, message);
      if (this.#completedTurns.size > 100) {
        const first = this.#completedTurns.keys().next().value;
        if (typeof first === "string") {
          this.#completedTurns.delete(first);
        }
      }
      return;
    }
    this.#turnWaiters.delete(turnId);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#serialTail.then(operation, operation);
    this.#serialTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const nested = value[objectKey];
  return isObject(nested) && typeof nested[fieldKey] === "string" ? nested[fieldKey] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledSystemSkill(
  response: unknown,
  expectedName: string,
): { readonly name: string; readonly path: string } | undefined {
  if (!isObject(response) || !Array.isArray(response.data)) return undefined;
  for (const entry of response.data) {
    if (!isObject(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills) {
      if (
        isObject(skill) &&
        skill.enabled === true &&
        skill.scope === "system" &&
        skill.name === expectedName &&
        typeof skill.path === "string"
      ) {
        return { name: expectedName, path: skill.path };
      }
    }
  }
  return undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const nestedResultMarker = "OMNICODEX_NESTED_RESULT_V1:";

function parseJsonExecResult(output: unknown): unknown {
  for (const text of execTextBlocks(output).reverse()) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      // Continue searching other output blocks.
    }
  }
  throw new Error("Codex functions.exec returned no parseable JSON result");
}

function parseMarkedExecResult(output: unknown, marker: string): unknown {
  for (const text of execTextBlocks(output).reverse()) {
    const index = text.indexOf(marker);
    if (index < 0) {
      continue;
    }
    return JSON.parse(text.slice(index + marker.length));
  }
  throw new Error("Codex nested tool returned no correlated result marker");
}

function execTextBlocks(output: unknown): string[] {
  if (!Array.isArray(output)) {
    return [];
  }
  return output
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string");
}

function jsonLiteral(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) {
    throw new Error("Nested tool arguments are not JSON-serializable");
  }
  return serialized;
}

function nestedToolSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
