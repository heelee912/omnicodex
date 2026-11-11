import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeCandidate } from "../src/domain/runtime.js";
import { CodexAppServerConnection } from "../src/infrastructure/runtime/codex-app-server-connection.js";

const candidate: RuntimeCandidate = {
  executablePath: "C:\\Codex\\codex.exe",
  canonicalPath: "C:\\Codex\\codex.exe",
  source: "managed_install",
  productVersion: "0.164.0-alpha.11.1",
  buildSha256: "a".repeat(64),
};

describe("CodexAppServerConnection", () => {
  it.skipIf(process.platform !== "win32")(
    "closes its socket without stopping the server",
    async () => {
      const pipeName = `\\\\.\\pipe\\omnicodex-connection-test-${randomUUID()}`;
      const instanceNonce = randomUUID();
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline)) as {
            id: number;
            params: { capabilities: { extensions: Record<string, unknown> } };
          };
          expect(request.params.capabilities.extensions["omnicodex/thread-owner-key"]).toBe(
            instanceNonce,
          );
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { codexHome: "C:\\Codex" } })}\n`,
          );
        });
      });
      await listen(server, pipeName);
      try {
        const connection = new CodexAppServerConnection(
          candidate,
          { requestTimeoutMs: 2000 },
          {
            locate: async () => ({
              transport: "named_pipe",
              pid: process.pid,
              pipeName,
              executablePath: candidate.executablePath,
              appServerVersion: candidate.productVersion ?? "",
              instanceNonce,
            }),
          },
        );
        await connection.start();
        expect(connection.identity.pid).toBe(process.pid);
        expect(connection.hasAppServerExited()).toBe(false);
        const probe = vi.spyOn(process, "kill");
        try {
          const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
          probe.mockImplementation(() => {
            throw missing;
          });
          expect(connection.hasAppServerExited()).toBe(true);
          const denied = Object.assign(new Error("denied"), { code: "EPERM" });
          probe.mockImplementation(() => {
            throw denied;
          });
          expect(() => connection.hasAppServerExited()).toThrow(denied);
        } finally {
          probe.mockRestore();
        }
        await connection.stop();
        expect(server.listening).toBe(true);

        const second = connect(pipeName);
        await new Promise<void>((resolve, reject) => {
          second.once("connect", resolve);
          second.once("error", reject);
        });
        second.destroy();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
