# Real-source qualification under frozen producer D

The completed D campaign attempted **1,171 candidates and natively admitted
987**. The original campaign preserves all 184 other dispositions. This is a
qualification census, including repeated public episodes; representative
selection and batch preparation have separate denominators.

The complete machine-readable [campaign analysis](evidence/semantic-v5/real-source-campaign-D-2026-11-18.json)
records exact manifest and log hashes, identities, every refusal group and case
ID, split and component token totals, execution difficulty, and storage costs.
The analysis reads completed evidence without recovering, rewriting, or
re-admitting any candidate.

## Exact execution identity

| Item | Frozen value |
| --- | --- |
| Producer | `83e0d5742e63dc4439b68d6296f323cb7a3aafdc` |
| Native consumer | `b88073dcb5a8e438a711d494a5fd592e773798f5` |
| Tokenizer identity | `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2` |
| Tokenizer file SHA-256 | `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60` |
| Global registry digest | `3518d930f2d486f81e6d914c5233b5475450b149d0036d1bee50364bf43e1498` |
| Campaign identity | `9feebefdd391b9d6aabb62cb5a4dafb921c48cee2ae9f90f70f89a983243fcb6` |
| Final manifest SHA-256 | `dc630eb7d08d09fd4020b74b437efc997c35efa094adae05ab4f724a9f09310f` |
| Append-only log SHA-256 | `679ee3acc47eeb71031f9ef0b1fec1f3fd6b6ccfd77386528e8147b060479994` |

The same registry was used for the D authored and generated-program campaigns.
It contains 508 source variants, 199 declared families and 135 conservative
connected components. Exercism's whole upstream project is a frozen test
holdout; a generated composition is also held out. Component counts are
heuristic diversity measures, not independent algorithms or evidence about a
model's pretraining data.

## Completed source coverage

| Stream | Attempted | Native admitted | Admitted families | Admitted components | Native generated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reviewed utilities | 936 | 924 | 77 | 23 | 816,289 |
| Active canonical Exercism cases | 201 | 44 | 7 | 7 | 22,716 |
| Production helpers | 34 | 19 | 5 | 2 | 2,528 |
| **Total** | **1,171** | **987** | **89** | **32** | **841,533** |

The utility sweep attempted all twelve reviewed invocations for each of 78
families. Exercism includes active upstream replacements rather than both old
and superseding canonical cases. Every successful real-source row passed the
ordinary source, projection, independent-reference and native admission gates;
historical local status flags were not used to promote it.

The admitted split counts are 870 training, 48 validation and 69 test episodes.
Their respective native generated-token totals are 786,454, 9,644 and 45,435.
These are actual tokenizer counts. Public byte size and observed-token totals
are reported separately.

## Retained dispositions and bounded diagnoses

| Disposition | Count | Evidence and scope |
| --- | ---: | --- |
| Native rejected | 48 | Shared-cell capture validation rejects valid source binding names under the pinned D consumer. Affects distinct, knapsack, Roman numerals, sum of multiples and one Axios helper. Later consumer qualification is separate from these historical results. |
| Unsupported execution/profile | 107 | Spread arrays, BigInt, regular-expression matching, a constructor expression, `this`, or the unsupported String global. Each retains its exact source and refusal. |
| Canonical mismatch | 2 | Armstrong-number inputs exceed exact JavaScript Number precision. The rounded input graph and the original false result are retained alongside canonical true; later input-binding triage must not rewrite D. |
| Worker timeout | 6 | Collatz, knapsack and sum-of-multiples cases exceeded the declared 120-second worker deadline. These are bounded resource refusals, not training labels. |
| Projection refused | 12 | All darts cases fail replay completion. The minimal D reproduction is `return Number(x)`, while `Number.isNaN(x)`, square root and the threshold branches pass without that conversion. |
| Unsupported source initialization | 9 | The space-age proof uses top-level non-function initialization outside the bridge's declared extraction profile. |

The [minimal darts diagnostic](evidence/semantic-v5/darts-number-projection-D-2026-11-18.json)
records seven actual local gate runs and their identities or failure digests.
It makes no native-admission claim. Complete failures, original source and
canonical provenance remain in the private campaign.

