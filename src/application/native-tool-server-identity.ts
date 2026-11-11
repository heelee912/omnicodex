import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const IDENTITY_DOMAIN = "omnicodex-mcp-server\0";

/**
 * Derives the stable, public identity of one OmniCodex MCP deployment from its
 * OAuth protected-resource URL. The URL already belongs to the public MCP
 * contract; only its digest is advertised on tools.
 */
export function omniCodexServerIdentityFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const resource = metadata?.resource;
  if (typeof resource !== "string" || resource.length === 0) return undefined;
  let canonicalResource: string;
  try {
    canonicalResource = new URL(resource).href;
  } catch {
    return undefined;
  }
  return createHash("sha256")
    .update(IDENTITY_DOMAIN, "utf8")
    .update(canonicalResource, "utf8")
    .digest("hex");
}

/** Adds the exact deployment marker without replacing native tool metadata. */
export function withOmniCodexServerIdentity(tool: Tool, serverIdentity: string): Tool {
  const meta = objectRecord(tool._meta);
  const omniCodex = objectRecord(meta.omnicodex);
  return {
    ...tool,
    _meta: {
      ...meta,
      omnicodex: {
        ...omniCodex,
        serverIdentity,
      },
    },
  } as Tool;
}

/** Reads an exact deployment marker previously advertised by OmniCodex. */
export function omniCodexServerIdentity(tool: Tool): string | undefined {
  const value = objectRecord(objectRecord(tool._meta).omnicodex).serverIdentity;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
