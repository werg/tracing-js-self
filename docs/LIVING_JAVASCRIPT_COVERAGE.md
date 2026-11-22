# Living JavaScript coverage and corpus

This is the working record for [issue #48](https://github.com/werg/tracing-js-self/issues/48).
The development target is current JavaScript and useful real programs. A supported
subset, a saved run, or a historical format label does not freeze that target.
Implementation, independent checking, corpus production, preparation, training,
and serving advance together. Earlier observations retain their actual code,
inputs, settings, and outcomes; they do not certify later code.

## Active implementation

The first changes address semantic and evidence-integrity problems before
expanding the source population. The pull request description is the detailed
live tally; this file records the durable working direction and commands.

| Work | Status | Verification needed |
| --- | --- | --- |
| Owned async iteration and synchronous-iterator adaptation | In progress | Original-source differential execution; abrupt iterator closing; restore across awaits |
| Original Test262 async completion ownership | In progress | Reject printed completion markers, missing completion, and duplicate completion |
| Current Test262 acquisition and resumable campaign accounting | In progress | Exact source/harness provenance; disjoint shards; interruption and resume without lost variants |
| Complete source-family clustering without fixed population ceilings | In progress | Near-clone regressions; explicit work budgets; no silent dropped matches |
| Ordinary generation with visible resource limits and unrun inputs | In progress | Every selected source retains a disposition; failed checks cannot become admitted data |
| Independent native and preparation integration | Investigating | Exercise changed semantics through the current consumer; retain unsupported stages explicitly |

## Continuing work

These areas remain part of the same implementation. They are not a sequence of
scope-selection or release gates, and this increment does not claim to finish
them.

| Area | Continuing work |
| --- | --- |
| [Original sources #49](https://github.com/werg/tracing-js-self/issues/49) | Complete harnesses, strict/sloppy/raw/module variants, phase-correct errors, realms, async jobs, source correspondence, interruption and retry |
| [Async and cleanup #50](https://github.com/werg/tracing-js-self/issues/50) | Promise ownership and species, asynchronous iteration and generators, disposal, resumable cleanup, independent transitions |
| [Objects #51](https://github.com/werg/tracing-js-self/issues/51) | Observable reference and coercion order, Proxy invariants, construction, private state, sparse collections, abrupt partial effects |
| [Modules and sessions #52](https://github.com/werg/tracing-js-self/issues/52) | Loading/linking/evaluation, cyclic live bindings, dynamic import, persistent identities, complete TypeScript provenance |
| [Standard libraries #53](https://github.com/werg/tracing-js-self/issues/53) | Binary memory and aliases, owned RegExp execution, remaining builtin methods, explicit resource accounting |
| [Dynamic code and realms #54](https://github.com/werg/tracing-js-self/issues/54) | Owned eval and constructors, environment semantics, cross-realm identity, proper tail calls |
| [Agents #55](https://github.com/werg/tracing-js-self/issues/55) | Shared memory, atomic ordering, wait/notify, schedule exploration and recoverable worker state |
| [Weak references #56](https://github.com/werg/tracing-js-self/issues/56) | Reachability, keep-alive obligations, collection choices, cleanup reentry and restoration |
| [Hosts #57](https://github.com/werg/tracing-js-self/issues/57) | Node/browser APIs, scheduling, internationalization, explicit time and environment observations |
| [Durability #58](https://github.com/werg/tracing-js-self/issues/58) | Callback ingress after checkpoints, descendants, service ownership, physical-effect reconciliation and process-loss tests |
| [Current implementation #59](https://github.com/werg/tracing-js-self/issues/59) | Consolidate producer, native checker, preparation, exports, serving and restoration; retire obsolete paths as replacements work |
| [Corpus preparation](https://github.com/werg/megatoken/issues/39) | Continuously acquire and independently admit growing source families, preserve causal targets and physical membership |
| [Training and evaluation](https://github.com/werg/megatoken/issues/40) | Exercise the ordinary training/export/serving path and use observed model failures to guide implementation |

## Evidence rules

- Record actual source bytes, harness dependencies, tools, commands, and limits.
- Report parsing, owned execution, source correspondence, native checking,
  preparation, and model evaluation separately.
- Keep unsupported behavior, guest exceptions, infrastructure failures,
  resource exhaustion, interruption, and unrun cases distinguishable.
- Use configurable execution budgets to bound work. A budget does not define
  the language target or silently discard the rest of a source population.
- Keep related source families together across training and evaluation. If
  clustering exhausts its budget, fail visibly instead of weakening separation.
- Add regression examples to the ordinary corpus as semantics become usable.

## Lessons while implementing

- A reference process printing a success marker is not proof that the original
  source invoked the async harness completion callback.
- Common source fragments still carry clone evidence. Silently dropping a
  large posting list changes the meaning of a train/evaluation split.
- Async iteration must retain the iterator and its methods across awaits and
  preserve pending-completion precedence during cleanup; parser acceptance alone
  would not establish support.
