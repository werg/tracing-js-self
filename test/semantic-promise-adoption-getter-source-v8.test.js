import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {PROMISE_ADOPTION_GETTER_FIXTURES_V8} from '../fixtures/semantic-regions/promise-adoption-getters.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const artifacts=[],nativeReceipts=[];
for(const fixture of PROMISE_ADOPTION_GETTER_FIXTURES_V8)test('source/reference adoption constructor: '+fixture.id,async()=>{
  const result=await verifyProtocolRegionTrainingCase(fixture);
  assert(result.exported,result.category+': '+result.reason);
  const checked=await recheckProtocolRegionEvidence(result.exported);
  assert.equal(checked.sourceValidated,true);assert.equal(checked.projectionValidated,true);assert.equal(checked.replayValidated,true);
  const replay=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(replay.controller.completion,{kind:'return',value:['str',fixture.expected]});
  assert(result.exported.public.timeline.some(event=>event.kind==='protocol'&&event.fields.line.includes('promise.adopt.get')));
  artifacts.push({name:fixture.id,exported:result.exported,state:sharedRegionState(replay.controller)});
});
test('adoption source retains explicit custom species and finally cleanup boundaries',async()=>{
  for(const body of [
    `const p=Promise.resolve(1);Object.defineProperty(p,'constructor',{get(){return {[Symbol.species]:Promise};}});async function h(){return p;}await h();return 1;`,
    `const p=Promise.resolve(1);await Promise.resolve(2).finally(()=>p);return 1;`
  ]){
    const result=await verifyProtocolRegionTrainingCase({id:'bounded-adoption-refusal',family:'promise-adoption-getter',
      source:'"use strict";async function run(){'+body+'}',entry:'run',args:[]});
    assert.equal(result.exported,undefined);assert.equal(result.status,'unsupported');
    assert.match(result.reason,/constructor\/species|finally completion|cleanup jobs/);
  }
});
test('native independently checks adoption constructor jobs, retained scopes and selected completions',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
    assert.equal(artifacts.length,PROMISE_ADOPTION_GETTER_FIXTURES_V8.length);
    const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import copy,json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
from megatoken.data.protocol_v8 import validate_protocol_state
out=[]
for row in json.load(sys.stdin):
    artifact=row['exported'];receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state'],row['name']
    bad_records=0
    for event in artifact['public']['timeline']:
        if event['kind']!='protocol':continue
        record=json.loads(event['fields']['line'][9:])
        if record['kind'] not in ['promise.adopt.get','promise.adopt.finish']:continue
        bad=copy.deepcopy(artifact)
        record['child']='unrelated-child'
        bad['public']['timeline'][event['sequence']-1]['fields']['line']='protocol '+json.dumps(record,separators=(',',':'),sort_keys=True)
        try:validate_v8_artifact(bad)
        except Exception:bad_records+=1
        else:raise AssertionError('accepted changed adoption getter scope')
    active=next(context['state'] for context in artifact['contexts'] if any((node.get('adoption') or {}).get('phase')=='reading' for _,node in context['state']['heap']))
    corruptions=[]
    changed=copy.deepcopy(active);changed['activeJob']='wrong-job';corruptions.append(changed)
    changed=copy.deepcopy(active);changed['receiver']=['undefined'];corruptions.append(changed)
    changed=copy.deepcopy(active);adopter=next(node for _,node in changed['heap'] if (node.get('adoption') or {}).get('phase')=='reading');adopter['adoption']['lookup']['child']='wrong-child';corruptions.append(changed)
    changed=copy.deepcopy(active);adopter=next(node for _,node in changed['heap'] if (node.get('adoption') or {}).get('phase')=='reading');dict(changed['jobs'])[adopter['adoption']['job']]['status']='completed';corruptions.append(changed)
    for changed in corruptions:
        try:validate_protocol_state(changed['protocol'],changed['heap'],changed)
        except Exception:pass
        else:raise AssertionError('accepted corrupt adoption getter continuation')
    out.append({'name':row['name'],'counts':receipt['counts'],'rejectedRecords':bad_records,'rejectedRestorations':len(corruptions)})
print(json.dumps(out))
`;
    const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python3',['-c',script],{cwd:root,
      env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts.push(...JSON.parse(result.stdout));
  });
after(()=>{
  if(process.env.ADOPTION_GETTER_CASES_OUT)writeFileSync(process.env.ADOPTION_GETTER_CASES_OUT,JSON.stringify(artifacts));
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-adoption-getter-source-evidence.json'),JSON.stringify({
    schema:'promise-adoption-getter-source-evidence/1',sourceCases:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
    generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
