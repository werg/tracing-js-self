import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {decodeRecord,restoreLines} from '../src/training/format.js';

const source=body=>'"use strict";\n'+body;
function verified(body,args=[]){
  const result=verifyTrainingCase({source:source(body),entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const exported=result.exported;
  assert.equal(validateTrainingExport(exported).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(exported).valid,true);
  assert.equal(validateBundle(exported.sidecar.archive).valid,true);
  assert.equal(replayExact(exported.sidecar.archive).valid,true);
  return exported;
}

test('counted for loop clones every lexical header binding into each iteration',()=>{
  const output=verified(`function f(){
    const captured=[];
    for(let i=0, upper=3; i<upper; i++) captured[i]=()=>[i,upper];
    return [captured[0](),captured[1](),captured[2]()];
  }`);
  const carries=output.sidecar.semantic.events.filter(e=>e.op==='carry'&&e.copies);
  assert(carries.length>=3);
  for(const event of carries){
    assert.deepEqual(event.copies.map(c=>c.from.key),['i','upper']);
    assert(event.copies.every(c=>c.from.version===c.to.version));
    assert(new Set(event.copies.map(c=>c.to.env)).size===1);
  }
  const publicCarries=restoreLines(output.public.groups.flatMap(g=>g.events.map(e=>e.record)))
    .map(decodeRecord).filter(r=>r.kind==='carry'&&r.fields.copies);
  assert.equal(publicCarries.length,carries.length);
});

test('multiple var for-header bindings stay in the function environment',()=>{
  verified(`function f(n){var total=0;for(var i=0,cap=n+1;i<cap;i++){total+=i;}return [i,cap,total];}`, [5]);
});

test('duplicate multi-binding let declarations and unsupported headers fail closed',()=>{
  for(const code of [
    'function f(){for(let i=0,i=1;i<2;i++){}return 1;}',
    'function f(){for(let i=0,j;i<2;i++){}return 1;}',
    'function f(){for(const i=0,j=1;i<2;i++){}return 1;}'
  ])assert.equal(verifyTrainingCase({source:source(code),entry:'f'}).status,'unsupported');
});
