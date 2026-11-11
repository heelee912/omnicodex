import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  BrowserNativeContextRequest,
  BrowserNativeSurfaceRecovery,
} from "../../application/browser-native-executor.js";
import { locateInstalledFirstPartyAsset } from "../../application/installed-first-party-instructions.js";
import {
  type HiddenSpawnOptions,
  inspectWindowsProcessesByName,
  type OwnedHiddenChildProcess,
  type RecoveredWindowsProcessIdentity,
  spawnHidden,
} from "./hidden-child-process.js";

type HiddenSpawner = (
  executable: string,
  args: readonly string[],
  options?: HiddenSpawnOptions,
) => OwnedHiddenChildProcess;

export interface FirstPartyChromeSurfaceRecoveryOptions {
  readonly codexHome?: string;
  readonly nodeExecutablePath?: string;
  readonly spawn?: HiddenSpawner;
  readonly warmupMs?: number;
  readonly nowUnixMs?: () => number;
  readonly inspectRunningProcesses?: (
    name: string,
  ) => Promise<readonly RecoveredWindowsProcessIdentity[]>;
}

interface OfficialChromeLaunchPlan {
  readonly browserFamily: string;
  readonly dryRun: boolean;
  readonly profileDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
}

interface OfficialChromeRuntimeState {
  readonly running: boolean;
}

interface OfficialChromeExtensionState {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly userDataDirectory: string;
  readonly selectedProfileDirectory: string;
  readonly disableReasons: readonly number[];
}

interface PreferredChromeProfile {
  readonly preferencesPath: string;
  readonly userDataDirectory: string;
  readonly profileDirectory: string;
}

interface ChromeRecoveryState {
  attempted: boolean;
  failure: Error | undefined;
  retryAt: number;
  failureCount: number;
  flight: Promise<void> | undefined;
  controller: AbortController | undefined;
  waiters: number;
  launchedProfile: string | undefined;
}

interface OfficialChromeNativeHostState {
  readonly correct: boolean;
  readonly problem?: string;
  readonly exists?: boolean;
  readonly manifestPath?: string;
  readonly registryKey?: string;
}

interface HiddenChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Restores the installed first-party Chrome Use extension on the exact Chrome
 * profile selected by the installed plugin diagnostics. The official helper is
 * executed in dry-run mode only; its resolved Chrome executable/profile is then
 * launched directly through OmniCodex's hidden, shell-free process boundary so
 * Windows never flashes cmd.exe or PowerShell.
 */
