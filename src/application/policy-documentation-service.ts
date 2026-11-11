import { protectedBrowserPolicyFile } from "../domain/protected-policy-document.js";
import { ProtectedPolicyLibrary } from "../infrastructure/safety/protected-policy-library.js";
import type { BrowserNativeSurface } from "./browser-native-executor.js";

/** Serves policy text from the protected Markdown source, independent of the installed browser reader. */
export class PolicyDocumentationService {
  readonly #library: ProtectedPolicyLibrary;

  constructor(codexHome: string) {
    this.#library = new ProtectedPolicyLibrary(codexHome);
  }

  async readBrowserDocument(
    name: string,
    surface: BrowserNativeSurface,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const fileName = protectedBrowserPolicyFile(name, surface);
    return fileName === undefined ? undefined : this.#library.read(fileName, signal);
  }
}
