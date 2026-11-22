# Final paired composition — 22 November 2026

## Published implementation checkpoint

Producer [`e58a0e3e`](https://github.com/werg/tracing-js-self/commit/e58a0e3eca94aaf96df1aebfc487d83f40109fb9) composes 26 recovery and 30 Promise source/test paths and pins native [`eb758da9`](https://github.com/werg/megatoken/commit/eb758da9f1f6e6cca90ba7f4a3c9d4e70753bb0c). Native tree `85245d6cc3c95fb9d339c53bb54e4b66872bd8da` composes six recovery, 14 Promise and eight release/input-relocation paths. These are scoped integrations, preserving later main evidence and training archive tools.

The producer's explicit optional-native configuration guard was reapplied after recovery composition; it is the sole intended difference from that recovery file map. Promise source/test paths match their frozen map exactly. Native recovery, Promise and release paths match their respective final candidate blobs exactly. No alternate async resolution mechanism was added.

The independent generated contract check passed on this producer composition: contract `fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`, interoperability `b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`. This check is not the final paired qualification.

## Completed bounded evidence, with its original source identity

| Gate | Exact tested pair and run | Result |
| --- | --- | --- |
| Recovery | Producer `9b2e5fae` / native `15844c00`; [45042073863](https://github.com/werg/tracing-js-self/actions/runs/45042073863) | 165 native and 193 producer leaf cases, zero failures, errors or skips; all five jobs passed. |
| Promise object guard | Producer `132b1d10` / native `03a9e338`; [45042386283](https://github.com/werg/tracing-js-self/actions/runs/45042386283) | 104 native and 167 producer cases, zero skips; distinct original-source and refusal populations retained. |
| Added original async-return assertions | Final Promise source map in `docs/evidence/promise-final-composition-20261122/` | Both exact original programs retained: two sources, nine serialized cuts, 78 native contexts; four producer leaves passed. |
| Added Promise boundary assertions | Same final source maps | Twenty focused producer and ten native async controls passed. These overlap other populations; the final full Promise union is 173 producer / 106 native. |

The complete original successful and failed recovery artifacts, full job logs, checksum metadata and reproducible independent audit are retained in `docs/evidence/v8-composed-recovery-20261122/`. Promise guard red/green proof and both original hosted packets are retained in the separate Promise evidence directories. No counts in this table should be summed as one unique population.

### Why the recovery test correction matters

Recovery replays previously selected records to reconstruct model state. It must retain original attempts, decoder records and historical cost, then account for exactly one recovery and one checkpoint call. It must not dispatch new external work or repeat service termination. The earlier two failing expectations incorrectly required an empty history after reconstruction. Their correction preserves the stronger refusal controls and the complete original failed run.

## Release task authority defect and correction

The original release verifier accepted a resealed journal after the perimeter and capacity tasks' individually valid source/admission/native artifact triplets were swapped. The original frozen 64-task population, selection and registry bytes were unchanged. This demonstrated that internal hashes and successful replay of an artifact do not establish that it belongs to the selected task.

The original counterexample is retained in `docs/evidence/v8-release-task-binding-red-2026-11-22/`. Corrected source [`790f525c`](https://github.com/werg/tracing-js-self/commit/790f525c280b34a66ef8269aa7148bd9966b8639), tree `704836c11a16ce49350157b2813c5c0677c4cd24`, binds the encoded task's source, entry, argument aliases, host fixture, random seed, ordered session/module calls, teacher requirement and frozen registry membership before fresh replay. The unchanged original 64-task packet passes; the same swapped-artifact packet is refused without mutating the journal.

The snapshot is a read-only request comparison. Existing package/restore verification still freshly executes the bound source, independently admits it, prepares data and checks checkpoint/model contents. Module verification freshly relinks the original graph and compares the generated source, inputs and outcomes. Transformed tasks carrying a distinct `originalReferenceSource` fail closed pending an explicit binding for that source; none of the frozen 64 support tasks requires that exception.

The corrected local population passed 59 executable Node leaves (70 reporter entries including parent containers) and 17 archive controls, zero skips. [Corrected hosted run 45044587251](https://github.com/werg/tracing-js-self/actions/runs/45044587251) is in progress on native `d4afac5b`. The older [45042619619](https://github.com/werg/tracing-js-self/actions/runs/45042619619) remains separate mechanics evidence and cannot close the task binding defect. Both are distinct from the still-required final composed pair.

## Exact continuation of the interrupted original training pass

[Run 45043236761](https://github.com/werg/tracing-js-self/actions/runs/45043236761), driver `2dd1d31d`, continues original producer `9cf091e6` / native `1a69d9d`. The original archive is 175,381,869 bytes with SHA-256 `6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`. Its step314 checkpoint, optimizer/RNG/cursor, original runtime and input path identities passed preflight.

The original engine limits each invocation by its new updates, so the continuation changes only the invocation limit from 348 to 34. It requires exactly updates 315 through 348, preserves every original metric/checkpoint/input byte, then independently reconstructs full target and position coverage. The original partial run and failed command report remain unchanged.

Completion of this bounded pass is different from exhausting the original 200,000,000-unit phase budget. The complete one-pass position census is 52,054 units. A final metric may correctly retain a step-limit termination; coverage must be proven by the independent census. No learned-quality or router-internal-position result is inferred.

## Remaining acceptance and next gates

1. Finish and independently audit the exact 34-update continuation; preserve the complete original and resumed archives with verified durable custody.
2. Qualify corrected source-task binding and actual production-tokenizer package/restore on the final composed producer/native pair.
3. Require all six recovery/Promise lanes on that exact pair: recovery 165 native / 193 producer; Promise 106 native / 173 producer. Verify installed consumer and shared payloads, exact source identities, complete per-file populations and zero skips.
4. Observe the current ordinary Node20/22/24 matrix separately. Absent optional native configuration remains an explicit skip; mandatory paired gates never use that escape.
5. Complete broader source ownership, unknown external effects, dynamic descendants, full edition/production-route parity and measured learning/operational acceptance before changing defaults.

All 17 full acceptance packages remain open. Both PRs remain drafts; V6 remains the production default. The main PR description keeps the complete per-package implementation/remaining tally. The full preceding narrative is retained in [PR47 before final composition](PR47_NARRATIVE_2026_11_22_BEFORE_FINAL_PAIR.md).

