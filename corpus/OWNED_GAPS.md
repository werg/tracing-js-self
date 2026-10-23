# Owned real-source corpus coverage and semantic work queue

**Snapshot:** 2026-10-23, 78 pinned function families, two deterministic
invocations each (156). This is a sampled **owned-interpreter** comparison,
not a measurement of all JavaScript behavior and not training admission.
The independent native V8 diagnostic corpus has 936 matching outcomes, but
native agreement does not prove owned trace semantics.

The historical two-input baseline below remains a useful smoke benchmark.
The new **all-936-invocation** owned verification and **912-case** stateful
diagnostic report supersede it for coverage accounting; see
[FULL_CORPUS_EVAL.md](FULL_CORPUS_EVAL.md).

## Rechecked owned execution

| Result | Invocations |
| --- | ---: |
| Locally verified (owned replay, source-boundary operations, V8 controls, public trajectory, serialized evidence) | **93** |
| Unsupported owned profile | 40 |
| Owned runtime failure | 15 |
| Exact upstream helper bundle exceeds current source budget | 8 |
| **Total** | **156** |

The original committed 2026-10-23 baseline was **24/156**, and current
`main` already verified **83/156** before the improvements in this PR.
The new **10** verified invocations come from (1) multiple `let` bindings
in counted `for` initializers (4), (2) bounded string `substr` (2), and
(3) bounded array `for…of` (4). CI guards this total; coverage must never be
increased by treating unsupported execution as a successful trace.

## Remaining blocker classes

| Count | Root cause | Required sound design |
| ---: | --- | --- |
| 14 | RegExp literals, pattern/string operations | Explicit owned RegExp identity, flags, `lastIndex`, captures and stateful matching; source-anchored effects and independent V8 checks. |
| 12 | Top-level source declarations outside function-only profile | Deterministic module/constant initialization, including pinned exports and named helper data, without editing upstream source or hiding initial effects. |
| 11 | Unmodeled ordinary property access, chiefly array higher-order methods | Owned, resuming callback continuations for `filter`, `map`, `reduce`, `sort` and their observable length/index reads; preserve mutation/reentry/throw behavior. |
| 8 | `new` expressions, including collections and errors | Typed constructors and owned collection operations with observable identity; fail closed on unknown prototypes. |
| 8 | Complete pinned helper bundle above the source budget | Source-splitting / dependency-context design retaining original bytes, original source sites and model visibility; no silent source replacement. |
| 4 | Array-length expansion / sparse intermediate state | Own array holes, index descriptors, `length` semantics and coupled atomic mutations; an absent element cannot be rewritten as present `undefined`. |
| 4 | Completed-returns-only training gate | Determine which cases actually require abrupt/final throw modeling, and extend the public controller only with independently checked completion traces. |
| 2 | Rest parameter declaration | Owned rest argument allocation and alias/length semantics; no invisible host spread. |
| **63** | **Unverified owned executions** | **Remain diagnostic-only; never admitted** |

**The native-V8 stateful adversarial benchmark** is a separate 912-execution
suite. It verifies independently reproduced final effects, not owned
`semantic-execution/2` records. It therefore remains diagnostic-only.

## Training data boundary

Use the separately versioned corpus bridge:

```sh
npm run corpus:generate -- --per-function 2 --output corpus/out/traces.jsonl \
  --report corpus/out/report.json --review corpus/out/review.md
npm run corpus:owned-coverage -- \
  --input corpus/out/traces.jsonl \
  --output corpus/out/owned-coverage.json --per-function 2 \
  --min-owned-verified 93 \
  --local-episodes corpus/out/owned-locally-verified.jsonl
```

The exported JSONL is **locally verified candidate** material, not admitted
training examples. Only `public.groups` are model-facing. Private
`sidecar` data contains independent V8 receipts, archive, lineage and
validation metadata. Do not train a predictor on its private answers or let
it enter generation context. An independent external megatoken
schema/teacher-conditioning/serving gate must explicitly admit each episode.
Splits are frozen by source family, not by input vector; source SHA-256,
upstream revision, license and fixture index are retained.

The bridge refuses discrepancies in source bytes, upstream revision, source
license, URL and split, and fails a recheck of serialized independent evidence.
A green native-corpus workflow is **not** equivalent to full semantic coverage.
