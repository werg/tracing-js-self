import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';

// Literal getter source follows the published 7fe5a9d5 fixture. Computed and
// alias forms are explicit derived regressions, not an unavailable external
// proof. Expected values come from fresh, uninstrumented Node executions.
const cases=[
  {
    "name": "positive-async-owned-return",
    "source": "\"use strict\";async function target(){return 1;}async function run(){const p=target();async function outer(){return p;}return await outer();}",
    "expected": 1,
    "boundary": null
  },
  {
    "name": "external-published-literal-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();Object.defineProperty(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "computed-binding-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperty(p,key,{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "computed-expression-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();Object.defineProperty(p,\"th\"+\"en\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "literal-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();p.then=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "computed-binding-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";p[key]=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "computed-expression-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();p[\"th\"+\"en\"]=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "aliased-promise-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const alias=p;Object.defineProperty(alias,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "aliased-object-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const O=Object;O.defineProperty(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "aliased-method-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const define=Object.defineProperty;define(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: unrepresentable captured cell"
    }
  },
  {
    "name": "destructured-method-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const {defineProperty:define}=Object;define(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: unrepresentable captured cell"
    }
  },
  {
    "name": "computed-object-assign-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.assign(p,{[key]:function(resolve){order+=\"t\";resolve(2);}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "owned-execution",
      "reason": "Object.assign needs a bounded ordinary data target"
    }
  },
  {
    "name": "computed-reflect-set-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Reflect.set(p,key,function(resolve){order+=\"t\";resolve(2);});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "owned-execution",
      "reason": "Reflect.set currently requires an owned module namespace"
    }
  },
  {
    "name": "computed-defineProperties-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperties(p,{[key]:{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "owned-execution",
      "reason": "Unsupported property receiver (no host fallback)"
    }
  },
  {
    "name": "aliased-setPrototypeOf",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const set=Object.setPrototypeOf;set(p,{then:function(resolve){order+=\"t\";resolve(2);}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: unrepresentable captured cell"
    }
  },
  {
    "name": "prototype-computed-then",
    "source": "\"use strict\";async function h(){return Promise.resolve(1);}async function run(){let order=\"\";const original=Promise.prototype.then;const key=\"then\";Promise.prototype[key]=function(resolve,reject){order+=\"t\";return original.call(this,resolve,reject);};const adopted=h();await adopted;return order;}",
    "expected": "t",
    "boundary": {
      "phase": "owned-execution",
      "reason": "Call adapter requires an owned function target"
    }
  },
  {
    "name": "aliased-promise-resolve-override",
    "source": "\"use strict\";async function h(){return Promise.resolve(1);}async function run(){const P=Promise;P.resolve=function(value){return {then:function(resolve){resolve(value+1);}};};return await h();}",
    "expected": 2,
    "boundary": {
      "phase": "owned-execution",
      "reason": "Not a writable guest object"
    }
  },
  {
    "name": "shadowed-promise-resolve",
    "source": "\"use strict\";async function h(Promise){return Promise.resolve(1);}async function run(){return await h({resolve:function(value){return Promise.resolve(value+1);}});}",
    "expected": 2,
    "boundary": null
  },
  {
    "name": "positive-unrelated-object-write",
    "source": "\"use strict\";async function h(o){o.x=2;return Promise.resolve(o.x);}async function run(){return await h({x:1});}",
    "expected": 2,
    "boundary": null
  },
  {
    "name": "evaluated-spread-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperty(...[p,key,{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}}]);async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "boundary": {
      "phase": "source-projection",
      "reason": "Effectful teacher projection: owned Promise adoption requires its resolved intrinsic then lookup"
    }
  },
  {
    "name": "caught-unmodeled-promise-descriptor",
    "source": "\"use strict\";async function run(){const p=Promise.resolve(1);try{Object.defineProperty(p,\"then\",{value:7});}catch(error){}return 7;}",
    "expected": 7,
    "boundary": null
  },
  {
    "name": "unmodeled-non-then-promise-property",
    "source": "\"use strict\";async function run(){const p=Promise.resolve(1);Object.defineProperty(p,\"x\",{value:3});return 7;}",
    "expected": 7,
    "boundary": null
  },
  {
    "name": "shadowed-object-define-property",
    "source": "\"use strict\";async function run(){const Object={defineProperty:function(target,key,descriptor){return target;}};const p=Promise.resolve(1);Object.defineProperty(p,\"then\",{value:5});return await p;}",
    "expected": 1,
    "boundary": null
  },
  {
    "name": "ordinary-object-descriptor",
    "source": "\"use strict\";function run(){const p={};Object.defineProperty(p,\"x\",{value:2,writable:true,enumerable:true,configurable:true});return p.x;}",
    "expected": 2,
    "boundary": null
  }
];
const observations=[],artifacts=[];let nativeReceipts=[];
const tagged=value=>[typeof value==='string'?'str':'num',value];
function ownedOutcome(runtime){
  const completion=runtime.state.control.a0.completion;assert.equal(completion.kind,'return');
  let value=completion.value;
  if(value[0]==='promise'){
    const promise=runtime.state.promises[value[1]];assert.equal(promise.status,'fulfilled');value=promise.value.value;
  }
  return {kind:'return',value};
}
if(process.env.REQUIRE_PROMISE_ADOPTION_V8==='1')
  assert(process.env.MEGATOKEN_ROOT,'Mandatory Promise mutation gate requires its exact native checkout');
