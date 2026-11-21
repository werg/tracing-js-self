import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {causalLmV8Prompt,encodeCausalLmV8Example,validateRegionTrainingContexts,
  createCausalLmV8Selector,auditRegionServingCosts} from '../src/semantic/causal-lm-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {encodePureRegionRecord,decodePureRegionRecord} from '../src/semantic/pure-region-v8.js';
import {encodeDetailedRecord} from '../src/semantic/detailed-v7.js';
import {verifyRegionTrainingCase} from '../src/semantic/compiler-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';

const fixtures=JSON.parse(await readFile(new URL('./fixtures/semantic-regions-v8.json',import.meta.url)));
const example=id=>fixtures.examples.find(row=>row.id===id);
const tokenizer={identity:'e'.repeat(64),encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids)};
const options={tokenizer,eosTokenId:256,maxContextTokens:1000000};

test('v8 masks include only generated line and EOS, with full published state in the actual prompt',async()=>{
  const artifact=example('ordered-map'),context=artifact.contexts[0],
    row=artifact.public.timeline.find(row=>row.mode==='generated');
  const encoded=await encodeCausalLmV8Example(context,row.fields.line,options);
  assert.equal(encoded.prompt,causalLmV8Prompt(context));
  assert.match(encoded.prompt,/semantic-algorithm\/2/);
  assert.match(encoded.prompt,/captureAliases/);
  assert.equal(encoded.prompt.includes('sourceArtifact'),false);
  assert.equal(encoded.prompt.includes('reference.outcome'),false);
  assert.deepEqual(encoded.labels.slice(0,encoded.boundaries.promptTokens),
    Array(encoded.boundaries.promptTokens).fill(-100));
  assert.deepEqual(encoded.labels.slice(encoded.boundaries.promptTokens),[...Buffer.from(row.fields.line),256]);
  assert.equal(encoded.inputIds.length,encoded.costs.flatContextTokens);
  assert.equal(encoded.inputIds.length,Buffer.byteLength(encoded.prompt)+Buffer.byteLength(row.fields.line)+1);
  await assert.rejects(encodeCausalLmV8Example(context,row.fields.line,{...options,maxContextTokens:2}),/budget/);
  const result=example('causal-counter').public.timeline.find(row=>row.kind==='result');
  await assert.rejects(encodeCausalLmV8Example(context,result.fields.line,options),/generated|result|observation/);
});

test('every v8 training context must equal its reconstructed causal prefix',()=>{
  for(const fixture of fixtures.examples)assert.equal(validateRegionTrainingContexts(fixture).length,fixture.contexts.length);
  const changed=structuredClone(example('shared-getter'));
  changed.contexts[0].state.locals.push(['future',['num',200]]);
  assert.throws(()=>validateRegionTrainingContexts(changed),/already published state/);
  const extra=structuredClone(example('ordered-map').contexts[0]);extra.futureOutcome=['num',18];
  assert.throws(()=>causalLmV8Prompt(extra),/fields|unknown/);
  const privateState=structuredClone(example('ordered-map').contexts[0]);privateState.state.sourceArchive={};
  assert.throws(()=>causalLmV8Prompt(privateState),/fields|unknown/);
  const legacy=structuredClone(example('ordered-map').contexts[0]);legacy.schema='semantic-context/7';
  assert.throws(()=>causalLmV8Prompt(legacy),/v8 context/);
});

test('v8 cost meter measures expanded physical prompts and targets including repeated definitions',async()=>{
  const artifact=example('ordered-map'),unmeasured=await auditRegionServingCosts(artifact);
  assert.equal(unmeasured.measurement,'untested');assert.equal(unmeasured.tokens.total,null);
  const measured=await auditRegionServingCosts(artifact,options);
  assert.equal(measured.predictions,2);assert.equal(measured.rows.length,artifact.contexts.length);
  assert.equal(measured.tokens.total,measured.rows.reduce((sum,row)=>sum+row.inputIds.length,0));
  assert.equal(measured.tokens.terminal,2);assert.equal(measured.bytes.cumulativeContext,
    measured.rows.reduce((sum,row)=>sum+Buffer.byteLength(row.prompt),0));
  for(const row of measured.rows)assert.match(row.prompt,/semantic-algorithm\/2/);
  assert.equal(measured.rows[0].detail,false);assert.equal(measured.rows[1].detail,true);
  assert.equal(measured.model.status,'untested');assert.equal(measured.native.status,'untested');
});

