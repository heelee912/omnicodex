import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ACTIVE_DIRECTORY_NAME = "durable-mcp-events";

export interface DurableMcpEventDirectoryLayout {
  /** The single authoritative location for new events and restart replay. */
  readonly activeDirectory: string;
  /** Ordered replay locations. Current OmniCodex has no legacy compatibility store. */
  readonly replayDirectories: readonly string[];
}

/**
 * Prepares the single current durable-event directory.
 *
 * Older builds kept a second compatibility store and replayed it at every
 * startup. That store accumulated tens of thousands of obsolete snapshots,
 * inflated disk usage, and made restart work proportional to historical test
 * traffic. The current product has one authoritative store; migrations belong
 * to an explicit offline release operation, never the live daemon bootstrap.
 */
export async function prepareDurableMcpEventDirectoryLayout(
  dataRoot: string,
): Promise<DurableMcpEventDirectoryLayout> {
  const activeDirectory = join(resolve(dataRoot), ACTIVE_DIRECTORY_NAME);
  await mkdir(activeDirectory, { recursive: true });
  return {
    activeDirectory,
    replayDirectories: [activeDirectory],
  };
}
