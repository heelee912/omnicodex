import { createHash } from "node:crypto";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProtectedFileObservation } from "../../domain/non-interference.js";

export interface ProtectedFileTarget {
  readonly logicalName: string;
  readonly path: string;
}

export async function observeProtectedFile(
  target: ProtectedFileTarget,
): Promise<ProtectedFileObservation> {
  const requestedPath = resolve(target.path);
  let canonicalPath = requestedPath;

  try {
    const requestedStat = await lstat(requestedPath);
    if (requestedStat.isSymbolicLink()) {
      return {
        logicalName: target.logicalName,
        canonicalPath,
        status: "unverifiable",
        errorCode: "SYMLINK_NOT_ALLOWED",
      };
    }
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      return {
        logicalName: target.logicalName,
        canonicalPath,
        status: "missing",
      };
    }
    return {
      logicalName: target.logicalName,
      canonicalPath,
      status: "unverifiable",
      ...(code === undefined ? {} : { errorCode: code }),
    };
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalPath, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return {
        logicalName: target.logicalName,
        canonicalPath,
        status: "unverifiable",
        errorCode: "NOT_REGULAR_FILE",
      };
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return {
        logicalName: target.logicalName,
        canonicalPath,
        status: "unverifiable",
        errorCode: "FILE_CHANGED_DURING_READ",
      };
    }

    return {
      logicalName: target.logicalName,
      canonicalPath,
      status: "present",
      sizeBytes: before.size.toString(),
      modifiedAtUnixMs: Number(before.mtimeNs / 1_000_000n),
      fileIdentity: `${before.dev.toString()}:${before.ino.toString()}`,
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      return {
        logicalName: target.logicalName,
        canonicalPath,
        status: "missing",
      };
    }
    return {
      logicalName: target.logicalName,
      canonicalPath,
      status: "unverifiable",
      ...(code === undefined ? {} : { errorCode: code }),
    };
  } finally {
    await handle?.close();
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
