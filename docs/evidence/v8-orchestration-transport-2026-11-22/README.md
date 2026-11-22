# Ordinary V8 orchestration transport controls

The working increment based on producer `d4c1c256af01cf66130053abefac25b9e3d6592b` with exact consumer `10847cbfd48ebedbc0368ade01744eb9b849e784` passes **21/21** transport controls, zero failures/errors/skips. The complete JUnit result and both encoded/decoded hashes are retained here. Decode with `base64 -d < transport-21.xml.gz.b64 | gzip -d`.

```sh
MEGATOKEN_ROOT=/path/to/megatoken MEGATOKEN_PYTHON=python3 node --test --test-reporter=junit test/semantic-native-process-v8.test.js test/semantic-native-orchestration-transport-v8.test.js
```

The dedicated JSONL subprocess peer is a deterministic protocol fixture. It covers original bytes/fragments/context/model identity, typed source/input bindings, create acknowledgement retry, host bootstrap, join/completion/progress, cancellation, closed-session checkpoint restoration and exact historical completion retry. A direct model-free Python/JavaScript check compares the actual native context, binding and canonical digest. These results are not evidence of learned model selection or source/native corpus admission.

Two concrete review findings were corrected before this final selection: native meridian IDs are nonnegative integers; and a receipt for another otherwise-valid declared child must not acknowledge the selected child's action. The latter is retained as a two-child swapped-receipt negative control. Other refusal controls cover changed checkpoint/context/payload, child owner/dependency and typed completion digest. An explicitly supplied paired checkout cannot be silently skipped.

The producer policy now pins consumer `10847cb`. Hosted paired CI adds this exact transport gate and preserves the complete result. The separate native shared-runtime suite must pass on that exact pair. Composite host/coordinator driver recovery, source-qualified lifecycle training transcripts, production child coverage and learned-quality qualification remain open.
