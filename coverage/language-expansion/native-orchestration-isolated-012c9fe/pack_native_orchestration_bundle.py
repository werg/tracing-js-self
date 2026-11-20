"""Retain exact served bytes for the isolated native lifecycle diagnostic."""

import gzip
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

root = Path('/workspace/scratch/754a49249d01')
base = root / 'native-orchestration-isolated-012c9fe-39c4036'
served = root / 'native-v8-cli-smoke/served'
receipt = json.loads((base / 'run.json').read_text())
assert receipt['status'] in {'passed', 'failed'}
assert receipt['identityUnchanged']
archive = base / 'served-bundle.tar.gz'
assert not archive.exists()
members = []
with archive.open('wb') as target:
    with gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0, compresslevel=6) as stream:
        with tarfile.open(fileobj=stream, mode='w|') as output:
            for relative, identity in receipt['identities']['served'].items():
                path = served / relative
                data = path.read_bytes()
                assert hashlib.sha256(data).hexdigest() == identity['sha256']
                name = 'served/' + relative
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                with path.open('rb') as source:
                    output.addfile(info, source)
                members.append({'path': name, 'bytes': len(data), 'sha256': identity['sha256']})
with tarfile.open(archive) as source:
    expected = {member['path']: member for member in members}
    assert set(source.getnames()) == set(expected)
    for member in source.getmembers():
        data = source.extractfile(member).read()
        assert len(data) == expected[member.name]['bytes']
        assert hashlib.sha256(data).hexdigest() == expected[member.name]['sha256']
parts = []
with archive.open('rb') as source:
    index = 0
    while block := source.read(4 * 1024 * 1024):
        part = base / f'served-bundle.tar.gz.part-{index:02}'
        part.write_bytes(block)
        parts.append({'path': part.name, 'bytes': len(block),
                      'sha256': hashlib.sha256(block).hexdigest()})
        index += 1
manifest = {'schema': 'isolated-native-served-bundle-archive/1',
            'scope': receipt['substitution'],
            'archive': {'path': archive.name, 'bytes': archive.stat().st_size,
                        'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()},
            'parts': parts, 'members': members,
            'verified': True, 'instructions': 'Concatenate parts in numeric order, check the combined archive SHA256, and extract into a new directory. Use the served/ directory for MEGATOKEN_ORCHESTRATION_SERVED with the exact source/native revisions and unchanged test command in plan.json.'}
(base / 'served-bundle-archive.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copyfile(__file__, base / Path(__file__).name)
print(json.dumps({'manifest': str(base / 'served-bundle-archive.json'),
                  'bytes': archive.stat().st_size, 'parts': len(parts), 'members': len(members)}))
