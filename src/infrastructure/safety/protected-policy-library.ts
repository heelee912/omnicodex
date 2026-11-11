import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Reads the protected source on every request so edits take effect without a runtime restart. */
export class ProtectedPolicyLibrary {
  readonly #root: string;

  constructor(codexHome: string) {
    this.#root = join(codexHome, "protected-confirmation-docs");
  }

  async read(fileName: string, signal?: AbortSignal): Promise<string> {
    if (!/^[a-z][a-z0-9-]*\.md$/u.test(fileName)) {
      throw new Error("Protected policy file name is invalid");
    }
    const manifest = JSON.parse(
      await readFile(join(this.#root, "manifest.json"), { encoding: "utf8", signal }),
    ) as unknown;
    if (!Array.isArray(manifest)) throw new Error("Protected policy manifest is invalid");
    const entries = manifest.filter(
      (entry): entry is { Source: string; SHA256: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.Source === "string" &&
        typeof entry.SHA256 === "string" &&
        basename(entry.Source).toLowerCase() === fileName.toLowerCase(),
    );
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined || !/^[a-f0-9]{64}$/iu.test(entry.SHA256)) {
      throw new Error(`Protected policy manifest has no unique hash for ${fileName}`);
    }
    const markdown = await readFile(join(this.#root, fileName), { encoding: "utf8", signal });
    const actualHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    if (actualHash.toLowerCase() !== entry.SHA256.toLowerCase()) {
      throw new Error(`Protected policy hash mismatch: ${fileName}`);
    }
    if (!/^#{1,6}[\t ]+\S/mu.test(markdown) || !/[가-힣]/u.test(markdown)) {
      throw new Error(`Protected policy is not Korean Markdown: ${fileName}`);
    }
    return markdown;
  }
}
