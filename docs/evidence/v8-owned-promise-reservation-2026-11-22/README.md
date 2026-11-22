# Exact reserved Promise jobs and independent source-boundary review

The published mechanism is producer `f9d3363a24b3e3bee7f7be2f8db1d12acb0672d5` / native `a8b2a78350ecc6971fa1b3f2397aeaf8266ff8bd`. The corresponding local implementation commits are `7cdecaaa7e925b723cffb2fccb295a38059e43eb` / `da817b269500d56da9983f22f58ddf1dbb48fc19`. Exact source/test bytes are mapped in `source-map.json`.

Both live subscription and restored queued state bind every reserved job field: status, owner, Promise slot, reaction, closures, target, sequence and causal resolution metadata. An extra readiness or foreign metadata field refuses. The future settlement identity remains reserved in the same job collection used by ordinary Promise work. Throwing a Promise preserves it as a rejection reason.

## Retained final focused result

The final `r3` run passed **six JavaScript cases and eleven independent Python cases**, zero failures/skips. JavaScript duration was 304.687580 ms; Python reported 0.18 s. These overlapping mechanism populations are not original-source certification, learned execution or whole-language qualification.

The implementation diffs were present before these runs and committed immediately afterward. The producer worktree also had uncommitted source-projection/contract work; the focused protocol test imports neither of those changed paths. The native worktree had only the two committed Python paths changed. The source map records committed file bytes; no pre-run whole-worktree receipt is invented.

## Earlier attempts and review observations

All six original focused log files are retained unchanged. The first JavaScript attempt had five passes and one assertion-message failure: exact-field validation already rejected the malformed job, but the test's expected error expression omitted the new label. Its accompanying Python run passed eleven cases. The second attempt passed six/eleven before the final live-subscription exact-shape precheck; the final third attempt above includes that precheck. Earlier intermediate source trees were not independently hashed before those runs, so only their observed outputs and stated development sequence are retained. Counts from repeated attempts are not added.

The independent review accepted a reserved job with an extra `readySequence` before the complete exact-shape correction. `reserved-job-extra-field-review/` retains the exact original command and tool-return stdout plus a **post-run** source snapshot. Its README explicitly states that no pre-run source hash was captured; the original result is not relabeled as execution of that later snapshot, and was not recreated by rerunning.

`proxy-then-return/` retains original JavaScript baselines and actual compiler/runtime refusals for a Proxy `then` trap and an aliased property mutation. These refused examples establish explicit unsupported boundaries, not thenable support or universal absence of bypasses. Original-source return ownership, observable ordinary then-property lookup and full source/native composition remain separate qualification work.

The preceding six/eleven mechanism checkpoint is retained in the adjacent `v8-owned-promise-protocol-2026-11-22` directory; its lost initial four/ten logs remain disclosed there.
