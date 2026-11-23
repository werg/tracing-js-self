import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {ownedEffectfulOutcome} from '../src/training/effectful-compiler.js';
import {auditProtocolSourceV8,independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';

test('independent Promise observations preserve identity, calls, cleanup order and returned settlement',async()=>{
  for(const source of [
    '"use strict";async function run(){const p=Promise.resolve(3);const q=p;return [await q,p===q];}',
    '"use strict";async function run(){let cleaned=0;try{await Promise.all([Promise.resolve(1),Promise.reject(2)]);}catch(error){return [error,cleaned];}finally{cleaned++;}}',
    '"use strict";async function run(){const n=await Promise.resolve(2).then(x=>x+3);return n*2;}'
  ]){
    const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});runtime.drive();
    const bundle=runtime.exportRun(),referenceInput={source,entry:'run',inputGraph:encodeNativeGraph([]),awaitReturnedPromise:true};
    const audit=await auditProtocolSourceV8({bundle,referenceInput,outcome:ownedEffectfulOutcome(bundle)});
    assert.equal(audit.status,'agreed');assert(audit.metadataAudit.checked>0);
    assert(audit.observations.metadata.some(row=>row.objects.some(node=>node.kind==='promise')));
  }
});
test('independent Promise metadata retains modified own state',async()=>{
  const input={source:'"use strict";function run(){const p=Promise.resolve(1);p.extra=2;return p;}',
    entry:'run',inputGraph:encodeNativeGraph([]),mode:'completions',awaitReturnedPromise:true};
  const reference=await independentProtocolSourceReference(input);
  assert(reference.metadata.some(row=>row.objects.some(node=>node.kind==='promise'&&node.properties.some(property=>
    property.key[0]==='str'&&property.key[1]==='extra'&&property.descriptor.value?.[1]===2))));
});
