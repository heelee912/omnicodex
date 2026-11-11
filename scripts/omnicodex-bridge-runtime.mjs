import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let browserAgentPromise;
let browserClientPath;
let skyEntryPath;

export async function listBrowserSurfaces() {
  const agent = await browserAgent();
  const surfaces = await agent.browsers.list();
  return surfaces.map(({ id, family, type, name }) => ({ id, family: family ?? null, type, name }));
}

export async function getBrowser(surface) {
  const agent = await browserAgent();
  const surfaces = await agent.browsers.list();
  const selected = surfaces.find((candidate) => matchesBrowserSurface(candidate, surface));
  if (selected == null) throw new Error(`Browser is not available: ${surface}`);
  return agent.browsers.get(selected.id);
}

export async function getCurrentUserTab(surface) {
  const browser = await getBrowser(surface);
  const [current] = await browser.user.openTabs();
  if (current == null) return null;
  const { id, providerTabId, title, url, lastOpened, tabGroup } = current;
  return {
    id,
    providerTabId: providerTabId ?? null,
    title: title ?? null,
    url: url ?? null,
    lastOpened: lastOpened ?? null,
    tabGroup: tabGroup ?? null,
  };
}

export async function claimCurrentUserTab(surface) {
  const browser = await getBrowser(surface);
  const [current] = await browser.user.openTabs();
  if (current == null) throw new Error(`No open user tab is available in: ${surface}`);
  return browser.user.claimTab(current);
}

export async function computerUse(method, args = {}) {
  if (!computerUseMethods.has(method)) throw new Error(`Unknown Computer Use method: ${method}`);
  const { sky } = await import(pathToFileURL(await locateSkyEntry()).href);
  return method === "list_apps" || method === "list_windows" ? sky[method]() : sky[method](args);
}

async function browserAgent() {
  browserAgentPromise ??= (async () => {
    const { setupBrowserRuntime } = await import(pathToFileURL(await locateBrowserClient()).href);
    return setupBrowserRuntime();
  })();
  return browserAgentPromise;
}

function matchesBrowserSurface(candidate, surface) {
  if (surface === "chrome") return candidate.type === "extension" && candidate.family === "chrome";
  if (surface === "iab") return candidate.type === "iab";
  if (surface === "edge") return candidate.type === "extension" && candidate.family === "edge";
  if (surface === "extension") return candidate.type === "extension";
  if (surface === "default") return candidate.type === "iab" || candidate.type === "extension";
  throw new Error("Browser surface must be chrome, iab, edge, extension, or default");
}

async function locateBrowserClient() {
  if (browserClientPath !== undefined) return browserClientPath;
  const codexHome = join(homedir(), ".codex");
  const root = join(codexHome, "plugins", "cache", "openai-bundled");
  const candidates = [];
  for (const plugin of ["browser", "chrome", "chrome-internal", "chrome-dev"]) {
    const pluginRoot = join(root, plugin);
    let versions;
    try {
      versions = await readdir(pluginRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions.filter((entry) => entry.isDirectory())) {
      const path = join(pluginRoot, version.name, "scripts", "browser-client.mjs");
      try {
        candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs });
      } catch {
        // Ignore incomplete plugin versions.
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path, "en"),
  );
  browserClientPath = candidates[0]?.path;
  if (!browserClientPath) throw new Error("Installed Codex Browser runtime was not found");
  return browserClientPath;
}

async function locateSkyEntry() {
  if (skyEntryPath !== undefined) return skyEntryPath;
  const programFiles = "C:\\Program Files";
  const windowsApps = join(programFiles, "WindowsApps");
  const roots = await registeredCodexPackageRoots();
  for (const packageRoot of roots.sort((left, right) => right.localeCompare(left, "en"))) {
    const candidate = join(
      packageRoot,
      "app",
      "resources",
      "cua_node",
      "bin",
      "node_modules",
      "@oai",
      "sky",
      "dist",
      "project",
      "cua",
      "sky_js",
      "src",
      "index.js",
    );
    try {
      await access(candidate);
      skyEntryPath = candidate;
      return candidate;
    } catch {
      // Try the next registered package.
    }
  }
  throw new Error(`Installed Codex Computer Use runtime was not found under ${windowsApps}`);
}

async function registeredCodexPackageRoots() {
  if (platform() !== "win32") return [];
  const reg = join("C:\\Windows", "System32", "reg.exe");
  const key =
    "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
  const output = await execFileHidden(reg, ["query", key, "/s", "/f", "OpenAI.Codex_"]);
  return [...output.matchAll(/^\s*PackageRootFolder\s+REG_[A-Z_]+\s+(.+)$/gim)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
}

function execFileHidden(executable, args) {
  return new Promise((resolveOutput, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
  });
}

const computerUseMethods = new Set([
  "list_apps",
  "list_windows",
  "get_window",
  "launch_app",
  "get_window_state",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
]);
