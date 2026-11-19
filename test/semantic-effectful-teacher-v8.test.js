import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileEffectfulWitness} from '../src/training/effectful-compiler.js';
import {compileEffectfulRegionWitnessV8,createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {independentEffectfulReference} from '../src/training/effectful-admit.js';

function owned(source,args=[]){const runtime=createRuntime().startEntry({text:source,functionName:'run',args,allowAsync:true});
  runtime.drive();return runtime.exportRun();}
const cases=[
  '"use strict";async function run(){const before=2+3;const x=await Promise.resolve(7);return before+x;}',
  '"use strict";async function run(){let total=1;const value=await Promise.resolve(3).then(x=>{total+=x;return x+1;});return total+value;}',
  '"use strict";async function run(){let cleaned=0;try{await Promise.reject(2);}catch(error){return [error,cleaned];}finally{cleaned++;}}'
];
test('the v8 teacher bridge retains exact Promise and cleanup execution in public shared state',async()=>{
  for(const source of cases){
    const bundle=owned(source),compiled=compileEffectfulRegionWitnessV8(bundle),artifact=compiled.exported;
    assert.equal(artifact.public.schema,'semantic-execution/8');
    const reference=await independentEffectfulReference({source,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]}});
    assert.deepEqual(compiled.outcome,reference.outcome);
    const replay=RegionExecutionHarness.replay(artifact),restored=RegionExecutionHarness.restore(replay.checkpoint());
    assert.deepEqual(sharedRegionState(restored.controller),sharedRegionState(replay.controller));
    assert.equal(artifact.contexts.length,artifact.public.timeline.filter(row=>row.mode==='generated').length);
    for(const context of artifact.contexts)assert.equal(context.schema,'semantic-context/8');
  }
});
test('versioned teacher selection leaves historical projection unchanged and retains scheduler refusal checks',()=>{
  const bundle=owned(cases[0]),before=compileEffectfulWitness(bundle,{semanticRegions:false}),
    extended=compileEffectfulRegionWitnessV8(bundle),after=compileEffectfulWitness(bundle,{semanticRegions:false});
  assert.deepEqual(before,after);assert.equal(before.exported.public.schema,'semantic-execution/6');
  const episode=structuredClone(extended.exported.public),resume=episode.timeline.find(row=>row.fields.line?.includes('"resume"'));
  assert(resume);const record=JSON.parse(resume.fields.line.slice('detail '.length));record.fields.result=['num',99];
  resume.fields.line='detail '+JSON.stringify(record);
  assert.throws(()=>RegionExecutionHarness.replay(episode),/settlement|canonical/);
  assert.throws(()=>compileEffectfulWitness(bundle,{regionAdapter:createEffectfulRegionAdapterV8()}),/explicit detailed source projection/);
});
test('teacher extensions must emit checked public operations rather than mutate a public-state target',()=>{
  const bundle=owned('"use strict";function run(){return 1;}');let attempted=false;
  assert.throws(()=>compileEffectfulRegionWitnessV8(bundle,{extensions:[{id:'false-computation/1',event(ctx,event,row){
    if(attempted||!row)return false;attempted=true;
    ctx.emitProtocol(ctx.rootInvocation,{kind:'compute',expr:{op:'literal',value:['num',1]},result:['num',2],bind:null},event);
    return true;
  }}]}),/computation|result|claim/);
  assert(attempted);
});
