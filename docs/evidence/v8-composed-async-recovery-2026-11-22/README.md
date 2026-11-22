# Composed source, module and recovery verification

This local integration combines the published producer recovery source `656661f`, frozen shared generator and nested async source `f7d0b07a` / `493fdaad` (hosted executable pair `fa8eeee2/fe563c1`), and the strengthened edition audit. It uses exact independently published native composition `db624cc7ff0781868470e815e9d0f1dade8f0ab0`.

- **208 focused continuation controls passed, zero failures/errors/skips**, including current-history recovery, original modules, exact source ownership and actual native lifecycle comparison. The six original module sources retain all64 owned transitions.
- A separate **67 generator/Promise/nested-async controls passed, zero failures/errors/skips**. Six generator source cases replay all189 contexts, and ten nested async source cases replay all231 contexts in actual Python.
- Canonical contract generation passed in check mode. Both copies have digest `f92c2b99bcd373eadaadf2fa425af6b866c4312a18c6ff62b74743c40ab19f3c`. The existing six interoperability payloads retain digest `f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`.
- The companion separately passed140 native cases plus119 pytest subtests with zero failures/errors/skips, joining its async/controller and exact-commit recovery suites. Its complete raw report is retained in the companion repository.
- Edition audit controls passed5 cases with zero skips; the complete hosted frozen-catalog evidence is retained separately.

The first expanded208-case focused run had one failed assertion expecting the previous error wording for a missing history dependency. That report is retained. The corrected test now requires the explicit latest-history contract and also rejects a backend offering only historical prefix reads. The complete rerun passed. No test was removed and no native check was converted into a skip.

Raw JUnit reports and bounded source/native context summaries are retained here. Source/event populations, repeated regression suites and pytest subtests are separate measures; do not sum them into one coverage count. Evaluated-module and training admission remain false for the new source-composition experiments, and optimizer updates remain zero. The later staging-performance optimization and707-context module-ledger probe are not part of this frozen composition.
