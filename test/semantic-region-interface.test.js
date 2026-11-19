import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {defineRegionProgram,validateRegionProgram,evaluateLocalRegion,regionEntry,
  encodeRegionRecord,decodeRegionRecord,analyzeRegionEffects} from '../src/semantic/regions.js';
import {parse} from 'acorn';

function setup(source,args){
  const h=new SelectedExecutionHarness({sessionId:'region'});
  h.publishProgram({programId:'p',source,entry:'run'});
  h.admitInvocation({programId:'p',invocationId:'i',trackId:'t',realmId:'realm',triggerId:'entry',args});
  return {controller:h.invocations.get('i').controller,...defineRegionProgram({source,entry:'run'})};
}
test('source-only region definitions split around getters without observing them',()=>{
  const source='"use strict";function run(x){const a=x+1;const b=a*2;const v=account.price;return b+v;}';
  const {program,provenance}=defineRegionProgram({source,entry:'run'});
  assert.equal(program.regions.length,2);
  assert.deepEqual(program.regions[0].inputs,['x']);
  assert.deepEqual(program.regions[0].outputs,['a','b']);
  assert.deepEqual(program.regions[1].inputs,['b','v']);
  assert.equal(program.regions[1].completion,'return');
  assert.equal(provenance.locations.length,2);
  assert.equal(validateRegionProgram(program),true);
  assert(Object.isFrozen(program.regions[0].operations));
  const changed=structuredClone(program);changed.regions[0].operations[0].binding='wrong';
  assert.throws(()=>validateRegionProgram(changed),/definition changed/);
});
test('entry anchors shared cells, pending completion and exact causal cutoff',()=>{
  const {program,controller}=setup('"use strict";function run(x){let y=x+1;return y*2;}',[3]);
  const region=program.regions[0],entry=regionEntry(program,region,controller,2);
  const evaluated=evaluateLocalRegion(region,controller);
  assert.deepEqual(evaluated.bindings,[['y',['num',4]]]);
  assert.deepEqual(evaluated.completion,{kind:'return',value:['num',8]});
  assert.equal(controller.locals.has('y'),false,'eligibility does not mutate state');
  controller.setLocal('x',['num',4]);
  assert.notEqual(regionEntry(program,region,controller,2).stateDigest,entry.stateDigest);
  assert.equal(regionEntry(program,region,controller,3).visibleThrough,3);
});
test('selection is lazy and undefined defaults stay distinct from nullishness',()=>{
  for(const [x,expected] of [[0,0],[null,10],[undefined,10]]){
    const {program,controller}=setup('"use strict";function run(x){let a=x??10;return false?(1n+1):a;}',[x]);
    const result=evaluateLocalRegion(program.regions[0],controller);
    assert.deepEqual(result.completion,{kind:'return',value:['num',expected]});
    assert.deepEqual(result.decisions.at(-1),{kind:'select',selected:'alternate'});
  }
});
test('a later throwing expression refuses before an earlier binding is committed',()=>{
  const {program,controller}=setup('"use strict";function run(x){let a=x+1;let b=1n+1;return a;}',[2]);
  assert.throws(()=>evaluateLocalRegion(program.regions[0],controller),/BigInt/);
  assert.equal(controller.locals.has('a'),false);
});
test('shadowed cells and cleanup stay detailed; effect metadata identifies boundaries',()=>{
  const source='"use strict";function run(x){let a=x+1;{let a=2;}try{return a;}finally{cleanup();}}';
  const {program}=defineRegionProgram({source,entry:'run'});
  assert.equal(program.regions.length,0);
  const effects=analyzeRegionEffects(parse(source,{ecmaVersion:2026}));
  assert(effects.calls.includes('cleanup'));assert(effects.cleanup);assert(effects.mayThrow);
});
test('const assignment, cross-frame duplicate bindings and shadowed undefined cannot become local claims',()=>{
  for(const source of [
    '"use strict";function run(x){const a=x+1;a=2;return a;}',
    '"use strict";function run(undefined){return undefined;}',
    '"use strict";function helper(x){return x+1;}function run(x){return x+2;}'
  ]){
    const {program}=defineRegionProgram({source,entry:'run'});
    if(source.includes('a=2'))assert(program.regions.every(region=>region.operations.every(step=>step.term?.value?.[1]!==2)));
    else assert.equal(program.regions.length,0);
  }
});
test('canonical region records retain lossless values and reject changed fields',()=>{
  const {program,controller}=setup('"use strict";function run(x){return -x;}',[0]);
  const region=program.regions[0],{records,...result}=evaluateLocalRegion(region,controller);
  const record={region:region.id,...result};
  const line=encodeRegionRecord(record);
  assert.deepEqual(decodeRegionRecord(line),record);
  assert.deepEqual(record.completion.value,['num','-0']);
  assert.throws(()=>decodeRegionRecord(line+' '),/Noncanonical/);
  assert.throws(()=>encodeRegionRecord({...record,future:7}),/fields/);
});
