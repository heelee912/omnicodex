import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
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

  it("rejects pending requests when the stream closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonlRpcClient({ readable: input, writable: output });
    const request = client.request("never", {});
    input.end();
    await expect(request).rejects.toThrow(/stream ended|closed/);
    output.destroy();
  });
});
