# Prospective real-source experiment and known-source input probes

This is a **frozen future experiment**, with zero optimizer steps and no
measured model accuracy. It does not relabel the earlier synthetic-recipe
model's exposure or reuse its checkpoint as a model trained on utility sources.

The freezer independently rechecked every one of 174 actually admitted exports
from the completed fixed native real-source campaign. Four bounded concurrent
source verifiers used the immutable producer
`5753de14760b76754fd1bd49ca7c8bfc6de85831` and native policy pinned to consumer
`6206b33a55eba3e50f80498f906439221bc289b7`. The exact complete private declaration
has SHA-256 `531b5b14d0e55935cace2c66685e47ab2e8c1237329ece86be5860444312c5f3`.
[declaration-summary.json](declaration-summary.json) records its immutable
membership and decision rules without copying private expected outcomes.

| Cohort | Available episodes / independent components | Frozen episodes / independent components |
| --- | --- | --- |
| Train | 148 / 21 | 32 / 21 |
| Validation | 8 / 2 | 8 / 2 |
| Test | 18 / 8 | 18 / 8 |
| Reserved new inputs on exact selected training sources | 4 / 4 | 4 / 4 |

The four auxiliary rows remain in the training split but are reserved from
optimization. Each matches a selected training member's actual source text,
entry, invocation topology, component, and completion policy. Its input graph
differs from every selected input for that source. The declaration includes the
matched training identity and distinct input hash. These rows are labeled
`new-inputs-known-source` and cannot enter the primary unseen-source score.

The 18 primary test cases are pure selected-execution cases. Ten have an
upstream-project holdout label; fourteen are short and four medium by declared
native learner-token thresholds. This collection supplies no effects, valid
error, cleanup, different-observation, or different-schedule test cases. Those
slice results must remain untested until actual admitted matching cohorts are
frozen. It also has only eight independent test components, not the prospective
100-component confirmatory target.

The declared run uses one exploratory optimizer seed, a newly initialized base,
validation checkpoints at steps 16 and 64, a 900-second optimizer cap, supported
32-record/16-decision native windows, and per-fragment selected inference caps.
Actual preparation must inspect its native window plan and report measured
source exposure. Source membership, successful source verification, and a
prospective step budget do not establish successful optimization or execution.

The full private declaration, including the original public model envelopes and
separate expected outcomes, is preserved with the follow-up diagnostic archive.
Use it with `run-optimization-smoke.py --experiment` and the exact matching
producer/consumer checkouts, then `run-learning-pilot.py`; the existing runner
rejects binding an older optimizer run to this new declaration after the fact.
