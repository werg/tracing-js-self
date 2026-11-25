# Tinker follow-up implementation plan

This work covers the entire follow-up slate requested after the initial training
bridge, not only the short list of next changes. Local verification is separate
from live model evidence. No CPU replay or scripted model is a learning result.

## Scope and acceptance

| Area | Deliverable and acceptance criterion |
| --- | --- |
| Reward control | Separate correctness and successful-length signals; compression coefficient remains effective after normalization; analytical tests for failures, ties, caps, mixed and all-correct groups. |
| Optimizer controls | Distinct SFT/RL learning rates; example/token SFT weighting; explicit IS/PPO settings; optional fixed-SFT-reference KL with original token alignment and separate drift diagnostics. |
| Evaluation | Full or explicit frozen selections; protected validation/test roles; deterministic family-cluster intervals; validation checkpoint selection and accuracy gates; comparable seeds and complete failure costs. |
| Corpus | Diverse authored and generated programs with variants; lineage grouped before splitting; separate familiar-program input diagnostics, unseen families and harder-composition challenges; exact manifests and honest independent-family counts. |
| Adversarial grader | Observable negative controls and narration-positive controls; bounded seeded differential fuzzing; reproducible/minimized disagreements; an independently implemented native boundary recorder for a declared subset. |
| Causal privacy | Prefix invariance until observation divergence; no future sentinel/expected answer/corrected student history in prompts; actual renderer observation-loss checks. |
| Supervision | Full, compact and actions-only targets; contemporaneous causal narration; replay and stratified audit; removed steps absent from inputs. |
| Curriculum | Feature/tier metadata; easier-to-harder training with retention; useful-group and zero-signal diagnostics. |
| Baselines and ablations | Validation-only effort/prompt sweep, staged learning-rate and trace-format comparisons, SFT/correctness-RL/compression-RL controls, repeat seeds and sealed final evaluation. |
| Learnability | Prepared small overfit dataset and executable live contract/one-update diagnostic, retaining exact sampled tokens and log probabilities; absent credentials reported as a live prerequisite. |
| Reporting | Complete accuracy by family/feature, failure taxonomy, all tokens including failures, tokens per success, tails, paired cost and family uncertainty; exact token-category accounting where recoverable. |
| Workload coverage | Reproducible admission census over existing programs/trajectories with full candidate denominator and refusal reasons; execution coverage kept distinct from agent objective success. |
| Reproducibility | Locked runtime/dependencies, deterministic plans and hashes, resumable results, regression gates, launch instructions and honest validation record. |

## Implementation boundaries

The existing bounded sequential execution profile remains the initial model task.
The census determines which subsequent execution-profile expansions are useful;
it does not relabel unsupported candidates as successful executions. Original
agent-task success requires its own ground truth, beyond an attached executor.

Generated and imported programs retain template/source ancestry before any split.
Renaming identifiers or changing literals cannot create new independent families.
Repeated variants improve semantic coverage but do not increase the reported
number of independent evaluation units.

## Validation order

1. Focused analytical and codec/broker negative controls.
2. Real Node worker integration and actual pinned Inkling rendering without compute.
3. Expanded corpus replay, supervision audit, seeded fuzzing and workload census.
4. Experiment plan and report/resume checks with clearly labeled fixtures.
5. Authenticated capability preflight; live contract/learnability and validation
   experiments only when account access is available.
6. Sealed test evaluation after validation choices have been recorded.

The implementation status and exact observed counts are recorded in
`TINKER_VALIDATION.md` after integration. Example thresholds in experiment plans
are acceptance criteria, not claims that any model has already met them.
