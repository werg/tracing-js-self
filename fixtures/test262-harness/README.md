# Original pinned Test262 harness

These 43 JavaScript harness files and `features.yml` are copied byte for byte from
the `harness/` tree of `tc39/test262` commit
`d53ebc8b1931d9f1541e43d59650776e4b766248`. `snapshot.lock.json` records the Git
blob SHA and SHA-256 of every retained upstream file. The upstream BSD license is
retained in `LICENSE`.

The owned runner evaluates original `assert.js`, then original `sta.js`, then the
required async harness and named includes in metadata order, as separate global
scripts in a fresh owned environment. Raw tests omit these files. Unsupported
harness or test syntax remains an explicit unsupported result; these sources are
never replaced with weaker assertions to obtain a passing result.

Retaining a harness does not imply that its complete language or host surface is
implemented. Runner qualification tests verify byte pins, real passing and
failing assertions, isolation, strict and raw routing, and explicit refusal of
missing capabilities. Full Test262 and edition conformance remain separate gates.
