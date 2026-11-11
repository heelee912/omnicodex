import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonlRpcClient } from "../src/infrastructure/runtime/jsonl-rpc-client.js";

function readLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolveLine) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      stream.removeListener("data", onData);
      resolveLine(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    };
    stream.on("data", onData);
  });
}

describe("JsonlRpcClient", () => {
  it("keeps incoming requests separate from outgoing responses with the same id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const onServerRequest = vi.fn(async () => ({ accepted: true }));
    const client = new JsonlRpcClient({ readable: input, writable: output, onServerRequest });
    const request = client.request("command/exec", {});
    void request.catch(() => undefined);
    try {
      const sent = await readLine(output);
      const response = readLine(output);
      input.write(
        `${JSON.stringify({ id: sent.id, method: "item/tool/call", params: { tool: "read" } })}\n`,
      );
      expect(onServerRequest).toHaveBeenCalledOnce();
      await expect(response).resolves.toMatchObject({ id: sent.id, result: { accepted: true } });
      input.write(
        `${JSON.stringify({ id: sent.id, result: { stdout: "actual command result" } })}\n`,
      );
      await expect(request).resolves.toEqual({ stdout: "actual command result" });
    } finally {
      client.close();
      input.destroy();
      output.destroy();
    }
  });

  it("round-trips responses without requiring a jsonrpc field", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });

    const request = client.request<{ value: string }>("initialize", { ok: true });
    const sent = await readLine(output);
    expect(sent.method).toBe("initialize");
    expect(sent.jsonrpc).toBe("2.0");
    input.write(`${JSON.stringify({ id: sent.id, result: { value: "ready" } })}\n`);

    await expect(request).resolves.toEqual({ value: "ready" });
    client.close();
    input.destroy();
    output.destroy();
  });

  it("preserves response and notification lines larger than transport convenience caps", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notifications: Record<string, unknown>[] = [];
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onNotification: (message) => notifications.push(message),
    });
    const request = client.request<{ stdout: string; stderr: string }>("large/result", {});
    const sent = await readLine(output);
    const stdout = `stdout-${"한글🙂".repeat(300_000)}`;
    const stderr = `stderr-${"e".repeat(1_500_000)}`;
    const notification = {
      method: "item/large-progress",
      params: { chunk: `notification-${"n".repeat(1_500_000)}` },
    };

    input.write(`${JSON.stringify({ id: sent.id, result: { stdout, stderr } })}\n`);
    input.write(`${JSON.stringify(notification)}\n`);

    await expect(request).resolves.toEqual({ stdout, stderr });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications).toEqual([notification]);
    client.close();
    input.destroy();
    output.destroy();
  });

  it("preserves the complete structured RPC error and an oversized data payload", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const request = client.request("large/error", {});
    const sent = await readLine(output);
    const rpcError = {
      code: -32_123,
      message: "native execution failed",
      data: {
        stderr: `error-detail-${"x".repeat(1_500_000)}`,
        nested: { nativeCode: "FULL_NATIVE_ERROR_CONTEXT" },
      },
      extension: { retryable: false },
    };

    input.write(`${JSON.stringify({ id: sent.id, error: rpcError })}\n`);
    const rejection = await request.catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      name: "JsonlRpcError",
      code: rpcError.code,
      data: rpcError.data,
      rpcError,
      cause: rpcError,
    });
    expect((rejection as Error).message).toContain("FULL_NATIVE_ERROR_CONTEXT");
    expect((rejection as Error).message).toContain(rpcError.data.stderr);
    client.close();
    input.destroy();
    output.destroy();
  });

  it("reports malformed protocol input without trimming its original line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notifications: Record<string, unknown>[] = [];
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onNotification: (message) => notifications.push(message),
    });
    const malformed = "  {not-json:\tFULL_MALFORMED_CONTEXT}  \r";

    input.write(`${malformed}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications).toEqual([
      {
        method: "omnicodex/runtime/malformed_message",
        params: { line: malformed },
      },
    ]);
    client.close();
    input.destroy();
    output.destroy();
  });

  it("does not invent a timeout when the caller omits one", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const client = new JsonlRpcClient({ readable: input, writable: output });
      const request = client.request<{ value: string }>("long/read", {});
      const sent = await readLine(output);
      let settled = false;
      void request.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(settled).toBe(false);
      input.write(`${JSON.stringify({ id: sent.id, result: { value: "complete" } })}\n`);
      await expect(request).resolves.toEqual({ value: "complete" });

      client.close();
      input.destroy();
      output.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies only an explicit timeout and consumes the late correlated response", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const notifications: unknown[] = [];
      const client = new JsonlRpcClient({
        readable: input,
        writable: output,
        onNotification: (message) => notifications.push(message),
      });
      const request = client.request("slow/write", {}, { timeoutMs: 25 });
      const sent = await readLine(output);

      const timedOut = expect(request).rejects.toThrow("App Server request timed out: slow/write");
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000);
      input.write(`${JSON.stringify({ id: sent.id, result: { accepted: true } })}\n`);
      await Promise.resolve();
      expect(notifications).toEqual([]);

      client.close();
      input.destroy();
      output.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an absolute caller deadline without overflowing long timeout values", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const client = new JsonlRpcClient({ readable: input, writable: output });
      const longRequest = client.request("long/deadline", {}, { timeoutMs: 3_000_000_000 });
      const longSent = await readLine(output);
      let longSettled = false;
      void longRequest.finally(() => {
        longSettled = true;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(longSettled).toBe(false);
      input.write(`${JSON.stringify({ id: longSent.id, result: "long-ok" })}\n`);
      await expect(longRequest).resolves.toBe("long-ok");

      const deadlineRequest = client.request(
        "absolute/deadline",
        {},
        {
          deadlineUnixMs: Date.now() + 25,
        },
      );
      await readLine(output);
      const timedOut = expect(deadlineRequest).rejects.toThrow(
        "App Server request timed out: absolute/deadline",
      );
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;

      client.close();
      input.destroy();
      output.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch when the caller's absolute deadline has already elapsed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    let wrote = false;
    output.once("data", () => {
      wrote = true;
    });
    const deadlineUnixMs = Date.now() - 1;

    await expect(
      client.request("must/not/run-after-deadline", {}, { deadlineUnixMs }),
    ).rejects.toMatchObject({
      name: "JsonlRpcRequestTimeoutError",
      code: "JSONL_RPC_DEADLINE_EXCEEDED",
      deadlineUnixMs,
      method: "must/not/run-after-deadline",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(wrote).toBe(false);

    client.close();
    input.destroy();
    output.destroy();
  });

  it("preserves explicit AbortSignal cancellation without misclassifying a late response", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const notifications: unknown[] = [];
    const controller = new AbortController();
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onNotification: (message) => notifications.push(message),
    });
    const request = client.request("long/action", {}, { signal: controller.signal });
    const sent = await readLine(output);

    controller.abort(new Error("caller cancelled"));
    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      message: "caller cancelled",
    });
    input.write(`${JSON.stringify({ id: sent.id, result: { completed: true } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications).toEqual([]);

    client.close();
    input.destroy();
    output.destroy();
  });

  it("retains a dispatched mutation until its late correlated cancellation settlement", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const request = client.request(
      "command/exec",
      { command: ["long-task"] },
      {
        signal: controller.signal,
        awaitResponseAfterCancellation: true,
      },
    );
    const sent = await readLine(output);
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort(new Error("caller cancelled"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    input.write(`${JSON.stringify({ id: sent.id, result: { completed: true } })}\n`);
    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      message: "caller cancelled",
      rpcResponse: { completed: true },
    });

    client.close();
    input.destroy();
    output.destroy();
  });

  it("retains a timed-out mutation until its late correlated response", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const client = new JsonlRpcClient({ readable: input, writable: output });
      const request = client.request(
        "fs/writeFile",
        { path: "C:\\large.txt" },
        {
          timeoutMs: 25,
          awaitResponseAfterCancellation: true,
        },
      );
      const sent = await readLine(output);
      let settled = false;
      void request.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(false);
      input.write(`${JSON.stringify({ id: sent.id, result: { written: true } })}\n`);
      await expect(request).rejects.toMatchObject({
        name: "JsonlRpcRequestTimeoutError",
        code: "JSONL_RPC_DEADLINE_EXCEEDED",
        method: "fs/writeFile",
      });

      client.close();
      input.destroy();
      output.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch a request whose signal is already aborted", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    controller.abort();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    let wrote = false;
    output.once("data", () => {
      wrote = true;
    });

    await expect(
      client.request("must/not/run", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(wrote).toBe(false);

    client.close();
    input.destroy();
    output.destroy();
  });

  it("answers server requests through the approval callback", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onServerRequest: async (message) => ({ approved: message.method === "approval/request" }),
    });
    const response = readLine(output);
    input.write(`${JSON.stringify({ id: "server-1", method: "approval/request", params: {} })}\n`);

    await expect(response).resolves.toMatchObject({
      id: "server-1",
      result: { approved: true },
    });
    client.close();
    input.destroy();
    output.destroy();
  });

  it("returns the complete structured handler error for App Server requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const failure = Object.assign(
      new Error("native approval handler failed", { cause: { step: 2 } }),
      {
        code: -32_042,
        data: { stderr: "complete stderr", ordered: ["first", "last"] },
        rpcError: { code: "E_NATIVE", retryable: false },
        retryAfterMs: 250,
      },
    );
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onServerRequest: async () => {
        throw failure;
      },
    });
    const response = readLine(output);
    input.write(
      `${JSON.stringify({ id: "server-error", method: "approval/request", params: {} })}\n`,
    );

    await expect(response).resolves.toMatchObject({
      id: "server-error",
      error: {
        code: -32_042,
        message: "native approval handler failed",
        data: {
          name: "Error",
          message: "native approval handler failed",
          cause: { step: 2 },
          code: -32_042,
          data: { stderr: "complete stderr", ordered: ["first", "last"] },
          rpcError: { code: "E_NATIVE", retryable: false },
          retryAfterMs: 250,
        },
      },
    });
    client.close();
    input.destroy();
    output.destroy();
  });

  it("rejects pending requests when the stream closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const request = client.request("never", {});
    input.end();
    await expect(request).rejects.toThrow(/stream ended|closed/);
    output.destroy();
  });

  it("contains writable EPIPE errors and rejects pending requests instead of crashing the daemon", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const request = client.request("write/after-child-exit", {});
    await readLine(output);

    output.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    await expect(request).rejects.toMatchObject({ message: "write EPIPE", code: "EPIPE" });
    client.close();
    input.destroy();
  });

  it("contains a broken pipe while replying to a server request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const client = new JsonlRpcClient({
      readable: input,
      writable: output,
      onServerRequest: async () => {
        await handlerGate;
        return { approved: true };
      },
    });

    input.write(`${JSON.stringify({ id: "server-epipe", method: "approval/request" })}\n`);
    output.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    releaseHandler();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    client.close();
    input.destroy();
  });

  it("subscribes and unsubscribes exact App Server notifications", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const observed: unknown[] = [];
    const unsubscribe = client.subscribeNotifications((message) => observed.push(message));

    input.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "1" } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    input.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "2" } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(observed).toEqual([{ method: "turn/completed", params: { turn: { id: "1" } } }]);
    client.close();
    input.destroy();
    output.destroy();
  });
});
