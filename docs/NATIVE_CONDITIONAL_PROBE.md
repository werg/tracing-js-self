# Actual native conditional-state probe

`tools/probe-native-conditionals.py` executes the real native training and
serving paths at the same saved checkpoint and the same first public prefix.
It captures each path's already computed Gaussian policy mean and log-scale,
then stops **before** the Gaussian facet draw. Serving has already evaluated
and drawn its text-only modality categorical. No semantic selection is returned,
no optimizer update runs, and no learned execution success is claimed.

The implementation is runnable in the existing qualified native environment.
The current local workspace has no PyTorch runtime; its numerical execution
has therefore not been measured locally. The optional real-model hook test is
skipped explicitly when PyTorch or the companion checkout is missing. Synthetic
comparison tests are not substituted for the missing native result.

## Fresh zero-update diagnostic

Use a **current source/native-admitted training episode**, the clean pinned
companion checkout, and the already qualified tokenizer. The command does not
download assets or launch compute services:

```sh
python tools/probe-native-conditionals.py \
  --consumer-root /path/to/clean/pinned/megatoken \
  --episode /path/to/current-admitted-short-training-episode.json \
  --initialize-tiny --tokenizer-json /path/to/qualified/tokenizer.json \
  --seed 17 --max-tokens 128 --atol 0.000001 --rtol 0.00001 \
  --output /path/to/new-native-conditional-probe
```

This mode freshly rechecks the episode, uses the native corpus preparation path,
checks the actual masks, and saves a genuine tiny initialized checkpoint with
zero optimizer updates. It calls the existing diagnostic checkpoint helper,
then exports and reloads the exact served weights. The initialization
configuration's `max_steps: 1` is only the native configuration's required
positive bound; no training command or optimizer step is invoked.

One can also inspect a retained compatible checkpoint and its actual prepared
corpus without changing either:

```sh
python tools/probe-native-conditionals.py \
  --consumer-root /path/to/clean/pinned/megatoken \
  --episode /path/to/original-current-admitted-training-episode.json \
  --checkpoint /path/to/compatible/checkpoint \
  --prepared /path/to/its/prepared-corpus \
  --seed 17 --max-tokens 128 --atol 0.000001 --rtol 0.00001 \
  --output /path/to/new-retained-checkpoint-probe
```

Existing checkpoints must satisfy the companion's current artifact contract.
Older prepared/model artifacts are not migrated or silently accepted. The
prepared episode's record bytes, physical geometry, controls, track declarations
and meridians must match fresh native adaptation of the source-certified input.
The bounded probe is limited to the first direct invocation and the first
physical generated record; resumed/callback and later-prefix parity require
separate measurements.

## The executed boundaries

The training arm uses the actual saved configuration and native
`PreparedCorpus`, `_WindowPlan`, `prepare_batches`, `TransducerTrainer`,
`LossLedger` and `forward_meridian_batch`. It runs that trainer forward with
`differentiate=False`, under `torch.no_grad()`, with every model module in eval
mode. This is the same disabled-dropout forward used for native held-out loss.
The original native metadata, observation reconstruction, context announcements,
track identities and bank lookups remain in place.

The serving arm reloads the exact `ServedBundle`, opens the real
`MultiTrackRuntime`, initializes `SelectedSemanticInference` with the bound
model identity and seed, and calls its real `select` method with the lawful
public prefix from the existing selected driver. Native source-visibility
verification remains enabled. No capture endpoint replaces the real runtime in
this neural probe.

Both paths reach the actual `MultiTrackGenerator._prior` and
`MultiTrackGenerator._sample_policy` boundary. The hook records the finite
model-produced Gaussian before its facet sampler runs, then raises a dedicated
stop signal. The serving path's earlier text-only modality categorical is outside
this comparison; `capturedBeforePolicyDraw` refers specifically to the Gaussian
facet draw. In the trainer this boundary occurs before the generated target's
neural encoding or teacher continuation. The hook does not supply replacement
states, forced target choices, repaired output bytes or a successful selection.
All patched methods are restored on exit, and model-state hashes are checked
for changes. Native inference is closed after capture.

The Gaussian mean and log-scale are an equivalent native decoding-state
measurement for this narrow boundary. They are not lexical logits. The native
policy samples facets, then uses its argmax structural/lexical renderer; those
downstream heads do not run in this probe.

## Retained evidence and interpretation

Each output directory retains:

- The freshly source-certified public prefix and first target, with source,
  candidate, checkpoint, served model and tokenizer identities.
- The exact native implementation digests for preparation, physical records,
  controls, trainer, recurrent model, decoder and checkpoint/serving paths.
- Actual `encode_chunk` and `encode_control` call bytes and track IDs, encoded
  track semantics, final track registry/descriptions, event/meridian counts,
  visible-history identifiers and positions, context policy and dropped events.
- Actual training target token IDs/masks and first-fragment geometry; actual
  serving action specifications and control bytes.
- Full finite Gaussian vectors, shapes, dtypes and float32 checksums for both
  paths, plus the first numerical divergence and maximum absolute difference.
- Actual loaded lexical-alphabet buffers and structural/terminal head sizes,
  with a separate source-bound decoder-support comparison.

The decoder-support comparison recognizes one exact `_teacher_raw_impl` source
body by its SHA-256. In that body, raw training normalizes length over every
length-head row and lexical targets over `valid_bytes`; serving's actual request
can restrict lengths and use `utf8`. The audit reports those ranges and alphabet
differences alongside the model's actual buffers. It **does not** claim that the
downstream heads ran. A changed trainer body makes this interpretation
`unmeasured` until a new support capture is implemented; it is not guessed from
an architecture name.

A numerical Gaussian mismatch establishes divergence in the actual native
conditional state under the two paths. The input and track audit helps locate
its cause. For example, identical JSON values on different native tracks can
still create different recurrent state. No track remapping, metadata rewriting,
removed context announcement, synthetic history, or teacher-forced state is
inserted to manufacture equality.

The Gaussian comparison's `status` applies only to those retained vectors. The
top-level report separately records `gaussianConditionalStatus`,
`trainingServingParityStatus`, and `fullConditionalParityClaim: false`. Actual
encoder-call drift or the source-defined decoder-support mismatch fails the
overall check even if the Gaussian vectors happen to agree. Agreement at one
untrained checkpoint cannot establish agreement after learning, at other
prefixes, or for lexical/terminal action decoding.

The command exits 1 for a retained measured mismatch. A hosted workflow should
upload the output directory even on that exit. Missing assets, unsupported
boundaries or errors retain an `unmeasured`/incomplete report and traceback; they
never create zero vectors or a parity pass. A new output path is required for
every attempt.

## Verification

```sh
python test/test_native_conditional_probe.py
MEGATOKEN_REPOSITORY=/path/to/pinned/megatoken python test/test_native_conditional_probe.py
```

The optional test requires installed PyTorch and uses the companion's real tiny
model with its built-in byte codec. It verifies that the real Gaussian boundary
is reached, the stop occurs before the Gaussian facet draw, and the original native method is
restored. That small hook test does not qualify a source sample or establish
training/serving parity. The standalone command above is the actual paired
capture that must be executed and reviewed.
