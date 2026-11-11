import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerBoundResourceStore } from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import {
  PROTECTED_RESULT_HANDLE_PREFIX,
  PROTECTED_RESULT_READ_TOOL,
  type ProtectedResultContext,
  protectOversizedResult,
  requiresProtectedResultTransport,
  withProtectedResultInlineControl,
} from "../src/infrastructure/mcp/protected-result-mapper.js";

const context: ProtectedResultContext = {
  owner: {
    issuer: "https://owner.example/",
    subject: "auth0|owner",
    clientId: "client",
    resource: "https://owner.example/mcp/full",
  },
  sessionId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("protectOversizedResult", () => {
  it.each(["browser_use", "browserUse", "codex/toolSurface"])(
    "adds a same-session read guide to a text error with %s screenshot metadata",
    async (key) => {
      const store = await resourceStore();
      const screenshot = { url: "data:image/png;base64,Zml4dHVyZQ==", tabId: "fixture-tab" };
      const error = { type: "text" as const, text: "TimeoutError: fixture chooser wait" };
      const recovery = {
        type: "text" as const,
        text: JSON.stringify({ mutationRecovery: { operationId: "fixture-operation" } }),
      };
      const input: CallToolResult = {
        isError: true,
        content: [error, recovery],
        structuredContent: { mutationRecovery: { operationId: "fixture-operation" } },
        _meta: { [key]: { screenshot } },
      };
      const original = JSON.stringify(input);
      const result = await protectOversizedResult(input, context, store);
      expect(result.content).toHaveLength(3);
      expect(result.content.slice(0, 2)).toEqual(input.content);
      expect(result.content[0]).toBe(error);
      expect(result.content[1]).toBe(recovery);
      expect(result.structuredContent).toBe(input.structuredContent);
      expect(result._meta?.[key]).toBe(input._meta?.[key]);
      expect(result.isError).toBe(true);
      expect(requiresProtectedResultTransport(input)).toBe(true);
      const guide = result.content[2];
      if (guide?.type !== "text") throw new Error("Missing visible guide");
      expect(guide.text).toContain(PROTECTED_RESULT_HANDLE_PREFIX);
      expect(guide.text).not.toContain(screenshot.url);
      const receipt = handleMetadata(result);
      const stored = await store.get(String(receipt.resourceId), context.owner);
      expect(Buffer.from(stored?.bytes ?? []).toString("utf8")).toBe(original);
      expect(JSON.stringify(input)).toBe(original);
      await expect(
        store.get(String(receipt.resourceId), { ...context.owner, subject: "other-owner" }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([0, 2 * 1024 * 1024])(
    "publishes only a secret-free guide while retaining the exact %i byte failure",
    async (size) => {
      const store = await resourceStore();
      const privateSession = {
        workSessionBinding: "private-work-binding-fixture",
        continuationToken: "private-continuation-fixture",
      };
      const nativeMeta = { privateTrace: "private-native-meta-fixture" };
      const input: CallToolResult = {
        isError: true,
        content: [
          { type: "text", text: `native-failure-${"한🙂".repeat(size / 2)}` },
          { type: "resource_link", name: "native attachment", uri: "https://example.test/file" },
        ],
        structuredContent: { original: { code: "NATIVE_FAILURE", finalRow: "last-row" } },
        _meta: { native: nativeMeta, omnicodex: { originalField: true } },
      };
      const before = JSON.stringify(input);
      const result = await protectOversizedResult(
        input,
        { ...context, retrievalSession: privateSession },
        store,
      );
      expect(result.content).toHaveLength(input.content.length + 1);
      input.content.forEach((item, index) => {
        expect(result.content[index]).toBe(item);
      });
      expect(result.structuredContent).toBe(input.structuredContent);
      expect(result._meta?.native).toBe(nativeMeta);
      expect(result._meta?.omnicodex).toMatchObject({ originalField: true });
      const control = result.content.at(-1);
      if (control?.type !== "text") throw new Error("Missing visible read guide");
      expect(Buffer.byteLength(control.text, "utf8")).toBeLessThan(16 * 1024);
      expect(control.text.startsWith(PROTECTED_RESULT_HANDLE_PREFIX)).toBe(true);
      const guide = JSON.parse(control.text.slice(PROTECTED_RESULT_HANDLE_PREFIX.length));
      expect(guide.reconstruction).toContain("snapshotIntegrity=verified");
      expect(guide.reconstruction).toContain("not completed client reconstruction");
      expect(guide.reconstruction).toContain("before JSON.parse or use");
      expect(guide.reconstruction).toContain("verification is missing");
      const privateReceipt = handleMetadata(result);
      expect(guide).toEqual({
        schemaVersion: 1,
        resourceId: privateReceipt.resourceId,
        digest: privateReceipt.digest,
        retrievalTool: PROTECTED_RESULT_READ_TOOL,
        readArguments: {
          resourceId: privateReceipt.resourceId,
          offset: 0,
          expectedDigest: privateReceipt.digest,
        },
        reconstruction: expect.stringContaining("same approved work session"),
      });
      for (const excluded of [
        ...Object.values(privateSession),
        nativeMeta.privateTrace,
        "continuationToken",
        "workSessionBinding",
        "_omnicodexSession",
        "journalCursor",
        "last-row",
        "native-failure-",
      ]) {
        expect(control.text).not.toContain(excluded);
      }
      expect(privateReceipt.readArguments).toMatchObject({ _omnicodexSession: privateSession });
      const original = await store.get(String(guide.resourceId), context.owner);
      expect(Buffer.from(original?.bytes ?? []).toString("utf8")).toBe(before);
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("preserves native accessors without extra payload traversal for the guide", async () => {
    const store = await resourceStore();
    const getter = vi.fn(() => "native accessor value");
    const item = {
      type: "text" as const,
      get text() {
        return getter();
      },
    };
    const input: CallToolResult = { isError: true, content: [item] };
    const descriptor = Object.getOwnPropertyDescriptor(item, "text");
    const result = await protectOversizedResult(input, context, store);
    expect(getter).toHaveBeenCalledOnce(); // Existing durable JSON serialization only.
    expect(result.content[0]).toBe(item);
    expect(Object.getOwnPropertyDescriptor(item, "text")).toEqual(descriptor);
  });

  it("preserves a throwing accessor failure without publishing a false read guide", async () => {
    const store = await resourceStore();
    const getter = vi.fn(() => {
      throw new Error("private-getter-fixture");
    });
    const item = {
      type: "text" as const,
      get text(): string {
        return getter();
      },
    };
    const input: CallToolResult = { isError: true, content: [item] };
    const result = await protectOversizedResult(input, context, store);
    expect(result.content).toBe(input.content);
    expect(getter).toHaveBeenCalledOnce();
    expect(result._meta?.omnicodex).toMatchObject({
      protectedResultPersistence: { status: "unavailable", nativeResultPreserved: true },
    });
    expect((await store.usage()).entryCount).toBe(0);
  });

  it.each([65537, 98305, 262145, 2097152])(
    "preserves a %i byte successful text result without storage or a read guide",
    async (size) => {
      const store = await resourceStore();
      const put = vi.spyOn(store, "put");
      const output = { stdout: "x".repeat(size), finalRow: "last-row" };
      const rawItem = { type: "function_call_output", call_id: "native-call", output };
      const input: CallToolResult = {
        content: [
          { type: "text", text: JSON.stringify(output) },
          { type: "resource_link", uri: "https://example.test/result", name: "attachment" },
        ],
        structuredContent: {
          outputType: rawItem.type,
          callId: rawItem.call_id,
          output,
          rawItem,
          rawItems: [rawItem],
        },
        _meta: { native: { full: "m".repeat(size) } },
      };
      const before = JSON.stringify(input);
      const result = await protectOversizedResult(input, context, store);
      expect(result).toBe(input);
      expect(JSON.stringify(result)).toBe(before);
      expect(requiresProtectedResultTransport(input)).toBe(false);
      expect(put).not.toHaveBeenCalled();
      expect((await store.usage()).entryCount).toBe(0);
    },
  );

  it("retains small native failures unchanged with an owner-bound receipt across restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-error-receipt-"));
    temporaryDirectories.push(dataDirectory);
    const store = new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => 0 });
    const retrievalSession = {
      workSessionBinding: "work-session-native-error",
      continuationToken: "private-continuation",
    };
    const input: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "TimeoutError: native operation timed out" }],
      structuredContent: { code: "NATIVE_TIMEOUT", details: { elapsedMs: 16_800 } },
      _meta: { nativeTrace: "trace-1", omnicodex: { originalField: true } },
    };
    const serialized = JSON.stringify(input);
    const result = await protectOversizedResult(input, { ...context, retrievalSession }, store);
    expect(result.content.slice(0, input.content.length)).toEqual(input.content);
    expect(result.content[0]).toBe(input.content[0]);
    expect(result.content).toHaveLength(input.content.length + 1);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject(input._meta ?? {});
    expect(JSON.stringify(input)).toBe(serialized);
    const metadata = result._meta?.omnicodex as {
      protectedResult: { resourceId: string; readArguments: Record<string, unknown> };
    };
    const receipt = metadata.protectedResult;
    expect(receipt).toMatchObject({
      originalIsError: true,
      ownerBound: true,
      workSessionAttributed: true,
      complete: true,
      readArguments: { _omnicodexSession: retrievalSession },
    });
    expect(receipt).not.toHaveProperty("expiresAtUnixMs");
    const reopened = new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => 86_400_000 });
    const resource = await reopened.get(receipt.resourceId, context.owner);
    expect(resource?.sessionId).toBe(context.sessionId);
    expect(Buffer.from(resource?.bytes ?? []).toString("utf8")).toBe(serialized);
    await expect(
      reopened.get(receipt.resourceId, { ...context.owner, subject: "auth0|another-owner" }),
    ).resolves.toBeUndefined();
    expect((await reopened.usage()).entryCount).toBe(1);
  });

  it("does not persist ordinary successful small read results", async () => {
    const store = await resourceStore();
    const input: CallToolResult = { content: [{ type: "text", text: "native read succeeded" }] };
    await expect(protectOversizedResult(input, context, store)).resolves.toBe(input);
    expect((await store.usage()).entryCount).toBe(0);
  });

  it("preserves the native error when receipt storage fails without leaking the storage exception", async () => {
    const store = await resourceStore();
    vi.spyOn(store, "put").mockRejectedValue(new Error("private-path secret-storage-detail"));
    const input: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "TimeoutError: native selector wait" }],
      structuredContent: { code: "TIMEOUT" },
      _meta: { native: { correlation: "native-call" } },
    };
    const result = await protectOversizedResult(input, context, store);
    expect(result.content).toBe(input.content);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({
      ...input._meta,
      omnicodex: {
        protectedResultPersistence: { status: "unavailable", nativeResultPreserved: true },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-storage-detail");
    expect(result._meta?.omnicodex).not.toHaveProperty("protectedResult");
  });

  it.each([true])(
    "preserves oversized native bodies and handles on storage failure (isError=%s)",
    async (isError) => {
      const store = await resourceStore();
      const put = vi.spyOn(store, "put").mockRejectedValue(new Error("private-storage-failure"));
      const input: CallToolResult = {
        isError,
        content: [
          { type: "text", text: "native-output".repeat(9000) },
          { type: "resource_link", uri: "https://example.test/result", name: "result" },
        ],
        structuredContent: {
          stdout: "stdout",
          stderr: "stderr",
          cell_id: "cell-1",
          jobHandle: "job-1",
          exitCode: isError ? 1 : 0,
        },
        _meta: { native: { observation: "original" }, omnicodex: { originalField: true } },
      };
      const before = JSON.stringify(input);
      const result = await protectOversizedResult(input, context, store);
      expect(put).toHaveBeenCalledOnce();
      expect(result.content).toBe(input.content);
      expect(result.structuredContent).toBe(input.structuredContent);
      expect(result.isError).toBe(isError);
      expect(result._meta).toMatchObject(input._meta ?? {});
      expect(result._meta?.omnicodex).toMatchObject({
        protectedResultPersistence: { status: "unavailable", nativeResultPreserved: true },
      });
      expect(result._meta?.omnicodex).not.toHaveProperty("protectedResult");
      expect(JSON.stringify(result)).not.toContain("private-storage-failure");
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("does not overwrite an established protected receipt or duplicate its storage", async () => {
    const store = await resourceStore();
    const result = await protectOversizedResult(
      { isError: true, content: [{ type: "text", text: "native timeout" }] },
      context,
      store,
    );
    await expect(protectOversizedResult(result, context, store)).resolves.toBe(result);
    expect((await store.usage()).entryCount).toBe(1);
  });

  it("does not publish a guide from untrusted pre-existing receipt metadata", async () => {
    const store = await resourceStore();
    const put = vi.spyOn(store, "put");
    const input: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "original native error" }],
      _meta: {
        omnicodex: {
          protectedResult: {
            resourceId: "untrusted-fixture",
            readArguments: { continuationToken: "private-fixture" },
          },
        },
      },
    };
    await expect(protectOversizedResult(input, context, store)).resolves.toBe(input);
    expect(input.content).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not alias a native event whose output differs from the semantic output", async () => {
    const store = await resourceStore();
    const output = "x".repeat(20 * 1024);
    const input: CallToolResult = {
      content: [{ type: "text", text: output }],
      structuredContent: {
        output,
        outputType: "function_call_output",
        callId: "call-7",
        rawItem: { type: "function_call_output", call_id: "call-7", output: `${output}different` },
      },
    };
    const result = await protectOversizedResult(input, context, store);
    expect(result).toBe(input);
    expect(requiresProtectedResultTransport(input)).toBe(false);
    expect((await store.usage()).entryCount).toBe(0);
  });

  it("preserves native envelopes and browser screenshots without a delivery cache", async () => {
    const store = await resourceStore();
    const output = "x".repeat(20 * 1024);
    const input: CallToolResult = {
      content: [{ type: "text", text: output }],
      structuredContent: {
        output,
        outputType: "function_call_output",
        callId: "call-7",
        rawItem: { type: "function_call_output", call_id: "call-7", output },
      },
      _meta: {
        browser_use: { screenshot: { url: `data:image/jpeg;base64,${"a".repeat(90 * 1024)}` } },
      },
    };
    const result = await protectOversizedResult(input, context, store);
    expect(result).toBe(input);
    expect(result.content).toBe(input.content);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result._meta).toBe(input._meta);
    expect(requiresProtectedResultTransport(input)).toBe(false);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("preserves the original Browser Use error and screenshot metadata", async () => {
    const store = await resourceStore();
    const previewUrl = `data:image/jpeg;base64,${Buffer.alloc(96 * 1024, 0x4a).toString("base64")}`;
    const input = {
      content: [{ type: "text", text: "No element matched selector" }],
      isError: true,
      _meta: {
        browser_use: {
          url: "https://example.test/current",
          screenshot: {
            pageUrl: "https://example.test/current",
            tabId: "tab-7",
            url: previewUrl,
          },
        },
        "codex/toolSurface": {
          kind: "browserUse",
          openTabs: [{ id: "tab-7", title: "Current", url: "https://example.test/current" }],
        },
      },
    } as unknown as CallToolResult;
    const result = await protectOversizedResult(input, context, store);

    expect(result.content.slice(0, input.content.length)).toEqual(input.content);
    expect(result.content[0]).toBe(input.content[0]);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result._meta?.browser_use).toBe(input._meta?.browser_use);
    expect(result._meta?.["codex/toolSurface"]).toBe(input._meta?.["codex/toolSurface"]);
    expect(requiresProtectedResultTransport(input)).toBe(true);
    const receipt = handleMetadata(result);
    const stored = await store.get(String(receipt.resourceId), context.owner);
    expect(Buffer.from(stored?.bytes ?? []).toString("utf8")).toBe(JSON.stringify(input));
    expect(result.content.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining(PROTECTED_RESULT_HANDLE_PREFIX),
    });
  });

  it.each([false, true])(
    "keeps a Chrome error immediate with a toolSurface preview (duplicated=%s)",
    async (duplicated) => {
      const store = await resourceStore();
      const screenshot = {
        tabId: "tab-7",
        pageUrl: "https://example.test/current",
        url: `data:image/jpeg;base64,${Buffer.alloc(1100 * 1024, 0x4a).toString("base64")}`,
      };
      const input: CallToolResult = {
        content: [
          { type: "text", text: "Timed out waiting for CDP command Page.captureScreenshot." },
        ],
        isError: true,
        _meta: {
          browser_use: { url: screenshot.pageUrl, ...(duplicated ? { screenshot } : {}) },
          "codex/toolSurface": { kind: "browserUse", screenshot, openTabIds: ["tab-7"] },
        },
      };
      const expectedJson = JSON.stringify(input);
      const result = await protectOversizedResult(input, context, store);
      expect(result.content.slice(0, input.content.length)).toEqual(input.content);
      expect(result.content[0]).toBe(input.content[0]);
      expect(result.structuredContent).toBe(input.structuredContent);
      expect(result._meta?.browser_use).toBe(input._meta?.browser_use);
      expect(result._meta?.["codex/toolSurface"]).toBe(input._meta?.["codex/toolSurface"]);
      expect(requiresProtectedResultTransport(input)).toBe(true);
      const receipt = handleMetadata(result);
      const stored = await store.get(String(receipt.resourceId), context.owner);
      expect(Buffer.from(stored?.bytes ?? []).toString("utf8")).toBe(expectedJson);
      expect(JSON.stringify(input)).toBe(expectedJson);
      expect(result.content.at(-1)).toMatchObject({
        type: "text",
        text: expect.stringContaining(PROTECTED_RESULT_HANDLE_PREFIX),
      });
    },
  );

  it("leaves a small Browser Use metadata preview byte-for-byte unchanged", async () => {
    const store = await resourceStore();
    const input = {
      content: [{ type: "text", text: "ok" }],
      _meta: {
        browser_use: {
          screenshot: {
            pageUrl: "https://example.test/current",
            tabId: "tab-7",
            url: `data:image/jpeg;base64,${Buffer.from("small-preview").toString("base64")}`,
          },
        },
      },
    } as unknown as CallToolResult;

    await expect(protectOversizedResult(input, context, store)).resolves.toBe(input);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("preserves large native image bytes and MIME without JPEG conversion or storage", async () => {
    const store = await resourceStore();
    const original = Buffer.alloc(800 * 1024, 0x5a);
    const unpadded = original.toString("base64").replace(/=+$/u, "");
    const input: CallToolResult = {
      content: [
        {
          type: "image",
          data: unpadded,
          mimeType: "image/png",
          _meta: { observationId: "native-observation", detail: "original" },
        },
      ],
    };
    const result = await protectOversizedResult(input, context, store);
    expect(result).toBe(input);
    expect(result.content).toBe(input.content);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result._meta).toBe(input._meta);
    expect(requiresProtectedResultTransport(input)).toBe(false);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
    expect(result.content[0]).toMatchObject({ data: unpadded, mimeType: "image/png" });
    const image = result.content[0];
    if (image?.type !== "image") throw new Error("Missing native image");
    expect(Buffer.from(image.data, "base64")).toEqual(original);
  });

  it("preserves the complete view_image result including duplicated original metadata", async () => {
    const store = await resourceStore();
    const data = Buffer.alloc(350 * 1024, 0x44).toString("base64");
    const input = {
      content: [{ type: "image", data, mimeType: "image/png", detail: "original" }],
      structuredContent: {
        value: JSON.stringify({
          detail: "original",
          image_url: `data:image/png;base64,${data}`,
        }),
      },
    } as unknown as CallToolResult;
    const result = await protectOversizedResult(input, context, store);

    expect(result).toBe(input);
    expect(result.content).toBe(input.content);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result._meta).toBe(input._meta);
    expect(requiresProtectedResultTransport(input)).toBe(false);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("keeps native attachment links materializable when unrelated metadata is oversized", async () => {
    const store = await resourceStore();
    const attachment = {
      type: "resource_link" as const,
      uri: "https://owner.example/files/result.pdf",
      name: "result.pdf",
      mimeType: "application/pdf",
      _meta: { nativeAttachment: { id: "attachment-1" } },
    };
    const screenshot = {
      type: "image" as const,
      data: Buffer.from("small image").toString("base64"),
      mimeType: "image/png",
    };
    const input: CallToolResult = {
      isError: true,
      content: [attachment, screenshot, { type: "text", text: "Partial result" }],
      structuredContent: { details: "x".repeat(768 * 1024), code: "PARTIAL_FAILURE" },
      _meta: { nativeTrace: "trace-1" },
    };
    const result = await protectOversizedResult(input, context, store);
    expect(result).toBe(input);
    expect(result.content).toBe(input.content);
    expect(result.structuredContent).toBe(input.structuredContent);
    expect(result._meta).toBe(input._meta);
    expect(requiresProtectedResultTransport(input)).toBe(false);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it.each(["image", "audio", "embedded-image", "embedded-audio", "embedded-video"])(
    "preserves mixed error results containing %s without any delivery storage",
    async (kind) => {
      const store = await resourceStore();
      const put = vi.spyOn(store, "put");
      const data = Buffer.alloc(1100 * 1024, 0x3a).toString("base64");
      const mimeType = kind.includes("audio")
        ? "audio/wav"
        : kind.includes("video")
          ? "video/mp4"
          : "image/png";
      const media = kind.startsWith("embedded-")
        ? {
            type: "resource",
            resource: { uri: "native://observation", mimeType, blob: data },
          }
        : { type: kind, mimeType, data };
      const input = {
        isError: true,
        content: [
          { type: "text", text: "Partial native failure\n".repeat(10_000) },
          { ...media, _meta: { observationId: "unchanged-observation", sequence: 9 } },
        ],
        structuredContent: { nativeResult: "x".repeat(256 * 1024) },
        _meta: { nativeTrace: { cursor: "exact-native-cursor" } },
      } as CallToolResult;
      const bytes = JSON.stringify(input);
      expect(requiresProtectedResultTransport(input)).toBe(false);
      const result = await protectOversizedResult(input, context, store);
      expect(result).toBe(input);
      expect(JSON.stringify(result)).toBe(bytes);
      expect(result.content).toBe(input.content);
      expect(result.structuredContent).toBe(input.structuredContent);
      expect(result._meta).toBe(input._meta);
      expect(put).not.toHaveBeenCalled();
      await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
    },
  );

  it.each(["browser_use", "browserUse", "codex/toolSurface"])(
    "preserves original %s screenshot observations without requiring protected retrieval",
    async (key) => {
      const store = await resourceStore();
      const put = vi.spyOn(store, "put");
      const input: CallToolResult = {
        content: [{ type: "text", text: "native observation" }],
        structuredContent: { nativeResult: "x".repeat(256 * 1024) },
        _meta: {
          [key]: {
            kind: "browserUse",
            screenshot: {
              id: "native-frame",
              url: "https://native.example/observation.png",
              mimeType: "image/png",
              width: 3840,
              height: 2160,
            },
          },
        },
      };
      expect(requiresProtectedResultTransport(input)).toBe(false);
      await expect(protectOversizedResult(input, context, store)).resolves.toBe(input);
      expect(put).not.toHaveBeenCalled();
      await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
    },
  );

  it("returns a small mixed result unchanged", async () => {
    const store = await resourceStore();
    const input: CallToolResult = {
      content: [
        { type: "text", text: "small text" },
        {
          type: "image",
          data: Buffer.from("small image").toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "resource",
          resource: {
            uri: "omnicodex://small-note",
            text: "small embedded text",
            mimeType: "text/plain",
          },
        },
      ],
      structuredContent: { ok: true, count: 3 },
    };

    await expect(protectOversizedResult(input, context, store)).resolves.toBe(input);
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("emits a server-authored execution header for a small immediate result", () => {
    const result = withProtectedResultInlineControl(
      { content: [{ type: "text", text: "exact descriptor" }] },
      'OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:{"executeWith":"call_native_tool"}',
    );

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"executeWith":"call_native_tool"'),
      }),
      { type: "text", text: "exact descriptor" },
    ]);
  });

  it("embeds durable read arguments so retrieval survives an MCP transport reconnect", async () => {
    const store = await resourceStore();
    const result = await protectOversizedResult(
      { isError: true, content: [{ type: "text", text: "x".repeat(256 * 1024 + 1) }] },
      {
        ...context,
        retrievalSession: {
          workSessionBinding: "wsb1_owner-conversation",
          continuationToken: "continuation-owner-conversation",
        },
      },
      store,
    );

    expect(handleMetadata(result)).toMatchObject({
      retrievalTool: PROTECTED_RESULT_READ_TOOL,
      transportSessionIndependent: true,
      readArguments: {
        resourceId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        offset: 0,
        _omnicodexSession: {
          workSessionBinding: "wsb1_owner-conversation",
          continuationToken: "continuation-owner-conversation",
        },
      },
    });
  });

  it("has no default expiry and preserves caller-selected retention", async () => {
    const store = await resourceStore();
    const withoutExpiry = await protectOversizedResult(
      { isError: true, content: [{ type: "text", text: "x".repeat(256 * 1024 + 1) }] },
      context,
      store,
    );
    expect(handleMetadata(withoutExpiry)).not.toHaveProperty("expiresAtUnixMs");

    const retainedForOneMinute = await protectOversizedResult(
      { isError: true, content: [{ type: "text", text: "y".repeat(256 * 1024 + 1) }] },
      { ...context, retentionMs: 60_000 },
      store,
    );
    expect(handleMetadata(retainedForOneMinute)).toHaveProperty("expiresAtUnixMs", 60_000);
  });
});

async function resourceStore(): Promise<OwnerBoundResourceStore> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "omnicodex-result-mapper-"));
  temporaryDirectories.push(dataDirectory);
  return new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => 0 });
}

function handleMetadata(
  item: { readonly _meta?: CallToolResult["_meta"] } | undefined,
): Record<string, unknown> {
  if (item === undefined) throw new Error("Expected protected result handle");
  const metadata = item._meta?.omnicodex;
  if (!isRecord(metadata) || !isRecord(metadata.protectedResult)) {
    throw new Error("Expected OmniCodex protected result metadata");
  }
  return metadata.protectedResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
