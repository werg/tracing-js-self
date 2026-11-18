# Capability evidence

`required.json` indexes the current v5 contracts, measured ledger command and
release gates. It contains no inferred conformance percentage.

Run `npm run coverage:current -- --out /path/to/capabilities.json` to execute
the strict training probes. Each row reports parser, owned execution,
independent outcome, independent intermediate checks, public v5 replay,
native admission and model evaluation separately. Totals retain the attempted
denominator and distinguish unsupported, resource-limited and untested stages.
Native and model evidence require their actual environments and executed gates.

To measure native admission for the same feature probes, supply the pinned
consumer, Python, tokenizer and policy to `tools/generate-capability-ledger.mjs`:

```sh
node tools/generate-capability-ledger.mjs --out /path/to/native-capabilities.json \
  --megatoken /path/to/megatoken --python /path/to/python \
  --tokenizer /path/to/tokenizer.json \
  --native-policy contracts/native-admission-policy-v5.json
```

`--cases scalar-arithmetic,synchronous-primitive-throw` selects explicit probes
without changing their denominator. Native failures retain the passing earlier
stages and exit unsuccessfully; unsupported source is not counted as an
attempted native admission. Model evaluation remains untested by this command.

`npm run baseline:v5 -- --out /path/to/new-baseline --jobs 4` additionally
captures unit results, explicit skips, contract checks, trace inspection,
source registry and the three authored recipes. Its output binds the exact
producer revision, environment and lock hashes. Each new report uses a fresh
directory; historical evidence is never relabeled as a current result.

The byte-preserved `historical/required-pre-v5.json` was the earlier manually
maintained ledger. It mixes historical profile versions and is not a current
support or release claim. See [current status](../docs/STATUS.md) and
[release gates](../docs/RELEASE_GATES.md).
