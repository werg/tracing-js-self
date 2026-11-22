# Frozen bootstrap failures and exact fixture correction

Both historical gates below failed. Their raw hosted logs and artifact JUnit
files are retained here; neither result qualifies the corrected source.

| Producer / native | Run | Native result | Producer result |
| --- | --- | --- | --- |
| `32efcddadf1cb441dc32ceb8263f6c3d9049fff9` / `b504228288e2935c9e021da23896fc82babc6836` | 45029326909 | 145 passed, zero skips | 166 passed, four failed, zero skips |
| `ae5fa0f13fc8e8d8996cb6ff360c209ae2f83fa8` / `56cce3b80423b0cb70c3a096d867561066e3a211` | 45030773600 | 151 passed, zero skips | 166 passed, four failed, zero skips |

The first pair is also superseded because native `b504` admitted two mixed
separator spellings of raw bootstrap through a durable-only guard. Native
`56c` retains the original request bytes but normalizes classification before
guarding all four accepted spellings. The second pair includes that correction.
The fixture error does not excuse the first pair's separate semantic defect.

The same four producer leaves failed in both runs: the actual two-child lexical
fixture, later sibling create lost reply/repeated loss, later sibling bootstrap
lost reply/repeated loss, and acknowledged same-owner cancellation recovery.
The exact names and logs are in `manifest.json` and the hosted JUnit files.
Both Python wrappers had replaced a fixture generator with a zero-argument
function; the preserved native terminal fixture now invokes that generator
with its `final_action` argument. Real fixture startup reproduced both
TypeErrors, before any semantic dispatch.

The corrected producer is published as
`e5d53e47b39ccc1699db6da0c6f53bb703b3dce2`, local
`8f1c85b35d75b3822bbd05f912058f56d762b303`, exact tree
`4e1f048e718daa1a7ff7617202de2eb086090153`. It changes only the two
wrapper signatures relative to `ae5`. The cancellation wrapper forwards the
argument; the explicitly supplied lexical sequence permits its declared
`track_complete` action and refuses a substituted terminal action. Both real
fixture startup probes then exit successfully, with no semantic dispatch.
Empty green log files mean successful invocation only, not recovery success.

The corrected exact paired gate is **45032886414**, native `56c`, requiring
**151 native and 170 producer leaves, with zero skips**. It is pending at this
archive's creation. Its final raw log/JUnit must be retained separately before
promotion. No historical result is relabeled as a corrected success, no test
was removed, and no production denominator, training campaign, or resource cap
changed.

`corrected-source-map22.json` records the 22 exact source paths against
main baseline `9a0b84d89652e49e7157f6c9d808a819b904aa9b`. Later main work
must be preserved when composing these paths. The two compressed raw logs are
base64-encoded gzip with deterministic headers; `manifest.json` records both
raw and retained-file hashes, JUnit counts, artifact ZIP hashes, and identities.
