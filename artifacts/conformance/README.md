# Frozen Test262 inventory

`test262-d53ebc8b-frozen-catalog.json.xz` retains the complete catalog of the
`test/` and `harness/` trees at upstream `tc39/test262` commit
`d53ebc8b1931d9f1541e43d59650776e4b766248`. It contains paths, exact Git blob and
SHA-256 identities, metadata, variant modes, harness and module dependencies,
resource policy, and explicit scope classifications. It contains no test bodies.

The catalog has 53,974 files: 53,616 standalone tests, 294 fixture files, 43
JavaScript harness files, and 21 other resources. It has 102,994 variants, no
unresolved metadata, and no missing default or named harness files. Every
edition classification is `unclassified`. This original catalog retains its
pre-pin profile and remains unchanged; later campaigns derive a new profile
bound to the pinned specification below. Acquiring the full Test262 tree does
not establish full ECMAScript edition coverage or any passing conformance result.

| Identity | Value |
| --- | --- |
| Upstream tree | `befe78ff4f2fe67154f777d7449a5a330a680a1d` |
| Catalog canonical digest | `2e1c7727c58d41822edaac2294761baa550a8ad7be8f5dcfedbfc7b779457299` |
| Compressed artifact SHA-256 | `4d1db1374e7901737eee9bd8ac3b88c92f9a31c133ba4ba9bdb330e2a8d8890c` |
| Compressed bytes | 10,902,500 |
| Uncompressed compact JSON bytes | 107,347,489 |

## Normative ECMAScript 2026 specification pin

Ecma International publishes the ECMAScript 2026 language specification as
ECMA-262 17th edition, June 2026. Its publication page identifies HTML as the
normative copy and PDF as a print rendering. The pinned source is the official,
edition-specific single-page HTML at
[`https://262.ecma-international.org/17.0/index.html`](https://262.ecma-international.org/17.0/index.html),
not the moving `tc39.es/ecma262/` draft.

The uncompressed response is 8,348,904 bytes with SHA-256
`5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a`. It is
retained byte-for-byte as
[`ecma262-17.0-index.html.xz`](ecma262-17.0-index.html.xz). The compressed
archive is 536,148 bytes with SHA-256
`37d455e2c206604894fa4031484a73dbf7af368447a0cb9decc18c07cac725f4`.
Acquisition metadata, including the official URL, retrieval time, ETag,
Last-Modified value, byte counts, and both digests, is in
[`ecma262-17.0.json`](ecma262-17.0.json). The retained original HTML still
contains the complete Ecma copyright notice and license in section 39 without
source modification. That notice grants redistribution subject to its stated
notice, disclaimer, and change-notice conditions.

Verify the retained bytes using the same loader that new campaigns call:

```sh
node --input-type=module - <<'JS'
import {readPinnedEcma262Specification} from './src/conformance/test262-specification.js';
const {manifest,specification}=readPinnedEcma262Specification();
console.log(JSON.stringify({manifest,specification}));
JS
```

The historical catalog still has `specification: null` and all edition
classifications remain `unclassified`. New campaign execution verifies the
actual decompressed HTML bytes against the pinned URL, size, and digest before
binding the profile. This establishes the selected annual specification bytes,
not a full edition inventory or conformance result.

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

## Execute the complete retained module-reference shard

Materialize the exact Test262 checkout outside the producer repository. The
campaign acquisition verifies that checkout's `HEAD` and every upstream `test/`
and `harness/` Git blob before it executes a selected variant:

```sh
git clone --filter=blob:none https://github.com/tc39/test262 ../test262-upstream
git -C ../test262-upstream checkout --detach d53ebc8b1931d9f1541e43d59650776e4b766248
```

Then run all 843 frozen module variants. The case IDs are derived after binding
the current runner profile, and the campaign retains all 102,994 rows; other
modes stay `not_selected`, while the 353 module rows with unresolved graphs
remain selected and receive an explicit environment disposition. The owned
module stage is included so its current lack of a qualified linker remains
visible.

```sh
node --input-type=module <<'JS'
import {spawnSync} from 'node:child_process';
import {readTest262Json} from './src/conformance/test262-campaign.js';
import {bindTest262CatalogProfile} from './src/conformance/test262-catalog.js';
import {ownedTest262Profile} from './src/conformance/test262-runner.js';
import {readPinnedEcma262Specification} from './src/conformance/test262-specification.js';
const loaded=readTest262Json('artifacts/conformance/test262-d53ebc8b-frozen-catalog.json.xz');
const base=loaded.catalog??loaded;
const profile=ownedTest262Profile({specification:readPinnedEcma262Specification().specification});
const catalog=bindTest262CatalogProfile(base,profile);
const ids=catalog.variants.filter(row=>row.mode==='module').map(row=>row.id);
if(ids.length!==843)throw new Error('Frozen module population changed: '+ids.length);
const result=spawnSync(process.execPath,['tools/run-test262-campaign.mjs',
  '--suite-root','../test262-upstream',
  '--out','../test262-d53ebc8b-module-reference-campaign.json',
  '--stages','parse,owned,reference','--cases',ids.join(',')],{stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
JS
```

No test result from this campaign should be described as full ECMAScript 2026
conformance. In particular, it is a module-only execution shard against the
full retained denominator; unresolved graph, host, timeout, unsupported, and
failure dispositions remain in the report.
