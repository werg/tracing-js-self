import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {SemanticController} from '../src/training/controller.js';
import {decodeRecord,encodeRecord,restoreLines} from '../src/training/format.js';

const src='"use strict";\nfunction f(){return [Math.random(),Math.random()];}';
function verified(seed){
  const outcome=verifyTrainingCase({source:src,entry:'f',seed,maxGenerated:1024});
  assert.equal(outcome.status,'locally_verified',JSON.stringify(outcome));
  const exported=JSON.parse(JSON.stringify(outcome.exported));
  assert.equal(validateTrainingExport(exported).valid,true);
  assert.equal(validateBundle(exported.sidecar.archive).valid,true);
  assert.equal(replayExact(exported.sidecar.archive).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(exported).valid,true);
  return exported;
}

test('two seeded random calls are reproducible with independent V8 receipts',()=>{
  const a=verified(42),b=verified(42),c=verified(43);
  assert.deepEqual(a.public,b.public);
  assert.notDeepEqual(a.public,c.public);
  assert.equal(a.sidecar.archive.initialState.control.a0.randomSeed,42);
  const [code]=restoreLines(a.public.groups.filter(g=>g.mode==='observed')
    .flatMap(g=>g.events.map(x=>x.record))).map(decodeRecord);
  assert.equal(code.fields.randomSeed,42);
  assert.equal(c.sidecar.archive.initialState.control.a0.randomSeed,43);
});

test('serving controller refuses fabricated seeded Math.random value atomically',()=>{
  const data=verified(42);
  const observed=data.public.groups.filter(g=>g.mode==='observed')
    .flatMap(g=>g.events.map(e=>e.record));
  const controller=new SemanticController(observed,{maxGenerated:1024});
  const sites=new Map(decodeRecord(restoreLines(observed)[0]).fields.sites
    .map(x=>[x.id,x]));
  let found=false;
  for(const group of data.public.groups.filter(g=>g.mode==='generated')){
    const event=group.events[0];
    let record=event.record;
    // This small fixture has no generated fragments.
    const {kind,fields}=decodeRecord(record);
    const site=sites.get(fields.site);
    if(!found&&kind==='value'&&site &&
       src.slice(site.start,site.end)==='Math.random()'){
      found=true;
      const invalid=encodeRecord(kind,{...fields,result:['num',0.999]});
      const previous=controller.randomState;
      assert.throws(()=>controller.commitGenerated(invalid,{track:event.track}),
        /Random call|random value/i);
      assert.equal(controller.randomState,previous,'bad prediction must not consume randomness');
    }
    controller.commitGenerated(record,{track:event.track});
  }
  assert.equal(found,true);
});

test('unseeded randomness and malformed seeded calls are refused',()=>{
  assert.notEqual(verifyTrainingCase({source:src,entry:'f'}).status,'locally_verified');
  for(const seed of [-1,1.5,4294967296,'42'])
    assert.equal(verifyTrainingCase({source:src,entry:'f',seed}).status,'unsupported');
  for(const form of ['const random=Math.random;return random();',
    'return Math["random"]();']){
    assert.equal(verifyTrainingCase({source:'"use strict";function f(){'+form+'}',
      entry:'f',seed:42}).status,'unsupported');
  }
  const wrong=verifyTrainingCase({source:'"use strict";function f(){return Math.random(1);}',
    entry:'f',seed:42});
  assert.notEqual(wrong.status,'locally_verified');
});
