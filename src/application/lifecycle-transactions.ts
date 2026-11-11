export interface SecretReferenceStore {
  put(name: string, secret: string): Promise<string>;
  remove(reference: string): Promise<void>;
}

export interface AuthRotationState {
  readonly activeReference: string;
  readonly previousReference?: string;
}

export async function rotateReferencedSecret(
  store: SecretReferenceStore,
  name: string,
  secret: string,
  current?: AuthRotationState,
): Promise<AuthRotationState> {
  if (secret.length < 16) throw new Error("Refusing to rotate an empty or weak secret");
  const next = await store.put(name, secret);
  if (next.length === 0 || next === secret) {
    throw new Error("Secret stores must return an opaque reference, never secret material");
  }
  return {
    activeReference: next,
    ...(current === undefined ? {} : { previousReference: current.activeReference }),
  };
}

export interface ReleaseSwitchAdapter {
  stage(version: string): Promise<string>;
  validate(stagedPath: string): Promise<void>;
  current(): Promise<string | undefined>;
  switchAtomically(stagedPath: string): Promise<void>;
  rollback(previousPath: string): Promise<void>;
}

export interface ReleaseSwitchResult {
  readonly version: string;
  readonly activePath: string;
  readonly previousPath?: string;
}

/** Shadow-validates before switching and restores the exact prior release on switch failure. */
export async function installValidatedRelease(
  adapter: ReleaseSwitchAdapter,
  version: string,
): Promise<ReleaseSwitchResult> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid release version");
  }
  const stagedPath = await adapter.stage(version);
  await adapter.validate(stagedPath);
  const previousPath = await adapter.current();
  try {
    await adapter.switchAtomically(stagedPath);
  } catch (error) {
    if (previousPath !== undefined) await adapter.rollback(previousPath);
    throw error;
  }
  return {
    version,
    activePath: stagedPath,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}
