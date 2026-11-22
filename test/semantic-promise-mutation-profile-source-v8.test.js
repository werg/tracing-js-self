import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {compileSourceProjection} from '../src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../src/semantic/source-compiler-v8.js';
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
    "refuse": false,
    "profileRefusal": false
  },
  {
    "name": "external-published-literal-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();Object.defineProperty(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "computed-binding-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperty(p,key,{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "computed-expression-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();Object.defineProperty(p,\"th\"+\"en\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "literal-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();p.then=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "computed-binding-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";p[key]=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "computed-expression-own-then-assignment",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();p[\"th\"+\"en\"]=function(resolve){order+=\"t\";resolve(2);};async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "aliased-promise-own-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const alias=p;Object.defineProperty(alias,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "aliased-object-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const O=Object;O.defineProperty(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "aliased-method-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const define=Object.defineProperty;define(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "destructured-method-defineProperty",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const {defineProperty:define}=Object;define(p,\"then\",{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "computed-object-assign-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.assign(p,{[key]:function(resolve){order+=\"t\";resolve(2);}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "computed-reflect-set-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Reflect.set(p,key,function(resolve){order+=\"t\";resolve(2);});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "computed-defineProperties-then",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperties(p,{[key]:{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "aliased-setPrototypeOf",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const set=Object.setPrototypeOf;set(p,{then:function(resolve){order+=\"t\";resolve(2);}});async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "t2",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "prototype-computed-then",
    "source": "\"use strict\";async function h(){return Promise.resolve(1);}async function run(){let order=\"\";const original=Promise.prototype.then;const key=\"then\";Promise.prototype[key]=function(resolve,reject){order+=\"t\";return original.call(this,resolve,reject);};const adopted=h();await adopted;return order;}",
    "expected": "t",
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "aliased-promise-resolve-override",
    "source": "\"use strict\";async function h(){return Promise.resolve(1);}async function run(){const P=Promise;P.resolve=function(value){return {then:function(resolve){resolve(value+1);}};};return await h();}",
    "expected": 2,
    "refuse": true,
    "profileRefusal": false
  },
  {
    "name": "shadowed-promise-resolve",
    "source": "\"use strict\";async function h(Promise){return Promise.resolve(1);}async function run(){return await h({resolve:function(value){return Promise.resolve(value+1);}});}",
    "expected": 2,
    "refuse": false,
    "profileRefusal": false
  },
  {
    "name": "positive-unrelated-object-write",
    "source": "\"use strict\";async function h(o){o.x=2;return Promise.resolve(o.x);}async function run(){return await h({x:1});}",
    "expected": 2,
    "refuse": false,
    "profileRefusal": false
  },
  {
    "name": "evaluated-spread-then-accessor",
    "source": "\"use strict\";async function target(){return 1;}async function run(){let order=\"\";const p=target();const key=\"then\";Object.defineProperty(...[p,key,{get:function(){order+=\"g\";return function(resolve){order+=\"t\";resolve(2);};}}]);async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}",
    "expected": "gt2",
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "caught-unmodeled-promise-descriptor",
    "source": "\"use strict\";async function run(){const p=Promise.resolve(1);try{Object.defineProperty(p,\"then\",{value:7});}catch(error){}return 7;}",
    "expected": 7,
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "unmodeled-non-then-promise-property",
    "source": "\"use strict\";async function run(){const p=Promise.resolve(1);Object.defineProperty(p,\"x\",{value:3});return 7;}",
    "expected": 7,
    "refuse": true,
    "profileRefusal": true
  },
  {
    "name": "shadowed-object-define-property",
    "source": "\"use strict\";async function run(){const Object={defineProperty:function(target,key,descriptor){return target;}};const p=Promise.resolve(1);Object.defineProperty(p,\"then\",{value:5});return await p;}",
    "expected": 1,
    "refuse": false,
    "profileRefusal": false
  },
  {
    "name": "ordinary-object-descriptor",
    "source": "\"use strict\";function run(){const p={};Object.defineProperty(p,\"x\",{value:2,writable:true,enumerable:true,configurable:true});return p.x;}",
    "expected": 2,
    "refuse": false,
    "profileRefusal": false
  }
];
const observations=[],artifacts=[];let nativeReceipts=[];
const profileError=error=>error?.category==='unsupported.promise-source-mutation'&&
  /Promise own-property mutation requires its declared source profile/.test(error.message);
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
  let bundle,projected,error;
  try{runtime.drive();bundle=runtime.exportRun();projected=compileProtocolSourceV8(bundle);}catch(cause){error=cause;}
  if(scenario.refuse){
    assert(error,'unsupported Promise mutation must refuse direct compilation');assert.equal(projected,undefined);
    if(scenario.profileRefusal){
      assert(profileError(error),error.message);
      assert.throws(()=>compileSourceProjection(bundle,{projectionClient:SOURCE_PROJECTION_CLIENT_V8}),profileError);
    }
  }else{
    assert.equal(error,undefined,error?.message);
    assert.deepEqual(projected.outcome,{kind:'return',graph:{roots:[[typeof scenario.expected==='string'?'str':'num',scenario.expected]],objects:[]}});
  }
  const result=await verifyProtocolRegionTrainingCase({source:scenario.source,entry:'run',args:[],family:'promise-mutation-profile:'+scenario.name});
  if(scenario.refuse){
    assert.equal(result.exported,undefined,'refused source cannot provide native admission input');
    if(scenario.profileRefusal)assert.equal(result.category,'unsupported.promise-source-mutation');
    observations.push({name:scenario.name,source:scenario.source,original,refused:true,
      directCategory:error.category??null,directReason:error.message,sourceCategory:result.category,sourceReason:result.reason});
  }else{
    assert(result.exported,result.reason);const check=await recheckProtocolRegionEvidence(result.exported);
    assert.equal(check.sourceValidated,true);const replay=RegionExecutionHarness.replay(result.exported);
    assert.deepEqual(replay.controller.completion,{kind:'return',value:[typeof scenario.expected==='string'?'str':'num',scenario.expected]});
    artifacts.push({name:scenario.name,exported:result.exported,state:sharedRegionState(replay.controller)});
    observations.push({name:scenario.name,source:scenario.source,original,refused:false,sourceValidated:true,contexts:result.exported.contexts.length});
  }
});
test('actual native independently replays every eligible mutation-boundary control',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
  assert.equal(artifacts.length,5);assert.equal(observations.filter(row=>row.refused).length,19);
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
  assert.equal(nativeReceipts.length,5);
});
after(()=>{
  if(!process.env.RUNNER_TEMP)return;
  writeFileSync(join(process.env.RUNNER_TEMP,'promise-mutation-profile-evidence.json'),JSON.stringify({
    schema:'promise-mutation-profile-evidence/1',sourceCases:observations.length,refusedSources:observations.filter(r=>r.refused).length,
    eligibleSources:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
    generatedContexts:artifacts.reduce((sum,row)=>sum+row.exported.contexts.length,0),
    sourceAdmissionWasAlreadyRefusing:true,directCompilerProfileRefusalAdded:true,
    moduleAdmission:false,trainingAdmission:false,optimizerUpdates:0,observations,cases:artifacts}));
});
