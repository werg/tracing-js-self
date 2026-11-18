# JavaScript execution data resumption — 18 November 2026

Starting revision: `55a53c4b884b7d536cfc06220d8838d8cead9236`.

This work implements the supplied 18 November audit plan in independently
reviewable increments. The production learner contract remains semantic-execution/5,
semantic-trace/5, semantic-context/5, semantic-continuation/5, selected-harness/2.
Historical v4 receipts and integration locks are preserved.

The branch also incorporates the separately developed work merged through
[producer PR38](https://github.com/werg/tracing-js-self/pull/38) at
`0c307781fea0fa3fca58f1dec037c8653cc921e0` and
[consumer PR31](https://github.com/werg/megatoken/pull/31), whose exact consumer
pin is `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`. This reconciliation retains
both regression sets, bounded primitive String/BigInt conversion, general owned
implicit-error completions, supported descriptor updates, optional Linux
reference isolation, exclusive/shared campaign locks, source-only transfer
evaluation and the checkpoint/exposure safeguards. Final integrated
qualification passes at H `881664b98ec9d484f9f4775d0b40a3a2b1b81174`;
historical C–G evidence keeps its original pins.

The [parallel-main handover](RESUMPTION_HANDOVER_2026-11-18.md) and its learning
receipts retain a separate 64-update/five-source experiment, a three-task test
from one component and a one-task pure-output test. Those negative results are
not added to this branch's 49-update/32-source run or eight-component held-out
diagnostic. Neither experiment passed the empirical learning milestone.

## Work and evidence ledger

| Work | Scope | Status |
| --- | --- | --- |
| W01 | Current baseline, capability ledger, environment/oracle locks | Implemented; integrated H has 932 passing tests, five explicit initial served-coordinator skips (all five pass separately with the actual native runtime), eight fixture passes and 40/40 attempted native capability admissions from 49 declared probes. H Python release/evidence tests pass141 with six original-artifact skips. D benchmark recovery completed at128/128 without rewriting the original timeout. |
| W02–W04 | Array defaults, async declarations, parameter environments, descriptors | Implemented for the declared bounded profile, including authenticated parameter TDZ outcomes, initialization-only forward closure capture and async-helper replay. Main's legal ordinary descriptor updates are preserved; unsupported combinations explicitly refuse. |
| W05 | Immutable identity, provenance, split and admission policy | Implemented; actual C preparation rejects all 30 metadata mutations and accepts both controls. |
| W06 | Guest throws, failure categories and callback checks | Primitive, declared Error/TypeError and authenticated implicit owned guest-error outcomes are implemented; unsupported callback obligations and broader Error behavior remain explicit refusals. |
| W07–W08 | Real-source bridge, family/clone isolation, frozen holdouts | Implemented; one global 508-variant/199-family/135-component registry. Full D real-source measurement: 987/1,171 admitted across 89 declared families/32 components; exact native equivalence permits 965 public representatives. E freshly admits all 12 capture-fix cases; F admits all 60 targeted capture/Number cases and retains its two original timeouts. |
| W09 | Broader current-v5 native qualification and durable evidence | Implemented in CI and packaging. C and D engineering/training/benchmark passed 25/50/128; D generated passed 64/64. D real-source preparation re-admits all 965 representatives, retains 541 native examples and records 424 duplicates. The verified capped native release has 211 examples (132/27/52), all evaluation rows and a largest training-component share of 7.1745%; its archive and the full census are saved. F's 52 public representatives prepare into 22 examples and 30 duplicates. |
| W10 | Actual optimizer smoke | Executed full 49-update pass over 32 examples/29 families/9,379 targets. Masks, updates and reload identities pass; trained held-in execution is 0/4, so the acceptance criterion remains unmet. |
| W11 | Held-out learning comparison | Strict comparator implemented; actual one-seed diagnostic has 0/8 baseline and 0/8 trained success. No positive or confirmatory transfer result established. |
| W12 | Resumable campaigns and measured generation costs | Implemented CAS, recovery, receipt reuse, exclusive/shared OS locks, explicit pinned historical readers, process bounds and cost reports. Optional Linux reference isolation actually passes H confinement and source-policy tests on this host; the prior bwrap failure is historical. Default trusted-source scope and absent aggregate process-tree quotas remain explicit limits. |
| W13 | Further language features selected by measured evidence | Added dense some/forEach, sparse fill and bounded primitive Number/String/BigInt conversion; repaired canonical bindings and native graph/capture validators. Exact unsafe canonical inputs refuse before lossy conversion; broader language coverage remains measured scope work. |
| W14 | Release/documentation/source-license maintenance | Current navigation, locked CI and complete private packaging implemented. All twelve verified archives, delivered in nineteen binary files, and the private download index are saved; the consolidated handover and supplemental inventory preserve all remaining limitations. Hosted CI retains its exact revision-specific status. |

The [handover](RESUMPTION_HANDOVER.md) distinguishes implemented code, measured
acceptance, supported-profile limitations, and work requiring assets or an
external runner. It is the detailed release ledger. Historical receipts keep
their original revisions and failure dispositions.

## Evidence rules

- Acquisition, local verification, native admission and learned accuracy are
  separate stages with separate denominators.
- Intentional guest throws are outcomes; unsupported programs, budgets,
  interpreter errors and failed oracle processes are separate dispositions.
- Public learner records must not contain private identity payloads, future
  observations or teacher corrections.
- No optimizer, native-admission, browser or generalization success is claimed
  without a corresponding executed check and retained evidence.
- Every implementation increment is committed and pushed promptly. An end-of-run
  handover records exact checks, unresolved work, blockers and reproduction steps.
