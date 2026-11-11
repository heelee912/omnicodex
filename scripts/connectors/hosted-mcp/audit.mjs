import { open } from "node:fs/promises";
import { stateFile } from "./state.mjs";

const events = new Set(["request", "catalog"]);
const methods = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
const outcomes = new Set(["ok", "failed", "tool_error"]);

export function redactAudit(record) {
  const safe = { time: new Date().toISOString() };
  if (events.has(record.event)) safe.event = record.event;
  if (methods.has(record.method)) safe.method = record.method;
  if (outcomes.has(record.outcome)) safe.outcome = record.outcome;
  for (const key of ["status", "elapsedMs", "toolCount"]) {
    if (Number.isSafeInteger(record[key]) && record[key] >= 0) safe[key] = record[key];
  }
  return safe;
}

export function createAudit(state, enabled = false) {
  let queue = Promise.resolve();
  const audit = (record) => {
    if (!enabled) return;
    const line = `${JSON.stringify(redactAudit(record))}\n`;
    queue = queue
      .then(async () => {
        const file = await open(await stateFile(state, "connection.log.jsonl"), "a", 0o600);
        try {
          await file.writeFile(line, "utf8");
        } finally {
          await file.close();
        }
      })
      .catch(() => {
        process.stderr.write("Could not write redacted hosted MCP audit log.\n");
      });
  };
  audit.flush = () => queue;
  return audit;
}
