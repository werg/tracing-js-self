import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {independentProtocolSourceReference} from '../src/semantic/protocol-source-reference-v8.js';
import {PROTOCOL_METADATA_LIMITS} from '../src/semantic/protocol-source-observations-v8.js';

test('a module observer cap preserves the failed worker diagnostic without admitting its source',async()=>{
  const linked=linkEvaluatedModules({modules:{
    's.js':'export let n=1;',
    'a.js':"import './s.js';await 0;",
    'b.js':"import './s.js';await 0;",
    'main.js':"import './a.js';import './b.js';import {n} from './s.js';export function run(){return n;}"
  },entryModule:'main.js',exportName:'run'});
  const input={source:linked.source,entry:linked.entryFunction,
    inputGraph:encodeNativeGraph([linked.entryInput]),awaitReturnedPromise:true};
  const original=await independentProtocolSourceReference({...input,mode:'original'});
  assert.equal(original.outcome.kind,'return');
  assert.deepEqual(original.outcome.graph.roots.at(-1),['num',1]);
  await assert.rejects(independentProtocolSourceReference({...input,mode:'completions'}),error=>{
    assert.equal(error.category,'reference_process_failure');
    assert.match(error.message,/invalid JSON \(exit 1, mode completions\)/);
    assert.match(error.message,/Independent protocol metadata observation bound/);
    assert(error.cause instanceof SyntaxError);
    return true;
  });
  assert.deepEqual(PROTOCOL_METADATA_LIMITS,{snapshots:8192,bytes:4194304,snapshotBytes:1048576});
});

test('a returned Promise that leaves the worker unsettled reports its process exit',async()=>{
  await assert.rejects(independentProtocolSourceReference({
    source:'async function run(){await new Promise(function(){});}',entry:'run',
    inputGraph:encodeNativeGraph([]),mode:'original',awaitReturnedPromise:true
  }),error=>{
    assert.equal(error.category,'reference_process_failure');
    assert.match(error.message,/invalid JSON \(exit 13, mode original\)/);
    assert(error.cause instanceof SyntaxError);
    return true;
  });
});
