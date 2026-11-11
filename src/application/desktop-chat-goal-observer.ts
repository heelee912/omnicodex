import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ORACLE_GOAL_CONVERSATION_SOURCE,
  type OracleGoalConversation,
  parseOracleGoalConversation,
} from "../infrastructure/chatgpt/oracle-goal-conversation.js";
import type { DirectGoalStore } from "../infrastructure/mcp/direct-goal-store.js";
import {
  type DesktopChatCompletionCandidate,
  type DesktopChatCompletionVerification,
  desktopChatCompletionCandidates,
} from "../infrastructure/windows/desktop-chat-completion.js";
import type {
  DesktopChatEventSource,
  DesktopChatObservedEvent,
} from "../infrastructure/windows/desktop-chat-event-source.js";
import { chatAccountRateLimitRetryAt } from "./chat-account-request-coordinator.js";

export type DesktopGoalBindingRecovery =
  | OracleGoalConversation
  | { readonly outcome: "pending"; readonly retryAtUnixMs: number };

/** A throttled observation is not evidence that the source account changed. */
export function desktopGoalBindingObservation(
  result: {
    readonly goalConversations?: readonly OracleGoalConversation[];
    readonly nextScanAtUnixMs?: number;
  },
  conversationUrl: string,
  accountSourceId: string,
  now: number,
): DesktopGoalBindingRecovery {
  const observation = result.goalConversations?.find(
    (item) => item.conversationUrl === conversationUrl,
  );
  if (!observation) {
    if (result.nextScanAtUnixMs !== undefined && result.nextScanAtUnixMs > now)
      return { outcome: "pending", retryAtUnixMs: result.nextScanAtUnixMs };
    throw new Error("DESKTOP_GOAL_BINDING_OBSERVATION_MISSING");
  }
  if (observation.source?.accountSourceId !== accountSourceId)
    throw new Error("DESKTOP_GOAL_BINDING_SOURCE_CHANGED");
  return observation;
}

type Node = { id: string; parent?: string; final: boolean };
type Pending = {
  accountSourceId: string;
  conversationUrl: string;
  goals: OracleGoalConversation["goals"];
  nodes: Record<string, Node>;
  candidates: string[];
  pending: boolean;
  revision: number;
  retryAt: number;
  rateLimitRetryAt?: number;
  bindingReadPending?: boolean;
  attempts: number;
};
const project = new Function(`return (${ORACLE_GOAL_CONVERSATION_SOURCE})`)() as (
  id: string,
  conversation: unknown,
  connector: string,
) => unknown;

