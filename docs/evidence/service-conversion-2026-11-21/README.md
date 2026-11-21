# Service recovery and shared conversion: retained development evidence

These archives preserve original local log and probe bytes from the resumed
21 November 2026 implementation. `manifest.json` records both the uncompressed
and XZ archive SHA-256 hashes and sizes. Failed and intermediate attempts are
retained alongside successful checks. They are not relabeled as passing runs.

## Exact scope

| Evidence | Result and revision boundary |
| --- | --- |
| `published-05d4d28-regressions.log` | Clean published producer `05d4d28a82ea10dc8a58a217ce48818cd38e0aec`: 144 integrated service, recovery, property and module checks; zero failures/skips. |
| `conversion-identity-final-test.log` | Frozen tree `fa4b7d5725c7e05a1a828eff970272f9513d6d23`, local `42b4279` / published `e4de45e`: 51 IR, codec and conversion checks; zero failures/skips. |
| `service-integrated-final.log` | Earlier working service integration: 68 checks, overlapping the 144-test published result. |
| `property-metadata-and-namespace.log` | Earlier working property/module selection: 37 checks, overlapping the published result. |
| `native-conversion-source.log` | Working native conversion mirror: 41 checks covering 19 source-positive artifacts, checkpoints, prefix reconstruction and tampering. |
| `native-conversion-regressions.log` | 64 existing native checks against regenerated fixtures. |
| `native-support-and-absence-final.log` | 21 supporting fixture and absence checks; all eight legacy wire imports blocked during replay/preparation of the 19 positives. Existing 240-second bound unchanged. |
| `native-support-and-absence.log` | The preceding attempt failed on a missing `uniseg` dependency; the original failure remains retained. |
| `probe-conversion-source.*` and `probe-conversion-native.log` | 24 authored adversarial sources: 17 source-positive artifacts independently replay, seven explicit refusals. These are review probes, not added production admission receipts. |
| `probe-conversion-scalars.*` | 3,315 original scalar inputs and their native JavaScript Number/PropertyKey results, used for 6,630 JS/Python comparisons; no mismatch observed. |
| Other conversion/service logs | Earlier implementation, regression, fixture-generation and failed development attempts. Counts overlap and are not additive. |

The native mirror was committed as local `fdfde8f`, published as `e675b807` with
the identical tree recorded in the manifest. Some checks preceded that final
fixture commit and are intentionally labeled working integration checks. The
supporting packets at this checkpoint retain the actual local producer
`6adcacf` provenance; the subsequent published-pin regeneration is a separate
increment. A local commit is not silently substituted by its API mirror hash in
retained evidence.

The three probe `.mjs` files preserve their original relative imports and output
paths. Reproduction requires adapting the scratch output path and running beside
a producer checkout; their exact retained output bytes are also supplied. They
are not CI entry points or independent token/packing qualification. The scalar
probe uses a fixed pseudorandom seed and actual Node scalar conversions.

## Resolved findings and remaining boundaries

Both producer and consumer had invented ordinary Object stringification for an
object inheriting from an unmodeled function intrinsic. Independent source
comparison exposed the error despite checker agreement; both public conversion
paths now refuse that fallback while keeping explicit own guest hooks.

A generated conversion fault also accepted a broad operation identifier that
was invalid as a heap reference. Both implementations now validate the eventual
reference before allocating or mutating state. The retained controls cover
slash, space, numeric-leading identifiers and final LF/CR/U+2028/U+2029 characters.
An additional suspected regexp-anchor issue was disproved by direct Node probes;
no shared IR regexp change was needed or committed.

The production candidate inventory retains 24 rows: 19 source positives, two
intrinsic-error source-authority refusals and three pinned-engine disagreements.
The recurring population preserves the original 47 input identities and adds
the 19 positives. This evidence packet does not establish current-pair token
admission, packing, ordinary model training, learned task success, complete
ECMAScript coverage or default cutover.
