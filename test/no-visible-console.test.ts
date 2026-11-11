import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const scriptsRoot = join(process.cwd(), "scripts");
const processBoundary = "infrastructure/windows/hidden-child-process.ts";
const readOnlyProcessInspectionBoundary =
  "src/infrastructure/safety/windows-codex-boundary-guard.ts";
const ownedCargoBuildGuard = "scripts/windows/desktop-engine/run-cargo-with-memory-guard.mjs";
const desktopStockBridge = "scripts/windows/desktop-engine/stock-app-server-stdio.mjs";

describe("absolute no-visible-console invariant", () => {
  it("forbids direct child_process use outside the hidden launch boundary", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const normalized = relative(sourceRoot, file).replaceAll("\\", "/");
      if (normalized === processBoundary) {
        continue;
      }
      const contents = await readFile(file, "utf8");
      if (/^\s*import\s+[^;]*?\s+from\s+["']node:child_process["']/m.test(contents)) {
        violations.push(normalized);
      }
    }
    expect(violations).toEqual([]);
  });

  it("hard-codes no-shell and hidden-window creation in the boundary", async () => {
    const contents = await readFile(join(sourceRoot, processBoundary), "utf8");
    expect(contents).toContain("shell: false");
    expect(contents).toContain("windowsHide: true");
  });

  it("forbids process signaling outside the owned hidden-child boundary", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const normalized = relative(sourceRoot, file).replaceAll("\\", "/");
      if (normalized === processBoundary) continue;
      const contents = await readFile(file, "utf8");
      if (containsMutatingProcessSignal(contents)) violations.push(normalized);
    }
    expect(violations).toEqual([]);
  });

  it("forbids PID or port based cleanup in product and smoke scripts", async () => {
    const violations: string[] = [];
    for (const root of [sourceRoot, scriptsRoot]) {
      for (const file of await codeFiles(root)) {
        const normalized = relative(process.cwd(), file).replaceAll("\\", "/");
        if (normalized === `src/${processBoundary}`) continue;
        const contents = await readFile(file, "utf8");
        if (normalized === ownedCargoBuildGuard) {
          expect(contents).toContain("String(child.pid)");
          expect(contents).toContain("windowsHide: true");
          continue;
        }
        if (normalized === desktopStockBridge) {
          // Only the exact child handle created here may be terminated. PID 0 is a liveness probe.
          expect(contents).toContain("const stock = spawn(executable, desktopArgs, {");
          expect(contents).toContain("windowsHide: true");
          expect(contents.match(/\bstock\.kill\(\)/g)).toHaveLength(1);
          expect(contents.match(/\bprocess\.kill\(parentPid,\s*0\)/g)).toHaveLength(1);
          const ownedChildAndLivenessOnly = contents
            .replace("if (stock.exitCode === null) stock.kill();", "")
            .replace("process.kill(parentPid, 0);", "");
          expect(ownedChildAndLivenessOnly).not.toMatch(
            /\btaskkill\b|\bStop-Process\b|\bprocess\.kill\s*\(|\.kill\s*\(/i,
          );
          expect(ownedChildAndLivenessOnly).not.toBe(contents);
          continue;
        }
        if (normalized === readOnlyProcessInspectionBoundary) {
          expect(contents).not.toMatch(
            /\btaskkill\b|\bStop-Process\b|\bprocess\.kill\s*\(|\.kill\s*\(/i,
          );
          continue;
        }
        if (
          /\btaskkill\b|\bStop-Process\b/i.test(contents) ||
          containsMutatingProcessSignal(contents)
        ) {
          violations.push(normalized);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not launch an interactive command shell outside the audited hidden DPAPI bridge", async () => {
    const forbidden =
      /(?:spawnHidden|spawn|execFile)\s*\(\s*["'](?:cmd|powershell|pwsh|wt)(?:\.exe)?["']/i;
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const normalized = relative(sourceRoot, file).replaceAll("\\", "/");
      if (normalized === "infrastructure/windows/windows-dpapi-secret-store.ts") continue;
      const contents = await readFile(file, "utf8");
      if (forbidden.test(contents)) {
        violations.push(normalized);
      }
    }
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (extname(entry.name) === ".ts" && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

function containsMutatingProcessSignal(contents: string): boolean {
  const withoutExistenceProbes = contents.replaceAll(
    /\bprocess\.kill\s*\(\s*[^,()]+\s*,\s*0\s*\)/g,
    "",
  );
  return /\bprocess\.kill\s*\(|(?<!process)\.kill\s*\(/.test(withoutExistenceProbes);
}

async function codeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await codeFiles(path)));
    else if (extname(entry.name) === ".ts" || extname(entry.name) === ".mjs") files.push(path);
  }
  return files;
}
