# Actual private release packaging smoke receipts — 2026-11-18

Both runs used clean packaging commit
`1a31a812bb054bc6d77b5a9729d0ee70c2adf52e`, the exact original producer
`5753de14760b76754fd1bd49ca7c8bfc6de85831`, and native consumer
`6206b33a55eba3e50f80498f906439221bc289b7`. The original corpus has three
engineering examples in one frozen training component. Reference checks used
the qualified Linux namespace isolation mode.

| Actual measurement | Default membership | 600-token component budget |
| --- | ---: | ---: |
| Original native-admitted candidates | 3 | 3 |
| Fresh source/native qualifications passed | 3 | 3 |
| Training candidates supplied to native preparation | 3 | 2 |
| Training-only exclusions | 0 | 1 |
| Native prepared episodes | 3 | 2 |
| Fresh generated tokens before selection | 906 | 906 |
| Selected training generated tokens | 906 | 600 |
| Verified archive files | 45 | 45 |

The capped run used `--max-family-tokens 600 --max-family-share 1`. It selected
`checkpoint-source-reread` and `counter-0`, each with 300 native generated
tokens, and excluded `counter-1`, with 306 tokens. Its original admission and
all original campaign bytes remain in the archive. The default run omitted
both cap options and prepared all three original candidates.

Each run independently executed the exact original producer's native
environment checker and source verifier, measured native tokens, prepared the
selected candidates, validated the final native SQLite token counts/splits,
created an archive, and verified every archived file without extraction.
Deterministic environment and qualification receipts were byte-identical
between the two executions and are retained once here. Complete archive
manifests and per-run selection/verification receipts are retained separately.

- Default archive SHA-256:
  `d37ede7e792e7b1de16a6fabade2ef7b774a410cff2ca4128ce22b95eb93624e`.
- Capped archive SHA-256:
  `a1f54b11840c278c6b2d27fb54f0d34f8cdabcd33010baaf8a54dd4ae9a0bf6f`.

The complete native-consumer tool unittest discovery passed **35/35** tests.
The release campaign, training selection, and source-registry Node tests passed
**21/21**. They include synthetic held-out membership tests, stale environment
receipts, changed public digests, aliases, omitted refusals, bounded archive
reads, and final token-share failures after native deduplication.

The actual smoke corpus contains no validation/test examples, so it does not
measure native held-out preservation or large-corpus memory use. Synthetic
regressions establish the selection rules; a larger real-source campaign needs
its own actual packaging receipt. No optimizer ran, and learned success is
unmeasured. Private source archives and full corpus data are intentionally not
committed in this receipt directory.
