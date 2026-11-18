# Qualified private real-source release, 2026-11-18

The release completed and every archived file passed streamed checksum
verification. It preserves all **210 original attempts**, including all 174
admitted candidates and all 36 original refusals, at the original producer
`5753de14760b76754fd1bd49ca7c8bfc6de85831` and native consumer
`6206b33a55eba3e50f80498f906439221bc289b7`. Later fixes do not relabel this historical corpus.

The clean packaging implementation was commit
`a1560f5badbe8ad733150aa6a091d53a8dd9d11f`. Its exact source hashes are retained in the
manifest. It checked the complete campaign chain and referenced bytes, freshly
verified the actual pinned native environment, and re-executed source and native
qualification for **174/174 original admissions**. The prior interrupted
attempt's qualifications were not reused to bypass those checks.

## Actual selection and preparation

| Measurement | Observed value |
|---|---:|
| Per-component training token cap | 750 |
| Maximum training token share | 0.2 |
| Original training candidates | 148 |
| Training candidates selected | 19 |
| Training candidates excluded by caps | 129 |
| Unchanged held-out inputs supplied | 26: 8 validation, 18 test |
| Native intake admissions | 45/45 |
| Native duplicate aliases retained in audit | 5 |
| Distinct prepared rows | 40: 17 training, 6 validation, 17 test |
| Selected training tokens before dedup | 5,814 |
| Actual prepared training tokens | 5,714 |
| Largest prepared component token share | 0.128631431572 |
| Final cap violations | 0 |
| Files verified in archive | 1226 |
| Compressed archive bytes | 483396088 |

The training cap did not remove or change a held-out input. The native
consumer's existing deduplication then represented two validation, one test,
and two training inputs by retained duplicate aliases. The receipt distinguishes
all 26 supplied held-out memberships from the 23 distinct prepared held-out
rows. `prepared-training-selection.json` retains each native disposition and
its duplicate target. Every original candidate, refusal, split, registry,
source notice, and private qualification remains in the archive.

This smaller prepared collection demonstrates an actual complete release path
and enforced training token balance. It is not evidence of a large balanced
training corpus or learned generalization; optimizer steps are zero.

## Archive identity and retained evidence

Archive SHA-256:
`8dc1afe0f0a683f152f134a37353bb4654d775f856ec1ce63c109c2861ae33c3`.

Release identity digest:
`59dcc3288b7cb39bd2b4e65ffe87403e84a263fdab5cef133b854e87e321a698`.

`release-manifest.json` binds the complete 1,226-file inventory and exact
producer, consumer, tokenizer, package, campaign, selection, and preparation
receipts. `native-qualification.jsonl` retains all 174 actual fresh qualification
receipts; its summary binds the exact bytes. The selection and prepared
selection artifacts retain selected and excluded IDs, split memberships,
measured tokens, component shares, and dedup dispositions. The larger campaign
verification, source notices, and selector input are inside the archive; their
exact hashes are also listed in `index.json`.

The archive is private audit evidence. These receipts do not grant public
redistribution approval. Exact upstream notices remain attached to source
identities; the companion source-refusal receipt binds every historical source
variant to its retained notice text and hash.

## Interrupted larger selection

The first cap of 10,000 tokens with share 0.2 selected 69 training inputs plus
the same 26 held-out inputs. All 174 fresh qualifications and 95 native intake
admissions completed, with seven duplicate aliases, before the process was
observed killed with exit code 137 while exporting prepared data. No kernel
counter was captured to establish the cause. No completed release archive or
final prepared-selection receipt existed for that attempt.

`interrupted-larger-selection.json` preserves that incomplete result. The
successful smaller run used a new directory, repeated every required gate,
preserved the exact historical consumer pin, and retained every held-out input.
