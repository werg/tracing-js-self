import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeRecord,fragmentLine,restoreLines} from '../src/training/format.js';

test('fragment restoration preserves Unicode, lone surrogates, and exact canonical records',()=>{
  for(const value of ['x'.repeat(800),'😀'.repeat(250),'\\ud800'.repeat(400),'a\\u0000b'.repeat(250)]){
    const record=encodeRecord('value',{id:'v1',result:['str',value]});
    const fragments=fragmentLine(record,{maxBytes:96});
    assert(fragments.length>2);
    assert(fragments.every(line=>Buffer.byteLength(line,'utf8')<=96));
    assert.deepEqual(restoreLines(fragments),[record]);
  }
});

test('fragment restoration rejects orphan, missing, empty and reordered parts',()=>{
  const part=encodeRecord('value-part',{id:'v1',data:'abc'});
  const close=encodeRecord('value-close',{id:'v1'});
  const open=encodeRecord('value-open',{id:'v1',type:'semantic-record'});
  assert.throws(()=>restoreLines([part]),/Orphaned/);
  assert.throws(()=>restoreLines([close]),/Orphaned/);
  assert.throws(()=>restoreLines([open,part]),/Unclosed/);
  assert.throws(()=>restoreLines([open,encodeRecord('value-part',{id:'v1',data:''}),close]),/Invalid partial/);
  assert.throws(()=>restoreLines([open,encodeRecord('value-part',{id:'other',data:'x'}),close]),/Interleaved/);
  assert.throws(()=>restoreLines([open,close]),/empty fragmented/i);
  const source=encodeRecord('value',{id:'actual',result:['str','hello']});
  const forged=[open,encodeRecord('value-part',{id:'v1',data:source}),close];
  assert.throws(()=>restoreLines(forged),/identity/);
  const wrongType=encodeRecord('value-open',{id:'actual',type:'not-a-record'});
  assert.throws(()=>restoreLines([wrongType,encodeRecord('value-part',{id:'actual',data:source}),encodeRecord('value-close',{id:'actual'})]),/type mismatch/);
});
