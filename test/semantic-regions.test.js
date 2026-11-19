import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSemanticRegion,evaluateSemanticRegion,checkSemanticRegionClaim} from '../src/training/semantic-regions.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {verifyEffectfulProjection} from '../src/training/effectful-compiler.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {decodeWitness,encodeWitness} from '../src/training/format.js';

const sum='"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}';
const array=(values)=>new Map([['o1',{kind:'array',properties:new Map([
  ['length',['num',values.length]],...values.map((v,i)=>[String(i),['num',Object.is(v,-0)?'-0':v]])])}]]);
const fixture=(source,entry,args)=>({source,entry,args,fixture:{calls:[]},family:'production-semantic-region'});
const lines=episode=>episode.public.timeline.filter(row=>row.kind==='semantic').map(row=>decodeWitness(row.line));

test('bounded public proof handles scalar helpers and ordered short-circuit decisions',()=>{
  const source='"use strict";function pick(x){return x?4:4;}function run(a,b){return pick(a)+pick(b);}';
  const region=inspectSemanticRegion(source,'run');
  assert.equal(region.profile,'pure-control-helper/1');
  const args=[['bool',false],['bool',true]],expected=evaluateSemanticRegion(region,args);
  assert.deepEqual(expected.result,['num',8]);
  assert.deepEqual(expected.decisions.map(row=>row.selected),['alternate','consequent']);
  assert.deepEqual(expected.decisions[0].site,expected.decisions[1].site);
  const claim={entry:'run',arguments:args,profile:region.profile,...expected};
  assert(checkSemanticRegionClaim(source,'run',args,claim).consistent);
  const falsePath=structuredClone(claim);falsePath.decisions.reverse();
  assert.equal(checkSemanticRegionClaim(source,'run',args,falsePath).consistent,false,
    'the same final value cannot excuse a false executed branch');
  assert.deepEqual(falsePath.result,['num',8]);
});

test('region proof only reads exact public arguments and rejects ambient state',()=>{
  const source='"use strict";function run(a,b){return a&b;}',args=[['num',6],['num',3]];
  const region=inspectSemanticRegion(source,'run');
  assert.deepEqual(evaluateSemanticRegion(region,args),{result:['num',2]});
  assert.throws(()=>checkSemanticRegionClaim(source,'run',args,{entry:'run',arguments:[['num',7],['num',3]],
    result:['num',3],profile:region.profile}),/exact committed input/);
  assert.throws(()=>inspectSemanticRegion('"use strict";function run(){return future;}','run'),/ambient/);
  assert.throws(()=>evaluateSemanticRegion(region,[['ref','future'],['num',3]]),/primitive/);
});

test('dense sum proves zero and finite-array cases and refuses holes or hidden properties',()=>{
  const region=inspectSemanticRegion(sum,'sum');
  assert.deepEqual(evaluateSemanticRegion(region,[['ref','o1']],{heap:array([2,3,4])}),
    {result:['num',9],iterations:3,accumulator:'total'});
  assert.deepEqual(evaluateSemanticRegion(region,[['ref','o1']],{heap:array([])}).result,['num',0]);
  assert.deepEqual(evaluateSemanticRegion(region,[['ref','o1']],{heap:array([-0])}).result,['num',0]);
  const hole=array([1,2]);hole.get('o1').properties.delete('0');
  assert.throws(()=>evaluateSemanticRegion(region,[['ref','o1']],{heap:hole}),/holes/);
  const extra=array([1]);extra.get('o1').properties.set('extra',['num',9]);
  assert.throws(()=>evaluateSemanticRegion(region,[['ref','o1']],{heap:extra}),/extra properties/);
  assert.throws(()=>evaluateSemanticRegion(region,[['ref','o1']],{heap:array(Array(129).fill(1))}),/bound/);
});

