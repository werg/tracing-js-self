#!/usr/bin/env python3
"""Compare a fresh independently admitted dataset with an untouched published archive."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--published', type=Path, required=True)
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--published-commit', required=True)
args = parser.parse_args()
external, own = args.published, args.run
index = read(external / 'archive-index.json')
archive_path = external / index['archive']['file']
assert archive_path.stat().st_size == index['archive']['compressedBytes']
assert digest(archive_path.read_bytes()) == index['archive']['sha256']
receipt = read(own / 'run.json')
assert receipt['status'] == 'passed' and receipt['identityUnchanged'] and receipt['pinsBefore'] == receipt['pinsAfter']
verification = read(own / 'dataset-verification.json')
assert verification['passed'] and verification['physicalTokenIdsReencoded'] and verification['byteRoundTripsRechecked']
actual = own / ('v8-dataset-' + receipt['pinsBefore']['producer']['revision'][:7])
manifest = read(actual / 'dataset/manifest.json')
assert (external / 'manifest.json').read_bytes() == (actual / 'dataset/manifest.json').read_bytes()
matched = []
with tarfile.open(archive_path, 'r:xz') as archive:
    assert archive.getnames() == [row['name'] for row in index['files']]
    for row in index['files']:
        member = archive.getmember(row['name'])
        assert member.isfile()
        data = archive.extractfile(member).read()
        assert len(data) == row['bytes'] and digest(data) == row['sha256']
        relative = Path(row['name']).relative_to(Path(row['name']).parts[0])
        core = relative.as_posix() == 'candidates.jsonl' or relative.parts[0] in {'dataset', 'native-inputs'}
        if core:
            local = actual / relative
            assert local.is_file() and local.stat().st_size == len(data) and digest(local.read_bytes()) == row['sha256']
            matched.append({'path': relative.as_posix(), 'bytes': len(data), 'sha256': row['sha256']})
assert len([row for row in matched if row['path'].endswith('.receipt.json')]) == 37
own_inputs, old_inputs = read(actual / 'inputs.json'), read(external / 'inputs.json')
assert own_inputs['producerRevision'] == old_inputs['producerRevision'] == index['producerRevision']
source_reports = []
for ours, prior in zip(own_inputs['sources'], old_inputs['sources']):
    assert {key: value for key, value in ours.items() if key != 'reportSha256'} == {key: value for key, value in prior.items() if key != 'reportSha256'}
    source_reports.append({'population': ours['population'], 'declared': ours['declared'], 'populationDigest': ours['populationDigest'],
        'independentReportSha256': ours['reportSha256'], 'publishedReportSha256': prior['reportSha256']})
assert read(own / 'dataset-input-check.json')['sourceArtifacts'] == read(external / 'qualification-input-check.json')['sourceArtifacts']
bindings = [json.loads(line) for line in (actual / 'native-inputs/bindings.jsonl').read_text().splitlines() if line]
native = []
for row in bindings:
    item = read(actual / 'native-inputs' / (row['id'] + '.receipt.json'))
    assert item['admitted'] and item['consumerRevision'] == index['consumerRevision']
    assert item['sourceVerification']['producerRevision'] == index['producerRevision']
    assert item['sourceVerification']['artifactSha256'] == row['sha256']
    assert all(value == 'passed' for value in item['checks'].values())
    native.append({'id': row['id'], 'sourceId': row['sourceId'], 'inputSha256': row['sha256'],
        **{key: item[key] for key in ['publicDigest', 'contextsDigest', 'sourceArtifactDigest', 'datasetBindingDigest', 'nativeTrainingDigest']}})
report = {'schema': 'semantic-v8-independent-dataset-replication/1', 'passed': True,
    'publishedCommit': args.published_commit, 'publishedPackage': 'coverage/language-expansion/dataset-v8-012c9fe',
    'independentPackage': 'coverage/language-expansion/dataset-v8-012c9fe-independent',
    'producerRevision': index['producerRevision'], 'consumerRevision': index['consumerRevision'],
    'publishedArchive': index['archive'], 'allPublishedArchiveMembersVerified': len(index['files']),
    'independentExecutionReceiptSha256': digest((own / 'run.json').read_bytes()),
    'publishedExecutionReceiptSha256': digest((external / 'run-receipt.json').read_bytes()),
    'manifestByteIdentical': True, 'candidatesByteIdentical': True, 'nativeInputsAndReceiptsByteIdentical': True,
    'allDatasetFilesByteIdentical': True, 'matchedCoreFiles': matched, 'sourceReportBindings': source_reports,
    'all37QualifiedSourceArtifactHashesEqual': True, 'nativeEpisodeIdentities': native,
    'episodes': manifest['episodes'], 'examples': manifest['examples'], 'generatedTokensWithEOS': manifest['generatedTokens'],
    'registryDigest': manifest['registryDigest'], 'registryMembers': manifest['registryMembers'],
    'registryComponents': manifest['registryComponents'], 'optimizerSteps': 0,
    'freshNativeExecutionInComparison': False,
    'scope': 'Independent completed qualification and dataset admission reproduced the published candidates, all dataset bytes and all37 native transports/receipts. Comparison verifies retained bytes; it does not rerun either admission, merge their input populations, increase unique-case counts, or overwrite the original published package.'}
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'publishedMembersVerified': len(index['files']), 'byteIdenticalCoreFiles': len(matched),
                  'nativeEpisodes': len(native), 'examples': sum(manifest['examples'].values())}))
