# Merge and release gates

This document defines the review gate set for the current semantic v5 producer.
It describes the checks maintainers should require and the evidence needed for
a release. Workflow files remain the executable declarations; a workflow's
existence does not establish that its latest run passed.

The [workflow inventory](evidence/release-workflows-2026-11-18.json) records all
13 workflows and their exact file hashes at producer commit
`8a41f1a739fb78bc0383d1a01309d81ea83a97b9`. The separate
[repository snapshot](evidence/repository-maintenance-snapshot-2026-11-18.json)
records the observation time and remote main head
`2aa694be86a6cda3b9d63fde739957d08f568961`. These are different revisions: work
present on an implementation branch is not implicitly merged or qualified.

At that observation, GitHub reported `main.protected: false`, no required status
checks, and an empty repository/inherited ruleset collection. The gate set below
is therefore a documented review policy, not a claim of automatic enforcement.
This maintenance work changes no branch protection, ruleset, issue, or remote
branch. Before merging or releasing, inspect actual check results at the exact
intended commit and retain their links or logs. A cancelled, skipped, missing,
or stale run does not supply a passing result for work that needs the gate.

## Merge review

### Core checks for every change

Require all applicable matrix members in these pull-request workflows:

| Workflow and job | Required evidence | Scope of a pass |
| --- | --- | --- |
| [ci.yml](../.github/workflows/ci.yml), `test` on Node 20, 22, and 24 | Locked installation, `npm test`, semantic fixture inspection, demo and deterministic replay | Repository regression tests on the supported Node matrix; skipped external tests remain untested |
| [spec-baseline.yml](../.github/workflows/spec-baseline.yml), `spec-reference` | Exact upstream ownership audit; isolated `npm ci` oracle; independent scalar/arithmetic probes; pinned syntax, scalar-runtime and selected Test262 reports | Only the declared oracle probes and Test262 populations, with their own denominators and explicit unsupported/omitted variants |
| [semantic-reasoning.yml](../.github/workflows/semantic-reasoning.yml), `semantic-inspection` | Source grounding, projection/context tests, and generated readable examples | Source-certified semantic trace and context checks; no model learning claim |
| [selected-harness-v4.yml](../.github/workflows/selected-harness-v4.yml), `selected-harness` | Contracts, selected invocation/model/callback/adapters, and actual Chromium DOM/events/CSP/cleanup tests | Current v5 selected runtime and the tested browser path; the historical filename does not imply a second production format |
| [megatoken-consumer.yml](../.github/workflows/megatoken-consumer.yml), `independent-native-import` for engineering, training-v4, and benchmark-v1 | Exact companion/tokenizer/dependency identities, complete source/native admission, preparation, and release-package verification | Actual admitted rows for those recipes under those pins; the engineering controlled evaluation tests orchestration and cannot measure learned execution |

The native workflow's recipe names `training-v4` and `benchmark-v1` identify
historical fixture collections. Their current outputs use semantic-execution/5,
semantic-trace/5, semantic-context/5, semantic-continuation/5, and
selected-harness/2. Keep historical receipts and locks unchanged.

For changes to Python comparison, optimization, or release tools, also run their
focused tests in the pinned native environment. These tests are not all covered
by `npm test` or by the native workflow's `tools/native-consumer` discovery:

```sh
"$NATIVE_PYTHON" -m pytest -q \
  test/test_learning_comparison.py \
  test/test_learning_artifacts.py \
  test/test_optimization_smoke_selection.py \
  tools/native-consumer/test_release_bundle.py
```

Use the corresponding companion source path in `PYTHONPATH` and the locked
tokenizer/environment required by the tests. Synthetic comparison and optimizer
fixtures validate implementation; they do not create semantic learning results.
Run affected focused tests as well when newer modules add their own coverage.

### Source and corpus checks when their inputs change

Path filters can omit a job even when a shared runtime change affects its
behavior. Review the dependencies, then run the relevant workflow or equivalent
commands at the intended head. Push-only and manual jobs cannot be presumed to
have run on a pull request.

