# Fresh v8 interoperability and retained-gallery qualification

This directory retains complete source, native-admission, tokenizer, and replay evidence for the repaired producer and consumer. It is an engineering qualification, with zero optimizer steps and no model-execution or serving-latency claim.

## Measured revisions

- Producer: `8d1f7b5b24d385ce067e9a3d64cce37140a26a56`.
- Consumer: `be3a8d789f2ea8c76a77c7f2f14eff717960d64e`.
- Contract digest: `0880cbd31fe3dd749f3566f96183741451ae51c5fd58a309bf1b8a3fafa27e46`.
- Interoperability digest: `6ff5cbe1b22fd9ab891275aef124e3bd0cfbb756709603c5f95ddc7dd31f780c`.
- Production tokenizer SHA-256: `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
- Tokenizer library: `tokenizers==0.23.3`.

The producer checkout and consumer checkout were clean and fixed at these revisions throughout qualification. `report.json` contains the population-level results and native policy. `archive.json` binds each compressed archive and each uncompressed member to its exact SHA-256.

## Results

| Declared population | Source qualified | Native admitted | Exact cost measurements |
| --- | ---: | ---: | ---: |
| Interoperability | 22 / 22 | 22 / 22 | 22 / 22 |
| Retained gallery | 11 / 11 | 11 / 11 | 11 / 11 |

All 33 native receipts passed independent replay, contexts, continuation, exact physical-record masks, live source binding, and the production tokenizer gate. The interoperability population includes ordinary generator properties and Symbol aliases, causal short-circuit choices, initializer throws, Promise joins/executors, private state, Proxy callbacks, typed views, and built-in iterators. The retained gallery includes callbacks, persistent external triggers, cleanup, branch paths, aliases, compact pure work, and ordered loops.

### Exact flat token costs

Flat contexts are the exact submitted context plus immutable public view. The terminal column counts the flat EOS framing. These measurements are separate from native training packing below.

| Population | Generated tokens | Terminal tokens | Submitted context tokens | Total tokens |
| --- | ---: | ---: | ---: | ---: |
| Interoperability | 23,867 | 761 | 1,217,943 | 1,242,571 |
| Retained gallery | 3,378 | 97 | 139,863 | 143,338 |

### Exact native training packing

| Population | Generated tokens | Observed/context tokens | Terminal tokens | Physical records | Logical records |
| --- | ---: | ---: | ---: | ---: | ---: |
| Interoperability | 23,867 | 1,244,727 | 0 | 2,848 | 809 |
| Retained gallery | 3,378 | 158,551 | 0 | 407 | 169 |

Native physical records include inserted contexts and framing. These counts do not measure serving latency, cache savings, or model success. Detailed generated-token shares are 96.42% for interoperability and 86.29% for the gallery; the artifacts preserve that cost rather than claiming protocol traces are predominantly compact.

## Retained artifacts and verification

The population archives include the complete qualification and cost reports, immutable populations, source artifacts with source authority, admitted artifacts, native receipts, progress records, attempts, and exact native input bytes. They are deterministic archives capped at 8,000,000 compressed bytes per part.

The qualification tool sends compact `JSON.stringify(source)` bytes followed by one newline to the native subprocess, while its original retained source files are pretty printed. The `*.native-input.json` files reconstruct that exact transport encoding. Every reconstructed file was checked against `sourceVerification.artifactSha256` in the receipt returned by the live producer authority. `native-inputs-manifest.json` records that method and the binding for every admitted case. All original qualification and cost artifact hashes were also verified before archiving. After writing each archive, every archived member was read back and checked for its expected byte length and SHA-256.

The consumer-validation archive retains the complete **178-test passing log, with no skips**, the test command and environment, and successful repository-wide lint, format (518 files), and diff checks. Those focused tests used the same consumer revision and live source authority at producer `2f9bca8`; the separate 33-case production qualification and costs above used the final producer `8d1f7b5`. The validation summary preserves both scopes explicitly.

Reproduce qualification from the pinned producer checkout with the pinned consumer checkout and production tokenizer:

```sh
PYTHONPATH="$CONSUMER/src" node tools/qualify-semantic-v8.mjs \
  --out "$OUTPUT" --population interoperability \
  --megatoken "$CONSUMER" --tokenizer "$TOKENIZER_JSON" \
  --python "$PYTHON" --workers 2
```

Repeat with `--population gallery` for the second population. Each archive retains the exact runtime policy and run inventories; the cost reports retain the production tokenizer evidence and scope of every denominator.

## Qualification limits

The 33 cases are the complete declared interoperability and retained-gallery populations at the measured revision. They do not replace the separate declared 665-case source population. Earlier interrupted runs remain historical diagnostics. External-model next-step accuracy, completed model execution, native serving latency/cache behavior, and default promotion remain unqualified. The default representation is unchanged.
