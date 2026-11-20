# Superseded qualification prefix at ea4ccff

These attempts were stopped or set aside after an independently reproduced live
graph-valued observation bug broke public context agreement and checkpoint
restoration. They are **superseded evidence, not the final candidate qualification**.
The exact producing revisions were producer
`ea4ccffc1ea1c5f57ff9b94b2ad4c51cfc60c709` and consumer
`6adf99f1301557ee5b95269581a3acd4162496b4`.

The 665-case expansion run committed 102 attempt rows with recorded native
admission before interruption, leaving 563 cases untested or uncommitted. Three
additional source artifacts were written before their native attempts committed;
they remain in the archive and are not counted as native admissions. The
interoperability run completed all 23 rows just before the stop, with 23 recorded
source/native admissions. Its completion does not resolve the separately found
graph bug or qualify the final corrected producer. Gallery qualification, token
cost measurement and dataset export had not started.

The completed reference run is retained under its original producer pin. It
records 624 executions across 208 positive inputs and 52 distinguishing pairs;
it does not establish correctness outside that declared population. The initial
interoperability startup refusal, caused by Python importing an older editable
consumer checkout, is also retained separately. The corrected invocation set
`PYTHONPATH` to the frozen consumer checkout before executing cases.

`superseded-prefix.tar.xz` contains unchanged reports, attempts, source/admitted
artifacts, native receipts, complete progress journals and objects, logs,
disposition metadata and the reference outputs. `archive-index.json` specifies
every retained and excluded path with exact length and SHA-256. Only two empty
process locks and three temporary uncommitted native inputs were excluded; each
temporary input was independently confirmed equal to a retained source artifact.
There were no worker scratch files in this stopped tree.

The supplemental `reconstructed-native-inputs` directory contains all 125 exact
committed native transports, reconstructed as `JSON.stringify(source)` plus a
newline and checked against each original live source receipt's SHA-256. The
independent integrity check additionally verified both campaign identities,
all journal hashes and predecessor links, compressed and uncompressed object
hashes, exact attempt/result equality and every committed artifact hash.
`verification.json` records this check. It performs no new native execution and
makes no learning or default-promotion claim.

The archive uses sorted regular files, USTAR, XZ preset 6, mode0644, zero
mtime/uid/gid and empty owner names. Two builds produced identical bytes; every
member hash was checked after decompression and the original files were checked
again for concurrent changes. The preparation and packing scripts are retained.

```sh
sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xJf superseded-prefix.tar.xz -C unpacked
node verify-superseded-inputs.mjs \
  unpacked/pre-graph-normalization-ea4ccff new-verified-transports
```

The helper writes only to its new output directory. Final qualification must be
read from the separately retained corrected producer run.
