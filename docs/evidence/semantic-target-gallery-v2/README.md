# Production target gallery v6

This gallery shows the exact generated text records produced by the current
`semantic-trace/6` compiler for eleven independently checked engineering
fixtures. It includes the source, generated and observed records, exact target
UTF-8 bytes, source claim, certificate rule, and a digest of the public prefix
before each generated record.

## Paired counts

| Representation | Generated records | Target UTF-8 bytes | Production tokenizer tokens |
| --- | ---: | ---: | ---: |
| Archived `semantic-trace/5` | 145 | 12,345 | 3,784 |
| Current `semantic-trace/6` | 107 | 3,861 | 1,307 |
| Change | -38 | -8,484 | -2,477 |

Byte and token reductions are reported separately. The token counts encode each
exact raw target line independently; they exclude native transport framing,
recurrent context, and training masks.

The same pinned Ling tokenizer asset was used for both raw target sets:

- Revision: `9a98e35fe1c9ee255f78dd64771c7ae15a799481`
- Tokenizer SHA-256: `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`
- Codec fingerprint: `7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`

## Read the comparison correctly

The v5 side comes directly from the checked-in v1 control gallery's raw target
strings and stored byte counts. Those records were not decoded or reinterpreted
with the v6 grammar. The v5 and v6 raw strings were independently encoded with
the same pinned tokenizer, with an exact token-to-byte round trip required for
every line.

The v6 helper and dense-loop examples each use a source-region summary followed
by `end return`, for example:

```text
evaluate run(4) => 5
end return
```

The counter example keeps the observed read boundary before the computation:

```text
request @e1 demo.readAsync("counter") payload ["counter"] promise @p2 in @invocation1 at 57..76
await @p2 as @continuation1 returns @p1 in @invocation1
resume @continuation1 fulfilled 7 in @invocation1
current = 7
compute (current + 1) => 8 as next in @invocation1
```

`gallery.md` and `gallery.json` preserve every actual generated line in full.
These are source-verified teacher targets and tokenizer measurements, not model
emissions, learned-quality results, or native admission evidence.

## Reproduce

```sh
node tools/semantic-trace-gallery.mjs \
  --out /tmp/semantic-gallery-v6 \
  --tokenizer-json /path/to/tokenizer.json \
  --consumer-root /path/to/megatoken \
  --python /path/to/python
```

The default baseline is
`docs/evidence/semantic-target-gallery-v1/control/gallery.json`. The baseline
path can be overridden with `--baseline-gallery` without changing its contents.
