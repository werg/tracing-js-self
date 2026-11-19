import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase,independentEffectfulReference} from '../src/training/effectful-admit.js';
import {executeWithNativeServices} from '../src/host/native-driver.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {ownedEffectfulOutcome} from '../src/training/effectful-compiler.js';
import {referenceOutcome,ownedOutcome} from '../src/training/reference.js';
import {auditReferenceOperations} from '../src/training/operation-reference.js';
import {auditReferenceBranches} from '../src/training/branch-reference.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
const source=body=>'"use strict";function run(){'+body+'}';
function verify(body){
  const r=verifyOwnedSourceCase({source:source(body),entry:'run',maxGenerated:4096});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
  return r;
}
test('sparse literals preserve absent slots and spread insertion positions',()=>{
  for(const body of [
    'const a=[,2,,];return [a.length,Object.hasOwn(a,0),Object.hasOwn(a,1),Object.hasOwn(a,2),a[0]];',
    'const a=[,...[2,3],,4,];return [a.length,Object.keys(a),a[0],a[3]];',
    'const a=[,,,];return [a.length,Object.keys(a)];',
    'return [,undefined,];'
  ])verify(body);
});
function runtimeVerified(body){
  const text=source(body),r=createRuntime().startEntry({text,functionName:'run'});
  assert.equal(r.drive().kind,'terminated');
  const bundle=r.exportRun();
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  const opts={source:text,entry:'run',args:bundle.entrySpec.arguments,initialHeap:bundle.initialState.heap,bundle};
  const reference=referenceOutcome(opts);
  assert.deepEqual(ownedOutcome(r),reference);
  assert.equal(auditReferenceOperations({...opts,reference}).status,'agreed');
  assert.equal(auditReferenceBranches({...opts,reference}).status,'agreed');
  return r;
}
test('strict frontend exposes bounded owned Proxy access with original receiver',()=>{
  runtimeVerified('const target={x:3};const p=new Proxy(target,{get:function(t,k,r){return t[k]+1;}});return p.x;');
  runtimeVerified('let seen=0;const t={x:2};const p=new Proxy(t,{set:function(o,k,v,r){seen++;o[k]=v+1;return true;}});p.x=7;return [t.x,seen];');
});
test('strict Promise construction executes and rechecks executor ordering and rejection',async()=>{
  for(const body of [
    'let order="";const p=new Promise(function(resolve,reject){order+="a";resolve(7);reject(8);order+="b";});order+="c";const x=await p;return [order,x];',
    'try{return await new Promise(function(resolve){throw 9;});}catch(e){return e+1;}',
    'return await new Promise(function(resolve){resolve(4);throw 9;});'
  ]){
    const text='"use strict";async function run(){'+body+'}';
    const run=await executeWithNativeServices({entry:{text,functionName:'run',args:[]},services:{}});
    assert.equal(validateBundle(run.bundle).valid,true);
    assert.equal(replayExact(run.bundle).valid,true);
    for(const mode of ['original','operations','branches','completions']){
      const reference=await independentEffectfulReference({source:text,entry:'run',inputGraph:encodeNativeGraph([]),fixture:{calls:[]},mode});
      assert.deepEqual(ownedEffectfulOutcome(run.bundle),reference.outcome);
      assert.deepEqual(reference.effects,[]);
    }
    const candidate=await verifyEffectfulTrainingCase({source:text,entry:'run',family:'strict-promise-executor',fixture:{calls:[]}});
    assert.equal(candidate.status,'projection_refused');
    assert.match(candidate.reason,/Promise.executor/);
  }
});
test('strict typed views share owned backing bytes and preserve offsets',()=>{
  const body='const b=new SharedArrayBuffer(8);const bytes=new Uint8Array(b,2,4);'+
    'const view=new DataView(b,2,4);bytes[0]=7;view.setUint16(1,258);'+
    'return [bytes[0],bytes[1],bytes[2],view.byteOffset,view.byteLength];';
  const r=runtimeVerified(body);
  assert.deepEqual(r.state.heap[r.result[1]].properties['0'].value,['num',7]);
  // Full source projection of shared-buffer graphs is separately qualified;
  // the runtime exposure does not claim native-training admission.
});
