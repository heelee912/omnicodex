import { describe, expect, it } from "vitest";
import { inputSchemaFromToolDescription } from "../src/application/typescript-tool-schema.js";

describe("inputSchemaFromToolDescription", () => {
  it("preserves names, required fields, enums, arrays, and descriptions", () => {
    const description = `Run a command.\n\nexec tool declaration:\n\`\`\`ts
declare const tools: { exec_command(args: {
  // Shell command to execute.
  cmd: string;
  // Optional shell.
  shell?: string;
  sandbox_permissions?: "use_default" | "require_escalated";
  prefix_rule?: Array<string>;
  tty?: boolean;
}): Promise<unknown>; };
\`\`\``;

    expect(inputSchemaFromToolDescription("exec_command", description)).toEqual({
      type: "object",
      properties: {
        cmd: { type: "string", description: "Shell command to execute." },
        shell: { type: "string", description: "Optional shell." },
        sandbox_permissions: { enum: ["use_default", "require_escalated"] },
        prefix_rule: { type: "array", items: { type: "string" } },
        tty: { type: "boolean" },
      },
      required: ["cmd"],
      additionalProperties: false,
    });
  });

  it("returns a string schema for freeform nested tools", () => {
    const description = `exec tool declaration:\n\`\`\`ts
declare const tools: { apply_patch(input: string): Promise<unknown>; };
\`\`\``;
    expect(inputSchemaFromToolDescription("apply_patch", description)).toEqual({ type: "string" });
  });

  it("resolves local aliases, interfaces, enums, generics, and utility types", () => {
    const description = `Shared types.
\`\`\`typescript
enum Mode { Read = "read", Write = "write" }
type Identifier = string;
interface BaseArgs {
  /** Stable request identity. */
  readonly id: Identifier;
}
interface Payload<T> extends BaseArgs {
  // Exact operation mode.
  mode: Mode;
  value: T;
  note?: string | undefined;
}
type Selected = Pick<Payload<number>, "id" | "mode" | "value">;
declare const tools: {
  execute(args: Readonly<Partial<Selected>> & Required<Pick<Selected, "id">>): Promise<unknown>;
};
\`\`\``;

    expect(inputSchemaFromToolDescription("execute", description)).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "Stable request identity." },
        mode: { enum: ["read", "write"], description: "Exact operation mode." },
        value: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("projects finite Record, mapped, readonly array, and const-indexed types", () => {
    const description = `\`\`\`ts
type Channels = "stdout" | "stderr";
const statuses = ["queued", "running", "done"] as const;
type Status = typeof statuses[number];
type Output = { [K in Channels]?: ReadonlyArray<string> };
declare const tools: {
  wait(args: {
    output: Output;
    counts: Record<Channels, number>;
    status: Status;
  }): Promise<unknown>;
};
\`\`\``;

    expect(inputSchemaFromToolDescription("wait", description)).toEqual({
      type: "object",
      properties: {
        output: {
          type: "object",
          properties: {
            stdout: { type: "array", items: { type: "string" } },
            stderr: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        counts: {
          type: "object",
          properties: { stdout: { type: "number" }, stderr: { type: "number" } },
          required: ["stdout", "stderr"],
          additionalProperties: false,
        },
        status: { enum: ["queued", "running", "done"] },
      },
      required: ["output", "counts", "status"],
      additionalProperties: false,
    });
  });

  it("preserves required, optional, and variadic readonly tuple positions", () => {
    const description = `\`\`\`ts
declare const tools: {
  tuple(args: readonly [head: string, tail?: number, ...rest: boolean[]]): Promise<unknown>;
};
\`\`\``;

    expect(inputSchemaFromToolDescription("tuple", description)).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      minItems: 1,
      items: { type: "boolean" },
    });
  });

  it("keeps unresolved declarations callable and exposes exact compiler diagnostics", () => {
    const description = `\`\`\`ts
declare const tools: {
  future(args: ImportedArgs): Promise<unknown>;
};
\`\`\``;

    expect(inputSchemaFromToolDescription("future", description)).toEqual({
      "x-omnicodex-typescript-diagnostics": [
        {
          code: 2304,
          category: "Error",
          message: "Cannot find name 'ImportedArgs'.",
          start: 38,
          length: 12,
          source: "ImportedArgs",
        },
      ],
    });
  });

  it("does not silently omit a missing declaration", () => {
    expect(
      inputSchemaFromToolDescription(
        "missing",
        `\`\`\`ts\ndeclare const tools: { other(args: string): unknown };\n\`\`\``,
      ),
    ).toMatchObject({
      "x-omnicodex-open-fallback": {
        code: "tool_declaration_not_found",
        nodeKind: "SourceFile",
      },
    });
  });
});
