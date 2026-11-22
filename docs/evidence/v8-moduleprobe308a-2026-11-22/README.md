# Shared-context staging and original-module composition probe

The exact hosted pair passed [run 45013067890](https://github.com/werg/tracing-js-self/actions/runs/45013067890), job 137179405755, on 2026-11-22. The complete job log is retained in `complete-success.log`.

| Authority | Exact revision |
| --- | --- |
| Producer | `308ae678d79c7c1568816a20dec69ee20dcade99` |
| Independent native consumer | `fe563c1fa8e11a73f59af53c59da97e553b26fa3` |
| Public contract | `f92c2b99bcd373eadaadf2fa425af6b866c4312a18c6ff62b74743c40ab19f3c` |
| Existing interoperability population | `f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661` |

Both checkouts remained unchanged. Canonical producer regeneration, exact native contract equality, and all six existing interoperability payloads passed. The complete gate ran 109 Node controls (40 scheduler, 49 shared-generator/Promise, 20 nested-async/context-isolation) and 95 native Python controls, with zero failures and zero skips.

## What changed

Private source-event staging now copies the index of already-isolated context snapshots, rather than cloning every historical snapshot for each event. Captured and exported snapshots remain deep copies, and mutable selected state still forks independently. Two adversarial controls verify returned/exported-context isolation, committed branch isolation, and discarded branch nonpublication.

The original three-module probe combines a caught rejected top-level await, a sibling top-level await, and the synchronous importing entry module. It freshly recompiles the original module request, verifies unique lifecycle event ownership, emits ordinary generator/Promise/async public records, compares the outcome with original untransformed ESM, and independently replays the public continuation in Python.

The exact hosted probe covered 2,012 owned source events, 707 public records and causal contexts (595 detail plus 112 protocol), 10 uniquely owned module lifecycle cuts, and all 10 corresponding independently checked native public states. Every source-owned cut maps to one contiguous public transaction. Python checked all 707 contexts, completed a separate full checkpoint replay, and matched the complete final shared state. The probe took 335,383 ms in this hosted environment; this is one concrete run, not a general performance benchmark.

The scheduler foundation's six original ESM cases/64 source-owned cuts, the shared-generator six cases/189 contexts, and the nested-async ten cases/231 contexts remain separate evidence populations. They are not added together as a production coverage denominator.

## Boundaries and lessons

The public records at this revision do not contain an active module lifecycle ledger. Module dependency/settlement facts are checked as a source-owned engineering comparison. The native receipt therefore reports `admitted: false`; masks, source binding, and tokenizer admission remain untested. Module admission and training admission remain false, and this probe performs zero optimizer updates.

The earlier probe implementation redundantly replayed every preceding checkpoint for each module cut. This revision reuses the exact causal states already independently replayed and checked by native artifact validation, then retains a separate full checkpoint replay and complete final-state equality. The change removes repeated work without replacing independent native checks with producer-reported facts.

Plan-bound lifecycle enforcement, broader module families, source/data admission, production population changes, and model exposure require their own exact paired evidence. This receipt does not certify later worktree changes.

## Main-branch composition

The exact three executable/test blobs listed in `main-composition-scope.json`
were composed on producer `fb871032967b789eae69b71777eb53cd7fc9f312` against
native `4545ad50a40c8c4321e15517ebcbbee832c86eba`. All 69 source-composition
controls passed locally with zero failures or skips; the raw JUnit result is
`current-main-source-composition.xml`. The main interoperability CI lane now
requires both new context-isolation controls in its exact 69-case gate.

Separately, the preceding main pair passed hosted focused continuation run
[45013504747](https://github.com/werg/tracing-js-self/actions/runs/45013504747),
job 137180762710: 208 leaf testcases, zero failures and zero skips. The Node
reporter also counts five parent entries, so its aggregate counter is 213.
`current-main-focused.log.gz.b64` retains the full raw log, with its SHA-256 in
the scope file. This earlier run qualifies the async/recovery/edition composition
and the corrected paired module test environment; it does not by itself qualify
the later staging optimization. Neither result is a complete-language, learned
quality, training-exposure or production-cutover claim.
