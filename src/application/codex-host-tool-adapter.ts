import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceDependencyLocator } from "../infrastructure/windows/workspace-dependency-locator.js";
import type { BrowserNativeExecutor } from "./browser-native-executor.js";
import type {
  ComputerUseMethod,
  ComputerUseNativeExecutor,
} from "./computer-use-native-executor.js";
import type { AppServerRpcClient } from "./native-tool-catalog.js";

export interface CodexHostToolDescriptor {
  readonly name: string;
  readonly tool: Tool;
  readonly invokesModel: boolean;
}

export interface CodexHostToolAdapterOptions {
  readonly cwd?: string;
  readonly browser?: BrowserNativeExecutor;
  readonly computerUse?: ComputerUseNativeExecutor;
  readonly workspaceDependencies?: { locate(): Promise<unknown> };
}

/** Non-invasive semantic adapters for host tools that have equivalent App Server operations. */
export class CodexHostToolAdapter {
  readonly #client: AppServerRpcClient;
  readonly #options: CodexHostToolAdapterOptions;
  readonly #projects = new Map<string, string>();
  readonly #tools: readonly CodexHostToolDescriptor[];
  readonly #workspaceDependencies: { locate(): Promise<unknown> };

  constructor(client: AppServerRpcClient, options: CodexHostToolAdapterOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.#workspaceDependencies = options.workspaceDependencies ?? new WorkspaceDependencyLocator();
    this.#tools = hostTools(options.browser !== undefined, options.computerUse !== undefined);
  }

