# Inkling Execution Training with Tinker

Train **Inkling-2-Mini** on Tinker to execute supplied JavaScript accurately, then shorten its reasoning via RL only after complete externally observable behavior is verified. Tinker supplies model compute; the owned JS interpreter, controlled host environment, and independent native Node reference run locally on CPU.

## Core Design

| Component | Implementation | Purpose |
| --- | --- | --- |
| Tinker SDK adapter | `training/tinker_js/adapter.py` | Official `tml_v0` Inkling renderer/tokenizer; dynamic model context limits (65K free, 256K PEFT, up to 1M); exact sampled token IDs & logprobs; assistant-only loss; trajectory-normalized RL advantages; optional TTL on recovery checkpoints. |
| Trace exporter & grader | `src/training/tinker-execution.js`, `tools/tinker-execution.mjs` | Concise, deduplicated causal traces (`full`, `compact`, `actions-only`) routed into Inkling's native `<|content_thinking|>` channel (`reasoning_channel: "auto"` uses `thinking` when `effort > 0` and `text` when `effort == 0`). Observations always have zero prediction loss. |
| Corpus & independent verifier | `src/training/tinker-benchmark.js`, `tinker-independent.js`, `tinker-verification.js` | Origin-stratified, lineage-isolated splits; separate `familiar-inputs` and `challenge` diagnostics; independent native boundary verification and adversarial negative controls. |
| Runner & study orchestrator | `training/tinker_js/runner.py`, `learning.py`, `metrics.py`, `experiments.py` | Batched multi-prompt RL (`rl_prompts_per_step`), decoupled correctness + success-conditional length advantages, ephemeral on-policy sampler refreshes (`save_weights_and_get_sampling_client`), validation checkpoint selection, and cached export reuse across staged sweeps. |

## Context Length & Generation Budgets

Inkling-2-Mini supports up to **1M context** (256K train / 1M sample on `thinkingmachines/Inkling-2-Mini:peft:262144`), while the free tier (`thinkingmachines/Inkling-2-Mini:peft:65536:free`) is capped at **65,536 tokens**.

Because multi-step execution traces can be long, `validate_token_budgets` explicitly checks both context fit (`<= max_context_tokens`) and per-turn / episode generation budgets (`max_tokens` / `max_generated_tokens`, enforced when `enforce_turn_budget: true`):

| Config | Model | Context | Max / Turn | Max / Episode | RL Batch |
| --- | --- | ---: | ---: | ---: | --- |
| `training/configs/inkling-mini.json` | `Inkling-2-Mini:peft:65536:free` | 65,536 | 8,192 | 16,384 | 2 prompts × 4 |
| `training/configs/inkling-pilot.json` | `Inkling-2-Mini:peft:65536:free` | 65,536 | 16,384 | 32,768 | 8 prompts × 4 |
| `training/configs/inkling-long-context.json` | `Inkling-2-Mini:peft:262144` | 262,144 | 65,536 | 131,072 | 8 prompts × 4 |

## Setup & Commands

```sh
npm ci --ignore-scripts --no-audit --no-fund
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tinker" uv sync --project training --locked
source .venv-tinker/bin/activate

# Offline tests & preflight
npm run test:tinker
python training/run.py --config training/configs/inkling-mini.json check

# Authenticate & verify live Tinker access
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live

# Recommended live progression: probe -> 12-example learnability -> pilot/long-context
python training/experiment.py probe --config training/configs/inkling-mini.json --output-dir runs/tinker-probe --live
python training/experiment.py learnability --config training/configs/inkling-pilot.json --output-dir runs/tinker-learnability --live
python training/run.py --config training/configs/inkling-pilot.json run
```

## Action Protocol & Trace Formats

Each assistant turn puts optional reasoning in Inkling's `<|content_thinking|>` block (or prose before the fence when `reasoning_channel: "text"`) and ends with one JSON action:

- External call: `{"type":"call","operation":"demo.readAsync","arguments":["key"]}`
- Completion: `{"type":"complete","kind":"return"|"throw","arguments":[finalArgs],"value":resultOrError}`

Trace formats:
- **`compact`** (default in configs): concise variable/property writes, branches (`branch i<xs.length => true (then)`), and returns/throws.
- **`full`**: adds intermediate scalar expression evaluations without duplicating writes or branch tests.
- **`actions-only`**: JSON actions only, zero teacher narration.

## Supervision, RL & Checkpoint Hygiene

- **Thinking-channel alignment**: With `reasoning_channel: "auto"` (default), `effort > 0` routes teacher traces into Inkling's `<|content_thinking|>` channel and JSON actions into `<|content_text|>`; `effort == 0` flattens traces to plain text.
- **Zero loss on observations**: System prompts, user prompts, and arrived external observations always carry `weight = 0`.
- **Exact RL provenance**: Sampled token IDs and logprobs are passed verbatim to `rl_train` (never decoded and re-tokenized). Trajectory-length normalization (`rl_token_normalization: "trajectory"`) prevents long failed rollouts from dominating short successes.
- **Checkpoint efficiency**: With `checkpoint_every_update: false`, intermediate RL steps use free ephemeral sampler refreshes (`save_weights_and_get_sampling_client()`), persisting durable cloud checkpoints only at `checkpoint_every`, validation, and final steps. When per-update recovery checkpoints are enabled (`checkpoint_every_update: true`), non-published `recovery-*` snapshots attach `ttl_seconds` (`recovery_checkpoint_ttl_seconds: 86400`).
- **Rollback safety**: Compression-gate rollback triggers during `rl_objective: "compression"` (or on a regression beyond `accuracy_tolerance` during `correctness` RL), never merely because correctness RL is still climbing below `compression_min_accuracy`.
