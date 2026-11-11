/** Returns one complete JSON-safe representation of an Error or rejection value. */
export function structuredErrorDetails(
  value: unknown,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (!(value instanceof Error)) {
    return { name: "Error", message: errorMessage(value), value: jsonSafeErrorValue(value, seen) };
  }
  if (seen.has(value)) {
    return { name: value.name, message: value.message, cause: "[Circular]" };
  }
  seen.add(value);
  try {
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
    if (value.cause !== undefined) {
      details.cause = jsonSafeErrorValue(value.cause, seen);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (["name", "message", "stack", "cause"].includes(key)) continue;
      try {
        details[key] = jsonSafeErrorValue(Reflect.get(value, key), seen);
      } catch (error) {
        details[key] = { inaccessible: true, reason: String(error) };
      }
    }
    return details;
  } finally {
    seen.delete(value);
  }
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const message = Reflect.get(value, "message");
    if (typeof message === "string") return message;
  }
  return String(value);
}

function jsonSafeErrorValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) return structuredErrorDetails(value, seen);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      return value.map((item) => jsonSafeErrorValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        try {
          output[key] = jsonSafeErrorValue(Reflect.get(value, key), seen);
        } catch (error) {
          output[key] = { inaccessible: true, reason: String(error) };
        }
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}
