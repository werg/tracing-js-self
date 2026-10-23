import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {executeTest262AsyncReference as execute} from '../src/corpus/test262-async-reference.mjs';
const harness={
  'sta.js':'function Test262Error(m){this.message=m}',
  'assert.js':'function assert(x){if(!x)throw new Test262Error("failed")}; assert.sameValue=(a,b)=>{if(!Object.is(a,b))throw new Test262Error("different")}',
  'helper.js':'globalThis.helper=23;'
};
const meta=(negative=null,includes=[],flags=['async'])=>({metadataStatus:'parsed',
  flags,includes,features:[],negative});
const run=(source,metadata=meta(),more={})=>execute({source,metadata,
  harnessSources:harness,...more});

test('pinned async harness observes Promise microtasks and non-admission',async()=>{
  const result=await run('Promise.resolve(23).then(value=>{ assert.sameValue(value,helper); $DONE(); });',
    meta(null,['helper.js']));
  assert.equal(result.status,'passed',result.reason);
  assert.equal(result.completionCalls,1);
  assert.equal(result.authority,'native-v8-diagnostic-only');
  assert.equal(result.verifiedOwned,false);
  assert.equal(result.admitted,false);
});
test('async completion errors are real cross-realm constructors',async()=>{
  const negative=meta({phase:'runtime',type:'TypeError'});
  assert.equal((await run('Promise.resolve().then(()=>$DONE(new TypeError()))',negative)).status,'passed');
  assert.equal((await run('Promise.resolve().then(()=>$DONE({name:"TypeError"}))',negative)).status,'failed');
  assert.equal((await run('Promise.resolve().then(()=>$DONE(new RangeError()))',negative)).status,'failed');
  assert.equal((await run('Promise.resolve().then(()=>$DONE())',negative)).status,'failed');
  assert.equal((await run('throw new TypeError()',negative)).status,'passed');
  assert.equal((await run('throw {name:"TypeError"}',negative)).status,'failed');
  assert.equal((await run('$DONE(new TypeError())')).status,'failed');
  assert.equal((await run('$DONE(null)')).status,'failed');
});
test('missing, duplicate and thrown completions do not pass',async()=>{
  assert.equal((await run('Promise.resolve().then(()=>{})')).status,'unsupported');
  assert.equal((await run('new Promise(()=>{}).then($DONE)')).status,'unsupported');
  assert.equal((await run('$DONE(); $DONE()')).status,'failed');
  assert.equal((await run('$DONE(); Promise.resolve().then($DONE)')).status,'failed');
  assert.equal((await run('$DONE(); throw new Error("after completion")')).status,'failed');
  assert.equal((await run('assert(false); $DONE()')).status,'failed');
  assert.equal((await run('while(true){}',meta(),{timeoutMs:10})).status,'failed');
});
test('parse error, strictness, metadata and harness restrictions',async()=>{
  assert.equal((await run('var = ;',meta({phase:'parse',type:'SyntaxError'}))).status,'passed');
  assert.equal((await run('var x=1;',meta({phase:'parse',type:'SyntaxError'}))).status,'failed');
  assert.equal((await run('with({}){}; $DONE()',meta(null,[],['async','onlyStrict']),{mode:'strict'})).status,'failed');
  assert.equal((await run('$DONE()',meta(null,[],['async','onlyStrict']))).status,'unsupported');
  assert.equal((await run('$DONE()',meta(null,[],['async','module']))).status,'unsupported');
  assert.equal((await run('$DONE()',meta(null,[],['async','raw']))).status,'unsupported');
  assert.equal((await run('$DONE()',meta({phase:'early',type:'SyntaxError'}))).status,'unsupported');
  assert.equal((await run('$DONE()',meta(null,['../unsafe.js']))).status,'unsupported');
  assert.equal((await run('$DONE()',meta(null,['missing.js']))).status,'unsupported');
  assert.equal((await run('$DONE()',meta(),{harnessSources:{...harness,'sta.js':'throw Error("bad")'}})).status,'unsupported');
  await assert.rejects(run('$DONE()',meta(),{timeoutMs:1}),/Invalid/);
});

test('unhandled rejection after $DONE is a failed diagnostic (isolated child)',()=>{
  const payload={source:'$DONE(); Promise.resolve().then(()=>{throw Error("late")})',
    metadata:meta(),harnessSources:harness};
  const script='import {executeTest262AsyncReference as run} from '+
    JSON.stringify(new URL('../src/corpus/test262-async-reference.mjs',import.meta.url).href)+';'+
    'const result=await run('+JSON.stringify(payload)+');console.log(result.status);';
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],
    {encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'failed');
});

test('opt-in virtual host turns support bounded async timer completion',async()=>{
 const delayed=await run('setTimeout(()=>Promise.resolve(3).then(x=>{assert.sameValue(x,3);$DONE();}),0)',
  meta(),{hostTimers:true});
 assert.equal(delayed.status,'passed',delayed.reason);
 assert.equal(delayed.completionCalls,1);
 assert.equal(delayed.verifiedOwned,false);
 assert.equal(delayed.admitted,false);
 const cancelled=await run('const id=setTimeout(()=>{throw Error("should not fire")},0);clearTimeout(id);$DONE();',
  meta(),{hostTimers:true});
 assert.equal(cancelled.status,'passed',cancelled.reason);
 const queued=await run('queueMicrotask(()=>$DONE())',
  meta(),{hostTimers:true});
 assert.equal(queued.status,'passed',queued.reason);
});
test('virtual host timers refuse endless intervals and detect late errors',async()=>{
 const interval=await run('setInterval(()=>{},0)',meta(),{hostTimers:true});
 assert.equal(interval.status,'unsupported');
 assert.match(interval.reason,/budget/);
 assert.equal(interval.verifiedOwned,false);
 const duplicate=await run('$DONE();setTimeout(()=>$DONE(),0)',
  meta(),{hostTimers:true});
 assert.equal(duplicate.status,'failed');
 const callbackThrow=await run('setTimeout(()=>{throw Error("late")},0);$DONE();',
  meta(),{hostTimers:true});
 assert.equal(callbackThrow.status,'failed');
 const absent=await run('setTimeout(()=>{},0)',meta(),{hostTimers:true});
 assert.equal(absent.status,'unsupported');
 assert.equal((await run('setTimeout(()=>$DONE(),0)',meta())).status,'failed');
});
test('virtual timers cannot spoof a declared native negative constructor',async()=>{
 const native=await run('setTimeout(()=>$DONE(new TypeError()),0)',
  meta({phase:'runtime',type:'TypeError'}),{hostTimers:true});
 assert.equal(native.status,'passed');
 const spoof=await run('setTimeout(()=>$DONE({name:"TypeError"}),0)',
  meta({phase:'runtime',type:'TypeError'}),{hostTimers:true});
 assert.equal(spoof.status,'failed');
 await assert.rejects(run('$DONE()',meta(),{hostTimers:'yes'}),/Invalid/);
});
