import { chmod, readFile } from "node:fs/promises";

const path = new URL("../dist/cli.js", import.meta.url);
const source = await readFile(path, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("Built CLI is missing its executable Node.js shebang");
}
await chmod(path, 0o755);
