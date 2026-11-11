import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { PolicyDocumentationService } from "../../application/policy-documentation-service.js";
import { protectedDocumentationResponse } from "../../application/protected-documentation-response.js";

type Send = (line: string) => void;

interface OmniClient {
  readonly send: Send;
  initialized: boolean;
}

interface OwnershipClaim {
  readonly previousOwnerPresent: boolean;
  readonly previousOwner: number | undefined;
  readonly previousClaim: OwnershipClaim | undefined;
  status: "pending" | "failed" | "committed";
}

interface PendingCall {
  readonly clientId: number;
  readonly originalId: string | number;
  readonly method: string;
  readonly threadId: string | undefined;
  readonly ephemeral: boolean;
  readonly ownershipClaim: OwnershipClaim | undefined;
}

interface PendingServerRequest {
  readonly clientId: number | undefined;
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly line: string;
}

interface PendingDesktopThreadTransition {
  readonly method: "thread/resume" | "turn/start";
  readonly threadId: string;
}

/** Multiplexes independent clients over the primary native stdio connection. */
export class StdioAppServerRouter {
  readonly #sendServer: Send;
  readonly #sendDesktop: Send;
  readonly #policyDocumentation: PolicyDocumentationService;
  readonly #ownerKey: string;
  readonly #clients = new Map<number, OmniClient>();
  readonly #pendingCalls = new Map<string, PendingCall>();
  readonly #pendingServerRequests = new Map<string, PendingServerRequest>();
  readonly #pendingDesktopThreadTransitions = new Map<string, PendingDesktopThreadTransition>();
  readonly #threadOwners = new Map<string, number | undefined>();
  readonly #ownershipClaims = new Map<string, OwnershipClaim>();
  readonly #desktopTurnOwners = new Map<string, Set<string>>();
  readonly #ephemeralThreadOwners = new Map<string, number>();
  #nextClientId = 1;
  #nextCallId = 1;
  #desktopInitializeId: string | number | undefined;
  #desktopInitializeResult: Record<string, unknown> | undefined;

  constructor(options: {
    readonly sendServer: Send;
    readonly sendDesktop: Send;
    readonly policyDocumentation: PolicyDocumentationService;
    readonly ownerKey: string;
  }) {
    this.#sendServer = options.sendServer;
    this.#sendDesktop = options.sendDesktop;
    this.#policyDocumentation = options.policyDocumentation;
    this.#ownerKey = options.ownerKey;
  }

  get ready(): boolean {
    return this.#desktopInitializeResult !== undefined;
  }

  addClient(send: Send): number {
    const id = this.#nextClientId++;
    this.#clients.set(id, { send, initialized: false });
    return id;
  }

  removeClient(id: number): void {
    this.#clients.delete(id);
    for (const [threadId, owner] of this.#threadOwners) {
      if (owner === id) {
        this.#threadOwners.set(threadId, undefined);
        this.#ownershipClaims.delete(threadId);
      }
    }
    for (const [requestId, request] of this.#pendingServerRequests) {
      if (request.clientId === id) {
        this.#pendingServerRequests.set(requestId, { ...request, clientId: undefined });
      }
    }
    for (const [requestId, request] of this.#pendingCalls) {
      if (request.clientId === id) this.#pendingCalls.delete(requestId);
    }
  }

