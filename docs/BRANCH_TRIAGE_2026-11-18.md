# Branch and maintenance triage — 18 November 2026

This is a read-only snapshot, not a branch deletion or a blanket merge recommendation. The comparison base is public `main` at **`dac57b163f277085f1ee42f5d1fa0085eeecb556`**, the merge of PR36. GitHub branch enumeration returned 30 branches; a second page was empty. Of these, 23 pre-November branches were examined below, six `codex/` branches were active at that snapshot, and one is `main`.

**Later same-day integration update:** PR37 subsequently merged into main at `2aa694be86a6cda3b9d63fde739957d08f568961`, confirmed from the remote before integration. The original inventory and patch comparisons below remain a snapshot at `dac57b1`; they are not rewritten as a new branch audit. PR38 incorporates that exact main revision alongside its own `58dd347f3f29c044bd2fd4b872c8f1c727fe2899` head in published two-parent merge `aafcd199489659c92e78c73237150aeb41b5025d`. Its tree is `fd63d7c5c9f6669c421813df216a87c137a2d924`; both branches' useful features and all original receipts were preserved. Implementation head `1e2e6a0de8952c4349edbeef46ab70c4a06f8157` additionally receives explicit artifact/repair receipts, authenticated learning guards, the reconciled native consumer policy, and the hosted registry-persistence/shutdown repair. Final documentation/evidence is consolidated in `278337e317ebc51ab7f196146dceb64a0d4d5b71`. Evidence-only merge `8f99dd6436cb517fa31be246ed945efe997a0b29` then retains temporary CI producer `3850539e1038f3cd19c19c446403444b96281797` as a reachable parent. Its source tree exactly equals the recorded `aa7b843` tree; that retention merge changed no file bytes. PR38 then merged at 14:23:55 UTC into main `0c307781fea0fa3fca58f1dec037c8653cc921e0`; a fresh remote fetch confirmed its tree exactly equals implementation head `1e2e6a0`. The final-docs branch received that main commit, preserving all evidence additions with no non-documentation delta against main. No branch was deleted or overwritten. Repeat the final section's read-only checks before any later cleanup.

## Method and decision rule

Each historical branch was checked with `git merge-base --is-ancestor`, `git rev-list --left-right --count`, and `git cherry -v main branch`. A `+` from `git cherry` only means that an individual commit's patch has no identical counterpart: it does not establish missing functionality after a squash.

For non-ancestors, the complete diff from their merge base to their tip was compared with the relevant mainline commit using `git patch-id --stable`. Changed-file blob identities and remaining source/test/documentation content were then checked for the four cases without a complete aggregate match. Patch IDs ignore whitespace and line numbers; the content checks below address the semantic differences that matter for cleanup. PR state was read from GitHub, rather than inferred from branch names.

**Result:** ten branch tips are ancestors of main; nine additional branches have an exact stable aggregate patch match on main (one also has an individually equivalent commit); four are superseded or incorporated with the specific differences described below. None needs a wholesale merge into the current v5 tree. This is a recommendation to archive the historical references after maintainer review, preserving the cited history and evidence.

## Tips already in main's history

| Branch | Examined tip | PR / ancestry evidence |
| --- | --- | --- |
| `audit/grounded-effects-single-witness-path` | `e032f737830d` | PR30 merged; tip is an ancestor |
| `docs/semantic-execution-track-invocations` | `c560d90dd06a` | PR31 merged; tip is an ancestor |
| `eliminate-legacy-trace-paths-20261025` | `4b45aaddf815` | PR35 merged; tip is an ancestor |
| `feat/semantic-execution-followups-20261025` | `5a413868639e` | PR33 merged; tip is an ancestor |
| `feat/semantic-execution-harness-v4-20261025` | `e486399c165f` | PR32 merged; tip is an ancestor |
| `fix/semantic-v3-unified-hardening-20261024` | `f2da83dd4abf` | PR27 merged; tip is an ancestor |
| `owned-coercion-rejection-20261022` | `1f2b7d2f4b7a` | PR7 merged; tip is an ancestor |
| `semantic-reasoning-traces-20261025` | `0894066c149b` | PR34 merged; tip is an ancestor |
| `work/natlang-bounded-20261022` | `4338da3f01eb` | Direct ancestry, independent of PR naming |
| `work/promise-reactions-20261022` | `60b8494514c4` | Direct ancestry, independent of PR naming |

## Squashed or patch-equivalent work

Every row has a matching **complete branch delta**, not merely a similar commit subject. The `+ / -` column gives non-equivalent / equivalent individual commits reported by `git cherry`; merge commits are not counted by that command.

