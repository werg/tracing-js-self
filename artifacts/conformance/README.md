# Frozen Test262 inventory

`test262-d53ebc8b-frozen-catalog.json.xz` retains the complete catalog of the
`test/` and `harness/` trees at upstream `tc39/test262` commit
`d53ebc8b1931d9f1541e43d59650776e4b766248`. It contains paths, exact Git blob and
SHA-256 identities, metadata, variant modes, harness and module dependencies,
resource policy, and explicit scope classifications. It contains no test bodies.

The catalog has 53,974 files: 53,616 standalone tests, 294 fixture files, 43
JavaScript harness files, and 21 other resources. It has 102,994 variants, no
unresolved metadata, and no missing default or named harness files. Every
edition classification is `unclassified`; specification bytes are not pinned.
Acquiring the full Test262 tree does not establish full ECMAScript edition
coverage or any passing conformance result.

| Identity | Value |
| --- | --- |
| Upstream tree | `befe78ff4f2fe67154f777d7449a5a330a680a1d` |
| Catalog canonical digest | `2e1c7727c58d41822edaac2294761baa550a8ad7be8f5dcfedbfc7b779457299` |
| Compressed artifact SHA-256 | `4d1db1374e7901737eee9bd8ac3b88c92f9a31c133ba4ba9bdb330e2a8d8890c` |
| Compressed bytes | 10,902,500 |
| Uncompressed compact JSON bytes | 107,347,489 |

## Reproduce and inspect

Check out the exact upstream commit and run from the producer repository:

```sh
node tools/catalog-test262.mjs \
  --suite-root ../test262-upstream \
  --revision d53ebc8b1931d9f1541e43d59650776e4b766248 \
  --out ../test262-full-catalog.json
```

The acquisition verifies each working file against its pinned Git blob, including
binary resources. The command creates a full catalog and a campaign whose stages
are all `not_run`; it executes zero tests. The catalog also binds its declared
parser and resource policy, so changing those inputs changes its digest. The
campaign additionally binds the implementation revision and source fingerprints;
it cannot resume under an incompatible implementation.

The retained file omits that large, redundant initial campaign. Recreate one
with `createTest262Campaign` from `src/conformance/test262-catalog.js` using the
current explicit implementation identity. This retains all variants and does
not infer any passing stage from catalog membership.

Extract and validate the retained catalog without the upstream checkout:

```sh
python3 - <<'PY'
import lzma
from pathlib import Path
source = Path('artifacts/conformance/test262-d53ebc8b-frozen-catalog.json.xz')
Path('test262-frozen-catalog.json').write_bytes(lzma.decompress(source.read_bytes()))
PY
node --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
import {validateTest262Catalog} from './src/conformance/test262-catalog.js';
const catalog=JSON.parse(readFileSync('test262-frozen-catalog.json','utf8'));
validateTest262Catalog(catalog);
console.log(catalog.digest,catalog.summary);
JS
```

The archive was produced by extracting the `catalog` field from the CLI output,
serializing compact JSON with a final newline, and compressing it with Python
`lzma` preset 6. Its acquisition profile is a frozen inventory profile, not a
qualified original-source runner profile. Actual execution campaigns must bind
the implemented parser, harness, host capabilities, and resource policy they use.