export class FirstPartyChromeSurfaceRecovery implements BrowserNativeSurfaceRecovery {
  readonly #codexHome: string;
  readonly #nodeExecutablePath: string;
  readonly #spawn: HiddenSpawner;
  readonly #warmupMs: number;
  readonly #now: () => number;
  readonly #inspectRunningProcesses: (
    name: string,
  ) => Promise<readonly RecoveredWindowsProcessIdentity[]>;
  readonly #outages = new Map<string, ChromeRecoveryState>();
  readonly #launchedProfiles = new Set<string>();

  constructor(options: FirstPartyChromeSurfaceRecoveryOptions = {}) {
    const userProfile = process.env.USERPROFILE;
    const codexHome = options.codexHome ?? process.env.CODEX_HOME;
    if (codexHome === undefined && userProfile === undefined) {
      throw new Error("CODEX_HOME and USERPROFILE are unavailable");
    }
    this.#codexHome = codexHome ?? join(userProfile as string, ".codex");
    this.#nodeExecutablePath = options.nodeExecutablePath ?? process.execPath;
    this.#spawn = options.spawn ?? spawnHidden;
    this.#warmupMs = options.warmupMs ?? 2_000;
    this.#now = options.nowUnixMs ?? Date.now;
    this.#inspectRunningProcesses =
      options.inspectRunningProcesses ??
      ((name) => inspectWindowsProcessesByName(name, { timeoutMs: 15_000 }));
  }

  async recoverUnavailableSurface(
    request: BrowserNativeContextRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isChromeExtensionRequest(request) || process.platform !== "win32") return;
    signal?.throwIfAborted();
    const key = chromeRecoveryKey(request);
    let state = this.#outages.get(key);
    if (state === undefined) {
      state = {
        attempted: false,
        failure: undefined,
        retryAt: 0,
        failureCount: 0,
        flight: undefined,
        controller: undefined,
        waiters: 0,
        launchedProfile: undefined,
      };
      this.#outages.set(key, state);
    }
    if (state.flight === undefined && state.attempted) {
      if (state.failure === undefined) return;
      if (this.#now() < state.retryAt) throw state.failure;
    }

    if (state.flight === undefined) {
      state.attempted = true;
      const controller = new AbortController();
      state.controller = controller;
      const currentState = state;
      const flight = this.#launchSelectedChromeProfile(request, state, controller.signal)
        .then(
          () => {
            currentState.failure = undefined;
            currentState.retryAt = 0;
            currentState.failureCount = 0;
          },
          (error: unknown) => {
            if (controller.signal.aborted) throw error;
            currentState.failure = error instanceof Error ? error : new Error(String(error));
            currentState.failureCount += 1;
            currentState.retryAt =
              this.#now() +
              Math.min(900_000, 30_000 * 2 ** Math.min(currentState.failureCount - 1, 5));
            throw currentState.failure;
          },
        )
        .finally(() => {
          if (currentState.flight === flight) {
            currentState.flight = undefined;
            currentState.controller = undefined;
          }
        });
      state.flight = flight;
    }
    const flight = state.flight;
    state.waiters += 1;
    try {
      await waitForChromeRecoveryFlight(flight, signal);
    } finally {
      state.waiters -= 1;
      if (state.waiters === 0 && state.flight === flight && state.launchedProfile === undefined) {
        state.controller?.abort(new Error("Chrome recovery has no waiting callers"));
        if (this.#outages.get(key) === state) this.#outages.delete(key);
      }
    }
  }

  /** Read-only official diagnostic; never launches or focuses Chrome. */
  async isExtensionHostRunning(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    const runningScriptPath = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["chrome", "chrome-internal", "chrome-dev"],
      relativePath: ["scripts", "chrome-is-running.js"],
    });
    const runtime = parseOfficialChromeRuntimeState(
      await captureHiddenChild(
        this.#spawn,
        this.#nodeExecutablePath,
        [runningScriptPath, "--browser", "chrome", "--json"],
        15_000,
      ),
    );
    return runtime.running;
  }

  noteSurfaceAvailable(request: BrowserNativeContextRequest): void {
    if (!isChromeExtensionRequest(request)) return;
    const key = chromeRecoveryKey(request);
    const state = this.#outages.get(key);
    if (state?.launchedProfile !== undefined) this.#launchedProfiles.delete(state.launchedProfile);
    this.#outages.delete(key);
  }

  async #launchSelectedChromeProfile(
    request: BrowserNativeContextRequest,
    state: ChromeRecoveryState,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const runningScriptPath = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["chrome", "chrome-internal", "chrome-dev"],
      relativePath: ["scripts", "chrome-is-running.js"],
    });
    const extensionScriptPath = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["chrome", "chrome-internal", "chrome-dev"],
      relativePath: ["scripts", "check-extension-installed.js"],
    });
    const nativeHostScriptPath = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["chrome", "chrome-internal", "chrome-dev"],
      relativePath: ["scripts", "check-native-host-manifest.js"],
    });
    const launchScriptPath = await locateInstalledFirstPartyAsset({
      codexHome: this.#codexHome,
      plugins: ["chrome", "chrome-internal", "chrome-dev"],
      relativePath: ["scripts", "open-chrome-window.js"],
    });

    const runtime = parseOfficialChromeRuntimeState(
      await captureHiddenChild(
        this.#spawn,
        this.#nodeExecutablePath,
        [runningScriptPath, "--browser", "chrome", "--json"],
        15_000,
      ),
    );
    signal.throwIfAborted();
    const selection = request.operation === "list_surfaces" ? undefined : request;
    const configuredPreferences =
      process.env.CODEX_CHROMIUM_PREFERENCES_PATH ?? process.env.CODEX_CHROME_PREFERENCES_PATH;
    // An unscoped request should first reconnect the existing native browser;
    // last_used is only a fallback for opening Chrome when it is not running.
    if (
      runtime.running &&
      selection?.browserId === undefined &&
      selection?.chromeProfileName === undefined &&
      !configuredPreferences
    ) {
      const processes = await this.#inspectRunningProcesses("chrome.exe");
      if (processes.some(isInteractiveChromeProcess)) {
        await this.#warmup();
        return;
      }
    }
    // A native id without profile metadata cannot safely be translated to a
    // Chrome directory. Keep the native id for the reconnect attempt instead.
    if (selection?.browserId !== undefined && selection.chromeProfileName === undefined) {
      await this.#warmup();
      return;
    }
    let extensionResult = await captureHiddenChildResult(
      this.#spawn,
      this.#nodeExecutablePath,
      [extensionScriptPath, "--browser", "chrome", "--json"],
      15_000,
    );
    // The official diagnostic deliberately uses exit 1 for disabled and 2
    // for missing extensions. Those are structured diagnoses, not a crashed
    // helper; retain their cause instead of throwing the raw JSON away.
    if (extensionResult.code !== 0 && extensionResult.code !== 1 && extensionResult.code !== 2) {
      throw new Error(extensionResult.stderr || "Installed Chrome extension diagnostic failed");
    }
    let extension = parseOfficialChromeExtensionState(extensionResult.stdout);
    if (configuredPreferences && selection?.chromeProfileName === undefined) {
      const configuredPath = resolve(configuredPreferences);
      const configuredProfile = basename(dirname(configuredPath));
      const configuredRoot = dirname(dirname(configuredPath));
      if (
        canonicalWindowsPath(extension.userDataDirectory) !==
          canonicalWindowsPath(configuredRoot) ||
        !sameChromeProfile(extension.selectedProfileDirectory, configuredProfile)
      ) {
        throw new Error(
          "CHROME_PROFILE_MISMATCH: extension diagnostic ignored the requested profile",
        );
      }
    }
    if (selection?.chromeProfileName !== undefined) {
      const processes = runtime.running ? await this.#inspectRunningProcesses("chrome.exe") : [];
      const preferredProfile = await findUniqueChromeProfile(
        extension.userDataDirectory,
        selection.chromeProfileName,
        processes,
      );
      if (preferredProfile === undefined) {
        await this.#warmup();
        return;
      }
      extensionResult = await captureHiddenChildResult(
        this.#spawn,
        this.#nodeExecutablePath,
        [extensionScriptPath, "--browser", "chrome", "--json"],
        15_000,
        { CODEX_CHROMIUM_PREFERENCES_PATH: preferredProfile.preferencesPath },
      );
      if (extensionResult.code !== 0 && extensionResult.code !== 1 && extensionResult.code !== 2) {
        throw new Error(extensionResult.stderr || "Installed Chrome extension diagnostic failed");
      }
      extension = parseOfficialChromeExtensionState(extensionResult.stdout);
      if (
        canonicalWindowsPath(extension.userDataDirectory) !==
          canonicalWindowsPath(preferredProfile.userDataDirectory) ||
        !sameChromeProfile(extension.selectedProfileDirectory, preferredProfile.profileDirectory)
      ) {
        throw new Error(
          "CHROME_PROFILE_MISMATCH: extension diagnostic selected a different profile",
        );
      }
    }
    if (extension.disableReasons.includes(1 << 10)) {
      throw new Error(
        `CHROME_EXTENSION_CORRUPTED: Chrome marked the extension in profile ${extension.selectedProfileDirectory} as corrupted (disable reason 1024). Use Chrome's official Repair action at chrome://extensions; reconnecting or opening another window cannot repair it.`,
      );
    }
    if (!extension.installed || !extension.enabled) {
      throw new Error(
        "CHROME_EXTENSION_REINSTALL_REQUIRED: the installed Browser plugin extension is missing or disabled",
      );
    }
    const nativeHostResult = await captureHiddenChildResult(
      this.#spawn,
      this.#nodeExecutablePath,
      [nativeHostScriptPath, "--browser", "chrome", "--json"],
      15_000,
    );
    const nativeHost = parseOfficialChromeNativeHostState(nativeHostResult.stdout);
    const nativeHostCorrect =
      nativeHost.correct || (await this.#localizedWindowsRegistryRegistrationIsCorrect(nativeHost));
    if (!nativeHostCorrect) {
      throw new Error(
        `CHROME_NATIVE_HOST_REGISTRATION_REQUIRED: ${nativeHost.problem ?? "reinstall the Browser plugin to restore its official Native Messaging registration"}`,
      );
    }

    // The first-party browser client reconnects after this method returns. If
    // the selected Chrome profile is already running, opening another
    // --new-window cannot repair extension messaging and only creates an
    // ownerless user-visible window. Preserve the existing profile/window set.
    if (runtime.running && (await this.#selectedProfileIsRunning(extension))) {
      await this.#warmup();
      return;
    }

    const selectedProfile = selectedChromeProfile(extension);
    const profileEnvironment = { CODEX_CHROMIUM_PREFERENCES_PATH: selectedProfile.preferencesPath };
    const launchKey = canonicalWindowsPath(
      join(selectedProfile.userDataDirectory, selectedProfile.profileDirectory),
    );
    // Different sessions can select the same physical profile. Open it once.
    if (this.#launchedProfiles.has(launchKey)) {
      state.launchedProfile = launchKey;
      return;
    }
    let launch: { readonly executable: string; readonly args: readonly string[] };
    try {
      const planText = await captureHiddenChild(
        this.#spawn,
        this.#nodeExecutablePath,
        [launchScriptPath, "--browser", "chrome", "--dry-run", "--json"],
        15_000,
        profileEnvironment,
      );
      const plan = parseOfficialChromeLaunchPlan(planText);
      if (!sameChromeProfile(plan.profileDirectory, selectedProfile.profileDirectory)) {
        throw new Error("CHROME_PROFILE_MISMATCH: launch plan selected a different profile");
      }
      launch = directChromeLaunch(plan);
    } catch (error) {
      if (!String(error).includes("Could not find the Google Chrome executable.")) throw error;
      launch = await this.#windowsChromeLaunchFromRegistry(extension.selectedProfileDirectory);
    }
    const userDataArgument = `--user-data-dir=${selectedProfile.userDataDirectory}`;
    if (
      launch.args.some((arg) => {
        const normalized = arg.toLowerCase();
        return normalized === "--user-data-dir" || normalized.startsWith("--user-data-dir=");
      })
    ) {
      throw new Error(
        "CHROME_PROFILE_MISMATCH: launch plan unexpectedly specifies a user data directory",
      );
    }
    launch = { ...launch, args: [userDataArgument, ...launch.args] };
    signal.throwIfAborted();
    if (this.#launchedProfiles.has(launchKey)) {
      state.launchedProfile = launchKey;
      return;
    }
    this.#launchedProfiles.add(launchKey);
    state.launchedProfile = launchKey;
    try {
      await spawnDetached(this.#spawn, launch.executable, launch.args);
    } catch (error) {
      this.#launchedProfiles.delete(launchKey);
      state.launchedProfile = undefined;
      throw error;
    }
    await this.#warmup();
  }

  async #windowsChromeLaunchFromRegistry(profileDirectory: string): Promise<{
    readonly executable: string;
    readonly args: readonly string[];
  }> {
    const appPath = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe";
    for (const hive of ["HKCU", "HKLM", "HKLM\\Software\\WOW6432Node"]) {
      const key =
        hive === "HKLM\\Software\\WOW6432Node"
          ? `${hive}\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`
          : `${hive}\\${appPath}`;
      const query = await captureHiddenChildResult(
        this.#spawn,
        "reg.exe",
        ["query", key, "/ve"],
        15_000,
      );
      if (query.code !== 0) continue;
      const executable = parseWindowsRegistryStringValue(query.stdout);
      if (
        executable === undefined ||
        !isAbsolute(executable) ||
        basename(executable).toLowerCase() !== "chrome.exe" ||
        !(await stat(executable).catch(() => undefined))?.isFile()
      )
        continue;
      return {
        executable,
        args: [`--profile-directory=${profileDirectory}`, "--new-window", "about:blank"],
      };
    }
    throw new Error("Installed Chrome executable could not be confirmed in Windows App Paths");
  }

  /**
   * The bundled diagnostic currently recognizes only the English `(Default)`
   * label emitted by reg.exe. A hidden child on a localized Windows desktop can
   * instead emit the translated label, causing the diagnostic to report a
   * missing key even though the registration exists. Confirm the same key and
   * manifest path without depending on that localized label.
   */
  async #localizedWindowsRegistryRegistrationIsCorrect(
    nativeHost: OfficialChromeNativeHostState,
  ): Promise<boolean> {
    if (
      process.platform !== "win32" ||
      nativeHost.exists !== true ||
      nativeHost.registryKey === undefined ||
      nativeHost.manifestPath === undefined
    ) {
      return false;
    }
    const query = await captureHiddenChildResult(
      this.#spawn,
      "reg.exe",
      ["query", nativeHost.registryKey, "/ve"],
      15_000,
    );
    if (query.code !== 0) return false;
    const registeredManifestPath = parseWindowsRegistryStringValue(query.stdout);
    return (
      registeredManifestPath !== undefined &&
      canonicalWindowsPath(registeredManifestPath) === canonicalWindowsPath(nativeHost.manifestPath)
    );
  }

  async #selectedProfileIsRunning(extension: OfficialChromeExtensionState): Promise<boolean> {
    const processes = await this.#inspectRunningProcesses("chrome.exe");
    if (
      processes.some((processIdentity) =>
        chromeBrowserProcessUsesSelectedProfile(processIdentity, extension),
      )
    )
      return true;
    if (
      !processes.some((processIdentity) =>
        chromeProcessUsesUserData(processIdentity, extension.userDataDirectory),
      )
    )
      return false;
    try {
      const data: unknown = JSON.parse(
        await readFile(join(extension.userDataDirectory, "Local State"), "utf8"),
      );
      const profile =
        data !== null && typeof data === "object" ? Reflect.get(data, "profile") : undefined;
      const active =
        profile !== null && typeof profile === "object"
          ? Reflect.get(profile, "last_active_profiles")
          : undefined;
      return Array.isArray(active)
        ? active.some(
            (directory) =>
              typeof directory === "string" &&
              sameChromeProfile(directory, extension.selectedProfileDirectory),
          )
        : true;
    } catch {
      // An existing browser with unknown profile state should be reconnected,
      // not duplicated while its active windows are uncertain.
      return true;
    }
  }

  async #warmup(): Promise<void> {
    if (this.#warmupMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.#warmupMs);
      });
    }
  }
}

