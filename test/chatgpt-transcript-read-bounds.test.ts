import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : [".ts", ".mjs"].includes(extname(entry.name))
        ? [path]
        : [];
  });
}

it("keeps every ChatGPT transcript request bounded to the current turn", () => {
  const files = [...sourceFiles("src"), ...sourceFiles(join("scripts", "oracle"))];
  const requests = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/num_turns\s*:\s*(\d+)/g)].map((match) => ({
      file,
      value: Number(match[1]),
    })),
  );

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((request) => request.value !== 1)).toEqual([]);
});
