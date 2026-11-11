import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { withCodeModeWebPlatformGlobals } from "../src/application/code-mode-web-platform-globals.js";

describe("Code Mode Web Platform globals", () => {
  it("runs the fs/readFile Base64-to-UTF-8 flow in a processless isolate", async () => {
    const text = vi.fn();
    const source = withCodeModeWebPlatformGlobals(`// @exec: {"max_output_tokens": 1000}
const file = { dataBase64: "SGVsbG8sIOyEuOqzhCDwn4yN" };
const bytes = Uint8Array.from(atob(file.dataBase64), (character) => character.charCodeAt(0));
const decoded = new TextDecoder().decode(bytes);
const encodedBytes = new TextEncoder().encode(decoded);
const encoded = btoa(String.fromCharCode(...encodedBytes));
const streaming = new TextDecoder();
const firstChunk = streaming.decode(Uint8Array.from([240, 159]), { stream: true });
const secondChunk = streaming.decode(Uint8Array.from([140, 141]));
text(JSON.stringify({
  decoded,
  encoded,
  forgivingBase64: atob(" YQ\\n") === "a",
  binaryBase64: btoa("\\u0000\\u00ff"),
  streamed: firstChunk + secondChunk,
  processType: typeof process,
  bufferType: typeof Buffer,
}));`);

    expect(source).toMatch(
      /^\/\/ @exec: \{"max_output_tokens": 1000\}\n\/\* OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1 \*\//u,
    );
    const injectedPrelude = source.slice(0, source.indexOf("const file"));
    expect(injectedPrelude).not.toMatch(/\bprocess\b|\bBuffer\b/u);

    await evaluate(source, text);

    expect(JSON.parse(String(text.mock.calls[0]?.[0]))).toEqual({
      decoded: "Hello, 세계 🌍",
      encoded: "SGVsbG8sIOyEuOqzhCDwn4yN",
      forgivingBase64: true,
      binaryBase64: "AP8=",
      streamed: "🌍",
      processType: "undefined",
      bufferType: "undefined",
    });
  });

  it("matches the Web error contracts and UTF-8 replacement behavior", async () => {
    const text = vi.fn();
    const source = withCodeModeWebPlatformGlobals(`
const errorName = (operation) => {
  try {
    operation();
    return "missing";
  } catch (error) {
    return error.name;
  }
};
const replacement = new TextDecoder().decode(new TextEncoder().encode("\\ud800"));
text(JSON.stringify({
  invalidBase64: errorName(() => atob("%%%")),
  invalidBinaryString: errorName(() => btoa("✓")),
  fatalUtf8: errorName(() => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([255]))),
  unsupportedEncoding: errorName(() => new TextDecoder("utf-16")),
  replacement,
}));`);

    await evaluate(source, text);

    expect(JSON.parse(String(text.mock.calls[0]?.[0]))).toEqual({
      invalidBase64: "InvalidCharacterError",
      invalidBinaryString: "InvalidCharacterError",
      fatalUtf8: "TypeError",
      unsupportedEncoding: "RangeError",
      replacement: "�",
    });
  });

  it("preserves native implementations without trusting marker text in user source", async () => {
    const text = vi.fn();
    const nativeDecoder = class {
      decode() {
        return "native-decoder";
      }
    };
    const source = withCodeModeWebPlatformGlobals(
      'const marker = "/* OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1 */"; text(JSON.stringify({ marker, decoded: new TextDecoder().decode(), base64: atob("ignored") }));',
    );

    expect(source.match(/OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1/gu)).toHaveLength(2);
    await evaluate(source, text, {
      atob: () => "native-atob",
      TextDecoder: nativeDecoder,
    });
    expect(JSON.parse(String(text.mock.calls[0]?.[0]))).toEqual({
      marker: "/* OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1 */",
      decoded: "native-decoder",
      base64: "native-atob",
    });
  });

  it("preserves CRLF Code Mode pragmas as the first line", () => {
    const source = withCodeModeWebPlatformGlobals(
      '// @exec: {"yield_time_ms": 10000}\r\ntext("ok");',
    );
    expect(
      source.startsWith(
        '// @exec: {"yield_time_ms": 10000}\r\n/* OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1 */ ',
      ),
    ).toBe(true);
    expect(source.endsWith('text("ok");')).toBe(true);
  });
});

async function evaluate(
  source: string,
  text: (value: unknown) => void,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const context = {
    ArrayBuffer,
    Uint8Array,
    atob: undefined,
    btoa: undefined,
    TextDecoder: undefined,
    TextEncoder: undefined,
    text,
    ...overrides,
  };
  await runInNewContext(`(async () => {\n${source}\n})()`, context);
}
