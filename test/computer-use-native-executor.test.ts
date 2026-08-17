import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerUseNativeExecutor } from "../src/application/computer-use-native-executor.js";
import type { ResponsesRuntimeExecutor } from "../src/application/responses-runtime-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ComputerUseNativeExecutor", () => {
  it("executes a first-party sky method through node_repl without a model selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-sky-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.js");
    await writeFile(entry, "export const sky = {};\n", "utf8");
    const calls: Array<{ server: string; tool: string; args: unknown }> = [];
    const responses = {
      callMcp: async (server: string, tool: string, args: unknown) => {
        calls.push({ server, tool, args });
        const code = objectValue(args).code;
        if (typeof code !== "string") throw new Error("missing generated code");
        const encodedMarker = code.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        const marker = JSON.parse(encodedMarker) as string;
        return {
          content: [
            {
              type: "text",
              text: `${marker}{"ok":true,"value":[{"id":"app-1"}]}`,
            },
          ],
        };
      },
    } as unknown as ResponsesRuntimeExecutor;
    const executor = new ComputerUseNativeExecutor(responses, { skyEntryPath: entry });

    await expect(executor.call("list_apps", {})).resolves.toEqual([{ id: "app-1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.server).toBe("node_repl");
    expect(calls[0]?.tool).toBe("js");
    const code = objectValue(calls[0]?.args).code;
    expect(code).toContain('import("@oai/sky")');
    expect(code).toContain('__omniSky["list_apps"]()');
  });

  it("passes structured action arguments without executing arbitrary method names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-sky-"));
    temporaryDirectories.push(directory);
    const entry = join(directory, "index.js");
    await writeFile(entry, "export const sky = {};\n", "utf8");
    let generatedCode = "";
    const responses = {
      callMcp: async (_server: string, _tool: string, args: unknown) => {
        generatedCode = String(objectValue(args).code);
        const encodedMarker = generatedCode.match(/console\.log\(("OMNICODEX_SKY_[^"]+:") \+/)?.[1];
        if (encodedMarker === undefined) throw new Error("missing correlation marker");
        return { text: `${JSON.parse(encodedMarker) as string}{"ok":true,"value":null}` };
      },
    } as unknown as ResponsesRuntimeExecutor;
    const executor = new ComputerUseNativeExecutor(responses, { skyEntryPath: entry });
    const window = { app: "notepad", id: 42, title: "Document" };

    await expect(executor.call("click", { window, x: 12, y: 34 })).resolves.toBeNull();
    expect(generatedCode).toContain(
      'const __omniInput = {"window":{"app":"notepad","id":42,"title":"Document"},"x":12,"y":34};',
    );
    expect(generatedCode).toContain('__omniSky["click"](__omniInput)');
    await expect(executor.call("constructor" as never, {})).rejects.toThrow(
      "Unknown Computer Use method",
    );
  });
});

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}
