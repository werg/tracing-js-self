# Complete 32-case V8 source, native and token-cost qualification

The clean producer `a2a2067cc87a36f7636e6d32e603de3bf13beade` and clean consumer
`351c8f7aed56ac400d533156544e34a76ea3e5b5` passed every declared interoperability
case with the actual pinned production tokenizer. The population includes the
new Promise → Number → Proxy → binary memory → map callback → built-in iterator
→ Promise join/await source, with independently checked result 10.

| Measurement | Actual result |
| --- | ---: |
| Declared interoperability cases | 32 |
| Source-qualified cases | 32 |
| Independently native-admitted cases | 32 |
| Cases with exact flat token costs | 32 |
| Cases with native packing measurements | 32 |
| Cases containing compact regions | 15 |
| Wholly detailed cases | 17 |
| Compact / detailed generated records | 27 / 1,266 |
| Generated text tokens | 40,869 |
| Detailed generated text tokens | 39,890 (97.60%) |
| Flat framing terminal tokens | 1,293 |
| Flat observed and repeated context tokens | 2,231,289 |
| Flat peak context tokens | 3,597 |
| Native physical / logical records | 5,143 / 1,391 |
| Optimizer updates | 0 |

This is the complete **named interoperability population**, not the full edition,
all 665 expansion inputs, or a held-out model evaluation. The cost report keeps
flat serving-context serialization separate from native training packing. It
does not measure latency, model task success, cache savings or deployment
readiness. The high detailed-token share remains a material limitation. Default
promotion is explicitly `not-qualified`.

## Exact identities and retained evidence

The production tokenizer bytes have SHA-256
`40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`;
the native codec fingerprint is
`7f52faca2fe82273a889023defd2f1a6fd6080a21096ec77e97f4798a0a370b2`.
`summary.json` retains the complete native policy, population digest, exact
tokenizer evidence and aggregate report. Failed earlier pairs remain in their
original evidence directories; this result does not relabel them or qualify
later executable changes.

The four archive parts contain **268 original files / 148,229,832 uncompressed
bytes**: the frozen population and inputs, every original source export, native
admission and receipt, progress journals, complete cost rows and both command
logs. Every member was decompressed and verified against its original SHA-256
and byte length. The combined archive is 8,387,564 bytes, with SHA-256
`70e7bf06f96cda75a5b208eeeb9fa8d448c93557cd91a8730e618d0164489489`.

Reassemble and verify it from this directory:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
archive = json.loads(Path('inventory.json').read_text())['archive']
digest = hashlib.sha256()
with Path(archive['file']).open('wb') as output:
    for part in archive['parts']:
        data = Path(part['file']).read_bytes()
        assert len(data) == part['bytes']
        assert hashlib.sha256(data).hexdigest() == part['sha256']
        digest.update(data)
        output.write(data)
assert digest.hexdigest() == archive['sha256']
assert Path(archive['file']).stat().st_size == archive['bytes']
PY
mkdir restored
tar -xzf complete-admission-and-costs.tar.gz -C restored
```

## Reproduction commands

Use clean checkouts at the exact revisions, install the locked native
dependencies, and point Python at that consumer's `src` directory. With the
actual tokenizer verified, the commands are:

```sh
node tools/qualify-semantic-v8.mjs --out "$QUALIFICATION" \
  --megatoken "$CONSUMER" --tokenizer "$TOKENIZER" --python "$PYTHON" \
  --native-policy contracts/semantic-native-policy-v8.json --workers 2
MEGATOKEN_ROOT="$CONSUMER" MEGATOKEN_TOKENIZER_JSON="$TOKENIZER" \
  MEGATOKEN_PYTHON="$PYTHON" node tools/measure-semantic-v8.mjs \
  --qualification "$QUALIFICATION" --out "$COSTS" \
  --tokenizer-module tools/semantic-v8-tokenizer-adapter.mjs
```

Original reports retain their recorded checkout and temporary paths. A new run
must create its own artifacts rather than rewriting these identities.