  get tools(): readonly CodexHostToolDescriptor[] {
    return this.#tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "codex_app__list_threads":
        return this.#listThreads(args);
      case "codex_app__read_thread":
        return this.#readThread(args);
      case "codex_app__list_projects":
        return this.#listProjects();
      case "codex_app__load_workspace_dependencies":
        return this.#workspaceDependencies.locate();
      case "codex_app__set_thread_archived":
        return this.#setArchived(args);
      case "codex_app__set_thread_title":
        return this.#setTitle(args);
      case "codex_app__fork_thread":
        return this.#forkThread(args);
      case "codex_app__wait_threads":
        return this.#waitThreads(args);
      case "codex_app__create_thread":
        return this.#createThread(args);
      case "codex_app__send_message_to_thread":
        return this.#sendMessage(args);
      case "codex.browser.exec":
        if (this.#options.browser === undefined) {
          throw new Error("Installed Codex Browser runtime is unavailable");
        }
        return this.#options.browser.call(args);
      default:
        if (name.startsWith(computerUseToolPrefix)) {
          if (this.#options.computerUse === undefined) {
            throw new Error("Installed Codex Computer Use runtime is unavailable");
          }
          return this.#options.computerUse.call(
            name.slice(computerUseToolPrefix.length) as ComputerUseMethod,
            args,
          );
        }
        throw new Error(`Unknown Codex host adapter tool: ${name}`);
    }
  }

  async #listThreads(args: Record<string, unknown>): Promise<unknown> {
    const result = await this.#client.request<unknown>("thread/list", {
      ...(numberValue(args.limit) === undefined ? {} : { limit: numberValue(args.limit) }),
      ...(typeof args.query === "string" ? { searchTerm: args.query } : {}),
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    return withLocalHost(result);
  }

  async #readThread(args: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(args.threadId, "threadId");
    const [metadata, turns] = await Promise.all([
      this.#client.request<unknown>("thread/read", { threadId, includeTurns: false }),
      this.#client.request<unknown>("thread/turns/list", {
        threadId,
        ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        ...(numberValue(args.turnLimit) === undefined
          ? { limit: 20 }
          : { limit: numberValue(args.turnLimit) }),
        itemsView: args.includeOutputs === true ? "full" : "summary",
        sortDirection: "desc",
      }),
    ]);
    return { hostId: "local", metadata, turns };
  }

  async #listProjects(): Promise<unknown> {
    const result = await this.#client.request<unknown>("thread/list", {
      limit: 1_000,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    const paths = new Set<string>();
    if (this.#options.cwd !== undefined) {
      paths.add(this.#options.cwd);
    }
    if (isObject(result) && Array.isArray(result.data)) {
      for (const thread of result.data) {
        if (isObject(thread) && typeof thread.cwd === "string" && thread.cwd.length > 0) {
          paths.add(thread.cwd);
        }
      }
    }
    this.#projects.clear();
    const projects = [...paths]
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((path) => {
        const projectId = projectIdFor(path);
        this.#projects.set(projectId, path);
        return {
          projectId,
          name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
          path,
          hostId: "local",
        };
      });
    return { projects };
  }

  async #setArchived(args: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(args.threadId, "threadId");
    const archived = requiredBoolean(args.archived, "archived");
    const result = await this.#client.request(archived ? "thread/archive" : "thread/unarchive", {
      threadId,
    });
    return { hostId: "local", threadId, archived, result };
  }

  async #setTitle(args: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(args.threadId, "threadId");
    const title = requiredString(args.title, "title");
    const result = await this.#client.request("thread/name/set", { threadId, name: title });
    return { hostId: "local", threadId, title, result };
  }

  async #forkThread(args: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(args.threadId, "threadId");
    const environment = isObject(args.environment) ? args.environment.type : undefined;
    if (environment !== undefined && environment !== "same-directory") {
      throw new Error(
        "Worktree fork requires the desktop host worktree manager and is not available",
      );
    }
    const result = await this.#client.request<unknown>("thread/fork", {
      threadId,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
    });
    return withLocalHost(result);
  }

  async #waitThreads(args: Record<string, unknown>): Promise<unknown> {
    if (!Array.isArray(args.targets) || args.targets.length === 0 || args.targets.length > 8) {
      throw new Error("targets must contain one to eight threads");
    }
    const timeoutMs = Math.max(0, Math.min(120_000, numberValue(args.timeoutMs) ?? 120_000));
    const deadline = Date.now() + timeoutMs;
    do {
      const snapshots = await Promise.all(
        args.targets.map(async (target) => {
          if (!isObject(target)) {
            throw new Error("Each wait target must be an object");
          }
          const threadId = requiredString(target.threadId, "threadId");
          const value = await this.#client.request<unknown>("thread/read", {
            threadId,
            includeTurns: false,
          });
          return { hostId: "local", threadId, value };
        }),
      );
      const ready = snapshots.find((snapshot) => !isThreadActive(snapshot.value));
      if (ready !== undefined || Date.now() >= deadline) {
        return { ready: ready ?? null, snapshots, cursor: String(Date.now()) };
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error("Unreachable wait state");
  }

  async #createThread(args: Record<string, unknown>): Promise<unknown> {
    requireModelAcknowledgement(args);
    const prompt = requiredString(args.prompt, "prompt");
    let cwd: string | null = null;
    if (isObject(args.target) && args.target.type === "project") {
      if (isObject(args.target.environment) && args.target.environment.type === "worktree") {
        throw new Error("Worktree creation requires the desktop host worktree manager");
      }
      const projectId = requiredString(args.target.projectId, "projectId");
      if (!this.#projects.has(projectId)) {
        await this.#listProjects();
      }
      cwd = this.#projects.get(projectId) ?? null;
      if (cwd === null) {
        throw new Error(`Unknown local project id: ${projectId}`);
      }
    }
    const started = await this.#client.request<unknown>("thread/start", {
      approvalPolicy: "never",
      cwd,
      ephemeral: false,
      model: typeof args.model === "string" ? args.model : null,
      sandbox: "danger-full-access",
      serviceName: "omnicodex",
      threadSource: "user",
    });
    const threadId = nestedString(started, "thread", "id");
    if (threadId === undefined) {
      throw new Error("App Server did not return a persistent thread id");
    }
    await this.#client.request("thread/name/set", {
      threadId,
      name: `[OmniCodex] ${prompt.replace(/\s+/g, " ").trim().slice(0, 80)}`,
    });
    const turn = await this.#client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      ...(typeof args.model === "string" ? { model: args.model } : {}),
      ...(typeof args.thinking === "string" ? { effort: args.thinking } : {}),
    });
    return { hostId: "local", threadId, thread: started, turn };
  }

  async #sendMessage(args: Record<string, unknown>): Promise<unknown> {
    requireModelAcknowledgement(args);
    const threadId = requiredString(args.threadId, "threadId");
    const prompt = requiredString(args.prompt, "prompt");
    await this.#client.request("thread/resume", {
      threadId,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const turn = await this.#client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      ...(typeof args.model === "string" ? { model: args.model } : {}),
      ...(typeof args.thinking === "string" ? { effort: args.thinking } : {}),
    });
    return { hostId: "local", threadId, turn };
  }
}