/** Exact event readbacks only. Goal state and dispatch claims remain in DirectGoalStore. */
export class DesktopChatGoalObserver {
  readonly #abort = new AbortController();
  readonly #pending = new Map<string, Pending>();
  readonly #flights = new Map<string, Promise<void>>();
  #writes: Promise<void> = Promise.resolve();
  #events: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tick: Promise<void> | undefined;
  #lastError: string | undefined;
  #storageFailed = false;
  constructor(
    private readonly options: {
      path: string;
      source: Pick<DesktopChatEventSource, "ensureConnected" | "stop">;
      store: Pick<
        DirectGoalStore,
        "hasObservedGoalCandidate" | "continuationCheckpoints" | "hasUnboundContinuation"
      >;
      recoverBinding?: (
        conversationUrl: string,
        accountSourceId: string,
        signal: AbortSignal,
      ) => Promise<DesktopGoalBindingRecovery>;
      readCooldown?: (accountSourceId: string) => Promise<{ retryAtUnixMs: number } | undefined>;
      readScope: (
        signal: AbortSignal,
      ) => Promise<{ accountSourceId: string; connectorIds: readonly string[] }>;
      verify: (
        candidate: DesktopChatCompletionCandidate,
        signal: AbortSignal,
      ) => Promise<DesktopChatCompletionVerification>;
      readback: (
        conversationUrl: string,
        anchor: string | undefined,
        signal: AbortSignal,
      ) => Promise<DesktopChatCompletionVerification>;
      observe: (observations: readonly OracleGoalConversation[]) => Promise<void>;
      onConversationDeleted?: (conversationUrl: string, accountSourceId: string) => Promise<void>;
      report: (outcome: string, error?: string) => Promise<void>;
      onEvent?: (event: DesktopChatObservedEvent) => void;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.options.path, "utf8")) as {
        version: number;
        entries: Pending[];
      };
      if (data.version !== 1 || !Array.isArray(data.entries))
        throw new Error("DESKTOP_GOAL_READBACK_STATE_INVALID");
      for (const entry of data.entries) {
        if (
          !/^chatgpt:[^:]+:[^:]+$/.test(entry.accountSourceId) ||
          !/^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+$/i.test(entry.conversationUrl) ||
          !entry.nodes ||
          !Array.isArray(entry.goals) ||
          !Array.isArray(entry.candidates) ||
          !Number.isSafeInteger(entry.revision) ||
          (entry.bindingReadPending !== undefined &&
            typeof entry.bindingReadPending !== "boolean") ||
          (entry.rateLimitRetryAt !== undefined &&
            (!Number.isSafeInteger(entry.rateLimitRetryAt) || entry.rateLimitRetryAt < 0))
        )
          throw new Error("DESKTOP_GOAL_READBACK_STATE_INVALID");
        // Retire persisted local exponential waits without shortening a known
        // server/account deadline or an unresolved binding observation.
        if (entry.pending && !entry.bindingReadPending) {
          entry.retryAt = Math.min(
            entry.retryAt,
            Math.max(this.#now() + 30_000, entry.rateLimitRetryAt ?? 0),
          );
        }
        this.#pending.set(this.#key(entry), entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      this.options.recoverBinding &&
      (await this.options.store.hasUnboundContinuation({ activeOnly: true }))
    ) {
      const checkpoints = await this.options.store.continuationCheckpoints();
      let changed = false;
      for (const entry of this.#pending.values()) {
        if (
          entry.pending &&
          entry.bindingReadPending === undefined &&
          !checkpoints.some((item) => item.conversationUrl === entry.conversationUrl) &&
          !(await this.options.store.hasObservedGoalCandidate(entry.goals, { unboundOnly: true }))
        ) {
          // Older snapshots can retain a bare completion but miss its Goal result.
          // Recover only that durable pending conversation; preserve its cooldown.
          entry.bindingReadPending = true;
          changed = true;
        }
      }
      if (changed) await this.#save();
    }
    this.#schedule(0);
  }

