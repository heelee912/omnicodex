import { createHash } from "node:crypto";
import {
  type FileHandle,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OwnerBoundResourceStore,
  ProtectedResourceCapacityError,
} from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import type { HttpAuthorizationIdentity } from "../src/infrastructure/mcp/streamable-http-gateway.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readdir: vi.fn(original.readdir), readFile: vi.fn(original.readFile) };
});

const OWNER: HttpAuthorizationIdentity = {
  issuer: "https://issuer.example/",
  subject: "auth0|owner",
  clientId: "client-a",
  resource: "https://omnicodex.example/mcp/full",
};
const SESSION_A = "A".repeat(43);
const SESSION_B = "B".repeat(43);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OwnerBoundResourceStore", () => {
  it("skips capacity scans for unlimited byte and file admission while retaining exact results", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory: join(dataDirectory, "spool") });
    const first = await store.put(resourceInput([1, 2, 3]));
    vi.mocked(readdir).mockClear();
    const second = await store.put(resourceInput([4, 5, 6]));
    // Only the existing verified-payload lookup enumerates stored resources.
    expect(readdir).toHaveBeenCalledTimes(1);

    const sourcePath = join(dataDirectory, "source.bin");
    await writeFile(sourcePath, Uint8Array.of(7, 8, 9));
    vi.mocked(readdir).mockClear();
    const file = await store.putFile({
      owner: OWNER,
      sessionId: SESSION_A,
      mimeType: "application/octet-stream",
      path: sourcePath,
    });
    // Only attachment identity reuse enumerates stored resources.
    expect(readdir).toHaveBeenCalledTimes(1);
    expect((await store.get(first.id, OWNER))?.bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect((await store.get(second.id, OWNER))?.bytes).toEqual(Uint8Array.of(4, 5, 6));
    expect((await store.get(file.id, OWNER))?.bytes).toEqual(Uint8Array.of(7, 8, 9));
    await expect(store.usage()).resolves.toEqual({ entryCount: 3, totalBytes: 9 });
  });

  it("snapshots a local file for attachment without retaining a live source reference", async () => {
    const dataDirectory = await temporaryDirectory();
    const sourcePath = join(dataDirectory, "source.bin");
    const original = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, index) => index % 251);
    await writeFile(sourcePath, original);
    const store = new OwnerBoundResourceStore({ dataDirectory: join(dataDirectory, "spool") });

    const resource = await store.putFile({
      owner: OWNER,
      sessionId: SESSION_A,
      mimeType: "application/octet-stream",
      path: sourcePath,
    });
    await writeFile(sourcePath, Uint8Array.of(9, 9, 9));

    expect(resource).toMatchObject({
      sessionId: SESSION_A,
      mimeType: "application/octet-stream",
      byteLength: original.byteLength,
      digest: createHash("sha256").update(original).digest("base64url"),
    });
    expect((await store.get(resource.id, OWNER))?.bytes).toEqual(original);
  });

  it("reuses one durable attachment when ChatGPT retries the same unchanged local file", async () => {
    const dataDirectory = await temporaryDirectory();
    const sourcePath = join(dataDirectory, "retry.png");
    await writeFile(sourcePath, Uint8Array.of(1, 3, 3, 7));
    const store = new OwnerBoundResourceStore({ dataDirectory: join(dataDirectory, "spool") });

    const first = await store.putFile({
      owner: OWNER,
      sessionId: SESSION_A,
      mimeType: "image/png",
      path: sourcePath,
    });
    const retried = await store.putFile({
      owner: { ...OWNER, clientId: "rotated-client" },
      sessionId: SESSION_A,
      mimeType: "image/png",
      path: sourcePath,
    });

    expect(retried.id).toBe(first.id);
    await expect(store.usage()).resolves.toEqual({ entryCount: 1, totalBytes: 4 });
  });

  it("persists exact bytes across restart and OAuth client rotation for the same principal", async () => {
    const dataDirectory = await temporaryDirectory();
    const first = new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => 1_000 });
    const resource = await first.put(resourceInput([1, 2, 3]));

    expect(resource.expiresAtUnixMs).toBeUndefined();
    expect(resource.byteLength).toBe(3);
    expect(resource.digest).toBe(
      createHash("sha256")
        .update(Uint8Array.from([1, 2, 3]))
        .digest("base64url"),
    );

    const restarted = new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => 9_999_999 });
    expect((await restarted.get(resource.id, OWNER))?.bytes).toEqual(Uint8Array.from([1, 2, 3]));
    await expect(
      restarted.get(resource.id, { ...OWNER, issuer: "https://other.example/" }),
    ).resolves.toBeUndefined();
    await expect(
      restarted.get(resource.id, { ...OWNER, subject: "auth0|other" }),
    ).resolves.toBeUndefined();
    await expect(
      restarted.get(resource.id, { ...OWNER, clientId: "client-b" }),
    ).resolves.toMatchObject({ bytes: Uint8Array.from([1, 2, 3]) });
    await expect(
      restarted.get(resource.id, { ...OWNER, resource: "https://omnicodex.example/mcp" }),
    ).resolves.toBeUndefined();
    await expect(restarted.usage()).resolves.toEqual({ entryCount: 1, totalBytes: 3 });
  });

  it("applies expiry and session deletion only when explicitly requested", async () => {
    const dataDirectory = await temporaryDirectory();
    let nowUnixMs = 1_000;
    const store = new OwnerBoundResourceStore({ dataDirectory, nowUnixMs: () => nowUnixMs });
    const expiring = await store.put(resourceInput([1, 1], { ttlMs: 10 }));
    const retained = await store.put(resourceInput([2, 2, 2], { sessionId: SESSION_B }));

    nowUnixMs += 10;
    await expect(store.get(expiring.id, OWNER)).resolves.toBeUndefined();
    await expect(store.get(retained.id, OWNER)).resolves.toBeDefined();
    await expect(store.usage()).resolves.toEqual({ entryCount: 1, totalBytes: 3 });

    await store.deleteSession(SESSION_B, { reason: "user_requested" });
    await expect(store.usage()).resolves.toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it("keeps independent resource identities while hard-linking verified duplicate payload bytes", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const first = await store.put(resourceInput([7, 8, 9, 10], { sessionId: SESSION_A }));
    const second = await store.put(resourceInput([7, 8, 9, 10], { sessionId: SESSION_B }));

    expect(second.id).not.toBe(first.id);
    const firstPayload = await stat(join(dataDirectory, first.id, "payload.bin"));
    const secondPayload = await stat(join(dataDirectory, second.id, "payload.bin"));
    expect(firstPayload.dev).toBe(secondPayload.dev);
    expect(firstPayload.ino).not.toBe(0);
    expect(secondPayload.ino).toBe(firstPayload.ino);
    expect(firstPayload.nlink).toBeGreaterThanOrEqual(2);
    await store.deleteSession(SESSION_A, { reason: "user_requested" });
    expect((await store.get(second.id, OWNER))?.bytes).toEqual(Uint8Array.from([7, 8, 9, 10]));
  });

  it("deletes a durable result only for its authenticated consumer acknowledgement", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const resource = await store.put(resourceInput([4, 2, 4, 2]));

    await expect(
      store.acknowledgeConsumed(resource.id, { ...OWNER, subject: "auth0|other" }),
    ).resolves.toBe(false);
    await expect(store.get(resource.id, OWNER)).resolves.toMatchObject({
      bytes: Uint8Array.from([4, 2, 4, 2]),
    });

    await expect(store.acknowledgeConsumed(resource.id, OWNER)).resolves.toBe(true);
    await expect(store.get(resource.id, OWNER)).resolves.toBeUndefined();
  });

  it("deduplicates already stored payloads without deleting resources or changing logical usage", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const first = await store.put(resourceInput([3, 1, 4, 1, 5], { sessionId: SESSION_A }));
    const second = await store.put(resourceInput([2, 7, 1, 8], { sessionId: SESSION_B }));
    await writeFile(
      join(dataDirectory, second.id, "payload.bin"),
      Uint8Array.from([3, 1, 4, 1, 5]),
    );
    const secondManifestPath = join(dataDirectory, second.id, "manifest.json");
    const secondManifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(secondManifestPath, "utf8"),
    ) as Record<string, unknown>;
    secondManifest.digest = first.digest;
    secondManifest.byteLength = first.byteLength;
    await writeFile(secondManifestPath, JSON.stringify(secondManifest), "utf8");

    await expect(store.deduplicateExisting()).resolves.toMatchObject({
      entryCount: 2,
      duplicatePayloadsLinked: 1,
      physicalBytesSaved: 5,
    });
    await expect(store.usage()).resolves.toEqual({ entryCount: 2, totalBytes: 10 });
    const [firstPayload, secondPayload] = await Promise.all([
      stat(join(dataDirectory, first.id, "payload.bin")),
      stat(join(dataDirectory, second.id, "payload.bin")),
    ]);
    expect(secondPayload.ino).toBe(firstPayload.ino);
  });

  it("rejects a configured entry-cap overflow without evicting live resources", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory, maximumEntries: 2 });
    const first = await store.put(resourceInput([1]));
    const second = await store.put(resourceInput([2]));

    await expect(store.put(resourceInput([3]))).rejects.toMatchObject({
      code: "PROTECTED_RESOURCE_CAPACITY_EXCEEDED",
    });
    await expect(store.get(first.id, OWNER)).resolves.toBeDefined();
    await expect(store.get(second.id, OWNER)).resolves.toBeDefined();
    await expect(store.usage()).resolves.toEqual({ entryCount: 2, totalBytes: 2 });
  });

  it("rejects a configured byte-cap overflow without evicting the previous result", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory, maximumTotalBytes: 4 });
    const existing = await store.put(resourceInput([1, 2]));

    await expect(store.put(resourceInput([3, 4, 5]))).rejects.toBeInstanceOf(
      ProtectedResourceCapacityError,
    );
    expect((await store.get(existing.id, OWNER))?.bytes).toEqual(Uint8Array.from([1, 2]));
    await expect(store.usage()).resolves.toEqual({ entryCount: 1, totalBytes: 2 });
  });

  it("reads exact byte ranges without materializing or changing the stored result", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const resource = await store.put(resourceInput([0, 1, 2, 3, 4, 5, 6, 7]));

    const slice = await store.readRange(resource.id, OWNER, 2, 5);
    expect(slice).toMatchObject({
      id: resource.id,
      mimeType: "application/octet-stream",
      byteLength: 8,
      start: 2,
      endInclusive: 5,
      digest: resource.digest,
    });
    expect(slice?.bytes).toEqual(Uint8Array.from([2, 3, 4, 5]));
    expect((await store.get(resource.id, OWNER))?.bytes).toEqual(
      Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
    );
  });

  it.each(["equal-length-tail", "truncated", "extended"])(
    "rejects %s corruption before returning even an unchanged prefix or empty end range",
    async (kind) => {
      const directory = await temporaryDirectory();
      const store = new OwnerBoundResourceStore({ dataDirectory: directory });
      const original = Buffer.alloc(256 * 1024 + 17, 0x41);
      const resource = await store.put({ ...resourceInput([]), bytes: original });
      const corrupted = Buffer.from(original);
      corrupted[corrupted.length - 1] = 0x42;
      await writeFile(
        join(directory, resource.id, "payload.bin"),
        kind === "truncated"
          ? original.subarray(0, -1)
          : kind === "extended"
            ? Buffer.concat([original, Buffer.of(0)])
            : corrupted,
      );
      await expect(store.readRange(resource.id, OWNER, 0, 7)).rejects.toThrow(
        /payload (digest|size)/u,
      );
      await expect(
        store.readRange(resource.id, OWNER, original.length, original.length - 1),
      ).rejects.toThrow(/payload (digest|size)/u);
    },
  );

  it.each(["already-read-bytes", "unread-bytes", "path-replacement"])(
    "rejects %s changes during verification without returning a range",
    async (kind) => {
      const directory = await temporaryDirectory();
      const store = new OwnerBoundResourceStore({ dataDirectory: directory });
      const original = Buffer.alloc(256 * 1024 + 17, 0x41);
      const resource = await store.put({ ...resourceInput([]), bytes: original });
      const payloadPath = join(directory, resource.id, "payload.bin");
      await withFirstPayloadRead(
        async () => {
          if (kind === "path-replacement") {
            await rename(payloadPath, `${payloadPath}.original`);
            await writeFile(payloadPath, original);
          } else {
            const changed = Buffer.from(original);
            changed[kind === "already-read-bytes" ? 0 : changed.length - 1] = 0x42;
            await writeFile(payloadPath, changed);
            await utimes(payloadPath, new Date(0), new Date(10_000));
          }
        },
        async () => {
          await expect(store.readRange(resource.id, OWNER, 0, 7)).rejects.toThrow(
            "snapshot changed during verification",
          );
        },
      );
    },
  );

  it("returns only captured verified bytes when the source changes after the hash pass", async () => {
    const directory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory: directory });
    const original = Buffer.alloc(256 * 1024 + 17, 0x41);
    const resource = await store.put({ ...resourceInput([]), bytes: original });
    const originalReadFile = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).readFile;
    let manifestReads = 0;
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const bytes = await Reflect.apply(originalReadFile, undefined, args);
      if (String(args[0]).endsWith("manifest.json") && ++manifestReads === 2) {
        await writeFile(
          join(directory, resource.id, "payload.bin"),
          Buffer.alloc(original.length, 0x42),
        );
      }
      return bytes;
    }) as typeof readFile);
    try {
      const slice = await store.readRange(resource.id, OWNER, 0, 7);
      expect(slice?.bytes).toEqual(Uint8Array.from(original.subarray(0, 8)));
      expect(manifestReads).toBe(2);
      await expect(store.readRange(resource.id, OWNER, 0, 7)).rejects.toThrow(
        "digest does not match",
      );
    } finally {
      vi.mocked(readFile).mockImplementation(originalReadFile);
    }
  });

  it.each(["owner", "session", "expiry"])(
    "rechecks %s attribution after verification",
    async (kind) => {
      const directory = await temporaryDirectory();
      let now = 0;
      const store = new OwnerBoundResourceStore({ dataDirectory: directory, nowUnixMs: () => now });
      const resource = await store.put({
        ...resourceInput([]),
        bytes: Buffer.alloc(128 * 1024, 0x41),
        ttlMs: 60_000,
      });
      await withFirstPayloadRead(
        async () => {
          if (kind === "expiry") {
            now = 60_001;
            return;
          }
          const path = join(directory, resource.id, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          if (kind === "owner") manifest.ownerBindingDigest = "f".repeat(64);
          else manifest.sessionId = SESSION_B;
          await writeFile(path, JSON.stringify(manifest));
        },
        async () => {
          if (kind === "session")
            await expect(store.readRange(resource.id, OWNER, 0, 7)).rejects.toThrow(
              "manifest changed during verification",
            );
          else await expect(store.readRange(resource.id, OWNER, 0, 7)).resolves.toBeUndefined();
        },
      );
    },
  );

  it("hashes the complete snapshot once with bounded buffers and performs no post-verification payload read", async () => {
    const directory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory: directory });
    const original = Buffer.alloc(512 * 1024 + 257, 0x41);
    const resource = await store.put({ ...resourceInput([]), bytes: original });
    const probe = await open(join(directory, resource.id, "payload.bin"), "r");
    const prototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
    await probe.close();
    const spy = vi.spyOn(prototype, "read");
    try {
      const slice = await store.readRange(resource.id, OWNER, 65_530, 65_545);
      expect(slice?.bytes).toEqual(Uint8Array.from(original.subarray(65_530, 65_546)));
      expect(spy).toHaveBeenCalledTimes(9);
      const reads = spy.mock.calls as unknown as readonly [Buffer, number, number, number][];
      expect(reads.map((call) => call[3])).toEqual(
        Array.from({ length: 9 }, (_, index) => index * 64 * 1024),
      );
      for (const call of reads) {
        expect(call[0].byteLength).toBeLessThanOrEqual(64 * 1024);
        expect(call[2]).toBeLessThanOrEqual(64 * 1024);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("verifies empty snapshots and rejects unauthorized range reads", async () => {
    const directory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory: directory });
    const resource = await store.put(resourceInput([]));
    expect((await store.readRange(resource.id, OWNER, 0, -1))?.bytes).toEqual(Uint8Array.of());
    await expect(
      store.readRange(resource.id, { ...OWNER, subject: "auth0|other" }, 0, -1),
    ).resolves.toBeUndefined();
    await expect(store.readRange(resource.id, OWNER, 1, 0)).rejects.toThrow(
      "byte range is invalid",
    );
  });

  it("streams complete and ranged payloads only after full manifest integrity verification", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const original = Uint8Array.from({ length: 256 * 1024 + 37 }, (_, index) => index % 251);
    const resource = await store.put({ ...resourceInput([]), bytes: original });

    const complete = await store.openReadStream(resource.id, OWNER);
    expect(complete).toMatchObject({
      byteLength: original.byteLength,
      start: 0,
      endInclusive: original.byteLength - 1,
      digest: resource.digest,
    });
    expect(await collectStream(complete?.stream)).toEqual(original);

    const ranged = await store.openReadStream(resource.id, OWNER, {
      start: 64 * 1024 - 5,
      endInclusive: 192 * 1024 + 11,
    });
    expect(await collectStream(ranged?.stream)).toEqual(
      original.slice(64 * 1024 - 5, 192 * 1024 + 12),
    );

    const payloadPath = join(dataDirectory, resource.id, "payload.bin");
    const corrupted = Uint8Array.from(original);
    const finalIndex = corrupted.length - 1;
    corrupted[finalIndex] = (corrupted[finalIndex] ?? 0) ^ 0xff;
    await writeFile(payloadPath, corrupted);
    await expect(store.openReadStream(resource.id, OWNER)).rejects.toThrow(
      "Protected resource payload digest does not match its manifest",
    );
  });

  it("streams an empty protected result without manufacturing a byte", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new OwnerBoundResourceStore({ dataDirectory });
    const resource = await store.put(resourceInput([]));

    const opened = await store.openReadStream(resource.id, OWNER);
    expect(opened).toMatchObject({ byteLength: 0, start: 0, endInclusive: -1 });
    expect(await collectStream(opened?.stream)).toEqual(Uint8Array.of());
  });

  it("continues legal short file reads until the requested range is complete", async () => {
    const dataDirectory = await temporaryDirectory();
    const probePath = join(dataDirectory, "read-prototype-probe");
    await writeFile(probePath, Uint8Array.of(0));
    const probe = await open(probePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    const limitedRead = function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): unknown {
      return Reflect.apply(originalRead, this, [buffer, offset, Math.min(length, 3), position]);
    } as unknown as FileHandle["read"];
    const readSpy = vi.spyOn(fileHandlePrototype, "read").mockImplementation(limitedRead);
    try {
      const store = new OwnerBoundResourceStore({ dataDirectory });
      const original = Uint8Array.from({ length: 64 }, (_, index) => index);
      const resource = await store.put({
        ...resourceInput([]),
        bytes: original,
      });

      const range = await store.readRange(resource.id, OWNER, 7, 52);
      expect(range?.start).toBe(7);
      expect(range?.endInclusive).toBe(52);
      expect(range?.bytes).toEqual(original.slice(7, 53));
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-protected-results-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function withFirstPayloadRead(
  action: () => Promise<void>,
  operation: () => Promise<void>,
): Promise<void> {
  const directory = await temporaryDirectory();
  const path = join(directory, "prototype-probe");
  await writeFile(path, Buffer.of(0));
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
  await probe.close();
  const originalRead = prototype.read;
  let triggered = false;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) {
    const result = await Reflect.apply(originalRead, this, [buffer, offset, length, position]);
    if (!triggered && position === 0 && buffer.byteLength === 64 * 1024) {
      triggered = true;
      await action();
    }
    return result;
  } as FileHandle["read"]);
  try {
    await operation();
    expect(triggered).toBe(true);
  } finally {
    spy.mockRestore();
  }
}

function resourceInput(
  bytes: readonly number[],
  overrides: Partial<{
    readonly owner: HttpAuthorizationIdentity;
    readonly sessionId: string;
    readonly ttlMs: number;
  }> = {},
) {
  return {
    owner: overrides.owner ?? OWNER,
    sessionId: overrides.sessionId ?? SESSION_A,
    mimeType: "application/octet-stream",
    bytes: Uint8Array.from(bytes),
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
  };
}

async function collectStream(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
  if (stream === undefined) throw new Error("Expected protected resource stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Uint8Array.from(Buffer.concat(chunks));
}
