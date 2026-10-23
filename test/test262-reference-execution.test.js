import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeTest262Reference} from '../src/corpus/test262-reference-execution.mjs';
const harnessSources={
  'sta.js':'function Test262Error(message){this.message=message}',
  'assert.js':'function assert(x){if(!x)throw new Test262Error("failed")}; assert.sameValue=(a,b)=>{if(!Object.is(a,b))throw new Test262Error("not same")}',
  'helper.js':'var helperValue=42;'
};
const meta=(flags=[],negative=null,includes=[])=>({metadataStatus:'parsed',flags,
  includes,features:[],negative});
const run=(source,metadata=meta(),more={})=>executeTest262Reference({
  source,metadata,harnessSources,...more});
test('sloppy/strict variants use pinned harness and do not produce owned training data',()=>{
  const original='assert.sameValue(helperValue,42); assert.sameValue((function(){return this===undefined})(),false);';
  const sloppy=run(original,meta([],null,['helper.js']));
  const strict=run(original,meta([],null,['helper.js']),{mode:'strict'});
  assert.equal(sloppy.status,'passed',sloppy.reason);
  assert.equal(strict.status,'failed');
  assert.equal(sloppy.verifiedOwned,false);assert.equal(sloppy.admitted,false);
  assert.equal(sloppy.authority,'native-v8-diagnostic-only');
});
test('negative parse and runtime are distinguished by actual phase and constructor',()=>{
  const parse=meta([], {phase:'parse',type:'SyntaxError'});
  assert.equal(run('var = ;',parse).status,'passed');
  assert.equal(run('var x=1;',parse).status,'failed');
  const runtime=meta([],{phase:'runtime',type:'TypeError'});
  assert.equal(run('throw new TypeError("real");',runtime).status,'passed');
  assert.equal(run('throw {name:"TypeError"};',runtime).status,'failed');
  assert.equal(run('var = ;',runtime).status,'failed');
  assert.equal(run('throw new RangeError("other");',runtime).status,'failed');
  assert.equal(run('throw new TypeError("real");').status,'failed');
  assert.equal(run('var = ;').status,'failed');
});
test('strict-only parsing, harness errors and safety refusals fail closed',()=>{
  assert.equal(run('with({}){}',meta(['onlyStrict']),{mode:'strict'}).status,'failed');
  assert.equal(run('assert(true)',meta(['onlyStrict'])).status,'unsupported');
  assert.equal(run('assert(true)',meta(['module'])).status,'unsupported');
  assert.equal(run('assert(true)',meta(['async'])).status,'unsupported');
  assert.equal(run('assert(true)',meta(['raw'])).status,'unsupported');
  assert.equal(run('assert(true)',meta([],{phase:'early',type:'SyntaxError'})).status,'unsupported');
  assert.equal(run('assert(true)',meta([],null,['../evil.js'])).status,'unsupported');
  assert.equal(run('assert(true)',meta([],null,['missing.js'])).status,'unsupported');
  assert.equal(run('assert(true)',meta(),{harnessSources:{'sta.js':'throw Error("bad")',
    'assert.js':harnessSources['assert.js']}}).status,'unsupported');
  assert.equal(run('while(true){}',meta(),{timeoutMs:15}).status,'failed');
  assert.throws(()=>run('1',meta(),{timeoutMs:0}),/Invalid/);
});
