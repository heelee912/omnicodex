import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  candidateAcceptanceGateNames,
  releasedAcceptanceGateNames,
} from "../../application/release-acceptance.js";

const PACKAGE_NAME = "@heelee912/omnicodex";
const REPOSITORY = "heelee912/omnicodex";
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const BOOT_TIME_TOLERANCE_MS = 10_000;
const allGates = new Set<string>(releasedAcceptanceGateNames);

export interface ReleaseAcceptanceIdentity {
  readonly sourceCommit: string;
  readonly packageVersion: string;
  readonly packageSha256: string;
}

export interface ReleaseAcceptanceArtifactInput {
  readonly kind: string;
  readonly path: string;
}

export interface ReleaseAcceptanceRecordInput extends ReleaseAcceptanceIdentity {
  readonly gate: string;
  readonly artifacts: readonly ReleaseAcceptanceArtifactInput[];
}

/**
 * Atomically accumulates metadata-only receipts for one exact build. Artifact
 * paths and bytes are never copied into the evidence file; only kind, size,
 * and SHA-256 are retained. Existing gate receipts are append-only/idempotent.
 */
export class ReleaseAcceptanceStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #uptimeSeconds: () => number;

  constructor(
    path: string,
    now: () => Date = () => new Date(),
    uptimeSeconds: () => number = uptime,
  ) {
    if (!isAbsolute(path)) throw new Error("Release acceptance evidence path must be absolute");
    this.#path = resolve(path);
    this.#now = now;
    this.#uptimeSeconds = uptimeSeconds;
  }

  async preview(input: ReleaseAcceptanceRecordInput): Promise<Record<string, unknown>> {
    validateInput(input);
    return this.#record(input, false);
  }

  async record(input: ReleaseAcceptanceRecordInput): Promise<Record<string, unknown>> {
    validateInput(input);
    await mkdir(dirname(this.#path), { recursive: true });
    const lockPath = `${this.#path}.lock`;
    const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
      if (isObject(error) && error.code === "EEXIST") {
        throw new Error("Another release acceptance writer owns the evidence lock");
      }
      throw error;
    });
    try {
      await lock.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
      return await this.#record(input, true);
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async #record(
    input: ReleaseAcceptanceRecordInput,
    persist: boolean,
  ): Promise<Record<string, unknown>> {
    await validateGateEvidence(input, this.#now(), this.#uptimeSeconds());
    const artifacts = await Promise.all(input.artifacts.map(hashArtifact));
    const identity = {
      schemaVersion: 1,
      repository: REPOSITORY,
      sourceCommit: input.sourceCommit,
      package: {
        name: PACKAGE_NAME,
        version: input.packageVersion,
        sha256: input.packageSha256,
      },
    };
    const existing = await this.#readOptional();
    if (existing !== undefined && !sameIdentity(existing, input)) {
      throw new Error("Release acceptance evidence belongs to a different build");
    }
    const gates = isObject(existing?.gates) ? existing.gates : {};
    const receipt = {
      mode: "actual",
      passed: true,
      sourceCommit: input.sourceCommit,
      packageVersion: input.packageVersion,
      packageSha256: input.packageSha256,
      completedAt: this.#now().toISOString(),
      artifacts,
    };
    const prior = gates[input.gate];
    if (prior !== undefined) {
      const priorStable = stableReceipt(prior);
      const nextStable = stableReceipt(receipt);
      if (JSON.stringify(priorStable) !== JSON.stringify(nextStable)) {
        throw new Error("Release acceptance gate already has different immutable evidence");
      }
      return existing as Record<string, unknown>;
    }
    const evidence = { ...identity, gates: { ...gates, [input.gate]: receipt } };
    if (persist) await atomicJsonWrite(this.#path, evidence);
    return evidence;
  }

  async #readOptional(): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!isObject(parsed)) throw new Error("Release acceptance evidence is not an object");
      return parsed;
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
}

async function validateGateEvidence(
  input: ReleaseAcceptanceRecordInput,
  now: Date,
  uptimeSeconds: number,
): Promise<void> {
  if (input.gate === "ordinary_zero_model") {
    const receipt = await requiredJsonReceipt(input, "ordinary_zero_model_receipt");
    assertBuildBoundReceipt(receipt, input, "ordinary_zero_model_succeeded");
    if (
      receipt.providerRequestCount !== 0 ||
      receipt.modelUsage !== 0 ||
      !Number.isSafeInteger(receipt.nativeToolCalls) ||
      (receipt.nativeToolCalls as number) <= 0
    ) {
      throw new Error(
        "Ordinary zero-model receipt did not prove a native call with zero model use",
      );
    }
    return;
  }
  if (input.gate === "auth0_dcr_pkce") {
    const receipt = await requiredJsonReceipt(input, "auth0_dcr_pkce_receipt");
    assertBuildBoundReceipt(receipt, input, "auth0_dcr_pkce_succeeded");
    if (
      receipt.publicClient !== true ||
      receipt.pkceMethod !== "S256" ||
      receipt.codeExchange !== true ||
      receipt.refresh !== true ||
      receipt.offlineAccess !== true ||
      !validFullResource(receipt.resource)
    ) {
      throw new Error("Auth0 receipt did not prove public DCR, PKCE, exchange, and refresh");
    }
    return;
  }
  if (input.gate === "ngrok_external") {
    const receipt = await requiredJsonReceipt(input, "ngrok_external_receipt");
    assertBuildBoundReceipt(receipt, input, "ngrok_external_succeeded");
    if (
      receipt.tlsVerified !== true ||
      receipt.protectedMetadata !== true ||
      receipt.authenticatedMcp !== true ||
      !validFullResource(receipt.resource)
    ) {
      throw new Error("ngrok receipt did not prove TLS, metadata, and authenticated MCP");
    }
    return;
  }
  if (input.gate === "official_inspector") {
    const receipt = await requiredJsonReceipt(input, "official_inspector_receipt");
    assertBuildBoundReceipt(receipt, input, "official_inspector_succeeded");
    if (
      receipt.officialClient !== true ||
      receipt.initialize !== true ||
      receipt.listPaging !== true ||
      receipt.call !== true ||
      receipt.progress !== true ||
      receipt.cancellation !== true ||
      receipt.resources !== true ||
      receipt.localSurface !== true ||
      receipt.externalSurface !== true
    ) {
      throw new Error("Official Inspector receipt omitted a required real protocol operation");
    }
    return;
  }
  if (input.gate === "web_chatgpt_pro_full") {
    const receipt = await requiredJsonReceipt(input, "web_chatgpt_pro_full_receipt");
    assertBuildBoundReceipt(receipt, input, "web_chatgpt_pro_full_succeeded");
    if (
      receipt.registration !== true ||
      receipt.auth0Completed !== true ||
      receipt.dcrPkce !== true ||
      receipt.stableTools !== true ||
      receipt.fullSurface !== true ||
      receipt.ordinaryProviderRequestCount !== 0 ||
      receipt.ordinaryModelUsage !== 0 ||
      receipt.missingScopeDenied !== true ||
      receipt.unapprovedSubjectDenied !== true ||
      !validFullResource(receipt.resource)
    ) {
      throw new Error("Web ChatGPT Pro receipt did not prove the authenticated native surface");
    }
    validateWebChatgptProDirectWork(receipt.directWorkEvidence);
    return;
  }
  if (input.gate === "oracle_consent_receipts") {
    const receipt = await requiredJsonReceipt(input, "oracle_consent_receipts");
    assertBuildBoundReceipt(receipt, input, "oracle_consent_verified");
    if (
      receipt.freshLiveVerification !== "verified" ||
      receipt.connect !== true ||
      receipt.alwaysAllow !== true ||
      typeof receipt.connectorId !== "string" ||
      receipt.connectorId.length === 0 ||
      typeof receipt.runId !== "string" ||
      receipt.runId.length === 0 ||
      typeof receipt.correlationId !== "string" ||
      receipt.correlationId.length === 0 ||
      !validFullResource(receipt.resource) ||
      receipt.surface !== "/mcp/full"
    ) {
      throw new Error("Oracle receipt did not prove same-run Connect and Always allow");
    }
    return;
  }
  if (input.gate === "runtime_switch_rollback") {
    const receipt = await requiredJsonReceipt(input, "runtime_switch_rollback_receipt");
    assertBuildBoundReceipt(receipt, input, "runtime_switch_rollback_succeeded");
    if (
      receipt.distinctInstalledCandidate !== true ||
      receipt.shadowProbe !== true ||
      receipt.admissionDrained !== true ||
      receipt.atomicSwitch !== true ||
      receipt.rollbackObserved !== true ||
      receipt.protectedCodexFilesUnchanged !== true
    ) {
      throw new Error("Runtime receipt did not prove a distinct live switch and rollback");
    }
    return;
  }
  if (input.gate === "package_update_rollback") {
    const receipt = await requiredJsonReceipt(input, "package_update_rollback_receipt");
    assertBuildBoundReceipt(receipt, input, "package_update_rollback_succeeded");
    if (
      receipt.candidateArtifact !== true ||
      receipt.candidateIntegrity !== true ||
      receipt.sbom !== true ||
      receipt.shadowProbe !== true ||
      receipt.admissionDrained !== true ||
      receipt.atomicSwitch !== true ||
      receipt.rollbackObserved !== true ||
      receipt.protectedCodexFilesUnchanged !== true
    ) {
      throw new Error("Package receipt did not prove staged-candidate update and rollback");
    }
    return;
  }
  if (input.gate === "gui_e2e") {
    const receipt = await requiredJsonReceipt(input, "gui_e2e_receipt");
    assertBuildBoundReceipt(receipt, input, "gui_e2e_succeeded");
    if (
      receipt.browser !== true ||
      receipt.chrome !== true ||
      receipt.computerUse !== true ||
      receipt.codexAppContinuity !== true ||
      receipt.protectedCodexFilesUnchanged !== true
    ) {
      throw new Error("GUI receipt did not prove all three surfaces and app continuity");
    }
    validateGuiCapabilityEvidence(receipt.capabilityEvidence);
    return;
  }
  if (input.gate !== "autostart_reboot") return;
  const artifact = input.artifacts.find(({ kind }) => kind === "autostart_reboot_receipt");
  if (artifact === undefined) {
    throw new Error("autostart_reboot requires an autostart_reboot_receipt artifact");
  }
  const receipt = await readLastJsonObject(artifact.path);
  if (
    receipt.event !== "autostart_succeeded" ||
    receipt.source !== "scheduled-task" ||
    receipt.exitCode !== 0 ||
    !Number.isSafeInteger(receipt.attempts) ||
    (receipt.attempts as number) <= 0
  ) {
    throw new Error("Autostart reboot receipt is not a successful Scheduled Task launch");
  }
  if (
    receipt.pointerVersion !== input.packageVersion ||
    receipt.pointerSourceCommit !== input.sourceCommit
  ) {
    throw new Error("Autostart reboot receipt belongs to a different release build");
  }
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error("Current system uptime is invalid");
  }
  const nowUnixMs = now.getTime();
  const currentBootUnixMs = nowUnixMs - Math.floor(uptimeSeconds * 1_000);
  const bootedAtUnixMs = safeUnixMs(receipt.bootedAtUnixMs, "boot time");
  const pointerActivatedAtUnixMs = safeUnixMs(
    receipt.pointerActivatedAtUnixMs,
    "pointer activation time",
  );
  const startedAtUnixMs = safeIsoUnixMs(receipt.startedAt, "start time");
  const timestampUnixMs = safeIsoUnixMs(receipt.timestamp, "completion time");
  if (Math.abs(bootedAtUnixMs - currentBootUnixMs) > BOOT_TIME_TOLERANCE_MS) {
    throw new Error("Autostart reboot receipt belongs to a previous boot");
  }
  if (
    pointerActivatedAtUnixMs > bootedAtUnixMs + BOOT_TIME_TOLERANCE_MS ||
    startedAtUnixMs < bootedAtUnixMs ||
    timestampUnixMs < startedAtUnixMs ||
    timestampUnixMs > nowUnixMs + BOOT_TIME_TOLERANCE_MS
  ) {
    throw new Error("Autostart reboot receipt timestamps are inconsistent");
  }
}

/**
 * Release evidence verifies ownership and authoritative native results without
 * prescribing a prompt-specific tool plan. Tool names, order, and call count
 * are selected by the Web model from the live native catalog.
 */
function validateWebChatgptProDirectWork(value: unknown): void {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new Error(
      "Web ChatGPT Pro receipt requires versioned structured attributable direct-work evidence",
    );
  }
  const actor = requiredWebProObject(value, "actor");
  if (
    actor.kind !== "web_chatgpt_pro" ||
    !validSha256(actor.conversationIdSha256) ||
    !validSha256(actor.mcpSessionIdSha256) ||
    !validEvidenceText(actor.connectorId) ||
    !validEvidenceText(actor.runId)
  ) {
    throw new Error("Web ChatGPT Pro direct-work actor attribution is invalid");
  }
  if (
    value.delegated !== false ||
    value.providerRequestCount !== 0 ||
    value.modelUsage !== 0 ||
    value.modelInvocationCount !== 0 ||
    !validEvidenceText(value.correlationId)
  ) {
    throw new Error("Web ChatGPT Pro direct-work evidence must be non-delegated and zero-model");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error("Web ChatGPT Pro direct-work evidence requires native call results");
  }

  const steps = value.steps.map((candidate) => {
    if (!isObject(candidate)) {
      throw new Error("Web ChatGPT Pro direct-work chain contains an invalid step");
    }
    if (
      !validEvidenceText(candidate.route) ||
      candidate.actorRunId !== actor.runId ||
      candidate.correlationId !== value.correlationId
    ) {
      throw new Error(
        "Web ChatGPT Pro direct-work steps must belong to the same Web ChatGPT Pro run in order",
      );
    }
    if (
      candidate.executionOwner !== "web_chatgpt_pro" ||
      candidate.modelEffect !== false ||
      candidate.providerRequestCount !== 0 ||
      candidate.modelUsage !== 0
    ) {
      throw new Error(
        "Web ChatGPT Pro direct-work steps must be executed directly by Web ChatGPT Pro with zero model use",
      );
    }
    if (
      !validEvidenceText(candidate.toolName) ||
      !validEvidenceText(candidate.callId) ||
      candidate.outcome !== "succeeded" ||
      !validEvidenceText(candidate.stateEffect) ||
      !validSha256(candidate.targetSha256) ||
      !validSha256(candidate.authoritativeReadbackSha256)
    ) {
      throw new Error(
        "Web ChatGPT Pro direct-work step lacks an exact tool, effect target, or authoritative readback",
      );
    }
    return candidate;
  });

  if (new Set(steps.map((step) => step.callId)).size !== steps.length) {
    throw new Error("Web ChatGPT Pro direct-work chain requires distinct call identities");
  }
}

function requiredWebProObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = value[key];
  if (!isObject(nested)) {
    throw new Error(`Web ChatGPT Pro direct-work evidence is missing ${key}`);
  }
  return nested;
}

/**
 * A GUI E2E receipt is written by the same release process that consumes it,
 * so capability booleans are assertions rather than evidence. Keep the legacy
 * summary flags for receipt compatibility, but require independently
 * attributable calls and authoritative readbacks for every acceptance
 * capability.
 */
function validateGuiCapabilityEvidence(value: unknown): void {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new Error("GUI receipt requires versioned structured capability evidence");
  }

  const inAppBrowser = requiredObject(value, "inAppBrowser");
  const chrome = requiredObject(value, "chrome");
  const computerUse = requiredObject(value, "computerUse");
  const sentinelFile = requiredObject(value, "sentinelFile");
  const hiddenTerminal = requiredObject(value, "hiddenTerminal");
  const adb = requiredObject(value, "adb");
  const godot = requiredObject(value, "godot");
  const continuity = requiredObject(value, "localCodexContinuity");

  validateCapabilityCall(inAppBrowser, {
    label: "in-app browser",
    surface: "iab",
    exactToolName: "browser__control_in_app_browser",
  });
  validateCapabilityCall(chrome, {
    label: "Chrome",
    surface: "chrome",
    exactToolName: "chrome__control_chrome",
  });
  if (inAppBrowser.surface === chrome.surface || sameCallIdentity(inAppBrowser, chrome)) {
    throw new Error("GUI receipt must prove distinct Chrome and in-app browser calls");
  }

  validateCapabilityCall(computerUse, {
    label: "Computer Use",
    surface: "computer_use",
    toolNamePattern: /^(?:codex__)?computer_use(?:__|$)/u,
  });
  if (computerUse.readOnly !== true) {
    throw new Error("GUI receipt Computer Use proof must be a bounded read-only observation");
  }

  validateSentinelFileEvidence(sentinelFile);
  validateHiddenTerminalEvidence(hiddenTerminal);
  validateAdbEvidence(adb);
  validateGodotEvidence(godot);
  validateLocalCodexContinuity(continuity);
}