| Workflow | Trigger and required use | Evidence boundary |
| --- | --- | --- |
| [real-corpus.yml](../.github/workflows/real-corpus.yml) | Path-filtered push/PR/manual; utility extraction, source transforms, owned runtime, or utility input changes | V8 observations, partitioned owned checks and complete refusal accounting; no automatic native admission |
| [owned-exercism.yml](../.github/workflows/owned-exercism.yml) | Path-filtered push/PR/manual; canonical bindings, solution pins or lowering changes | Original/lowered/owned comparisons, denominators and local evidence; fresh bridge/native qualification is separate |
| [production-owned.yml](../.github/workflows/production-owned.yml) | Path-filtered push/manual; production helper extraction and source-span changes | Pinned helper execution and independent V8 comparison, explicitly non-admitted |
| [stateful-corpus.yml](../.github/workflows/stateful-corpus.yml) | Path-filtered push/PR/manual; stateful source, command models, observation or differential verifier changes | Stateful observable agreement and adversarial diagnostics, with their own scenario counts |
| [external-corpus.yml](../.github/workflows/external-corpus.yml) | Path-filtered push/PR/manual; importer, upstream snapshot or disposition changes | Acquisition/static mining and separately labeled local/native diagnostics; acquiring a fixture does not produce a training trace |
| [production-validator.yml](../.github/workflows/production-validator.yml) | Path-filtered push/manual; validator/schema changes | Pinned Ajv execution in the declared restricted container; no owned interpreter or native training admission claim |
| [real-source-quality.yml](../.github/workflows/real-source-quality.yml) | Push/manual; include when publishing current real-source readability/quality evidence | V8 diagnostic observations and trace-quality measurements |
| [test262-native-full.yml](../.github/workflows/test262-native-full.yml) | Manual; require a fresh complete sweep only when publishing that specific native-reference coverage claim | Sharded native reference and acquisition accounting; neither full owned conformance nor admitted corpus evidence |

The full native Test262 workflow has its own restricted Docker invocation.
That does not make the ordinary generation worker an OS sandbox for arbitrary
programs. Its trusted-source restriction, V8 heap bound, wall timeout and output
bound remain as documented in [RESUMABLE_CORPUS.md](RESUMABLE_CORPUS.md).

## Data release acceptance

A release must declare its exact producer, consumer, tokenizer, source inventory,
transforms, split policy, contracts and environment. Start from an unchanged
committed producer checkout and the exact clean companion checkout required by
`contracts/native-admission-policy-v5.json`. Verify the runtime import path and
dependency identities with `tools/native-consumer/check_environment.py`; a
version string alone does not bind an installed environment.

Use the [resumable collection and packaging runbook](RESUMABLE_CORPUS.md). The
release review requires all of the following evidence:

1. **A frozen source registry before selection.** Preserve upstream pins,
   original/transformed bytes and notices, family/ancestor components, and
   train/validation/test membership. Repeated wrappers or inputs do not create
   independent source families.
2. **Every attempted disposition.** Retain successful rows, refusals, resource
   failures, source mismatches and private forensic objects. Report both the
   complete campaign denominator and any selected subset. A failed candidate
   cannot become a target by removing its refusal or changing its expected value.
3. **Fresh qualification for every admitted row.** Require independent source
   agreement, owned journal/replay, public replay, and pinned native tokenizer,
   action, loss-mask, visibility, transport and identity checks. Accepted local
   evidence and controlled fixtures cannot substitute for native receipts.
4. **Exact evidence boundaries across revisions.** A producer or consumer repair
   requires new qualification. A targeted `--case-ids` campaign qualifies only
   its selected rows under its new pins; it does not rewrite an older campaign
   or requalify that older campaign's unselected rows. Preserve D and E receipts
   separately when their producer/consumer identities differ.
