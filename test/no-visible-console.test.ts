import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const scriptsRoot = join(process.cwd(), "scripts");
const processBoundary = "infrastructure/windows/hidden-child-process.ts";

describe("absolute no-visible-console invariant", () => {
  it("forbids direct child_process use outside the hidden launch boundary", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const normalized = relative(sourceRoot, file).replaceAll("\\", "/");
      if (normalized === processBoundary) {
        continue;
      }
      const contents = await readFile(file, "utf8");
      if (/from\s+["']node:child_process["']/.test(contents)) {
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
      if (/\bprocess\.kill\s*\(|\.kill\s*\(/.test(contents)) violations.push(normalized);
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
        if (
          /\bprocess\.kill\s*\(|\.kill\s*\(|\btaskkill\b|\bStop-Process\b|\bGet-(?:NetTCPConnection|Process)\b|\b(?:netstat|wmic)\b/i.test(
            contents,
          )
        ) {
          violations.push(normalized);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not launch cmd, PowerShell, pwsh, or Windows Terminal", async () => {
    const forbidden =
      /(?:spawnHidden|spawn|execFile)\s*\(\s*["'](?:cmd|powershell|pwsh|wt)(?:\.exe)?["']/i;
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const contents = await readFile(file, "utf8");
      if (forbidden.test(contents)) {
        violations.push(relative(sourceRoot, file).replaceAll("\\", "/"));
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
    } else if (extname(entry.name) === ".ts") {
      files.push(path);
    }
  }
  return files;
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
