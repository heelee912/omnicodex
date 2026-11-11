const WEB_PLATFORM_GLOBALS_MARKER = "/* OMNICODEX_CODE_MODE_WEB_PLATFORM_GLOBALS_V1 */";

/**
 * Adds the small Web Platform subset that Code Mode file workflows rely on.
 *
 * The processless Code Mode isolate intentionally has no Node `process` or
 * `Buffer` globals. Keep that boundary intact and implement the browser
 * contracts in terms of ordinary JavaScript plus Uint8Array. Native globals,
 * when a future runtime supplies them, always win.
 */
const WEB_PLATFORM_GLOBALS_PRELUDE = String.raw`${WEB_PLATFORM_GLOBALS_MARKER}
(() => {
  const __omniAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const __omniInvalidCharacter = (message) => {
    const error = new Error(message);
    error.name = "InvalidCharacterError";
    return error;
  };

  if (typeof globalThis.atob !== "function") {
    Object.defineProperty(globalThis, "atob", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function atob(value) {
        let input = String(value).replace(/[\t\n\f\r ]/g, "");
        if (input.length % 4 === 0) input = input.replace(/==?$/, "");
        if (input.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(input)) {
          throw __omniInvalidCharacter("The string to be decoded is not correctly encoded.");
        }
        const bytes = new Uint8Array(Math.floor((input.length * 6) / 8));
        let accumulator = 0;
        let bitCount = 0;
        let byteIndex = 0;
        for (let index = 0; index < input.length; index += 1) {
          accumulator = (accumulator << 6) | __omniAlphabet.indexOf(input[index]);
          bitCount += 6;
          if (bitCount >= 8) {
            bitCount -= 8;
            bytes[byteIndex] = (accumulator >> bitCount) & 255;
            byteIndex += 1;
            accumulator = bitCount === 0 ? 0 : accumulator & ((1 << bitCount) - 1);
          }
        }
        let output = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return output;
      },
    });
  }

  if (typeof globalThis.btoa !== "function") {
    Object.defineProperty(globalThis, "btoa", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function btoa(value) {
        const input = String(value);
        const output = [];
        for (let index = 0; index < input.length; index += 3) {
          const first = input.charCodeAt(index);
          const hasSecond = index + 1 < input.length;
          const hasThird = index + 2 < input.length;
          const second = hasSecond ? input.charCodeAt(index + 1) : 0;
          const third = hasThird ? input.charCodeAt(index + 2) : 0;
          if (first > 255 || second > 255 || third > 255) {
            throw __omniInvalidCharacter(
              "The string to be encoded contains characters outside of the Latin1 range.",
            );
          }
          output.push(
            __omniAlphabet[first >> 2],
            __omniAlphabet[((first & 3) << 4) | (second >> 4)],
            hasSecond ? __omniAlphabet[((second & 15) << 2) | (third >> 6)] : "=",
            hasThird ? __omniAlphabet[third & 63] : "=",
          );
        }
        return output.join("");
      },
    });
  }

  const __omniUtf8Bytes = (value) => {
    const bytes = [];
    for (const character of String(value)) {
      let point = character.codePointAt(0);
      if (point >= 55296 && point <= 57343) point = 65533;
      if (point <= 127) {
        bytes.push(point);
      } else if (point <= 2047) {
        bytes.push(192 | (point >> 6), 128 | (point & 63));
      } else if (point <= 65535) {
        bytes.push(224 | (point >> 12), 128 | ((point >> 6) & 63), 128 | (point & 63));
      } else {
        bytes.push(
          240 | (point >> 18),
          128 | ((point >> 12) & 63),
          128 | ((point >> 6) & 63),
          128 | (point & 63),
        );
      }
    }
    return bytes;
  };

  if (typeof globalThis.TextEncoder !== "function") {
    class TextEncoder {
      get encoding() {
        return "utf-8";
      }

      encode(value = "") {
        return Uint8Array.from(__omniUtf8Bytes(value));
      }

      encodeInto(value, destination) {
        if (!(destination instanceof Uint8Array)) {
          throw new TypeError("TextEncoder.encodeInto requires a Uint8Array destination.");
        }
        const input = String(value);
        let read = 0;
        let written = 0;
        for (const character of input) {
          const bytes = __omniUtf8Bytes(character);
          if (written + bytes.length > destination.length) break;
          destination.set(bytes, written);
          written += bytes.length;
          read += character.length;
        }
        return { read, written };
      }
    }
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: TextEncoder,
    });
  }

  if (typeof globalThis.TextDecoder !== "function") {
    const __omniReplacement = 65533;
    const __omniBufferSource = (input) => {
      if (input === undefined) return new Uint8Array(0);
      if (input instanceof Uint8Array) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) {
        return new Uint8Array(input);
      }
      if (
        input !== null &&
        typeof input === "object" &&
        input.buffer !== undefined &&
        Number.isSafeInteger(input.byteOffset) &&
        Number.isSafeInteger(input.byteLength)
      ) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      throw new TypeError("TextDecoder.decode requires an ArrayBuffer or ArrayBufferView.");
    };
    const __omniCodePointsToString = (points) => {
      let result = "";
      for (let offset = 0; offset < points.length; offset += 4096) {
        result += String.fromCodePoint(...points.slice(offset, offset + 4096));
      }
      return result;
    };

    class TextDecoder {
      constructor(label = "utf-8", options = {}) {
        const normalized = String(label).trim().toLowerCase();
        if (normalized !== "utf-8" && normalized !== "utf8" && normalized !== "unicode-1-1-utf-8") {
          throw new RangeError("The encoding label provided must be utf-8.");
        }
        this._fatal = Boolean(options.fatal);
        this._ignoreBOM = Boolean(options.ignoreBOM);
        this._pending = new Uint8Array(0);
        this._streaming = false;
        this._bomSeen = false;
      }

      get encoding() {
        return "utf-8";
      }

      get fatal() {
        return this._fatal;
      }

      get ignoreBOM() {
        return this._ignoreBOM;
      }

      decode(input, options = {}) {
        const stream = Boolean(options.stream);
        if (!this._streaming) {
          this._pending = new Uint8Array(0);
          this._bomSeen = false;
        }
        const next = __omniBufferSource(input);
        const bytes = new Uint8Array(this._pending.length + next.length);
        bytes.set(this._pending, 0);
        bytes.set(next, this._pending.length);
        this._pending = new Uint8Array(0);
        const points = [];
        const invalid = () => {
          if (this._fatal) throw new TypeError("The encoded data was not valid UTF-8.");
          points.push(__omniReplacement);
        };
        let index = 0;
        while (index < bytes.length) {
          const first = bytes[index];
          if (first <= 127) {
            points.push(first);
            index += 1;
            continue;
          }
          let length = 0;
          let point = 0;
          let secondMinimum = 128;
          let secondMaximum = 191;
          if (first >= 194 && first <= 223) {
            length = 2;
            point = first & 31;
          } else if (first >= 224 && first <= 239) {
            length = 3;
            point = first & 15;
            if (first === 224) secondMinimum = 160;
            if (first === 237) secondMaximum = 159;
          } else if (first >= 240 && first <= 244) {
            length = 4;
            point = first & 7;
            if (first === 240) secondMinimum = 144;
            if (first === 244) secondMaximum = 143;
          } else {
            invalid();
            index += 1;
            continue;
          }
          if (index + length > bytes.length) {
            if (stream) {
              this._pending = bytes.slice(index);
              break;
            }
            invalid();
            index = bytes.length;
            continue;
          }
          let valid = true;
          let invalidOffset = 1;
          for (let offset = 1; offset < length; offset += 1) {
            const current = bytes[index + offset];
            const minimum = offset === 1 ? secondMinimum : 128;
            const maximum = offset === 1 ? secondMaximum : 191;
            if (current < minimum || current > maximum) {
              valid = false;
              invalidOffset = offset;
              break;
            }
            point = (point << 6) | (current & 63);
          }
          if (!valid) {
            invalid();
            index += invalidOffset;
            continue;
          }
          points.push(point);
          index += length;
        }
        this._streaming = stream;
        if (!stream) this._pending = new Uint8Array(0);
        let output = __omniCodePointsToString(points);
        if (!this._bomSeen && output.length > 0) {
          this._bomSeen = true;
          if (!this._ignoreBOM && output.charCodeAt(0) === 65279) output = output.slice(1);
        }
        return output;
      }
    }
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: TextDecoder,
    });
  }
})();`.replace(/\r?\n[\t ]*/gu, " ");

/** Preserves the optional first-line Code Mode pragma while installing globals. */
export function withCodeModeWebPlatformGlobals(source: string): string {
  const pragma = /^[\t ]*\/\/[\t ]*@exec:[^\r\n]*(?:\r?\n|$)/u.exec(source);
  if (pragma === null) return `${WEB_PLATFORM_GLOBALS_PRELUDE}\n${source}`;
  const firstLine = pragma[0].replace(/\r?\n$/u, "");
  const newline = pragma[0].endsWith("\r\n") ? "\r\n" : "\n";
  return `${firstLine}${newline}${WEB_PLATFORM_GLOBALS_PRELUDE}${newline}${source.slice(pragma[0].length)}`;
}
