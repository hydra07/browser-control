# Identity regressions — R0-03

The offline contract in `app/extension/modules/snapshot/identity.test.ts` runs the existing AX
candidate builder **and** `SemanticState`. It uses the versioned R0-02 captures for insertion,
duplicate controls, reorder, physical replacement and virtualized reuse. Title and label changes
are controlled AX mutations of those captures; ancestor rename uses a named group around the same
captured control. These three mutations are not additional live Chrome recordings.

The oracle uses the fixture's document UUID, physical WeakMap witness, DOM handle and business
anchor. It compares ref relationships, not literal `eN` numbers. Both old-ref resolution and current
ref assignment are checked: a ref that resolves to a different row is a failure even if the number
still exists. Fixture/adapter setup happens outside expected-failure callbacks, so a broken import,
missing target or invalid physical continuity cannot masquerade as a reproduced identity bug.

## Reproduced failures

All five ordinary assertions failed on the current engine before being marked as expected failures.
The original local run is preserved in ignored `data/control-readiness-r0-03-reproduced.log`.

| Contract | Current result | Required result |
| --- | --- | --- |
| Document title changes in the AX root | Save receives a fresh ref | Same physical control retains its ref |
| Named ancestor changes name | Descendant Save receives a fresh ref | Same physical control retains its ref |
| Control changes accessible name | Control receives a fresh ref | Same physical control retains its ref |
| Identical Open controls reorder across rows | The two refs exchange physical targets | Each ref stays with its original physical button |
| Known identical DOM replacement | Old executable ref resolves to the replacement | R0-02 physical replacement contract: old ref stale, fresh node gets a fresh ref |

The current matcher starts from name-bearing structural paths. Physical backend matching happens
only within those groups, so it cannot rescue an unchanged node after the path changes. Separate row
paths can also hide the duplicate relationship and permit the ordinal path to take over another
button's ref. Unique structural/name matches currently accept a new backend node without proving
physical continuity or a guarded semantic rebind.

The replacement assertion deliberately follows R0-02's independently recorded physical contract.
The older `semanticState.test.ts` test that preserves a ref across a changed backend ID is a legacy
characterization of structural reuse, not evidence of safe physical continuity. R2-04 must reconcile
that behavior with the physical-first algorithm and explicit, uniquely verified semantic matching;
it must not treat these stored offline handles as executable state.

## Passing controls and limits

Ordinary tests also cover unchanged AX with metadata-only title updates, unrelated sibling insertion,
identical sibling insertion, duplicate refs with uncertain nodes excluded from resolution, physical
identity across both virtualized windows, and rejection of the old scope after document replacement.
The virtualized case proves physical continuity while its independent business anchor changes
ORD-42 → ORD-44 → ORD-42. It does **not** prove production fingerprint/final guards reject stale order
context; those remain R2-07/R1-07 work. No offscreen-row removal is inferred.

These tests use sanitized, already validated single-frame fixtures. They do not start Chrome, prove
live collection timing, implement resume, or fix the identity engine. Go corpus tests still validate
the source captures and their physical witnesses separately.

## Run and fix

From the repository root, the ordinary suite runs every known failure with Bun's `test.failing`:

```powershell
bun test app/extension/modules/snapshot/identity.test.ts
```

An expected failure that starts passing makes the suite fail, requiring its marker to be removed.
Nothing is skipped or marked TODO. To run the desired contracts as ordinary assertions:

```powershell
$env:BROWSERCONTROL_IDENTITY_STRICT = '1'
try {
    bun test app/extension/modules/snapshot/identity.test.ts
} finally {
    Remove-Item Env:BROWSERCONTROL_IDENTITY_STRICT
}
```

The current strict run must exit 1 with five failing assertions. R2-04 removes each expected-failure
marker as its contract is fixed; the final strict run must pass. Keep the passing controls and the
independent fixture oracle intact when moving the suite to page core.