  receiveDesktop(line: string): void {
    const message = parseMessage(line);
    if (
      (message.method === "thread/resume" || message.method === "turn/start") &&
      isId(message.id)
    ) {
      const threadId = stringValue(objectValue(message.params)?.threadId);
      if (threadId !== undefined) {
        this.#pendingDesktopThreadTransitions.set(String(message.id), {
          method: message.method,
          threadId,
        });
      }
    }
    if (message.method === "initialize" && isId(message.id)) {
      this.#desktopInitializeId = message.id;
    }
    if (message.method === undefined && isId(message.id)) {
      const owner = this.#pendingServerRequests.get(String(message.id));
      if (owner !== undefined) {
        // Only the OmniCodex connection that received the request may answer it.
        return;
      }
    }
    this.#sendServer(line);
  }

  receiveClient(clientId: number, line: string): void {
    const client = this.#clients.get(clientId);
    if (client === undefined) return;
    const message = parseMessage(line);
    if (!client.initialized) {
      if (message.method !== "initialize" || !isId(message.id))
        throw new Error("OmniCodex client must initialize first");
      const params = objectValue(message.params);
      const clientInfo = objectValue(params?.clientInfo);
      const capabilities = objectValue(params?.capabilities);
      const extensions = objectValue(capabilities?.extensions);
      if (
        (clientInfo?.name !== "omnicodex" && clientInfo?.name !== "codex-native") ||
        extensions?.["omnicodex/thread-owner-key"] !== this.#ownerKey
      ) {
        throw new Error("OmniCodex client identity is invalid");
      }
      if (this.#desktopInitializeResult === undefined)
        throw new Error("Desktop App Server is not initialized");
      client.initialized = true;
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: this.#desktopInitializeResult }),
      );
      return;
    }
    if (typeof message.method === "string") {
      if (
        message.method === "initialize" ||
        /^userVerification\/(?:enroll|delete|verify|cancel)$/u.test(message.method)
      ) {
        if (isId(message.id))
          client.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32600, message: "This method belongs to Codex Desktop" },
            }),
          );
        return;
      }
      if (!isId(message.id)) {
        if (message.method !== "initialized") this.#sendServer(line);
        return;
      }
      const params = objectValue(message.params);
      const threadId = stringValue(params?.threadId);
      if (message.method === "thread/unsubscribe") {
        const ownsEphemeralThread =
          threadId !== undefined &&
          this.#ephemeralThreadOwners.get(threadId) === clientId &&
          this.#threadOwners.get(threadId) === clientId;
        const hasPending =
          threadId !== undefined &&
          ([...this.#pendingDesktopThreadTransitions.values()].some(
            (request) => request.threadId === threadId,
          ) ||
            [...this.#pendingServerRequests.values()].some(
              (request) => request.threadId === threadId,
            ) ||
            [...this.#pendingCalls.values()].some((request) => request.threadId === threadId));
        if (ownsEphemeralThread && hasPending) {
          client.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "Cannot release an active ephemeral thread" },
            }),
          );
          return;
        }
        if (!ownsEphemeralThread) {
          // Desktop and OmniCodex share one connection; retain Desktop subscriptions.
          if (
            threadId !== undefined &&
            this.#threadOwners.get(threadId) === clientId &&
            !hasPending
          ) {
            this.#threadOwners.delete(threadId);
          }
          client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          return;
        }
      }
      const remappedId = `omni:${this.#ownerKey}:${clientId}:${this.#nextCallId++}`;
      let ownershipClaim: PendingCall["ownershipClaim"];
      if (threadId !== undefined && ["turn/start", "thread/resume"].includes(message.method)) {
        const previousOwnerPresent = this.#threadOwners.has(threadId);
        const previousOwner = this.#threadOwners.get(threadId);
        const previousClaim = this.#ownershipClaims.get(threadId);
        this.#claimThread(threadId, clientId);
        ownershipClaim = {
          previousOwnerPresent,
          previousOwner,
          previousClaim,
          status: "pending",
        };
        this.#ownershipClaims.set(threadId, ownershipClaim);
      }
      this.#pendingCalls.set(remappedId, {
        clientId,
        originalId: message.id,
        method: message.method,
        threadId,
        ephemeral: message.method === "thread/start" && params?.ephemeral === true,
        ownershipClaim,
      });
      this.#sendServer(JSON.stringify({ ...message, id: remappedId }));
      return;
    }
    if (isId(message.id)) {
      const request = this.#pendingServerRequests.get(String(message.id));
      if (request?.clientId !== clientId) return;
      this.#pendingServerRequests.delete(String(message.id));
      this.#sendServer(line);
    }
  }

  async receiveServer(line: string): Promise<void> {
    const message = parseMessage(line);
    if (message.method === undefined && isId(message.id)) {
      if (message.id === this.#desktopInitializeId) {
        const result = objectValue(message.result);
        if (result !== undefined) this.#desktopInitializeResult = result;
      }
      const pending = this.#pendingCalls.get(String(message.id));
      if (pending !== undefined) {
        this.#pendingCalls.delete(String(message.id));
        if (pending.threadId !== undefined && pending.ownershipClaim !== undefined) {
          this.#settleOwnershipClaim(
            pending.threadId,
            pending.clientId,
            pending.ownershipClaim,
            message.error === undefined,
          );
        }
        if (["thread/start", "thread/fork", "thread/resume"].includes(pending.method)) {
          const thread = objectValue(objectValue(message.result)?.thread);
          const threadId = stringValue(thread?.id);
          if (
            threadId !== undefined &&
            !(pending.method === "thread/resume" && threadId === pending.threadId)
          ) {
            this.#claimThread(threadId, pending.clientId);
            if (pending.ephemeral) this.#ephemeralThreadOwners.set(threadId, pending.clientId);
          }
        }
        if (
          pending.method === "thread/unsubscribe" &&
          pending.threadId !== undefined &&
          message.error === undefined
        ) {
          this.#ephemeralThreadOwners.delete(pending.threadId);
          if (this.#threadOwners.get(pending.threadId) === pending.clientId) {
            this.#threadOwners.delete(pending.threadId);
          }
        }
        this.#clients
          .get(pending.clientId)
          ?.send(JSON.stringify({ ...message, id: pending.originalId }));
        return;
      }
      const desktopTransition = this.#pendingDesktopThreadTransitions.get(String(message.id));
      if (desktopTransition !== undefined) {
        this.#pendingDesktopThreadTransitions.delete(String(message.id));
        this.#sendDesktop(line);
        if (message.error === undefined) {
          this.#ephemeralThreadOwners.delete(desktopTransition.threadId);
          const owner = this.#threadOwners.get(desktopTransition.threadId);
          if (this.#threadOwners.has(desktopTransition.threadId) && owner === undefined) {
            const turnId = desktopTurnId(desktopTransition.method, message.result);
            if (turnId !== undefined) {
              this.#giveTurnToDesktop(desktopTransition.threadId, turnId);
            }
          }
        }
        return;
      }
      this.#sendDesktop(line);
      return;
    }
    if (typeof message.method === "string" && isId(message.id)) {
      const protectedResponse = await protectedDocumentationResponse(
        message,
        this.#policyDocumentation,
      );
      if (protectedResponse !== undefined) {
        this.#sendServer(JSON.stringify(protectedResponse));
        return;
      }
      if (
        message.method === "mcpServer/elicitation/request" &&
        objectValue(message.params)?.mode === "openai/userVerification"
      ) {
        // Windows verification is owned by the Desktop GUI, even for an OmniCodex turn.
        this.#sendDesktop(line);
        return;
      }
      const threadId = stringValue(objectValue(message.params)?.threadId);
      const turnId = stringValue(objectValue(message.params)?.turnId);
      const clientId = threadId === undefined ? undefined : this.#threadOwners.get(threadId);
      const client = clientId === undefined ? undefined : this.#clients.get(clientId);
      if (
        threadId !== undefined &&
        turnId !== undefined &&
        this.#desktopTurnOwners.get(threadId)?.has(turnId)
      ) {
        this.#sendDesktop(line);
      } else if (client !== undefined && threadId !== undefined) {
        this.#pendingServerRequests.set(String(message.id), { clientId, threadId, turnId, line });
        client.send(line);
      } else if (threadId !== undefined && this.#threadOwners.has(threadId)) {
        this.#pendingServerRequests.set(String(message.id), { clientId, threadId, turnId, line });
      } else {
        this.#sendDesktop(line);
      }
      return;
    }
    const threadId = stringValue(objectValue(message.params)?.threadId);
    if (message.method === "turn/completed" && threadId !== undefined) {
      const turnId = stringValue(objectValue(objectValue(message.params)?.turn)?.id);
      const desktopTurns = this.#desktopTurnOwners.get(threadId);
      if (turnId !== undefined) desktopTurns?.delete(turnId);
      if (desktopTurns?.size === 0) this.#desktopTurnOwners.delete(threadId);
    }
    const clientId = threadId === undefined ? undefined : this.#threadOwners.get(threadId);
    const client = clientId === undefined ? undefined : this.#clients.get(clientId);
    if (threadId !== undefined && this.#threadOwners.has(threadId)) {
      client?.send(line);
      this.#sendDesktop(line);
    } else if (threadId === undefined) {
      this.#sendDesktop(line);
      for (const peer of this.#clients.values()) if (peer.initialized) peer.send(line);
    } else {
      this.#sendDesktop(line);
    }
  }

  #giveTurnToDesktop(threadId: string, turnId: string): void {
    const turns = this.#desktopTurnOwners.get(threadId) ?? new Set<string>();
    turns.add(turnId);
    this.#desktopTurnOwners.set(threadId, turns);
    for (const [id, request] of this.#pendingServerRequests) {
      if (
        request.threadId !== threadId ||
        request.turnId !== turnId ||
        request.clientId !== undefined
      ) {
        continue;
      }
      this.#pendingServerRequests.delete(id);
      this.#sendDesktop(request.line);
    }
  }

  #claimThread(threadId: string, clientId: number): void {
    const prior = this.#threadOwners.get(threadId);
    if (prior !== undefined && prior !== clientId && this.#clients.has(prior)) {
      throw new Error("A different OmniCodex connection owns this thread");
    }
    this.#threadOwners.set(threadId, clientId);
    for (const [requestId, request] of this.#pendingServerRequests) {
      if (request.threadId !== threadId) continue;
      this.#pendingServerRequests.set(requestId, { ...request, clientId });
      this.#clients.get(clientId)?.send(request.line);
    }
  }

  #settleOwnershipClaim(
    threadId: string,
    clientId: number,
    claim: OwnershipClaim,
    success: boolean,
  ): void {
    claim.status = success ? "committed" : "failed";
    if (this.#ownershipClaims.get(threadId) !== claim) return;
    if (success || this.#threadOwners.get(threadId) !== clientId) {
      this.#ownershipClaims.delete(threadId);
      return;
    }
    let rejected = claim;
    while (rejected.previousClaim?.status === "failed") rejected = rejected.previousClaim;
    if (rejected.previousOwnerPresent) {
      this.#threadOwners.set(threadId, rejected.previousOwner);
    } else {
      this.#threadOwners.delete(threadId);
    }
    if (rejected.previousClaim?.status === "pending") {
      this.#ownershipClaims.set(threadId, rejected.previousClaim);
    } else {
      this.#ownershipClaims.delete(threadId);
    }
  }
}

