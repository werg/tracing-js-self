import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareQueueHistory,generateQueueSequences,shrinkStatefulMismatch,
 validateStatefulCommands} from '../src/corpus/stateful-differential.mjs';
import Queue from '../corpus/stateful/upstream/yocto-queue/index.js';

test('bounded pinned queue sequences reproduce across an independent state model',()=>{
 const generated=generateQueueSequences({seed:19,count:200,maxCommands:80});
 assert(generated.length>120);
 assert.deepEqual(generated,generateQueueSequences({seed:19,count:200,maxCommands:80}));
 assert.notDeepEqual(generated,generateQueueSequences({seed:20,count:200,maxCommands:80}));
 const operations=new Set();
 for(const {commands} of generated){
  for(const c of commands)operations.add(c.op);
  const outcome=compareQueueHistory(commands,Queue);
  assert.equal(outcome.agreed,true,JSON.stringify(commands));
  assert.equal(outcome.admitted,false);
  assert.equal(outcome.verifiedOwned,false);
 }
 assert.deepEqual([...operations].sort(),['clear','dequeue','drain','enqueue','peek','snapshot']);
});
test('strict command validation rejects dangerous, non-data and unsupported inputs',()=>{
 assert.throws(()=>validateStatefulCommands([]),/Invalid/);
 assert.throws(()=>validateStatefulCommands([{op:'eval'}]),/Invalid queue/);
 assert.throws(()=>validateStatefulCommands([{op:'enqueue'}]),/Invalid queue/);
 assert.throws(()=>validateStatefulCommands([{op:'peek',value:1}]),/Invalid queue/);
 assert.throws(()=>validateStatefulCommands([{op:'enqueue',value:Infinity}]),/JSON/);
 assert.throws(()=>validateStatefulCommands([{op:'enqueue',value:undefined}]),/Expected|JSON/);
 assert.throws(()=>validateStatefulCommands([{op:'enqueue',value:{get x(){throw Error('executed')}}}]),/Unsafe/);
 assert.throws(()=>validateStatefulCommands([{op:'enqueue',value:JSON.parse('{"__proto__":1}')}]),/Unsafe/);
 assert.throws(()=>generateQueueSequences({count:5000}),/Invalid/);
});
test('delta debugging removes irrelevant commands and reduces JSON payloads',async()=>{
 const commands=[{op:'enqueue',value:1000},{op:'peek'},
  {op:'enqueue',value:{noise:'not-needed',hit:900}},
  {op:'clear'},{op:'enqueue',value:19},{op:'snapshot'}];
 const predicate=async seq=>({reproduced:seq.some(c=>c.op==='enqueue'&&
  typeof c.value==='object'&&c.value?.hit>0),signature:'queue-state-mismatch'});
 const result=await shrinkStatefulMismatch(commands,predicate,{maxEvaluations:256});
 assert.equal(result.status,'minimized');
 assert.equal(result.oracleSignature,'queue-state-mismatch');
 assert.deepEqual(result.minimizedCommands,[{op:'enqueue',value:{hit:1}}]);
 assert(result.minimizedBytes<result.originalBytes);
 assert(result.evaluations<=256);
 assert.equal(result.admitted,false);
 const again=await shrinkStatefulMismatch(commands,predicate,{maxEvaluations:256});
 assert.deepEqual(result,again);
});
test('shrinker refuses flaky, exception, nonmatching signatures, and bounded budgets',async()=>{
 const commands=[{op:'enqueue',value:13},{op:'peek'}];
 const missing=await shrinkStatefulMismatch(commands,()=>false);
 assert.equal(missing.status,'not-reproduced');
 let flip=false;
 const flaky=await shrinkStatefulMismatch(commands,()=>{flip=!flip;return flip;});
 assert.equal(flaky.status,'not-reproduced');
 const errors=await shrinkStatefulMismatch(commands,()=>{throw Error('oracle crashed');});
 assert.equal(errors.oracleErrors,1);
 const cannotChange=await shrinkStatefulMismatch(commands,seq=>({reproduced:
  seq.length===commands.length&&seq[0].value===13,signature:'same'}));
 assert.equal(cannotChange.status,'unreduced');
 const limited=await shrinkStatefulMismatch(commands,()=>true,{maxEvaluations:2});
 assert.equal(limited.evaluations,2);
 assert.equal(limited.status,'budget-exhausted');
 await assert.rejects(shrinkStatefulMismatch(commands,()=>true,{confirmations:1}),/Invalid/);
});
