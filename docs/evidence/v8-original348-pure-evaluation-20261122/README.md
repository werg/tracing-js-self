# Actual original step-348 pure-program evaluation: original failed run

This directory preserves the first actual-model evaluation of the completed
original training trajectory. It does not convert its failed measurement gate
into a successful quality result.

## Immutable source and archive

- Evaluation run: <https://github.com/werg/tracing-js-self/actions/runs/45046754653>;
  attempt 1, job `137282942375`, conclusion **failure**.
- Driver: `f4bcf1e0bfde2dee398df3df692246b3e93dadef`.
- Original producer: `9cf091e6ccc5add960ef0897576d0c391b199a65`.
- Original native consumer: `1a69d9da3254b7568c831d12866a629c206cf4fe`.
- Complete original artifact: `14763634179`, named
  `v8-original348-pure-evaluation`; **16,427,247 bytes**, SHA-256
  `2d575cbec0b543e329e68e9bb1289e3a7f33988866a145a9fb3c641a41ff91ad`.
- Training checkpoint: step **348**, SHA-256
  `854c37716597b0cb13cece65805ad646ffe837d2ca64bc6de99331bf1bce703a`.
- Actual served weights: SHA-256
  `88c4b86fdfcdc0032a3813b59317fdc0a240dbf434b06e63362b495fccf3940e`.
- Tokenizer identity:
  `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
- Serving training-lineage identity:
  `74bb51e8757fc3f6a6119e52a5a2ace1b9a484533350dd81fc0f0b085de14d92`.

The complete archive was downloaded and independently checked against its byte
count and SHA-256. `original-archive.json` hashes all **114 original members**.
`original-text-evidence.tar.gz` preserves every original member except the
served weights, tokenizer, and transducer binary. Those three remain in the
complete original workflow ZIP and its separately retained custody copy. No
report, selection, source case, private oracle, log, manifest, study, or receipt
was omitted from the compact text archive. Selected original JSON documents
are also included as individual gzip files for convenient inspection.

## Original observed outcome

All 16 original pure cases were selected before inference, with the original
12 training / 3 validation / 1 test split. Every process exited normally, with
one model selection attempt per case and no accepted generated record. The
recorded private source checker completed for all 16 expected artifacts with
no private-scoring exception. An independent replay audit is recorded in the
following evidence increment; the original reports remain immutable.

| Split | Declared cases | Processes completed | Selection provenance validated | Complete source-certified programs |
| --- | ---: | ---: | ---: | ---: |
| Training | 12 | 12 | 6 | 0 |
| Validation | 3 | 3 | 2 | 0 |
| Test | 1 | 1 | 0 | 0 |
| Total | 16 | 16 | 8 | 0 |

Eight selections produced bytes with validated model provenance but failed the
V8 generated-record grammar. Eight returned native invalid-text-fragment
failures whose producer-side provenance check did not validate the incomplete
failure packet. Those eight remain unqualified; a native attempt and a valid
private oracle do not establish qualified model-selection provenance.

The study reports `measurement-incomplete` and the workflow fails accordingly.
The fixed denominator remains 16. Zero full programs completed, but this is not
a claim that all 16 were quality-qualified. The other 48 original profile cases
and an initialized baseline remain explicitly unmeasured. No optimizer updates,
answer repair, synthetic selector, or default promotion occurred.

Every case used seed 17, CPU, 128 tokens per fragment, at most eight fragments,
effort 1, at most 32 selection requests / 128 generated logical records / 16
outstanding operations, zero stale retries, and a 300,000 ms execution bound.
The three studies were frozen before the first model call. These measurements
belong only to the original source pair above, not to later PR candidate code.

## Independent audit completed

`audit.py` and `audit-source.mjs` independently verified the complete original
archive, original 64-case source population and selected 16-case split, all
freeze receipts, the actual checkpoint/export relationship, all original model
fragments, and all source scores. `independent-audit.json`, `fragment-audit.json`
and `source-audit.json.gz` retain the results. The audit passed; the evaluated
workflow and its quality result remain failed/incomplete.

- All **407 served tensors, containing 4,039,640 elements**, matched the original
  checkpoint exactly, including dtype and every value. The served transducer
  snapshot also matched the real checkpoint. The original loader validated
  checkpoint, tokenizer, architecture, and training lineage.
- All **29 fragments, containing 1,957 original token IDs and 12,475 raw bytes**,
  reproduced exactly with the original tokenizer. This is an offline identity
  check of retained evidence, not new inference or retroactive acceptance.
- Exactly **eight final fragments** contain invalid UTF-8. In each corresponding
  native failure packet, the fragment list retains the rejected final bytes but
  the aggregate payload contains only earlier fragments, or is null on the first
  fragment. The producer correctly refuses that incomplete aggregate binding.
- All **16 private source artifacts** were independently re-executed and scored
  again by the original source verifier. The resulting scored records and their
  digests matched the original reports exactly. All 16 private source oracles
  are valid; all 16 selected executions still fail to complete. The eight
  provenance-validated outputs are not canonical V8 records.
- The eight validated malformed outputs retain an observed cancellation event.
  This cleanup is not a generated model record or source-program completion.

The audit used the original Node 24.22.3, Python 3.12.14 and locked Python package
versions, with the source verifier's original UTC setting. It performed **zero
model calls and zero optimizer updates**, and verified that no original archive,
checkpoint, study, report, source case or served bundle bytes changed. Its local
platform is recorded separately from the original hosted runtime. The retained
audit-development notes include the initial strict environment refusal and
corrections to the auditor's assumptions; those were not model reruns.

The measurement now separates two concrete problems. The model fails to emit
the required record grammar even for the eight outputs whose original selection
provenance is valid. Separately, the native exception path loses aggregate byte
coverage when rejecting invalid text. Correcting that exception evidence cannot
establish learned execution success or change this original run's provenance
flags. A later serving implementation requires its own exact source identity
and full fixed-population evaluation.

## Retained failures and remaining work

- [x] Independently recheck all 16 private source projections and unchanged result
  digests, verify every exported tensor and transducer state against the original
  checkpoint, and audit complete fragment/token identity and original cost flags.
- [x] Distinguish the model's failure to emit canonical records from the incomplete
  rejected-fragment envelope. Preserve the eight unvalidated selections even
  if a later implementation corrects rejection evidence.
- [ ] Use the measured failure to choose the next bounded training or inference
  investigation. This run establishes no learned full-program success.
- [ ] Preserve the complete ZIP beyond Actions retention using the existing
  unpublished-release custody helper. Custody is evidence storage, not a
  quality gate, release, or publication approval.
