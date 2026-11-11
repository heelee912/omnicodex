import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { RuntimeCandidate } from "../domain/runtime.js";
import { omniCodexDataDirectory } from "../infrastructure/config/omnicodex-config-store.js";
import { CodexAppServerConnection } from "../infrastructure/runtime/codex-app-server-connection.js";
import type { CodexAppServerOwnershipRegistry } from "../infrastructure/runtime/owned-codex-app-server-registry.js";
import {
  type AppServerThreadInventory,
  readAppServerThreadInventory,
} from "./app-server-thread-inventory.js";
import { OMNICODEX_BRIDGE_THREAD_TITLE } from "./app-server-thread-operation.js";
import type { AppServerRpcClient } from "./native-tool-catalog.js";
import {
  acquireOmniCodexBridgeDirectoryLease,
  type OmniCodexBridgeDirectoryLease,
} from "./omnicodex-bridge-directory-lease.js";

const MANIFEST_SCHEMA_VERSION = 1;
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * The Bridge is only a durable calling context for app-global native tools.
 * The desktop renderer accepts any persisted thread as that context, whatever
 * its dynamic tools are, while the real tool catalog is served by the gateway
 * App Server. A fixed empty registry keeps one Bridge for the lifetime of the
 * install instead of replacing it whenever catalog wording or desktop tool
 * availability changes (3,541 retired Bridges had accumulated by 2026-09-30).
 */
export const OMNICODEX_BRIDGE_CONTEXT_TOOLS: readonly Record<string, unknown>[] = Object.freeze([]);

type BridgePhase =
  | "stable"
  | "candidate_started"
  | "staged"
  | "old_archived"
  | "old_retired"
  | "candidate_promoted";

export interface OmniCodexBridgeManifest {
  readonly schemaVersion: 1;
  readonly phase: BridgePhase;
  readonly desiredRegistryDigest: string;
  readonly activeThreadId?: string;
  readonly previousThreadId?: string;
  readonly candidateThreadId?: string;
  readonly candidateTitle?: string;
  readonly previousRetiredTitle?: string;
  readonly updatedAtUnixMs: number;
  /** Immutable thread/start registries already materialized by this reconciler. */
  readonly registryThreads?: Readonly<Record<string, string>>;
}

export interface OmniCodexBridgeReconcileResult {
  readonly threadId: string;
  readonly registryDigest: string;
  readonly disposition: "current" | "created" | "replaced" | "deferred_active_owner";
}

export interface OmniCodexBridgeBootstrap {
  readonly client: AppServerRpcClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OmniCodexBridgeThreadLifecycle {
  setTitle(threadId: string, title: string): Promise<void>;
  setArchived(threadId: string, archived: boolean): Promise<void>;
}

export interface OmniCodexBridgeReconcilerOptions {
  readonly candidate: RuntimeCandidate;
  readonly dynamicTools: readonly Record<string, unknown>[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDirectory?: string;
  readonly now?: () => number;
  /** Optional caller deadline applied to every App Server request in this reconciliation. */
  readonly requestTimeoutMs?: number;
  /** Optional caller deadline for waiting until a materialized Bridge enters thread/list. */
  readonly inventoryWaitTimeoutMs?: number;
  readonly bootstrapFactory?: () => OmniCodexBridgeBootstrap;
  readonly threadLifecycle?: OmniCodexBridgeThreadLifecycle;
  readonly materializeCandidate?: (
    client: AppServerRpcClient,
    threadId: string,
    resumeRequired: boolean,
  ) => Promise<void>;
  readonly ownerInspector?: {
    findThreadOwner(
      threadId: string,
      options?: { readonly hostId?: string; readonly timeoutMs?: number },
    ): Promise<string | null>;
  };
  readonly ownershipRegistry?: CodexAppServerOwnershipRegistry;
}

type BridgeInventory = AppServerThreadInventory;

interface BridgePromotionContext {
  /** The candidate writer belongs to the bootstrap executing this promotion. */
  readonly candidateCreatedByThisBootstrap?: boolean;
  /** A recovered candidate that thread/read could resolve outside thread/list. */
  readonly knownCandidate?: Record<string, unknown>;
}

/**
 * Reconciles one canonical Bridge without ever resuming it in the long-lived
 * gateway transport. The bootstrap transport is closed before returning.
 */
export class OmniCodexBridgeReconciler {
  readonly #options: OmniCodexBridgeReconcilerOptions;
  readonly #dataDirectory: string;
  readonly #manifestPath: string;
  readonly #lockPath: string;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number | undefined;
  readonly #inventoryWaitTimeoutMs: number | undefined;

