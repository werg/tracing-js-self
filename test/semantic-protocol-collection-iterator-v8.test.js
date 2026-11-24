import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

async function checked(source){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[]});
  runtime.drive();const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  const audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph([])},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
  assert.equal(audit.metadataAudit.status,'agreed');
  return compiled;
}

test('Set iterator observes live delete, re-add, completion and stable done state under Node 24',async()=>{
  const source='"use strict";function run(){const values=new Set([1,2]);const it=values.values();'+
    'const first=it.next().value;values.delete(2);values.add(3);const second=it.next().value;'+
    'const end=it.next().done;values.add(4);return [first,second,end,it.next().done];}';
  const compiled=await checked(source);
  assert.equal(compiled.outcome.kind,'return');
  for(const name of ['set.create','set.delete','set.add','iterator.lookup','iterator.create','iterator.next'])
    assert(compiled.claims.some(row=>row.record.kind===name),name);
});

test('Map entries read overwritten values and appended entries with fresh pairs under Node 24',async()=>{
  const source='"use strict";function run(){const values=new Map([[1,"old"]]);const it=values.entries();'+
    'values.set(1,"updated");values.set(2,"second");const first=it.next().value;const second=it.next().value;'+
    'return [first,second,values.size];}';
  const compiled=await checked(source);
  assert.equal(compiled.outcome.kind,'return');
  for(const name of ['map.create','map.set','map.size','iterator.lookup','iterator.create','iterator.next'])
    assert(compiled.claims.some(row=>row.record.kind===name),name);
});
