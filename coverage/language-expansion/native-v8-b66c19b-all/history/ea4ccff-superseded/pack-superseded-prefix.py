#!/usr/bin/env python3
"""Retain the explicitly superseded pre-graph-normalization attempt prefix."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import tarfile


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--supplements', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--input-verifier', type=Path, required=True)
args = parser.parse_args()
root, extra, out = args.source, args.supplements, args.output
out.mkdir(exist_ok=False)
members, excluded = [], []
for path in sorted(root.rglob('*')):
    assert not path.is_symlink(), 'No symlinks permitted'
    if not path.is_file():
        continue
    rel = path.relative_to(root)
    item = {'name': root.name + '/' + rel.as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path)}
    if path.name == '.campaign.lock':
        assert path.stat().st_size == 0
        excluded.append({**item, 'reason': 'Empty transient process lock; authoritative campaign journal and objects retained.'})
        continue
    if len(rel.parts) > 2 and rel.parts[1] == 'native':
        value = read(path)
        matches = [other for other in (root / rel.parts[0]).glob('*.source.json') if read(other) == value]
        assert len(matches) == 1, 'Only proven duplicate temporary native inputs may be excluded'
        duplicate = matches[0]
        excluded.append({**item, 'reason': 'Temporary uncommitted native transport duplicates the retained source artifact; no admission receipt exists.',
                         'retainedEquivalentSource': root.name + '/' + duplicate.relative_to(root).as_posix(),
                         'retainedEquivalentSourceSha256': sha(duplicate)})
        continue
    members.append((item, path))
for path in sorted(extra.rglob('*')):
    if path.is_file():
        members.append(({'name': root.name + '/reconstructed-native-inputs/' + path.relative_to(extra).as_posix(),
                         'bytes': path.stat().st_size, 'sha256': sha(path)}, path))
members.sort(key=lambda pair: pair[0]['name'])


def build(path):
    with tarfile.open(path, 'w:xz', preset=6, format=tarfile.USTAR_FORMAT) as archive:
        for item, source in members:
            info = tarfile.TarInfo(item['name'])
            info.size, info.mode, info.mtime = item['bytes'], 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with source.open('rb') as stream:
                archive.addfile(info, stream)


archive_path = out / 'superseded-prefix.tar.xz'
repeat_path = out / 'repeat.tar.xz'
build(archive_path)
build(repeat_path)
archive_sha = sha(archive_path)
assert sha(repeat_path) == archive_sha
repeat_path.unlink()
with tarfile.open(archive_path) as archive:
    assert archive.getnames() == [item['name'] for item, _ in members]
    for item, source in members:
        assert sha(source) == item['sha256'], 'Source changed during retention'
        entry = archive.getmember(item['name'])
        assert entry.isfile() and entry.size == item['bytes']
        digest = hashlib.sha256()
        with archive.extractfile(entry) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        assert digest.hexdigest() == item['sha256']
index = {'schema': 'superseded-qualification-retention/1', 'status': 'superseded-not-final-evidence',
         'producerRevision': 'ea4ccffc1ea1c5f57ff9b94b2ad4c51cfc60c709',
         'consumerRevision': '6adf99f1301557ee5b95269581a3acd4162496b4',
         'selection': 'All original regular files retained except empty campaign locks and temporary native inputs independently confirmed equal to retained uncommitted source artifacts. No worker files were present. All reports, attempts, receipts, source/admitted artifacts, complete journal/object stores, logs, setup refusal and dispositions are retained unchanged. Supplemental exact transports are reconstructed and matched to retained live receipt SHA256 values.',
         'archive': {'file': archive_path.name, 'sha256': archive_sha, 'compressedBytes': archive_path.stat().st_size},
         'deterministic': {'format': 'USTAR/XZ preset6; sorted regular files; mode0644; zero mtime/uid/gid; empty owner names',
                           'secondBuildSha256': archive_sha, 'identicalBuilds': True, 'allMembersVerifiedAfterDecompression': True},
         'files': [item for item, _ in members], 'excluded': excluded}
(out / 'archive-index.json').write_text(json.dumps(index, indent=2) + '\n')
for name in ['all-disposition.json', 'interoperability-disposition.json']:
    shutil.copyfile(root / name, out / name)
shutil.copyfile(extra / 'verification.json', out / 'verification.json')
shutil.copyfile(args.input_verifier, out / args.input_verifier.name)
shutil.copyfile(Path(__file__), out / Path(__file__).name)
readme = '''# Superseded qualification prefix at ea4ccff

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
node verify-superseded-inputs.mjs \\
  unpacked/pre-graph-normalization-ea4ccff new-verified-transports
```

The helper writes only to its new output directory. Final qualification must be
read from the separately retained corrected producer run.
'''
(out / 'README.md').write_text(readme)
(out / 'SHA256SUMS').write_text(''.join(sha(path) + '  ' + path.name + '\n' for path in sorted(out.iterdir()) if path.is_file()))
print(json.dumps({'output': str(out), 'archiveSha256': archive_sha, 'compressedBytes': archive_path.stat().st_size,
                  'retainedFiles': len(members), 'excludedFiles': len(excluded), 'deterministic': True,
                  'allMemberHashesVerified': True}, indent=2))