function hostTools(browser: boolean, computerUse: boolean): readonly CodexHostToolDescriptor[] {
  const descriptors: CodexHostToolDescriptor[] = [
    descriptor(
      "codex_app__list_threads",
      "List Codex threads on the local host.",
      objectSchema({ limit: { type: "integer", minimum: 1 }, query: { type: "string" } }),
      false,
    ),
    descriptor(
      "codex_app__read_thread",
      "Read Codex thread metadata and paged turns.",
      objectSchema(
        {
          threadId: { type: "string" },
          cursor: { type: "string" },
          turnLimit: { type: "integer", minimum: 1 },
          includeOutputs: { type: "boolean" },
        },
        ["threadId"],
      ),
      false,
    ),
    descriptor(
      "codex_app__list_projects",
      "List local project roots derived from current Codex threads.",
      objectSchema({}),
      false,
    ),
    descriptor(
      "codex_app__load_workspace_dependencies",
      "Locate the installed Codex workspace dependency runtime paths.",
      objectSchema({}),
      false,
    ),
    descriptor(
      "codex_app__set_thread_archived",
      "Archive or unarchive a local Codex thread.",
      objectSchema({ threadId: { type: "string" }, archived: { type: "boolean" } }, [
        "threadId",
        "archived",
      ]),
      false,
    ),
    descriptor(
      "codex_app__set_thread_title",
      "Rename a local Codex thread.",
      objectSchema({ threadId: { type: "string" }, title: { type: "string" } }, [
        "threadId",
        "title",
      ]),
      false,
    ),
    descriptor(
      "codex_app__fork_thread",
      "Fork a local Codex thread in the same directory.",
      objectSchema(
        {
          threadId: { type: "string" },
          environment: {
            type: "object",
            properties: { type: { enum: ["same-directory", "worktree"] } },
          },
        },
        ["threadId"],
      ),
      false,
    ),
    descriptor(
      "codex_app__wait_threads",
      "Wait until one of up to eight local Codex threads is no longer active.",
      objectSchema(
        {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              required: ["threadId"],
              properties: {
                threadId: { type: "string" },
                hostId: { type: "string" },
                afterCursor: { type: "string" },
              },
            },
          },
          timeoutMs: { type: "integer", minimum: 0, maximum: 120000 },
        },
        ["targets"],
      ),
      false,
    ),
    descriptor(
      "codex_app__create_thread",
      "Create a persistent [OmniCodex] thread and explicitly invoke the Codex model.",
      modelSchema(
        {
          prompt: { type: "string" },
          target: { type: "object", additionalProperties: true },
          model: { type: "string" },
          thinking: { type: "string" },
        },
        ["prompt"],
      ),
      true,
    ),
    descriptor(
      "codex_app__send_message_to_thread",
      "Send a follow-up to a persistent thread and explicitly invoke the Codex model.",
      modelSchema(
        {
          threadId: { type: "string" },
          prompt: { type: "string" },
          model: { type: "string" },
          thinking: { type: "string" },
        },
        ["threadId", "prompt"],
      ),
      true,
    ),
  ];
  if (browser) {
    descriptors.push(
      descriptor(
        "codex.browser.exec",
        "Execute the installed Codex Browser/Chrome API in the persistent privileged runtime.",
        objectSchema(
          {
            code: { type: "string" },
            timeout_ms: { type: "integer", minimum: 1 },
            title: { type: "string", maxLength: 80 },
          },
          ["code"],
        ),
        false,
      ),
    );
  }
  if (computerUse) {
    descriptors.push(...computerUseTools());
  }
  return descriptors;
}

const computerUseToolPrefix = "codex.computer_use.";

