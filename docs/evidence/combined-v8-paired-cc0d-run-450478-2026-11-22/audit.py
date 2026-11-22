#!/usr/bin/env python3
import hashlib, json, pathlib, xml.etree.ElementTree as ET
root=pathlib.Path(__file__).resolve().parent
man=json.loads((root/'manifest.json').read_text())
for rel,info in man['files'].items():
    raw=(root/rel).read_bytes()
    assert len(raw)==info['bytes'] and hashlib.sha256(raw).hexdigest()==info['sha256'], rel
summary=json.loads((root/'audit-result.json').read_text())['summary']
assert summary['nativeRecovery']==165 and summary['producerRecovery']==193
assert summary['nativePromise']==106 and summary['producerPromise']==173
for p in root.glob('lanes/**/*.xml'):
    tree=ET.parse(p); cases=tree.findall('.//testcase')
    assert len(cases)>0, p
    for case in cases:
        assert not case.findall('failure') and not case.findall('error') and not case.findall('skipped'), p
producer={lane:sum(len(ET.parse(p).findall('.//testcase')) for p in (root/'lanes'/lane).glob('producer.xml')) for lane in ['bootstrap-history','commit-history','promise','structural','terminal-history','transport']}
native={lane:sum(len(ET.parse(p).findall('.//testcase')) for p in (root/'lanes'/lane).glob('native.xml')) for lane in ['promise','structural']}
assert sum(v for k,v in producer.items() if k!='promise')==193, producer
assert producer['promise']==173, producer
assert sum(native.values())==271 and native=={'promise':106,'structural':165}, native
print('retained manifest and JUnit checks passed')
