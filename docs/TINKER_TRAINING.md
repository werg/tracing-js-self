# Inkling execution training with Tinker

## Objective and implementation plan

Train `thinkingmachines/Inkling-2-Mini:peft:65536:free` to execute supplied JavaScript, then prefer shorter executions only after the complete externally observable behavior has been verified. Tinker supplies model compute. The owned JavaScript interpreter, controlled host environment, and independent Node reference execution run locally on CPU.

The implementation is organized around five acceptance criteria:

| Work | Implementation | Acceptance criterion |
| --- | --- | --- |
| Connect Tinker | `training/tinker_js/adapter.py` | Official Inkling renderer/tokenizer; exact sampled token IDs and log probabilities; assistant-only supervised loss; context limits; resumable optimizer checkpoints. |
| Export examples | `src/training/tinker-execution.js` and `tools/tinker-execution.mjs` | Ordinary source and readable execution conversations; observations have zero prediction loss; source families remain together. |
| External observations | Controlled fixture broker and registered native callable bindings | Reads, writes, clocks, console effects, and native observations arrive causally; no expected answer or future observation appears in the student's initial context. |
| Compression grading | Private reference execution and public student action protocol | Return/throw, final input state, aliases, and ordered external operations agree; missing, invalid, or incomplete executions receive no success reward. Internal wording and intermediate steps may differ. |
| Experiment runner | `training/tinker_js/runner.py` | Export, baseline, SFT, sampled rollouts, RL updates, checkpoint/resume, and a held-out accuracy-versus-generated-token report. |

The existing canonical V8 admission and exact-trace scorer retain their existing purpose. The new outcome experiment makes a separate behavioral claim; it does not confer canonical trace admission on arbitrary student prose.

## Setup on tick

