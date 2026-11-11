import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("OmniCodex bridge runtime", () => {
  it("does not depend on the process global omitted by the Codex node_repl isolate", async () => {
    const source = await readFile(
      resolve(process.cwd(), "scripts", "omnicodex-bridge-runtime.mjs"),
      "utf8",
    );

    expect(source).not.toMatch(/\bprocess\s*\./u);
  });
});