  #key(entry: Pick<Pending, "accountSourceId" | "conversationUrl">): string {
    return `${entry.accountSourceId}\0${entry.conversationUrl}`;
  }
  #now(): number {
    return this.options.now?.() ?? Date.now();
  }
  #save(): Promise<void> {
    const serialized = JSON.stringify({ version: 1, entries: [...this.#pending.values()] });
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true });
      await writeFile(`${this.options.path}.tmp`, serialized, { mode: 0o600 });
      await renamePendingSnapshot(`${this.options.path}.tmp`, this.options.path);
    });
    this.#writes = write.catch(() => {
      this.#storageFailed = true;
    });
    return write;
  }

  /** Serializes only event ingestion, never the native readback of independent Goals. */
  accept(event: DesktopChatObservedEvent): Promise<void> {
    const accepted = this.#events.then(() => this.#accept(event));
    this.#events = accepted.catch((error) => this.#report(error));
    return accepted;
  }
  async #accept(event: DesktopChatObservedEvent): Promise<void> {
    this.#abort.signal.throwIfAborted();
    const payload = event.notification.payload as {
      conversation_id?: string;
      update_content?: { messages?: Record<string, unknown>[] };
    };
    const id = event.conversationUrl.slice("https://chatgpt.com/c/".length);
    if (
      !/^[a-z0-9-]+$/i.test(id) ||
      event.conversationUrl !== `https://chatgpt.com/c/${id}` ||
      payload?.conversation_id !== id
    )
      return;
    const messages = payload.update_content?.messages ?? [];
    if (!Array.isArray(messages)) return;
    const known = [...this.#pending.values()].some(
      (entry) => entry.conversationUrl === event.conversationUrl,
    );
    const possibleGoal = messages.some((message) => {
      const metadata = message?.metadata as
        | { invoked_resource?: { resource_uri?: unknown } }
        | undefined;
      const uri = metadata?.invoked_resource?.resource_uri;
      return (
        typeof uri === "string" &&
        /\/omnicodex__goal_(create|get|update|complete|claim_next_step)$/.test(uri)
      );
    });
    const recoverBinding =
      event.notification.type === "conversation-turn-complete" &&
      this.options.recoverBinding !== undefined &&
      (await this.options.store.hasUnboundContinuation({ activeOnly: true }));
    if (
      !known &&
      !possibleGoal &&
      !recoverBinding &&
      !(await this.options.store.continuationCheckpoints()).some(
        (item) => item.conversationUrl === event.conversationUrl,
      )
    )
      return;
    const scope = await this.options.readScope(this.#abort.signal);
    const goals = scope.connectorIds.flatMap(
      (connector) => parseOracleGoalConversation(project(id, { messages }, connector)).goals,
    );
    const key = this.#key({ ...scope, conversationUrl: event.conversationUrl });
    const prior = this.#pending.get(key);
    if (
      !prior &&
      !recoverBinding &&
      !(await this.options.store.hasObservedGoalCandidate(goals)) &&
      !(await this.options.store.continuationCheckpoints()).some(
        (item) => item.conversationUrl === event.conversationUrl,
      )
    )
      return;
    const entry: Pending = prior ?? {
      accountSourceId: scope.accountSourceId,
      conversationUrl: event.conversationUrl,
      goals: [],
      nodes: Object.create(null),
      candidates: [],
      pending: false,
      revision: 0,
      retryAt: 0,
      attempts: 0,
    };
    const finals = new Set(
      desktopChatCompletionCandidates(event).map((candidate) => candidate.finalMessageId),
    );
    const newFinals = [...finals].filter((id) => entry.nodes[id]?.final !== true);
    for (const message of messages) {
      if (typeof message.id !== "string" || !/^[a-z0-9][a-z0-9_:-]{0,127}$/i.test(message.id))
        continue;
      const metadata = message.metadata as { parent_id?: unknown } | undefined;
      const parent = message.parent_id ?? metadata?.parent_id;
      const previous = entry.nodes[message.id];
      if (previous?.parent && typeof parent === "string" && previous.parent !== parent)
        throw new Error("DESKTOP_GOAL_PARENT_CHANGED");
      entry.nodes[message.id] = {
        id: message.id,
        ...(typeof parent === "string"
          ? { parent }
          : previous?.parent
            ? { parent: previous.parent }
            : {}),
        final: finals.has(message.id) || previous?.final === true,
      };
    }
    entry.goals = [
      ...new Map([...entry.goals, ...goals].map((goal) => [goal.messageId, goal])).values(),
    ];
    entry.candidates = [...new Set([...entry.candidates, ...newFinals])];
    if (recoverBinding) entry.bindingReadPending = true;
    entry.revision++;
    if (
      newFinals.length ||
      recoverBinding ||
      (!entry.pending && event.notification.type === "conversation-turn-complete")
    ) {
      entry.pending = true;
      // A new final can resolve transcript lag, but cannot cancel a 429 deadline.
      entry.retryAt =
        (entry.rateLimitRetryAt ?? 0) > this.#now() ? (entry.rateLimitRetryAt ?? 0) : 0;
      entry.attempts = 0;
    }
    this.#pending.set(key, entry);
    await this.#save();
    this.#schedule(0);
  }

  #schedule(delay: number): void {
    if (this.#abort.signal.aborted) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#tick) return;
      this.#tick = this.#run()
        .catch((error) => this.#report(error))
        .finally(() => {
          this.#tick = undefined;
          this.#schedule(30_000);
        });
    }, delay);
    this.#timer.unref();
  }

  async #run(): Promise<void> {
    await this.#events;
    if (this.#storageFailed) throw new Error("DESKTOP_GOAL_READBACK_PERSIST_FAILED");
    try {
      const connected = await this.options.source.ensureConnected((event) => {
        try {
          this.options.onEvent?.(event);
        } catch (error) {
          void this.#report(error);
        }
        void this.accept(event).catch(() => undefined);
      }, this.#abort.signal);
      if (connected) await this.options.report("connected");
      this.#lastError = undefined;
    } catch (error) {
      await this.#report(error);
    }
    for (const [key, entry] of this.#pending) {
      if (
        !entry.pending ||
        entry.retryAt > this.#now() ||
        this.#flights.has(key) ||
        this.#abort.signal.aborted
      )
        continue;
      const flight = this.#verify(key, structuredClone(entry))
        .catch((error) => this.#report(error))
        .finally(() => this.#flights.delete(key));
      this.#flights.set(key, flight);
    }
  }

  async #verify(key: string, entry: Pending): Promise<void> {
    const checkpoint = (
      await this.options.store.continuationCheckpoints(entry.accountSourceId)
    ).find((item) => item.conversationUrl === entry.conversationUrl)?.checkpoint;
    // Keep pending history for resume, but do not fetch transcripts for Goals
    // that no longer run. A first verified binding is still needed when a Goal
    // was paused before its creation result arrived.
    if (
      !checkpoint &&
      !entry.bindingReadPending &&
      !(await this.options.store.hasObservedGoalCandidate(entry.goals, { unboundOnly: true }))
    )
      return;
    let accepted = false;
    let resolved = new Set<string>();
    let rateLimitRetryAt: number | undefined;
    let bindingRetryAt: number | undefined;
    let conversationDeleted = false;
    try {
      if (entry.bindingReadPending) {
        if (await this.options.store.hasUnboundContinuation({ activeOnly: true })) {
          if (!this.options.recoverBinding)
            throw new Error("DESKTOP_GOAL_BINDING_READER_UNAVAILABLE");
          const recovered = await this.options.recoverBinding(
            entry.conversationUrl,
            entry.accountSourceId,
            this.#abort.signal,
          );
          if ("outcome" in recovered) {
            bindingRetryAt = recovered.retryAtUnixMs;
            return;
          }
          if (
            recovered.conversationUrl !== entry.conversationUrl ||
            recovered.source?.accountSourceId !== entry.accountSourceId
          )
            throw new Error("DESKTOP_GOAL_BINDING_SOURCE_CHANGED");
          entry.goals = [
            ...new Map(
              [...entry.goals, ...recovered.goals].map((goal) => [goal.messageId, goal]),
            ).values(),
          ];
        }
        entry.bindingReadPending = false;
        if (
          !checkpoint &&
          !(await this.options.store.hasObservedGoalCandidate(entry.goals, { unboundOnly: true }))
        ) {
          accepted = true;
          resolved = new Set(entry.candidates);
          return;
        }
      }
      // All candidates refer to this same conversation. Resolve a backlog from
      // one authoritative current branch instead of fetching it once per ID.
      const batch =
        entry.candidates.length > 1
          ? await this.options.readback(
              entry.conversationUrl,
              checkpoint?.settledMessageId,
              this.#abort.signal,
            )
          : undefined;
      const candidates =
        batch === undefined
          ? entry.candidates.length
            ? entry.candidates
            : [undefined]
          : batch.outcome === "verified" &&
              entry.candidates.includes(batch.completion.finalMessageId)
            ? [batch.completion.finalMessageId]
            : [];
      for (const candidateId of candidates) {
        let node = candidateId === undefined ? undefined : entry.nodes[candidateId];
        if (candidateId !== undefined && !node?.final) continue;
        const verified =
          batch ??
          (node === undefined
            ? await this.options.readback(
                entry.conversationUrl,
                checkpoint?.settledMessageId,
                this.#abort.signal,
              )
            : await this.options.verify(
                { conversationUrl: entry.conversationUrl, finalMessageId: node.id },
                this.#abort.signal,
              ));
        if (verified.outcome !== "verified") continue;
        node ??= { id: verified.completion.finalMessageId, final: true };
        if (verified.accountSourceId !== entry.accountSourceId)
          throw new Error("DESKTOP_GOAL_ACCOUNT_CHANGED");
        let ancestors: string[] = [...(verified.ancestorMessageIds ?? [])];
        const seen = new Set([node.id]);
        let parent = node.parent;
        while (parent && verified.ancestorMessageIds === undefined) {
          if (seen.has(parent)) throw new Error("DESKTOP_GOAL_PARENT_CYCLE");
          seen.add(parent);
          ancestors.push(parent);
          parent = entry.nodes[parent]?.parent;
        }
        // Streaming updates can omit the user message that joins two turns.
        // Recover that edge from the native current branch before committing.
        const anchor = checkpoint?.settledMessageId;
        if (anchor && anchor !== node.id && !ancestors.includes(anchor)) {
          const branch = await this.options.readback(
            entry.conversationUrl,
            anchor,
            this.#abort.signal,
          );
          if (
            branch.outcome !== "verified" ||
            branch.accountSourceId !== entry.accountSourceId ||
            branch.completion.finalMessageId !== node.id ||
            !branch.ancestorMessageIds?.includes(anchor)
          )
            continue;
          ancestors = [...branch.ancestorMessageIds];
        }
        this.#abort.signal.throwIfAborted();
        await this.options.observe([
          {
            conversationUrl: entry.conversationUrl,
            source: { kind: "desktop", accountSourceId: entry.accountSourceId },
            goals: entry.goals,
            ...(checkpoint ? { checkpoint } : {}),
            current: {
              id: node.id,
              authorRole: "assistant",
              status: "finished_successfully",
              channel: "final",
              endTurn: true,
              ...(ancestors.length ? { ancestorMessageIds: ancestors } : {}),
            },
          },
        ]);
        accepted = true;
        resolved = new Set([node.id, ...ancestors]);
        await this.options.report("verified");
        break;
      }
    } catch (error) {
      // Only a native terminal response verified against this exact account and
      // conversation can retire observation. Keep the Goal and original error.
      const failure = error as {
        code?: unknown;
        can_retry?: unknown;
        accountSourceId?: unknown;
        conversationUrl?: unknown;
      } | null;
      conversationDeleted =
        failure?.code === "conversation_deleted" &&
        failure.can_retry === false &&
        failure.accountSourceId === entry.accountSourceId &&
        failure.conversationUrl === entry.conversationUrl;
      if (conversationDeleted && this.options.onConversationDeleted) {
        try {
          await this.options.onConversationDeleted(entry.conversationUrl, entry.accountSourceId);
        } catch (lifecycleError) {
          conversationDeleted = false;
          throw new AggregateError(
            [error, lifecycleError],
            "DESKTOP_GOAL_CONVERSATION_DELETE_SYNC_FAILED",
          );
        }
      }
      rateLimitRetryAt = chatAccountRateLimitRetryAt(error, this.#now());
      if (rateLimitRetryAt !== undefined && this.options.readCooldown) {
        // The first native 429 preserves its original error body. The shared
        // coordinator has already persisted the actual recovery deadline.
        const cooldown = await this.options.readCooldown(entry.accountSourceId);
        if (cooldown) rateLimitRetryAt = Math.max(rateLimitRetryAt, cooldown.retryAtUnixMs);
      }
      throw error;
    } finally {
      const current = this.#pending.get(key);
      if (current && rateLimitRetryAt !== undefined) {
        current.rateLimitRetryAt = Math.max(current.rateLimitRetryAt ?? 0, rateLimitRetryAt);
      }
      if (current?.revision === entry.revision) {
        current.goals = entry.goals;
        if (entry.bindingReadPending === undefined) {
          delete current.bindingReadPending;
        } else {
          current.bindingReadPending = entry.bindingReadPending;
        }
        if (accepted) {
          current.candidates = current.candidates.filter((id) => !resolved.has(id));
          delete current.rateLimitRetryAt;
        }
        current.pending = !conversationDeleted && (!accepted || current.candidates.length > 0);
        current.attempts = accepted
          ? 0
          : bindingRetryAt !== undefined
            ? current.attempts
            : current.attempts + 1;
        current.retryAt = accepted
          ? 0
          : bindingRetryAt !== undefined
            ? Math.max(this.#now() + 30_000, bindingRetryAt)
            : rateLimitRetryAt !== undefined
              ? Math.max(this.#now() + 30_000, rateLimitRetryAt)
              : this.#now() + 30_000;
        await this.#save();
      } else if (current && bindingRetryAt !== undefined) {
        current.retryAt = Math.max(current.retryAt, this.#now() + 30_000, bindingRetryAt);
        await this.#save();
      } else if (current && rateLimitRetryAt !== undefined) {
        // A newer event does not invalidate the account cooldown from this read.
        current.retryAt = Math.max(current.retryAt, this.#now() + 30_000, rateLimitRetryAt);
        current.attempts++;
        await this.#save();
      }
    }
  }

  async #report(error: unknown): Promise<void> {
    if (this.#abort.signal.aborted) return;
    const message = String(error);
    if (message === this.#lastError) return;
    this.#lastError = message;
    await this.options.report("failed", message);
  }
  async stop(): Promise<void> {
    this.#abort.abort();
    if (this.#timer) clearTimeout(this.#timer);
    await this.options.source.stop();
    await this.#tick;
    await this.#events;
    await Promise.all([...this.#flights.values()]);
    await this.#writes;
  }
}

// Windows readers can briefly hold the destination without delete sharing.
// Retry the atomic replace, never delete the durable destination first.
async function renamePendingSnapshot(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  let delay = 5;
  for (;;) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        Date.now() + delay > deadline
      )
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 100);
    }
  }
}
