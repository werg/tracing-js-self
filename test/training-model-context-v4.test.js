import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {decodeWitness,MODEL_CONTEXT_INTERVAL} from '../src/training/format.js';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isState=item=>item.kind==='model-context'&&Object.hasOwn(item,'selectedState');
const fixture=EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id==='long-callback-retained-tail');
let exported;
test.before(async()=>{
  const result=await verifyEffectfulTrainingCase({...fixture,projectionOptions:{representation:'compact'}});
  assert.equal(result.status,'locally_verified',result.reason);exported=result.exported;
});

test('long callback tail publishes bounded observed code and exact publicly replayed selected state',async()=>{
  const timeline=exported.public.timeline,callback=timeline.find(item=>item.kind==='invocation'&&item.activation==='callback');
  const root=timeline.find(item=>item.kind==='invocation'&&item.parentInvocationId===null);
  const decoded=timeline.filter(item=>item.kind==='semantic').map(item=>({...item,...decodeWitness(item.line)}));
  const captured=decoded.find(item=>item.kind==='allocate'&&item.fields.kind==='closure').fields.captures
    .find(item=>item.binding==='seen').cell;
  const mutation=decoded.find(item=>item.invocationId===callback.invocationId&&item.kind==='bind'&&item.fields.name===captured);
  const resume=decoded.find(item=>item.invocationId===root.invocationId&&item.kind==='resume');
  assert(decoded.filter(item=>item.sequence>mutation.sequence&&item.sequence<resume.sequence).length>128);
  const receipts=timeline.filter(isState),callbackReceipts=receipts.filter(item=>item.invocationId===callback.invocationId);
  assert(callbackReceipts.length>=7);
  for(const [index,receipt] of callbackReceipts.entries()){
    const next=callbackReceipts[index+1]?.sequence??Infinity;
    assert(decoded.filter(item=>item.invocationId===callback.invocationId&&
      item.sequence>receipt.sequence&&item.sequence<next).length<=MODEL_CONTEXT_INTERVAL);
  }
  for(const receipt of receipts){
    assert.equal(receipt.mode,'observed');assert.equal(receipt.visibleThrough,receipt.sequence-1);
    const previous=timeline[receipt.sequence-2];
    assert.equal(previous.kind,'source-read');assert.equal(previous.track,receipt.track);
    const replay=SelectedExecutionHarness.replay({public:{...exported.public,
      timeline:timeline.slice(0,receipt.sequence-1)}},{requireTerminal:false});
    const context=replay.selectionContext(receipt.invocationId);
    assert.deepEqual(receipt.selectedState,context.selectedState);
    assert.equal(receipt.realmPrefixDigest,digest(context.realmCommitted));
  }
  const parentContext=receipts.findLast(item=>item.invocationId===root.invocationId&&item.sequence<resume.sequence);
  assert.deepEqual(new Map(parentContext.selectedState.locals).get(captured),['num',3]);
  const checked=await recheckEffectfulAdmission(exported,{requireAdmitted:false});
  assert(checked.sourceValidated&&checked.replayValidated);
  const rendered=SelectedExecutionHarness.replay(exported).inspect();
  assert(rendered.some(line=>line.includes('observed: refresh committed selected state through')));
  assert(!rendered.some(line=>line.includes('"heap":')),'normal inspection does not dump the state packet');
});

test('source-certified long callback tail executes with the same pre-inference state refresh path',async()=>{
  const fixture=controlledEvaluationCase(exported,{id:'bounded-callback-context'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,seed:17,representation:'compact'});
  assert.equal(actual.failure,null,JSON.stringify(actual.failure));assert.deepEqual(actual.outcome,fixture.expected);
  assert(actual.episode.public.timeline.filter(isState).length>=8);
  SelectedExecutionHarness.replay(actual.episode);
});

test('forged selected snapshots and future cutoffs fail exact public replay and checkpoint restoration',()=>{
  for(const alter of [
    receipt=>{receipt.selectedState.locals[0][1]=['num',999];},
    receipt=>{receipt.visibleThrough=receipt.sequence;},
    receipt=>{receipt.realmPrefixDigest='0'.repeat(64);}
  ]){
    const forged=structuredClone(exported);alter(forged.public.timeline.find(isState));
    assert.throws(()=>SelectedExecutionHarness.replay(forged),/Replay|context|cutoff|fields/);
  }
  const packet=SelectedExecutionHarness.replay(exported).checkpoint();
  packet.timeline.find(isState).selectedState.locals[0][1]=['num',999];
  const {integrity,...body}=packet;packet.integrity=digest(body);
  assert.throws(()=>SelectedExecutionHarness.restore(packet),/Replay|context|fields/);
});

test('state refresh cannot omit its observed immutable source reread',()=>{
  const harness=new SelectedExecutionHarness();
  harness.publishProgram({programId:'source',source:'function run(){return 1;}',entry:'run'});
  harness.admitInvocation({programId:'source',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside'});
  assert.throws(()=>harness.recordModelContext('call',[],{includeState:true}),/preceding checked source reread/);
  harness.restoreSource('worker','source');
  const receipt=harness.recordModelContext('call',[],{includeState:true});
  assert.equal(receipt.visibleThrough,receipt.sequence-1);
});
