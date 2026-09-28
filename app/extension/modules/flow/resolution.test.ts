import { describe, expect, test } from "bun:test";
import { selectUniqueCandidate } from "./resolution.js";

describe("flow target resolution", () => {
    test("selects one unique identity and tolerates duplicate AX wrappers", () => {
        expect(selectUniqueCandidate([{ id: 11 }, { id: 11 }], (candidate) => candidate.id)).toEqual({
            kind: "matched",
            value: { id: 11 },
        });
    });

    test("fails closed for missing or ambiguous identities", () => {
        expect(selectUniqueCandidate([], (candidate: { id: number }) => candidate.id)).toEqual({ kind: "not_found" });
        expect(selectUniqueCandidate([{ id: 11 }, { id: 12 }], (candidate) => candidate.id)).toEqual({
            kind: "ambiguous",
            count: 2,
        });
    });
});