test('retained callback inputs are public context identities and remain fully metered',async()=>{
  for(const id of ['callback-captured-write','persistent-external-trigger']){
    const result=await verifyRegionTrainingCase(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id));
    assert(result.exported,result.reason);
    const artifact=result.exported,context=artifact.contexts.find(row=>row.input.retained?.length);
    assert(context,'fixture must exercise retained invocation inputs');
    assert.match(causalLmV8Prompt(context),/"retained"/);
    const cost=await auditRegionServingCosts(artifact);
    assert.equal(cost.predictions,artifact.contexts.length);
    assert(cost.bytes.cumulativeContext>0);
    const missing=structuredClone(context);missing.input.retained.push('unavailable-object');
    assert.throws(()=>causalLmV8Prompt(missing),/retained input identities/);
    const future=structuredClone(context);future.input.future=['num',999];
    assert.throws(()=>causalLmV8Prompt(future),/immutable input fields/);
  }
});

test('callback-owned Promise work meters recorded host closure exactly once without live synthesis',async()=>{
  for(const id of ['callback-owned-join','callback-owned-join-awaited']){
    const result=await verifyRegionTrainingCase(HOST_PROTOCOL_FIXTURES_V8.find(row=>row.id===id));
    assert(result.exported,result.reason);
    const artifact=result.exported,before=structuredClone(artifact),
      close=artifact.public.timeline.find(row=>row.kind==='handler-close');
    assert(close,'the source must retain its host closure observation');
    const rows=validateRegionTrainingContexts(artifact),cost=await auditRegionServingCosts(artifact,options);
    assert.equal(rows.length,artifact.contexts.length);
    assert.equal(cost.predictions,artifact.contexts.length);
    assert.equal(cost.tokens.terminal,artifact.contexts.length);
    assert.deepEqual(rows.map(item=>item.row.sequence),artifact.public.timeline.filter(row=>row.mode==='generated').map(row=>row.sequence));
    assert.deepEqual(artifact,before,'context reconstruction cannot rewrite the original source evidence');
    const forged=structuredClone(artifact);
    forged.public.timeline.find(row=>row.kind==='handler-close').fields.subscriptionId='unregistered-handler';
    assert.throws(()=>validateRegionTrainingContexts(forged));
    const future=structuredClone(artifact);
    future.contexts.find(row=>row.invocationId!=='root').visibleThrough++;
    assert.throws(()=>validateRegionTrainingContexts(future),/already published state/);
  }
});

test('serving checks original model bytes against shared state and counts rejected attempts and retries',async()=>{
  const artifact=example('ordered-map'),target=artifact.public.timeline.find(row=>row.kind==='algorithm');
  const falseRecord=decodePureRegionRecord(target.fields.line);
  falseRecord.allocations[0].properties[0].value=['num',999];
  const emitted=[encodePureRegionRecord(falseRecord),target.fields.line];
  const runtime={initialize:async request=>request,generate:async()=>({tokenIds:[...Buffer.from(emitted.shift()),256],stopReason:'eos'})};
  const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity:'c'.repeat(64),maxNewTokens:2048});
  await selector.initialize({checkpointIdentity:'c'.repeat(64),seed:17});
  const prefix={...artifact.public,timeline:artifact.public.timeline.slice(0,target.sequence-1)},
    harness=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),before=harness.modelContext(target.fields.invocationId);
  await assert.rejects(selector.selectInto(harness,target.fields.invocationId),/false algorithm/);
  assert.deepEqual(harness.modelContext(target.fields.invocationId),before);
  const accepted=await selector.selectInto(harness,target.fields.invocationId);
  assert.equal(accepted.record,target.fields.line);assert.equal(accepted.selection.status,'accepted');
  const metrics=selector.metrics();assert.equal(metrics.predictionAttempts,2);assert.equal(metrics.retries,1);
  assert.equal(metrics.failedAttempts,1);assert.equal(metrics.semanticallyAccepted,1);
  assert.equal(metrics.emissions[0].prompt,metrics.emissions[1].prompt);
  assert.equal(metrics.promptTokens,2*Buffer.byteLength(causalLmV8Prompt(before)));
  assert.equal(metrics.nativeAdmissionClaim,false);assert.equal(metrics.sourceAdmissionClaim,false);
});