  constructor(options: OmniCodexBridgeReconcilerOptions) {
    this.#options = options;
    this.#dataDirectory = resolve(
      options.dataDirectory ?? omniCodexDataDirectory({ ...process.env, ...(options.env ?? {}) }),
    );
    this.#manifestPath = join(this.#dataDirectory, "bridge", "manifest.json");
    this.#lockPath = join(this.#dataDirectory, "bridge", "reconcile.lock");
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = optionalPositiveSafeInteger(
      options.requestTimeoutMs,
      "requestTimeoutMs",
    );
    this.#inventoryWaitTimeoutMs = optionalPositiveSafeInteger(
      options.inventoryWaitTimeoutMs,
      "inventoryWaitTimeoutMs",
    );
  }

  async reconcile(): Promise<OmniCodexBridgeReconcileResult> {
    const lease = await acquireOmniCodexBridgeDirectoryLease(this.#lockPath, { now: this.#now });
    const bootstrap = this.#options.bootstrapFactory?.() ?? this.#createBootstrap();
    try {
      await bootstrap.start();
      await lease.assertOwned();
      const client = clientWithRequestTimeout(bootstrap.client, this.#requestTimeoutMs);
      const result = await this.#reconcileWithClient(client, lease);
      if (result.disposition !== "deferred_active_owner") {
        await this.#archiveStaleStages(client, result.threadId, lease);
      }
      return result;
    } finally {
      try {
        await bootstrap.stop();
      } finally {
        await lease.release();
      }
    }
  }

  #createBootstrap(): OmniCodexBridgeBootstrap {
    return new CodexAppServerConnection(this.#options.candidate, {
      env: this.#options.env ?? {},
      ...(this.#options.ownershipRegistry === undefined
        ? {}
        : { ownershipRegistry: this.#options.ownershipRegistry }),
      configOverrides: ["features.code_mode_host=true"],
      ...(this.#requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#requestTimeoutMs }),
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
    });
  }

  async #reconcileWithClient(
    client: AppServerRpcClient,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<OmniCodexBridgeReconcileResult> {
    const digest = omniCodexBridgeRegistryDigest(this.#options.dynamicTools);
    let manifest = await readOptionalManifest(this.#manifestPath);
    let inventory = await listBridgeInventory(client);
    assertAtMostOneExactActive(inventory);

    const exact = exactActiveThreads(inventory)[0];
    if (
      exact !== undefined &&
      manifest?.phase === "stable" &&
      manifest.desiredRegistryDigest === digest &&
      manifest.activeThreadId === threadId(exact)
    ) {
      return { threadId: threadId(exact), registryDigest: digest, disposition: "current" };
    }

    // Finish every interrupted transaction before considering the current
    // digest. Otherwise an update that changes the registry can strand the
    // previous staged candidate and create a second active Bridge.
    if (manifest !== undefined && manifest.phase !== "stable") {
      const interruptedDigest = manifest.desiredRegistryDigest;
      const recovered = await this.#recover(client, manifest, inventory, lease);
      if (recovered?.disposition === "deferred_active_owner") return recovered;
      if (recovered !== undefined && interruptedDigest === digest) return recovered;
      inventory = await listBridgeInventory(client);
      assertAtMostOneExactActive(inventory);
      manifest = await readOptionalManifest(this.#manifestPath);
    }

    const previous = exactActiveThreads(inventory)[0];
    const registryThreads = rememberedRegistryThreads(manifest);
    if (manifest?.registryThreads === undefined) {
      // Older manifests remembered only the most recently activated registry.
      // Recover their immutable registry index once, otherwise the first
      // return to every already archived registry creates another duplicate.
      // Inventory is newest first, so retain the newest surviving equivalent.
      for (const thread of inventory.archived) {
        if (!isExactBridge(thread)) continue;
        const persistedDigest = await persistedBridgeRegistryDigest(thread);
        if (persistedDigest !== undefined && registryThreads[persistedDigest] === undefined) {
          registryThreads[persistedDigest] = threadId(thread);
        }
      }
    }
    if (previous !== undefined) {
      const persistedDigest = await persistedBridgeRegistryDigest(previous);
      if (persistedDigest !== undefined) registryThreads[persistedDigest] = threadId(previous);
      if (persistedDigest === digest) {
        await lease.assertOwned();
        await atomicManifestWrite(this.#manifestPath, {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          phase: "stable",
          desiredRegistryDigest: digest,
          activeThreadId: threadId(previous),
          registryThreads,
          updatedAtUnixMs: this.#now(),
        });
        return { threadId: threadId(previous), registryDigest: digest, disposition: "current" };
      }
    }
    if (
      previous !== undefined &&
      ((await this.#isDesktopOwned(threadId(previous))) || isThreadRecordActive(previous))
    ) {
      return {
        threadId: threadId(previous),
        registryDigest: digest,
        disposition: "deferred_active_owner",
      };
    }

    const cachedThread = findThread(inventory, registryThreads[digest]);
    if (
      cachedThread !== undefined &&
      isArchivedThread(cachedThread) &&
      isExactBridge(cachedThread) &&
      (isThreadRecordActive(cachedThread) || (await this.#isDesktopOwned(threadId(cachedThread))))
    ) {
      // Starting a duplicate would grow the archive whenever an otherwise
      // reusable registry is temporarily owned by a desktop task.
      return {
        threadId: threadId(previous ?? cachedThread),
        registryDigest: digest,
        disposition: "deferred_active_owner",
      };
    }
    const reusableThread =
      cachedThread !== undefined &&
      threadId(cachedThread) !== (previous === undefined ? undefined : threadId(previous)) &&
      isArchivedThread(cachedThread) &&
      isExactBridge(cachedThread)
        ? cachedThread
        : undefined;
    const recoverableStages = [...inventory.active, ...inventory.archived].filter((thread) =>
      threadTitle(thread).startsWith(stagedTitlePrefix(digest)),
    );
    if (recoverableStages.length > 1) {
      throw new Error("Multiple staged Bridges match the desired registry; refusing mutation");
    }
    const recoverableStage = reusableThread ?? recoverableStages[0];
    if (recoverableStage !== undefined) {
      manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        phase: "staged",
        desiredRegistryDigest: digest,
        ...(previous === undefined ? {} : { previousThreadId: threadId(previous) }),
        ...(previous === undefined
          ? {}
          : { previousRetiredTitle: retiredTitle(threadId(previous), digest) }),
        candidateThreadId: threadId(recoverableStage),
        candidateTitle:
          reusableThread === undefined ? threadTitle(recoverableStage) : stagedTitle(digest),
        registryThreads,
        updatedAtUnixMs: this.#now(),
      };
      await lease.assertOwned();
      await atomicManifestWrite(this.#manifestPath, manifest);
      return this.#promote(
        client,
        manifest,
        previous === undefined ? "created" : "replaced",
        lease,
      );
    }

    const candidateTitle = stagedTitle(digest);
    await lease.assertOwned();
    const created = await client.request<unknown>("thread/start", {
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { features: { code_mode_host: true } },
      dynamicTools: this.#options.dynamicTools,
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
    });
    const candidateThreadId = startedThreadId(created);
    manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      phase: "candidate_started",
      desiredRegistryDigest: digest,
      ...(previous === undefined ? {} : { previousThreadId: threadId(previous) }),
      ...(previous === undefined
        ? {}
        : { previousRetiredTitle: retiredTitle(threadId(previous), digest) }),
      candidateThreadId,
      candidateTitle,
      registryThreads,
      updatedAtUnixMs: this.#now(),
    };
    // Journal the returned identity before materialization can create a
    // durable but unnamed rollout. A process exit during goal/set must not
    // strand that candidate and create another on the next startup.
    await lease.assertOwned();
    await atomicManifestWrite(this.#manifestPath, manifest);
    try {
      // Materialize the source rollout before naming the candidate. Newer App
      // Servers persist paginated thread/start metadata before the source
      // rollout exists; naming that row first makes thread/list reject the
      // entire inventory with a missing-lineage error.
      await this.#materializeCandidate(client, candidateThreadId, false, lease);
      // Also give the durable candidate an inventory-discoverable identity so
      // it remains recoverable if the manifest itself is later lost.
      await lease.assertOwned();
      await client.request("thread/name/set", {
        threadId: candidateThreadId,
        name: candidateTitle,
      });
    } catch (stageError) {
      // If staging itself fails, preserve the returned id in the manifest so a
      // later bootstrap can recover it through thread/read.
      await lease.assertOwned();
      await atomicManifestWrite(this.#manifestPath, manifest).catch((manifestError: unknown) => {
        throw new AggregateError(
          [stageError, manifestError],
          `Bridge candidate ${candidateThreadId} could not be staged or journaled`,
        );
      });
      throw stageError;
    }
    await lease.assertOwned();
    await atomicManifestWrite(this.#manifestPath, manifest);

    return this.#promote(client, manifest, previous === undefined ? "created" : "replaced", lease, {
      candidateCreatedByThisBootstrap: true,
      knownCandidate: { id: candidateThreadId },
    });
  }

  async #isDesktopOwned(threadIdValue: string): Promise<boolean> {
    if (this.#options.ownerInspector === undefined) return false;
    return (
      (await this.#options.ownerInspector.findThreadOwner(threadIdValue, {
        hostId: "local",
        ...(this.#requestTimeoutMs === undefined ? {} : { timeoutMs: this.#requestTimeoutMs }),
      })) !== null
    );
  }

  async #archiveStaleStages(
    client: AppServerRpcClient,
    canonicalThreadId: string,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<void> {
    const inventory = await listBridgeInventory(client);
    const archivedIds: string[] = [];
    for (const thread of inventory.active) {
      const id = threadId(thread);
      if (
        id === canonicalThreadId ||
        !/^\[OmniCodex\] Bridge staging [a-f0-9]{32} [a-f0-9]{8}$/u.test(threadTitle(thread)) ||
        !isStaleStage(thread, this.#now()) ||
        isThreadRecordActive(thread) ||
        (await this.#isDesktopOwned(id))
      )
        continue;
      await this.#setArchived(client, id, true, lease);
      archivedIds.push(id);
    }
    if (archivedIds.length === 0) return;
    const confirmed = await listBridgeInventory(client);
    for (const id of archivedIds) {
      const thread = findThread(confirmed, id);
      if (thread === undefined || !isArchivedThread(thread)) {
        throw new Error(`Stale Bridge staging archive was not authoritatively confirmed: ${id}`);
      }
    }
  }

  async #recover(
    client: AppServerRpcClient,
    manifest: OmniCodexBridgeManifest,
    inventory: BridgeInventory,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<OmniCodexBridgeReconcileResult | undefined> {
    if (manifest.phase === "stable") return undefined;
    const candidateId = manifest.candidateThreadId;
    if (candidateId === undefined) return undefined;
    const previous = findThread(inventory, manifest.previousThreadId);
    const listedCandidate = findThread(inventory, candidateId);
    const candidate = listedCandidate ?? (await readOptionalThread(client, candidateId));
    if (candidate === undefined) {
      if (manifest.phase === "candidate_started") return undefined;
      throw new Error(
        `Persisted ${manifest.phase} Bridge candidate ${candidateId} is unavailable; refusing a duplicate`,
      );
    }
    if (previous !== undefined && !isArchivedThread(previous)) {
      if ((await this.#isDesktopOwned(threadId(previous))) || isThreadRecordActive(previous)) {
        return {
          threadId: threadId(previous),
          registryDigest: manifest.desiredRegistryDigest,
          disposition: "deferred_active_owner",
        };
      }
    }
    return this.#promote(
      client,
      manifest,
      manifest.previousThreadId === undefined ? "created" : "replaced",
      lease,
      { knownCandidate: candidate },
    );
  }

  async #promote(
    client: AppServerRpcClient,
    manifest: OmniCodexBridgeManifest,
    disposition: "created" | "replaced",
    lease: OmniCodexBridgeDirectoryLease,
    context: BridgePromotionContext = {},
  ): Promise<OmniCodexBridgeReconcileResult> {
    const candidateId = requiredManifestValue(manifest.candidateThreadId, "candidateThreadId");
    const candidateTitle = requiredManifestValue(manifest.candidateTitle, "candidateTitle");
    const previousId = manifest.previousThreadId;
    let initialInventory = await listBridgeInventory(client);
    assertAtMostOneExactActive(initialInventory);
    let actualCandidate =
      findThread(initialInventory, candidateId) ??
      (context.knownCandidate !== undefined && threadId(context.knownCandidate) === candidateId
        ? context.knownCandidate
        : undefined);
    if (actualCandidate === undefined && context.candidateCreatedByThisBootstrap === true) {
      actualCandidate = await readRequiredThread(client, candidateId);
    }
    if (actualCandidate === undefined) throw new Error("Staged Bridge is missing during promotion");
    if (findThread(initialInventory, candidateId) === undefined) {
      if (!hasDurableTurns(actualCandidate)) {
        await this.#materializeCandidate(
          client,
          candidateId,
          context.candidateCreatedByThisBootstrap !== true,
          lease,
        );
      }
      initialInventory = await waitForListedBridge(
        client,
        candidateId,
        this.#inventoryWaitTimeoutMs,
      );
      actualCandidate = findThread(initialInventory, candidateId);
      if (actualCandidate === undefined) {
        throw new Error("Materialized Bridge did not enter the authoritative inventory");
      }
    }
    const actualPrevious = findThread(initialInventory, previousId);
    if (previousId !== undefined && actualPrevious === undefined) {
      throw new Error("Previous Bridge is missing during promotion");
    }
    let previousArchived = actualPrevious === undefined || isArchivedThread(actualPrevious);
    let candidateArchived = isArchivedThread(actualCandidate);
    let candidatePromoted = isExactBridge(actualCandidate) && !candidateArchived;
    const setCandidateTitle = async (title: string): Promise<void> => {
      await lease.assertOwned();
      if (context.candidateCreatedByThisBootstrap === true) {
        await client.request("thread/name/set", { threadId: candidateId, name: title });
        return;
      }
      await this.#setTitle(client, candidateId, title, lease);
    };
    const setCandidateArchived = async (archived: boolean): Promise<void> => {
      await lease.assertOwned();
      if (context.candidateCreatedByThisBootstrap === true) {
        await client.request(archived ? "thread/archive" : "thread/unarchive", {
          threadId: candidateId,
        });
        return;
      }
      await this.#setArchived(client, candidateId, archived, lease);
    };

    try {
      if (
        manifest.phase === "candidate_started" &&
        !candidatePromoted &&
        threadTitle(actualCandidate) !== candidateTitle
      ) {
        // A newly started empty thread is not guaranteed to appear in thread/list
        // until its first durable mutation. Only the creating bootstrap may use
        // its in-memory writer; recovery uses the app-global lifecycle surface.
        await setCandidateTitle(candidateTitle);
        actualCandidate = { ...actualCandidate, name: candidateTitle };
      }
      if (manifest.phase === "candidate_started" && !candidatePromoted) {
        manifest = transitionManifest(manifest, "staged", this.#now());
        await lease.assertOwned();
        await atomicManifestWrite(this.#manifestPath, manifest);
      }
      // First make the candidate identifiable by its persisted staged title.
      // No previous Bridge mutation occurs before this succeeds.
      if (candidateArchived && !isExactBridge(actualCandidate)) {
        await setCandidateArchived(false);
        candidateArchived = false;
      }
      if (!isExactBridge(actualCandidate) && threadTitle(actualCandidate) !== candidateTitle) {
        await setCandidateTitle(candidateTitle);
      }
      if (previousId !== undefined && !previousArchived && actualPrevious !== undefined) {
        // Desktop ownership is authoritative even when App Server reports idle.
        if ((await this.#isDesktopOwned(previousId)) || isThreadRecordActive(actualPrevious)) {
          return {
            threadId: previousId,
            registryDigest: manifest.desiredRegistryDigest,
            disposition: "deferred_active_owner",
          };
        }
        await this.#setArchived(client, previousId, true, lease);
        previousArchived = true;
        manifest = transitionManifest(manifest, "old_archived", this.#now());
      }

      // Archived state-only threads are inert history, not active Bridge
      // owners. The installed app has an official archive fallback for these
      // records but no public title fallback when their rollout is absent, so
      // canonical uniqueness is intentionally an active-inventory invariant.

      if (!candidatePromoted) {
        if (candidateArchived) {
          await setCandidateArchived(false);
          candidateArchived = false;
        }
        if (!isExactBridge(actualCandidate)) {
          await setCandidateTitle(OMNICODEX_BRIDGE_THREAD_TITLE);
        }
        candidatePromoted = true;
        manifest = transitionManifest(manifest, "candidate_promoted", this.#now());
        await lease.assertOwned();
        await atomicManifestWrite(this.#manifestPath, manifest);
      }

      const inventory = await listBridgeInventory(client);
      assertAtMostOneExactActive(inventory);
      const exact = exactActiveThreads(inventory)[0];
      if (exact === undefined || threadId(exact) !== candidateId) {
        throw new Error("Promoted Bridge was not the sole exact active Bridge");
      }
      if (previousId !== undefined) {
        const finalPrevious = findThread(inventory, previousId);
        if (finalPrevious === undefined || !isArchivedThread(finalPrevious)) {
          throw new Error("Previous Bridge archive was not authoritatively confirmed");
        }
      }
      const stable = stableManifest(manifest, candidateId, this.#now());
      await lease.assertOwned();
      await atomicManifestWrite(this.#manifestPath, stable);
      return { threadId: candidateId, registryDigest: manifest.desiredRegistryDigest, disposition };
    } catch (error) {
      // A dispatched native mutation can commit after its response channel
      // times out or disconnects. Never race that late commit with an inverse
      // mutation. First accept an authoritatively observed completed
      // promotion; otherwise leave the journal interrupted for the next
      // reconciliation to resume without compensation.
      if (isUnknownMutationOutcome(error)) {
        const committed = await readCommittedPromotion(client, candidateId, previousId).catch(
          () => false,
        );
        if (committed) {
          const stable = stableManifest(manifest, candidateId, this.#now());
          await lease.assertOwned();
          await atomicManifestWrite(this.#manifestPath, stable);
          return {
            threadId: candidateId,
            registryDigest: manifest.desiredRegistryDigest,
            disposition,
          };
        }
        throw error;
      }
      // Preserve the previous exact Bridge whenever a promotion cannot commit.
      let candidateIsExact = candidatePromoted;
      const rollbackInventory = await listBridgeInventory(client).catch(() => undefined);
      if (!candidateIsExact) {
        candidateIsExact =
          rollbackInventory === undefined ||
          exactActiveThreads(rollbackInventory).some((thread) => threadId(thread) === candidateId);
      }
      let candidateDemoted = !candidateIsExact;
      if (candidateIsExact) {
        candidateDemoted = await setCandidateTitle(candidateTitle).then(
          () => true,
          () => false,
        );
      }
      // Never unarchive the previous exact title while the candidate might
      // still have that title: preserving both records must not create two
      // exact active Bridges.
      if (previousId !== undefined && candidateDemoted) {
        const rollbackPrevious =
          rollbackInventory === undefined ? undefined : findThread(rollbackInventory, previousId);
        const previousMayBeArchived =
          previousArchived || rollbackPrevious === undefined || isArchivedThread(rollbackPrevious);
        const previousWasCanonical = actualPrevious !== undefined && isExactBridge(actualPrevious);
        const restoredCanonical = previousWasCanonical
          ? true
          : await this.#setTitle(client, previousId, OMNICODEX_BRIDGE_THREAD_TITLE, lease).then(
              () => true,
              () => false,
            );
        if (restoredCanonical && previousMayBeArchived) {
          await this.#setArchived(client, previousId, false, lease).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async #setTitle(
    client: AppServerRpcClient,
    threadId: string,
    title: string,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<void> {
    await lease.assertOwned();
    if (this.#options.threadLifecycle !== undefined) {
      await this.#options.threadLifecycle.setTitle(threadId, title);
      return;
    }
    await client.request("thread/name/set", { threadId, name: title });
  }

  async #materializeCandidate(
    client: AppServerRpcClient,
    threadId: string,
    resumeRequired: boolean,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<void> {
    await lease.assertOwned();
    if (this.#options.materializeCandidate !== undefined) {
      await this.#options.materializeCandidate(client, threadId, resumeRequired);
      return;
    }
    if (resumeRequired) {
      await client.request("thread/resume", {
        threadId,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        excludeTurns: true,
      });
    }
    // `thread/list` intentionally excludes rows whose persisted preview is
    // empty. Raw Responses items appended with `thread/inject_items` do not
    // update that preview, so they can never make a newly started Bridge
    // discoverable. A completed goal update is the installed App Server's
    // model-free metadata event that both materializes the preview and remains
    // inert: it cannot start an automatic continuation. Clear the transient
    // goal immediately; the preview is durable while the dedicated Bridge is
    // left without an application goal.
    await client.request("thread/goal/set", {
      threadId,
      objective: "OmniCodex native bridge registry",
      status: "complete",
    });
    await client.request("thread/goal/clear", { threadId });
    // The caller performs an authoritative thread/list readback before
    // promotion. An acknowledgement from this mutation alone is never enough.
  }

  async #setArchived(
    client: AppServerRpcClient,
    threadId: string,
    archived: boolean,
    lease: OmniCodexBridgeDirectoryLease,
  ): Promise<void> {
    await lease.assertOwned();
    if (this.#options.threadLifecycle !== undefined) {
      await this.#options.threadLifecycle.setArchived(threadId, archived);
      return;
    }
    await client.request(archived ? "thread/archive" : "thread/unarchive", { threadId });
  }
}

async function readCommittedPromotion(
  client: AppServerRpcClient,
  candidateId: string,
  previousId: string | undefined,
): Promise<boolean> {
  const inventory = await listBridgeInventory(client);
  const exact = exactActiveThreads(inventory);
  if (exact.length !== 1 || threadId(exact[0] as Record<string, unknown>) !== candidateId) {
    return false;
  }
  if (previousId === undefined) return true;
  const previous = findThread(inventory, previousId);
  return previous !== undefined && isArchivedThread(previous);
}

function isUnknownMutationOutcome(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (error.name === "NativePipeTransportError" && error.dispatched === true) return true;
  const message = typeof error.message === "string" ? error.message : "";
  return /\bunknown outcome\b|\btimed out\b|\bconnection (?:closed|lost|reset)\b/iu.test(message);
}

/** Stable across object-key and registry/tool ordering differences. */
export function omniCodexBridgeRegistryDigest(
  dynamicTools: readonly Record<string, unknown>[],
): string {
  const registry = dynamicTools.map(normalizeRegistryEntry).sort(compareNamedValues);
  return createHash("sha256").update(canonicalJson(registry), "utf8").digest("hex");
}

async function listBridgeInventory(client: AppServerRpcClient): Promise<BridgeInventory> {
  return readAppServerThreadInventory(client);
}

function assertAtMostOneExactActive(inventory: BridgeInventory): void {
  if (exactActiveThreads(inventory).length > 1) {
    throw new Error("Multiple exact active [OmniCodex] Bridge threads exist; refusing mutation");
  }
}

function exactActiveThreads(inventory: BridgeInventory): readonly Record<string, unknown>[] {
  return inventory.active.filter(isExactBridge);
}

function isThreadRecordActive(thread: Record<string, unknown>): boolean {
  const status = thread.status;
  return status === "active" || (isObject(status) && status.type === "active");
}

async function readRequiredThread(
  client: AppServerRpcClient,
  threadIdValue: string,
): Promise<Record<string, unknown>> {
  const response = await client.request<unknown>("thread/read", {
    threadId: threadIdValue,
    includeTurns: true,
  });
  const thread = isObject(response) && isObject(response.thread) ? response.thread : undefined;
  if (thread === undefined) throw new Error(`Bridge thread/read omitted ${threadIdValue}`);
  return typeof thread.id === "string" ? thread : { ...thread, id: threadIdValue };
}

function hasDurableTurns(thread: Record<string, unknown>): boolean {
  return Array.isArray(thread.turns) && thread.turns.length > 0;
}

async function waitForListedBridge(
  client: AppServerRpcClient,
  threadIdValue: string,
  timeoutMs: number | undefined,
): Promise<BridgeInventory> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let inventory = await listBridgeInventory(client);
  while (
    findThread(inventory, threadIdValue) === undefined &&
    (deadline === undefined || Date.now() < deadline)
  ) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    inventory = await listBridgeInventory(client);
  }
  return inventory;
}

function clientWithRequestTimeout(
  client: AppServerRpcClient,
  requestTimeoutMs: number | undefined,
): AppServerRpcClient {
  if (requestTimeoutMs === undefined) return client;
  const subscribeNotifications = client.subscribeNotifications?.bind(client);
  return {
    request: <T>(method: string, params: unknown, timeoutMs?: number) =>
      client.request<T>(method, params, timeoutMs ?? requestTimeoutMs),
    ...(subscribeNotifications === undefined ? {} : { subscribeNotifications }),
  };
}

function optionalPositiveSafeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

async function readOptionalThread(
  client: AppServerRpcClient,
  threadIdValue: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readRequiredThread(client, threadIdValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /\b(?:thread\s+)?not[ _-]?(?:found|loaded)\b|\bunknown thread\b|\bno rollout found for thread id\b|\binvalid paginated history lineage\b.*\bmissing source rollout\b/i.test(
        message,
      )
    ) {
      return undefined;
    }
    throw error;
  }
}

function isExactBridge(value: Record<string, unknown>): boolean {
  return threadTitle(value) === OMNICODEX_BRIDGE_THREAD_TITLE;
}

function threadTitle(value: Record<string, unknown>): string {
  if (typeof value.name === "string") return value.name;
  return typeof value.title === "string" ? value.title : "";
}

function threadId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Bridge inventory item is missing its thread id");
  }
  return value.id;
}

function isArchivedThread(value: Record<string, unknown>): boolean {
  return value.archived === true;
}

function findThread(
  inventory: BridgeInventory,
  id: string | undefined,
): Record<string, unknown> | undefined {
  if (id === undefined) return undefined;
  return [...inventory.active, ...inventory.archived].find((thread) => threadId(thread) === id);
}

function stagedTitle(digest: string): string {
  return `${stagedTitlePrefix(digest)}${randomUUID().slice(0, 8)}`;
}

function stagedTitlePrefix(digest: string): string {
  return `[OmniCodex] Bridge staging ${digest.slice(0, 32)} `;
}

function retiredTitle(previousThreadId: string, digest: string): string {
  return `[OmniCodex] Bridge retired ${digest.slice(0, 24)} ${previousThreadId.slice(-12)}`;
}

function startedThreadId(value: unknown): string {
  const id =
    isObject(value) && isObject(value.thread) && typeof value.thread.id === "string"
      ? value.thread.id
      : undefined;
  if (id === undefined || id.length === 0) {
    throw new Error("Staged Bridge creation did not return a thread id");
  }
  return id;
}

function stableManifest(
  source: OmniCodexBridgeManifest,
  activeThreadId: string,
  now: number,
): OmniCodexBridgeManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    phase: "stable",
    desiredRegistryDigest: source.desiredRegistryDigest,
    activeThreadId,
    registryThreads: {
      ...rememberedRegistryThreads(source),
      [source.desiredRegistryDigest]: activeThreadId,
    },
    updatedAtUnixMs: now,
  };
}

function transitionManifest(
  source: OmniCodexBridgeManifest,
  phase: BridgePhase,
  now: number,
): OmniCodexBridgeManifest {
  return { ...source, phase, updatedAtUnixMs: now };
}

async function readOptionalManifest(path: string): Promise<OmniCodexBridgeManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateManifest(value);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function validateManifest(value: unknown): OmniCodexBridgeManifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !isBridgePhase(value.phase) ||
    typeof value.desiredRegistryDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.desiredRegistryDigest) ||
    typeof value.updatedAtUnixMs !== "number"
  ) {
    throw new Error("Invalid OmniCodex Bridge manifest");
  }
  for (const key of [
    "activeThreadId",
    "previousThreadId",
    "candidateThreadId",
    "candidateTitle",
    "previousRetiredTitle",
  ]) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "string" || field.length === 0)) {
      throw new Error("Invalid OmniCodex Bridge manifest");
    }
  }
  if (
    value.registryThreads !== undefined &&
    (!isObject(value.registryThreads) ||
      Object.entries(value.registryThreads).some(
        ([digest, id]) =>
          !/^[a-f0-9]{64}$/u.test(digest) || typeof id !== "string" || id.length === 0,
      ))
  ) {
    throw new Error("Invalid OmniCodex Bridge registry index");
  }
  return value as unknown as OmniCodexBridgeManifest;
}

function rememberedRegistryThreads(
  manifest: OmniCodexBridgeManifest | undefined,
): Record<string, string> {
  return {
    ...manifest?.registryThreads,
    ...(manifest?.phase === "stable" && manifest.activeThreadId !== undefined
      ? { [manifest.desiredRegistryDigest]: manifest.activeThreadId }
      : {}),
  };
}

async function persistedBridgeRegistryDigest(
  thread: Record<string, unknown>,
): Promise<string | undefined> {
  if (typeof thread.path !== "string" || thread.path.length === 0) return undefined;
  const stream = createReadStream(thread.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const entry: unknown = JSON.parse(line);
      if (!isObject(entry) || entry.type !== "session_meta" || !isObject(entry.payload)) {
        return undefined;
      }
      const metadata = entry.payload;
      if (metadata.id !== threadId(thread) || !Array.isArray(metadata.dynamic_tools))
        return undefined;
      if (!metadata.dynamic_tools.every(isObject))
        throw new Error("Invalid persisted Bridge registry");
      return omniCodexBridgeRegistryDigest(metadata.dynamic_tools);
    }
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function isStaleStage(thread: Record<string, unknown>, now: number): boolean {
  // App Server timestamps are Unix seconds. Unknown ages are never reclaimed.
  const updatedAt = thread.updatedAt;
  return (
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    now - updatedAt * 1_000 >= STALE_STAGING_AGE_MS
  );
}

async function atomicManifestWrite(path: string, manifest: OmniCodexBridgeManifest): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, absolute);
}

function normalizeRegistryEntry(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeJson(value) as Record<string, unknown>;
  // Codex omits false deferLoading when persisting a function registry. Apply
  // that protocol default symmetrically to comparisons only. The registered
  // definitions, descriptions and schemas remain exactly as supplied.
  if (normalized.type === "function" && normalized.deferLoading === undefined) {
    normalized.deferLoading = false;
  }
  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools
      .map((tool) => (isObject(tool) ? normalizeRegistryEntry(tool) : tool))
      .sort(compareNamedValues);
  }
  return normalized;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function compareNamedValues(left: unknown, right: unknown): number {
  const leftName =
    isObject(left) && typeof left.name === "string" ? left.name : canonicalJson(left);
  const rightName =
    isObject(right) && typeof right.name === "string" ? right.name : canonicalJson(right);
  return leftName.localeCompare(rightName, "en-US");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function requiredManifestValue(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Bridge manifest is missing ${name}`);
  return value;
}

function isBridgePhase(value: unknown): value is BridgePhase {
  return (
    value === "stable" ||
    value === "candidate_started" ||
    value === "staged" ||
    value === "old_archived" ||
    value === "old_retired" ||
    value === "candidate_promoted"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
