# Actual-model closed-session qualification

`tools/qualify-v8-closed-sessions.mjs` runs a bounded CPU check against a
fitted served bundle and the paired Megatoken JSONL service. It takes the exact
first-selection request written by the producer's checkpoint-history
qualifier. Before starting inference, it reconstructs that request from the
provided source artifact's observed prefix and refuses if the parsed request
differs from the producer-derived one.

The run gives session A one actual model selection. The ordinary producer
validates its original record against the live execution state and the native
service acknowledges that exact record. Private correspondence with the full
source artifact is checked only after that rollout. The run then derives session B by replaying
the same observed source and input rows with a separate session identity. B's
model context and prefix digest come from that replay. The service samples one
native candidate for B, and the host closes B without acknowledging the
candidate. A remains active.

The tool saves the complete native checkpoint, starts a fresh service process,
restores the checkpoint, and compares the active A cut, closed B cut, complete
attempt evidence and costs, opening receipts, and RNG state. It then sends B's
old request once to verify that the closed identity is refused without
sampling a model output or changing the native checkpoint. Finally, it runs
the same next A request before and after restore and compares original model
bytes and selection evidence. If an actual output is malformed or refused, the
tool saves its full evidence; the comparison proceeds only when that refusal is
bound to the loaded model, session, and original context.

The source correspondence check runs after the actual A record has been
acknowledged. The diagnostic does not dispatch host effects, run the complete
source program, test held-out examples, or establish generalization. B's
candidate is never described as semantically accepted.

Example:

```sh
node tools/qualify-v8-closed-sessions.mjs \
  --megatoken /path/to/megatoken \
  --python /path/to/megatoken-venv/bin/python \
  --served /path/to/fitted-served-bundle \
  --source /path/to/original-source.json \
  --request /path/to/history-qualifier/selection-request.json \
  --out /path/to/new-evidence-directory \
  --max-tokens 18 \
  --seed 17
```

Evidence includes the source and request hashes, served manifest and asset
hashes, both raw next-output outcomes, B's cancellation receipt, the original
and restored native checkpoints, the refused closed-session call, measured
transport/runtime costs, and a report that states the limits above. A failed
or unbound model output leaves `failed-attempt.json` with the original error
evidence.
