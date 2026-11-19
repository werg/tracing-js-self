# Native v7 consumption and training/export integration

## Scope

The requested follow-up implements the first two remaining items from PR #45:
the actual independent native v7 consumer, and v7 training/export with semantic
family splits and a detailed fallback inside the new contract. Full serving-cost
qualification and external comprehension evaluation remain separate work.

Producer work continues on `codex/semantic-algorithm-v7` from
`f610a2e3929fc13c685b7ba223f818ba6875f5bc`. Companion work uses the same branch
name in `werg/megatoken`, starting at main
`3733774ba64f349f34cbce51206df771198bf02a` (the same source tree as the earlier
qualified consumer `d644e3dfc01a22a14f039a9c063d7b65937d8e8f`). Each completed
slice is committed and pushed. Historical reports remain bound to their actual
producing revisions.

## Contract decisions

Both representations use `semantic-execution/7`, `semantic-trace/7`, and
`semantic-context/7`. Every public episode explicitly declares its representation:

| Representation | Execution profile | Generated records | Public context |
| --- | --- | --- | --- |
| `algorithm` | `algorithm-execution/1` | Checked compact operation/effect records | Previously published immutable definitions and inputs, live committed state, and exact causal cutoff |
| `detailed` | `selected-detailed/1` | `detail ` followed by canonical JSON with exactly `kind` and `fields` | The full current public selected prefix, including exact source, input and continuation state |

The nested `fields` object is necessary because detailed transfer and completion
records already have their own `kind` field. A new detailed decoder accepts only
the new structured spelling; old v6 wire records are rejected. Detailed targets
and all affected context/causal digests are regenerated from independently
checked execution evidence. No public artifact is admitted by changing only its
version label.

Algorithm contexts and continuations require `representation: 'algorithm'`.
Earlier candidate contexts without a representation are rejected. Algorithm
durable checkpoints advance to `semantic-algorithm-checkpoint/2` and reject the
previous checkpoint schema.

Detailed contexts declare `representation: 'detailed'` and contain a strict
`selected-inference-prefix/3`, a visible-through cutoff, and the stable digest
of that exact current prefix. Full source/definition availability is explicit;
the detailed profile does not pretend that an unresolved ID is accessible data.

## Implementation and acceptance checklist

- [x] Explicit v7 representation and checkpoint boundaries.
- [ ] Independent Python algorithm parser, canonical encoder and operation evaluator.
- [ ] Native causal replay, cache/continuation validation, physical episode import,
  real model serving, and matching training/serving controls.
- [ ] Detailed v7 source projection, decoder and independent native import.
- [ ] New exact-revision source/native admission receipts and policies.
- [ ] Versioned complete family registry; all relatives, identical cores and
  source aliases remain in one split; unknown or changed memberships are rejected.
- [ ] V7 prepared data and causal-LM exports, generated-only labels, exact tokenizer
  round trips, and production refusal of unadmitted or old-version artifacts.
- [ ] Cross-language valid/malformed fixtures, counterfactual future isolation,
  restored continuations, actual observation loss masks and source rechecks.
- [ ] Pushed evidence and coordinated companion PR.

Native admission checks the actual companion's operations, causal visibility,
contexts, physical framing, and loss ownership. Independent source/reference
and exact journal replay remain distinct producer checks. Private evidence is
never a model input, and consistency hashes alone do not authorize a source or
external observation.
