export type CandidateResolution<T> =
    | { kind: "matched"; value: T }
    | { kind: "not_found" }
    | { kind: "ambiguous"; count: number };

/** Selects a candidate only when all matches resolve to one unique identity. */
export function selectUniqueCandidate<T, K>(
    candidates: readonly T[],
    identity: (candidate: T) => K | undefined,
): CandidateResolution<T> {
    const identified = candidates
        .map((candidate) => ({ candidate, key: identity(candidate) }))
        .filter((entry): entry is { candidate: T; key: K } => entry.key !== undefined);
    if (identified.length === 0) return { kind: "not_found" };

    const unique = new Map<K, T>();
    for (const entry of identified) unique.set(entry.key, entry.candidate);
    if (unique.size > 1) return { kind: "ambiguous", count: unique.size };
    return { kind: "matched", value: unique.values().next().value as T };
}