function desktopTurnId(
  method: "thread/resume" | "turn/start",
  result: unknown,
): string | undefined {
  const response = objectValue(result);
  if (method === "turn/start") return stringValue(objectValue(response?.turn)?.id);
  const turns = objectValue(response?.thread)?.turns;
  if (!Array.isArray(turns)) return undefined;
  const active = turns
    .map(objectValue)
    .filter((turn) => turn?.status === "inProgress")
    .map((turn) => stringValue(turn?.id))
    .filter((id): id is string => id !== undefined);
  return active.length === 1 ? active[0] : undefined;
}

/** Isolates one external client socket from the shared Desktop app-server stream. */
export function attachOmniClientSocket(
  socket: Duplex,
  router: Pick<StdioAppServerRouter, "addClient" | "removeClient" | "receiveClient">,
  onClose: () => void,
  reportError: (error: unknown) => void,
): void {
  const clientId = router.addClient((line) => socket.write(`${line}\n`));
  let failureReported = false;
  const fail = (error: unknown) => {
    if (!failureReported) {
      failureReported = true;
      reportError(error);
    }
    socket.destroy();
  };
  socket.on("error", fail);
  socket.once("close", () => {
    router.removeClient(clientId);
    onClose();
  });
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  void (async () => {
    for await (const line of lines) {
      try {
        router.receiveClient(clientId, line);
      } catch (error) {
        fail(error);
        break;
      }
    }
  })().catch(fail);
}

function parseMessage(line: string): Record<string, unknown> {
  const value = JSON.parse(line) as unknown;
  const message = objectValue(value);
  if (message === undefined) throw new Error("App Server message is not an object");
  return message;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
