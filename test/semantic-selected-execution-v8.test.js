import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runSelectedRegionExecution} from '../src/semantic/selected-execution-v8.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';

const golden=JSON.parse(await readFile(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)));
const protocols=JSON.parse(await readFile(new URL('./fixtures/semantic-protocol-source-v8.json',import.meta.url)));
const pin={checkpointIdentity:'c'.repeat(64),tokenizerIdentity:'e'.repeat(64),seed:17};
function input(artifact){const end=artifact.public.timeline.findIndex(row=>row.mode==='generated');
  return {...artifact.public,timeline:artifact.public.timeline.slice(0,end)};}
function fixtureSelector(artifact,{commit=null,mutate=null}={}){
  const requests=[],commits=[],rows=new Map();
  for(const row of artifact.public.timeline.filter(row=>row.mode==='generated')){
    if(!rows.has(row.fields.invocationId))rows.set(row.fields.invocationId,[]);
    rows.get(row.fields.invocationId).push(row.fields.line);
  }
  const select=async request=>{
    requests.push(structuredClone(request));
    assert.equal(request.contexts.length,request.public.timeline.filter(row=>row.mode==='generated').length);
    assert.equal(request.context.visibleThrough,request.public.timeline.length);
    assert(!JSON.stringify(request).includes('sourceArtifact'));
    const id=request.context.invocationId,index=request.public.timeline.filter(row=>
      row.mode==='generated'&&row.fields.invocationId===id).length;
    const original=rows.get(id)?.[index];assert.equal(typeof original,'string','explicit engineering selection exhausted');
    return {record:mutate?mutate(original,index,request):original,selection:{origin:'engineering-injected'}};
  };
  select.initialize=async request=>request;
  select.commit=async request=>{commits.push(structuredClone(request));
    assert.equal(request.contexts.length,request.public.timeline.filter(row=>row.mode==='generated').length);
    return commit?commit(request):{committed:true};};
  select.complete=async()=>({completed:true});select.cancel=async()=>({cancelled:true});
  return {select,requests,commits};
}

test('v8 runner selects whole algorithms, mixed regions and protocols through one acknowledged authority',async()=>{
  for(const id of ['ordered-map','shared-getter','source-symbol-getter-arithmetic']){
    const source=protocols.cases.find(row=>row.id===id),artifact=golden.examples.find(row=>row.id===id)??
      (await verifyRegionTrainingCase({...source,family:'selected-test-'+id,fixture:{calls:[]}})).exported;
    assert(artifact,id);
    const adapter=fixtureSelector(artifact),result=await runSelectedRegionExecution({initialPublic:input(artifact),
      select:adapter.select,...pin,origin:'engineering'});
    assert.equal(result.status,'completed',JSON.stringify(result.failure));
    assert.equal(result.publicCompleted,true);assert.equal(result.sourceValidated,false);
    assert.equal(result.completedExecution,false);assert.equal(result.qualification.modelMeasurement,'engineering-only');
    assert.equal(result.attempts.length,artifact.contexts.length);
    assert.equal(adapter.commits.length,result.attempts.length);
    assert.deepEqual(result.public,artifact.public);
  }
});

test('v8 runner completes deferred callbacks and retained subscriptions through the existing lifecycle',async()=>{
  for(const id of ['callback-captured-write','persistent-external-trigger']){
    const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id),verified=await verifyRegionTrainingCase(fixture);
    assert(verified.exported,verified.reason);
    const adapter=fixtureSelector(verified.exported),result=await runSelectedRegionExecution({
      initialPublic:input(verified.exported),fixture:fixture.fixture,select:adapter.select,...pin,origin:'engineering'});
    assert.equal(result.status,'completed',id+': '+JSON.stringify(result.failure));
    assert.deepEqual(result.completion,{kind:'return',value:['num',id==='callback-captured-write'?7:5]});
    assert.equal(result.effects.filter(row=>row.kind==='callback').length,2);
    assert(result.public.timeline.filter(row=>row.kind==='invocation').length>1);
    assert.equal(result.costs.hostDispatches,fixture.fixture.calls.length);
  }
});

