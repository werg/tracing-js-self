# Reconstruct the original corpus and baseline archive

This is the original local baseline and pre-fix broad native campaign, **not a current dataset release**. The exact [archive receipt](tracing-js-original-corpus-evidence-2026-11-18-zstd.json) records 7,641 verified source files, 7,228,861,076 uncompressed file bytes, the compressed archive identity, the uncompressed tar-stream identity, and every part's size/hash. Archive creation and content verification are complete. **Private part uploads are pending confirmation at this receipt increment.** Download availability must be confirmed separately in the final delivery.

The archive is a lossless Zstandard-compressed tar stream, split into four consecutive byte ranges. It is not a four-member tar or ZIP collection. Reassemble all four parts in their numbered order before extraction. Keep original producer/campaign identities and refusals unchanged after extraction.

| Part | Bytes | SHA-256 |
| --- | ---: | --- |
| `tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part01` | 419,430,400 | `a6bd0edebcc3c1c6279583c777ca1c12b0d614f540600b08167e7f96185f742f` |
| `tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part02` | 419,430,400 | `d11e842ab0f4c940bf274b3da1ab51d2c3e825ae5c72b46353ff182b870753b1` |
| `tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part03` | 419,430,400 | `f318aa0ffbda0c07f0bd5547de3ed75412f80ae7f57af3c421305c270ad557d6` |
| `tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part04` | 200,750,413 | `a0ed012017fa1bc92fda2558ce76e4d87889f4600bd26a4e407a682394abc87c` |

The joined archive is **1,459,041,613 bytes**, SHA-256 **`f3ff1cd6a1e9b5a065f331be3dcda6a50deaef938444384142d9c0162a74602c`**. Its uncompressed tar-stream SHA-256 is `262a8fe0c74f376c4254c25f824d39f1cd4961d60517c0858595f201d6c98ca9`. Keeping the four parts, joined archive and extracted files simultaneously requires about 10.2 GB plus filesystem overhead.

## Verify, join and extract

Put the four downloaded parts and the JSON receipt in one directory. The following Bash sequence requires Python3, `zstd`, `sha256sum` and `tar`. It verifies every part before concatenation and verifies the joined archive before extracting into a new directory. The Python verifier streams file reads; it does not load the large archive into memory.

```sh
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import hashlib, json
receipt = json.loads(Path('tracing-js-original-corpus-evidence-2026-11-18-zstd.json').read_text())
for part in receipt['parts']:
    path = Path(part['file'])
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
            size += len(block)
    if size != part['bytes'] or digest.hexdigest() != part['sha256']:
        raise SystemExit(f'Part identity mismatch: {path}')
    print(f'Verified {path}: {size} bytes')
PY

cat tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part01 \
    tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part02 \
    tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part03 \
    tracing-js-original-corpus-evidence-2026-11-18.tar.zst.part04 \
  > tracing-js-original-corpus-evidence-2026-11-18.tar.zst
printf '%s  %s\n' \
  f3ff1cd6a1e9b5a065f331be3dcda6a50deaef938444384142d9c0162a74602c \
  tracing-js-original-corpus-evidence-2026-11-18.tar.zst | sha256sum --check -
zstd --test tracing-js-original-corpus-evidence-2026-11-18.tar.zst
mkdir original-corpus-evidence-2026-11-18
zstd --decompress --stdout tracing-js-original-corpus-evidence-2026-11-18.tar.zst \
  | tar --extract --file - --directory original-corpus-evidence-2026-11-18
```

The receipt's tar-stream digest offers an additional check without extracting a second copy:

```sh
set -euo pipefail
printf '%s  -\n' \
  262a8fe0c74f376c4254c25f824d39f1cd4961d60517c0858595f201d6c98ca9 \
  > original-evidence-tar-stream.sha256
zstd --decompress --stdout tracing-js-original-corpus-evidence-2026-11-18.tar.zst \
  | sha256sum --check original-evidence-tar-stream.sha256
```

The original learning-model archive is a separate gzip archive with its own receipt and SHA-256. Do not concatenate it with these parts. Recovered source data remain private audit artifacts under their recorded provenance/licensing boundaries; archive checksums establish byte identity, not new semantic admission or learned performance.
