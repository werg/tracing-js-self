# Second semantic review evidence for issue #61

This packet retains actual diagnostic and corrective executions. It includes
the original failures, optional-native skips, complete corrective reruns and
the native-enabled controls. The files are byte-preserving gzip encodings;
`manifest.json` records hashes of both original and retained bytes.

These are working-tree executions before the checkpoint commits. They are
**not clean-pair attestations**, and the later commit IDs identify the code
checkpoints rather than pretending those revisions were executed by these
earlier commands. The separate final clean campaign and paired component
packets establish their own exact revision authority.

## Actual executed leaves

| Run | Passed | Failed | Skipped | Interpretation |
| --- | ---: | ---: | ---: | --- |
| runtime-initial | 6 | 1 | 0 | Initial control includes one out-of-profile unbound-identifier probe; the genuine semantic regressions are preserved separately. |
| runtime-first-correction | 75 | 0 | 0 | 75 passing leaves before the additional nested-helper/reentrant unwind control. |
| runtime-final | 76 | 0 | 0 | Final 76 leaves include eight new review leaves and the nested-helper/reentrant unwind correction. |
| reflection-initial | 5 | 1 | 0 | Five passes and one probe requiring unsupported defineProperty on function storage. |
| reflection-unwind | 18 | 1 | 0 | 18 passes and one real in-operator validator regression; the subsequent complete corrective run is retained. |
| reflection-final | 24 | 0 | 0 | 24 passes: seven new reflection controls plus 17 existing controls. |
| observer-initial | 24 | 1 | 0 | 24 passes and one incorrectly specified graph expectation; the native observer side effect was independently reproduced. |
| observer-core-final | 32 | 0 | 0 | 32 passes: seven earlier observer controls plus existing observations, isolation and core execution. |
| observer-namespace-final | 8 | 0 | 0 | Eight observer controls, including actual Linux namespace worker execution. |
| source-initial | 9 | 0 | 1 | Nine passes and one optional-native skip before native-enabled execution and the additional bounded-update refusal control. |
| public-initial | 28 | 0 | 1 | 28 passes and one optional-native skip before native-enabled execution. |
| source-public-native-final | 15 | 0 | 0 | 15 passes with real native execution: source file11 and direct public file4. |
| existing-source-initial | 23 | 1 | 2 | 23 passes, two optional-native skips and one real nested-helper throw validation regression. |
| existing-source-native-final | 26 | 0 | 0 | 26 passes with real native execution after current active unwind-chain authority was corrected. |
| native-fixture-reproductions | 0 | 3 | 0 | Three reproduced stale-fixture failures; no passing result inferred from these diagnostics. |
| native-fixture-corrective | 20 | 0 | 0 | 20 passes across the three affected complete files after canonical unchanged-source regeneration. |
| native-adoption-final | 40 | 0 | 0 | 40 passes across executor, async and scheduler files. |
| native-retained-detail-final | 11 | 0 | 0 | 11 passes including three new retained-invocation intrinsic authority controls. |
| gate-policy-final | 24 | 0 | 0 | 24 passes: 13 combined-gate controls and 11 release-driver controls. |
| gate-native-receipts-final | 15 | 0 | 0 | 15 passes with actual native replay and the additional retained receipt fields required by the final gate. |

Counts describe separate executions. They must not be added as unique test
coverage: existing files and corrective runs overlap. The five new producer
files contain 38 leaves (7 reflection, 8 runtime, 8 observer, 11 source and
4 public protocol). Native executor now contains 12 leaves and retained detail
contains 11. The manifest extracts these subsets from the actual JUnit files.

The initial runtime probe used an unsupported unbound identifier and the first
reflection probe used unsupported function descriptor mutation. Their corrected
probes exercise supported input shapes; those two probe errors are not counted
as repaired semantic behavior. The later reflection `in` validator failure and
nested helper getter-throw failure were real regressions and have passing
complete corrective executions. One observer draft had an incorrect expected
graph identity; the inspector's Error.stack side effect itself was independently
confirmed on the locked Node runtime and has explicit zero-hook controls.

## Retained artifacts and lessons

The original runtime reproductions and adversarial summaries remain alongside
their full archived traces. A `true` validation result in the old adversarial
summary records a forged trace that was accepted before the repair; it is not
a passing rejection control. Final tests reject changed invocation causes,
captured environments, active frames, await wrappers, thrown reasons and
unrelated historical unwind authority.

The eight new original source artifacts retain 196 contexts; the two direct
public artifacts retain 30 contexts and all-owner shared-state comparisons.
Native-enabled execution passed for every artifact. These populations are
additional review controls and do not replace or rename the canonical 51 source
fixtures. The final required gate checks each source/direct case's independent
native receipt separately.

The native fixture diagnostics preserve the three actual failures and the
canonical regeneration log. The original fixture-consumer progress log was
stopped after 29 dots, so no complete-file pass is claimed for that invocation.

The observer uses native Promise slots only in the trusted reference child on
the pinned Node runtime, preserving actual result identity without touching
Error.stack, then, constructor or species. Missing native slot support causes
an explicit observer refusal. Retained invocations derive fresh initialization
from the validated complete intrinsic group; ordinary restore remains strict.
Adoption jobs keep their captured then method while later constructor lookup
occurs at its specified point. Throw authority follows the actual pre-event
active unwind chain and exact newly rejected destination.

## Verification

Run `python3 artifacts/conformance/issue61-second-review/verify.py` from the
repository. To compare against the original workspace files as well, add
`--source-root /path/to/workspace`. The retained `verification.json` records
that byte comparison and the re-derived JUnit counts.

This packet makes no complete combined-gate, module-admission, training or
learned-quality claim. General source finally cleanup, custom species/then
composition, accessor/object-coercing updates and function-source globalThis
remain explicitly bounded follow-ups documented in the implementation ledger.