test('live detailed selection rejects false claims atomically and keeps the original failed emission',async()=>{
  const compute={kind:'compute',fields:{expr:{op:'binary',operator:'+',left:{op:'local',name:'x'},
    right:{op:'literal',value:['num',1]}},result:['num',4],bind:'n',invocation:'i'}};
  const choose={kind:'choose',fields:{expr:{op:'literal',value:['bool',false]},decision:['bool',false],
    path:'else',invocation:'i'}};
  const summarize={kind:'summarize',fields:{entry:'run',arguments:[['num',3]],result:['num',4],profile:'pure-helper/1'}};
  const cases=[
    {valid:compute,invalid:{...compute,fields:{...compute.fields,result:['num',999]}}},
    {valid:compute,invalid:{...compute,fields:{...compute.fields,expr:{op:'local',name:'missing'}}}},
    {valid:choose,invalid:{...choose,fields:{...choose.fields,decision:['bool',true],path:'then'}}},
    {valid:choose,invalid:{...choose,fields:{...choose.fields,path:'then'}}},
    {valid:summarize,invalid:{...summarize,fields:{...summarize.fields,result:['num',999]}}}
  ];
  for(const {valid,invalid} of cases){
    const harness=new RegionExecutionHarness({sessionId:'detailed-claims'});
    harness.publishProgram({programId:'p',source:'"use strict";function run(x){return x+1;}',entry:'run'});
    harness.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3]});
    const before=harness.checkpoint(),rejected=encodeDetailedRecord(invalid,{role:'generated'}),
      accepted=encodeDetailedRecord(valid,{role:'generated'}),emitted=[rejected,accepted];
    const runtime={initialize:async request=>request,
      generate:async()=>({tokenIds:[...Buffer.from(emitted.shift()),256],stopReason:'eos'})};
    const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity:'c'.repeat(64),maxNewTokens:2048});
    await selector.initialize({checkpointIdentity:'c'.repeat(64),seed:17});
    await assert.rejects(selector.selectInto(harness,'i'),/false detailed/);
    assert.deepEqual(harness.checkpoint(),before,invalid.kind+' changed the live machine');
    assert.equal(harness.controller.firstWitnessViolation,null);
    const failure=selector.metrics();
    assert.equal(failure.failedAttempts,1);assert.equal(failure.semanticallyAccepted,0);
    assert.equal(failure.emissions[0].status,'semantic-rejected');
    assert.deepEqual(failure.emissions[0].emittedTokenIds,[...Buffer.from(rejected),256]);
    assert.equal(failure.emissions[0].payloadHex,Buffer.from(rejected).toString('hex'));
    const selection=await selector.selectInto(harness,'i');
    assert.equal(selection.record,accepted);assert.equal(selection.selection.sourceAdmissionClaim,false);
    const metrics=selector.metrics();
    assert.equal(metrics.semanticallyAccepted,1);assert.equal(metrics.failedAttempts,1);assert.equal(metrics.retries,1);
    assert.equal(metrics.emissions[0].prompt,metrics.emissions[1].prompt);
    assert.equal(harness.controller.firstWitnessViolation,null);
  }
});

test('a live selector cannot accept later work on a diagnostically false prefix',async()=>{
  const harness=new RegionExecutionHarness({sessionId:'false-prefix'});
  harness.publishProgram({programId:'p',source:'"use strict";function run(x){return x+1;}',entry:'run'});
  harness.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'r',triggerId:'entry',args:[3]});
  // Direct diagnostic replay still preserves the supplied false value; live
  // model serving must not turn a later well-formed record into an acceptance.
  harness.select('i',{kind:'compute',fields:{expr:{op:'literal',value:['num',4]},result:['num',999],bind:'n'}});
  assert.equal(harness.controller.firstWitnessViolation.consistent,false);
  assert.deepEqual(harness.controller.visibleLocals().get('n'),['num',999]);
  const before=harness.checkpoint(),record=encodeDetailedRecord({kind:'return',fields:{value:['num',4]}},{role:'generated'});
  const runtime={initialize:async request=>request,
    generate:async()=>({tokenIds:[...Buffer.from(record),256],stopReason:'eos'})};
  const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity:'c'.repeat(64),maxNewTokens:2048});
  await selector.initialize({checkpointIdentity:'c'.repeat(64),seed:17});
  await assert.rejects(selector.selectInto(harness,'i'),/prefix contains a false witness/);
  assert.deepEqual(harness.checkpoint(),before);
  assert.equal(selector.metrics().semanticallyAccepted,0);
  assert.equal(selector.metrics().failedAttempts,1);
});