test('regions refuse mutation, coercion hooks, recursion, async and hidden effects even in dead branches',()=>{
  for(const body of [
    'return x?host.readAsync("x"):0;', 'return x?x.value:0;', 'return x?(x=1):0;',
    'return x?(()=>1)():0;', 'return run(x);', 'try{return x;}finally{x++;}',
    'let n=0;for(let i=0;i<x.length;i++){n+=x[i];x[i]=0;}return n;'
  ])assert.throws(()=>inspectSemanticRegion('"use strict";function run(x){'+body+'}','run'));
  assert.throws(()=>inspectSemanticRegion('"use strict";async function run(x){return x;}','run'),/ordinary/);
  assert.throws(()=>inspectSemanticRegion('"use strict";let state=1;function run(x){return x;}','run'),/top-level/);
});

test('default production compiler emits region records with independent admission and exact replay',async()=>{
  for(const input of [
    fixture('"use strict";function increment(x){return x+1;}function run(n){return increment(n);}','run',[4]),
    fixture('"use strict";function run(x,flag,fallback){return x<0?(flag&&(-x)):(fallback??3);}','run',[-4,true,0]),
    fixture('"use strict";function run(a,b,c){return a&&(b||c)?2:7;}','run',[true,false,true]),
    fixture(sum,'sum',[[2,3,4]])
  ]){
    const result=await verifyEffectfulTrainingCase(input);
    assert.equal(result.status,'locally_verified',result.reason);
    assert.deepEqual(lines(result.exported).map(row=>row.kind),['summarize','end']);
    assert.equal(result.exported.sidecar.compiler.region.inputUnchanged,true);
    assert(result.exported.sidecar.compiler.certificates[0].journalEvents.length>0);
    assert.equal((await recheckEffectfulAdmission(result.exported,{requireAdmitted:false})).sourceValidated,true);
    const detailed=await verifyEffectfulTrainingCase({...input,projectionOptions:{semanticRegions:false}});
    assert.equal(detailed.status,'locally_verified',detailed.reason);
    assert.deepEqual(result.exported.sidecar.reference.outcome,detailed.exported.sidecar.reference.outcome);
    assert(lines(result.exported).length<lines(detailed.exported).length);
    const forged=structuredClone(result.exported);
    forged.sidecar.compiler.region.inputUnchanged=false;
    assert.throws(()=>verifyEffectfulProjection(result.exported.sidecar.archive,forged),/certificates/);
  }
});

test('selected controller preserves a false prediction and diagnoses wrong result or branch',async()=>{
  const result=await verifyEffectfulTrainingCase(fixture('"use strict";function run(x){return x?4:4;}','run',[false]));
  assert.equal(result.status,'locally_verified',result.reason);
  const forged=structuredClone(result.exported),row=forged.public.timeline.find(row=>row.kind==='semantic');
  const decoded=decodeWitness(row.line);decoded.fields.decisions[0].selected='consequent';
  row.line=encodeWitness(decoded.kind,decoded.fields);
  const selected=SelectedExecutionHarness.replay(forged).invocations.get('invocation1').controller;
  assert(selected.firstWitnessViolation);
  assert.equal(selected.firstWitnessViolation.consistent,false);
  assert.deepEqual(selected.completion.value,['num',4]);
  assert.equal(decodeWitness(row.line).fields.decisions[0].selected,'consequent');
});

test('whole-region claims cannot skip earlier selected work or summarize effectful source',()=>{
  const harness=new SelectedExecutionHarness({sessionId:'regions'});
  harness.publishProgram({programId:'p',source:'"use strict";function run(x){return x+1;}',entry:'run'});
  harness.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'call',args:[2]});
  harness.selected('i',encodeWitness('bind',{name:'x',value:['num',2]}));
  assert.throws(()=>harness.selected('i',encodeWitness('summarize',{entry:'run',arguments:[['num',2]],
    result:['num',3],profile:'pure-helper/1'})),/untouched invocation/);
});
