import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {compileEffectfulWitness,verifyEffectfulProjection} from '../src/training/effectful-compiler.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {decodeWitness,validateExpression} from '../src/training/format.js';

const records=e=>e.public.timeline.filter(x=>x.kind==='semantic').map(x=>decodeWitness(x.line));
const computations=e=>records(e).filter(x=>x.kind==='compute');
const source=async(text,args=[])=>
 (await executeWithNativeServices({entry:{text:'"use strict";'+text,functionName:'run',args}})).bundle;

test('source-certified expressions execute through the canonical serving model',async()=>{
  for(const family of ['compound-pure','compound-effectful']){
    const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id===family);
    const result=await verifyEffectfulTrainingCase(fixture);
    assert.equal(result.status,'locally_verified',result.reason);
    const episode=result.exported;
    assert.equal(episode.sidecar.representation,'compact');
    assert.equal((await recheckEffectfulAdmission(episode,{requireAdmitted:false})).sourceValidated,true);
    const cohort=controlledEvaluationCase(episode,{id:fixture.id});
    const selected=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
      caseId:fixture.id,seed:17,representation:'compact',request:cohort.request});
    assert.equal(selected.failure,null,JSON.stringify(selected.failure));
    assert.deepEqual(selected.outcome,cohort.expected);
    assert.equal(computations(episode).length,1);
    assert.equal(validateExpression(computations(episode)[0].fields.expr).operatorCount,4);
    const certificate=episode.sidecar.compiler.certificates.find(c=>c.rule==='owned-compact-compute/4');
    assert(certificate);
    assert.equal(certificate.dependencies.length,3);
    const forged=structuredClone(episode);
    forged.sidecar.compiler.certificates.find(c=>c.dependencies).dependencies[0].producer='a0:e999999';
    assert.throws(()=>verifyEffectfulProjection(episode.sidecar.archive,forged,
      episode.sidecar.projectionOptions),/certificates/);
  }
});

test('unrelated equal-valued computations never fuse; bound cells retain identity',async()=>{
  const unrelated=compileEffectfulWitness(await source(
    'function run(a,b){return ((a+b),(a+b))*2;}',[2,3])).exported;
  assert.equal(unrelated.sidecar.compiler.compaction.removedComputations,0);
  const bound=compileEffectfulWitness(await source(
    'function run(a,b){const previous=a+b;return previous*2;}',[2,3])).exported;
  assert.equal(computations(bound).length,2);
  assert.equal(bound.sidecar.compiler.compaction.removedComputations,0);
});

test('bounded source expressions respect eight operators and 32 nodes',async()=>{
  const bundle=await source('function run(value){return ((((((((((value+1)+2)+3)+4)+5)+6)+7)+8)+9)+10);}',[1]);
  const canonical=compileEffectfulWitness(bundle).exported;
  const sizes=computations(canonical).map(row=>validateExpression(row.fields.expr));
  assert.deepEqual(sizes.map(row=>row.operatorCount),[8,2]);
  assert(sizes.every(row=>row.nodeCount<=32));
  const small=compileEffectfulWitness(bundle,{maxOperators:1}).exported;
  assert.equal(computations(small).length,10);
  assert.throws(()=>compileEffectfulWitness(bundle,{maxOperators:9}),/bound/);
  assert.throws(()=>compileEffectfulWitness(bundle,{representation:'explicit'}),/canonical semantic trace/);
});

test('mutations, requests, observations and cleanup do not become pure calculations',async()=>{
  const result=await verifyEffectfulTrainingCase({family:'semantic-barriers',entry:'run',
    args:['x',{n:1}],source:'"use strict";async function run(key,state){const value=(2+3)*4;state.n=value;try{const x=await host.readAsync(key);if(x>0){host.store(key,(x+2)*3);return (x+4)*5;}return 0;}finally{host.store("cleanup",(1+2)*3);}}',
    fixture:{calls:[{operation:'demo.readAsync',arguments:['x'],result:2},
      {operation:'demo.store',arguments:['x',12]},{operation:'demo.store',arguments:['cleanup',9]}]}});
  assert.equal(result.status,'locally_verified',result.reason);
  const trace=records(result.exported);
  assert(trace.some(x=>x.kind==='write'&&x.fields.key==='n'));
  assert.equal(trace.filter(x=>x.kind==='request').length,3);
  assert(result.exported.sidecar.effects.some(x=>x.kind==='dispatch'&&x.operation==='demo.store'));
  assert(trace.some(x=>x.kind==='end'&&x.fields.kind==='return'));
  for(const c of result.exported.sidecar.compiler.certificates.filter(item=>item.dependencies)){
    const events=c.journalEvents.map(id=>result.exported.sidecar.archive.events.find(x=>x.eventId===id));
    const pureEvents=events.filter(x=>x.operation==='spec.operation.complete');
    if(pureEvents.length<2)continue;
    const first=pureEvents[0].sequence,last=pureEvents.at(-1).sequence;
    assert(!result.exported.sidecar.archive.events.some(x=>x.sequence>first&&x.sequence<last&&
      /^(external\.|effect\.|async\.|job\.|property\.write|control\.)/.test(x.operation)));
  }
});
