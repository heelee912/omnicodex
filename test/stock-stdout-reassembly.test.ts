import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PolicyDocumentationService } from "../src/application/policy-documentation-service.js";
import { StdioAppServerRouter } from "../src/infrastructure/runtime/stdio-app-server-router.js";

const scriptUrl = pathToFileURL(
  resolve("scripts/windows/desktop-engine/stock-app-server-stdio.mjs"),
).href;
const { receiveStockStdout, STOCK_STDOUT_LIMITS } = await import(scriptUrl);
const threadId = "synthetic-thread";
const head = '{"id":17,"result":{"thread":{"id":"synthetic-thread","text":"';
const tail = 'end"}}}\n';
const wire = `${head}start\n${tail}`;

async function harness(id: string | number = 17, method = "thread/resume") {
  const desktop: string[] = [];
  const server: string[] = [];
  const router = new StdioAppServerRouter({
    sendDesktop: (line) => desktop.push(line),
    sendServer: (line) => server.push(line),
    policyDocumentation: {} as PolicyDocumentationService,
    ownerKey: "synthetic-owner",
  });
  router.receiveDesktop('{"id":0,"method":"initialize"}');
  await router.receiveServer('{"id":0,"result":{}}');
  desktop.length = 0;
  router.receiveDesktop(JSON.stringify({ id, method, params: { threadId } }));
  const addClient = (name: string) => {
    const messages: string[] = [];
    const client = router.addClient((line) => messages.push(line));
    router.receiveClient(
      client,
      JSON.stringify({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "codex-native" },
          capabilities: { extensions: { "omnicodex/thread-owner-key": "synthetic-owner" } },
        },
      }),
    );
    messages.length = 0;
    router.receiveClient(
      client,
      JSON.stringify({ id, method: "thread/resume", params: { threadId: name } }),
    );
    return { messages, nativeId: JSON.parse(server.at(-1) ?? "{}").id };
  };
  return { router, desktop, server, addClient };
}

function stdout(text: string, chunkSize = 11) {
  const bytes = Buffer.from(text);
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        yield bytes.subarray(offset, offset + chunkSize);
    })(),
  );
}

