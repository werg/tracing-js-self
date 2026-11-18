# Native captured-variable name correction

The frozen D producer correctly emitted a closure capture for the source
variable `keyFn`. The native consumer incorrectly validated the captured cell
name as a heap reference identifier, whose grammar permits only lowercase
letters and digits. This rejected the pinned VS Code `distinct` trajectory
even though its original/owned JavaScript checks passed.

The isolated native fix is commit
`3e3d418dab6ba268ce3f0948f57387c162de327b`, based on
`b88073dcb5a8e438a711d494a5fd592e773798f5`. It validates both names in a capture
relation with the existing source-binding predicate used for ordinary binding
records. Heap reference validation remains unchanged. The v5 format and its
declared fields do not change; this corrects the implementation of an existing
source-binding relation.

## Actual source regression

Candidate `real-utilities-5a1fde95b4daab8314e03d36`, from
`utility:vscode/arrays.ts/distinct`, was reconstructed from its durable failed
D candidate using the unchanged producer
`83e0d5742e63dc4439b68d6296f323cb7a3aafdc`. The reconstruction independently
passed original-versus-transformed and owned execution checks. Its closure
captures `seen` and `keyFn`.

The exact same reconstructed export was then checked with the pinned production
tokenizer against both consumer versions:

| Consumer | Observed result |
| --- | --- |
| `b88073dcb5a8e438a711d494a5fd592e773798f5` | Refused with `Malformed shared cell capture relation`. |
| `3e3d418dab6ba268ce3f0948f57387c162de327b` | Native component admitted; loss masks, visibility, and fragmentation validated. |

The successful native check processed **65 logical records**, represented by
**69 physical records**, including **1,379 generated tokens** and **2,320
observed tokens**. These counts describe native framing of this one recorded
trajectory. No optimizer or learned-model execution occurred. Serialization of
the entire public/private input was unchanged after admission.

The measured receipt is
[`evidence/native-capture-bindings-2026-11-18.json`](evidence/native-capture-bindings-2026-11-18.json).
The release evidence directory `capture-binding-recheck/` contains the full
local export, compressed source-verification result, original reconstruction
and campaign references, both native outcomes, and the test log/JUnit report.

## Regression coverage and limits

**68 tests passed, with zero failures, errors, or skips**, across the new capture
tests and the existing v5 contract, harness, and immutable-graph suites. The
new cases cover camel case, underscores, lexical-name suffixes, dollar signs,
malformed binding/cell values, duplicate capture bindings, and continued
rejection of invalid heap reference targets. A production-tokenizer test uses
the exact reconstructed public trajectory, with its upstream Microsoft MIT
notice retained beside the fixture.

The committed component fixture intentionally omits private source evidence
and labels its reference status unverified. The separate complete local
reconstruction retains that evidence. Neither the component fixture nor its
native receipt promotes the historical D case into an admitted training row.

The active D producer and consumer checkouts were not modified. The original
D refusal remains part of that campaign. Full qualification under the fix
requires a newly frozen producer/consumer pair and fresh admission. The reused
source-name predicate is the existing bounded native predicate; these tests do
not establish complete Unicode identifier parity.
