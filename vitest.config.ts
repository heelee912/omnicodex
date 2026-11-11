import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "prefer-authoritative-typescript-sources",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer === undefined || !source.startsWith(".") || !source.endsWith(".js")) {
          return null;
        }
        const typescriptSource = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
        return existsSync(typescriptSource) ? typescriptSource : null;
      },
    },
  ],
  test: {
    coverage: {
      enabled: false,
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The durability suites intentionally exercise thousands of real Windows
    // filesystem operations. Unbounded worker fan-out turns disk contention
    // into false 10-second failures and leaves timed-out resources pending.
    // These limits apply only to the regression runner, never product calls.
    maxWorkers: 4,
    testTimeout: 60_000,
  },
});