The campaign's nonzero exit status is expected when any requested native
qualification fails. It does not mean the 987 admitted rows or their durable
receipts were discarded.

## Measured execution and storage

The admitted episodes executed 5,958 branch evaluations, 1,883 loop trips and
5,982 mutation events. Eight ended with a thrown completion. Maximum call depth
was 11; 372 executed path signatures were observed within source components.
There were no awaits in this real-source cohort, so it supplies no asynchronous
coverage by itself. The authored campaigns provide a separate source of such
coverage.

The pilot admitted 16 of 16 rows using two workers in 96.260 seconds. The full
run then reused those receipts and processed the remaining 1,155 candidates
using four workers in 2,426.852 seconds. Summed controller wall time was 42.052
minutes, excluding the pause between invocations. Summed per-worker verification
elapsed time was 9,547.386 seconds; that number is not CPU time.

Peak reported JavaScript worker RSS was 444,862,464 bytes. The worker setting
was a 768 MiB V8 heap limit, a 120-second deadline and a 268,435,456-byte output
limit. Worker RSS excludes reference and native child processes; the heap
setting is not a process-tree memory quota. A separately retained single-row
native probe measures only that probe, not the campaign's native memory peak.

All 5,312 finalized CAS objects, including refusals, occupy 83,629,653 bytes.
The shared frozen registry occupies 339,890 bytes once. Admitted private objects
occupy 48,930,107 compressed bytes and expand losslessly to 4,302,778,945 logical
JSON bytes. Comparing these last two sizes measures compression plus shared
storage, not registry deduplication alone. The earlier
[storage comparison receipt](evidence/semantic-v5/corpus-storage-and-selection-2026-11-18.json)
isolates deduplication on the same four original private sidecars.

## Selection and release boundaries

The complete qualification pool is intentionally retained. It is not already a
balanced training set: the largest two training components account for 44.17%
and 25.33% of its native generated tokens. The deterministic component token
and share caps described in [the collection runbook](RESUMABLE_CORPUS.md) produce
a separately audited selection without changing original admissions.

There are 965 distinct stored public objects for 987 admitted candidates.
Repeated public episodes with different private task identities need explicit
representative selection before native batch preparation. A selected release
must retain the complete original campaign as its audit authority. Native
preparation may further deduplicate training examples; selected native-admitted
rows and prepared examples must remain separate counts.

This document records the completed original D campaign. The subsequent
[native-prepared training selection](REAL_SOURCE_D_TRAINING_SELECTION.md)
records the distinct native deduplication and component-cap denominators.
Neither document claims optimizer updates or learned success. The trusted-source restriction and
the need for operating-system isolation before accepting arbitrary untrusted
programs remain unchanged.

## Completed native preparation and archive

The later [prepared-release receipt](evidence/semantic-v5/real-source-prepared-release-D-2026-11-18.json)
records a successful full batch under the same frozen D producer and `b88073d`
consumer. All 965 representatives were independently source-rechecked and
natively re-admitted. Native deduplication retained 541 examples and recorded
424 duplicates, with zero new refusals or quarantines. The accepted splits are
462 training, 27 validation and 52 test examples, containing 546,670 native
generated/scored tokens in total.

The private archive includes every original candidate and refusal, selected
representatives, prepared data, exact locks, native environment receipt and
source notices. Verification read and hashed all 6,474 inventoried files. The
archive is 1,688,252,285 bytes with SHA-256
`ac4e88a3fba5f046ad44501e5751560806b1cdeaf701deb46fd6eea80aff9558`.
Its release identity is
`113e8faec41e9455c755860c6e32b74c16da7d01bf603f5467aaf1aad2fec030`.

Full preparation, packaging and verification took 2,055.309 seconds. Peak
packager Python RSS was 446,980,096 bytes. The separate waited-child peak is
reported with its Linux resource-accounting scope; neither value measures
simultaneous memory across the entire process tree. The unchanged native audit
schema expands to 6,874,306,358 bytes, while the original compressed campaign
CAS remains 83,629,653 bytes. These artifacts serve different purposes and
their storage sizes must not be presented as the same denominator.