function originalOutcome(source){
  const result=spawnSync(process.execPath,['-e','const originalThen=Promise.prototype.then,originalResolve=Promise.resolve.bind(Promise);'+source+
    ';originalThen.call(originalResolve(run()),value=>process.stdout.write(JSON.stringify({kind:"return",value})),error=>process.stdout.write(JSON.stringify({kind:"throw",name:error?.name,message:error?.message})));'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));return JSON.parse(result.stdout);
}
for(const scenario of cases)test('Promise mutation source boundary: '+scenario.name,async()=>{
  const original=originalOutcome(scenario.source);assert.deepEqual(original,{kind:'return',value:scenario.expected});
  const runtime=createRuntime().startEntry({text:scenario.source,functionName:'run',args:[],allowAsync:true});
  let bundle,projected,runtimeError,projectionError,owned;
  try{assert.equal(runtime.drive().kind,'terminated');bundle=runtime.exportRun();}catch(cause){runtimeError=cause;}
  if(scenario.boundary?.phase==='owned-execution'){
    assert(runtimeError,'the declared owned-execution boundary must refuse before source projection');
    assert.equal(runtimeError.name,'TypeError');assert.equal(runtimeError.message,scenario.boundary.reason);
    assert.equal(bundle,undefined);
  }else{
    assert.equal(runtimeError,undefined,runtimeError?.message);
    owned=ownedOutcome(runtime);
    assert.deepEqual(owned,{kind:'return',value:tagged(scenario.expected)},
      'source refusal must not conceal an incorrect owned result');
    try{projected=compileProtocolSourceV8(bundle);}catch(cause){projectionError=cause;}
    if(scenario.boundary){
      assert(projectionError,'the declared source-projection boundary must refuse direct compilation');
      assert.equal(projectionError.category,'unsupported.witness-projection');
      assert.equal(projectionError.message,scenario.boundary.reason);assert.equal(projected,undefined);
    }else{
      assert.equal(projectionError,undefined,projectionError?.message);
      assert.deepEqual(projected.outcome,{kind:'return',graph:{roots:[tagged(scenario.expected)],objects:[]}});
    }
  }
  const result=await verifyProtocolRegionTrainingCase({source:scenario.source,entry:'run',args:[],family:'promise-mutation-profile:'+scenario.name});
  if(scenario.boundary){
    assert.equal(result.exported,undefined,'refused source cannot provide native admission input');
    assert.equal(result.category,scenario.boundary.phase==='owned-execution'?
      'unsupported.protocol-source':'unsupported.witness-projection');
    assert.equal(result.reason,scenario.boundary.reason);
    const error=runtimeError??projectionError;
    observations.push({name:scenario.name,source:scenario.source,original,owned:owned??null,refused:true,
      refusalPhase:scenario.boundary.phase,directCategory:error.category??null,directReason:error.message,
      sourceCategory:result.category,sourceReason:result.reason});
  }else{
    assert(result.exported,result.reason);const check=await recheckProtocolRegionEvidence(result.exported);
    assert.equal(check.sourceValidated,true);const replay=RegionExecutionHarness.replay(result.exported);
    assert.deepEqual(replay.controller.completion,{kind:'return',value:tagged(scenario.expected)});
    artifacts.push({name:scenario.name,exported:result.exported,state:sharedRegionState(replay.controller)});
    observations.push({name:scenario.name,source:scenario.source,original,owned,refused:false,sourceValidated:true,contexts:result.exported.contexts.length});
  }
});
test('actual native independently replays every eligible mutation-boundary control',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,7);assert.equal(observations.filter(row=>row.refused).length,17);
  assert.equal(observations.filter(row=>row.refusalPhase==='owned-execution').length,5);
  assert.equal(observations.filter(row=>row.refusalPhase==='source-projection').length,12);
  const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    a=row['exported'];r=validate_v8_artifact(a)
    assert r['admitted'] is False
    assert all(r['checks'][k]=='passed' for k in ['replay','contexts','continuation'])
    state=_replay_shared_state(a['public']['timeline'],a['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
    assert state==row['state']
    out.append({'name':row['name'],'counts':r['counts']})
print(json.dumps(out))
`;
  const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python',['-c',script],{cwd:root,
    env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts=JSON.parse(result.stdout);
  assert.equal(nativeReceipts.length,7);
});
after(()=>{
  if(!process.env.RUNNER_TEMP)return;
  writeFileSync(join(process.env.RUNNER_TEMP,'promise-mutation-profile-evidence.json'),JSON.stringify({
    schema:'promise-mutation-profile-evidence/1',sourceCases:observations.length,refusedSources:observations.filter(r=>r.refused).length,
    eligibleSources:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
    generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
    ownedExecutionCases:observations.filter(row=>row.owned!==null).length,
    ownedRefusals:observations.filter(row=>row.refusalPhase==='owned-execution').length,
    sourceProjectionRefusals:observations.filter(row=>row.refusalPhase==='source-projection').length,
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,observations,cases:artifacts}));
});
