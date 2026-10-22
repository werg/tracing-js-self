# Executed Test262 scalar slice

This profile executes selected official Test262 bodies in the owned interpreter,
with an explicit small guest harness. It is separate from the existing
[syntax-only baseline](ENGINE262_ADOPTION.md), and it is **not** the complete
Test262 execution harness or full language conformance.

```sh
node scripts/run-runtime-conformance.mjs --output /tmp/test262-runtime.json
# With the separately installed, pinned engine262 reference package:
node scripts/run-runtime-conformance.mjs --oracle --output /tmp/test262-runtime.json
# Offline, from a Test262 checkout or exact-file mirror:
node scripts/run-runtime-conformance.mjs --suite-root /path/to/test262
```

The suite commit and each file's Git blob hash are pinned in
`coverage/test262-runtime.lock.json`. The runner verifies the complete file bytes
before interpreting them. It prepends the declared harness without editing the
official body. No guest source runs through Node `eval`, `vm`, or `Function`.

## Scope and denominator

The initial slice has **8 files**, with **6 passing non-strict script variants**,
**16 executed assertions**, and **2 explicitly unsupported variants**. The 8
corresponding strict variants are reported as omitted, not passed. The accepted
files exercise BigInt-to-string addition, zero-to-zero BigInt exponentiation,
large negative Number exponents, and multiplication/division/remainder across
line terminators. Two nearby tests retain visible gaps for update expressions
and exception assertion callbacks.

The harness implements `assert.sameValue` and `assert.notSameValue` for scalars
without Symbol. Its functions, assertion counter, branches, calls and failure
throws all execute inside the guest machine. Focused negative controls verify
that false assertions fail, including NaN and signed-zero distinctions. Every
passing file has an exact expected assertion count, so parsing or skipping the
assertions cannot qualify as success.

Each file gets a fresh runtime. Every sealed run is structurally reconstructed
and deterministically replayed without host adapters. With `--oracle`, every
passing script also executes independently in the pinned engine262 realm and
must complete with the same assertion count. This comparison does not make
engine262 a trace producer.

Metadata handling is intentionally restrictive: positive scripts with no flags
or `noStrict`, and only the declared `BigInt`/`exponentiation` feature labels.
Includes, runtime/parse negatives, modules, async, raw scripts, strict-only tests,
unknown features and unsupported metadata formats are rejected explicitly.
Unsupported syntax is checked across the entire body before the harness runs.

The scalar harness is a documented implementation of a limited assertion
contract; it does **not** execute official `assert.js`/`sta.js`. Proper strict
execution, complete default harness installation, includes, negative-phase
semantics, asynchronous completion, module realms and broader coverage remain
release blockers. A matching baseline checks this selected slice, never a
percentage of the full Test262 suite.
