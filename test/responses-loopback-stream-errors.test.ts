import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ResponsesLoopbackDriver } from "../src/infrastructure/runtime/responses-loopback-driver.js";

const cause = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
const model = { slug: "test-model" };
type FailureMode = "accepted write" | "backpressure" | "queued end" | "manual";

async function fixture(mode: FailureMode, fetchImpl?: typeof fetch) {
  let response: ServerResponse | undefined;
  let listenerCountBeforeWrite = 0;
  let errorCount = 0;
  let closeCount = 0;
  let writes = 0;
  let ends = 0;
  const driver = new ResponsesLoopbackDriver({
    modelMetadata: { rawModel: model, modelDigest: "0".repeat(64), cachePath: "test-cache" },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    binding: {
      host: "127.0.0.1",
      listen: async (server) => {
        server.prependListener("request", (request: IncomingMessage, candidate: ServerResponse) => {
          if (request.headers["x-test-fail"] !== "true") return;
          response = candidate;
          candidate.once("close", () => closeCount++);
          const emitError = () => {
            errorCount++;
            candidate.emit("error", cause);
          };
          const nativeWrite = candidate.write;
          vi.spyOn(candidate, "write").mockImplementation((chunk: string | Uint8Array) => {
            listenerCountBeforeWrite = candidate.listenerCount("error");
            writes++;
            const accepted = nativeWrite.call(candidate, chunk, "utf8");
            if (writes === 1 && mode === "accepted write") queueMicrotask(emitError);
            if (mode === "backpressure") {
              if (writes === 1) setImmediate(emitError);
              return false;
            }
            return accepted;
          });
          const nativeEnd = candidate.end;
          vi.spyOn(candidate, "end").mockImplementation(
            (...args: Parameters<typeof candidate.end>) => {
              listenerCountBeforeWrite = candidate.listenerCount("error");
              ends++;
              if (mode === "queued end") {
                // Queued end, not a completed flush. There will be no finish.
                Object.defineProperty(candidate, "writableEnded", {
                  configurable: true,
                  value: true,
                });
                setImmediate(emitError);
                return candidate;
              }
              return nativeEnd.apply(candidate, args);
            },
          );
        });
        return await listen(server);
      },
    },
  });
  await driver.start();
  return {
    driver,
    get response() {
      if (response === undefined) throw new Error("Test did not capture a response");
      return response;
    },
    get counts() {
      return { listenerCountBeforeWrite, errorCount, closeCount, writes, ends };
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address !== null) done(address.port);
      else reject(new Error("Missing test address"));
    });
  });
}

