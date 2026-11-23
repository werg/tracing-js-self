#!/usr/bin/env python3
"""Verify exact-pair retained bytes, actual JUnit populations and receipt bindings."""
import argparse,gzip,hashlib,json
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET

def require(ok,message):
    if not ok:raise ValueError(message)
def sha(data):return hashlib.sha256(data).hexdigest()

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--compare-originals',action='store_true')
args=parser.parse_args();base=Path(__file__).resolve().parent
manifest_bytes=(base/'manifest.json').read_bytes();manifest=json.loads(manifest_bytes)
require(manifest['schema']=='issue61-paired-component-retention/1','Unknown packet schema')
decoded={};compared=0
for row in manifest['files']:
    name=row['path'];require(Path(name).name==name and name not in decoded,'Invalid retained path')
    data=(base/name).read_bytes()
    require(len(data)==row['retainedBytes'] and sha(data)==row['retainedSha256'],'Retained bytes differ: '+name)
    require(data[:4]==b'\x1f\x8b\x08\x00' and data[4:8]==b'\0'*4,'Gzip timestamp differs: '+name)
    original=gzip.decompress(data)
    require(len(original)==row['sourceBytes'] and sha(original)==row['sourceSha256'],'Decoded bytes differ: '+name)
    if args.compare_originals:
        require(Path(row['sourcePath']).read_bytes()==original,'Original bytes differ: '+name);compared+=1
    decoded[name.removesuffix('.gz')]=original
read=lambda name:json.loads(decoded[name])
spec_bytes=(base/'gate-spec.json').read_bytes();spec=json.loads(spec_bytes)
require(sha(spec_bytes)==manifest['gateSpecSha256']==manifest['pair']['gateSpecSha256'],'Gate spec identity differs')
installed=read('installed-replay.json');result=read('local-promise-result.json')
require(installed['pair']==result['pair']==manifest['pair'],'Exact pair differs')
require(sha(decoded['installed-replay.json'])==result['installedReplaySha256'],'Installed receipt identity differs')
require(installed['installed']['importMode']=='isolated-installed-wheel','Installed import mode differs')
sources=installed['installed']['sourceReceipts']
require(len(sources)==len({row['id'] for row in sources})==spec['sourceExamples'],'Installed source population differs')
require(all(all(row['receipt']['checks'][key]=='passed' for key in ['replay','contexts','continuation']) for row in sources),
        'Installed source replay did not pass')
require(len(installed['payloads'])==7,'Shared payload count differs')
for suffix,key in [('', 'policySha256'),('.resolution.json','resolutionSha256')]:
    require(sha(decoded['semantic-native-policy-v8.json'+suffix])==manifest['pair'][key],'Frozen run policy differs')
summaries={}
for kind in ['native','producer']:
    data=decoded[kind+'.xml'];cases=list(ET.fromstring(data).iter('testcase'));counts=Counter();seen=set()
    for case in cases:
        require(not any(case.find(tag) is not None for tag in ['failure','error','skipped']),'Required testcase did not pass')
        if kind=='producer':source='test/'+Path(case.get('file','')).name
        else:
            parts=case.get('classname','').split('.')
            require(len(parts)>1 and parts[0]=='tests','Missing native testcase module');source='tests/'+parts[1]+'.py'
        identity=(source,case.get('classname'),case.get('name'))
        require(identity[2] and identity not in seen,'Duplicate or unnamed testcase');seen.add(identity);counts[source]+=1
    actual=dict(cases=len(cases),files=dict(counts),failures=0,errors=0,skipped=0,xmlSha256=sha(data))
    require(actual==manifest[kind]==result['promiseTests'][kind],'Actual JUnit population differs: '+kind)
    require(dict(counts)==spec['lanes']['promise'][kind],'Required per-file inventory differs: '+kind)
    summaries[kind]=actual
for population in result['sourcePopulations']:
    require(sha(decoded[population['file']])==population['sha256'],'Source packet identity differs: '+population['file'])
require(manifest['completeCombinedGate']==installed['completeCombinedGate']==result['completeCombinedGate']=='not-qualified',
        'Component evidence cannot qualify the complete gate')
require(manifest['fullGateBoundary']==result['strictAttestation'],'Full-gate boundary differs')
require(manifest['moduleAdmission'] is False and manifest['trainingAdmission'] is False and
        manifest['optimizerUpdates']==0 and manifest['learnedQuality'] is False,'Unexpected admission or quality claim')
print(json.dumps(dict(schema='issue61-paired-component-verification/1',valid=True,
    manifestSha256=sha(manifest_bytes),pair=manifest['pair'],verifiedFiles=len(decoded),originalFilesCompared=compared,
    installedSources=len(sources),installedPythonFiles=installed['installed']['verifiedPythonFiles'],
    sharedPayloads=len(installed['payloads']),sharedDecodedBytes=sum(row['decodedBytes'] for row in installed['payloads']),
    actualTests=summaries,completeCombinedGate='not-qualified',fullGateBoundary=manifest['fullGateBoundary']),indent=2))
