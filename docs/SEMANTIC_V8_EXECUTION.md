# Frozen v8 selected-execution experiments

The v8 experiment path runs model-selected compact algorithms, detailed records,
and protocol records against one live public execution state. It also drives
declared external replies, owned callbacks, and retained subscriptions through
the existing fixture broker. Source correspondence is checked separately, after
the selected execution has finished.

The implementation is in `src/semantic/selected-execution-v8.js`,
`src/semantic/execution-study-v8.js`, and `src/semantic/native-process-v8.js`.
The command-line entry point is `tools/run-semantic-v8-experiment.mjs`.

## Prepare and freeze

Each case needs a complete source-qualified v8 artifact: `public`, `contexts`,
and its source-evidence `sidecar`. Public-only golden traces cannot supply private
source validation. For example, `verifyRegionTrainingCase` can prepare a small
owned source case:

```js
import {verifyRegionTrainingCase} from 'tracing-js-self/semantic/v8';

const verified = await verifyRegionTrainingCase({
  id: 'literal-seven',
  family: 'literal-seven-owned-source',
  source: '"use strict";function run(){return 7;}',
  entry: 'run',
  args: [],
  fixture: {calls: []}
});
if (!verified.exported) throw new Error(verified.reason);
// Save verified.exported as literal-seven.json for the inventory below.
```

The input inventory contains every declared case. Artifact paths are relative to
the inventory file. An inline `artifact` is also accepted. A case may explicitly
supply `fixture`; otherwise preparation uses the source artifact's declared
environment.

```json
{
  "cases": [
    {"id": "literal-seven", "artifactPath": "literal-seven.json"}
  ]
}
```

For the native Python bridge, freeze all four generation settings explicitly:

```json
{"device":"cpu","maxTokens":512,"maxFragments":32,"effort":1}
```

Effort is bounded from 1 through 6. The loaded runtime must attest exactly these
settings, the checkpoint hash, tokenizer hash, and seed before any prediction.
Use bounds the served model actually supports. A runtime cap that changes
`maxTokens` causes refusal; changing the requested configuration requires a new
frozen study. Model modules can use other settings objects, but they must attest
the exact frozen object too.

```sh
node tools/run-semantic-v8-experiment.mjs freeze \
  --input cases.json --out experiment-frozen \
  --model-id semantic-model --model-revision MODEL_REVISION \
  --settings settings.json \
  --checkpoint CHECKPOINT_SHA256 --tokenizer TOKENIZER_SHA256 \
  --seed 17 --seed 23 \
  --max-predictions 4096 --max-generated 16384 \
  --max-stale-retries 8 --max-outstanding 64 --timeout-ms 15000
```

Both hashes must be 64 lowercase hexadecimal characters. The output directory
must be new. Freeze writes `study.json` and `private-cases.json`. The study binds
the complete case and seed inventory, source/input prefixes, environment plans,
private artifact digests, model revision, settings, and execution limits.

Both saved files are evaluator inputs. The study includes future environment
responses, and the private case file additionally includes expected traces and
source evidence. Neither complete file is sent to the model.

## Run the frozen declaration

The native path uses an existing served bundle and the paired consumer checkout:

```sh
node tools/run-semantic-v8-experiment.mjs run \
  --study experiment-frozen/study.json \
  --cases experiment-frozen/private-cases.json \
  --out experiment-results \
  --megatoken /path/to/megatoken --served /path/to/served-bundle
```

Use `--python` to choose the Python executable. An alternative
`--selector-module adapter.mjs` must export `createSelector(configuration)`.
The factory receives only model identity, settings, hashes, origin, and limits;
it does not receive the cases or their future observations. A selector is a
callable with the initialization and lifecycle methods used by the native
adapter. The model path requires original selected bytes, native fragment/token
provenance, and a successful acknowledgement for every committed record.

Use `--case CASE_ID` repeatedly for a diagnostic subset. The report still
contains all declared cases and seeds, with omitted rows marked `untested`.
The full declared population remains the success-rate denominator. A new output
directory is required for each run; the original study is copied there and
`report.json` is saved before model startup and after every case/seed.

Explicitly injected fixture records are supported for engineering tests. Freeze
those runs with `--origin engineering`. Their reports retain
`modelMeasurement: "engineering-only"`, including when every private source
check succeeds. Such runs test the execution and scoring machinery, not model
learning or generalization.

## Causal lifecycle and failure handling

For each prediction, the selector receives `session`, the current `public`
prefix, `contexts` for prior committed predictions, and the current `context`.
The current context is not duplicated in `contexts`. No expected next record,
teacher sidecar, or future fixture response is supplied.

The runner validates original canonical bytes and performs semantic preflight
before changing live state. After a successful local commit it appends the
captured context and waits for the matching native acknowledgement. External
effects and subsequent model generation cannot proceed through a failed
acknowledgement. Callback completion is acknowledged per invocation; the whole
session is cancelled after all owned tasks settle, including successful runs.