test('v8 runner drives causal fixture observations without giving future replies to the selector',async()=>{
  const fixture=structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'));
  fixture.fixture.calls[0].result=987654321;fixture.fixture.calls[1].arguments[1]=987654322;
  const verified=await verifyRegionTrainingCase(fixture);assert(verified.exported,verified.reason);
  const adapter=fixtureSelector(verified.exported),result=await runSelectedRegionExecution({
    initialPublic:input(verified.exported),fixture:fixture.fixture,select:adapter.select,...pin,origin:'engineering'});
  assert.equal(result.status,'completed',JSON.stringify(result.failure));
  assert.deepEqual(result.completion,{kind:'return',value:['num',987654322]});
  assert.equal(result.costs.hostDispatches,2);
  assert(!JSON.stringify(adapter.requests[0]).includes('987654321'));
  const beforeResult=adapter.requests.filter(row=>!row.public.timeline.some(item=>item.kind==='result'));
  for(const request of beforeResult)assert(!JSON.stringify(request).includes('987654321'));
  assert.equal(result.effects.filter(row=>row.kind==='dispatch').length,2);
});

test('native acknowledgement failure stops continuation and prevents a committed request from dispatching',async()=>{
  const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0'),verified=await verifyRegionTrainingCase(fixture);
  assert(verified.exported,verified.reason);
  const adapter=fixtureSelector(verified.exported,{commit:request=>{
    if(request.record.includes('"kind":"request"'))throw new Error('native acknowledgement failed');
    return {committed:true};
  }});
  const result=await runSelectedRegionExecution({initialPublic:input(verified.exported),fixture:fixture.fixture,
    select:adapter.select,...pin,origin:'engineering'});
  assert.equal(result.status,'failed');assert.match(result.failure.message,/native acknowledgement/);
  assert.equal(result.costs.hostDispatches,0);assert.equal(result.effects.length,0);
  assert.equal(adapter.requests.length,adapter.commits.length);
  assert.equal(result.attempts.at(-1).status,'commit-failed');
});

test('v8 execution failures preserve original bytes and do not claim complete source execution',async()=>{
  const artifact=golden.examples.find(row=>row.id==='ordered-map'),bad='detail not canonical',
    adapter=fixtureSelector(artifact,{mutate:()=>bad});
  const result=await runSelectedRegionExecution({initialPublic:input(artifact),select:adapter.select,...pin,origin:'engineering'});
  assert.equal(result.status,'failed');assert.equal(result.publicCompleted,false);assert.equal(result.sourceValidated,false);
  assert.equal(result.attempts[0].record,bad);assert.equal(adapter.commits.length,0);
  assert.equal(result.costs.unknownGenerationCostAttempts,1);
  const exhausted=await runSelectedRegionExecution({initialPublic:input(artifact),
    select:fixtureSelector(artifact).select,...pin,origin:'engineering',maxPredictions:1});
  assert.equal(exhausted.status,'resource_limited');assert.equal(exhausted.publicCompleted,false);
});

test('v8 runner distinguishes a publicly legal wrong-source completion from source validation',async()=>{
  const artifact=golden.examples.find(row=>row.id==='ordered-map');
  const lines=[encodeDetailedRecord({kind:'return',fields:{value:['num',999]}},{role:'generated'}),
    encodeDetailedRecord({kind:'end',fields:{kind:'return'}},{role:'generated'})];
  const select=async()=>({record:lines.shift(),selection:{origin:'engineering-injected'}});
  select.initialize=async request=>request;
  const result=await runSelectedRegionExecution({initialPublic:input(artifact),select,...pin,origin:'engineering'});
  assert.equal(result.publicCompleted,true);assert.equal(result.publicAccepted,true);
  assert.equal(result.sourceValidated,false);assert.equal(result.completedExecution,false);
  assert.deepEqual(result.completion,{kind:'return',value:['num',999]});
});

test('model mode cannot silently run an engineering selector or mismatched checkpoint',async()=>{
  const artifact=golden.examples.find(row=>row.id==='ordered-map'),adapter=fixtureSelector(artifact);
  const result=await runSelectedRegionExecution({initialPublic:input(artifact),select:adapter.select,...pin,origin:'model'});
  assert.equal(result.status,'failed');assert.match(result.failure.message,/original model selection provenance/);
  const changed=fixtureSelector(artifact);changed.select.initialize=async request=>({...request,checkpointIdentity:'f'.repeat(64)});
  const refused=await runSelectedRegionExecution({initialPublic:input(artifact),select:changed.select,...pin,origin:'model'});
  assert.equal(refused.status,'failed');assert.equal(refused.attempts.length,0);
});
