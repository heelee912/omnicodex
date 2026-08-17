/**
 * Runtime identity and lifecycle values are deliberately independent from the
 * Codex application process. OmniCodex owns only the child App Server process
 * that it starts; the desktop application is never represented as a managed
 * runtime here.
 */

export type RuntimeCandidateSource = "managed_install" | "windows_apps" | "path" | "explicit";

export interface RuntimeCandidate {
  readonly executablePath: string;
  readonly canonicalPath: string;
  readonly source: RuntimeCandidateSource;
  readonly productVersion?: string;
  readonly modifiedAtUnixMs?: number;
}

export interface RuntimeDiscoveryReport {
  readonly platform: NodeJS.Platform;
  readonly candidates: readonly RuntimeCandidate[];
  readonly warnings: readonly string[];
}

export type RuntimeLifecycle =
  | "stopped"
  | "discovering"
  | "starting"
  | "ready"
  | "draining"
  | "failed";

export interface RuntimeStatus {
  readonly lifecycle: RuntimeLifecycle;
  readonly candidate?: RuntimeCandidate;
  readonly pid?: number;
  readonly correlationId?: string;
  readonly initializedAtUnixMs?: number;
  readonly lastError?: string;
}
