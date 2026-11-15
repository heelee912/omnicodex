import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { Server, Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { Duplex } from "node:stream";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const identity = { pid: 123, instanceNonce: "test-instance", startedAtUnixMs: 456 };
const cause = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });

type RuntimeControl = (command: string, ...args: unknown[]) => unknown;
interface ControlHarness {
  startControlServer(
    pipe: string,
    token: string,
    expectedIdentity: typeof identity,
    lifecycle: () => string,
    onStop: () => Promise<void>,
    onRuntimeControl: RuntimeControl,
  ): Promise<Server>;
  closeControlServer(server: Server): Promise<void>;
}

// daemon.ts has startup side effects. Execute its exact control-server functions
// with an in-memory listener, never import/start a daemon or use its real pipe.
async function controlHarness() {
  const source = await readFile(resolve("src/daemon.ts"), "utf8");
  const start = source.indexOf("async function startControlServer(");
  const end = source.indexOf("function shutdownErrorSummary(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const socketsByServer = new WeakMap<Server, Set<Socket>>();
  const harness = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}\n({ startControlServer, closeControlServer })`,
    {
      AbortController,
      Error,
      isAbsolute,
      resolve,
      controlSocketsByServer: socketsByServer,
      createServer: (accept: (socket: Socket) => void) => {
        const server = new EventEmitter() as Server;
        server.on("connection", accept);
        server.listen = ((_pipe: string, callback: () => void) => {
          Object.defineProperty(server, "listening", { value: true });
          queueMicrotask(callback);
          return server;
        }) as Server["listen"];
        server.close = ((callback: () => void) => {
          queueMicrotask(callback);
          return server;
        }) as Server["close"];
        return server;
      },
    },
  ) as ControlHarness;
  return { ...harness, socketsByServer };
}

function client(
  server: Server,
  command: string,
  options: { failWrite?: boolean; token?: string } = {},
) {
  const writes: string[] = [];
  const destroyed = vi.fn();
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      if (options.failWrite) setImmediate(() => callback(cause));
      else callback();
    },
    destroy(error, callback) {
      destroyed();
      callback(error);
    },
  }) as Socket;
  server.emit("connection", socket);
  socket.push(
    `${JSON.stringify({
      command,
      token: options.token ?? "owner",
      expectedPid: identity.pid,
      expectedInstanceNonce: identity.instanceNonce,
      expectedStartedAtUnixMs: identity.startedAtUnixMs,
    })}\n`,
  );
  return { socket, writes, destroyed };
}

async function tick() {
  await new Promise<void>((done) => setImmediate(done));
}

describe("daemon control socket error ownership", () => {
  it.each(["unauthorized", "status", "begin-drain"])(
    "contains asynchronous EPIPE after %s end, with one cleanup and no replay",
    async (command) => {
      const harness = await controlHarness();
      const runtime = vi.fn(async () => ({ admission: "draining", activeMcpRequests: 0 }));
      const stop = vi.fn(async () => {});
      const server = await harness.startControlServer(
        "unused-test-pipe",
        "owner",
        identity,
        () => "ready",
        stop,
        runtime,
      );
      const failed = client(server, command === "unauthorized" ? "stop" : command, {
        failWrite: true,
        ...(command === "unauthorized" ? { token: "not-owner" } : {}),
      });
      await vi.waitFor(() => expect(failed.socket.destroyed).toBe(true));
      await tick();
      expect(failed.destroyed).toHaveBeenCalledTimes(1);
      expect(failed.writes).toHaveLength(1);
      expect(harness.socketsByServer.get(server)?.size).toBe(0);
      expect(runtime).toHaveBeenCalledTimes(command === "begin-drain" ? 1 : 0);
      expect(stop).not.toHaveBeenCalled();
      // No uncaughtException handler is installed by this test. These late
      // asynchronous errors must remain owned even after socket-set cleanup.
      await new Promise<void>((done) => {
        setImmediate(() => {
          failed.socket.emit("error", cause);
          failed.socket.emit("error", cause);
          done();
        });
      });
      const healthy = client(server, "status");
      await vi.waitFor(() => expect(healthy.writes).toHaveLength(1));
      expect(JSON.parse(healthy.writes[0] ?? "")).toMatchObject({ ok: true, ...identity });
      expect(healthy.socket.destroyed).toBe(false);
      await harness.closeControlServer(server);
      await tick();
      expect(healthy.destroyed).toHaveBeenCalledTimes(1);
      expect(failed.destroyed).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts only a disconnected pending command once and never writes/replays its late outcome", async () => {
    const harness = await controlHarness();
    let settle!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    const runtime = vi.fn((_command: string, ...args: unknown[]) => {
      signal = args.at(-1) as AbortSignal;
      signal.addEventListener("abort", aborted);
      return new Promise((done) => {
        settle = done;
      });
    });
    const server = await harness.startControlServer(
      "unused-test-pipe",
      "owner",
      identity,
      () => "ready",
      async () => {},
      runtime,
    );
    const failed = client(server, "begin-drain");
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(1));
    setImmediate(() => failed.socket.emit("error", cause));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(harness.socketsByServer.get(server)?.size).toBe(0);
    const healthy = client(server, "status");
    await vi.waitFor(() => expect(healthy.writes).toHaveLength(1));
    settle({ admission: "draining", activeMcpRequests: 0 });
    await tick();
    failed.socket.emit("error", cause);
    expect(failed.writes).toHaveLength(0);
    expect(failed.destroyed).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(runtime).toHaveBeenCalledTimes(1);
    await harness.closeControlServer(server);
  });

  it("still flushes an authenticated stop proof before stopping once", async () => {
    const harness = await controlHarness();
    const stop = vi.fn(async () => {});
    const server = await harness.startControlServer(
      "unused-test-pipe",
      "owner",
      identity,
      () => "ready",
      stop,
      vi.fn(),
    );
    const accepted = client(server, "stop");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(JSON.parse(accepted.writes[0] ?? "")).toMatchObject({ ok: true, ...identity });
    accepted.socket.emit("error", cause);
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    await harness.closeControlServer(server);
  });
});
