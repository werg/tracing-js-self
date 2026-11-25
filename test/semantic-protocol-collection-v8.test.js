import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

function build(body){
  const source='"use strict";function run(){'+body+'}';
  const runtime=createRuntime({maxSteps:10000}).startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();
  const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  return {source,bundle,compiled};
}
async function checked(body){
  const {source,bundle,compiled}=build(body);
  const audit=await auditProtocolSourceV8({bundle,referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},
    outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
  assert.equal(audit.metadataAudit.status,'agreed');
  return {compiled,audit};
}

test('Set construction, SameValueZero membership, insertion and receiver identity agree with Node 24',async()=>{
  const {compiled}=await checked('const values=new Set([NaN,-0,0,NaN,2]);const added=values.add(3)===values;'+
    'return [values.has(NaN),values.has(+0),values.has(2),values.has(9),added,values.has(3)];');
  assert.equal(compiled.outcome.kind,'return');
  assert.equal(compiled.outcome.graph.objects.length,1);
  const records=compiled.claims.map(row=>row.record);
  for(const kind of ['set.create','set.lookup','set.has','set.add'])assert(records.some(row=>row.kind===kind),kind);
  assert.equal(records.filter(row=>row.kind==='set.has').length,5);
  assert.equal(records.filter(row=>row.kind==='set.add').length,1);
});

test('Set creation from nullish values and empty arrays is retained as an empty Set',async()=>{
  const {compiled}=await checked('const empty=new Set(null);const other=new Set([]);'+
    'return [empty.has(1),other.has(1)];');
  const records=compiled.claims.map(row=>row.record);
  assert.equal(records.filter(row=>row.kind==='set.create').length,2);
  assert.equal(compiled.outcome.kind,'return');
});

test('owned Set constructor fails closed on sparse iterable storage',()=>{
  const source='"use strict";function run(){const values=new Set([,1]);return values.has(1);}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});
  assert.throws(()=>runtime.drive(),/Sparse set constructor iterable/);
});

test('Set size, delete, clear and reinsertion retain live order under native comparison',async()=>{
  const {compiled}=await checked('const values=new Set([1,2,1]);const first=values.delete(1);'+
    'const middle=values.size;values.add(1);const third=values.size;values.clear();'+
    'return [first,middle,third,values.size,values.has(1)];');
  const records=compiled.claims.map(row=>row.record);
  for(const kind of ['set.size','set.delete','set.clear'])assert(records.some(row=>row.kind===kind),kind);
  assert.equal(records.filter(row=>row.kind==='set.add').length,1);
});

test('Map constructor and Map mutations preserve SameValueZero and insertion order',async()=>{
  const {compiled}=await checked('const values=new Map([[1,"first"],[2,"two"],[1,"updated"]]);'+
    'const before=values.get(1);const size=values.size;const same=values.set(1,"last")===values;'+
    'const present=values.has(2);const deleted=values.delete(2);const missing=values.get(2);'+
    'values.clear();return [before,size,same,present,deleted,missing,values.size];');
  const records=compiled.claims.map(row=>row.record);
  for(const kind of ['map.create','map.get','map.size','map.set','map.has','map.delete','map.clear'])
    assert(records.some(row=>row.kind===kind),kind);
});
