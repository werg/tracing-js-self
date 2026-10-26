import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWitness,decodeWitness} from '../src/training/format.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';
import {createHash} from 'node:crypto';

test('canonical witness seed is exact, bounded, and cannot alias another seed',()=>{
  const fields={entry:'run',source:'function run(){return Math.random();}',sites:[]};
  const zero=encodeWitness('code',{...fields,randomSeed:0});
  const one=encodeWitness('code',{...fields,randomSeed:1});
  assert.notEqual(zero,one);
  assert.equal(decodeWitness(zero).fields.randomSeed,0);
  assert.equal(decodeWitness(one).fields.randomSeed,1);
  assert.throws(()=>encodeWitness('code',{...fields,randomSeed:4294967296}),/seed/);
});

test('source projection publishes the seed and checks every owned random transition',()=>{
  const source='"use strict"; function sample(){return Math.random();} '+
    'function run(){Math.random();const a=sample();return a+Math.random();}';
  const episodes=[0,1].map(seed=>{
    const result=verifyOwnedSourceCase({source,entry:'run',seed});
    assert.equal(result.status,'locally_verified',result.reason);
    assert.equal(recheckOwnedSourceEvidence(result.exported).valid,true);
    assert.equal(result.exported.public.timeline[0].randomSeed,seed);
    const samples=result.exported.public.timeline.filter(row=>row.kind==='semantic')
      .map(row=>decodeWitness(row.line)).filter(row=>row.kind==='compute'&&row.fields.expr.op==='random');
    let state=seed;
    assert.equal(samples.length,3,'even the unused first sample must advance the public stream');
    for(const sample of samples){
      state=(Math.imul(state,1664525)+1013904223)>>>0;
      assert.deepEqual(sample.fields.result,['num',state/4294967296]);
    }
    const replay=SelectedExecutionHarness.replay(result.exported);
    assert.equal(replay.invocations.get('invocation1').controller.firstWitnessViolation,null);
    return result.exported;
  });
  const beforeSelection=episode=>episode.public.timeline.slice(0,
    episode.public.timeline.findIndex(row=>row.kind==='semantic'));
  assert.notDeepEqual(beforeSelection(episodes[0]),beforeSelection(episodes[1]),
    'different seeded computations must not have the same model-visible prefix');
  const tampered=structuredClone(episodes[0]);
  const record=tampered.public.timeline.find(row=>row.kind==='semantic');
  const {kind,fields}=decodeWitness(record.line);
  record.line=encodeWitness(kind,{...fields,result:['num',0]});
  assert.equal(recheckOwnedSourceEvidence(tampered).valid,false);
  const selected=SelectedExecutionHarness.replay(tampered).invocations.get('invocation1').controller;
  assert(selected.firstWitnessViolation,'public replay diagnoses the original wrong random claim');
  assert.deepEqual(selected.history.map(row=>decodeWitness(row.record))
    .find(row=>row.kind==='compute').fields.result,
    ['num',0],'the checker must not repair model-selected bytes');
});

test('seeded retained invocations and checkpoint restoration keep one realm stream',()=>{
  let h=new SelectedExecutionHarness({sessionId:'seeded'});
  h.publishProgram({programId:'program',source:'function run(){return Math.random();} '+
    'function helper(){return Math.random();}',entry:'run',randomSeed:0});
  let state=0;
  for(const [index,entry] of ['run','helper','run'].entries()){
    const invocationId='i'+index;
    h.admitInvocation({programId:'program',invocationId,trackId:'worker',realmId:'realm',
      triggerId:'trigger'+index,realmPolicy:'retained',entry});
    assert.equal(h.invocations.get(invocationId).controller.source.randomSeed,0);
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    const value=['num',state/4294967296];
    h.selected(invocationId,encodeWitness('compute',{expr:{op:'random'},result:value}));
    h.selected(invocationId,encodeWitness('return',{value}));
    h.selected(invocationId,encodeWitness('end',{kind:'return'}));
    assert.equal(h.invocations.get(invocationId).controller.firstWitnessViolation,null);
    const checkpoint=h.checkpoint();
    h=SelectedExecutionHarness.restore(checkpoint);
    const forged=structuredClone(checkpoint);
    forged.realms[0][1].randomState++;
    const {integrity,...body}=forged;
    forged.integrity=createHash('sha256').update(JSON.stringify(body)).digest('hex');
    assert.throws(()=>SelectedExecutionHarness.restore(forged),/randomState/);
  }
  assert.equal(SelectedExecutionHarness.replay(h.exportEpisode()).realms.get('realm').randomState,state);
});

test('random transitions cannot hide inside a pure expression or lack their seed',()=>{
  assert.throws(()=>encodeWitness('compute',{expr:{op:'binary',operator:'+',
    left:{op:'random'},right:{op:'random'}},result:['num',0]}),/standalone/);
  const result=verifyOwnedSourceCase({source:'"use strict"; function run(){return Math.random();}',entry:'run'});
  assert.notEqual(result.status,'locally_verified');
  const h=new SelectedExecutionHarness();
  assert.throws(()=>h.publishProgram({programId:'bad',source:'function run(){}',entry:'run',
    randomSeed:4294967296}),/seed/);
});

test('the selected model driver forwards and preserves the observed program seed',async()=>{
  const source='"use strict"; function run(){return Math.random();}';
  const result=verifyOwnedSourceCase({source,entry:'run',seed:0});
  assert.equal(result.status,'locally_verified',result.reason);
  const lines=result.exported.public.timeline.filter(row=>row.kind==='semantic').map(row=>row.line);
  const driver=new SelectedModelDriver({select:async prefix=>{
    assert.equal(prefix.committed.find(row=>row.kind==='program').randomSeed,0);
    return lines.shift();
  }});
  try{
    const call={programId:'program',source,entry:'run',randomSeed:0,invocationId:'invocation1',
      trackId:'worker',realmId:'realm',triggerId:'trigger'};
    const outcome=await driver.run(call);
    assert.deepEqual(outcome.completion.value,['num',1013904223/4294967296]);
    assert.equal(driver.harness.invocations.get('invocation1').controller.firstWitnessViolation,null);
    await assert.rejects(driver.run({...call,randomSeed:1,invocationId:'another',triggerId:'another'}),
      /immutable.*seed/);
  }finally{driver.close();}
});