| Branch | Examined tip | `+ / -` | Matching mainline commit |
| --- | --- | --- | --- |
| `feat/common-control-updates-20261023` | `1a3a0d465478` | 16 / 0 | `98e06b088e2306f24d75abdd195b268cea4bf7d0` |
| `feat/semantic-trace-boundary-foundations-20261024` | `f4966c052c5b` | 0 / 1 | `ed3666c12270bca9a17e7c4ed580f6ff4f347099` |
| `fix/corpus-last-96-20261023` | `0f9a6d04c0f3` | 24 / 0 | `855f9f61645eaf16a3c3ce320224bbd6183d21fe` |
| `fix/corpus-rest-spread-complete-20261023` | `a369a2617485` | 14 / 0 | `570c8274cb2688e6e4a04756d219c54dffa1f14c` |
| `fix/corpus-trace-capabilities-20261023` | `d6827a9aa230` | 6 / 0 | `94251276321604f1974eeb4db40f647902fe4055` |
| `fix/corpus-verified-traces-20261023` | `a90ff81b0f03` | 47 / 0 | `643b660f56ca460034d430b10c398b2d9597fbaf` |
| `fix/host-journal-integrity-20261022` | `adf1354e3e0a` | 15 / 0 | `9eb4d0cb7587551d3cc15b6ca39ab21b529b5173` |
| `fix/owned-array-sort-corpus-20261023` | `55ef645f63e8` | 4 / 0 | `0fc4bb3d15c9e39e9f00976960973311d67713c3` |
| `fix/salvage-pr9-pr11-integrity-20261023` | `dc96914512d6` | 5 / 0 | `9e2b9c4f771ebc97df23454cc7e2b37b9bd9c621` |

This explains why reopening PR9/11/19, or treating those branches' positive `git cherry` counts as missing work, would be misleading. For example, current `src/runtime.js` rejects non-boolean arrival `abrupt` flags before journaling, `src/validation.js` accepts owned binding/property update completions, and the salvaged completion/journal regression files match the branch's blobs. Later v5 changes have intentionally replaced the old training-format modules while retaining the fixes.

## Four content reconciliations

| Branch and tip | What differs | Grounded recommendation |
| --- | --- | --- |
| `feat/semantic-choice-reasoning-20261025` at `b103d28cbaed` | One post-PR29 documentation commit adds `docs/SEMANTIC_WITNESS_READABILITY.md`, which no longer exists on main. | Its own-property and named-helper explanation was recovered in PR35: current `docs/SEMANTIC_REASONING_TRACE.md`, section “Own-property choices and named helpers,” contains the v5 example, and `tools/inspect-semantic-reasoning.mjs` executes the `property-helper` case. Archive the historical branch; do not restore its v3 document as current guidance. |
| `feat/spec-oracle-test262-baseline` at `bbbadb9321e9` | Thirteen distinct commits; old `src/reference-engine.js` and a separate oracle test file are absent. Its engine pin ends in `678c2c0a…`. PR2/10/20 were closed without merging. | PR3/4 supplied the current `2d7d8d98…` oracle, exact Test262 blob pins, independent execution and replay checks, and explicit pass/known-fail/skip totals. Current surfaces are `src/spec-oracle.js`, `scripts/run-spec-probes.mjs`, and `tools/test262-baseline.mjs`. Preserve the isolated lock and the newer loader; no old oracle implementation should be imported. See issue13 below. |
| `fix/register-owned-template-substitution-20261023` at `c7e9c9a22c45` | The one-line intent is incorporated, but the branch labels `template.substitute` as an `algorithm`; main labels it `primitive`. PR14 was closed unmerged. | Main commit `f2bf22d3763c9f9814ccb1ed976a08b4d7a12f40` registers the same operation/version. Normalization maps it to a value observation, and `test/training-template-literals.test.js` covers source receipts, conversion, ordering, replay, and refusal. Preserve the current classification; importing the stale catalog edit would change content without fixing a missing registration. |
| `fix/remaining-corpus-classes-20261023` at `d7622455aa8d` | The tip includes work after merged PR17, and its complete delta is not one mainline patch. | The PR17 portion through `9f4060b7d183` exactly matches main's `8e55133` aggregate delta. PR18 explicitly records that the remaining rest/spread work was superseded by PR21; the branch's `test/training-rest-spread-corpus.test.js` is byte-identical to that file at merged main commit `570c827`. Current runtime/frontend retain the later rest/spread path. Archive this obsolete branch rather than merging its old schedule/visibility modules. |

## Work active at the original snapshot

The six active branches at this snapshot are `codex/resumption-20261118`, `codex/resumption-completion-20261118`, `codex/resumption-integrity-20261118`, `codex/resumption-learning-20261118`, `codex/resumption-semantics-20261118`, and `codex/release-integrity-20261118`.

