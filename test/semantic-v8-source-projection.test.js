import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {defineRegionProgram} from '../src/semantic/regions.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {decodeWitness} from '../src/training/format.js';
import {checkEffectfulProjectionState} from '../src/training/projection-state-profile.js';

test('forward parameter closure uses checked detailed execution when a pure core cannot represent its identity',async()=>{
  const source='"use strict";function run(f=()=>n,n=7){return f();}';
  assert.equal(defineRegionProgram({source,entry:'run'}).program.algorithm,null);
  const result=await verifyRegionTrainingCase({source,entry:'run',family:'forward-parameter-closure',fixture:{calls:[]}});
  assert(result.exported,result.reason);assert.equal(result.status,'detailed-fallback');
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',7]});
  assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
});

test('a matching scalar cannot qualify erased custom prototype or Proxy state',async()=>{
  for(const body of [
    'const p={x:4};const o=Object.create(p);return o.x;',
    'const o={__proto__:null,x:3};return o.x;',
    'const o={};const p={x:4};Object.setPrototypeOf(o,p);return Object.getPrototypeOf(o)===p;',
    'return new Proxy({x:3},{get:function(t,k,r){return t[k]+1;}}).x;'
  ]){
    const result=await verifyRegionTrainingCase({source:'"use strict";function run(){'+body+'}',
      entry:'run',family:'unsupported-behavioral-state',fixture:{calls:[]}});
    assert.equal(result.status,'projection_refused',result.reason);
    assert.match(result.reason,/explicit v8 (behavioral-state|protocol) profile/);
    assert.equal(result.exported,undefined);
  }
});

test('class, private slots and constructor completion cannot be flattened by the historical detailed state profile',()=>{
  for(const node of [
    {kind:'function',classConstructor:true},
    {kind:'object',privateSlots:{}},
    {kind:'object',privateKinds:{brand:'field'}},
    {kind:'object',privateVersions:{brand:1}},
    {kind:'function',prototypeInitialized:true},
    {kind:'function',dataAttributes:{prototype:{enumerable:false,writable:false,configurable:false}}},
    {kind:'object',prototype:['ref','proto']}
  ])assert.throws(()=>checkEffectfulProjectionState({initialState:{heap:{o:node}}}),/explicit v8 behavioral-state/);
  assert.throws(()=>checkEffectfulProjectionState({initialState:{frames:{f:{constructReceiver:['ref','o']}}}}),/construction completion/);
  const ordinaryNull={kind:'object',prototype:null,properties:{}};
  assert.equal(checkEffectfulProjectionState({initialState:{heap:{o:ordinaryNull}}}).valid,true);
  assert.equal(checkEffectfulProjectionState({initialState:{},events:[{operation:'external.input.deliver',
    stateChanges:[{table:'heap',before:null,after:ordinaryNull}]}]}).valid,true);
});

test('initial source helpers are published before captures and preserve helper-produced allocation identity',async()=>{
  for(const [family,source,args,expected] of [
    ['captured-helper','"use strict";function twice(x){return x*2;}function run(xs){const factor=3;const f=x=>twice(x)+factor;return xs.map(f);}',[[2,3,4]],[7,9,11]],
    ['helper-allocation','"use strict";function box(x){return {x};}function run(){const f=box;const a=f(3),b=f(3);return [a,b,a===b];}',[],[{x:3},{x:3},false]],
    ['helper-chain','"use strict";function inc(x){return x+1;}function twice(x){return inc(x)*2;}function run(xs){const f=x=>twice(x);return xs.map(f);}',[[1,2]],[4,6]]
  ]){
    const candidate=await verifyEffectfulTrainingCase({source,entry:'run',args,family,fixture:{calls:[]},
      projectionOptions:{semanticRegions:false,localStateCompaction:false}});
    assert.equal(candidate.status,'locally_verified',candidate.reason);
    assert.equal((await recheckEffectfulAdmission(candidate.exported,{requireAdmitted:false})).sourceValidated,true);
    const certificates=candidate.exported.sidecar.compiler.certificates;
    const published=certificates.filter(row=>row.rule==='owned-initial-source-closure/4');
    assert(published.length>=1);assert(published.every(row=>row.initialState.entityDigest.length===64));
    const emitted=new Set();
    for(const row of candidate.exported.public.timeline.filter(row=>row.kind==='semantic')){
      const record=decodeWitness(row.line);
      if(record.kind==='allocate')emitted.add(record.fields.name);
      if(record.kind==='bind'&&record.fields.value[0]==='ref'&&published.some(c=>c.initialState.identity===record.fields.value[1]))
        assert(emitted.has(record.fields.value[1]),'a captured initial function must already be public');
    }
    const result=await verifyRegionTrainingCase({source,entry:'run',args,family,fixture:{calls:[]}});
    assert(result.exported,result.reason);
    const controller=RegionExecutionHarness.replay(result.exported).controller;
    assert.deepEqual(controller.materialize(controller.completion.value),expected);
  }
});
