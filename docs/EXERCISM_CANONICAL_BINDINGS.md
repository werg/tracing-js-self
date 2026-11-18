# Explicit JavaScript bindings for pinned Exercism cases

The real-source collector retains the pinned, language-neutral canonical input
and expected result separately from the actual JavaScript invocation. It does
not change upstream files or infer an argument from a desired outcome.

Three bindings are explicit in `src/corpus/owned-exercism.mjs`:

| Canonical case | JavaScript binding | Retained evidence |
| --- | --- | --- |
| Two Fer, `name: null` means no name | Call `twoFer()` with zero arguments so the pinned function's default parameter applies | Original `{name: null}`, empty argument vector, versioned argument binding |
| Legacy Knapsack case with an empty `items` record | Pass an empty JavaScript array; the pinned canonical file also contains the replacement array case and permits language-specific input types | Original empty record and case ID, adapted array argument, versioned argument binding |
| Grains integer result | Compare against a JavaScript BigInt with the exact integer token from the pinned JSON syntax tree | Original parsed expected value and an exact decimal expected-value binding |

The Grains binding reads the numeric token before JSON number rounding. For
example, the pinned total is exactly `18446744073709551615`, not its nearest
floating-point approximation. The decimal binding is JSON-safe, survives
serialization, and is checked against the parsed canonical number. A manually
provided unsafe integer without its exact token is refused. This parsing path
works with the repository's Node 20 CI lane and does not depend on newer JSON
reviver-context support.

Fresh generation still executes the original pinned source and transformed
source independently before owned interpretation, source/operation/branch
agreement, replay, and the native-consumer gate. The expected-value binding is
applied only to the independent canonical comparison; it does not alter a
guest result or the teacher's execution.

A canonical `{error: ...}` expectation now requires an actual throw. A normal
return cannot pass merely because the canonical case describes an error.
Language-neutral error text does not specify JavaScript exception wording, so
that gate records `canonicalErrorMessageCompared: false`. The separate
original-source and owned-runtime checks still require exact agreement on the
actual observable exception name/message under the declared error profile.

`sourceProvenance.upstream` retains `canonicalInput`,
`canonicalArgumentBinding`, `canonicalExpected`, `canonicalExpectedBinding`,
the upstream source and canonical-file hashes, and the fresh
`originalSourceCheck.canonicalExpectation`. Historical campaign objects retain
their original dispositions and are never relabeled by these fixes.

## Requalifying individual pinned cases

`tools/check-real-source-cases.mjs` selects exact IDs from the current pinned
real-source catalog and executes the same original-source, transformed-source,
owned execution, replay, and optional native gates as the corpus worker. Pass
`--out NEW_DIRECTORY --cases ID,ID` with either `--local` or the exact
`--megatoken`, `--python`, `--tokenizer`, and `--native-policy` paths. The default
catalog contains two canonical inputs per family; `--per-family N` selects the
catalog bound explicitly. Native qualification requires a clean producer.

The report declares its selected and available denominators and does not claim
whole-corpus coverage. It retains the exact original/canonical source pins,
notice hashes, canonical input and result bindings, fresh source recheck,
native receipts, and checksums of compressed per-case evidence. Task inputs use
the canonical graph encoding, preserving undefined, BigInts, special numbers,
and aliases. A new output directory is required, and the historical campaign
and its previous dispositions are never rewritten by this command.
