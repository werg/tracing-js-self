#!/usr/bin/env python3
"""Audit preserved qualification bytes and accounting; perform no guest/model execution."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-root', type=Path, default=HERE.parent)
parser.add_argument('--repository', type=Path, help='Repository containing the exact historical commits')
parser.add_argument('--output', type=Path, default=HERE / 'report.json')
args = parser.parse_args()
EVIDENCE = args.evidence_root.resolve()
REPOSITORY = (args.repository or EVIDENCE.parent.parent).resolve()
ROOT = EVIDENCE / 'native-v8-012c9fe-all'
AUDITED = '64239894b36607de1265b67c337f537f3fc9a163'
EVIDENCE_COMMITS = {
    'native-v8-012c9fe-all': '0ebbb1d3a3aeefee230bc70d591e472225534290',
    'dataset-v8-012c9fe-independent': '2cebc6123c2d5c2b22795e0160f68899de6001d7',
    'dataset-v8-012c9fe': '60fe332b7968c1c1f2fe696c642649bd301ad7c2',
}
PRODUCER = '012c9fe49a082319bf98ac0c571596da925741a4'
CONSUMER = '39c4036564428e44cc89caf261f517d856482695'
def sha(raw): return hashlib.sha256(raw).hexdigest()
def digest(obj): return sha(json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode())
def require(ok, reason):
    if not ok: raise ValueError(reason)


def git(*arguments):
    return subprocess.check_output(['git', '-C', str(REPOSITORY), *arguments])


def verified_members(root, index, *, member_key='name'):
    """Stream the exact indexed regular-file inventory without trusting paths."""
    archive = index['archive']
    path = root / archive.get('file', archive.get('path'))
    require(path.stat().st_size == archive.get('compressedBytes', archive.get('bytes'))
            and sha(path.read_bytes()) == archive['sha256'], str(path) + ' archive hash')
    expected = {row[member_key]: row for row in index['files']}
    require(len(expected) == len(index['files']), 'Unique indexed members')
    seen = set()
    with tarfile.open(path, 'r|xz') as handle:
        for member in handle:
            name = member.name
            require(member.isfile() and name in expected and name not in seen,
                    name + ' exact regular-file inventory')
            require(not Path(name).is_absolute() and '..' not in Path(name).parts,
                    name + ' relative archive path')
            seen.add(name)
            raw = handle.extractfile(member).read()
            require(len(raw) == member.size == expected[name]['bytes'] and
                    sha(raw) == expected[name]['sha256'], name + ' member hash')
            yield name, raw
    require(seen == set(expected), 'Complete indexed member inventory')


identities = {'auditedRevision': AUDITED, 'evidencePackages': {}, 'producerInputs': {}}
for package, origin in EVIDENCE_COMMITS.items():
    relative = 'coverage/language-expansion/' + package
    origin_tree = git('rev-parse', origin + ':' + relative).decode().strip()
    audited_tree = git('rev-parse', AUDITED + ':' + relative).decode().strip()
    require(origin_tree == audited_tree, package + ' unchanged evidence tree')
    checksums = (EVIDENCE / package / 'SHA256SUMS').read_bytes()
    require(checksums == git('show', AUDITED + ':' + relative + '/SHA256SUMS'),
            package + ' checksums bound to audited revision')
    checked = 0
    for line in checksums.decode().splitlines():
        expected, name = line.split('  ', 1)
        require(not Path(name).is_absolute() and '..' not in Path(name).parts,
                package + ' checksum path')
        require(sha((EVIDENCE / package / name).read_bytes()) == expected,
                package + '/' + name + ' package checksum')
        checked += 1
    identities['evidencePackages'][package] = {
        'originCommit': origin, 'tree': audited_tree,
        'checksumFileSha256': sha(checksums), 'packageFilesChecked': checked,
    }
for relative in ('src', 'tools', 'contracts', 'fixtures', 'package.json', 'package-lock.json'):
    historical = git('rev-parse', PRODUCER + ':' + relative).decode().strip()
    audited = git('rev-parse', AUDITED + ':' + relative).decode().strip()
    require(historical == audited, relative + ' identical producer input')
    identities['producerInputs'][relative] = audited

manifest=json.loads((ROOT/'archive.json').read_bytes())
summary=json.loads((ROOT/'report.json').read_bytes())
by_pop={p['id']:p for p in manifest['populations']}
summary_by_pop={p['id']:p for p in summary['populations']}
results=[]
file_hashes={}
for arc in manifest['archives']:
    path=ROOT/arc['file']
    require(path.stat().st_size==arc['compressedBytes'] and sha(path.read_bytes())==arc['sha256'], path.name+' compressed hash')
    expected={r['name']:r for r in arc['files']}
    require(len(expected)==len(arc['files']), 'Unique indexed member names')
    seen=set(); reports={}; inputs={}; receipts={}; serving={}
    with tarfile.open(path,'r|xz') as tf:
        for member in tf:
            require(member.isfile() and member.name in expected and member.name not in seen, member.name+' exact regular member inventory')
            seen.add(member.name)
            raw=tf.extractfile(member).read(); row=expected[member.name]
            actual=sha(raw); file_hashes[member.name]=actual
            require(len(raw)==member.size==row['bytes'] and actual==row['sha256'], member.name+' member hash')
            name=member.name
            if name.endswith('/report.json'): reports[name]=json.loads(raw)
            if '/qualification/' in name and name.endswith('.native-input.json'):
                d=json.loads(raw); inputs[Path(name).name.removesuffix('.native-input.json')]={
                    'sha256':actual, 'publicDigest':digest(d['public']), 'contextsDigest':digest(d['contexts']),
                    'sourceArtifactDigest':digest(d['sidecar']['sourceArtifact'])}
            if '/qualification/' in name and name.endswith('.native.json'):
                receipts[Path(name).name.removesuffix('.native.json')]=json.loads(raw)
            if '/costs/serving-' in name:
                d=json.loads(raw); total=generated=context=terminal=detailed=0
                require(d['measurement']=='passed', name+' measured')
                for r in d['rows']:
                    p,g,t=r['promptTokens'],r['generatedTokens'],r['terminalTokens']
                    require(sha(r['prompt'].encode())==r['promptSha256'] and sha(r['target'].encode())==r['targetSha256'],name+' physical bytes')
                    require(len(r['prompt'].encode())==r['promptBytes'] and len(r['target'].encode())==r['targetBytes'],name+' physical byte lengths')
                    require(t==1 and len(r['inputIds'])==p+g+t==r['totalTokens'],name+' physical sequence length')
                    require(r['inputIds'][-1]==d['eosTokenId'] and d['eosTokenId'] not in r['inputIds'][:-1],name+' EOS')
                    require(r['labels']==[-100]*p+r['inputIds'][p:],name+' loss masks')
                    total+=p+g+t; generated+=g; context+=p; terminal+=t; detailed+=g if r['detail'] else 0
                require(len(d['rows'])==d['predictions']==terminal,name+' prediction count')
                require(d['tokens']['total']==total and d['tokens']['generated']==generated and d['tokens']['observedAndContext']==context and d['tokens']['terminal']==terminal,name+' token totals')
                serving[Path(name).name.removeprefix('serving-').removesuffix('.json')]={'generated':generated,'terminal':terminal,'observedAndContext':context,'total':total,'detailed':detailed}
    require(seen==set(expected),path.name+' complete archive inventory')
    result={'archive':path.name,'members':len(seen),'uncompressedBytes':sum(v['bytes'] for v in expected.values()),'verified':True}
    if arc['file'] in ('all-artifacts.tar.xz','gallery-artifacts.tar.xz','interoperability-artifacts.tar.xz'):
        pop=arc['file'].removesuffix('-artifacts.tar.xz')
        q=reports[pop+'/qualification/report.json']; c=reports[pop+'/costs/report.json']; declared=by_pop[pop]
        require(q['producerRevision']==c['producerRevision']==PRODUCER,pop+' producer')
        require(q['nativePolicy']['consumerRevision']==CONSUMER,pop+' consumer')
        require(q['nativePolicy']==declared['nativePolicy'],pop+' native policy')
        require(file_hashes[pop+'/qualification/report.json']==declared['qualificationReportSha256'],pop+' qualification report binding')
        require(file_hashes[pop+'/costs/report.json']==declared['costReportSha256'],pop+' cost report binding')
        require(q['declared']==len(q['rows'])==q['sourceQualified']==q['nativeAdmitted'],pop+' full denominator')
        require(q['preparationOnly'] is False and q['optimizerSteps']==0,pop+' execution scope')
        ids=[r['id'] for r in q['rows']]
        require(len(set(ids))==len(ids) and set(ids)==set(inputs)==set(receipts)==set(serving),pop+' complete case receipts and physical data')
        for r in q['rows']:
            case=r['id']; receipt=receipts[case]; inp=inputs[case]; verification=receipt['sourceVerification']
            require(r['status']=='admitted' and r['source']==r['native']=='passed',pop+' row disposition '+case)
            require(receipt==r['nativeReceipt'],pop+' row receipt '+case)
            require(receipt['admitted'] is True and all(v=='passed' for v in receipt['checks'].values()),pop+' required native checks '+case)
            require(verification['producerRevision']==PRODUCER and receipt['consumerRevision']==CONSUMER,pop+' receipt pins '+case)
            require(all(verification[k] is True for k in ('producerTreeClean','sourceValidated','projectionValidated','replayValidated')),pop+' source authority '+case)
            require(verification['artifactSha256']==inp['sha256'],pop+' exact native transport '+case)
            for key in ('publicDigest','contextsDigest','sourceArtifactDigest'):
                require(receipt[key]==inp[key],pop+' native content binding '+case+' '+key)
            require(receipt['counts']['generatedTokens']==serving[case]['generated'],pop+' native and flat generated agreement '+case)
        for report,stage in ((q,'qualification'),(c,'costs')):
            for filename,expected_hash in report['artifacts'].items():
                require(file_hashes.get(pop+'/'+stage+'/'+filename)==expected_hash,pop+' exact artifact binding '+filename)
        totals={key:sum(row[key] for row in serving.values()) for key in ('generated','terminal','observedAndContext','total','detailed')}
        require(all(c['summary']['flat']['tokens'][key]==value for key,value in totals.items()),pop+' aggregate cost totals')
        require(c['summary']==summary_by_pop[pop]['costs'],pop+' published cost summary')
        result.update(population=pop,declared=q['declared'],admitted=len(ids),physicalPredictions=totals['terminal'],flatTokens=totals)
    results.append(result)
    print(json.dumps(result),flush=True)

# Original orchestration, streaming-meter and handoff records remain intact.
provenance = json.loads((ROOT / 'coordinated-provenance.json').read_bytes())
provenance_members = sum(1 for _ in verified_members(ROOT, provenance, member_key='path'))

# Independently compare every published dataset byte with its separate execution.
independent = EVIDENCE / 'dataset-v8-012c9fe-independent'
published = EVIDENCE / 'dataset-v8-012c9fe'
dataset_index = json.loads((independent / 'archive-index.json').read_bytes())
published_index = json.loads((published / 'archive-index.json').read_bytes())
args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='retained-audit-', dir=args.output.resolve().parent) as scratch:
    unpacked = Path(scratch)
    independent_members = 0
    for name, raw in verified_members(independent, dataset_index):
        target = unpacked / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        independent_members += 1
    dataset = unpacked / 'v8-dataset-012c9fe-independent'
    core_files = published_members = 0
    for name, raw in verified_members(published, published_index):
        relative = Path(*Path(name).parts[1:])
        if relative.as_posix() == 'candidates.jsonl' or relative.parts[0] in ('dataset', 'native-inputs'):
            require((dataset / relative).read_bytes() == raw, str(relative) + ' replicated dataset bytes')
            core_files += 1
        published_members += 1
    dataset_check = json.loads(subprocess.check_output([
        sys.executable, str(independent / 'verify.py'), str(dataset),
        '--producer-revision', PRODUCER, '--consumer-revision', CONSUMER,
    ]))
    require(dataset_check['passed'] and not dataset_check['freshNativeExecution']
            and not dataset_check['physicalTokenIdsReencoded'], 'Retained dataset check scope')

# Recompute cost pairing, totals and all regressions without invoking a tokenizer.
comparison = json.loads((ROOT / 'paired-serving-costs.json').read_bytes())
paired = [row for row in comparison['rows'] if row['status'] == 'paired']
totals = comparison['summary']
require(len(comparison['rows']) == totals['declaredRows'] and len(paired) == totals['paired'] == 42,
        'Complete comparison denominator')
require(dict(Counter(row['status'] for row in comparison['rows'])) == totals['dispositions'],
        'Complete pairing dispositions')
for row in paired:
    identity = row['identity']
    require(identity['baselineSourceDigest'] == identity['currentSourceDigest'] and
            identity['baselineEntry'] == identity['currentEntry'] and
            identity['baselineRootedInput']['digest'] == identity['currentRootedInput']['digest'],
            row['id'] + ' exact pairing identity')
    for side in ('before', 'after'):
        cost = row[side]
        require(cost['flatTotalTokens'] == cost['generatedTokens'] + cost['promptTokens'] + cost['terminalTokens'],
                row['id'] + ' comparison token sum')
for side in ('before', 'after'):
    for key, value in totals[side].items():
        values = [row[side][key] for row in paired]
        require((max(values) if key.startswith('peak') else sum(values)) == value,
                side + ' comparison aggregate ' + key)
for key, delta in totals['delta'].items():
    require(totals['after'][key] - totals['before'][key] == delta, 'Comparison delta ' + key)
regressions = [row['id'] for row in paired if row['after']['flatTotalTokens'] > row['before']['flatTotalTokens']]
require(regressions == totals['flatTokenRegressions'], 'Every individual cost regression retained')

report = {
    'schema': 'semantic-v8-completion-retained-audit/1', 'passed': True,
    'scope': 'Retained archive integrity, source/native receipt bindings, masks and physical cost accounting.',
    'freshNativeExecution': False, 'physicalTokenIdsReencoded': False,
    'freshSourceExecution': False, 'freshModelExecution': False,
    'producerRevision': PRODUCER, 'consumerRevision': CONSUMER,
    'identityChecks': identities, 'verifierSha256': sha(Path(__file__).read_bytes()),
    'archives': results, 'coordinatedProvenanceMembersVerified': provenance_members,
    'datasetReplication': {
        'independentMembersVerified': independent_members,
        'publishedMembersVerified': published_members, 'byteIdenticalCoreFiles': core_files,
        'retainedDatasetCheck': dataset_check,
    },
    'comparison': {'declaredRows': len(comparison['rows']), 'paired': len(paired),
                   'dispositions': totals['dispositions'], 'before': totals['before'],
                   'after': totals['after'], 'flatTokenRegressions': regressions},
}
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'report': str(args.output),
                  'provenanceMembers': provenance_members, 'datasetCoreFilesCompared': core_files}))