interface CapabilityCallExpectation {
  readonly label: string;
  readonly surface: string;
  readonly exactToolName?: string;
  readonly toolNamePattern?: RegExp;
}

function validateCapabilityCall(
  value: Record<string, unknown>,
  expectation: CapabilityCallExpectation,
): void {
  if (
    !validEvidenceText(value.toolName) ||
    !validEvidenceText(value.route) ||
    value.surface !== expectation.surface ||
    !validCallIdentity(value) ||
    value.outcome !== "succeeded" ||
    !validSha256(value.authoritativeReadbackSha256) ||
    (expectation.exactToolName !== undefined && value.toolName !== expectation.exactToolName) ||
    (expectation.toolNamePattern !== undefined &&
      (typeof value.toolName !== "string" || !expectation.toolNamePattern.test(value.toolName)))
  ) {
    throw new Error(
      `GUI receipt ${expectation.label} proof requires a real tool call and authoritative readback`,
    );
  }
}

function validateSentinelFileEvidence(value: Record<string, unknown>): void {
  const write = requiredObject(value, "write");
  const read = requiredObject(value, "read");
  validateCapabilityCall(write, { label: "sentinel file write", surface: "filesystem" });
  validateCapabilityCall(read, { label: "sentinel file read", surface: "filesystem" });
  if (
    !validSha256(value.pathSha256) ||
    !validSha256(value.contentSha256) ||
    write.authoritativeReadbackSha256 !== value.contentSha256 ||
    read.authoritativeReadbackSha256 !== value.contentSha256 ||
    sameCallIdentity(write, read)
  ) {
    throw new Error("GUI receipt sentinel file write/read digest proof is inconsistent");
  }
}

