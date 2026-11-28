# Agent guidelines

## Pre-release development

This repository and its paired consumer, `werg/megatoken`, are pre-release.
Nobody depends on compatibility with the current implementation or saved formats.

- Make the smallest direct change that solves the problem. Change APIs, formats,
  schemas, and implementations in place when that is the quickest sensible path.
- Do not require version bumps, migrations, compatibility shims, deprecation
  periods, or a format-release process. Existing version labels may stay in place
  while their definitions evolve. Do not make versioning a blocker for a PR.
- Update affected producers, consumers, tests, fixtures, and examples together.
  Regenerate affected artifacts when necessary; do not preserve an obsolete
  format merely to keep old generated data working.
- Keep correctness checks and honest evidence. Historical results describe their
  recorded code and inputs; they are not proof that a later change works.
- Save authorized work in small commits and push completed increments promptly.

These instructions supersede older repository guidance that requires version
bumps or compatibility work during this pre-release period.

## Continuous data & training discipline

- **Always keep thinking ahead on data**: while remote RL/training runs execute on Tinker, continuously analyze the latest validation and `RealExecBench` bottlenecks and collect targeted, non-bloated new data (especially real-world OSS multi-file repos and messy stateful I/O) on local CPUs to feed the next stage.
- **Fault tolerance & no wasted recomputation**: never let batch pipelines die on a single task failure; skip and log individual errors cleanly, preserve already-collected trajectories, and auto-prune superseded remote recovery checkpoints.
- **Timers**: always set scheduled check-in timers to **at most 45 minutes** (`<= 2700s`) for prompt-cache reasons.

