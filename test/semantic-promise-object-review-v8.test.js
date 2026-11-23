import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {SemanticControllerV8} from '../src/semantic/controller-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detail-v8.js';
import {encodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';

const U=['undefined'],P=['ref','intrinsicpromise'],prototype=['ref','intrinsicpromiseprototype'],ref=id=>['ref',id];
const artifacts=[],nativeReceipts=[];
function recording(h=new RegionExecutionHarness({automaticDelivery:false}),contexts=[]){
  h.selectedContexts=contexts;const select=h.select.bind(h);
  h.select=(owner,line,options)=>{const context=h.modelContext(owner),result=select(owner,line,options);
    contexts.push(context);return result;};return h;
}
const select=(h,record,owner='invocation1')=>h.select(owner,encodeProtocolRecordV8(record));
const detail=(h,kind,fields,owner='invocation1')=>h.select(owner,encodeDetailedRecord({kind,fields}));
const data=value=>({kind:'data',value,writable:true,enumerable:false,configurable:true});
const accessor=get=>({kind:'accessor',get,set:U,enumerable:false,configurable:true});
const define=(h,object,key,descriptor,owner)=>select(h,{kind:'property.define',object,key:['str',key],descriptor,success:true},owner);
const admit=(h,owner)=>h.admitInvocation({programId:'program1',invocationId:owner,trackId:owner,realmId:'realm1',triggerId:owner,
  realmPolicy:'retained',inputGraph:{roots:[],objects:[]}});
function setup(source='"use strict";function run(){return 0;}function getter(){return Promise;}'){
  const h=recording();h.publishProgram({programId:'program1',source,entry:'run',capabilities:[]});admit(h,'invocation1');return h;
}
function roundtrip(h){const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(h.checkpoint())));
  for(const [owner,{controller}]of h.invocations)
    assert.deepEqual(sharedRegionState(restored.invocations.get(owner).controller),sharedRegionState(controller));
  return recording(restored,h.selectedContexts);
}
function retain(h,name){roundtrip(h);artifacts.push({name,artifact:{public:h.exportEpisode(),contexts:h.selectedContexts},
  states:[...h.invocations].map(([owner,{controller}])=>[owner,sharedRegionState(controller)])});}

test('a new retained invocation derives intrinsic initialization without inheriting local protocol state',()=>{
  const source='"use strict";function run(){const p=Promise.resolve(1);return Object.getPrototypeOf(p)===Promise.prototype;}';
  assert.deepEqual(Array.from(vm.runInNewContext(source+';[run(),run()]')),[true,true]);
  let h=setup(source);
  const run=(owner,promise)=>{
    detail(h,'promise',{action:'create',promise},owner);detail(h,'promise',{action:'resolve',promise,value:['num',1]},owner);
    select(h,{kind:'property.getPrototypeOf',object:promise,result:prototype},owner);
    select(h,{kind:'compute',expr:{op:'binary',operator:'===',left:{op:'literal',value:prototype},right:{op:'literal',value:prototype}},
      result:['bool',true],bind:null},owner);
    detail(h,'return',{invocation:owner,value:['bool',true]},owner);detail(h,'end',{kind:'return'},owner);
  };
  select(h,{kind:'promise.intrinsics'});run('invocation1','first');h=roundtrip(h);admit(h,'invocation2');
  const second=h.invocations.get('invocation2').controller;
  assert.deepEqual(second.protocol.promiseObjects,{schema:'semantic-promise-object-state/1',initialized:true});
  assert.equal(second.protocol.sequence,0);assert.deepEqual(second.protocol.callFrames,[]);assert.deepEqual(second.protocol.pendingCalls,[]);
  for(const key of ['promiseExecutors','construction','primitiveConversions','numberConversions'])assert.equal(second.protocol[key],null);
  run('invocation2','second');assert.deepEqual(second.heap.get('second').prototype,prototype);
  retain(h,'retained-intrinsic-prototype');
  const context=[encodeDetailedRecord({kind:'code',fields:second.source}),encodeDetailedRecord({kind:'input',fields:{graph:{roots:[],objects:[]}}})];
  for(const mutate of [heap=>heap.delete('intrinsicpromiseprototypethen'),
    heap=>{heap.get('intrinsicpromise').intrinsicName='Object';},
    heap=>{heap.get('intrinsicpromiseprototypethen').properties.set('extra',['num',1]);},
    heap=>{heap.get('intrinsicpromiseprototype').kind='array';},
    heap=>{heap.get('intrinsicobjectprototype').prototype=prototype;}]){
    const heap=structuredClone(second.heap);mutate(heap);
    assert.throws(()=>new SemanticControllerV8(context,{retainedState:{heap,locals:second.locals,scheduler:second.scheduler}}),
      /initialized intrinsic|intrinsic callable|intrinsic prototype|immutable null prototype/);
  }
  const missing=structuredClone(second.protocol);missing.promiseObjects=null;
  assert.throws(()=>restoreProtocolStateV8(second,missing),/declared protocol state|intrinsic accessor/);
  const ordinary=new SemanticControllerV8(context,{retainedState:{heap:new Map([
    ['intrinsicpromiseprototype',{kind:'object',prototype:'ordinary',properties:new Map()}]
  ]),locals:new Map(),scheduler:{registration:0,ready:0}}});
  assert.equal(ordinary.protocol,undefined);ordinary.createPromise('ordinarypromise');
  assert.equal(ordinary.heap.get('ordinarypromise').prototype,undefined);
});

