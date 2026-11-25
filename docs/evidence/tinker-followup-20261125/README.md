# Tinker follow-up evidence — 2026-11-25

These are local preparation and implementation receipts from tick. They contain
no model-accuracy result or trained checkpoint. The capability preflight was
blocked by absent Tinker authentication. See [the validation record](../../TINKER_VALIDATION.md)
and [experiment guide](../../TINKER_EXPERIMENTS.md) for interpretation and launch commands.

| File | Evidence |
| --- | --- |
| `verifier-report.json` | Definitive 10,000-case independent/adversarial gate, control counts and code identity |
| `verifier-run.json`, `verifier-append-receipt.json` | Exact seed/count/runtime binding and hash of the sealed raw record stream |
| `census-report.json` | Complete 466-candidate admission denominator, coverage and refusal categories |
| `supervision-audit-summary.json` | 105 replayed conversations, per-format data sizes, causal checks and digest of the full audit |
| `manual-supervision-review.json` | Spot checks of actual expanded-corpus compact conversations |
| `local-checks.json` | Test, installation, CLI and contract-log digests with their observed outcomes |
| `auth-preflight.json`, `auth-preflight-final.json` | Initial and final capability checks; generic authentication results, zero model samples or updates |
| `mini-preflight.json` | Complete 36-case starter fixture/renderer check |
| `pilot-plan.json`, `pilot-preparation.json`, `pilot-preflight.json` | Frozen staged study, exact data/split identities, diagnostic datasets and complete local pilot preflight |
| `runtime-budget-diagnosis.json` | The original 60-second export timeout, successful isolated export, CPU profile binding and justified 300-second pilot request limit |
| `index.json` | Content hashes and sizes of every archived evidence file |

The full raw fuzz records, full teacher audit, source inputs and exported datasets
remain under the named `runs/` paths on tick; their digests are recorded here.
The committed corpus is in `training/fixtures/expanded/`. Large raw records are
reproducible with the recorded implementation, seed and commands.

`pilot-plan.json` is an audit copy of `runs/tinker-study/plan.json` and contains
absolute tick paths. Launch the original plan on tick. For another checkout,
create a new plan using the experiment guide so its paths and identities bind to
that checkout.

The two implementation hashes have different scopes: the verifier binds the
JavaScript/tool/package tree; the training runner binds its runtime, Python and
locked dependencies. Capture revisions identify repository history and do not
replace enforced content hashes. Tests using scripted responses are explicitly
fixtures. Teacher byte reductions and successful CPU execution are not learned
model improvements.
