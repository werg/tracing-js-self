import test from 'node:test';
import assert from 'node:assert/strict';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulSession,recheckEffectfulSession} from '../src/training/effectful-session.js';
import {controlledEvaluationCase,evaluateSelectedCase} from '../src/training/selected-evaluation.js';

const fixture=id=>structuredClone(EFFECTFUL_ENGINEERING_FIXTURES.find(item=>item.id===id));
const semanticLines=timeline=>timeline.filter(item=>item.kind==='semantic').map(item=>item.line);

for(const callbackId of ['callback-captured-write','persistent-external-trigger'])
  test('source session preserves retained '+callbackId+' ownership and executes its exact certified bytes',async()=>{
    const collected=await verifyEffectfulSession({cases:[fixture('counter-0'),fixture(callbackId)],
      family:'session-'+callbackId});
    assert.equal(collected.status,'locally_verified',collected.reason);
    const exported=collected.exported,timeline=exported.public.timeline;
    const roots=timeline.filter(item=>item.kind==='invocation'&&item.parentInvocationId===null);
    const callbacks=timeline.filter(item=>item.kind==='invocation'&&item.activation==='callback');
    assert.equal(roots.length,2);assert.equal(callbacks.length,2);
    assert.notEqual(roots[0].realmId,roots[1].realmId);
    assert(callbacks.every(item=>item.parentInvocationId===roots[1].invocationId&&
      item.realmId===roots[1].realmId&&item.programId===roots[1].programId&&item.realmPolicy==='retained'));
    assert.deepEqual(semanticLines(timeline),exported.sidecar.collection.components.flatMap(component=>
      semanticLines(component.public.timeline)),'composition may resequence envelopes but cannot relabel selected bytes');
    const receipt=await recheckEffectfulSession(exported,{requireAdmitted:false});
    assert(receipt.sourceValidated&&receipt.effectsValidated&&receipt.replayValidated);
    if(callbackId==='persistent-external-trigger'){
      const calls=exported.sidecar.referenceInput.fixture.calls;
      assert.deepEqual(calls[3].callbacks.map(item=>item.call),[2,2]);
      assert.equal(exported.sidecar.effects.find(item=>item.kind==='subscription-close').subscriptionCall,2);
    }
    const evaluation=controlledEvaluationCase(exported,{id:'session-'+callbackId});
    assert.equal(evaluation.request.invocations.length,2,'callback activations are driven by ingress, not root proposals');
    const actual=await evaluateSelectedCase({schema:'semantic-evaluation-request/4',caseId:evaluation.id,
      request:evaluation.request,seed:17,representation:'explicit'});
    assert.equal(actual.failure,null,JSON.stringify(actual.failure));
    assert.deepEqual(actual.outcome,evaluation.expected);
    assert.deepEqual(actual.outcome.cleanup,{pendingEffects:0,pendingJobs:0,openHandlers:0});
  });

test('independent components with colliding certified callback identities are refused without relabeling',async()=>{
  await assert.rejects(verifyEffectfulSession({cases:[fixture('callback-captured-write'),fixture('callback-captured-write')],
    family:'colliding-independent-callbacks'}),/Certified (subscription|invocation or ingress) identity collision/);
});

test('session source recheck rejects a callback moved under another independently collected owner',async()=>{
  const collected=await verifyEffectfulSession({cases:[fixture('counter-0'),fixture('callback-captured-write')],
    family:'session-callback-ownership'});
  assert.equal(collected.status,'locally_verified',collected.reason);
  const forged=structuredClone(collected.exported);
  const callback=forged.sidecar.collection.components[1].public.timeline.find(item=>
    item.kind==='invocation'&&item.activation==='callback');
  callback.parentInvocationId='ingress1';
  await assert.rejects(recheckEffectfulSession(forged,{requireAdmitted:false}),/changed|owner|evidence|provenance/);
});
