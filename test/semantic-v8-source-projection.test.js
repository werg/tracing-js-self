import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {defineRegionProgram} from '../src/semantic/regions.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {decodeWitness} from '../src/training/format.js';
import {checkEffectfulProjectionState} from '../src/training/projection-state-profile.js';
import {runtimeDifferential} from './helpers/runtime-frontier.js';

test('forward parameter closure uses checked detailed execution when a pure core cannot represent its identity',async()=>{
  const source='"use strict";function run(f=()=>n,n=7){return f();}';
  assert.equal(defineRegionProgram({source,entry:'run'}).program.algorithm,null);
  const result=await verifyRegionTrainingCase({source,entry:'run',family:'forward-parameter-closure',fixture:{calls:[]}});
  assert(result.exported,result.reason);assert.equal(result.status,'detailed-fallback');
  assert.deepEqual(RegionExecutionHarness.replay(result.exported).controller.completion,{kind:'return',value:['num',7]});
  assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
});

test('supported prototype and Proxy state route through independently checked protocol evidence',async()=>{
  for(const [body,value] of [
    ['const p={x:4};const o=Object.create(p);return o.x;',4],
    ['const o={__proto__:null,x:3};return o.x;',3],
    ['return new Proxy({x:3},{get:function(t,k,r){return t[k]+1;}}).x;',4]
  ]){
    const result=await verifyRegionTrainingCase({source:'"use strict";function run(){'+body+'}',
      entry:'run',family:'qualified-behavioral-state',fixture:{calls:[]}});
    assert(result.exported,result.reason);
    const artifact=result.exported,replayed=RegionExecutionHarness.replay(artifact);
    assert.equal(artifact.sidecar.schema,'semantic-protocol-region-evidence/1');
    assert.equal(artifact.sidecar.sourceArtifact.sidecar.reference.metadataAudit.status,'agreed');
    assert.deepEqual(replayed.controller.completion,{kind:'return',value:['num',value]});
    const restored=RegionExecutionHarness.restore(JSON.parse(JSON.stringify(replayed.checkpoint())));
    assert.deepEqual(restored.exportEpisode(),artifact.public);
    assert.equal((await recheckRegionEvidence(artifact)).sourceValidated,true);
  }
});

test('unqualified live prototype replacement is not flattened into a scalar-only trace',async()=>{
  const source='"use strict";function run(){const o={};const p={x:4};Object.setPrototypeOf(o,p);return Object.getPrototypeOf(o)===p;}',
    result=await verifyRegionTrainingCase({source,entry:'run',family:'unsupported-prototype-replacement',fixture:{calls:[]}});
  assert.equal(result.status,'projection_refused',result.reason);
  assert.match(result.reason,/explicit v8 (behavioral-state|protocol) profile/);
  assert.equal(result.exported,undefined);
});

test('class, private slots and constructor completion cannot be flattened by the historical detailed state profile',()=>{
  for(const node of [
    {kind:'function',classConstructor:true},
    {kind:'object',privateSlots:{}},
    {kind:'object',privateKinds:{brand:'field'}},
    {kind:'object',privateVersions:{brand:1}},
    {kind:'function',prototypeInitialized:true},
    {kind:'function',dataAttributes:{prototype:{enumerable:false,writable:false,configurable:false}}},
    {kind:'object',prototype:['ref','proto']},
    {kind:'array',extensible:false},
    {kind:'array',templateSite:'source:site'},
    {kind:'array',templateRawOf:'cooked'}
  ])assert.throws(()=>checkEffectfulProjectionState({initialState:{heap:{o:node}}}),/explicit v8 behavioral-state/);
  assert.throws(()=>checkEffectfulProjectionState({initialState:{frames:{f:{constructReceiver:['ref','o']}}}}),/construction completion/);
  assert.throws(()=>checkEffectfulProjectionState({initialState:{frames:{f:{afterInstanceInitialization:{}}}}}),/construction completion/);
  assert.throws(()=>checkEffectfulProjectionState({initialState:{frames:{f:{classStaticResult:['ref','o']}}}}),/construction completion/);
  assert.throws(()=>checkEffectfulProjectionState({initialState:{control:{a0:{templateObjects:{site:'cooked'}}}}}),/template site identity/);
  const ordinaryNull={kind:'object',prototype:null,properties:{}};
  assert.equal(checkEffectfulProjectionState({initialState:{heap:{o:ordinaryNull}}}).valid,true);
  assert.equal(checkEffectfulProjectionState({initialState:{},events:[{operation:'external.input.deliver',
    stateChanges:[{table:'heap',before:null,after:ordinaryNull}]}]}).valid,true);
});

test('forward closures cross only proved pure parameter data scaffolding and retain live capture cells',async()=>{
  for(const [code,args,expected] of [
    ['function run(f=()=>n,{n=7}={}){return f();}',[],7],
    ['function run(f=()=>n,{n=7}={}){return f();}',[undefined,{n:11}],11],
    ['function run(f=()=>n,{n}={n:7}){return f();}',[],7],
    ['function run(x=2,f=()=>n+x,{n=7}={}){n+=1;return f();}',[],10]
  ]){
    const source='"use strict";'+code;
    const result=await verifyRegionTrainingCase({source,entry:'run',args,family:'deferred-pattern-capture',fixture:{calls:[]}});
    assert(result.exported,result.reason);
    const controller=RegionExecutionHarness.replay(result.exported).controller;
    assert.deepEqual(controller.completion,{kind:'return',value:['num',expected]});
    assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
    assert(result.exported.sidecar.sourceArtifact.sidecar.compiler.certificates.some(row=>
      row.rule==='owned-deferred-parameter-initialization/1'&&row.parameterDataProof.regions.length>0));
  }
});

test('early capture reads, getters, calls and shared parameter writes cannot cross deferred publication',async()=>{
  for(const code of [
    'function run(f=()=>n,n=f()){return n;}',
    'function run(f=()=>n,{n}={get n(){return 7;}}){return f();}',
    'function run(x=0,f=()=>n,n=(x=4)){return [x,f()];}',
    'function run(f=()=>n,n=f===f){return f();}'
  ]){
    const source='"use strict";'+code;
    runtimeDifferential('',{source});
    const result=await verifyRegionTrainingCase({source,entry:'run',family:'deferred-capture-near-miss',fixture:{calls:[]}});
    assert.equal(result.status,'projection_refused',result.reason);
    assert.match(result.reason,/deferred parameter closure|deferred closure/);
  }
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
