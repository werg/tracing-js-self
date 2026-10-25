import test from 'node:test';
import assert from 'node:assert/strict';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission,checkCounterfactualPrefixes,
  effectfulFamilySplit,requireNativeAdmission} from '../src/training/effectful-admit.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {decodeWitness} from '../src/training/format.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';

const results=new Map();
test.before(async()=>{
  for(const fixture of EFFECTFUL_ENGINEERING_FIXTURES){
    const result=await verifyEffectfulTrainingCase(fixture);
    assert.equal(result.status,'locally_verified',fixture.id+': '+result.reason);
    results.set(fixture.id,result.exported);
  }
});
test('effectful teachers pass independent source, effects, selected replay and computation checks',()=>{
  assert.equal(results.size,EFFECTFUL_ENGINEERING_FIXTURES.length);
  for(const episode of results.values()){
    assert.equal(episode.sidecar.referenceStatus,'agreed');
    assert.equal(episode.sidecar.reference.sourceChecks.status,'agreed');
    assert.equal(episode.sidecar.replay.nativeReplayDispatches,0);
    assert.equal(episode.sidecar.optimizerSteps,0);
    const replay=SelectedExecutionHarness.replay(episode);
    assert([...replay.invocations.values()].every(item=>item.status==='completed'));
    assert([...replay.intents.values()].every(item=>item.status==='settled'));
    assert(!Object.keys(episode.public).includes('archive'));
  }
});
test('all source-checked cases execute through the actual selected serving driver with exact independent outcomes',async()=>{
  for(const [id,episode] of results){
    const fixture=controlledEvaluationCase(episode,{id});
    assert.equal(Object.hasOwn(fixture.request,'expected'),false);
    const evaluated=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',
      caseId:id,request:fixture.request,seed:17,representation:episode.sidecar.representation},{timeoutMs:5000});
    assert.equal(evaluated.failure,null,id+': '+JSON.stringify(evaluated.failure));
    assert.deepEqual(evaluated.outcome,fixture.expected,id);
    assert.equal(evaluated.origin,'controlled');
    assert.equal(evaluated.firstSemanticInconsistency,null,id);
    assert(Object.values(evaluated.hardGates).every(count=>count===0),id);
    assert.equal(evaluated.costs.leakedResources,0,id);
  }
});
test('Promise reactions, rejection cleanup and microtasks execute their source closures',()=>{
  for(const id of ['promise-reaction','promise-rejection-finally','owned-microtask']){
    const episode=results.get(id),lines=episode.public.timeline.filter(item=>item.kind==='semantic')
      .map(item=>decodeWitness(item.line));
    assert(lines.some(item=>item.kind==='job'&&item.fields.action==='dispatch'));
    assert(lines.some(item=>item.kind==='job'&&item.fields.action==='complete'));
    assert(episode.sidecar.effects.some(item=>item.kind==='dispatch'));
  }
  const reaction=results.get('promise-reaction');
  assert.equal(reaction.sidecar.reference.outcome.graph.roots[0][1],4);
  assert.equal(results.get('promise-rejection-finally').sidecar.reference.outcome.graph.roots[0][1],9);
});
test('two asynchronous requests dispatch before reversed settlement without changing source continuation',()=>{
  const timeline=results.get('two-pending-reversed').public.timeline;
  const dispatch=timeline.filter(item=>item.kind==='dispatch'),observations=timeline.filter(item=>item.kind==='result');
  assert(dispatch[1].sequence<observations[0].sequence);
  assert.equal(observations[0].effectId,dispatch[1].effectId);
  assert.equal(observations[1].effectId,dispatch[0].effectId);
  const resumed=timeline.filter(item=>item.kind==='semantic'&&decodeWitness(item.line).kind==='resume');
  assert.equal(decodeWitness(resumed[0].line).fields.result[1],2);
  assert.equal(decodeWitness(resumed[1].line).fields.result[1],5);
});
test('queued callbacks preserve captured cells and callback-caused effects after registration settlement',()=>{
  const episode=results.get('callback-captured-write');
  assert.equal(episode.public.timeline.filter(item=>item.kind==='event').length,2);
  assert.equal(episode.public.timeline.filter(item=>item.kind==='invocation').length,3);
  const calls=episode.sidecar.effects.filter(item=>item.kind==='dispatch');
  assert.deepEqual(calls.map(item=>item.operation),['demo.withCallback','demo.store','demo.store','demo.store']);
  assert.equal(episode.sidecar.reference.outcome.graph.roots[0][1],7);
});
test('future fixture values cannot alter earlier code, invocation or request prefixes',()=>{
  for(const names of [['counter-0','counter-1'],['branch-0','branch-1']]){
    const left=results.get(names[0]),right=results.get(names[1]);
    const receipt=checkCounterfactualPrefixes(left,right);
    assert(receipt.identicalRecords>3);
    assert.equal(left.sidecar.split,right.sidecar.split);
  }
  assert.equal(effectfulFamilySplit('same-source'),effectfulFamilySplit('same-source'));
});
test('serialized admission independently rechecks journals and rejects forged source/reference evidence',async()=>{
  const valid=structuredClone(results.get('counter-0'));
  const checked=await recheckEffectfulAdmission(valid,{requireAdmitted:false});
  assert(checked.journalValidated&&checked.replayValidated&&checked.sourceValidated&&checked.effectsValidated);
  const changed=structuredClone(valid);
  changed.sidecar.referenceInput.fixture.calls[0].result=8;
  await assert.rejects(recheckEffectfulAdmission(changed,{requireAdmitted:false}),/inputs differ/);
  const forged=structuredClone(valid);
  forged.public.timeline.find(item=>item.kind==='result').result=['num',900];
  await assert.rejects(recheckEffectfulAdmission(forged,{requireAdmitted:false}),/bytes changed|evidence/);
  assert.throws(()=>requireNativeAdmission(valid,{schema:'semantic-native-admission/3',admitted:true}),/incompatible/);
  await assert.rejects(recheckEffectfulAdmission(valid),/Missing complete/,
    'local source checks cannot silently become production admission');
});
test('request mismatch never receives the answer intended for another effect',async()=>{
  const fixture=structuredClone(EFFECTFUL_ENGINEERING_FIXTURES[0]);
  fixture.fixture.calls[0].arguments=['a different key'];
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.notEqual(result.status,'locally_verified');assert.notEqual(result.status,'admitted');
});
test('source-certified repeated ingress publishes one immutable program and keeps complete family lineage',async()=>{
  const session=await verifyEffectfulSession({cases:EFFECTFUL_ENGINEERING_FIXTURES.slice(0,2),family:'async-counter'});
  assert.equal(session.status,'locally_verified',session.reason);
  const timeline=session.exported.public.timeline;
  assert.equal(timeline.filter(item=>item.kind==='program').length,1);
  assert.equal(timeline.filter(item=>item.kind==='invocation').length,2);
  assert(timeline.filter(item=>item.kind==='invocation').every(item=>item.realmPolicy==='fresh'));
  const receipt=await recheckEffectfulSession(session.exported,{requireAdmitted:false});
  assert(receipt.sourceValidated&&receipt.effectsValidated&&receipt.replayValidated);
  const fixture=controlledEvaluationCase(session.exported,{id:'repeated-ingress'});
  const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:fixture.id,
    request:fixture.request,seed:29,representation:session.exported.sidecar.representation});
  assert.deepEqual(actual.outcome,fixture.expected);
  const changed=structuredClone(session.exported);changed.sidecar.split='forged';
  await assert.rejects(recheckEffectfulSession(changed,{requireAdmitted:false}),/changed/);
});
