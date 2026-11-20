# Independent native v8 qualification

The producer admission command freshly rechecked all three source-bound artifacts and invoked the independent Python consumer. All six native gates passed for every fixture: replay, exact public contexts, continuation round trips, physical masks, source binding, and tokenizer identity. These are engineering receipts with zero optimizer steps; external-model execution and native inference latency remain unmeasured.

- Producer: `adb74d3aa00eecff5855e096aea231b4ebb65baf`.
- Consumer: `werg/megatoken` at `2e87ac4d7908a462dc9b97aaf5d0de9cebeeed17`.
- Contract: `fe1eed56bafa5c0012354b29ebb3b40bbe33f085f063d6990fcb3f26cb261cc2`.
- Fixture digest: `56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`.
- Tokenizer file: inclusionAI/Ling-3.0-tiny at `9a98e35fe1c9ee255f78dd64771c7ae15a799481`, SHA-256 `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
- Tokenizer identity: `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.

| Fixture | Public records | Predictions | Physical records | Generated tokens | Observed tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordered map | 4 | 2 | 6 | 143 | 2,639 |
| Getter between compact arithmetic | 15 | 13 | 44 | 352 | 19,305 |
| Causal counter | 17 | 11 | 40 | 343 | 15,983 |

Native packing uses `native-physical-record-boundaries/1`: it has no textual EOS token and reports zero terminal tokens. The flat causal serializer uses a separately measured EOS and is a different physical path. The context system record precedes each target; generated loss covers only the canonical generated line. Observations and routing have zero loss.

`report.json` contains the complete receipts and all three declared dispositions. `artifacts.tar.xz` retains the exact source artifacts, admitted artifacts, native receipts, and report. `archive.json` pins the compressed bytes and entry list. Later producer changes do not rewrite this historical run or promote its evidence to a different contract.