test('queued adoption keeps selected then while constructor lookup remains live at its job',()=>{
  let h=setup();for(const promise of ['p1','p2'])detail(h,'promise',{action:'create',promise});
  detail(h,'promise',{action:'resolve',promise:'p2',value:['num',7]});select(h,{kind:'promise.intrinsics'});
  select(h,{kind:'allocate',name:'getter1',objectKind:'closure',length:null,properties:[],code:'getter',captures:[],
    functionKind:'ordinary',lexicalReceiver:null});
  select(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'adopt1'});
  define(h,'p2','then',accessor(ref('getter1')));define(h,'p2','constructor',data(['num',99]));
  detail(h,'return',{invocation:'invocation1',value:['num',0]});h=roundtrip(h);
  assert.throws(()=>select(h,{kind:'promise.adopt.enter',promise:'p1',target:'p2',job:'adopt1',forwarding:'wrong'}),/constructor\/species/);
  // Restore a second live caller only to change the actual constructor before
  // the queued intrinsic then call. The captured then itself is unchanged.
  admit(h,'invocation2');define(h,'p2','constructor',accessor(ref('getter1')),'invocation2');
  detail(h,'return',{invocation:'invocation2',value:['num',0]},'invocation2');detail(h,'end',{kind:'return'},'invocation2');
  h=roundtrip(h);
  select(h,{kind:'promise.adopt.get',promise:'p1',target:'p2',job:'adopt1',child:'gettercall'});h=roundtrip(h);
  assert.deepEqual(h.controller.receiver,ref('p2'));
  define(h,'p2','constructor',data(['num',91]));h=roundtrip(h);
  select(h,{kind:'promise.adopt.finish',promise:'p1',target:'p2',job:'adopt1',child:'gettercall',
    completion:{kind:'return',value:P},forwarding:'forward1'});h=roundtrip(h);
  select(h,{kind:'promise.adopt.forward',promise:'p1',target:'p2',job:'forward1',status:'fulfilled',value:['num',7]});
  detail(h,'end',{kind:'return'});assert.deepEqual(h.controller.heap.get('p1').result,['num',7]);
  assert.equal([...h.controller.frameFunctions.values()].filter(code=>code==='getter').length,1);
  retain(h,'queued-then-live-constructor');
});

test('an altered then before initial resolution remains an explicit transactional refusal',()=>{
  const h=setup();for(const promise of ['p1','p2'])detail(h,'promise',{action:'create',promise});
  select(h,{kind:'promise.intrinsics'});define(h,'p2','then',data(U));const before=sharedRegionState(h.controller);
  assert.throws(()=>select(h,{kind:'promise.adopt.enqueue',promise:'p1',target:'p2',job:'adopt1'}),/resolved intrinsic then/);
  assert.deepEqual(sharedRegionState(h.controller),before);
});

test('native independently replays retained invocations and captured adoption selection',
  {skip:!process.env.MEGATOKEN_ROOT},()=>{
    assert.equal(artifacts.length,2);const root=resolve(process.env.MEGATOKEN_ROOT),script=`
import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
out=[]
for row in json.load(sys.stdin):
    artifact=row['artifact'];receipt=validate_v8_artifact(artifact)
    assert receipt['admitted'] is False
    assert all(receipt['checks'][key]=='passed' for key in ['replay','contexts','continuation'])
    for owner,expected in row['states']:
        state=_replay_shared_state(artifact['public']['timeline'],artifact['contexts'],{},roundtrip=True,boundary_invocation=owner)['state']
        assert state==expected,(row['name'],owner)
    out.append({'name':row['name'],'counts':receipt['counts'],'checks':receipt['checks'],'admitted':receipt['admitted'],
                'checkedOwners':[owner for owner,_ in row['states']]})
print(json.dumps(out))
`;
    const result=spawnSync(process.env.MEGATOKEN_PYTHON||'python3',['-c',script],{cwd:root,
      env:{...process.env,PYTHONPATH:join(root,'src')},input:JSON.stringify(artifacts),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,result.stderr||String(result.error));nativeReceipts.push(...JSON.parse(result.stdout));
  });
after(()=>{
  if(process.env.REVIEW_PROTOCOL_CASES_OUT)writeFileSync(process.env.REVIEW_PROTOCOL_CASES_OUT,JSON.stringify(artifacts));
  if(process.env.RUNNER_TEMP)writeFileSync(join(process.env.RUNNER_TEMP,'promise-object-review-protocol-evidence.json'),JSON.stringify({
    schema:'promise-object-review-protocol-evidence/1',publicCases:artifacts.length,actualNativeCases:nativeReceipts.length,nativeReceipts,
    trainingAdmission:false,optimizerUpdates:0,cases:artifacts}));
});
