import test from 'node:test';
import assert from 'node:assert/strict';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {compileAlgorithmWitness,verifyAlgorithmProjection,verifyAlgorithmTrainingCase,
  recheckAlgorithmEvidence,checkAlgorithmCounterfactualPrefixes} from '../src/semantic/compiler.js';
import {decodeAlgorithmRecord} from '../src/semantic/trace-codec.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const fixture=id=>structuredClone(SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id));
const lines=result=>result.exported.public.timeline.filter(row=>row.mode==='generated').map(row=>row.line);

test('algorithm teacher preserves source checks and replay while exposing computation and private-state meaning',async()=>{
  for(const [id,pattern] of [['compound-pure',/add\(multiply\(add\(\$a0, \$a1\), add\(\$a2, \$a3\)\), 1\)/],
    ['dense-loop',/fold_left\(\$a0, 0, add\)/],['object-alias',/add\(2, 1\)/],['pure-helper',/add\(\$a0, 1\)/]]){
    const result=await verifyAlgorithmTrainingCase(fixture(id));
    assert.equal(result.status,'locally_verified',result.reason);
    assert.match(lines(result)[0],pattern);assert.equal(result.exported.sidecar.nativeAdmission,null);
    assert.equal(result.exported.sidecar.sourceEvidence.sourceChecks.status,'agreed');
    assert.equal(result.exported.sidecar.optimizerSteps,0);
    assert.equal(verifyAlgorithmProjection(result.detailed.sidecar.archive,result.exported).valid,true);
    assert.equal(result.exported.contexts.length,lines(result).length);
    assert.ok(result.exported.contexts[0].program);
    if(result.exported.contexts.length>1)assert.equal(result.exported.contexts[1].program,undefined);
  }
});

test('counter compiles from committed journal interactions with observations excluded from generated roles',async()=>{
  const result=await verifyAlgorithmTrainingCase(fixture('counter-0'));
  assert.equal(result.status,'locally_verified',result.reason);
  assert.deepEqual(lines(result),['request r0 b0: demo.readAsync("counter")',
    'v1 = add(%v0, 1) => 8','request r1 b1: demo.store("counter", 8)','return 8']);
  const observed=result.exported.public.timeline.filter(row=>row.kind==='observation');
  assert.deepEqual(observed.map(row=>decodeAlgorithmRecord(row.line).value),[['num',7],['undefined']]);
  assert.ok(observed.every(row=>row.mode==='observed'));
  const changed=fixture('counter-0');changed.fixture.calls[0].result=21;
  changed.fixture.calls[1].arguments[1]=22;
  const other=await verifyAlgorithmTrainingCase(changed);
  assert.equal(other.status,'locally_verified',other.reason);
  assert.equal(checkAlgorithmCounterfactualPrefixes(result.exported,other.exported).valid,true);
  assert.deepEqual(result.exported.contexts[0],other.exported.contexts[0]);
  const rechecked=await recheckAlgorithmEvidence(result.exported,result.detailed);
  assert.equal(rechecked.valid,true);assert.equal(rechecked.admitted,false);
});

test('unproved cleanup and callback profiles keep independently checked detailed artifacts under their actual identity',async()=>{
  for(const id of ['rejection-finally','callback-captured-write']){
    const result=await verifyAlgorithmTrainingCase(fixture(id));
    assert.equal(result.status,'detailed-fallback',result.reason);
    assert.equal(result.exported,null);assert.equal(result.detailed.public.schema,'semantic-execution/6');
    assert.equal(result.detailed.sidecar.referenceStatus,'agreed');
    assert.match(result.reason,/profile|control flow|callbacks|cleanup/);
  }
});

test('regeneration rejects changed claims, role masks, regions, receipts and context before accepting evidence',async()=>{
  const result=await verifyAlgorithmTrainingCase(fixture('object-alias'));
  const bundle=result.detailed.sidecar.archive;
  const variants=[
    value=>{value.public.timeline.find(row=>row.mode==='generated').line='v0 = add(2, 1) => 4';},
    value=>{value.public.timeline.find(row=>row.mode==='generated').mode='observed';},
    value=>{value.sidecar.receipt.sourceDigest='0'.repeat(64);},
    value=>{value.sidecar.provenance.sourceDigest='1'.repeat(64);},
    value=>{value.contexts[0].state.values.push(['future',['num',99]]);},
    value=>{value.sidecar.receipt.preconditions.push('invented applicability guard');}
  ];
  for(const mutate of variants){
    const changed=structuredClone(result.exported);mutate(changed);
    changed.sidecar.publicDigest=hashAlgorithmData(changed.public);
    assert.throws(()=>verifyAlgorithmProjection(bundle,changed));
  }
  const corrupted=structuredClone(bundle);corrupted.events[0].operation='invented';
  assert.throws(()=>compileAlgorithmWitness(corrupted));
});