From `/home/werg/tracing-js-self`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tinker" uv sync --project training --locked
source .venv-tinker/bin/activate
python training/run.py --config training/configs/inkling-mini.json check
```

The project requires Node 20 or later and Python 3.11–3.14. The Python lock pins Tinker 0.40.0, tinker-cookbook 0.7.1, tml-renderers 0.4.2, and CPU PyTorch 2.15.0. No local GPU is required. The JS dependency lock remains the root `package-lock.json`.

Configure `TINKER_API_KEY` in the shell used for the experiment, or use the SDK's supported authentication mechanism. Keep credentials out of source files, configuration, datasets, logs, and checkpoints. Once credentials are available, run the live preflight before starting model compute:

```sh
tinker auth login
python training/run.py --config training/configs/inkling-mini.json check --live
python training/run.py --config training/configs/inkling-mini.json export
python training/run.py --config training/configs/inkling-mini.json run
```

The default configuration requests only the free model. The adapter never falls back to a paid model. The free tier has a 65,536-token context limit and rate limits, and prepaid accounts need a positive balance. Checkpoint storage has separate provider pricing. See [official pricing](https://thinkingmachines.ai/tinker/pricing/) and [checkpoint management](https://tinker-docs.thinkingmachines.ai/tinker/howto/checkpoints/).

## Starter experiment

`training/fixtures/executor.jsonl` contains 36 executions from 18 source families. It covers arithmetic, branches, ordered folds, array maps, strings, input mutation and aliases, return/throw, finally cleanup, synchronous and asynchronous observations, rejected reads, clock observations, console output, supplied native functions, fresh randomness, TypeScript lowering, and simulated file reads/writes.

Each family has two input/environment variants. This is a varied integration and initial learning suite, not a statistically sufficient benchmark for a broad JavaScript-execution claim. Expand the source inventory before interpreting small differences in accuracy as evidence of improvement.

The initial experiment supplies source code and invocation arguments to the executor. Learning which code to choose against an actual agent task is a later objective. Supervised agent-call examples can teach the call format, but executor success alone does not establish agent-task success.

The runner freezes dataset contents, realized random observations, a deterministic family split, and hashes of the runtime, runner, and dependency locks. A family, ancestor group, or identical source must not occur in multiple splits. Baseline, SFT, and RL evaluations use the same held-out cases and sampling settings. Training consumes only the training split. Test scores are for reporting, not checkpoint selection or reward tuning.

Default limits are deliberately small: one SFT epoch, one RL update, four samples per RL group, eight turns per execution, 2,048 sampled tokens per turn, and 8,192 total generated tokens per execution. All are configurable in `training/configs/inkling-mini.json`. The renderer uses the same explicit thinking effort for training and sampling. Context overflow fails explicitly; it does not silently drop earlier source, observations, or student history.

## Dataset authoring

A task is one JSON object per line. For example:

```json
{"id":"counter-a","family":"read-update-write","source":"function run(key){const n=host.readNumber(key);host.store(key,n+1);return n+1;}","entry":"run","args":["counter"],"fixture":{"calls":[{"operation":"demo.readNumber","arguments":["counter"],"result":4},{"operation":"demo.store","arguments":["counter",5],"result":{"$js":"undefined"}}]},"randomSeed":17}
```

The fixture belongs to the environment and private grader. Its future return values are not part of the initial model prompt. The student must request the correct external operation and evaluated arguments before receiving its observation. A wrong request terminates the attempt without supplying the teacher's correct request or expected arguments.

Host calls use the repository's existing operation names and capability boundary. Examples include `demo.readNumber`, `demo.readAsync`, `demo.store`, `fs.readText`, `fs.writeText`, `platform.dateNow`, `platform.console.log`, and `natlang.callSync`. The default suite simulates these effects; it does not write arbitrary real files or send network requests.

Use `nativeBindings` to supply named native functions, such as `lookup` or `freshRandom`. Native values travel through the registered host boundary. `Math.random()` remains seeded internal computation. For reproducible training, record the realized external random values in the private fixture; variants of the same source family can carry different observations. The source and public capability descriptions may name a native function, but must not contain its future result.

Set `language: "ts"` to use the repository's TypeScript lowering path. Unsupported syntax, host contracts, or observation graphs are rejected during export. Do not silently replace unsupported programs with an oracle answer or count them as successful evaluations.

Special JavaScript scalar values use the documented `$js` tags, for example `{"$js":"undefined"}`, `{"$js":"NaN"}`, or `{"$js":"-0"}`. The behavioral codec also preserves relevant object identity and input aliases. Its limits are explicit; it is not an unrestricted serialization of arbitrary ECMAScript objects.

## Importing existing artifacts and agent demonstrations

The `tracing-js-self/training/tinker-import` entry exports `exportCanonicalTinkerExample`, `exportAgentTinkerExample`, and `readableAgentMessages`. The worker's `export` operation also accepts JSONL rows containing `canonicalArtifact` or `agentTrajectory`.

For a canonical V8 artifact, provide `{"id":"example-name","canonicalArtifact":{...}}`. The importer rechecks the original artifact, extracts its exact source/input/environment, and produces a readable interpreter conversation. A top-level frozen V8 dataset binding is independently validated and its split/component preserved. The nested source admission's default hash split is not treated as a frozen dataset assignment. The import does not confer canonical trace admission on alternative student wording.

An agent row contains a normal executable task plus `agentTrajectory: {"messages":[...]}`; alternatively the task can live in `agentTrajectory.task`. Messages use `system`, `user`, `assistant`, and `tool` roles. Assistant `tool_calls` use `{id,type:"function",function:{name,arguments}}`, and tool messages reference `tool_call_id`. Arguments can be a JSON object or JSON string. Plain text is required; richer multimodal imports are outside this adapter.

JavaScript tool names default to `javascript`, `js`, `execute_javascript`, `run_js`, and `eval_js`; use `javascriptToolNames` for a different tool name. JavaScript calls supply `code` or `source`. The importer records all embedded program identities for split isolation, keeps call arguments next to observations, and removes opaque routing IDs from model-facing text. Results must follow real outstanding calls, and incomplete conversations are rejected.

The attached executor task is independently checked. The imported agent decisions and their broader task success remain supplied demonstrations: metadata explicitly records `agentTaskSuccessVerified: false`. Preflight replays the attached task separately; it does not pretend that these demonstrations are executor-protocol actions or certified agent-task successes.

## Supported initial execution profile

The first experiment supports sequential executions over the repository's data-value profile, including promise-returning calls that are awaited before another external request. It explicitly rejects callbacks, subscriptions, concurrent outstanding requests, and out-of-order observation schedules. The host console contract currently takes one argument; use an array to group several values. Unsupported cases fail export with their task ID.

The codec preserves supported data graphs and the repository's name/message Error profile. It does not claim arbitrary object prototypes, descriptors, functions, or every ECMAScript feature. This keeps training examples within independently verified runtime behavior while allowing the student to choose its internal explanation.

## Supervision and RL invariants

Supervised targets include useful JavaScript calls and readable execution steps/results. Program input, environment messages, and real tool observations receive zero prediction loss. Masking is applied at the renderer/token level and shifted consistently with next-token prediction. A removed teacher step must be absent from the conversation, not simply assigned zero loss while remaining visible.

During rollout, the runner continues from the student's own messages. It never inserts teacher intermediate state or corrected calculations. The grader compares only after the attempt is finished, using separately retained reference data and the recorded external behavior.

Every sampled response retains its original prompt tokens, output token IDs, and token log probabilities. RL constructs training data from those exact sequences; it never decodes and re-tokenizes the student response. This includes Inkling thinking, public reasoning, formatting, action syntax, and termination tokens. External observations remain part of subsequent prompts and receive no direct prediction loss.

Incorrect, malformed, over-budget, or incomplete executions receive zero success reward. The experiment runner uses `1 - length_penalty * min(generated_tokens / max_generated_tokens, 1)` for verified successes. With the default penalty of 0.25, every verified success earns at least 0.75, and shorter successes earn more. The standalone JS grader also exposes a monotonic diagnostic reward; the runner records that as `environmentReward` and applies the configured experiment reward consistently. Group-relative advantages may be negative for failed attempts even though their raw success reward is zero. A group with identical rewards has no relative learning signal and should be reported honestly.

Both training-state and sampler checkpoints are retained. Resume the full sequence with:

```sh
python training/run.py --config training/configs/inkling-mini.json run --resume
```

Completed evaluation cases and RL group members are reused, and the original RNG state is restored. Partial infrastructure failures retain received tokens and probabilities in `infrastructure-errors.jsonl`; they abort updates and remain separate from model failures. No blind retry repeats an uncertain optimizer update. Training-state checkpoints include optimizer state; sampler checkpoints are for evaluation. Resume must match the dataset, split, configuration, and training cursor rather than silently starting a new training session from sampler weights.

## Verification and reports

The full repository contract generator uses the reference engine pinned in `.nvmrc` (Node 24.22.3). The isolated command below supplies it without changing tick's default Node. The starter experiment and its new tests also run under Node 22.

```sh
npm run test:tinker
npm exec --yes --package=node@24.22.3 -- npm run contracts:check
python training/run.py --config training/configs/inkling-mini.json report
```

Artifacts are written under the configured output directory, normally `runs/tinker-mini/`, and are ignored by Git. Existing datasets are reused only when input, configuration, implementation, and stored-content hashes agree; `--refresh-export` deliberately regenerates a corpus before checkpoint state exists. They include frozen split/provenance data, exported conversations, rollout records, training metrics, checkpoint paths, and a compact JSON/Markdown report. Private grading fixtures and full trajectories can contain sensitive task data; keep them within the experiment's intended access boundary.

Read complete-execution accuracy alongside mean generated tokens, successful-execution tokens, and failure/incompletion counts. A short failed attempt is not a compression success. Compare held-out runs with the same case IDs, seeds, budgets, and evaluation settings. The first model milestone is an actual trained checkpoint plus such a report; passing unit tests or replaying teacher examples establishes infrastructure correctness only.

## Primary implementation references

- [Tinker SDK cheatsheet](https://tinker-docs.thinkingmachines.ai/tinker/sdk-cheatsheet/)
- [Using Inkling](https://tinker-docs.thinkingmachines.ai/cookbook/inkling/)
- [Inkling thinking effort](https://tinker-docs.thinkingmachines.ai/cookbook/inkling/thinking-effort/)
- [Tinker reinforcement learning](https://tinker-docs.thinkingmachines.ai/cookbook/rl/)
- Existing canonical bridge: `src/semantic/causal-lm-v8.js`
- Existing exact-trace study: `src/semantic/execution-study-v8.js`
- Existing native callable integration: `src/natlang-selected.js`
