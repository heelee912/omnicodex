/** Compare callable contracts without changing the native descriptor returned to clients. */
export function toolForCatalogConvergence(
  tool: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const comparable = { ...tool };
  delete comparable.icons;
  if (typeof tool.description === "string") {
    comparable.description = tool.description.replace(
      / This tool is part of plugin `[^`\r\n]+`\.$/u,
      "",
    );
  }
  return comparable;
}

export function toolsForCatalogConvergence(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, tool]) => [
      name,
      typeof tool === "object" && tool !== null && !Array.isArray(tool)
        ? toolForCatalogConvergence(tool as Record<string, unknown>)
        : tool,
    ]),
  );
}
