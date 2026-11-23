# Promise object state and original async sources (#61)

This is the implementation record for
[issue #61](https://github.com/werg/tracing-js-self/issues/61). The pull request
description is the current progress tally; this document retains the design and
the evidence locations needed to resume the work.

## Starting revisions and required evidence

- Producer baseline: `3d72b27cf626b87d78eb0b883f54ea9e9c5380e8`.
- Independent consumer baseline: `6eb4fc4b1c10e2f2b576fd04c21d88c24ed3a558`.
- Original Test262 inputs: `2a1ade303f72d3de80565c921d685222405c32ce`.
- Selection: the unchanged 20 paths in
  `artifacts/conformance/test262-current-pr60/selected-paths.txt`, including all
  40 required strict/sloppy variants and the original harness bytes.
- Earlier receipts remain historical. No new passing result is claimed here.

## Hardest questions first

Promise settlement and ordinary property storage currently follow different
paths. Merely accepting `Object.defineProperty` would leave observable
constructor getters, inherited identity, and Promise job ordering incorrect.
Promise objects will use the same descriptor and prototype operations as ordinary
objects, while retaining their Promise identity and settlement state.

The owned Promise row will hold ordinary property fields directly. The public
controller and independent consumer already represent each Promise in their
shared heap; they must check the same property changes there. A second object
identity or a compatibility representation is unnecessary.

Mutable intrinsic prototypes need one identity per realm. A lookup must keep
its original receiver even when a getter is inherited. Constructor lookups at
Promise resolution, await, and reaction creation must preserve synchronous
getter effects, reentry, abrupt completion, and FIFO job behavior.

## Work and acceptance ledger

- [ ] Reproduce current-clean first barriers on the exact original inputs.
- [ ] Implement shared Promise descriptors, prototype identity and reflection.
- [ ] Implement observable constructor lookup and getter/call sequencing.
- [ ] Add ordinary and adversarial runtime controls, preserving genuine guest
  errors and explicit implementation refusals.
- [ ] Extend source projection and original-reference observation together.
- [ ] Extend independently implemented native state transitions and rejection
  controls for receivers, descriptors, prototypes, source bindings and order.
- [ ] Regenerate affected contracts and fixtures in place.
- [ ] Rerun all 40 original variants and retain every outcome/new barrier.
- [ ] Record exact executed revisions, input hashes, budgets and commands.
- [ ] Run the required regression gates and record any unresolved work in the
  main PR description.

## Evidence boundaries

Owned execution, original reference execution, source correspondence and native
transition checking are distinct results. Each is reported only when executed.
Unsupported behavior must stop outside guest exception handling; it cannot
satisfy a negative test or become a caught-error success. Newly exposed semantic
barriers remain visible instead of changing the harness or dropping a variant.

Training and learned-execution evaluation are outside this issue's acceptance.
