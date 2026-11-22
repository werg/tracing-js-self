# Original module source admission and physical packing: exact local evidence

One explicitly enabled original JavaScript module graph passed fresh source
verification, independent native replay and ordinary prepared-data packing.
The single-member registry places this fixture in **validation**. It does not
change any production source population or training split. No optimizer ran and
no learned execution result was measured.

This is the completed local result, not the later hosted qualification. The
separate four-graph public/native lifecycle gate has its own evidence and must
not be inferred from this one-example data result.

## Exact execution and corresponding published trees

| Component | Local commit actually executed | Published commit with the identical complete tree | Tree |
| --- | --- | --- | --- |
| Producer | `e0f2463f0302e65801cb5dd64cc53ecd37e43b21` | `553c4c35b026c99b4a96586237ff9be054642687` | `e31773794e907c75e9129dadc931af1712a9b179` |
| Consumer | `ad3060c9e5bdefc0295fda5dfab63d78a1b0edf1` | `6af4772e3910f4d29d5827d8d5825e7483c3e973` | `0673a8c61e26deffc697177d5cf81f1797de8103` |

The local commits and connector-created commits have different commit metadata.
Their complete trees were compared before publication. The receipts retain the
local revisions that actually ran; they have not been relabeled with published
or later candidate revisions.

The source artifact is 29,521,433 bytes, with SHA-256
`b206c883e8f665af5ff1e959b035f4f009a22aad5dabc2cf6be4cffae13e5615`.
The pinned tokenizer SHA-256 is
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.
The active public contract digest is
`a952385535b9b5e19d737206286f6f26c149f7301c51b4b106fe3b1cae5ab55a`.
The existing six-case interoperability digest remains
`f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`.

## What ran and what passed

The original graph has two sibling dependencies and one entry module. The left
dependency catches an awaited rejection carrying `7`; the right dependency
awaits `0` and exports `2`; the entry returns `9`. The source bridge freshly
relinks the original modules, rebuilds their bound plan, reruns original ESM,
recompiles the owned trace and regenerates unique lifecycle-event ownership.
It checks each owned lifecycle cut against the active public scheduler state.

The integration test invoked the source emitter and the actual preparation CLI
from clean, exact producer and consumer checkouts. Source checking had an
explicit 600-second subprocess budget. The default for all callers remains
30 seconds; the new option accepts only finite integer budgets from 1 to 900.
Native preparation used the existing limits of 8,192 positions and 1,024
history positions. The full integration test passed with zero skips in
895.04 seconds.

| Measurement | Observed result |
| --- | ---: |
| Isolated source families / admitted validation episodes | 1 / 1 |
| Original modules / uniquely owned lifecycle cuts | 3 / 10 |
| Public timeline records | 710 |
| Generated logical targets and causal contexts | 708 each |
| Protocol records / detailed records | 113 / 595 |
| Selected physical target records | 708 |
| Physical context parts | 11,679 |
| All physical records | 12,438 |
| Packed windows | 898 |
| Scored token positions | 22,974 |
| Unscored observation tokens | 7,074,274 |
| Whole contexts exceeding 8,192 tokens | 566 |
| Largest whole context | 12,300 tokens |
| Optimizer updates | 0 |

All six mandatory native checks passed: replay, contexts, continuation, masks,
source binding and tokenizer. The test reconstructs every logical context and
target byte-for-byte from the prepared physical records, checks that context
records remain unscored and targets remain supervised, and verifies each final
context part's dependency edge to the first target part. Every physical record
fits the 8,192-token bound.

The retained native training digest is
`e5c8a825a43eba64f818b13e667d49297dd66b800470f505c49560be7bdc21b6`.
`packing-evidence.json` contains the full source and native receipts, source
registry, dataset binding, exact selected-token/mask digest, and unmodified
prepared report and manifest text with their SHA-256 digests.

A subsequent read of this already prepared dataset checked exact physical
record order across windows and measured a maximum packed window of exactly
8,192 tokens. `saved-window-check.json` records that inspection explicitly as
not a fresh source or native recheck. Those additional assertions were then
added to the separate hosted candidate's integration test.

## Related controls and their scope

`source-controls.log` records nine source and tamper-refusal tests, zero skips,
at the producer execution revision above. They cover missing original evidence,
changed source, rehashed plans, forged original ESM outcomes, removed or changed
public plans, forged initialization certificates, and the scalar single-call
entry restriction. Their source-only receipt deliberately says native
admission is false; the independent preparation receipt above establishes the
later data admission.

`native-controls.log` and its JUnit file record 45 admission tests plus 31
subtests, zero skips, against the same producer and the later native test-only
revision `45827a3b806bcb745afabd9cc4fb0b188455d280` (published equivalent
`1cd9480b8129dd553d8779407631103ea11d56b3`, tree
`ac829f7905fe7c37448025fc1005a5212707f707`). They include live producer forgery
refusals, real-tokenizer conversion admission, deadline/output guards and
session/orchestration admission controls. That revision changes one test double
to accept and verify the unchanged default timeout; production consumer code is
identical to the packing revision.

## Retained artifact and prepared dataset

`source-artifact.json.xz.b64` contains the complete original source/public/context
artifact, encoded as base64 of XZ-compressed bytes. `prepared-dataset.tar.xz.b64`
contains the complete reloadable prepared dataset: the episode shard, its index,
manifest, preparation report and frozen family registry. It excludes the
intermediate deduplication database, which the prepared reader does not need.
The compressed TAR SHA-256 is
`52e209b0224408f83bc2f29f2142f52d894fd9af104494a46a6b463d781b14e7`.

To decode into a new directory, from this evidence directory:

```python
import base64, hashlib, io, lzma, tarfile
from pathlib import Path

out = Path("decoded-module-evidence")
out.mkdir()
source = lzma.decompress(base64.b64decode(Path("source-artifact.json.xz.b64").read_bytes()))
assert hashlib.sha256(source).hexdigest() == "b206c883e8f665af5ff1e959b035f4f009a22aad5dabc2cf6be4cffae13e5615"
(out / "source-artifact.json").write_bytes(source)
archive = base64.b64decode(Path("prepared-dataset.tar.xz.b64").read_bytes())
assert hashlib.sha256(archive).hexdigest() == "52e209b0224408f83bc2f29f2142f52d894fd9af104494a46a6b463d781b14e7"
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as tar:
    tar.extractall(out / "prepared", filter="data")
```

## Lessons and remaining work

Logical context size is not the same as a physical record or packed-window
limit. Although 566 complete contexts exceed 8,192 tokens, the existing chunker
preserves their bytes and dependencies within the existing physical bounds.
Increasing the position limit was unnecessary.

The complete retained contexts are expensive: this small graph requires about
308 unscored observation tokens for each supervised position. This measurement
does not qualify a production cost envelope. Any future reduction of repeated
context must preserve causal reconstruction and needs its own evidence.

The profile remains explicitly enabled, bounded to scalar arguments and one
entry call. Default module data admission remains refused. Cycles, namespace
composition, arbitrary async adoption/thenables, larger source programs that
exceed the existing public-record byte limit, broad module-family population
coverage, cost-qualified training and learned model success remain separate
work. No standalone scheduler helper or successful packed example establishes
those claims.