function validateHiddenTerminalEvidence(value: Record<string, unknown>): void {
  validateCapabilityCall(value, { label: "hidden terminal", surface: "hidden_terminal" });
  if (
    value.windowsHide !== true ||
    value.shell !== false ||
    value.exitCode !== 0 ||
    !validSha256(value.stdoutSha256) ||
    value.stdoutSha256 !== value.authoritativeReadbackSha256
  ) {
    throw new Error("GUI receipt terminal proof was not a successful hidden shell-free call");
  }
}

function validateAdbEvidence(value: Record<string, unknown>): void {
  validateCapabilityCall(value, {
    label: "ADB",
    surface: "adb",
    toolNamePattern: /(?:^|__)command_exec$|^exec_command$/u,
  });
  if (
    value.readOnly !== true ||
    value.probe !== "devices-l" ||
    !Number.isSafeInteger(value.connectedDeviceCount) ||
    (value.connectedDeviceCount as number) < 0 ||
    !validSha256(value.transportStatesSha256) ||
    value.transportStatesSha256 !== value.authoritativeReadbackSha256
  ) {
    throw new Error("GUI receipt ADB proof is not a read-only device inventory");
  }
  if (
    (value.connectedDeviceCount as number) > 0 &&
    !validSha256(value.connectedDeviceIdentifiersSha256)
  ) {
    throw new Error("GUI receipt omitted authoritative readback for connected ADB devices");
  }
}