function chromeRecoveryKey(request: BrowserNativeContextRequest): string {
  if (request.operation === "list_surfaces") return "list_surfaces";
  return JSON.stringify([
    request.ownerBinding ?? "global",
    request.workSessionBinding ?? request.callerSessionId ?? request.contextThreadId ?? "global",
    request.browserId ?? "default",
  ]);
}

function waitForChromeRecoveryFlight(flight: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return flight;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = (action: () => void): void => {
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void flight.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function selectedChromeProfile(extension: OfficialChromeExtensionState): PreferredChromeProfile {
  const directory = extension.selectedProfileDirectory;
  if (
    !isAbsolute(extension.userDataDirectory) ||
    !directory ||
    directory === "." ||
    directory === ".." ||
    basename(directory) !== directory ||
    directory.includes("/") ||
    directory.includes("\\")
  ) {
    throw new Error("CHROME_PROFILE_INVALID: diagnostic returned an invalid profile location");
  }
  return {
    preferencesPath: join(extension.userDataDirectory, directory, "Preferences"),
    profileDirectory: directory,
    userDataDirectory: extension.userDataDirectory,
  };
}

async function findUniqueChromeProfile(
  officialUserDataDirectory: string,
  profileName: string,
  processes: readonly RecoveredWindowsProcessIdentity[],
): Promise<PreferredChromeProfile | undefined> {
  const roots = new Set([officialUserDataDirectory]);
  for (const processIdentity of processes) {
    if (
      processIdentity.name.toLowerCase() !== "chrome.exe" ||
      chromiumSwitchValue(processIdentity.commandLine, "type") !== undefined
    )
      continue;
    const root = chromiumSwitchValue(processIdentity.commandLine, "user-data-dir");
    if (root !== undefined && isAbsolute(root)) roots.add(root);
  }
  const matches = new Map<string, PreferredChromeProfile>();
  for (const root of roots) {
    try {
      const data: unknown = JSON.parse(await readFile(join(root, "Local State"), "utf8"));
      if (data === null || typeof data !== "object") continue;
      const profile = Reflect.get(data, "profile");
      const profiles =
        profile !== null && typeof profile === "object"
          ? Reflect.get(profile, "info_cache")
          : undefined;
      if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) continue;
      for (const [directory, info] of Object.entries(profiles)) {
        if (info === null || typeof info !== "object" || Reflect.get(info, "name") !== profileName)
          continue;
        const candidate = selectedChromeProfile({
          userDataDirectory: root,
          selectedProfileDirectory: directory,
          installed: true,
          enabled: true,
          disableReasons: [],
        });
        if (!(await stat(candidate.preferencesPath).catch(() => undefined))?.isFile()) continue;
        matches.set(canonicalWindowsPath(candidate.preferencesPath), candidate);
      }
    } catch {
      // An unreadable root cannot identify the requested existing profile.
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function sameChromeProfile(first: string, second: string): boolean {
  return first.localeCompare(second, "en", { sensitivity: "accent" }) === 0;
}

function parseOfficialChromeRuntimeState(value: string): OfficialChromeRuntimeState {
  const parsed = parseOfficialChromeDiagnostic(value, "runtime");
  if (typeof parsed.running !== "boolean") {
    throw new Error("Installed Chrome runtime diagnostic returned an unsupported contract");
  }
  return { running: parsed.running };
}

function parseOfficialChromeExtensionState(value: string): OfficialChromeExtensionState {
  const parsed = parseOfficialChromeDiagnostic(value, "extension");
  if (
    typeof parsed.installed !== "boolean" ||
    typeof parsed.enabled !== "boolean" ||
    typeof parsed.userDataDirectory !== "string" ||
    parsed.userDataDirectory.length === 0 ||
    typeof parsed.selectedProfileDirectory !== "string" ||
    parsed.selectedProfileDirectory.length === 0
  ) {
    throw new Error("Installed Chrome extension diagnostic returned an unsupported contract");
  }
  const selected = Array.isArray(parsed.profiles)
    ? parsed.profiles.find(
        (profile: unknown) =>
          profile !== null &&
          typeof profile === "object" &&
          Reflect.get(profile, "profileDirectory") === parsed.selectedProfileDirectory,
      )
    : undefined;
  const reasons: unknown = selected !== undefined ? Reflect.get(selected, "disableReasons") : [];
  return {
    installed: parsed.installed,
    enabled: parsed.enabled,
    userDataDirectory: parsed.userDataDirectory,
    selectedProfileDirectory: parsed.selectedProfileDirectory,
    disableReasons: Array.isArray(reasons)
      ? reasons.filter((reason): reason is number => Number.isSafeInteger(reason) && reason >= 0)
      : [],
  };
}

function chromeBrowserProcessUsesSelectedProfile(
  processIdentity: RecoveredWindowsProcessIdentity,
  extension: OfficialChromeExtensionState,
): boolean {
  if (!chromeProcessUsesUserData(processIdentity, extension.userDataDirectory)) return false;
  const actualProfileDirectory = chromiumSwitchValue(
    processIdentity.commandLine,
    "profile-directory",
  );
  return (
    actualProfileDirectory !== undefined &&
    sameChromeProfile(actualProfileDirectory, extension.selectedProfileDirectory)
  );
}

function isInteractiveChromeProcess(processIdentity: RecoveredWindowsProcessIdentity): boolean {
  return (
    processIdentity.name.toLowerCase() === "chrome.exe" &&
    chromiumSwitchValue(processIdentity.commandLine, "type") === undefined &&
    !/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/iu.test(processIdentity.commandLine)
  );
}

function chromeProcessUsesUserData(
  processIdentity: RecoveredWindowsProcessIdentity,
  userDataDirectory: string,
): boolean {
  if (!isInteractiveChromeProcess(processIdentity)) return false;
  const explicitDirectory = chromiumSwitchValue(processIdentity.commandLine, "user-data-dir");
  const defaultDirectory =
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data");
  const actualDirectory = explicitDirectory ?? defaultDirectory;
  return (
    actualDirectory !== undefined &&
    canonicalWindowsPath(actualDirectory) === canonicalWindowsPath(userDataDirectory)
  );
}

function chromiumSwitchValue(commandLine: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\s)--${escaped}=(?:"([^"]*)"|(\\S+))`, "iu").exec(commandLine);
  return match?.[1] ?? match?.[2];
}

function canonicalWindowsPath(value: string): string {
  return normalize(resolve(value)).toLocaleLowerCase("en-US");
}

function parseOfficialChromeNativeHostState(value: string): OfficialChromeNativeHostState {
  const parsed = parseOfficialChromeDiagnostic(value, "native host");
  if (typeof parsed.correct !== "boolean") {
    throw new Error("Installed Chrome native-host diagnostic returned an unsupported contract");
  }
  return {
    correct: parsed.correct,
    ...(typeof parsed.problem === "string" && parsed.problem.length > 0
      ? { problem: parsed.problem }
      : {}),
    ...(typeof parsed.exists === "boolean" ? { exists: parsed.exists } : {}),
    ...(typeof parsed.manifestPath === "string" && parsed.manifestPath.length > 0
      ? { manifestPath: parsed.manifestPath }
      : {}),
    ...(typeof parsed.registryKey === "string" && parsed.registryKey.length > 0
      ? { registryKey: parsed.registryKey }
      : {}),
  };
}

function parseWindowsRegistryStringValue(value: string): string | undefined {
  for (const line of value.split(/\r?\n/u)) {
    const match = /\bREG_SZ\s+(.+?)\s*$/iu.exec(line);
    if (match?.[1] !== undefined) return match[1].replace(/^"(.*)"$/u, "$1");
  }
  return undefined;
}

function parseOfficialChromeDiagnostic(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Installed Chrome ${name} diagnostic returned invalid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Installed Chrome ${name} diagnostic returned an unsupported contract`);
  }
  return parsed as Record<string, unknown>;
}

function isChromeExtensionRequest(request: BrowserNativeContextRequest): boolean {
  return (
    request.operation !== "list_surfaces" &&
    (request.surface === "chrome" || request.surface === "extension")
  );
}

function parseOfficialChromeLaunchPlan(value: string): OfficialChromeLaunchPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Installed Chrome helper returned invalid launch metadata", { cause: error });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Reflect.get(parsed, "browserFamily") !== "chrome" ||
    Reflect.get(parsed, "dryRun") !== true ||
    typeof Reflect.get(parsed, "profileDirectory") !== "string" ||
    typeof Reflect.get(parsed, "command") !== "string" ||
    !Array.isArray(Reflect.get(parsed, "args")) ||
    !(Reflect.get(parsed, "args") as unknown[]).every((item) => typeof item === "string")
  ) {
    throw new Error("Installed Chrome helper returned an unsupported launch contract");
  }
  return parsed as OfficialChromeLaunchPlan;
}

function directChromeLaunch(plan: OfficialChromeLaunchPlan): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  const executableIndex = plan.args.findIndex(
    (value) =>
      isAbsolute(value) &&
      (basename(value).toLowerCase() === "chrome.exe" ||
        basename(value).toLowerCase() === "google-chrome.exe"),
  );
  if (executableIndex < 0) {
    throw new Error("Installed Chrome helper did not resolve a Chrome executable");
  }
  const executable = plan.args[executableIndex];
  if (executable === undefined) throw new Error("Installed Chrome executable is missing");
  const args = plan.args.slice(executableIndex + 1);
  const profileArguments = args.filter((value) => {
    const normalized = value.toLowerCase();
    return normalized === "--profile-directory" || normalized.startsWith("--profile-directory=");
  });
  if (
    profileArguments.length !== 1 ||
    profileArguments[0] !== `--profile-directory=${plan.profileDirectory}`
  ) {
    throw new Error("Installed Chrome helper did not bind the selected profile");
  }
  return { executable, args };
}

function captureHiddenChild(
  spawn: HiddenSpawner,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  return captureHiddenChildResult(spawn, executable, args, timeoutMs, environment).then(
    (result) => {
      if (result.code === 0) return result.stdout;
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Installed Chrome helper exited with code ${String(result.code)}`,
      );
    },
  );
}