function computerUseTools(): readonly CodexHostToolDescriptor[] {
  return [
    computerUseDescriptor("list_apps", "List applications visible to Codex Computer Use.", {}),
    computerUseDescriptor("list_windows", "List windows visible to Codex Computer Use.", {}),
    computerUseDescriptor(
      "get_window",
      "Resolve a Computer Use window by id and optional application.",
      { id: { type: "number" }, app: stringProperty() },
      ["id"],
    ),
    computerUseDescriptor(
      "launch_app",
      "Launch an application through the installed Codex Computer Use runtime.",
      { app: stringProperty() },
      ["app"],
    ),
    computerUseDescriptor(
      "get_window_state",
      "Read the current Computer Use window state, optionally including screenshot or text.",
      {
        window: windowProperty(),
        include_screenshot: { type: "boolean" },
        include_text: { type: "boolean" },
      },
      ["window"],
    ),
    computerUseDescriptor(
      "click",
      "Click coordinates or an indexed element in a Computer Use window.",
      {
        window: windowProperty(),
        click_count: { type: "integer", minimum: 1 },
        element_index: { type: "integer", minimum: 0 },
        mouse_button: { enum: ["left", "middle", "right", "l", "m", "r"] },
        screenshotId: stringProperty(),
        x: numberProperty(),
        y: numberProperty(),
      },
      ["window"],
    ),
    computerUseDescriptor(
      "press_key",
      "Press a key or key chord in a Computer Use window.",
      { window: windowProperty(), key: stringProperty() },
      ["window", "key"],
    ),
    computerUseDescriptor(
      "type_text",
      "Type text into a Computer Use window.",
      { window: windowProperty(), text: stringProperty() },
      ["window", "text"],
    ),
    computerUseDescriptor(
      "scroll",
      "Scroll at coordinates in a Computer Use window.",
      {
        window: windowProperty(),
        scrollX: numberProperty(),
        scrollY: numberProperty(),
        x: numberProperty(),
        y: numberProperty(),
        screenshotId: stringProperty(),
      },
      ["window", "scrollX", "scrollY", "x", "y"],
    ),
    computerUseDescriptor(
      "set_value",
      "Set the value of an indexed element in a Computer Use window.",
      {
        window: windowProperty(),
        element_index: { type: "integer", minimum: 0 },
        value: stringProperty(),
      },
      ["window", "element_index", "value"],
    ),
    computerUseDescriptor(
      "drag",
      "Drag between coordinates in a Computer Use window.",
      {
        window: windowProperty(),
        from_x: numberProperty(),
        from_y: numberProperty(),
        to_x: numberProperty(),
        to_y: numberProperty(),
        screenshotId: stringProperty(),
      },
      ["window", "from_x", "from_y", "to_x", "to_y"],
    ),
    computerUseDescriptor(
      "perform_secondary_action",
      "Perform a secondary action on an indexed Computer Use element.",
      {
        window: windowProperty(),
        element_index: { type: "integer", minimum: 0 },
        action: stringProperty(),
      },
      ["window", "element_index", "action"],
    ),
    computerUseDescriptor(
      "activate_window",
      "Activate a Computer Use window.",
      { window: windowProperty() },
      ["window"],
    ),
  ];
}

function computerUseDescriptor(
  method: ComputerUseMethod,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): CodexHostToolDescriptor {
  return descriptor(
    `${computerUseToolPrefix}${method}`,
    description,
    objectSchema(properties, required),
    false,
  );
}

function stringProperty(): Record<string, unknown> {
  return { type: "string", minLength: 1 };
}

function numberProperty(): Record<string, unknown> {
  return { type: "number" };
}

function windowProperty(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      app: stringProperty(),
      id: { type: "number" },
      title: { type: "string" },
    },
    required: ["app", "id"],
    additionalProperties: false,
  };
}

function descriptor(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  invokesModel: boolean,
): CodexHostToolDescriptor {
  return {
    name,
    invokesModel,
    tool: {
      name,
      description,
      inputSchema,
      _meta: { omnicodex: { source: "codex_host_adapter", invokesModel } },
    } as unknown as Tool,
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function modelSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return objectSchema({ ...properties, invokesModel: { type: "boolean", const: true } }, [
    ...required,
    "invokesModel",
  ]);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function requireModelAcknowledgement(args: Record<string, unknown>): void {
  if (args.invokesModel !== true) throw new Error("This tool requires invokesModel=true");
}

function projectIdFor(path: string): string {
  return `local-${createHash("sha256").update(path.toLowerCase(), "utf8").digest("hex").slice(0, 20)}`;
}

function withLocalHost(value: unknown): unknown {
  return isObject(value) ? { hostId: "local", ...value } : { hostId: "local", value };
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  if (!isObject(value)) return undefined;
  const nested = value[objectKey];
  return isObject(nested) && typeof nested[fieldKey] === "string" ? nested[fieldKey] : undefined;
}

function isThreadActive(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.thread) || !isObject(value.thread.status)) return false;
  const type = value.thread.status.type;
  return type === "active" || type === "running" || type === "inProgress";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