function validateGodotEvidence(value: Record<string, unknown>): void {
  validateCapabilityCall(value, {
    label: "Godot",
    surface: "godot",
    toolNamePattern: /(?:^|__)command_exec$|^exec_command$/u,
  });
  if (
    value.readOnly !== true ||
    value.bounded !== true ||
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) <= 0 ||
    (value.timeoutMs as number) > 120_000 ||
    value.exitCode !== 0 ||
    !validSha256(value.probeSha256) ||
    value.probeSha256 !== value.authoritativeReadbackSha256
  ) {
    throw new Error("GUI receipt Godot proof was not a successful bounded read-only probe");
  }
}

function validateLocalCodexContinuity(value: Record<string, unknown>): void {
  if (
    !validEvidenceText(value.threadId) ||
    !validEvidenceText(value.appInstanceId) ||
    !validEvidenceText(value.route) ||
    !validSha256(value.protectedFilesBeforeSha256) ||
    value.protectedFilesAfterSha256 !== value.protectedFilesBeforeSha256
  ) {
    throw new Error(
      "GUI receipt local Codex continuity identity or protected-file proof is invalid",
    );
  }
  const phases = ["before", "during", "after"] as const;
  const calls = phases.map((phase) => {
    const call = requiredObject(value, phase);
    validateCapabilityCall(call, {
      label: `local Codex ${phase}`,
      surface: "codex_app",
      toolNamePattern: /^codex_app__/u,
    });
    if (
      call.phase !== phase ||
      call.threadId !== value.threadId ||
      call.appInstanceId !== value.appInstanceId ||
      call.route !== value.route
    ) {
      throw new Error(`GUI receipt local Codex ${phase} readback changed continuity identity`);
    }
    return call;
  });
  const identities = calls.map(callIdentity);
  if (new Set(identities).size !== phases.length) {
    throw new Error("GUI receipt local Codex continuity phases require distinct calls");
  }
}

