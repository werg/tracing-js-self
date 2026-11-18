# Canonical integer input precision — 18 November 2026

The complete D real-source campaign exposed two Armstrong-number canonical
inputs that lose integer precision when parsed as JavaScript Numbers. The
original D campaign keeps its two `canonical_mismatch` results. A fresh local
campaign at producer `a01cdc6d7e8efccf22ac5cce40c0a7c6d9efdcd4` now refuses
those two fixtures before source execution, with `fixture_unsupported` and
reason `unsupported_input_precision`.

The [measured receipt](evidence/canonical-input-precision-2026-11-18.json)
binds the old and new campaign entries, result hashes, exact source pins, raw
integer lexemes and offsets, the new collector manifest, and targeted test
results. Both original D result objects were reread from the checksummed campaign
store and compared with the retained decoded failures. The complete 1,171-entry
D log chain was checked read-only; no original disposition was changed.

## What changed before the old oracle ran

The pinned canonical JSON declares the following mathematical integers:

| Case | Canonical integer | Integer represented by the parsed Number |
| --- | --- | --- |
| Armstrong number containing seven zeroes | `186709961001538790100634132976990` | `186709961001538774354986564321280` |
| Largest and last Armstrong number | `115132219018763992565095597973971522401` | `115132219018763998168113697698579742720` |

The candidate IDs are
`real-exercism-fd163dd26aa026080cdd1737` and
`real-exercism-4524e8796cbf93cbc09c7b60`, respectively. The canonical file marks
both as `big-integer` scenarios, describes their 108-bit and 127-bit sizes, and
explicitly allows skipping them when appropriate.

The pinned proof starts by applying `BigInt(input)`. Converting a rounded Number
to BigInt preserves that rounded integer; it cannot reconstruct the discarded
digits. The old reference therefore evaluated a different integer from the
canonical input and returned false. That observation alone cannot establish a
teacher semantic defect on the intended input.

The exact JavaScript-track
[test file](evidence/canonical-input-precision-2026-11-18/armstrong-numbers.spec.js)
at upstream revision `ff04f35158cdf61eebfdf18a774010495a1fd6d9` passes these
two values as BigInt literals. Its Git blob is
`4d380e8b7d5b417d8add4e5c48ae5f0493e3a970`; the retained bytes and matching
[MIT notice](evidence/canonical-input-precision-2026-11-18/LICENSE) were checked
against their upstream Git blob identities. This is inspection of upstream
`xtest` declarations, not a claim that the upstream test suite was executed.
The full URL, SHA-256, and license identity are in the receipt.

## Conservative adapter behavior

`src/corpus/canonical-input-precision.mjs` inspects original canonical JSON
number tokens with the already pinned TypeScript parser. `JSON.parse` still
validates the complete document. Source offsets are positions in the original
JSON text, using JavaScript's UTF-16 indexing. The scanner follows declared
canonical case groups and input data paths, including arrays; expected outputs
are outside this input check.

For integer-valued tokens, including decimal/exponent spellings of integers,
the scanner compares the exact mathematical integer with the integer represented
by the resulting Number. Exact values above `Number.MAX_SAFE_INTEGER`, such as
`9007199254740992` and `18446744073709551616`, remain eligible. A magnitude
threshold alone would incorrectly refuse them. Fractional values retain the
existing Number contract; this check does not implement arbitrary decimal
arithmetic.

Lossy fixtures retain the raw token, its canonical integer, the observed Number
and represented integer, input path, source offsets, source hash, and upstream
scenario/comments. Their original parsed arguments remain visible for forensic
review, and the normal worker's preflight stops before either original or owned
source execution. The adapter does not infer a new input type or coerce an
observed result. The graph codec's general BigInt transport support does not
itself declare a canonical exercise input binding or expand owned BigInt/spread
semantics.

The older local Exercism reporting tool retains the same precision evidence
with its fixture refusal, so this limitation does not disappear outside the
main v5 collector.

## Fresh checks and limits

All **20 targeted tests passed**, with no failures or skips, on Node 24.22.3.
They cover exact and rounded positive/negative integers, exponent/decimal
spellings, large exact values, nested input paths, duplicate-property/identity
refusal, source-span retention, both actual pinned cases, and refusal before
even deliberately invalid source is parsed. Existing grains exact-output and
Node-20-compatible source-lexeme tests remained passing. This local check does
not assert an additional Node 20 run.

A direct comparison with the pre-fix adapter found **199 of 201 canonical
candidate fixtures unchanged**. Only the two precision refusals gained their
preflight/evidence metadata. No input argument value, original source byte or
transformed source byte changed.

The fresh normal collector used the original complete 1,171-case recipe and
frozen global registry, selecting just these two IDs. It retained **2 attempts,
2 fixture refusals, 0 locally verified rows, and 0 native admissions**. Exit
status 1 is the expected indication that neither selected candidate qualified.
No public training export was produced. There was no new guest source execution,
native admission, optimizer step, or model inference for those attempts.

Original D receipts remain tied to producer
`83e0d5742e63dc4439b68d6296f323cb7a3aafdc` and consumer
`b88073dcb5a8e438a711d494a5fd592e773798f5`. This later local preflight
measurement does not relabel them or qualify the rest of D under a newer producer.