[PR37](https://github.com/werg/tracing-js-self/pull/37), `codex/resumption-20261118`, had advanced after PR36 to `83e0d5742e63dc4439b68d6296f323cb7a3aafdc`, with 27 commits beyond the original public main snapshot. It was active work, not stale, at that audit. Its useful semantic commit `a22666041312e128820e37cd5fbfddebd75f6ded` adds bounded `Array.some`/`forEach` guest continuations, callback-throw cleanup, sparse `Array.fill`, and explicit refusal of async callbacks. `83e0d57` adds capability cases. These self-contained changes were integrated into [PR38](https://github.com/werg/tracing-js-self/pull/38) with attribution before the later full main reconciliation; the original branch was left untouched.

PR37 also supplied overlapping campaign/release selection changes, exploratory holdout tooling, exact JavaScript track-API binding, and separate 32-update and partial-epoch optimization/failure receipts. Their producing revisions and evidence remain distinct. The subsequent merge preserves those additions together with PR38's hardened campaign store, isolated reference runner, release verifier and learning experiment. PR37 and PR38 are now merged. Their original branches were not overwritten. Fresh native/source checks and exact hosted results are recorded in the [final handover](RESUMPTION_HANDOVER_2026-11-18.md), separately from the original historical branch audit.

## Later active work and evidence follow-up

After PR37 merged, its original `codex/resumption-20261118` branch continued in
[PR39](https://github.com/werg/tracing-js-self/pull/39). The read-only GitHub
snapshot on 18 November initially observed head
`54d3e68a6f3a3c71cd29fe98805e05d0dd64fccb`, recorded base `2aa694b`,
open/draft/unmerged and mergeable false at 14:28:41 UTC. A later snapshot
records head `a994f90eb7559e154421a25f381e94065d54c5c9`, open/unmerged,
`draft: false` and `mergeable: false`, with metadata updated at 14:41:25 UTC. Its description reports further qualification
and separate experiment/corpus evidence still being assembled. This is active
independent work, not a stale branch, and its additional code/results have not
been silently incorporated into the qualified `1e2e6a0` tree. Recheck its exact
head, content and completed qualification before any later integration; do not
overwrite or wholesale merge the ongoing branch as part of this historical
cleanup audit.

[PR40](https://github.com/werg/tracing-js-self/pull/40) is the separate final
handover/evidence follow-up to merged PR38. It receives main `0c30778`, all
published repair/learning receipts and the retained original failed CI producer.
Its runtime and consumer implementation matches merged main; the follow-up
also adds an archive-preservation workflow for an original CI artifact larger
than the download connector limit. This branch preserves evidence and current
status without treating the separate PR39
as already merged. PR descriptions and review readiness are maintained by the
coordinating owner.

The companion [Megatoken PR31](https://github.com/werg/megatoken/pull/31)
was merged by the user at 14:31:06 UTC on 18 November, with merge commit
`9bf32c3fc794c532444d6a84629bfa29599eb49c`. The native qualification remains
bound to its exact pre-merge head `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`.
This is a separately observed repository event, not a relabeling of earlier
experiments or a merge performed during this read-only branch audit.

## Issue13, actual CI failures, and repository rules

[Issue13](https://github.com/werg/tracing-js-self/issues/13) is an **open issue, not a PR**. It asks for a reproducible oracle dependency lock and passing oracle/selected-Test262 CI. Public main already contains `tools/spec-oracle/package.json`, its SHA-512 integrity lock, and `npm ci --prefix tools/spec-oracle --ignore-scripts --no-audit --no-fund` in the oracle workflow. The isolated lock includes the installed engine; its optional WebSocket peer is not installed.

The 18 November CI investigation found an actual remaining selected-Test262 failure: the CLI still read the obsolete root `node_modules/@engine262/engine262/package.json`. PR38 commit `9f415a02a4f3c44bd9701886e8f0285039bd8df9` switches it to `specOraclePackage()`, which checks the isolated package against both locks. The actual command then reported 11 selected, nine executed, four passed, five known failures, two explicit skips, and zero unexpected results. Node 20 CI separately exposed lazy native Error-stack materialization while merely reading a descriptor; commits `b0bcaca63cb6353f9949056093a9aadb804a2417` and test correction `fe3ee051179110a3ca9a334904576e53f8d76b19` avoid that operation. The declared/implicit exception tests pass 7/7 on the exact CI Node 20.20.2 and Node 24. Those local checks are independent of the hosted results recorded in the final handover. The selected-Test262 fix reached main through PR38, and the intended spec workflow for head `1e2e6a0` passed. Issue13 is ready for maintainer closure; this triage does not close it or change PR review state.

Read-only GitHub REST inspection by the coordinating agent on 18 November, during the audit of main at `dac57b163f277085f1ee42f5d1fa0085eeecb556`, returned `protected: false` for `branches/main`, `protection.enabled: false`, required-status-check enforcement `off` with empty contexts/checks, and an empty `rulesets?includes_parents=true` list. Thus this observation covers both branch metadata and inherited repository rulesets. No branch protection, ruleset, PR state, branch, or repository setting was changed by this triage. The intended gates should be reviewed and configured separately if the maintainer wants enforced merge protection.

## Reproducing the distinctions

Fetch current refs, record the new main/tip SHAs, and repeat these commands before any later cleanup:

```sh
git merge-base --is-ancestor "$branch" "$main"
git rev-list --left-right --count "$main...$branch"
git cherry -v "$main" "$branch"
git diff "$(git merge-base "$main" "$branch")" "$branch" | git patch-id --stable
git diff "$incorporating_commit^" "$incorporating_commit" | git patch-id --stable
```

For the four content cases, also compare the exact paths and PR disposition described above. Retain historical format and corpus receipts at their original revisions; do not relabel them as current admission evidence. No tests were rerun solely for this documentation audit: the claims are history, patch identity, inspected content, current API metadata, and the separately reported CI-fix checks.