function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!isObject(nested)) throw new Error(`GUI receipt capability evidence is missing ${key}`);
  return nested;
}

function validEvidenceText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validCallIdentity(value: Record<string, unknown>): boolean {
  return validEvidenceText(value.callId) || validEvidenceText(value.stableIdentifier);
}

function callIdentity(value: Record<string, unknown>): string {
  if (validEvidenceText(value.callId)) return `call:${value.callId}`;
  if (validEvidenceText(value.stableIdentifier)) return `stable:${value.stableIdentifier}`;
  return "";
}

function sameCallIdentity(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftIdentity = callIdentity(left);
  return leftIdentity.length > 0 && leftIdentity === callIdentity(right);
}

async function requiredJsonReceipt(
  input: ReleaseAcceptanceRecordInput,
  kind: string,
): Promise<Record<string, unknown>> {
  const artifact = input.artifacts.find((candidate) => candidate.kind === kind);
  if (artifact === undefined) throw new Error(`${input.gate} requires a ${kind} artifact`);
  return readJsonObject(artifact.path);
}

function assertBuildBoundReceipt(
  receipt: Record<string, unknown>,
  input: ReleaseAcceptanceRecordInput,
  event: string,
): void {
  if (
    receipt.event !== event ||
    receipt.sourceCommit !== input.sourceCommit ||
    receipt.packageVersion !== input.packageVersion ||
    receipt.packageSha256 !== input.packageSha256
  ) {
    throw new Error(`${input.gate} receipt is not a successful result for the exact build`);
  }
}

