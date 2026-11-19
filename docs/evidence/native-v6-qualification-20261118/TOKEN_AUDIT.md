# What the model is rewarded for predicting

These are actual native measurements from [Actions run 44416218114](https://github.com/werg/tracing-js-self/actions/runs/44416218114), at producer `3a2e8b9bade0a3abb2797114f798d04832072dec` and consumer `d644e3dfc01a22a14f039a9c063d7b65937d8e8f`. The [initial audit](native-conditionals/training-supervision-audit.json) and [fitted audit](native-fitted-audit/training-supervision-audit.json) retain every physical record, token ID, token piece, supervision mask, boundary, causal context, loss and gradient fingerprint. [manifest.json](manifest.json) binds the exact file bytes.

## One record, token by token

Before the first generated decision, native context contains 11 earlier positions: four physical observations and seven reserved metadata/query/knowledge positions. The current target is absent. Reserved controls can recur in history with their reserved track IDs; physical event identities remain distinct.

The first target is one complete record, `promise create @p1`:

| Output position | Token ID | Exact token piece as a JSON string | Lexical loss mask |
| ---: | ---: | --- | --- |
| 0 | 105998 | `"promise"` | true |
| 1 | 2818 | `" create"` | true |
| 2 | 1192 | `" @"` | true |
| 3 | 79 | `"p"` | true |
| 4 | 16 | `"1"` | true |

These are the intended next output positions, not a claim that the native decoder is a conventional autoregressive language model. Its realizer conditions on sampled facets and the chosen mode, length and terminal state, then scores the lexical output positions. The training and serving comparisons measure that actual computation.

The length target is 5, the mode is text, and the terminal target is true. A native terminal completes this text record. The separate trace line `end return` completes the JavaScript invocation. There is no hidden lexical EOS token standing in for either decision.

## Every episode token

| Physical records | Records | Tokens | Scored tokens |
| --- | ---: | ---: | ---: |
| Generated trace records | 11 | 142 | 142 |
| Observed source, invocation, lifecycle and external data | 8 | 1,567 | 0 |

Both initial and fitted audits pass `allGeneratedTokensScored` and `allObservedTokensUnscored`. Every generated token, including punctuation and structural words, has its intended lexical mask. Observations condition later decisions but receive no separate lexical prediction target. Current record IDs are absent from their own causal contexts, and retained physical context events are strictly earlier.

The prediction prior is computed before the target bytes are encoded. The separate reconstruction objective uses an encoding of the generated target after that boundary. Its parameter-owner gradients are recorded separately; it does not insert current or future labels into the prediction context.

## Loss normalization and gradient flow

The effective window scale is 1.0. Each loss sum uses its recorded weight divided by the episode-window denominator:

| Objective | Weight | Denominator | First-record scored count |
| --- | ---: | ---: | ---: |
| Prior lexical prediction | 1 | 142 | 5 |
| Generated-record reconstruction | 1 | 142 | 5 |
| Structure | 0.25 | 44 | 4 |
| Terminal | 0.1 | 22 | 2 |

The four structural targets are length and mode on the prior and reconstruction paths. The two terminal targets likewise cover both paths. The actual mode and modality supports in this request are singleton text, so they have probability one; their declared ledger entries do not create a useful classification gradient. The complete ledger also records routing regularization, unused loss families and their denominators.

The audit checks gradients separately for lexical, reconstruction, structure and terminal losses. It retains exact gradient digests, connected-parameter counts and norms for vocabulary, lexical realizer, structural and terminal heads, input encoder, context core, predictor, controls and shared experts. The structural and terminal heads receive nonzero gradients from their intended objectives. Read-only audit optimizer steps are zero.

## Valid future-observation perturbation

The later read observation at physical offset 9 changes from `observe @e1 fulfilled 7` to `observe @e1 fulfilled 8`. Both the numeric result field and its matching line change; other payload fields stay fixed, and token count remains 78. The observed mask stays empty.

For all four earlier decisions, both checkpoint audits find exact equality of context state, target IDs/masks/boundaries, conditional fingerprints, selected log probabilities, objective losses, full gradient fingerprints and norms, and actual decoder output. This is a measured causal-isolation result for those decisions, reinforced by the per-boundary earlier-context checks. It is not a claim about every possible dataset or configuration.

## Decoder feasibility and limits

At initialization, all 11 native emissions were tested and none was a complete valid generated v6 record. After the separate bounded decoder-only fit, the fitted audit has exactly one complete valid generated record. The independently reloaded service emits `promise create @p1` in one native call, and the production JavaScript controller accepts those original bytes.

The fit takes 16 genuine optimizer updates with all other model owners frozen. Its full checkpoint retains the model, real optimizer state and complete transducer attachment; diagnostic updates are recorded separately from the ordinary trainer schedule. This demonstrates feasibility of one complete record and enables the [two-boundary computation comparison](native-two-boundaries/report.json). It does not demonstrate whole-program execution, ordinary full-model training, or held-out reasoning improvement.
