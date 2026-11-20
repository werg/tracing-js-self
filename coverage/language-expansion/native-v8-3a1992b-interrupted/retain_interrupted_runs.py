#!/usr/bin/env python3
"""Retain superseded qualification attempts without promoting partial results."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
base, out = args.base, args.output
main = base / 'qualification-3a1992b'
superseded = read(main / 'superseded.json')
assert superseded['status'] == 'interrupted-superseded'
assert superseded['expansion']['recordedAttempts'] == superseded['expansion']['nativeAdmitted'] == 594
assert superseded['expansion']['untestedOrUncommitted'] == 71
assert sha(main / 'run.json') == superseded['runReceiptSha256']
for name, expected in [('interoperability', 23), ('gallery', 11)]:
    q, c = read(main / ('native-' + name) / 'report.json'), read(main / ('costs-' + name) / 'report.json')
    assert q['declared'] == q['sourceQualified'] == q['nativeAdmitted'] == expected
    assert c['summary']['flat']['tokenMeasuredEpisodes'] == c['summary']['nativePacking']['measuredEpisodes'] == expected
    assert c['qualification']['reportSha256'] == sha(main / ('native-' + name) / 'report.json')
    for directory, report in [(main / ('native-' + name), q), (main / ('costs-' + name), c)]:
        for filename, checksum in report['artifacts'].items():
            assert sha(directory / filename) == checksum
out.mkdir(exist_ok=False)
for name in ['run.json', 'superseded.json']:
    shutil.copyfile(main / name, out / name)
for name in ['run_final_qualification.py', 'retain-interrupted-native-inputs.mjs']:
    shutil.copyfile(base / 'qualification-tools' / name, out / name)
shutil.copyfile(__file__, out / Path(__file__).name)
archives = []
for directory, archive_name in [
    (main, 'original-3a1992b.tar.xz'),
    (base / 'qualification-f2fc630', 'startup-f2fc630.tar.xz'),
    (base / 'qualification-f2fc630-complete', 'interrupted-f2fc630.tar.xz'),
    (base / 'qualification-62eb943', 'interrupted-62eb943-e52a135.tar.xz'),
    (base / 'qualification-custom-iterator-653fd1b-a393a1c', 'custom-iterator-653fd1b-timeout.tar.xz'),
]:
    members = []
    for path in sorted(directory.rglob('*')):
        if not path.is_file() or path.name == '.campaign.lock' or 'tmp' in path.relative_to(directory).parts:
            continue
        assert not path.is_symlink()
        members.append({'path': directory.name + '/' + path.relative_to(directory).as_posix(), 'source': path,
                        'bytes': path.stat().st_size, 'sha256': sha(path)})
    if 'custom-iterator' in directory.name:
        for suffix in ['stdout.log', 'stderr.log']:
            path = directory.with_suffix('.' + suffix)
            members.append({'path': directory.name + '/' + suffix, 'source': path, 'bytes': path.stat().st_size, 'sha256': sha(path)})
        path = base / 'qualification-tools/qualify_custom_iterators.mjs'
        members.append({'path': directory.name + '/qualify_custom_iterators.mjs', 'source': path, 'bytes': path.stat().st_size, 'sha256': sha(path)})
    members.sort(key=lambda row: row['path'])
    archive = out / archive_name
    with tarfile.open(archive, 'w:xz', format=tarfile.PAX_FORMAT, preset=6) as tar:
        for row in members:
            entry = tarfile.TarInfo(row['path'])
            entry.size, entry.mode, entry.mtime = row['bytes'], 0o644, 0
            with row['source'].open('rb') as stream:
                tar.addfile(entry, stream)
    with tarfile.open(archive, 'r:xz') as tar:
        assert tar.getnames() == [row['path'] for row in members]
        for row in members:
            data = tar.extractfile(row['path']).read()
            assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
    archives.append({'file': archive_name, 'bytes': archive.stat().st_size, 'sha256': sha(archive), 'memberHashesRechecked': True,
                     'files': [{key: value for key, value in row.items() if key != 'source'} for row in members]})
    print(json.dumps({'archive': archive_name, 'bytes': archive.stat().st_size, 'verifiedMembers': len(members)}), flush=True)
index = {'schema': 'semantic-v8-interrupted-qualification-archives/1', 'archives': archives,
         'freshNativeExecution': False, 'scope': 'Unchanged historical run bytes and exact reconstructed native transports. No partial population is promoted to a complete run; no receipt is reassigned to a later revision.'}
(out / 'archive.json').write_text(json.dumps(index, indent=2) + '\n')
custom = read(base / 'qualification-custom-iterator-653fd1b-a393a1c/report.json')
assert custom['status'] == 'failed' and custom['nativeAdmitted'] == 14 and 'deadline exceeded' in custom['failure']
readme = '''# Superseded v8 qualification attempts

This package preserves the exact interrupted producer
`3a1992b4462e8e2affa6baa04e9075ba3b01d04a` / consumer
`418385b6880077b58bb5ae8f7ffeb7353a108d5d` run and the other superseded attempts.
Later shared protocol paths and iterable-destructuring frontend changes required
an independently executed complete final pair. The coordinator stopped this
older run with exit code 130 to prioritize that final qualification.

## Recorded 3a1992b results

| Population | Declared | Source qualified | Native admitted | Exact flat-token measurements | Remaining |
| --- | ---: | ---: | ---: | ---: | ---: |
| Interoperability | 23 | 23 | 23 | 23 | 0 |
| Original gallery | 11 | 11 | 11 | 11 | 0 |
| Expansion prefix | 665 | 594 | 594 | 0 | 71 untested or uncommitted |

There were zero recorded native failures in the 594 committed expansion
attempts. This is not a complete expansion pass. The remaining 71 case IDs are
listed in [superseded.json](superseded.json); any in-flight source artifacts do
not increase the committed count. No further expansion-cost, reference,
comparison or dataset stages were run after interruption.

The completed interoperability/gallery reports and exact physical costs remain
valid only at their recorded original pair. All source/admitted artifacts,
native receipts, token arrays, masks, progress journals and exact inputs are
retained in `original-3a1992b.tar.xz`. Native transport bytes for the 594 committed
prefix cases were reconstructed from the retained source artifacts and checked
against every live source-recheck receipt SHA-256. This integrity reconstruction
is not a new admission run.

The original [run.json](run.json) is unchanged, including its last in-progress
state. [superseded.json](superseded.json) explicitly records the termination,
replacement pair, completed counts, untested inventory and hash of that original
receipt. No historical command status was silently rewritten as a pass.

## Other preserved attempts

| Attempt | Exact scope and disposition |
| --- | --- |
| `f2fc630` startup | Failed during preflight because a dependency symlink appeared as an untracked source-tree entry; no population pass is claimed. |
| `f2fc630` / `7b36617` | Ten committed interoperability admissions before interruption when abrupt Number changes arrived; the remaining declared cases were not completed. |
| `62eb943` / `e52a135` | Twelve committed expansion admissions before interruption when the substantive native intrinsic-property guard change arrived; 653 cases were untested or uncommitted. |
| Custom iterators at `653fd1b` / `a393a1c` | Fourteen positive source/native/token admissions completed; the fifteenth source case verified but native admission exceeded its 120-second deadline. The final positive case and four declared source refusals did not run. |

The custom-iterator timeout occurred on `continue-outer-closes-inner-only`.
Its exact source result/artifact and exception are retained with all 14 completed
receipts and costs. No semantic pass is inferred for the timed-out native call,
and no unexecuted refusal is claimed. A later current-pair rerun uses its own
explicit bound and receipts; it does not replace this failed attempt.

## Retention and integrity

[archive.json](archive.json) binds every compressed archive and all uncompressed
members by byte length and SHA-256. Every member was rechecked after
decompression. The retained packaging helper and native-input reconstruction
helper reproduce those integrity checks. `SHA256SUMS` covers the complete
package. Integrity verification does not perform fresh native admission.

All completed and partial results remain attached to their exact source and
consumer commits. They are excluded from every final-pair population and dataset
denominator. The previously retained complete `b66c19b` qualification remains a
separate historical full run; this partial attempt does not overwrite it.
'''
(out / 'README.md').write_text(readme)
(out / 'SHA256SUMS').write_text(''.join(sha(path) + '  ' + path.name + '\n' for path in sorted(out.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'))
print(json.dumps({'output': str(out), 'archives': len(archives), 'verifiedMembers': sum(len(row['files']) for row in archives)}))
