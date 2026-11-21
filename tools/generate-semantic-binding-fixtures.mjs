#!/usr/bin/env node
// Independently recheck source detail, then adapt only redundant/unused host
// binding metadata. This is bounded interoperability evidence, not admission of
// arbitrary binding changes or a learned execution result.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {BINDING_ORDER_FIXTURES_V8} from '../fixtures/semantic-regions/binding-order.js';
import {verifySourceTrainingCaseV8,recheckSourceAdmissionV8} from '../src/semantic/source-admission-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {defineRegionProgram} from '../src/semantic/regions.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';

const args=process.argv.slice(2),check=args.includes('--check');
if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-semantic-binding-fixtures.mjs [--check]');
const cases=[];
for(const fixture of BINDING_ORDER_FIXTURES_V8){
  const sourceInput={source:fixture.source,entry:fixture.entry,args:fixture.args,
    family:'binding-order:'+fixture.id,fixture:{calls:[]},
    projectionOptions:{semanticRegions:false,localStateCompaction:false}};
  const qualified=await verifySourceTrainingCaseV8(sourceInput);
  if(!qualified.exported)throw new Error(fixture.id+': source did not qualify: '+qualified.reason);
  await recheckSourceAdmissionV8(qualified.exported,{requireAdmitted:false});
  const declared=analyzeSemanticProgram(fixture.source).functions.find(row=>row.name===fixture.entry).params;
  assert.deepEqual(declared,fixture.declaredParameters);
  for(const [name,index]of Object.entries(fixture.bindings)){
    assert.match(name,/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u);
    if(declared.includes(name))assert.equal(index,declared.indexOf(name),'declared binding must preserve source argument');
    else assert(!fixture.source.includes(name),'extra binding must be absent from this bounded source');
  }
  const sourceRows=qualified.exported.public.timeline;
  const harness=new RegionExecutionHarness({sessionId:sourceRows[0].session,automaticDelivery:false,now:()=>-Infinity});
  const contexts=[];
  let initialState;
  for(const row of sourceRows){
    if(row.kind==='model-context')continue;
    if(row.mode==='observed'){
      const {schema,sequence,ownerSequence,mode,kind,traceFormat,...fields}=structuredClone(row);
      if(kind==='program')fields.regionProgram=defineRegionProgram({source:fields.source,entry:fields.entry}).program;
      if(kind==='invocation'){
        fields.bindings=structuredClone(fixture.bindings);
        assert.equal(fields.entry,fixture.entry);
        assert.deepEqual(fields.inputGraph.roots,fixture.args.map(value=>['num',value]));
      }
      harness.importObserved({mode,kind,fields});
      if(kind==='invocation'){
        const controller=harness.invocations.get(fields.invocationId).controller;
        assert.deepEqual([...controller.captureAliases],fixture.expectedAliases);
        assert.deepEqual(fixture.expectedAliases.map(([,cell])=>controller.locals.get(cell)),fixture.expectedValues);
        initialState={aliases:[...controller.captureAliases],locals:[...controller.locals]};
      }
    }else{
      assert.equal(row.kind,'semantic');
      contexts.push(harness.modelContext(row.invocationId));
      harness.select(row.invocationId,row.line);
    }
  }
  const artifact={public:harness.exportEpisode(),contexts};
  assert.deepEqual(artifact.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line),
    sourceRows.filter(row=>row.mode==='generated').map(row=>row.line),'generated source detail must remain exact');
  const canonical=JSON.parse(stableAlgorithmJSON(artifact));
  for(const value of [artifact,canonical])assert.deepEqual(RegionExecutionHarness.replay(value).exportEpisode(),artifact.public);
  const restored=RegionExecutionHarness.restore(JSON.parse(stableAlgorithmJSON(harness.checkpoint())));
  assert.deepEqual(restored.exportEpisode(),artifact.public);
  assert.deepEqual(restored.controller.segmentPacket(),harness.controller.segmentPacket());
  cases.push({id:fixture.id,sourceInputDigest:hashAlgorithmData(sourceInput),
    sourcePublicDigest:hashAlgorithmData(qualified.exported.public),
    bindings:fixture.bindings,declaredParameters:declared,initialState,artifact});
}
const fixture={schema:'semantic-binding-order-interoperability/1',
  qualification:{source:'freshly-rechecked-original-detail',
    bindingAdaptation:'redundant positional mappings or names absent from original source; exact generated detail',
    public:'replayed-original-and-canonical',recovery:'canonical-complete-checkpoint',
    native:'untested',admission:'not-claimed',model:'unmeasured'},cases};
const path=new URL('../test/fixtures/semantic-binding-order-v8.json',import.meta.url),bytes=JSON.stringify(fixture,null,2)+'\n';
if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
else await writeFile(path,bytes);
console.log(JSON.stringify({valid:true,mode:check?'checked':'generated',cases:cases.map(row=>({id:row.id,
  publicDigest:hashAlgorithmData(row.artifact.public),contextDigest:hashAlgorithmData(row.artifact.contexts),
  initialState:row.initialState}))}));
