# Bounded owned remediation for the pinned utility corpus

## Evidence and denominator

The previous full pinned corpus audit checked **936/936 native cases** from
78 source families. It recorded **756 locally verified owned traces** and
**180 explicit unsupported cases** across 15 families.

On this branch, the pinned 12-case input suite was regenerated independently,
and all **84/84 cases** from the seven families below passed the owned interpreter,
exact archive replay, semantic-controller export, and independent V8 terminal
outcome check. All 84 exported *locally verified* episodes retain their provenance
and private verification evidence. This is **not** permission to mark them admitted
training episodes.

| Pinned source function | Newly checked inputs | Semantics |
| --- | ---: | --- |
| `arrays.ts/distinct` | 12/12 | `Set` allocation, ordered `has`/`add` mutations in an owned callback |
| `arrays.ts/withoutDuplicates` | 12/12 | Dense-array `Set` iteration and `Array.from(Set)` |
| `arrays.ts/tail` | 12/12 | Nonexecuted `new Error` branch retained without faking construction |
| `strings.ts/containsUppercaseCharacter` | 12/12 | Nonexecuted RegExp branch retained and explicitly refused if executed |
| `strings.ts/splitLines` | 12/12 | Exact owned CR/LF split regex, without capture |
| `strings.ts/splitLinesIncludeSeparators` | 12/12 | Exact owned CR/LF split regex, with captured delimiters |
| `strings.ts/escapeRegExpCharacters` | 12/12 | Exact global metacharacter escape regex with the literal `\\$&` replacement |

This recovers 84 previously unsupported invocations. The completed six-part
GitHub Actions audit at commit `a64957b` independently checked all 936 cases:
**840 locally verified, 84 unsupported, and 12 runtime failures**. The
`audit-entire-owned-corpus` job is the authoritative all-family regression
check; the 84-case focused audit alone is not a 936-case completion claim.

## Why these traces are suitable as candidates

- `Set` state is allocated by the owned runtime. Insertion order, SameValueZero
  comparisons (including `NaN` and signed zero), internal size, and inserts
  are represented as versioned, model-visible operations; no host `Set` is
  handed opaque guest state.
- Only dense ordinary owned arrays, `null`, `undefined`, and the empty
  constructor are in the supported `Set` constructor domain. Exotic,
  sparse, accessor, or arbitrary iterable behavior is not emulated.
- The two line-delimiter RegExp patterns and the pinned global metacharacter
  escape pattern are recognized by exact pattern **and flags**. Their supported
  `split` and `replace` leaves use bounded, deterministic guest-value logic.
  This is not a general host-RegExp escape hatch.
- Unsupported syntax in untaken branches is retained in the source and bytecode;
  if actually executed, the runtime records an unsupported completion rather
  than producing a fabricated successful trace.
- The exporter and serving-side controller replay the emitted allocation,
  value, and mutation records. Terminal results and source decisions are
  separately compared with independent V8 execution.

## Explicit remaining gaps

The remaining 96 nonverified cases belong to eight functions (12 inputs each):

- `arrays.ts/quickSelect`: **12 runtime failures** on an unsupported property receiver
  in its random-pivot/constructor path; matching a random pivot without
  owned nondeterminism would be unsound.
- `strings.ts/containsRTL`, `isBasicASCII`, `format`, and `format2`:
  top-level RegExp/static initialization and, for formatting, callback-based
  replacements are not fully modeled.
- `strings.ts/escape`: RegExp replacement callback and its `switch`
  control flow require an owned callback continuation.
- `strings.ts/lcut` and `rcut`: stateful global word-boundary matching,
  `lastIndex`, and repeated `exec`/`test` semantics remain unimplemented.

These are **not locally verified**: 84 are explicit `unsupported` cases and
12 are `runtime_failure` cases. Neither status represents a negative training label.
Do not promote them using a native `eval`, host-RegExp fallback, substituted
terminal answer, weakened replay check, or a forged operation receipt.

## Reproducing the complete audit

Run `npm ci` and `npm test`, then use the repository's pinned
`real-corpus.yml` workflow: it generates all 936 native observations,
runs a two-input smoke check, verifies six disjoint two-index partitions
covering every one of the 936 cases, and merges the provenance-checked
reports. The `owned-real-source-*` artifacts include separately marked,
locally verified candidate episodes. Report unsupported cases in the
denominator; do not treat them as silently skipped.
