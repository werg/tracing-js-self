# Additional module graphs: source checks and an explicit observer refusal

These exploratory results extend the source-only checks for the explicitly
enabled module scheduler profile. They do not establish native data admission
for any additional family. The complete original-source artifacts for the two
successful graphs are retained so that later native qualification can consume
the exact source evidence without inventing broader coverage.

The actual local producer revision was
`52d9073b33173ce1caf8830558df01c4e5d052df`, whose complete tree
`20a06e1050b6c696a5ebcb46a27f6ea35a660da1` is also published as
`55f5f59a4c9676281992ebba902f7748ae3ee1dc`. It contains the source bridge from
`e0f2463f0302e65801cb5dd64cc53ecd37e43b21` plus evidence-only changes. The
receipts keep the local execution identity.

| Original module graph | Source result | Causal contexts | Owned lifecycle cuts | Artifact bytes |
| --- | --- | ---: | ---: | ---: |
| Unhandled dependency rejection, with a waiting parent and an independent sibling | Passed; throws | 553 | 9 | 22,299,595 |
| Syntactic top-level await whose branch is not executed, plus an awaiting sibling | Passed; returns | 690 | 8 | 28,394,538 |
| Diamond with one shared synchronous dependency and two awaiting dependents | Refused at independent completion observation | — | — | No artifact exported |

Both successful graphs passed fresh original ESM comparison, unique source
lifecycle correspondence, ordinary independent generated-JavaScript audits,
and producer source/projection/replay rechecking. Their artifacts fit the
unchanged 32 MiB producer input cap. No native admission, prepared-data packing,
optimizer update or learned model execution ran for these additional graphs.
Their source checks took approximately 146 and 203 seconds respectively.

## Diamond refusal and diagnostic finding

The full four-graph engineering ledger gate separately establishes source-owned
public/native lifecycle replay for this diamond. The stricter source-admission
route also requires the ordinary independent generated-JavaScript audits. It
cannot borrow that separate engineering result to bypass an audit.

`diamond-reference-modes.json` preserves a direct native worker probe. Original,
operation and branch modes all completed successfully and returned `1`.
Completion mode exited with status `1`, no stdout and the explicit stderr
exception `Independent protocol metadata observation bound`. The unchanged
limits are 8,192 snapshots, 4,194,304 total metadata bytes and 1,048,576 bytes
per snapshot. The observed failure establishes that one of these existing
metadata bounds was reached; the retained worker message does not identify
which member bound fired.

The original parent parser attempted to decode the empty stdout before
reporting the worker failure, so the source-only run recorded the unhelpful
`Unexpected end of JSON input`. `source-only.log` preserves that original
result. A subsequent diagnostic-only change preserves the bounded stderr,
mode and exit status, while retaining the parse error as its cause. It leaves
all observation limits and admission refusals unchanged.

That follow-up is local commit
`8f576d510cb456e824523c071a4bb6b4a17f3c13`, published as
`ac6d393e28e8bc73307b6b20659ad4cae7cfe18d`, with tree
`87b9339394ef1c350320ddfa6f6db2ff8479e82a`. Its actual diamond refusal and
unsettled returned-Promise tests passed together with the existing Promise
observation tests: four cases, zero failures or skips. The new regression
file is `test/semantic-protocol-reference-failure-v8.test.js`.

## Retained files

`summary.json` retains all three original results, their exact source identity,
the diagnostic follow-up identity and compressed artifact digests.
`source-only.log`, `diamond-reference-modes.json` and `diagnostic-controls.log`
retain the corresponding raw observations. Each `*.json.xz.b64` file contains
one full source/public/context artifact. Decode it as base64 followed by XZ
decompression, then compare its SHA-256 with `summary.json`. Both compressed
artifacts were round-tripped byte-for-byte before committing this evidence.

The two additional source successes remain candidates for separate native and
physical-packing qualification. The diamond remains refused by the current
source profile. This evidence changes no production family count, split,
position budget, observation cap or model-success denominator.
