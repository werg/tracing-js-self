# tracing-js-self

An owned-machine JavaScript execution tracer and training harness for teaching small language models (starting with **Inkling-2-Mini** via the **Tinker API**) to execute JavaScript with concise, natural reasoning traces and verified external-effect behavior.

> Pre-release repository: APIs, trace formats, and datasets evolve in place without compatibility shims. See [AGENTS.md](AGENTS.md).

## Architecture

1. **Owned JS Interpreter & Trace Core (`src/runtime.js`, `src/frontend.js`, `src/validation.js`, `src/replay.js`, `src/causal.js`, `src/host/`)**
   - Bounded, deterministic JavaScript VM with copy-on-write state diffing, causal event journaling, host-capability boundary (`demo.*`, `fs.*`, `platform.*`, `natlang.*`), and TypeScript lowering (`src/typescript.js`).
   - Verified against independent native Node execution (`src/semantic/source-reference.js`).
2. **Readable Execution Traces & Behavioral Grader (`src/training/tinker-*.js`, `tools/tinker-*.mjs`)**
   - Converts causal execution journals into concise, natural scratchpad traces (`full`, `compact`, `actions-only`) formatted for Inkling's native `<|content_thinking|>` + `<|content_text|>` framing (or plain text at `effort = 0`).
   - Grades student rollouts solely on externally observable behavior: return/throw outcome, final input mutations & object aliases, and exact ordered external calls/arguments. Internal wording and intermediate steps may vary freely.
   - Stratified, lineage-isolated benchmark builder and independent native boundary verifier (`tools/tinker-benchmark.mjs`, `tools/tinker-supervision.mjs`).
3. **Tinker / Inkling-2-Mini Training Runner (`training/`)**
   - Reproducible SFT + group-relative RL (`importance_sampling` / `ppo`) runner (`training/tinker_js/runner.py`, `adapter.py`, `learning.py`, `metrics.py`, `experiments.py`).
   - Supports both the 65K free tier (`thinkingmachines/Inkling-2-Mini:peft:65536:free`) and long-context variants up to 256K train / 1M sample (`thinkingmachines/Inkling-2-Mini:peft:262144` or `thinkingmachines/Inkling-2-Mini`).

## Quick Start

Requires **Node >= 20** (pinned in `.nvmrc`) and **Python 3.11–3.14** with `uv` for Tinker training.

```sh
# 1. Install JS dependencies and run core tests
npm ci --ignore-scripts --no-audit --no-fund
npm test

# 2. Install locked CPU Python environment for Tinker
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tinker" uv sync --project training --locked
source .venv-tinker/bin/activate

# 3. Run full Tinker JS + Python regression suite
npm run test:tinker

# 4. Offline preflight (no API key or model compute needed)
python training/run.py --config training/configs/inkling-mini.json check
```

## Running Live Inkling-2-Mini Training on Tinker

```sh
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live

# Small contract probe + 12-example learnability check before any sweep:
python training/experiment.py probe --config training/configs/inkling-mini.json --output-dir runs/tinker-probe --live
python training/experiment.py learnability --config training/configs/inkling-pilot.json --output-dir runs/tinker-learnability --live

# Pilot run (65K free tier) or long-context run (256K train / 1M sample):
python training/run.py --config training/configs/inkling-pilot.json run
python training/run.py --config training/configs/inkling-long-context.json run
```

## Key Scripts & Configs

- `npm test` — Core VM, validation, replay, causal, and Tinker JS tests.
- `npm run test:tinker` — All Tinker JS + Python tests.
- `npm run demo` / `npm run trace` — Run the core tracer CLI (`bin/tracing.js`).
- `npm run tinker:build` — Rebuild stratified `training/fixtures/expanded/` corpus.
- `npm run tinker:fuzz` — Run independent boundary + adversarial grader verification.
- `npm run tinker:audit` — Audit supervision formats and causal prefix privacy.
- Configs:
  - `training/configs/inkling-mini.json` — 36-task smoke & integration suite (65K free).
  - `training/configs/inkling-pilot.json` — Expanded corpus pilot (65K free, 16K turn / 32K episode budget, batched RL).
  - `training/configs/inkling-long-context.json` — Long-trace training on `Inkling-2-Mini:peft:262144` (256K context, 64K turn / 128K episode budget).

See [docs/TINKER_TRAINING.md](docs/TINKER_TRAINING.md) and [docs/TINKER_EXPERIMENTS.md](docs/TINKER_EXPERIMENTS.md) for full training and study details.
