# Retained Promise.allSettled joins

The public Promise join machine and the independent Python consumer now support
`Promise.allSettled` alongside `Promise.all` and `Promise.race`. They use the
existing shared Promise heap, owning invocation and realm-wide ready order.
There is no separate evaluator or scheduler for the new combinator.

## Checked behavior

- Registration records the input Promise and job identities without anticipating
  result objects. An empty input fulfills immediately with its own empty array.
- Each queued reaction allocates a distinct ordinary object with `status` and
  either `value` or `reason`. Repeated inputs produce separate entry objects
  while preserving aliases in the fulfilled values or rejection reasons.
- A rejection does not settle the aggregate. The final reaction allocates the
  output array in input order, even when inputs settle in a different order.
- Jobs run only at their actual FIFO position with no competing active turn.
  Missing entries, reused identities, forged outcomes and premature output
  allocations refuse transactionally.
- JSON restoration preserves completed reactions and unfinished dependencies.
  Unpublished entries must still match their original settlements. After
  fulfillment the exposed entries and result array are ordinary mutable guest
  objects; restoration does not incorrectly freeze their properties.

The implementation follows the retained ECMA-262 17th-edition algorithms for
[Promise.allSettled](https://262.ecma-international.org/17.0/#sec-promise.allsettled)
and its per-element reactions. Source checks execute original JavaScript in an
independent native process, separately compare the instrumented observations,
and recheck public replay. The Python implementation derives its transitions
from its own state and does not import the producer evaluator.

## Evidence and boundaries

Twenty-six producer join/source/rollback/population tests and 46 native
join/protocol/replay tests pass before final pair qualification. Source cases include mixed outcomes,
empty inputs, duplicate Promise/value identities, nested Promise executors and
joins, mutation after fulfillment, and JSON recovery before each join reaction.
These counts describe their specific commands, not full language conformance.

Three cases are added to recurring interoperability, increasing its declared
population from 37 to 40: `promise-allsettled-mixed-aliases`,
`promise-allsettled-nested-executor`, and `promise-allsettled-empty-mutation`.
Fresh independent admission, tokenizer costs and ordinary lifecycle results
must identify the published producer/consumer pair separately.

The owned source runtime still bounds combinator iteration at 64 elements;
the public collecting-join contract permits at most 4,095 input entries because
the array's length uses the remaining property slot. These limits are explicit
resource boundaries, not conformance exclusions. Custom iterable acquisition,
arbitrary thenable assimilation, constructor/species customization and async
iteration require their own source and native qualification.

`Promise.any` remains outside this public profile. Its existing owned runtime
creates a simplified rejection object; full AggregateError prototype and
descriptor behavior must be corrected and independently checked before that
behavior can be promoted. The new allSettled support does not certify it.

No model-learning, held-out quality, default cutover or operational release
claim follows from these engineering controls.
