import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeWitness, encodeWitness} from '../src/training/format.js';

const allocation=captures=>({
  name:'o1',kind:'closure',properties:[],code:'function:1',captures
});

test('capture aliases and captured cells use the source identifier grammar',()=>{
  for(const name of ['keyFn','_key','key_fn','keyFn_2','$key','key$Fn','$','éclair']){
    const capture={binding:name,cell:name};
    const {kind,fields}=decodeWitness(encodeWitness('allocate',allocation([capture])));
    assert.equal(kind,'allocate');
    assert.deepEqual(fields.captures,[capture]);
  }
});

test('malformed captured aliases and cells are rejected alike',()=>{
  for(const field of ['binding','cell']){
    for(const invalid of ['', '1key','key-fn','key fn','key.fn','o:1',null,3,['ref','o1']]){
      const capture={binding:'keyFn',cell:'outerCell', [field]:invalid};
      assert.throws(()=>encodeWitness('allocate',allocation([capture])),/captured cell relation/);
    }
  }
});

test('different capture aliases may share one cell but aliases cannot duplicate',()=>{
  const captures=[{binding:'left',cell:'sharedCell'},{binding:'right',cell:'sharedCell'}];
  assert.deepEqual(decodeWitness(encodeWitness('allocate',allocation(captures))).fields.captures,captures);
  assert.throws(()=>encodeWitness('allocate',allocation([
    {binding:'same',cell:'firstCell'},{binding:'same',cell:'secondCell'}
  ])),/captured cell relation/);
});
