# JavaScript execution data resumption — 18 November 2026

Starting revision: `55a53c4b884b7d536cfc06220d8838d8cead9236`.

This work implements the supplied 18 November audit plan in independently
reviewable increments. The production learner contract remains semantic-execution/5,
semantic-trace/5, semantic-context/5, semantic-continuation/5, selected-harness/2.
Historical v4 receipts and integration locks are preserved.

## Work and evidence ledger

| Work | Scope | Status |
| --- | --- | --- |
| W01 | Current baseline, capability ledger, environment/oracle locks | Implemented; D has 837 passing tests, five explicit skips, and 31/31 attempted native capability probes. Its timed-out benchmark check is being recovered separately. |
| W02–W04 | Array defaults, async declarations, parameter environments, descriptors | Implemented for the declared bounded profile; unsupported descriptor combinations explicitly refuse. |
| W05 | Immutable identity, provenance, split and admission policy | Implemented; actual C preparation rejects all 30 metadata mutations and accepts both controls. |
| W06 | Guest throws, failure categories and callback checks | Primitive and declared Error/TypeError outcomes implemented; unsupported callback obligations and broader Error behavior remain explicit refusals. |
| W07–W08 | Real-source bridge, family/clone isolation, frozen holdouts | Implemented; one global 508-variant/199-family/135-component registry. Full D real-source measurement is finishing; E freshly admits all 12 capture-fix cases. |
| W09 | Broader current-v5 native qualification and durable evidence | Implemented in CI and packaging; C engineering/training/benchmark passed 25/50/128. D generated passed 64/64. Final D bundles are being assembled. |
| W10 | Actual optimizer smoke | Executed full 49-update pass over 32 examples/29 families/9,379 targets. Masks, updates and reload identities pass; trained held-in execution is 0/4, so the acceptance criterion remains unmet. |
| W11 | Held-out learning comparison | Strict comparator implemented; actual one-seed diagnostic has 0/8 baseline and 0/8 trained success. No positive or confirmatory transfer result established. |
| W12 | Resumable campaigns and measured generation costs | Implemented CAS, recovery, receipt reuse, process bounds and cost reports. Hard process-tree quotas and untrusted-source OS isolation remain external runner work. |
| W13 | Further language features selected by measured evidence | Added dense some/forEach and sparse fill, repaired canonical bindings and native graph/capture validators; broader language coverage remains measured scope work. |
| W14 | Release/documentation/source-license maintenance | Current navigation, locked CI and complete private packaging implemented; final durable artifact index and handover are being completed. |

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
