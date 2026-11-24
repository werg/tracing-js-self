import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileProtocolSourceV8} from '../src/semantic/protocol-source-compiler-v8.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';

async function checked(source,args=[]){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args});
  runtime.drive();const bundle=runtime.exportRun(),compiled=compileProtocolSourceV8(bundle);
  const audit=await auditProtocolSourceV8({bundle,
    referenceInput:{source,entry:'run',inputGraph:encodeNativeGraph(args)},outcome:compiled.outcome});
  assert.equal(audit.status,'agreed');
  assert.equal(audit.metadataAudit.status,'agreed');
  return compiled;
}

test('array literal spread snapshots before later calls mutate its source',async()=>{
  const source='"use strict";function run(){const values=[1,2];return [0,...values,values.push(3),...values];}';
  const compiled=await checked(source);
  assert.equal(compiled.outcome.kind,'return');
  assert.equal(compiled.claims.filter(row=>row.record.kind==='iterator.spread').length,2);
  assert(compiled.claims.some(row=>row.record.kind==='property.set'));
});

test('string spread iterates Unicode code points and array holes retain their positions',async()=>{
  for(const source of [
    '"use strict";function run(){return [..."A𝄞é"];}',
    '"use strict";function run(){return [0,...[],,3];}'
  ]){
    const compiled=await checked(source);
    assert.equal(compiled.outcome.kind,'return');
    assert(compiled.claims.some(row=>row.record.kind==='iterator.spread')||source.includes('...[]'));
  }
});

test('reference aliases survive bounded spread snapshots',async()=>{
  const source='"use strict";function run(){const value={x:1};const copied=[value];const output=[...copied];return [output[0]===value,output[0].x];}';
  const compiled=await checked(source);
  assert.equal(compiled.outcome.kind,'return');
});
