interface OracleGoalClientCandidate<T> {
  readonly client: T;
  readonly conversationUrls: ReadonlySet<string>;
  readonly primary: boolean;
  readonly connectorId?: string;
}

/** Select one observed account/session route without trying another account. */
export function selectOracleGoalClient<T extends { readonly accountSourceId?: string | undefined }>(
  target: {
    readonly accountSourceId?: string;
    readonly conversationUrl: string;
    readonly connectorId?: string;
  },
  candidates: readonly OracleGoalClientCandidate<T>[],
): T | undefined {
  const eligible = candidates.filter(
    (candidate) =>
      (target.accountSourceId === undefined ||
        candidate.client.accountSourceId === target.accountSourceId) &&
      (target.connectorId === undefined || candidate.connectorId === target.connectorId),
  );
  const observed = eligible.filter((candidate) =>
    candidate.conversationUrls.has(target.conversationUrl),
  );
  if (target.accountSourceId === undefined) {
    const accounts = new Set(
      observed.flatMap((candidate) =>
        candidate.client.accountSourceId === undefined ? [] : [candidate.client.accountSourceId],
      ),
    );
    if (accounts.size > 1) return undefined;
  }
  if (observed.length > 0) {
    return (observed.find((candidate) => candidate.primary) ?? observed[0])?.client;
  }
  const primary = eligible.find((candidate) => candidate.primary);
  if (primary !== undefined) return primary.client;
  if (target.accountSourceId !== undefined || eligible.length === 1) return eligible[0]?.client;
  return undefined;
}