An external observation can arrive while a prediction is being generated. An
uncommitted stale prediction can be rejected and retried within the frozen
`maxStaleRetries` bound. Every such generation consumes the global prediction
budget and remains in the evidence and costs. A semantic rejection or an
acknowledgement failure is not repaired or retried as a new answer. Exhausting
the stale retry allowance is a resource limit.

Initialization, selection, record acknowledgements, and automatically started
callbacks share the execution deadline. Final session cleanup has an additional
bound of `min(timeoutMs, 1000)` milliseconds. Cleanup failures are retained and
prevent the run from being reported as a completed execution.

## Interpret the report

| Field | Meaning |
| --- | --- |
| `publicAccepted` | The committed public prefix has no detected witness violation and the run has no recorded execution failure. |
| `publicCompleted` | All owned invocations completed under the public machine and execution/cleanup succeeded. |
| `sourceValidated` | Private source evidence was independently rechecked and the complete selected public timeline and contexts exactly match its certified projection. |
| `completedExecution` | Both public acceptance and the scoped source-validation requirement passed. This is the study's success numerator. |
| `sourceStatus: passed-exact-projection` | The independent source check and exact projection comparison passed. |
| `sourceStatus: unqualified-projection` | Public execution completed, but its decomposition or observation schedule differs from the certified projection. Source correctness is not established by this scorer. |
| `sourceStatus: incomplete` | The bounded public execution did not complete successfully. |
| `qualification.modelMeasurement` | `actual-model-selected` requires verified original model-selection evidence; `unmeasured` indicates no such measured output; engineering controls remain `engineering-only`. |

A `status` of `completed`, an equal final return value, or a legal public trace
alone does not establish source correspondence. The first scorer intentionally
qualifies exact source-certified projections. An alternative correct region
decomposition can remain unqualified. So can a causal callback run whose live
observation schedule differs from the canonical source trace. The report does
not silently mark those alternatives correct or assert that they are wrong.

The `nextStep` section compares original attempts only at independently
source-qualified canonical boundaries. `different-canonical-record` describes
a difference from that target; it does not prove that every alternative
decomposition is invalid. `unqualified-boundary` means the private artifact has
no exact context at which to score that attempt.

The aggregate `completedExecutionRate` uses `rateDenominator`, equal to the full
declared case/seed population. Failed, resource-limited, and untested rows remain
in that population. `attempts` retain original records, captured contexts,
provenance, acknowledgements, failures, and stale retries. Malformed output is
kept as evidence and never rewritten into an acceptable candidate.

Costs include every prediction attempt, rejected output, stale retry, original
byte count, and available token/runtime measurements. Unauthenticated token
claims are separated into `unverifiedClaimedTokens`; missing or invalid token
evidence increments `unknownGenerationCostAttempts`. Native compute and peak
memory metrics are reported when available, with `nativeCostExecutions` showing
coverage. Zero measured tokens or compute with missing coverage is not evidence
of zero generation cost.

These reports do not promote v8 to a default format, assert native corpus
admission, or establish a training benefit. The associated source/corpus native
admission checks, frozen model comparisons, and held-out learning measurements
remain separate evidence.

## Retained native experiments

The [current-contract native study](../coverage/language-expansion/native-v8-fit-39c4036/README.md)
evaluates a model fitted for 256 optimizer steps on one input of
`"use strict";function run(x){return x+1;}`. At producer `012c9fe` and consumer
`39c4036`, the fitted model completed and passed private source scoring on
input `6` for **3/3 declared seeds**, and on input `8`, excluded from the
optimizer and early stopping, for **0/3**. The zero-update baseline completed
**0/6**. Both inputs share the same source family and train-component identity;
this is a same-program input check, with no demonstrated held-out success.
The current-contract evaluation performed no additional optimizer updates.

An [independent retained-output audit](../coverage/language-expansion/native-v8-fit-39c4036/independent-audit/README.md)
replays private source scoring for all twelve results and decodes all fifteen
original prediction fragments using the pinned production codec. It reproduces
405 verified generated tokens for the fitted study and 344 for the baseline,
plus two baseline attempts whose costs remain unverified. Their original
invalid UTF-8 bytes and emitted token IDs remain in the evidence. Reported
compute and rollout durations describe those particular executions; they are
not a controlled efficiency comparison.

The original 43,360,285-byte fitted/checkpoint archive is named and hashed in
the study, but its bytes and a retrieval URL are absent from the repository.
The independent audit could verify retained output bytes and source outcomes;
it could not inspect or reload those weights, repeat inference, or resume that
optimizer checkpoint. The earlier training and stale-source attempts remain
in the [historical packet](../coverage/language-expansion/native-v8-fit-23cd478/README.md).

Two separate [four-step native fitting diagnostics](evidence/semantic-v8-diagnostic-pilot/2026-11-20/README.md)
each completed **0/2** frozen executions. Those packages include their full
fitted bundles, original rejected output, costs, settings and corpus roles.
The preliminary and corrected split experiments retain separate denominators.
These bounded results exercise actual fitting and selected execution while
leaving external comprehension, general learned reliability, matched-usefulness
cost/latency, and coordinated default promotion unqualified.
