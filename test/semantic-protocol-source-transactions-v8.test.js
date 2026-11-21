import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {createPrimitiveConversionSourceAdapterV8} from '../src/semantic/protocol-primitive-conversion-source-v8.js';
import {createArrayMapSourceAdapterV8} from '../src/semantic/protocol-array-map-source-v8.js';
import {createGeneratorSourceAdapterV8} from '../src/semantic/protocol-generator-source-v8.js';
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
    bundle=archive(source),number=createPrimitiveConversionSourceAdapterV8(),seen=[];
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
  for(const kind of ['conversion.begin','proxy.get.call','memory.set','iterator.next','call'])assert(kinds.has(kind),kind);
});

test('map callback finally cleanup composes with abrupt completion and survives JSON recovery',async()=>{
  const source='"use strict";function run(){let cleaned=0;try{return [2].map(function(value){'+
    'try{throw value;}finally{cleaned+=5;}})[0];}catch(error){return cleaned+error;}}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'map-finally-composition',timeoutMs:30000});
  assert(result.exported,result.reason);
  assert.equal(result.exported.sidecar.sourceArtifact.sidecar.outcome.graph.roots.at(-1)[1],7);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).projectionValidated,true);
  const timeline=result.exported.public.timeline,cut=timeline.findIndex(row=>row.kind==='protocol'&&row.fields.line?.includes('"kind":"throw"'));
  assert(cut>0,'the callback throw must be a retained public boundary');
  const prefix={...result.exported.public,timeline:timeline.slice(0,cut)},
    original=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(original.checkpoint())));
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(original.controller));
  const cleanupWrites=timeline.slice(0,cut).filter(row=>row.kind==='semantic'&&row.fields.line?.includes('\"kind\":\"bind\"')&&row.fields.line?.includes('\"name\":\"cleaned\"')).length;
  assert.equal(cleanupWrites,1,'cleanup has already committed before the throw boundary');
  for(const row of timeline.slice(cut))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  const complete=RegionExecutionHarness.replay(result.exported);
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(complete.controller));
  assert.deepEqual(complete.controller.completion,{kind:'return',value:['num',7]});
});

test('map callback nested finally preserves return and throw precedence',async()=>{
  const cases=[
    ['try{throw 2}finally{return 9}',9],
    ['try{return 3}finally{throw 2}',2],
    ['try{try{throw 2}finally{x+=1}}finally{x+=2}',32],
    ['try{try{return 3}finally{x+=1}}finally{x+=2}',3]
  ];
  for(const [body,expected] of cases){
    const source='"use strict";function run(){let x=0;try{return [1].map(function(value){'+body+
      '})[0];}catch(error){return x*10+error;}}';
    const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'map-completion-precedence',timeoutMs:30000});
    assert(result.exported,body+': '+result.reason);
    assert.deepEqual(result.exported.sidecar.sourceArtifact.sidecar.outcome.graph.roots.at(-1),['num',expected],body);
    assert.equal((await recheckProtocolRegionEvidence(result.exported)).projectionValidated,true,body);
  }
});

test('map generator callbacks compose creation, result writes, yield and JSON recovery',async()=>{
  const source='"use strict";function run(){const values=[2,3].map(function*(value){yield value+1;});'+
    'return values[0].next().value+values[1].next().value;}';
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'map-generator-composition',timeoutMs:30000});
  assert(result.exported,result.reason);
  assert.deepEqual(result.exported.sidecar.sourceArtifact.sidecar.outcome.graph.roots.at(-1),['num',7]);
  assert.equal((await recheckProtocolRegionEvidence(result.exported)).projectionValidated,true);
  const timeline=result.exported.public.timeline,cut=timeline.findIndex(row=>row.fields.line?.includes('"kind":"generator.create"'));
  assert(cut>0,'generator creation is a public suspension boundary');
  const prefix={...result.exported.public,timeline:timeline.slice(0,cut+1)},
    original=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(original.checkpoint())));
  for(const row of timeline.slice(cut+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
  assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(RegionExecutionHarness.replay(result.exported).controller));
  assert.equal(timeline.filter(row=>row.fields.line?.includes('"kind":"generator.create"')).length,2);
});

test('a rejected map-generator composite restores both adapter states atomically',()=>{
  const source='"use strict";function run(){return [2].map(function*(value){yield value;});}',
    runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();const bundle=runtime.exportRun(),map=createArrayMapSourceAdapterV8(),generator=createGeneratorSourceAdapterV8({bundle}),
    beforeMap=structuredClone(map.captureState()),beforeGenerator=structuredClone(generator.captureState());
  let failed=false;
  const audit={id:'map-generator-reject/1',stateless:true,afterEvent(_ctx,event){
    if(!failed&&event.operation==='call.enter'&&event.operands[0]?.[0]==='method'&&
      event.operands[0][1]?.[1]==='Array.prototype.map'){failed=true;throw Error('reject composite map-generator event');}
  }};
  assert.throws(()=>compileProtocolSourceV8(bundle,{adapters:[map,generator,audit]}),/reject composite map-generator event/);
  assert(failed);assert.deepEqual(map.captureState(),beforeMap);assert.deepEqual(generator.captureState(),beforeGenerator);
});

test('mapped generator IteratorClose resumes after JSON recovery and preserves throw precedence once',async()=>{
  const cases=[
    ['closed++;throw 2;', '',112],
    ['closed++;return {done:true};','throw 3;',113]
  ];
  for(const [closeBody,finallyBody,expected]of cases){
    const source='"use strict";function run(){let closed=0;const iterable={[Symbol.iterator]:function(){return this},'+
      'next:function(){return {value:3,done:false}},return:function(){'+closeBody+'}};const gen=[iterable].map(function*(it){'+
      'try{for(const value of it){yield value;break}}finally{closed+=10;'+finallyBody+'}})[0];gen.next();'+
      'try{gen.return(8)}catch(error){return closed*10+error}return 0;}';
    const result=await verifyProtocolRegionTrainingCase({source,entry:'run',family:'map-generator-iterator-close',timeoutMs:30000});
    assert(result.exported,result.reason);
    assert.deepEqual(result.exported.sidecar.sourceArtifact.sidecar.outcome.graph.roots.at(-1),['num',expected]);
    assert.equal((await recheckProtocolRegionEvidence(result.exported)).projectionValidated,true);
    const timeline=result.exported.public.timeline,cut=timeline.findIndex(row=>row.fields.line?.includes('"kind":"generator.yield"'));
    assert(cut>=0,'checkpoint follows the yielded value while the iterator close obligation is live');
    const prefix={...result.exported.public,timeline:timeline.slice(0,cut+1)},
      original=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
      restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(original.checkpoint())));
    for(const row of timeline.slice(cut+1))restored.select(row.fields.invocationId,row.fields.line,{entry:row.fields.entry??null});
    const complete=RegionExecutionHarness.replay(result.exported);
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(complete.controller));
    const closes=timeline.slice(cut+1).filter(row=>row.kind==='semantic'&&row.fields.line?.includes('\"kind\":\"bind\"')&&row.fields.line?.includes('\"name\":\"closed\"'));
    assert.equal(closes.length,2,'iterator return and generator finally each update the live close counter once');
  }
});
