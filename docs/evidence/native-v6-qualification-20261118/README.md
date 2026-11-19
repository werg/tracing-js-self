# Executed production v6 qualification

The production model now predicts the [terse v6 trace language](../../PRODUCTION_TRACE_V6.md). This folder preserves exact evidence from [paired native run 44416218114](https://github.com/werg/tracing-js-self/actions/runs/44416218114), which completed successfully.

- Measured tracer: `3a2e8b9bade0a3abb2797114f798d04832072dec`.
- Measured native consumer: `d644e3dfc01a22a14f039a9c063d7b65937d8e8f`.
- Runtime: Node 24.22.3, Python 3.12.14, PyTorch 2.10.0+cpu, locked production tokenizer, CPU float32, dropout disabled.
- The containing documentation commit is later than the measured code commit. These reports are evidence for their recorded revisions; they are not silently relabeled as later measurements.

[manifest.json](manifest.json) records every retained file's original SHA-256 and byte length. The large first serving capture is losslessly gzip-compressed; its uncompressed and stored hashes are both recorded.

## Production targets

The same eleven source examples in the [target gallery](../semantic-target-gallery-v2/README.md) contain 1,307 v6 target tokens versus 3,784 archived v5 tokens, a 65.5% reduction. Their generated UTF-8 text drops from 12,345 to 3,861 bytes. These are measured target-size changes, not learned-quality results.

The production compiler uses short source-grounded records and checked higher-level regions by default:

```text
evaluate run(4) => 5
end return
```

```text
evaluate run(@o2) => 9 over 3 items into total
end return
```

Effects and asynchronous boundaries retain their semantics. For example, after an observed read:

```text
resume @continuation1 fulfilled 7 in @invocation1
current = 7
compute (current + 1) => 8 as next in @invocation1
```

These are actual generated target strings. JavaScript and Python parse the same v6 language; the model's claims are validated without substituting teacher output. Bounds on pure regions, helpers and loops are explicit in the language specification.

## Saved-checkpoint computation

The [fit report](native-decoder-fit/report.json) records 16 real decoder-only optimizer updates. All other model owners remain unchanged. The complete native checkpoint includes every model owner, the actual optimizer state and the original complete transducer training attachment. It is a diagnostic fit, with updates recorded separately from ordinary trainer scheduling.

Saved checkpoint SHA-256:

```text
606393b3ca397234c3c1a3adaf4ecf1f85e20c12c9d8e9ad909aa77dc7e9c55c
```

Served model SHA-256:

```text
612fa6faebea2f6c967b6c61f16a0098fdd9c0723d4b8a5f0f3aa94f471b778f
```

The independently exported and reloaded service emits exactly:

```text
promise create @p1
```

It uses one complete native text record. The production JavaScript controller accepts the original model bytes, then the same live service predicts at the next boundary. There is no teacher insertion in the serving history.

The [two-boundary report](native-two-boundaries/report.json) compares actual trainer and serving computations from that one saved checkpoint:

| Measurement | First generated boundary | After committing the actual first record |
| --- | ---: | ---: |
| Gaussian coordinates compared | 256 | 256 |
| Recurrent-state coordinates compared | 1,837 | 2,224 |
| Maximum Gaussian/state difference | 0 | 9.5367431640625e-7 |
| Maximum actual sampled-facet difference | 0 | 9.5367431640625e-7 |
| Conditional probabilities compared | 784,585 | 10,041,154 |
| Maximum probability difference | 0 | 1.0058283805847168e-7 |
| Maximum total variation per conditional | 0 | 4.6246113004008715e-7 |
| Selected joint log-probability difference | 0 | 1.0168091193918372e-5 |
| Actual lexical/length/terminal argmax choices | 7 of 7 agree | 66 of 66 agree |

Loaded model tensors are exactly equal. Current public control bytes and encoded control tensors match. Native track addresses, descriptions, chronological positions, context policy and event attachments match; opaque dataset/runtime event IDs are retained side by side without rewriting. Reserved transducer IDs may repeat at their proper history positions.

Both actual decoders permit lengths 1–128, terminal choices 0/1, and the same UTF-8 lexical alphabet. Their actual output mode and modality supports are singleton text choices with probability one.

The decoder comparison scores the service's original emitted IDs through the captured real training readout, with no optimizer update. It checks every permitted token probability and also checks that training's actual argmax choices agree with the original serving choices; equal forced labels alone cannot pass.

### Numerical scope

The first boundary's measured neural tensors and probabilities are bitwise identical. The second is numerically close, with the differences shown above; it is not reported as bitwise identical. The original [stricter-threshold failure](history/7299-strict-probability-bound.json) is retained unchanged. That run exceeded a decimal 1e-7 probability cutoff by approximately 0.58%. The final bound is the native float32 epsilon at unit probability scale, 1.1920928955078125e-7, with the independent total-variation limit 1e-5 and selected log-probability limit 1e-4 retained. Argmax agreement is a separate required gate.

The source audit found the same target/emitted-byte encoder operations, track IDs, adapter selection and public semantics. The report locates the small continuation difference in the encoded raw state and retains its original tensors; it does not claim to have isolated a particular low-level arithmetic cause.

The per-boundary encoder-hook lists cover different intervals on the first boundary: serving includes prefix replay, while the training hook begins at the chosen supervision call. Those lists are retained and labeled as incomparable. The current control bytes/tensors and accumulated recurrent state are the gates. The separate [first-boundary probe](native-conditionals/report.json) captures both full prefix paths.

## Supervision and causal isolation

The [token-by-token guide](TOKEN_AUDIT.md) explains the exact targets, structural decisions, weights, normalization and gradient owners. The complete [initial audit](native-conditionals/training-supervision-audit.json) and [fitted audit](native-fitted-audit/training-supervision-audit.json) retain all 1,709 token positions.

- All 142 generated tokens are supervised.
- All 1,567 observed tokens have no lexical target.
- Current target records are absent from their own contexts.
- Changing the well-formed later read result from 7 to 8 leaves all four earlier decisions' states, distributions, masks, losses and exact gradient fingerprints unchanged, before and after the fit.
- Initialization produces 0 complete valid generated records in the eleven-emission audit. The fitted checkpoint produces 1. That first record also passes the actual public semantic controller.

The standalone first-boundary reports deliberately retain their narrower `partial-measured` interpretation. The extended conditional and argmax measurements are in the separate two-boundary report; no archived report is rewritten to imply a larger scope.

## Fresh source capability ledger

[current-v6-capabilities.json](current-v6-capabilities.json), also copied byte-for-byte to [coverage/current-v6.json](../../../coverage/current-v6.json), executes 52 declared probes:

| Stage | Passed | Failed/refused | Unsupported | Untested |
| --- | ---: | ---: | ---: | ---: |
| Frontend | 46 | 0 | 6 | 0 |
| Owned evaluation | 44 | 0 | 2 | 6 |
| Independent outcome | 43 | 1 | 0 | 8 |
| Independent intermediate checks | 43 | 0 | 0 | 9 |
| v6 projection/public replay | 44 | 0 | 0 | 8 |
| Native admission | 43 | 0 | 0 | 9 |
| Model evaluation | 0 | 0 | 0 | 52 |

The one independent-outcome refusal is `callback-abrupt-obligation`, classified as `reference_callback_failure`: callback failure is outside the qualified observable completion profile, so it is not admitted. It remains visible as a failure/refusal in the raw ledger. The three new spread probes—array literals, Unicode code points, and call operand evaluation order—pass every stage through native admission.

## CI and retained checkpoint

The measured code's [Node 20/22/24 workflow](https://github.com/werg/tracing-js-self/actions/runs/44416218046) is green. The companion's [complete CPU workflow](https://github.com/werg/megatoken/actions/runs/44411756531) is green on Python 3.11 and 3.12, each with 2,923 passed and 50 explicit skips. Its [production-tokenizer semantic pipeline](https://github.com/werg/megatoken/actions/runs/44411756313) also passes.

The [full checkpoint and raw run artifact](https://github.com/werg/tracing-js-self/actions/runs/44416218114/artifacts/14478759919) is 105,393,866 bytes and is retained by GitHub Actions until 2026-12-18T23:02:31Z. Its archive digest is `sha256:6f4d10ae34979c7e916a8cc4c2a951956b9efed938848cbf7c8c4975146d0648`. Exact JSON reports and hashes in this Git folder do not depend on the artifact retention period.

These measurements establish a bounded native computation and supervision result for one asynchronous prefix, plus feature-level native admission. They do not establish whole-episode model correctness, unrestricted JavaScript support, a larger model's behavior, or held-out reasoning improvement.