test('failed v8 checkpoint attestation invalidates earlier model selection',async()=>{
  const context=example('ordered-map').contexts[0],
    target=example('ordered-map').public.timeline.find(row=>row.kind==='algorithm').fields.line,
    checkpointIdentity='c'.repeat(64);
  let generated=0;
  const runtime={
    initialize:async request=>request.seed===2?{...request,checkpointIdentity:'f'.repeat(64)}:request,
    generate:async()=>{generated++;return {tokenIds:[...Buffer.from(target),256],stopReason:'eos'};}
  };
  const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity,maxNewTokens:2048});
  await selector.initialize({checkpointIdentity,seed:1});
  await assert.rejects(selector.initialize({checkpointIdentity,seed:2}),/attestation/);
  await assert.rejects(selector(context),/not attested/);
  assert.equal(generated,0);
  await selector.initialize({checkpointIdentity,seed:3});
  assert.equal((await selector(context)).record,target);
  assert.equal(generated,1);
  await assert.rejects(selector.initialize({checkpointIdentity:'f'.repeat(64),seed:4}),/frozen weights/);
  await assert.rejects(selector(context),/not attested/);
});

test('in-flight v8 model generation cannot cross a fresh checkpoint initialization',async()=>{
  const context=example('ordered-map').contexts[0],
    target=example('ordered-map').public.timeline.find(row=>row.kind==='algorithm').fields.line,
    checkpointIdentity='c'.repeat(64);
  let finishGeneration,signalStart;
  const generation=new Promise(resolve=>{finishGeneration=resolve;});
  const started=new Promise(resolve=>{signalStart=resolve;});
  const runtime={
    initialize:async request=>request,
    generate:async()=>{signalStart();return generation;}
  };
  const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity,maxNewTokens:2048});
  await selector.initialize({checkpointIdentity,seed:1});
  const pending=selector(context);
  await started;
  await selector.initialize({checkpointIdentity,seed:2});
  finishGeneration({tokenIds:[...Buffer.from(target),256],stopReason:'eos'});
  await assert.rejects(pending,/initialization changed during generation/);
  assert.equal(selector.metrics().failedAttempts,1);
});

test('v8 selector refuses otherwise valid tokens when the causal prefix changes during inference',async()=>{
  const artifact=example('ordered-map'),target=artifact.public.timeline.find(row=>row.kind==='algorithm'),
    prefix={...artifact.public,timeline:artifact.public.timeline.slice(0,target.sequence-1)},
    harness=RegionExecutionHarness.replay(prefix,{requireTerminal:false}),
    invocationId=target.fields.invocationId,checkpointIdentity='c'.repeat(64);
  const before=harness.modelContext(invocationId);
  const runtime={
    initialize:async request=>request,
    generate:async()=>{
      // A concurrent producer commits the same valid record while the model
      // is still selecting it. Replaying its bytes cannot authorize a second
      // commit from a context that is no longer the actual public prefix.
      harness.select(invocationId,target.fields.line,{entry:target.fields.entry});
      return {tokenIds:[...Buffer.from(target.fields.line),256],stopReason:'eos'};
    }
  };
  const selector=createCausalLmV8Selector({...options,runtime,checkpointIdentity,maxNewTokens:2048});
  await selector.initialize({checkpointIdentity,seed:1});
  await assert.rejects(selector.selectInto(harness,invocationId),/public context changed during generation/);
  assert.notDeepEqual(harness.modelContext(invocationId),before);
  assert.equal(harness.timeline.length,target.sequence);
  assert.equal(selector.metrics().semanticallyAccepted,0);
  assert.equal(selector.metrics().failedAttempts,1);
});
