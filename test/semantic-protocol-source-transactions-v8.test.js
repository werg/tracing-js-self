import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {createNumberSourceAdapterV8} from '../src/semantic/protocol-number-source-v8.js';
import {createArrayMapSourceAdapterV8} from '../src/semantic/protocol-array-map-source-v8.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from '../src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

function archive(source){
  const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();return runtime.exportRun();
}
function snapshot(ctx){return structuredClone({claims:ctx.claims,state:ctx.state,
  public:sharedRegionState(ctx.controller),published:[...ctx.published],accessors:[...ctx.pendingAccessors],
  extensions:[...ctx.extensionState]});}
const numberCall=event=>event.operation==='call.enter'&&event.operands[0]?.[0]==='intrinsic'&&event.operands[0][1]==='Number';

test('a rejected Number event restores every public claim and retained adapter state after all observers run',()=>{
  const source='"use strict";function run(){let n=1;const value={valueOf:function(){return n+2;}};return Number(value);}',
    bundle=archive(source),number=createNumberSourceAdapterV8(),seen=[];
  let context,before,numberBefore;
  const audit={id:'test-audit/1',stateless:true,
    setup(ctx){context=ctx;},
    beforeEvent(ctx,event){if(numberCall(event)){before=snapshot(ctx);numberBefore=structuredClone(number.captureState());}},
    afterEvent(ctx,event){
      if(!numberCall(event))return;
      assert(ctx.claims.length>before.claims.length,'the real number handler emitted its staged begin/call');
      assert(number.captureState().active.length>numberBefore.active.length,'the real handler retained its callback');
      ctx.emit({kind:'bind',fields:{name:'rejectedObserver',value:['num',91]}},event,'test-rejected-observer/1',{detail:true});
      seen.push('reject');return false;
    }};
  const later={id:'test-z-later/1',stateless:true,afterEvent(_ctx,event){if(numberCall(event))seen.push('later');}};
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[number,audit,later]}),/observer rejected/);
  assert.deepEqual(seen,['reject','later']);
  assert.deepEqual(snapshot(context),before);
  assert.deepEqual(number.captureState(),numberBefore);
  assert(!context.claims.some(claim=>claim.record.fields?.name==='rejectedObserver'));
});

test('rejected map completion retains the original shared plan and allows a clean fresh projection',()=>{
  const source='"use strict";function run(){return [2,3].map(function(value){return value+1;})[1];}',
    bundle=archive(source),map=createArrayMapSourceAdapterV8();
  let context,before,adapterBefore,failed;
  const audit={id:'map-completion-audit/1',stateless:true,
    setup(ctx){context=ctx;},
    beforeEvent(ctx,event){
      if(event.operation!=='call.return'||map.captureState().callbacks.length===0)return;
      failed=event.eventId;before=snapshot(ctx);adapterBefore=structuredClone(map.captureState());
    },
    afterEvent(_ctx,event){if(event.eventId===failed)throw Error('reject mapped callback result');}};
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[map,audit]}),/reject mapped callback result/);
  assert.deepEqual(snapshot(context),before);assert.deepEqual(map.captureState(),adapterBefore);
  const retained=map.captureState();
  assert.equal(retained.plans[0][1],retained.callbacks[0][1],'rollback preserves private plan alias identity');
  assert.deepEqual(compileProtocolSourceV8(bundle).outcome.graph.roots.at(-1),['num',4]);
});

test('source adapters must explicitly retain their private state across event staging',()=>{
  const bundle=archive('"use strict";function run(){return 1;}');
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[{id:'undeclared/1',event:()=>false}]}),/declare retained state/);
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[{id:'incomplete/1',captureState:()=>({}),event:()=>false}]}),/capture and restore/);
});

test('Number, Proxy, memory, map and iterator callbacks share one independently checked source projection',async()=>{
  const source='"use strict";function run(){const bytes=new Uint8Array(2);const target={x:3};'+
    'const proxy=new Proxy(target,{get:function(object,key){bytes[0]=object[key];return bytes[0]+1;}});'+
    'const converted=Number({valueOf:function(){return proxy.x;}});'+
    'const result=[converted,2].map(function(value){const iter=[value].values();return iter.next().value+1;});'+
    'return result[0]+result[1]+bytes[0];}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'protocol-staged-cross-family',timeoutMs:30000});
  assert(result.exported,result.reason);
  const rechecked=await recheckProtocolRegionEvidence(result.exported);
  assert(rechecked.sourceValidated&&rechecked.projectionValidated&&rechecked.replayValidated);
  const replayed=RegionExecutionHarness.replay(result.exported),restored=RegionExecutionHarness.restore(replayed.checkpoint());
  assert.deepEqual(replayed.controller.completion,{kind:'return',value:['num',11]});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replayed.controller));
  const projected=compileProtocolSourceV8(archive(source)),kinds=new Set(projected.claims.map(claim=>claim.record.kind));
  for(const kind of ['number.begin','proxy.get.call','memory.set','iterator.next','call'])assert(kinds.has(kind),kind);
});
