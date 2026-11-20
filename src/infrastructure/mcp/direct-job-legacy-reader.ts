import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

type Token = string | { readonly value: unknown };

/** Reads only one job at a time; heap use is proportional to the largest job, not the ledger. */
export async function readLegacyDirectJobs(
  path: string,
  acceptJob: (value: unknown, index: number) => string,
): Promise<{ revision: number; checksum: string; jobCount: number }> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const reader = new JsonReader(tokens(stream));
  const fields = new Map<string, unknown>();
  const hash = createHash("sha256").update('{"jobs":[');
  let jobCount = 0;
  try {
    await reader.expect("{");
    let token = await reader.next();
    while (token !== "}") {
      if (typeof token !== "object" || typeof token.value !== "string") invalid();
      const key = token.value;
      if (!["jobs", "revision", "schemaVersion", "checksum"].includes(key) || fields.has(key)) {
        invalid();
      }
      fields.set(key, true);
      await reader.expect(":");
      if (key === "jobs") {
        await reader.expect("[");
        let jobToken = await reader.next();
        while (jobToken !== "]") {
          const job = await reader.value(jobToken);
          if (jobCount !== 0) hash.update(",");
          hash.update(acceptJob(job, jobCount));
          jobCount += 1;
          jobToken = await reader.next();
          if (jobToken === "]") break;
          if (jobToken !== ",") invalid();
          jobToken = await reader.next();
          if (jobToken === "]") invalid();
        }
      } else {
        // Metadata is scalar. Never accumulate an unexpected unbounded value here.
        const scalar = await reader.next();
        if (typeof scalar !== "object") invalid();
        fields.set(key, scalar.value);
      }
      token = await reader.next();
      if (token === "}") break;
      if (token !== ",") invalid();
      token = await reader.next();
      if (token === "}") invalid();
    }
    if ((await reader.next()) !== undefined || fields.size !== 4) invalid();
    const revision = fields.get("revision");
    const checksum = fields.get("checksum");
    if (
      fields.get("schemaVersion") !== 1 ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof checksum !== "string" ||
      !/^[a-f0-9]{64}$/u.test(checksum)
    ) {
      invalid();
    }
    hash.update(`],"revision":${String(revision)},"schemaVersion":1}`);
    if (hash.digest("hex") !== checksum) {
      throw new Error("Direct job snapshot checksum does not match");
    }
    return { revision, checksum, jobCount };
  } finally {
    stream.destroy();
  }
}

class JsonReader {
  constructor(private readonly source: AsyncGenerator<Token>) {}

  async next(): Promise<Token | undefined> {
    return (await this.source.next()).value;
  }

  async expect(expected: string): Promise<void> {
    if ((await this.next()) !== expected) invalid();
  }

  async value(token: Token | undefined, depth = 0): Promise<unknown> {
    if (depth > 512) invalid();
    if (typeof token === "object") return token.value;
    if (token === "{") {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let key = await this.next();
      while (key !== "}") {
        if (typeof key !== "object" || typeof key.value !== "string") invalid();
        if (Object.hasOwn(result, key.value)) invalid();
        await this.expect(":");
        result[key.value] = await this.value(await this.next(), depth + 1);
        key = await this.next();
        if (key === "}") break;
        if (key !== ",") invalid();
        key = await this.next();
        if (key === "}") invalid();
      }
      return result;
    }
    if (token === "[") {
      const result: unknown[] = [];
      let item = await this.next();
      while (item !== "]") {
        result.push(await this.value(item, depth + 1));
        item = await this.next();
        if (item === "]") break;
        if (item !== ",") invalid();
        item = await this.next();
        if (item === "]") invalid();
      }
      return result;
    }
    return invalid();
  }
}

async function* tokens(stream: AsyncIterable<string | Buffer>): AsyncGenerator<Token> {
  let mode: "idle" | "string" | "primitive" = "idle";
  let escaped = false;
  let parts: string[] = [];
  for await (const buffer of stream) {
    const chunk = String(buffer);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index] as string;
      if (mode === "string") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') {
          parts.push(chunk.slice(start, index + 1));
          yield { value: JSON.parse(parts.join("")) as unknown };
          parts = [];
          mode = "idle";
        }
        continue;
      }
      if (mode === "primitive") {
        if (!/[\s{}[\],:]/u.test(character)) continue;
        parts.push(chunk.slice(start, index));
        yield { value: JSON.parse(parts.join("")) as unknown };
        parts = [];
        mode = "idle";
      }
      if (/^[\x20\t\r\n]$/u.test(character)) continue;
      if ("{}[],:".includes(character)) yield character;
      else {
        start = index;
        mode = character === '"' ? "string" : "primitive";
      }
    }
    if (mode !== "idle") parts.push(chunk.slice(start));
  }
  if (mode === "string") invalid();
  if (mode === "primitive") yield { value: JSON.parse(parts.join("")) as unknown };
}

function invalid(): never {
  throw new Error("Direct job snapshot is not a valid version 1 JSON ledger");
}
