# Current V6-to-V8 production route matrix

This inventory supersedes the **route-status claims** in the 21 November 2026
production-boundaries review. That review remains historical evidence for the
code it inspected. The matrix below uses the current producer worktree and the
paired consumer checkout at `abf4dc6424e3aeaf10f1d2609a2197897c1d42ba`; it does
not qualify a release or claim that V8 is the production default.

This is a **partial inventory of four major route categories**, not an
exhaustive mapping of every production entry point, launch recipe, service,
callback, recovery cut, or release-restoration route. Acceptance package 1
remains open until that complete mapping is tied to current paired evidence.

| V6 production route | Current V8 replacement | Current implementation evidence | Remaining parity gate |
| --- | --- | --- | --- |
| Typed coordinator/child task calls, completion, cancellation, and restoration | The V8 server exposes `open_orchestration`, `select_orchestration`, `commit_orchestration`, `bootstrap_orchestration_child`, `status_orchestration`, and `cancel_orchestration`. The producer binds public actions to acknowledged native V8 child tracks. | Consumer `src/megatoken/semantic_model_v8.py`, `src/megatoken/semantic_orchestration_v8.py`, `scripts/serve_semantic_v8.py`; producer `src/semantic/orchestration-training-v8.js`; focused transport, recovery, and checkpoint tests. Exact recorded paired checks include the 64-source/native lane and the 77-control native orchestration completion-cut run retained in `docs/evidence/v8-composite-terminal-2026-11-22/`. | Current teacher/runtime policy is bounded to declared root children and complete return/throw. Dynamic descendants, callbacks that create children, general concurrent graphs, and a final exact-head production restoration route still need qualification. Historical typed-RPC absence is no longer a current implementation blocker. |
| Production source families and behavior supply | Source-qualified repeated sessions and a frozen 64-source support cohort provide train/validation examples for code, tool feedback, async, callbacks, repeated invocation, semantic child work, source reread, and recovery. | `src/semantic/source-session-v8.js`, `docs/V8_SOURCE_SESSIONS_AND_SUPPORT_COHORT.md`, and `docs/evidence/v8-support-qualified1e71-2026-11-22/`. The recorded `1e71e5a/b276dc3` route passed 64/64 source, native, tokenizer, packing and preparation checks plus all eight supply requirements in both splits. The exact 64-source ordinary optimizer/resume/export/service route passed at `10c3016/a886fb8`. | A later scored-target census at `3cf0e47/e9817ad` measured four targets from one training source; only one of 48 training sources was scored. Full target exposure, accepted model-action recovery, learned task success, and new-pair/current-head repetition of the complete route remain open. Source eligibility and behavior supply are not optimizer exposure or learned success. |
| Ordinary production training launch | V8 has its own `semantic_v8_policy` configuration and `qualify_policy_v8` authority. The V8 launch path does not need `semantic_experiment`; legacy experiment launch remains a separate V6 path. | Consumer `src/megatoken/training/semantic_launch_v8.py`, `src/megatoken/training/semantic_launch.py`, `tests/test_semantic_launch_v8.py`, and `tests/test_semantic_launch_v8.py::test_real_production_v8_configuration_has_its_own_launch_authority`. The test asserts `config.semantic_experiment is None`. The launch policy also verifies clean exact producer/consumer identities. | Current-main installed-wheel and complete final-pair launch/readiness checks must be repeated after the latest paired changes. Production launch recipes, complete scored-target exposure, learned quality, and default routing remain separate release gates. Historical `semantic_experiment` dependency is not a current V8 launch-code blocker. |
| Prepare, train, resume, export, and restore production corpus | V8 preparation/admission, ordinary trainer, checkpoint, export, and service restoration now accept the complete support corpus on recorded pairs. | Consumer `scripts/prepare_semantic_corpus.py`, `scripts/admit_semantic_v8.py`, `scripts/qualify_semantic_v8_lifecycle.py`, `src/megatoken/training/semantic_launch_v8.py`; producer source-session/support verifiers; hosted logs cited above. | Repeat the entire sequence on the final PR pair and current main, with ordinary production tokenizer and installed package, after all remaining target/callback changes. Existing historical pair receipts do not qualify changed revisions. |

The still-open V6 parity question is no longer “does V8 have the typed child
route, behavior supply, or an independent launch qualifier?” Those now have
implementations and bounded historical checks. It is whether the final pair
qualifies those paths end to end at current heads, and whether the bounded
profiles cover all required production recipes, targets, dynamic descendants,
recovery cuts, and learned outcomes. Keep every narrower receipt scoped to its
exact pair and population.
