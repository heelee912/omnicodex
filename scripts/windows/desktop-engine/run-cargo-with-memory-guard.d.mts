export declare class EngineBuildMemoryPressure extends Error {
  readonly availableVirtualMb: number;
}

export declare function runCargoWithMemoryGuard(
  cargo: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    readAvailableMb?: () => number;
    pollIntervalMs?: number;
  },
): Promise<void>;
