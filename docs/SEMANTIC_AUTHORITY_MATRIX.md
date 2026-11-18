# Intermediate execution authority

The current admission path uses `effectful-source-checks/5`. In addition to
uninstrumented V8 outcomes/effects, operation and branch references, it executes
one independent **source-completion** reference. No journal operands or expected
answers are supplied to V8. The complete receipt is bound into the existing
immutable candidate identity. Historical `/4` receipts keep their historical
meaning; they must be regenerated to obtain the new gate.

## Independently observed source boundaries

`src/training/completion-reference.js` wraps once-evaluated source expressions
and inserts catch/finally/loop-transfer markers. It checks:

- ordinary identifier declaration initializers and uninitialized lexical cells;
- successful plain identifier/property assignments, including setter completion;
- normal source call completion, including owned callback and effect continuations;
- expression-statement completion, explicit return/throw values and concise-arrow returns;
- entry into catch/finally and executed break/continue statements;
- scalar values and first-observed reference identity/alias relationships.

The reference wrapper returns the original value. It does not reevaluate a
receiver, property key, getter, coercion, function argument or assignment.
Reference-valued observations inspect only JavaScript `typeof` and identity in
a private WeakMap; they do not enumerate properties or invoke user code.
Top-level initialization belongs to the initial context and is not counted as
an entry-function execution. Compiler-generated parameter and loop housekeeping
is excluded by original source ranges.

For every reference mode, admission compares the original completion graph,
input mutations, effects, callback failures and unhandled rejections with the
owned execution. Instrumentation that changes final observable behavior fails
admission. Reserved hook collisions, unrepresentable observations, incomplete
owned continuation mappings and observation limits are verifier refusals, not
guest exception training labels. Wrapping anonymous function initializers can
change JavaScript inferred function names; cases that expose this difference
are refused by original-versus-instrumented outcome agreement. Such cases are
not an independently qualified function-name profile.

The comparison returns the first differing source range, observation kind and
value, or an absent observation. Failed comparisons retain the original source,
input, private archive and all independent observations in the existing failure
record. The failure minimizer recognizes `reference_completion_mismatch`.

## Record authorities and limits

The table describes the implemented boundary. An `agreed` receipt means the
listed checks agree; it does not certify every ECMAScript operation or every
possible intermediate heap property.

| Public record | Source/private evidence | Independent check | Remaining boundary |
| --- | --- | --- | --- |
| `bind` | Declaration/write and exact source-cell identity | Observed source initializer/plain assignment value; reference alias identity | Implicit/default parameter initialization and compiler-created cells retain owned/replay authority |
| `compute` | Source expression certificate and committed operands | Existing V8 operation observations; enclosing completion observations | Bounded operation profile; arbitrary coercion/hidden host work is not inferred |
| `choose` | Source predicate, committed inputs and selected path | Existing V8 branch observations | Synthetic guards remain private |
| `allocate` | Fresh owned identity and construction evidence | Reference identity when exposed plus final graph/type agreement | Every transient allocation field is not independently snapshotted |
| `read` | Committed property observation and source relation | Enclosing source operation/call/statement result and final graph where observable | Standalone transient property snapshots are not a general independent authority |
| `write` | Committed property transition and source assignment | Plain assignment completion; ordinary committed stored value/result consistency; writes in setter source are observed separately | Arbitrary descriptor/proxy effects remain bounded/refused by the runtime profile |
| `call` | Source call, receiver, arguments, invocation and continuation | Normal V8 call completion in source order; body boundaries; final effects | Entry receiver/arguments and unobserved implicit throws are not a general independent call-state snapshot |
| `transfer` | Owned abrupt completion and handler route | Executed throw/return, catch/finally entry and break/continue markers | Implicit thrown values never exposed to a catch/finally are covered only by final completion and existing error profile |
| `return` | Explicit source return or owned implicit completion | Explicit return value, normal caller completion, final outcome graph | Async Promise/job internals retain their existing separate authorities |
| `throw` | Source throw or declared guest fault | Explicit throw value, catch identity/control route, final declared exception graph | No new universal native Error/prototype/stack contract |
| `request` | Source call and evaluated owned arguments | Independent fixture dispatch payload/order and settlement receipts | Only declared host operations and schedules |
| `promise`, `job`, `await`, `resume` | Owned Promise/job state and lawful observations | Independent outcomes, effects, callback failures and normal source completions | Internal Promise/job transitions remain bounded owned/replay checks; no universal scheduling equivalence claim |
| `end` | Owned completion and pending-work accounting | Final outcome/effects/failure agreement and selected replay | Native consumer qualification and learned execution are separate gates |

New datasets should retain these coverage fields with the actual producer and
consumer identities. Experiments requiring independently observed transient
heap snapshots, arbitrary alias mutations, default-parameter state or richer
Promise scheduling must narrow their profile or remain diagnostic until that
authority is implemented. A native format/mask receipt does not fill those gaps.

## Teacher-level mutation campaign

```sh
node tools/audit-teacher-mutations.mjs --out /path/to/new-mutation-receipt.json
node --test test/training-completion-reference.test.js
```

The campaign temporarily changes the executing runtime implementation in its
own serial process. It corrupts initializer storage while preserving the
reported initialization result, an overwritten lexical value, an overwritten
property value and an overwritten helper return; it restores the original
getter-only silent failure and skips a finally block. The original source is
unchanged, journals are never edited, and owned replay uses the same mutant.
Each control must pass; each mutant must execute and preserve the final outcome
yet fail specifically at independent completion certification. The receipt
reports attempted/detected counts by category and the first divergence.

This is a bounded detector-strength measurement, not a completeness proof.
Further state, coercion-order, captured-cell, pending-work and effect mutants
belong in the same campaign as their independent observation coverage expands.