function post(driver: ResponsesLoopbackDriver, input: unknown[], fail = false) {
  return fetch(`${driver.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omnicodex-loopback-key": driver.apiKey,
      ...(fail ? { "x-test-fail": "true" } : {}),
    },
    body: JSON.stringify({ model: "test-model", input, tools: [] }),
  });
}

async function consume(exchange: Promise<Response>) {
  return await exchange.then((response) => response.text()).catch((error: unknown) => error);
}

async function lateErrors(response: ServerResponse) {
  // No process-level error handler is added: an unowned emission fails Vitest.
  await new Promise<void>((done) => {
    setImmediate(() => {
      response.emit("error", cause);
      response.emit("error", cause);
      done();
    });
  });
}

describe("Responses loopback response error ownership", () => {
  it.each(["accepted write", "backpressure", "queued end"] as const)(
    "contains asynchronous EPIPE after %s without deciding/replaying the selected call",
    async (mode) => {
      const f = await fixture(mode);
      const active = f.driver.prepareToolCall({ kind: "function", name: "test", arguments: {} });
      let settled = false;
      void active.completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await consume(post(f.driver, [active.executionNonce], true));
        await vi.waitFor(() => {
          expect(f.response.destroyed).toBe(true);
          expect(f.counts.closeCount).toBe(1);
        });
        expect(f.counts.listenerCountBeforeWrite).toBeGreaterThan(0);
        expect(f.counts.errorCount).toBe(1);
        expect(f.counts.closeCount).toBe(1);
        expect(f.response.listenerCount("drain")).toBe(0);
        expect(settled).toBe(false);
        await lateErrors(f.response);
        expect(settled).toBe(false);
        const models = await fetch(`${f.driver.baseUrl}/models`, {
          headers: { "x-omnicodex-loopback-key": f.driver.apiKey },
        });
        expect(await models.json()).toEqual({ models: [model] });
        // The native call may have reached the executor. Accept only its real
        // correlated output; do not forge failure/success or automatically resend.
        expect(() =>
          f.driver.prepareToolCall({ kind: "function", name: "other", arguments: {} }),
        ).toThrow("already has an active tool call");
        const completed = await post(f.driver, [
          { type: "function_call_output", call_id: active.callId, output: "real outcome" },
        ]);
        expect(await completed.text()).toContain("OMNICODEX_LOOPBACK_COMPLETE");
        await expect(active.completion).resolves.toMatchObject({ output: "real outcome" });
        expect(f.driver.snapshot.requestCount).toBe(2);
        expect(f.counts.closeCount).toBe(1);
        await expect(f.driver.stop(1_000)).resolves.toBeUndefined();
      } finally {
        f.driver.cancelActiveToolCall(new Error("test cleanup"));
        await f.driver.stop(1_000);
      }
    },
  );

  it.each(["unauthorized", "models", "error"])(
    "owns an early %s end from creation and retains containment after cleanup",
    async (path) => {
      const f = await fixture("queued end");
      try {
        const exchange = fetch(
          `${f.driver.baseUrl}/${path === "error" ? "not-allowed" : "models"}`,
          {
            headers: {
              "x-test-fail": "true",
              ...(path === "unauthorized" ? {} : { "x-omnicodex-loopback-key": f.driver.apiKey }),
            },
          },
        );
        expect(await consume(exchange)).toBeInstanceOf(Error);
        expect(f.counts.listenerCountBeforeWrite).toBeGreaterThan(0);
        await vi.waitFor(() => expect(f.counts.closeCount).toBe(1));
        await lateErrors(f.response);
        expect(f.counts.ends).toBe(1);
        expect(f.counts.closeCount).toBe(1);
        await expect(f.driver.stop(1_000)).resolves.toBeUndefined();
      } finally {
        await f.driver.stop(1_000);
      }
    },
  );

  it("releases a disconnected retained request once without touching a later selected call", async () => {
    const f = await fixture("manual");
    try {
      const original = f.driver.prepareToolCall(
        { kind: "custom", namespace: "functions", name: "exec", arguments: "await work();" },
        { preserveYieldedTurn: true },
      );
      await consume(post(f.driver, [original.executionNonce]));
      const retainedExchange = consume(
        post(
          f.driver,
          [
            {
              type: "custom_tool_call_output",
              call_id: original.callId,
              output: "Script running with cell ID test-cell\nWall time 1.0 seconds\nOutput:\n",
            },
          ],
          true,
        ),
      );
      await expect(original.completion).resolves.toMatchObject({ turnRetained: true });
      const retired = f.response;
      setImmediate(() => retired.emit("error", cause));
      expect(await retainedExchange).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(f.counts.closeCount).toBe(1));
      const later = f.driver.prepareToolCall({ kind: "function", name: "later", arguments: {} });
      await lateErrors(retired);
      const selected = await consume(post(f.driver, [later.executionNonce]));
      expect(selected).toContain(`"call_id":"${later.callId}"`);
      await consume(
        post(f.driver, [
          { type: "function_call_output", call_id: later.callId, output: "later result" },
        ]),
      );
      await expect(later.completion).resolves.toMatchObject({ output: "later result" });
      expect(f.counts.writes).toBe(0);
      expect(f.counts.ends).toBe(0);
      expect(f.counts.closeCount).toBe(1);
      await expect(f.driver.stop(1_000)).resolves.toBeUndefined();
    } finally {
      f.driver.cancelActiveToolCall(new Error("test cleanup"));
      await f.driver.stop(1_000);
    }
  });

  it("cleans a failed relay once while a different in-flight request keeps draining normally", async () => {
    let finishHealthy!: (value: Response) => void;
    let healthySignal: AbortSignal | null | undefined;
    let healthyStarted = false;
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      if (body.includes("healthy")) {
        healthySignal = init?.signal;
        healthyStarted = true;
        return await new Promise<Response>((done) => {
          finishHealthy = done;
        });
      }
      return new Response("failed relay result");
    });
    const f = await fixture("backpressure", upstream);
    const native = (query: string, fail = false) =>
      fetch(`${f.driver.baseUrl}/alpha/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-upstream-credential",
          "x-omnicodex-loopback-key": f.driver.apiKey,
          ...(fail ? { "x-test-fail": "true" } : {}),
        },
        body: JSON.stringify({ query }),
      });
    try {
      await consume(native("failed", true));
      await vi.waitFor(() => expect(f.counts.closeCount).toBe(1));
      const healthy = native("healthy");
      await vi.waitFor(() => expect(healthyStarted).toBe(true));
      await lateErrors(f.response);
      let stopped = false;
      const stopping = f.driver.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(stopped).toBe(false);
      expect(healthySignal?.aborted).toBe(false);
      finishHealthy(new Response("healthy result"));
      expect(await consume(healthy)).toBe("healthy result");
      await stopping;
      expect(healthySignal?.aborted).toBe(false);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(f.counts.closeCount).toBe(1);
      expect(f.response.listenerCount("drain")).toBe(0);
      expect(f.response.listenerCount("error")).toBe(1);
    } finally {
      finishHealthy?.(new Response("test cleanup"));
      await f.driver.stop(1_000);
    }
  });
});
