import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserNativeExecutor } from "../src/application/browser-native-executor.js";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const apiReference = "## API reference\n### Tabs\nRead the selected browser tabs.";

async function readGeneratedDocumentation(
  installedDocument: string,
  name?: string,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-documentation-syntax-"));
  const clientPath = join(
    root,
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    "1.0.0",
    "scripts",
    "browser-client.mjs",
  );
  await mkdir(dirname(clientPath), { recursive: true });
  await writeFile(clientPath, "export const setupBrowserRuntime = async () => ({});", "utf8");
  const writes: unknown[] = [];
  const agent = {
    browsers: {
      list: async () => [{ id: "1", type: "extension", family: "chrome", name: "Chrome" }],
      get: async () => ({ browserId: "1", documentation: async () => installedDocument }),
      getDefault: async () => ({ browserId: "1", documentation: async () => installedDocument }),
    },
    documentation: { get: async () => installedDocument },
  };
  const isolatedGlobal = { __omniCodexBrowserPhysicalRuntimes: new Map() };
  const executor = new BrowserNativeExecutor(
    {
      callInContext: async (_server, tool, args) => {
        if (tool !== "js") return { content: [] };
        const { code } = args as { readonly code: string };
        const binding = /^\s*const __omniBrowserSessionId = ("[^"]+");$/mu.exec(code);
        const sessionId = binding?.[1];
        if (sessionId === undefined) throw new Error("Generated browser session id is missing");
        isolatedGlobal.__omniCodexBrowserPhysicalRuntimes.set(JSON.parse(sessionId), { agent });
        // Parse and execute the whole generated bootstrap, including its regex literals.
        await new AsyncFunction("globalThis", "nodeRepl", code)(isolatedGlobal, {
          write: (value: unknown) => writes.push(value),
        });
        return { content: [] };
      },
    },
    { codexHome: root, resolveContextThreadId: async () => "documentation-test-host" },
  );
  try {
    await executor.call({
      operation: "documentation",
      surface: "chrome",
      ...(name === undefined ? {} : { documentation_name: name }),
    });
    expect(writes).toHaveLength(1);
    return writes[0];
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true });
  }
}

function installedDocument(lineEnding: string): string {
  return [
    "# Installed browser instructions",
    "Installed prose before the API.",
    ...apiReference.split("\n"),
    "## node_repl + workflows",
    "* REPL state persists: exact installed wording.",
    "Installed prose after the API.",
  ].join(lineEnding);
}

describe("generated Chrome documentation JavaScript", () => {
  it("returns the exact protected Korean policy without starting the native browser runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-policy-documentation-"));
    const protectedRoot = join(root, "protected-confirmation-docs");
    const markdown = "# 브라우저 확인 정책\n\n보호 원본 문서입니다.\n";
    await mkdir(protectedRoot);
    await writeFile(join(protectedRoot, "chrome-confirmations.md"), markdown, "utf8");
    const writeManifest = (content: string) =>
      writeFile(
        join(protectedRoot, "manifest.json"),
        JSON.stringify([
          {
            Source: join(protectedRoot, "chrome-confirmations.md"),
            SHA256: createHash("sha256").update(content, "utf8").digest("hex"),
          },
        ]),
        "utf8",
      );
    await writeManifest(markdown);
    const nativeCall = vi.fn(async () => {
      throw new Error("native runtime must not be needed for a protected policy");
    });
    const executor = new BrowserNativeExecutor({ callInContext: nativeCall }, { codexHome: root });
    try {
      await expect(
        executor.call({
          operation: "documentation",
          surface: "chrome",
          documentation_name: "confirmations",
        }),
      ).resolves.toEqual({ content: [{ type: "text", text: markdown }] });
      expect(nativeCall).not.toHaveBeenCalled();

      const revised = "# 브라우저 확인 정책\n\n수정된 보호 원본입니다.\n";
      await writeFile(join(protectedRoot, "chrome-confirmations.md"), revised, "utf8");
      await expect(
        executor.call({
          operation: "documentation",
          surface: "chrome",
          documentation_name: "confirmations",
        }),
      ).rejects.toThrow("hash mismatch");
      await writeManifest(revised);
      await expect(
        executor.call({
          operation: "documentation",
          surface: "chrome",
          documentation_name: "confirmations",
        }),
      ).resolves.toEqual({ content: [{ type: "text", text: revised }] });
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the protected policy is missing instead of returning installed text", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-policy-missing-"));
    const nativeCall = vi.fn();
    const executor = new BrowserNativeExecutor({ callInContext: nativeCall }, { codexHome: root });
    try {
      await expect(
        executor.call({
          operation: "documentation",
          surface: "chrome",
          documentation_name: "confirmations",
        }),
      ).rejects.toThrow();
      expect(nativeCall).not.toHaveBeenCalled();
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the protected computer-use guide with a level-two Markdown heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-protected-computer-use-"));
    const protectedRoot = join(root, "protected-confirmation-docs");
    const markdown = "## 컴퓨터 사용 안내\n\n보호 원본 문서입니다.\n";
    await mkdir(protectedRoot);
    await writeFile(join(protectedRoot, "computer-use-guidance.md"), markdown, "utf8");
    await writeFile(
      join(protectedRoot, "manifest.json"),
      JSON.stringify([
        {
          Source: join(protectedRoot, "computer-use-guidance.md"),
          SHA256: createHash("sha256").update(markdown, "utf8").digest("hex"),
        },
      ]),
      "utf8",
    );
    const nativeCall = vi.fn(async () => {
      throw new Error("native runtime must not be needed for a protected policy");
    });
    const executor = new BrowserNativeExecutor({ callInContext: nativeCall }, { codexHome: root });
    try {
      await expect(
        executor.call({
          operation: "documentation",
          surface: "chrome",
          documentation_name: "computer-use-guidance",
        }),
      ).resolves.toEqual({ content: [{ type: "text", text: markdown }] });
      expect(nativeCall).not.toHaveBeenCalled();
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["\n", "\r\n"])(
    "forwards complete default runtime documentation (%j)",
    async (lineEnding) => {
      const document = installedDocument(lineEnding);
      expect(await readGeneratedDocumentation(document)).toBe(document);
    },
  );

  it.each(["\n", "\r\n"])(
    "preserves the complete named document without rewriting it (%j)",
    async (lineEnding) => {
      const document = installedDocument(lineEnding);
      expect(await readGeneratedDocumentation(document, "browser-api")).toBe(document);
    },
  );

  it("preserves named screenshot guidance without an API heading", async () => {
    const document =
      "# Screenshots\nUse the image helper.\nKeep the complete example: C:\\tmp\\image.png\n";
    expect(await readGeneratedDocumentation(document, "screenshots")).toBe(document);
  });

  it("leaves nested API sections to the installed protected reader", async () => {
    const document = [
      "# API Reference",
      "Complete reference.",
      "## Browser profile selection",
      "Runtime API reference.",
      "### Profile details",
      "Profile API.",
      "## Tabs",
      "Tabs API.",
      "### Read",
      "Read API.",
    ].join("\n");
    expect(await readGeneratedDocumentation(document)).toBe(document);
  });
});
