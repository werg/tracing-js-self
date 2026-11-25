# Initial Tinker implementation validation (historical)

This is the initial infrastructure record, before the comprehensive follow-up changes. See [the current validation record](TINKER_VALIDATION.md) for the current implementation.

Date: 2026-11-25. Device: tick. Working directory: `/home/werg/tracing-js-self`.

## Verified implementation

Source commit: `9eaa617cf2343ed6408354d766184c3941a7cbeb`.
Implementation hash (320 runtime/dependency files): `0cb2fa399747e1265bd62e4bfcdfeb39cc07610c7987c70efa86b958b196081c`.
Frozen dataset hash: `0620d10ccc402f67ac61fd5988c4aec8a1b785a3e8f78b7fc70a059e7da34483`.
Input corpus SHA-256: `821424ef51597d6c7e12d37f8c266c64c83f94f15b248a792a224e2fee85f1d1`.

This record verifies the implementation and local training prerequisites. No live model sample, optimizer update, trained Tinker checkpoint, or model-accuracy result was produced.

## Checks performed

| Check | Result |
| --- | --- |
| New JavaScript execution and importer regressions | 20 / 20 passed |
| Python suite with pinned SDK installed | 52 / 52 passed |
| Python suite without optional SDK dependencies | 49 passed, 3 real-SDK tests skipped |
| Existing console and exact V8 study regressions | 11 / 11 passed in the focused bridge regression |
| Repository contract generation/check | Passed under pinned Node 24.22.3 |
| Complete starter CPU executions | 36 / 36 passed |
| Source-family components | 18 |
| Train / validation / test cases | 20 / 8 / 8 |
| Actual Inkling supervised datums rendered | 20 |
| Largest supervised datum | 956 tokens |
| Largest initial rollout prompt | 707 tokens |
| Reserved output per turn | 2,048 tokens |
| Free-model context budget | 65,536 tokens |
| Local setup readiness | true |
| Live training readiness | false: authentication absent |

The Python suite comprises 21 adapter tests, 24 runner tests, and 7 end-to-end tests using the real Node worker with explicitly labeled scripted samples. Three adapter tests use the installed SDK, renderer, and tokenizer without sending authenticated requests. Scripted samples never become performance evidence.

The tests cover causal observation delivery, zero external-observation loss, original sampled-token/logprob shifts, malformed-output token accounting, input mutation and alias identity, shorter verified completions, incorrect/missing effects, native randomness, strict source handling, TypeScript lowering, V8 binding preservation, multi-program/ancestor split isolation, interrupted evaluation/RL groups, optimizer checkpoint recovery, and rejection of mocked performance reports.

## Runtime and dependencies

The experiment tests and preflight used Node 22.22.1 and Python 3.14.4 on tick. Tinker 0.40.0, tinker-cookbook 0.7.1, tml-renderers 0.4.2, and CPU PyTorch 2.15.0+cpu were installed from the committed project/lock. The renderer resolved to `tml_v0` for `thinkingmachines/Inkling-2-Mini:peft:65536:free`.

The full existing V8 contract gate failed under Node 22 with a reference-completion mismatch, then passed under the repository-pinned Node 24.22.3. The new work did not change the existing runtime or contract definitions. Use the pinned reference runtime for that gate.

## Reproduction commands

```sh
cd /home/werg/tracing-js-self
npm run test:tinker
.venv-tinker/bin/python training/run_tests.py
npm exec --yes --package=node@24.22.3 -- npm run contracts:check
.venv-tinker/bin/python training/run.py --config training/configs/inkling-mini.json check
```

The final preflight is retained locally in `runs/tinker-mini/check.json` with the frozen dataset and implementation identities. Generated datasets, private fixtures, local logs, and environments are ignored by Git. The source and dependency locks are committed.

## Authentication and next live run

A direct SDK capability preflight failed with `TinkerError` because no API key was supplied through the client, `TINKER_API_KEY`, or stored CLI authentication. This was an authentication check; it did not start model compute.

```sh
source .venv-tinker/bin/activate
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live
python training/run.py --config training/configs/inkling-mini.json run
```

An authenticated preflight must verify account access to the configured free model. The first actual learning milestone remains a saved trained checkpoint and the held-out accuracy/token report from that run.

## Local evidence digests

Files below are relative to `.cache/tinker-verification/`. These hashes identify the local evidence used for this record; the commands above reproduce the checks.

| Local evidence | SHA-256 |
| --- | --- |
| `offline-tests.log` | `3bd24db7d5aeed0db2b5b33cfd4524a075994da0f9318bb56fbef110d055fd1a` |
| `sdk-tests.log` | `b8c6452092d6e8c6d6c87901122d796b4bfefefde804b357f93830950086268e` |
| `contracts-node24.log` | `bbe903778426e18594f1eb27c9cd2e5465d7ee580da23518fc18bf976caaf404` |
| `final-preflight.stdout.json` | `a6e8655223fdb21700443bb8d31a55da5f8c2f54e3866ce74d46a27eaccab4a8` |
| `auth-check.json` | `636ac499458b69a7dca72f6d9d106ca3d475608576dd8f759eb0d800af9fa8e3` |
