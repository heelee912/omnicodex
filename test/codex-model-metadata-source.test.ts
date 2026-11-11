import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexModelMetadataSource } from "../src/infrastructure/runtime/codex-model-metadata-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexModelMetadataSource", () => {
  it("returns the exact installed descriptor without field or size filtering", async () => {
    const root = await temporaryCodexHome();
    const rawModel = {
      slug: "gpt-5.6-sol",
      context_window: 272_000,
      max_context_window: 872_000,
      effective_context_window_percent: 95,
      truncation_policy: { mode: "tokens", limit: 10_000 },
      shell_type: "unified_exec",
      use_responses_lite: true,
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      unknown_nested_field: { unicode: "원본 그대로 🧪", large: "값".repeat(40_000) },
    };
    await writeCache(root, {
      fetched_at: "2026-08-29T01:02:03Z",
      etag: "exact-etag",
      client_version: "0.150.0",
      models: [{ slug: "other" }, rawModel],
    });

    const snapshot = await new CodexModelMetadataSource({ codexHome: root }).read("gpt-5.6-sol");

    expect(snapshot.rawModel).toEqual(rawModel);
    expect(snapshot).toMatchObject({
      fetchedAt: "2026-08-29T01:02:03Z",
      etag: "exact-etag",
      clientVersion: "0.150.0",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rawModel)).toBe(true);
    expect(Object.isFrozen(snapshot.rawModel.unknown_nested_field)).toBe(true);
  });

  it("keys the digest only to the raw model descriptor", async () => {
    const root = await temporaryCodexHome();
    const source = new CodexModelMetadataSource({ codexHome: root });
    const model = { slug: "gpt-5.6-sol", context_window: 272_000 };
    await writeCache(root, { fetched_at: "first", models: [model] });
    const first = await source.read("gpt-5.6-sol");

    await writeCache(root, { fetched_at: "second", models: [model] });
    const refreshed = await source.read("gpt-5.6-sol");
    expect(refreshed.modelDigest).toBe(first.modelDigest);

    await writeCache(root, {
      fetched_at: "third",
      models: [{ ...model, context_window: 273_000 }],
    });
    const changed = await source.read("gpt-5.6-sol");
    expect(changed.modelDigest).not.toBe(first.modelDigest);
  });

  it("fails explicitly for missing, duplicate, or invalid model records", async () => {
    const root = await temporaryCodexHome();
    const source = new CodexModelMetadataSource({ codexHome: root });

    await writeCache(root, { models: [] });
    await expect(source.read("gpt-5.6-sol")).rejects.toThrow("found 0");

    await writeCache(root, {
      models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.6-sol" }],
    });
    await expect(source.read("gpt-5.6-sol")).rejects.toThrow("found 2");

    await writeFile(join(root, "models_cache.json"), "[]", "utf8");
    await expect(source.read("gpt-5.6-sol")).rejects.toThrow("cache is invalid");
  });

  it("uses CODEX_HOME before the process home fallback", async () => {
    const configured = await temporaryCodexHome();
    const fallback = await temporaryCodexHome();
    await writeCache(configured, { models: [{ slug: "gpt-5.6-sol", source: "configured" }] });
    await writeCache(fallback, { models: [{ slug: "gpt-5.6-sol", source: "fallback" }] });

    const snapshot = await new CodexModelMetadataSource({
      env: { CODEX_HOME: configured },
      homeDirectory: fallback,
    }).read("gpt-5.6-sol");

    expect(snapshot.rawModel.source).toBe("configured");
    expect(await readFile(snapshot.cachePath, "utf8")).toContain("configured");
  });
});

async function temporaryCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicodex-models-"));
  roots.push(root);
  return root;
}

async function writeCache(root: string, value: unknown): Promise<void> {
  await writeFile(join(root, "models_cache.json"), JSON.stringify(value), "utf8");
}
