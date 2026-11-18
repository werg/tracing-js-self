# Current v5 release gates

The release unit is a declared profile and a pinned source/input collection.
Every receipt names its actual producer commit, consumer commit, tokenizer,
environment and source registry. Historical v4 receipts retain their original
identity and do not qualify current artifacts.

## Required evidence

| Gate | Command or workflow | Interpretation |
| --- | --- | --- |
| Producer tests and exact replay | `npm test` | Record passed, failed and skipped counts. External orchestration skips require their separate native job. |
| Contract bytes | `npm run contracts:check` | Both generated contracts match committed bytes and the pinned consumer copies. |
| Source-grounded trace inspection | `node tools/inspect-semantic-reasoning.mjs` | Actual generated examples pass independent source checks. |
| Current capability ladder | `npm run coverage:current -- --out PATH` | Publish stage-specific denominators; untested remains untested. |
| Independent spec oracle | `.github/workflows/spec-baseline.yml` | Integrity-locked engine262 plus narrowly declared Test262 variants. Native diagnostics and inventories have separate denominators. |
| All authored native recipes | `.github/workflows/megatoken-consumer.yml` | Engineering, training-v4 and benchmark-v1 pass fresh producer, consumer, tokenizer, visibility, loss and provenance checks. |
| Browser adapter, when included | `npm run test:browser` | Execute real Chromium at the release revision; retain failure if the host cannot launch it. |
| Complete dataset release | `tools/package-semantic-release.py` | Recheck actual admitted rows; retain all refusals, private evidence, source notices, prepared data, lock hashes and archive inventory. |
| Model learning claim | Frozen base-versus-trained evaluation | Real optimization, exact checkpoint identity, uninjected model bytes and whole-task results; infrastructure success alone is insufficient. |

## Reproducibility and distribution

Use `.nvmrc`, `profiles/release-environment.lock.json`,
`tools/spec-oracle/package-lock.json`,
`tools/native-consumer/requirements.lock` and
`contracts/native-admission-policy-v5.json`. The native environment checker
compares actual installed versions and rejects a dirty or misrouted consumer.
Keep a clean producer checkout at the corpus's recorded commit for rechecking.

Freeze connected source and ancestor components before expanding inputs or
schedules. Reserve upstream-project and compositional holdouts in that registry.
Do not relabel held-out families to fill a training quota.

A release archive includes every candidate disposition and its original source
and notice evidence. `repository-fixture` is an origin marker, not a license
grant. The repository has no blanket data-redistribution license; a public data
release needs a source-by-source distribution decision. Code changes and
private verification do not imply that such a decision has been made.

CI artifacts expire even with 90-day retention. Copy complete checksummed
archives and their manifest/receipt to an explicitly chosen durable destination
before treating a dataset as a published release. A successful CI upload alone
is an engineering receipt, not permanent dataset hosting.

This document defines the intended checks. Repository branch rules are an
administrative setting and must be inspected separately; the presence of this
file does not claim those checks are enforced by branch protection.
