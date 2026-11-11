import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runtimeFiles = [
  "application/policy-documentation-service.js",
  "application/protected-documentation-response.js",
  "domain/protected-policy-document.js",
  "infrastructure/safety/protected-policy-library.js",
  "infrastructure/runtime/stdio-app-server-router.js",
];
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stock-refresh-test-"));
  roots.push(root);
  const scripts = join(root, "scripts", "windows", "desktop-engine");
  const localAppData = join(root, "local");
  const selectedExecutable = join(root, "stock-codex.exe");
  const launcher = join(localAppData, "OmniCodex", "bin", "OmniCodexDesktopEngine.exe");
  const marker = join(root, "installer-called.json");
  await mkdir(scripts, { recursive: true });
  await copyFile(
    join(process.cwd(), "scripts", "windows", "desktop-engine", "refresh-stock-desktop-engine.mjs"),
    join(scripts, "refresh-stock-desktop-engine.mjs"),
  );
  await writeFile(join(scripts, "stock-app-server-stdio.mjs"), "fixture bridge");
  await writeFile(join(scripts, "stock-app-server-launcher.rs"), "fixture launcher source");
  await writeFile(
    join(scripts, "stock-codex-executable.mjs"),
    `export async function findStockExecutable() { return ${JSON.stringify(selectedExecutable)}; }\n` +
      `export async function readStockVersion(path) { if (path !== ${JSON.stringify(selectedExecutable)}) throw new Error('wrong executable'); return '0.165.0-test'; }\n`,
  );
  await writeFile(
    join(scripts, "install-stock-bridge.mjs"),
    `import { copyFile, mkdir, writeFile } from 'node:fs/promises';\n` +
      `import { dirname, join } from 'node:path';\n` +
      `const files = ${JSON.stringify(runtimeFiles)};\n` +
      `for (const file of files) { const target = join(${JSON.stringify(dirname(launcher))}, file); await mkdir(dirname(target), { recursive: true }); await copyFile(join(${JSON.stringify(root)}, 'dist', file), target); }\n` +
      `await writeFile(${JSON.stringify(marker)}, JSON.stringify({ mode: process.argv[2], files }));\n` +
      `console.log(JSON.stringify({ status: 'activated', launcherPath: ${JSON.stringify(launcher)} }));\n`,
  );
  for (const file of runtimeFiles) {
    const output = join(root, "dist", file);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `// protected runtime fixture: ${file}\n`);
  }
  return { root, scripts, localAppData, selectedExecutable, launcher, marker };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const base = resolve(tmpdir());
    const full = resolve(root);
    if (!full.startsWith(`${base}${sep}stock-refresh-test-`)) {
      throw new Error("Refusing to remove a path outside the test directory");
    }
    await rm(full, { recursive: true, force: true });
  }
});

async function runRefresh(context: Awaited<ReturnType<typeof fixture>>, mode: string) {
  return execFileAsync(
    process.execPath,
    [join(context.scripts, "refresh-stock-desktop-engine.mjs"), mode],
    {
      cwd: context.root,
      env: { ...process.env, LOCALAPPDATA: context.localAppData },
      windowsHide: true,
      timeout: 15_000,
    },
  );
}

describe.skipIf(process.platform !== "win32")("stock Desktop bridge refresh", () => {
  it("keeps the protected Markdown modules in the actual installer", async () => {
    const installer = await readFile(
      join(process.cwd(), "scripts", "windows", "desktop-engine", "install-stock-bridge.mjs"),
      "utf8",
    );
    for (const file of runtimeFiles) expect(installer).toContain(`"${file}"`);
  });

  it("installs existing runtime files without a TypeScript compiler or full build", async () => {
    const context = await fixture();
    const result = await runRefresh(context, "--apply");
    const outcome = JSON.parse(result.stdout);
    expect(outcome).toMatchObject({
      status: "installed",
      stockVersion: "0.165.0-test",
      activeExecutablePath: context.selectedExecutable,
      restartRequired: true,
    });
    const installation = JSON.parse(await readFile(context.marker, "utf8"));
    expect(installation).toEqual({ mode: "--activate", files: runtimeFiles });
    for (const file of runtimeFiles) {
      expect(await readFile(join(dirname(context.launcher), file))).toEqual(
        await readFile(join(context.root, "dist", file)),
      );
    }
  });

  it("fails clearly before installation if a protected Markdown runtime module is missing", async () => {
    const context = await fixture();
    const missing = join(
      context.root,
      "dist",
      "infrastructure",
      "safety",
      "protected-policy-library.js",
    );
    await rm(missing);
    await expect(runRefresh(context, "--apply")).rejects.toMatchObject({
      stderr: expect.stringContaining("Desktop runtime files are missing:"),
    });
    await expect(stat(context.marker)).rejects.toThrow();
  });

  it("reports an update without installing on the read-only check path", async () => {
    const context = await fixture();
    const result = await runRefresh(context, "--check");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "update_needed",
      stockVersion: "0.165.0-test",
    });
    await expect(stat(context.marker)).rejects.toThrow();
  });
});