function validFullResource(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.pathname === "/mcp/full"
    );
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const handle = await open(resolve(path), "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RECEIPT_BYTES) {
      throw new Error("Acceptance receipt must be a bounded non-empty regular file");
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!isObject(parsed)) throw new Error("Acceptance receipt is not an object");
    return parsed;
  } finally {
    await handle.close();
  }
}

async function readLastJsonObject(path: string): Promise<Record<string, unknown>> {
  const handle = await open(resolve(path), "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RECEIPT_BYTES) {
      throw new Error("Autostart reboot receipt must be a bounded non-empty regular file");
    }
    const content = await handle.readFile("utf8");
    const lastLine = content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
    if (lastLine === undefined) throw new Error("Autostart reboot receipt is empty");
    const parsed: unknown = JSON.parse(lastLine);
    if (!isObject(parsed)) throw new Error("Autostart reboot receipt is not an object");
    return parsed;
  } finally {
    await handle.close();
  }
}

function safeUnixMs(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Autostart reboot receipt ${label} is invalid`);
  }
  return value as number;
}

function safeIsoUnixMs(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new Error(`Autostart reboot receipt ${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Autostart reboot receipt ${label} is invalid`);
  }
  return parsed;
}

function validateInput(input: ReleaseAcceptanceRecordInput): void {
  if (!allGates.has(input.gate)) throw new Error("Unknown release acceptance gate");
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error("Invalid source commit");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.packageVersion)) {
    throw new Error("Invalid package version");
  }
  if (!/^[a-f0-9]{64}$/.test(input.packageSha256)) {
    throw new Error("Invalid package SHA-256");
  }
  if (input.artifacts.length === 0) throw new Error("At least one actual artifact is required");
  const kinds = new Set<string>();
  for (const artifact of input.artifacts) {
    if (!/^[a-z0-9_-]{1,64}$/.test(artifact.kind) || kinds.has(artifact.kind)) {
      throw new Error("Artifact kinds must be unique safe identifiers");
    }
    if (!isAbsolute(artifact.path)) throw new Error("Artifact path must be absolute");
    kinds.add(artifact.kind);
  }
}

async function hashArtifact(
  artifact: ReleaseAcceptanceArtifactInput,
): Promise<{ readonly kind: string; readonly sizeBytes: number; readonly sha256: string }> {
  const handle = await open(resolve(artifact.path), "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Acceptance artifact must be a bounded non-empty regular file");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stats.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error("Acceptance artifact changed while hashing");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
      throw new Error("Acceptance artifact changed while hashing");
    }
    return { kind: artifact.kind, sizeBytes: stats.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

function sameIdentity(value: Record<string, unknown>, input: ReleaseAcceptanceIdentity): boolean {
  const packageValue = isObject(value.package) ? value.package : undefined;
  return (
    value.schemaVersion === 1 &&
    value.repository === REPOSITORY &&
    value.sourceCommit === input.sourceCommit &&
    packageValue?.name === PACKAGE_NAME &&
    packageValue.version === input.packageVersion &&
    packageValue.sha256 === input.packageSha256
  );
}

function stableReceipt(value: unknown): unknown {
  if (!isObject(value)) return value;
  const { completedAt: _completedAt, ...stable } = value;
  return stable;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function parseAcceptanceArtifact(value: string): ReleaseAcceptanceArtifactInput {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("Artifact must use kind=absolute-path");
  }
  return { kind: value.slice(0, separator), path: value.slice(separator + 1) };
}

export function isCandidateAcceptanceGate(value: string): boolean {
  return (candidateAcceptanceGateNames as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
