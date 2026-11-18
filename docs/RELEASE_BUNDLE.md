# Private semantic release bundles

`tools/package-semantic-release.py` qualifies and packages a completed durable
generation campaign. The bundle retains **every original candidate and attempt**,
including refusals, private source/reference evidence, public records, and any
compatibility exports. Training selection is a separate projection; it never
rewrites an original status, source identity, or frozen split.

Run the packager with the pinned native Python environment and the exact
producing checkout. A newer packaging checkout can qualify a historical corpus
through `--tracer-root`; its source verifier, native policy, dependency lock, and
environment checker come from that original producing checkout.

```sh
python tools/package-semantic-release.py \
  --corpus /path/to/completed-campaign \
  --tracer-root /path/to/exact-clean-producer \
  --megatoken /path/to/exact-clean-native-consumer \
  --tokenizer /path/to/tokenizer.json \
  --environment-receipt /path/to/native-environment.json \
  --max-family-tokens 100000 \
  --max-family-share 0.2 \
  --out /path/to/new-private-release
```

The supplied environment receipt must describe the actual current environment.
Packaging executes the original producer's `check_environment.py` again using
the running Python interpreter, compares the fresh result to the supplied
receipt, and retains both. A previously verified receipt cannot bypass a dirty
consumer, changed packages, changed tokenizer, or another failed current check.
Use the producer's required timezone, locale, installed consumer, and reference
isolation settings when collecting and packaging the corpus.

## Qualification and identity

The package holds a shared OS lock on the campaign for the entire operation, so
a generation writer cannot resume while the package is being produced. A
read-only verifier checks the complete append-only history, each committed
candidate/result binding, all referenced source/input/fixture/public/private
objects, and exact correspondence between the latest attempts and the campaign
manifest. Duplicate candidate IDs, omitted refusals, surplus disposition counts,
reused compatibility paths, symbolic links, stale summaries, and changed hashes
are rejected. Compact campaigns without compatibility JSON exports are supported.

Every admitted candidate is then requalified with the original producer's source
and replay checker and the actual pinned native consumer. Its public digest is
computed with the consumer's `public_digest`, independently of the manifest's
digest string. Fresh source receipts are cached only against a digest of the
entire unchanged public/private document. Native preparation runs its consumer
gate again on the selected documents.

The release records the original producer and native consumer revisions, the
packaging checkout revision and actual packaging-source hashes, exact tokenizer
identity, candidate identities, and checksums for the manifest, full campaign
verification, fresh native environment, qualification evidence, and selection
receipts. A packaging checkout with modified tracked files is explicitly marked
in the release; use a clean checkout for reproducible release evidence.

## Training token caps

Both cap options are optional. Omitting both preserves every admitted input in
its original order for native preparation. `--max-family-tokens` limits the sum
of freshly measured native `generatedTokens` in each frozen source component.
`--max-family-share` limits that component's share of selected **training** tokens.
The share denominator excludes validation and test tokens. Supplying one option
does not silently introduce the other limit.

Caps require authenticated `source-components/1` identities from one global
frozen source registry. Renamed descendants in the same connected component
share a budget. The selector reuses `balanceFamilyTokens`; selection is
deterministic by candidate ID. All original validation/test candidates are
supplied to native preparation without cap selection, and their frozen splits
are checked afterward. An impossible cap that removes every training candidate
fails with an explicit retained selection receipt.

Native deduplication may remove repeated training contracts under the existing
consumer policy. The packager therefore checks the actual prepared SQLite rows,
their native token counts, and their final training denominator as well. It
refuses a capped release if deduplication makes a component exceed the requested
share, removes every training token, or discovers a source ancestry join that
requires rebuilding the global registry. It also refuses moved splits, changed
token counts, unexpected native episodes, or omitted selected inputs.

The relevant artifacts are:

- `native-qualification.jsonl`: fresh source/native receipts for every original
  admitted candidate, including training examples excluded by the cap.
- `native-qualification-summary.json`: the exact qualification pins and totals.
- `training-selection-input.json`: qualified identities and measured token counts.
- `training-selection.json`: selected/excluded train IDs, exclusion reasons,
  unchanged held-out input IDs, and selected component token shares.
- `prepared-training-selection.json`: actual accepted native episodes, unchanged
  split checks, final component token shares, and native dedup dispositions.

Exclusion from training is not a source/native refusal. Original statuses and
all original evidence stay in `corpus/`. Source notices retain distinct
provenance/license records rather than overwriting a family's earlier notice.

## Archive verification and limits

Inventory hashing, tar writing, tar-member verification, and final archive
hashing use bounded streaming reads. Archive names must be canonical relative
paths. Duplicate paths, links, sparse/special files, unlisted members, changed
bytes, and oversized metadata are rejected. Normalized tar/gzip metadata makes
the same immutable inputs deterministic.

```sh
python tools/package-semantic-release.py --verify /path/to/semantic-v5-release.tar.gz
```

This verifies the archive's manifest identity and all file checksums without
extracting files. It does not execute source/native qualification again or
provide a publisher signature. Preserve the independently recorded archive
checksum when transferring the bundle.

The manifest metadata limit is 64 MiB. Each content-addressed candidate object
is limited to 256 MiB when loaded for semantic checks. The packager loads one
candidate at a time, but the pinned native preparation implementation may retain
audit sidecars and accepted-row metadata internally; streaming the archive does
not remove that consumer memory requirement.

Bundles are private audit artifacts. Upstream source notices are retained;
`repository-fixture` is provenance, not an SPDX license. Public distribution
approval is not inferred from native admission. Packaging performs zero optimizer
steps and makes no learned-success claim.