function captureHiddenChildResult(
  spawn: HiddenSpawner,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment?: NodeJS.ProcessEnv,
): Promise<HiddenChildResult> {
  // The installed diagnostics use execFileSync for reg/tasklist, but do not
  // all pass windowsHide. Scope the option correction to this helper process;
  // do not edit the installed plugin or the user's environment.
  const preload = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const original = childProcess.execFileSync;",
    'childProcess.execFileSync = (file, argv, options) => original(file, argv, { ...(typeof options === "string" ? { encoding: options } : options), windowsHide: true, shell: false });',
    "syncBuiltinESMExports();",
  ].join("\n");
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(args[0]?.endsWith(".js") !== true
      ? {}
      : {
          env: {
            ...process.env,
            ...environment,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import=data:text/javascript,${encodeURIComponent(preload)}`,
            ]
              .filter(Boolean)
              .join(" "),
          },
        }),
  });
  return new Promise<HiddenChildResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Installed Chrome helper did not finish")));
    }, timeoutMs);
    timer.unref?.();
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
        });
      });
    });
  });
}

function spawnDetached(
  spawn: HiddenSpawner,
  executable: string,
  args: readonly string[],
): Promise<void> {
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("spawn", () =>
      finish(() => {
        child.unref();
        resolve();
      }),
    );
  });
}
