#!/usr/bin/env python3
import gzip, hashlib, json, pathlib
root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'manifest.json').read_text())
for rel,meta in manifest['files'].items():
    raw=(root/rel).read_bytes()
    assert len(raw)==meta['bytes'] and hashlib.sha256(raw).hexdigest()==meta['sha256'], rel
log=gzip.decompress((root/'combined-job.log.gz').read_bytes())
assert len(log)==manifest['rawJobLog']['bytes']
assert hashlib.sha256(log).hexdigest()==manifest['rawJobLog']['sha256']
run=json.loads((root/'run-evidence.json').read_text())
qual=json.loads((root/'qualification-report.json').read_text())
package=json.loads((root/'package-report.json').read_text())
restore=json.loads((root/'restore-report.json').read_text())
artifact=json.loads((root/'artifact.json').read_text())['artifacts'][0]
assert run['runId']==45047889609 and run['jobConclusion']=='success'
assert (run['producerRevision'],run['consumerRevision'])==(
    'cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa',
    'cdd01ac0dcd65d92e948cec39f7b5c156800206e')
assert qual['status']=='passed' and qual['sourceQualified']==64 and qual['nativeAdmitted']==64
assert qual['splitCounts']=={'train':48,'validation':12,'test':4}
assert qual['ordinaryLifecycleOptimizerUpdates']==2
assert package['status']=='verified' and package['archive']['bytes']==70598150
assert restore['status']=='verified' and restore['decoderForwardPassesPerformed']==0
assert run['claims']['learnedSuccess'] is None and run['claims']['defaultPromotion'] is False
assert artifact['id']==14766156057 and artifact['size_in_bytes']==349488446
assert artifact['digest']=='sha256:806a2147e9fe3f142a4571fe98a6fae402bf3bec579269b46eea8b06f3453fce'
print('retained run evidence, reports, job log and artifact metadata verified')