describe("fail-closed primary stock stdout resume recovery", () => {
  it("recovers a 20.4M-character, nine-fragment fake native response only once for Desktop", async () => {
    const h = await harness();
    const first = h.addClient("other-thread-a");
    const second = h.addClient("other-thread-b");
    const sent = [...h.server];
    const suffix = ' quote:" slash:\\ escaped-newline:\n unicode:☃ ';
    const marked = `x${suffix}${Array.from({ length: 9 }, (_, i) => `part-${i}`).join("RAW_BOUNDARY")}`;
    const expected = `${"x".repeat(20_390_800)}${marked.replaceAll("RAW_BOUNDARY", "\n")}`;
    const nativeCode = `
      const text = 'x'.repeat(20_390_800) + ${JSON.stringify(marked)};
      const response = {id:17,result:{thread:{id:${JSON.stringify(threadId)},text}}};
      const bytes = Buffer.from(JSON.stringify(response).replaceAll('RAW_BOUNDARY', '\\n') + '\\r\\n');
      let offset = 0;
      function pump() {
        while (offset < bytes.length) {
          const end = Math.min(offset + 65537, bytes.length);
          const part = bytes.subarray(offset, end);
          offset = end;
          if (!process.stdout.write(part)) { process.stdout.once('drain', pump); return; }
        }
        process.stdout.end();
      }
      pump();
    `;
    const native = spawn(process.execPath, ["-e", nativeCode], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(native, "close");
    let diagnostic = "";
    native.stderr.on("data", (chunk) => (diagnostic += chunk.toString()));
    const receive = vi.spyOn(h.router, "receiveServer");
    try {
      await receiveStockStdout(native.stdout, h.router);
      expect((await closed)[0], diagnostic).toBe(0);
      expect(receive).toHaveBeenCalledTimes(1);
      expect(h.desktop).toHaveLength(1);
      expect(JSON.parse(h.desktop[0] ?? "{}")).toEqual({
        id: 17,
        result: { thread: { id: threadId, text: expected } },
      });
      expect(first.messages).toEqual([]);
      expect(second.messages).toEqual([]);
      expect(h.server).toEqual(sent); // No replay or other upstream RPC.
      expect(h.router.selectPendingDesktopResume(17)).toBeUndefined();
      // The same malformed response is no longer eligible, including on a new stream.
      await expect(receiveStockStdout(stdout(wire), h.router)).rejects.toThrow(
        "not-desktop-resume",
      );
      expect(h.desktop).toHaveLength(1);
    } finally {
      native.kill();
      await closed;
    }
  });

  it.each([17, "17", 'escaped-"\\id'])(
    "preserves exact id %j, UTF-8 chunk splits, escapes, empty fragments and final CRLF",
    async (id) => {
      const h = await harness(id);
      const response = {
        jsonrpc: "2.0",
        id,
        result: { thread: { id: threadId, text: '☃\\"\nRAW_BOUNDARYRAW_BOUNDARYtail' } },
      };
      const encoded = `${JSON.stringify(response).replaceAll("RAW_BOUNDARY", "\n")}\r\n`;
      await receiveStockStdout(stdout(encoded, 1), h.router, { maxFragments: 3 });
      response.result.thread.text = response.result.thread.text.replaceAll("RAW_BOUNDARY", "\n");
      expect(h.desktop.map((line) => JSON.parse(line))).toEqual([response]);
    },
  );

  it("leaves valid JSONL/CRLF unchanged, including other-client responses", async () => {
    const h = await harness();
    const client = h.addClient("other-thread");
    const valid = '{"id":17,"result":{"thread":{"id":"synthetic-thread","text":"ok\\n"}}}\r';
    const peerResponse = JSON.stringify({
      id: client.nativeId,
      result: { thread: { id: "other-thread" } },
    });
    await receiveStockStdout(stdout(`${valid}\n${peerResponse}\n`), h.router);
    expect(h.desktop).toEqual([valid]);
    expect(client.messages.map((line) => JSON.parse(line))).toEqual([
      { id: 17, result: { thread: { id: "other-thread" } } },
    ]);
  });

  it("provides only immutable, exact, unconsumed Desktop resume proofs", async () => {
    const h = await harness();
    const proof = h.router.selectPendingDesktopResume(17);
    expect(proof).toMatchObject({ id: 17, threadId, method: "thread/resume" });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(h.router.selectPendingDesktopResume(17)).toBe(proof);
    expect(h.router.selectPendingDesktopResume("17")).toBeUndefined();
    expect(h.router.selectPendingDesktopResume(0)).toBeUndefined();
    const client = h.addClient("other-thread");
    expect(h.router.selectPendingDesktopResume(client.nativeId)).toBeUndefined();
    h.router.receiveDesktop(
      JSON.stringify({ id: client.nativeId, method: "thread/resume", params: { threadId } }),
    );
    expect(h.router.selectPendingDesktopResume(client.nativeId)).toBeUndefined();
    const turn = await harness(17, "turn/start");
    expect(turn.router.selectPendingDesktopResume(17)).toBeUndefined();
    h.router.receiveDesktop('{"id":17,"method":"turn/interrupt","params":{}}');
    expect(h.router.selectPendingDesktopResume(17)).toBeUndefined();
  });

  it.each([
    ["unrelated invalid JSON", "synthetic-private-marker {bad\n"],
    ["unknown id", wire.replace('"id":17', '"id":18')],
    ["wrong id type", wire.replace('"id":17', '"id":"17"')],
    ["wrong thread", wire.replace(threadId, "different-thread")],
    ["missing thread", '{"id":17,"result":{"text":"start\nend"}}\n'],
    ["error envelope", '{"id":17,"error":{"text":"start\nend"}}\n'],
    ["notification", '{"method":"event","params":{"text":"start\nend"}}\n'],
    ["interleaved event", `${head}start\n{"method":"event","params":{}}\n${tail}`],
    ["interleaved response", `${head}start\n{"id":99,"result":{}}\n${tail}`],
    ["nesting budget", `{"id":17,"result":{"data":${"[".repeat(256)}"start\n`],
    ["truncated string EOF", `${head}start\nend`],
    ["missing final LF", wire.slice(0, -1)],
    ["truncated at LF", `${head}start\n`],
    ["raw CR", `${head}start\rend\n${tail}`],
    ["raw CRLF in string", `${head}start\r\n${tail}`],
    ["unexpected CR outside string", '{"id":17,\r"result":{}}\n'],
    ["raw control", `${head}start\u0001\n${tail}`],
    ["raw tab in string", `${head}start\t\n${tail}`],
    ["unfinished escape", `${head}start\\\n${tail}`],
    ["unfinished unicode escape", `${head}start\\u12\n${tail}`],
    ["invalid escape", `${head}start\\q\n${tail}`],
    ["LF outside a string", '{"id":17,"result":{\n"thread":{}}}\n'],
    ["invalid reconstructed JSON", `${head.replace('"text":', '"text" ')}start\n${tail}`],
    ["overridden id", `${head}start\nend"}},"id":18}\n`],
    ["mutation envelope", `${head}start\nend"}},"method":"turn/start"}\n`],
  ])("rejects %s without delivering any response", async (_name, text) => {
    const h = await harness();
    await expect(receiveStockStdout(stdout(text ?? ""), h.router)).rejects.toThrow(
      "Stock stdout rejected",
    );
    expect(h.desktop).toEqual([]);
    expect(h.router.selectPendingDesktopResume(17)).toBeDefined();
  });

  it("rejects malformed responses for other clients and Desktop mutations", async () => {
    const h = await harness();
    const a = h.addClient("other-a");
    const b = h.addClient("other-b");
    for (const id of [a.nativeId, b.nativeId]) {
      await expect(
        receiveStockStdout(stdout(wire.replace('"id":17', `"id":${JSON.stringify(id)}`)), h.router),
      ).rejects.toThrow("not-desktop-resume");
    }
    const turn = await harness(17, "turn/start");
    await expect(receiveStockStdout(stdout(wire), turn.router)).rejects.toThrow(
      "not-desktop-resume",
    );
    expect(a.messages).toEqual([]);
    expect(b.messages).toEqual([]);
  });

  it.each([
    [{ maxChars: head.length - 1 }, "character-budget"],
    [{ maxChars: wire.length - 1 }, "character-budget"],
    [{ maxBytes: head.length - 1 }, "byte-budget"],
    [{ maxBytes: Buffer.byteLength(wire) - 1 }, "byte-budget"],
    [{ maxFragments: 1 }, "fragment-budget"],
  ])("enforces bounded retention %j", async (limits, reason) => {
    const h = await harness();
    await expect(receiveStockStdout(stdout(wire, 1), h.router, limits)).rejects.toThrow(reason);
    expect(h.desktop).toEqual([]);
  });

  it("counts UTF-8 bytes, rejects invalid encoding and keeps production limits finite", async () => {
    const h = await harness();
    const multibyte = wire.replace("start", "☃".repeat(20));
    await expect(
      receiveStockStdout(stdout(multibyte, 1), h.router, { maxBytes: multibyte.length + 1 }),
    ).rejects.toThrow("byte-budget");
    await expect(
      receiveStockStdout(Readable.from([Buffer.from([0xff, 0x0a])]), h.router),
    ).rejects.toThrow("invalid-utf8");
    expect(STOCK_STDOUT_LIMITS).toEqual({
      maxChars: 33554432,
      maxBytes: 50331648,
      maxFragments: 32,
      timeoutMs: 10000,
    });
  });

  it("rejects reuse of the pending request even for the same id and thread", async () => {
    const h = await harness();
    const input = new PassThrough();
    const selected = vi.spyOn(h.router, "selectPendingDesktopResume");
    const flight = receiveStockStdout(input, h.router);
    const rejected = expect(flight).rejects.toThrow("invalid-resume-response");
    input.write(`${head}start\n`);
    await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    h.router.receiveDesktop(
      JSON.stringify({ id: 17, method: "thread/resume", params: { threadId } }),
    );
    input.end(tail);
    await rejected;
    expect(h.desktop).toEqual([]);
  });

  it("times out an incomplete resume without payloads or a lingering timer", async () => {
    const h = await harness();
    const input = new PassThrough();
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const flight = receiveStockStdout(input, h.router, { timeoutMs: 20 });
      const rejected = expect(flight).rejects.toThrow(/^Stock stdout rejected \(timeout\)$/);
      input.write(`${head}synthetic-private-marker\n`);
      await rejected;
      expect(input.destroyed).toBe(true);
      expect(h.desktop).toEqual([]);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  it.each(["stock exit", "Desktop close"])("cancels retained data on %s", async () => {
    const h = await harness();
    const input = new PassThrough();
    const abort = new AbortController();
    const selected = vi.spyOn(h.router, "selectPendingDesktopResume");
    const flight = receiveStockStdout(input, h.router, { signal: abort.signal, timeoutMs: 100 });
    input.write(`${head}start\n`);
    await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(flight).resolves.toBeUndefined();
    expect(input.destroyed).toBe(true);
    expect(h.desktop).toEqual([]);
  });

  it.skipIf(process.platform !== "win32").each(["stock exit", "Desktop close"])(
    "cancels an actual bridge's buffered resume on %s",
    async (mode) => {
      const nativeCode = `
        process.stdin.once('data', () => {
          process.stdout.write(${JSON.stringify(`${head}synthetic-private-marker\n`)});
          if (${JSON.stringify(mode)} === 'stock exit') setTimeout(() => process.exit(0), 100);
        });
        process.stdin.resume();
      `;
      const wrapperCode = `
        const {bridgeDesktopAppServer} = await import(${JSON.stringify(scriptUrl)});
        class Router {
          ready = false;
          pending = Object.freeze({id:17,threadId:${JSON.stringify(threadId)},method:'thread/resume'});
          constructor(transport) { this.transport = transport; }
          receiveDesktop(line) { this.transport.sendServer(line); }
          selectPendingDesktopResume(id) {
            process.stderr.write('selected\\n');
            return id === 17 ? this.pending : undefined;
          }
        }
        await bridgeDesktopAppServer(process.execPath, ['-e', ${JSON.stringify(nativeCode)}], false, {
          loadBridgeModules: async () => [
            {PolicyDocumentationService: class {}},
            {StdioAppServerRouter: Router, attachOmniClientSocket: () => {}},
          ],
        });
      `;
      const wrapper = spawn(process.execPath, ["--input-type=module", "-e", wrapperCode], {
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_HOME: join(
            process.env.PI_SCRATCH_DIR ?? tmpdir(),
            `synthetic-bridge-${randomUUID()}`,
          ),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let diagnostic = "";
      let output = "";
      wrapper.stderr.on("data", (chunk) => (diagnostic += chunk.toString()));
      wrapper.stdout.on("data", (chunk) => (output += chunk.toString()));
      const closed = once(wrapper, "close");
      try {
        wrapper.stdin.write(
          `${JSON.stringify({ id: 17, method: "thread/resume", params: { threadId } })}\n`,
        );
        await vi.waitFor(() => expect(diagnostic).toContain("selected\n"));
        if (mode === "Desktop close") wrapper.stdin.end();
        const [code] = await closed;
        if (mode === "Desktop close") {
          expect(code).toBe(0);
          expect(diagnostic).not.toContain("output failed");
        } else {
          // Pipe EOF may precede the process-exit event: truncated EOF is fatal,
          // while exit-event cancellation preserves the native exit code.
          expect([0, 1]).toContain(code);
        }
        expect(output).toBe("");
        expect(diagnostic).not.toContain("synthetic-private-marker");
      } finally {
        wrapper.kill();
        wrapper.stdin.destroy();
        await closed;
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "logs no native payload when the actual bridge fails closed",
    async () => {
      const nativeCode =
        "process.stdin.once('data', () => process.stdout.write('synthetic-private-marker {bad\\n')); process.stdin.resume();";
      const wrapperCode = `
      const {bridgeDesktopAppServer} = await import(${JSON.stringify(scriptUrl)});
      class Router {
        ready = false;
        constructor(transport) { this.transport = transport; }
        receiveDesktop(line) { this.transport.sendServer(line); }
        selectPendingDesktopResume() { return undefined; }
      }
      await bridgeDesktopAppServer(process.execPath, ['-e', ${JSON.stringify(nativeCode)}], false, {
        loadBridgeModules: async () => [
          {PolicyDocumentationService: class {}},
          {StdioAppServerRouter: Router, attachOmniClientSocket: () => {}},
        ],
      });
    `;
      const wrapper = spawn(process.execPath, ["--input-type=module", "-e", wrapperCode], {
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_HOME: join(
            process.env.PI_SCRATCH_DIR ?? tmpdir(),
            `synthetic-bridge-${randomUUID()}`,
          ),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let diagnostic = "";
      wrapper.stderr.on("data", (chunk) => (diagnostic += chunk.toString()));
      wrapper.stdout.resume();
      const closed = once(wrapper, "close");
      try {
        wrapper.stdin.write('{"id":0,"method":"initialize"}\n');
        expect((await closed)[0]).toBe(1);
        expect(diagnostic).toBe(
          "Codex Desktop App Server output failed (invalid or incomplete stock response)\n",
        );
        expect(diagnostic).not.toContain("synthetic-private-marker");
      } finally {
        wrapper.kill();
        wrapper.stdin.destroy();
        await closed;
      }
    },
  );
});
