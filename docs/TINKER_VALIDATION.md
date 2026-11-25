# Tinker / Inkling-2-Mini Local Verification Summary

No live model sampling or training has been performed yet (requires `tinker auth login` / `TINKER_API_KEY`). All checks below verify local CPU execution, rendering, corpus isolation, and offline training/orchestration contracts.

## What Was Fixed & Verified

- **Runtime performance**: Replaced full-heap `structuredClone` + `JSON.stringify` state diffing in `src/runtime.js` with persistent copy-on-write table diffing and structural equality, cutting worst-case recursive `collatz(1000000)` export time from **86.2s** to **~3.7s**.
- **Inkling native thinking channel**: `src/training/tinker-execution.js` routes teacher traces (`compact`, `full`) into Inkling's `{"type": "thinking", ...}` block and JSON actions into `{"type": "text", ...}` when `effort > 0` (`reasoning_channel: "auto"`), matching `tml_v0`'s pretraining framing. `training/tinker_js/adapter.py` groups consecutive `<|message_model|>` thinking+text frames in `_sft_layout` and flattens thinking cleanly at `effort == 0`.
- **Succinct, natural traces & tolerant action parser**: Deduplicated compound-assignment and branch trace lines, replaced verbose English branch/pending-return boilerplate with compact JS scratchpad lines (`total = 2`, `branch i<xs.length => true (then)`, `return 9`), trimmed duplicated input arguments from prompts, and made `parseStudentAction()` tolerant of prose code blocks and trailing punctuation while preserving strict semantic grading.
- **Long-context support & turn-budget checks**: `TinkerAdapter` infers context limits from the Tinker model ID (`65,536` for `:peft:65536:free`, `262,144` for `:peft:262144`, up to `1,048,576` for bare `Inkling-2-Mini`). Added `training/configs/inkling-long-context.json` (`262K` context, `64K` turn / `128K` episode) and raised `inkling-pilot.json` budgets (`16K` turn / `32K` episode). `validate_token_budgets` now measures and optionally enforces per-turn and per-episode assistant budgets against `max_tokens` / `max_generated_tokens`.
- **RL batching, normalization & checkpoint hygiene**: Added multi-prompt RL batching (`rl_prompts_per_step: 8`), trajectory-length advantage normalization (`rl_token_normalization: "trajectory"`), ephemeral sampler refresh between checkpoints (`checkpoint_every_update: false`), automatic TTL on recovery checkpoints (`recovery_checkpoint_ttl_seconds: 86400`), fixed correctness-RL rollback triggering below `compression_min_accuracy`, and added frozen export caching across staged study jobs in `training/tinker_js/experiments.py`.
- **Balanced corpus**: Stratified `assignFrozenSplits()` by `sourceOrigin`, excluded `Math.random()` LCG tasks (`quickSelect`), trimmed redundant synthetic wrappers, and rebuilt `training/fixtures/expanded/`.

## Next Live Steps

```sh
source .venv-tinker/bin/activate
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live
python training/experiment.py probe --config training/configs/inkling-mini.json --output-dir runs/tinker-probe --live
python training/experiment.py learnability --config training/configs/inkling-pilot.json --output-dir runs/tinker-learnability --live
```