5. **A complete verified private package.** `tools/package-semantic-release.py`
   must recheck source/native preparation and preserve admitted records,
   original campaign/CAS evidence, refusals, source notices, file hashes and
   release identity. Verify the resulting archive and retain it with its exact
   producing checkout or a durable checkout reference. A selected view must
   retain the required original audit campaign.
6. **Current execution claims at the release revision.** Rerun relevant core
   gates, including the actual browser gate when browser support is in scope.
   Keep capability totals and unsupported/untested counts tied to their exact
   measured producer and profiles. Do not silently promote old feature-level
   receipts merely because a later subset passes.

The engineering native job also runs the Python release/alias/learning-evidence
regressions and retains their JUnit report. Tests requiring the actual optional
diagnostic artifact bundle remain explicitly skipped when that bundle is absent.

The companion CI uploads complete native corpus/prepared/release artifacts for
90 days. Some historical utility workflows retain artifacts for only 14 days.
CI retention is finite; a release is not durably delivered merely because an
artifact upload succeeded. Preserve the complete release archive and manifest
outside expiring CI storage and record the durable location and checksums in
the handover. Do not replace missing artifacts with a summary that suggests the
full private evidence is still available.

Current release packages declare `distribution: private-audit-only` and
`publicRedistributionApproved: false`. Preserve exact upstream notices.
`repository-fixture` describes provenance and is not an SPDX license. A public
corpus publication needs an explicit owner distribution decision; this gate
document does not grant one.

## Model and learning claims

Data admission and controlled engineering evaluation are separate from model
performance. Use [OPTIMIZATION_SMOKE.md](OPTIMIZATION_SMOKE.md) for the actual
diagnostic optimizer/checkpoint/mask/rollout requirements. A completed run whose
model fails its first record is an unsuccessful execution result, even when
parameters changed and checkpoints reload correctly.

Use [EXPLORATORY_HELDOUT_DIAGNOSTIC.md](EXPLORATORY_HELDOUT_DIAGNOSTIC.md) for the
bounded diagnostic cohort and [LEARNING_COMPARISON.md](LEARNING_COMPARISON.md)
for a qualified production comparison. A confirmatory gain requires the frozen
cohort/design, actual base/trained artifact and prepared-data bindings, qualified
native launches, completed positive optimizer budgets, the planned seeds,
component-aware paired uncertainty, the predeclared practical threshold, and
declared effect/error/cleanup regression checks. Keep failed original model
bytes, costs, hard-gate failures and missing measurement coverage visible.

The one production trace format remains unchanged. Diagnostic success, passing
synthetic comparison tests, teacher-forced loss or compact storage cannot be
relabeled as held-out learning improvement.

## Superseded CI runs

The Exercism and external-acquisition workflows now cancel superseded runs for
one event/ref pair, matching the existing latest-revision behavior of core CI.
This prevents a sequence of incremental pull-request pushes from indefinitely
queueing redundant expensive checks. The event name separates explicit manual
sweeps from pull-request and main-push runs; different branches/PRs do not share
a group. The newest run still executes every declared gate. Cancellation is
reported as cancellation, never as a passing check.

Runs created before this policy were not assigned those concurrency groups and
can remain queued or running. This change does not retroactively claim to have
cancelled them. At the recorded browser check the browser was signed out, and
the connected API did not expose workflow cancellation, so no manual queue
mutation was performed.

## Maintenance follow-through

Issue [#13](https://github.com/werg/tracing-js-self/issues/13) was still open in
the recorded remote snapshot. The isolated oracle manifest/lock and
`npm ci --prefix tools/spec-oracle` are present on the recorded main revision.
Issue state is therefore separate from implementation state; verify the issue's
exact acceptance checks and retained CI evidence before a maintainer changes it.

Stale branches must be reviewed against a recorded main commit using ancestry,
stable patch IDs and current content. Squashed or selectively salvaged changes
can lack matching commit or patch IDs. An unmatched patch is a review candidate,
not proof of a missing feature. Preserve exact heads and review notes before any
future cleanup. This task performs read-only triage and does not delete branches.
