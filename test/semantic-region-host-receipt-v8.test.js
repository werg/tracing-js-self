import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HOST_PROTOCOL_FIXTURES_V8} from '../fixtures/semantic-regions/host-protocol.js';
import {createFixtureBroker} from '../src/training/fixture-broker.js';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {compileEffectfulRegionWitnessV8,createEffectfulRegionAdapterV8} from '../src/semantic/effectful-teacher-v8.js';
import {createPromiseJoinTeacherV8} from '../src/semantic/protocol-promise-join-source-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

let compiled;
async function artifact(){
  if(!compiled)compiled=(async()=>{
    const fixture=HOST_PROTOCOL_FIXTURES_V8.find(item=>item.id==='join-retained-callback'),
      broker=createFixtureBroker(fixture.fixture);
    try{
      const {bundle}=await executeWithNativeServices({entry:{text:fixture.source,
        functionName:fixture.entry,args:fixture.args},services:broker.services});
      broker.finish();
      return compileEffectfulRegionWitnessV8(bundle,{allowHost:true,realmPolicy:'retained',
        sessionId:'host-receipt-test',extensions:[createPromiseJoinTeacherV8()]}).exported;
    }finally{broker.abort();}
  })();
  return compiled;
}

test('host delivery certificates identify the result before automatic callback retirement',async()=>{
  const data=await artifact(),rows=data.public.timeline,
    close=rows.findIndex(row=>row.kind==='handler-close');
  assert.ok(close>0);
  assert.equal(rows[close-1].kind,'result');
  for(const certificate of data.sidecar.compiler.certificates.filter(item=>item.rule==='observed-delivery/4')){
    const receipt=rows[certificate.sequence-1];
    assert.equal(receipt.kind,'result');
    assert.equal(certificate.digest,createHash('sha256').update(receipt.fields.line).digest('hex'));
  }
  assert.ok(data.sidecar.compiler.certificates.some(item=>
    item.rule==='observed-delivery/4'&&item.sequence===rows[close-1].sequence));
  assert.equal(RegionExecutionHarness.replay(data).controller.completion.value[1],7);
});

test('reconciliation and duplicate host receipts retain their original public identity',async()=>{
  const data=await artifact(),rows=data.public.timeline,
    close=rows.findIndex(row=>row.kind==='handler-close'),cut=close-1,
    original=rows[cut].fields,
    before=RegionExecutionHarness.replay({...data.public,timeline:rows.slice(0,cut)},{requireTerminal:false}),
    adapter=createEffectfulRegionAdapterV8({allowHost:true,extensions:[createPromiseJoinTeacherV8()]}),
    restored=adapter.restore(JSON.parse(JSON.stringify(before.checkpoint())));
  const receipt=restored.reconcile(original.invocationId,original.effectId,
    {disposition:original.status,evidenceId:'independent-host-result',result:original.result});
  assert.equal(receipt.kind,'reconcile');
  assert.equal(receipt.sequence,cut+1);
  assert.deepEqual(restored.timeline.slice(-3).map(row=>row.kind),['reconcile','result','handler-close']);
  assert.deepEqual(receipt,restored.timeline.at(-3));
  const result=restored.timeline.at(-2),closed=restored.timeline.at(-1),
    activation=restored.invocations.get(original.invocationId),
    count=restored.timeline.length;
  assert.deepEqual(restored.deliverResult(original.invocationId,original.effectId,
    {status:original.status,result:original.result}),result);
  assert.equal(restored.timeline.length,count);
  const evicted=restored.evictSource(activation.trackId,activation.programId),
    read=restored.restoreSource(activation.trackId,activation.programId);
  assert.deepEqual(evicted,restored.timeline.at(-2));
  assert.deepEqual(read,restored.timeline.at(-1));
  assert.deepEqual(restored.closeEventHandler(closed.subscriptionId),closed);
  assert.equal(restored.timeline.length,count+2);
});
