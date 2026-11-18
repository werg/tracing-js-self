# Actual exploratory evaluation on eight independent test families

The initialized base and its trained checkpoint each completed **0 of 8 held-out
tasks**. Family-weighted correctness was zero for both; the measured change was
zero. These are real free-running native model outputs from one optimizer seed,
not injected selections. They establish an unsuccessful execution result for
this bounded tiny-model experiment, not a production learning or transfer claim.

## What was frozen and measured

The cohort was frozen before any held-out inference, after observing the failed
held-in diagnostic. Its eight source components were disjoint from every one of
the 32 prepared training examples, including any examples an earlier partial
optimization attempt had not sampled. The final checkpoint actually consumed all
32 examples from 29 training families, all 9,379 supervised lexical targets,
in 49 optimizer updates. Its complete training evidence is in the adjacent
`optimization-full-epoch-2026-11-18` receipt directory.

The selection rule chose one representative per test component: smallest measured
generated-token count, then public byte count and case ID. Eight components were
available in the three frozen source corpora. No model output influenced which
representative was chosen. Each selected example received a fresh producer
source/journal/replay check and an actual native admission before inference.

| Frozen source family | Case |
| --- | --- |
| async-cleanup | uncaught-rejection-finally |
| filesystem-stream-copy | filesystem-stream-copy |
| persistent-external-trigger | persistent-external-trigger |
| semantic-benchmark-v1:fibonacci-iterative | fibonacci-iterative-pure |
| semantic-benchmark-v1:modular-exponentiation | modular-exponentiation-pure |
| semantic-benchmark-v1:running-prefix-checksum | running-prefix-checksum-pure |
| semantic-benchmark-v1:single-transaction-profit | single-transaction-profit-pure |
| semantic-recipe:squared-distance | squared-distance-pure |

Both bundles used seed 17, 128 model tokens per selection, a 120-second case
timeout, and a 10-second cleanup timeout. The immutable producer's actual
selected evaluator received source, invocation inputs, and broker fixtures.
Teacher selections and private expected outcomes were absent from its request.

| Measurement | Initialized base | Trained checkpoint |
| --- | ---: | ---: |
| Complete tasks | 0 / 8 | 0 / 8 |
| Family-weighted correctness | 0 | 0 |
| Trace syntax failures (`TypeError`) | 5 | 6 |
| Native rendering failures (`SemanticSelectionError`) | 3 | 2 |
| Original emitted tokens | 710 | 843 |
| Total measured wall seconds | 90.995 | 92.044 |

Every attempt failed at its first candidate action. The original token IDs and
emitted byte fragments remain in each raw `result.json`. All five reported hard
gates and all three cleanup counters were zero. That verifies the observed
refusal/cleanup paths; it does not establish successful learned effects, callback
execution, error handling, or generalization.

## Artifact and checkpoint identity

The original cohort SHA-256 is
`753306fad714c04ad70ff755ea9f5d65b128be1341fff4c83ba2fcd94c7405d7`.
The original completed report SHA-256 is
`6caf2cd01f01a6d86bac5d05ee588cee7fddc4f5b1d5b9c6003e24ae5ef303f8`.

The exact initialized checkpoint `state.pt` SHA-256 is
`1e72b5c00d2554a1c0d5c732d48b0cf8936ddb1c5185dc56a10959fcd34d62db`.
The trained checkpoint `state.pt` SHA-256 is
`8a252dff697b1de7fa842c0370cc6a37626e4720be23858b39b82f100b93546c`.
The corresponding served model tensor files have SHA-256 values
`4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`
and `853c12ec19ccd6add5850f76773fe4a781c923cfd4e7c226a1e7fc4071484103`.

Both use the actual tokenizer SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`,
with native ByteCodec identity
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
The source producer was immutable
`c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`; the actual native consumer was
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. Later producer/consumer repairs are
not substituted into this experiment's provenance.

## Separate retrospective verification

Code review found three ways the diagnostic tools could have accepted incomplete
future evidence: missing hard-gate counters, unbound served attachments, and a
declared training-input subset not checked against the actual native corpus.
The tools were hardened, meaningful substitution tests were added, and a
separate audit of the original experiment passed. This audit ran **after
inference** and does not pretend to be an earlier launch qualification.

The audit checked all 24 original held-in and held-out raw outputs against exact
case, origin, representation, seed, checkpoint, and tokenizer identities. All
five hard-gate counters and all three cleanup counters were present as valid
integers. Serving profiles were complete with closed runtimes. Every original
success label, failure category, gate count, cleanup count, and held-out summary
remained unchanged.

Both actual served bundles matched their checkpoint tensors, model geometry,
global step, tokenizer bytes/fingerprint, and transducer bank attachments. The
only permitted bank difference was the native export's single cache-version
increment. Tests refused rehashed alternate tokenizer/config/bank files and an
omitted declared training source.

The inventory audit loaded the true checkpoint training configuration and the
checksummed native index and shards. It matched every full native episode and
lineage to its original source export, then rebuilt the exact window-stream
fingerprint bound by the checkpoint cursor. All 32 prepared and actually sampled
members, from 29 families, were present. Their registry ancestors reproduced
the same eight disjoint test components and the same frozen request/expectation
bytes. The aggregate native corpus identity is
`ca8f01d5e5874ed42a63fede1e681a460bd64064f15557155d7ece825c72c29e`;
its stream fingerprint is
`e7e43a4d21abc5b28c9fd2e91f1da252a997dee8df46e8df3cf4d94b5f441d3b`.

The first audit invocation correctly refused the sandbox's default
`Europe/Berlin` timezone because the original source identity records `UTC`.
The rerun used the original `TZ=UTC LC_ALL=C.UTF-8` environment and passed. Both
logs are retained. Neither attempt executed inference or optimization, and no
original output was modified.

The successful audit used code revision
`c6bc0cc072d10f1be1b36a018b85a30fcc828054`; its receipt SHA-256 is
`d65bb4b885dcc6221c8363ef8bbfdb80063347e6d08697b08b260b688a5e3690`.
The original schema-1 cohort remains under `original/`; the separately rebuilt
schema-2 cohort and audit are under `retrospective/`. `index.json` binds every
copied evidence file by SHA-256.

## Remaining scope

This is a newly initialized tiny P1 diagnostic with one optimizer seed and a
bounded representative sample. It has no production SE/SC launch qualification
or native semantic experiment budget. The strict learning comparator therefore
must not accept this diagnostic JSON as a qualified pilot report. Production
checkpoint ancestry, ordered donor imports, immutable hindsight targets, stage
supply, launch gates, and a separately frozen native evaluation design remain
required. Three planned optimizer seeds and the other confirmatory gates are
needed before a confirmatory learning comparison can be made.
