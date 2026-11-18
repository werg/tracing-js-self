import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,replayExact,validateBundle} from '../src/index.js';
import {realizeGraph} from '../src/training/graph.js';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';

function verified(source,args=[]){
  const result=verifyOwnedSourceCase({source,entry:'run',args,maxGenerated:4096});
  assert.equal(result.status,'locally_verified',result.reason??JSON.stringify(result));
  const exported=JSON.parse(JSON.stringify(result.exported));
  assert.equal(validateBundle(exported.sidecar.archive).valid,true);
  assert.equal(replayExact(exported.sidecar.archive).valid,true);
  assert.equal(recheckOwnedSourceEvidence(exported).valid,true);
  assert.doesNotThrow(()=>SelectedExecutionHarness.replay(exported));
  return exported;
}

function executed(source,args=[]){
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args});
  assert.equal(runtime.drive().kind,'terminated');
  return realizeGraph(runtime.state.heap,[runtime.result])[0];
}

test('array literals mix dense spreads, ordinary elements and empty inputs in source order',()=>{
  const source='"use strict";function run(a,b){return [0,...a,3,...b,...[],6];}';
  assert.deepEqual(executed(source,[[1,2],[4,5]]),[0,1,2,3,4,5,6]);
  verified(source,[[1,2],[4,5]]);
  verified('"use strict";function run(){return [...[],...""];}');
});

test('spread captures values before later elements or call arguments mutate its source',()=>{
  for(const tail of ['collect(...xs,xs.push(3))','collect?.(...xs,xs.push(3))']){
    const source='"use strict";function run(xs){const collect=(...ys)=>ys;return '+tail+';}';
    assert.deepEqual(executed(source,[[1,2]]),[1,2,3]);
    verified(source,[[1,2]]);
  }
  const source='"use strict";function run(xs){return [...xs,xs.push(3),...xs];}';
  assert.deepEqual(executed(source,[[1,2]]),[1,2,3,1,2,3]);
  const exported=verified(source,[[1,2]]);
  const captured=exported.sidecar.archive.events.filter(event=>event.result?.[0]==='spread');
  assert.deepEqual(captured.map(event=>event.result[1]),[
    [['num',1],['num',2]],[['num',1],['num',2],['num',3]]
  ]);
  assert.deepEqual(captured[0].readObservations.map(read=>read.key),['length','0','1']);
  assert.deepEqual(captured[0].readObservations.map(read=>read.value),[['num',2],['num',1],['num',2]]);
  const forged=structuredClone(exported.sidecar.archive);
  forged.events.find(event=>event.eventId===captured[0].eventId).readObservations[1].value=['num',999];
  assert.throws(()=>replayExact(forged),/Replay divergence/);
});

test('spread evaluates each source once and preserves alias identities across later writes',()=>{
  const source='"use strict";function part(log,n){log.push(n);return [n];}'+
    'function run(){const log=[];const a=[...part(log,1),...part(log,2)];return [a,log];}';
  assert.deepEqual(executed(source),[[1,2],[1,2]]);
  verified(source);
  const alias='"use strict";function run(){const value={n:1};const xs=[value];'+
    'const copied=[...xs,value.n=7];return [copied,value,copied[0]===value];}';
  const actual=executed(alias);
  assert.equal(actual[0][0],actual[1]);assert.equal(actual[1].n,7);assert.equal(actual[2],true);
  verified(alias);
});

test('primitive string spread uses code points in literals and calls, including lone surrogates',()=>{
  const text='A\u{1d11e}e\u0301\ud800';
  const source='"use strict";function collect(...ys){return ys;}'+
    'function run(text){return [[...text],collect(...text)];}';
  const expected=['A','\u{1d11e}','e','\u0301','\ud800'];
  assert.deepEqual(executed(source,[text]),[expected,expected]);
  verified(source,[text]);
});

test('array spread receives independent completion checks and uses only production v5 records',async()=>{
  for(const body of [
    'const xs=[1,2];return [...xs,xs.push(3),..."𝄞"];',
    'const a={n:1};const xs=[a];const ys=[...xs,a.n=2];return [ys,a];',
    'const xs=[1,2];host.store("spread",[...xs].join(","));return xs;'
  ]){
    const effectful=body.includes('host.store');
    const result=await verifyEffectfulTrainingCase({source:'"use strict";function run(){'+body+'}',
      entry:'run',fixture:{calls:effectful?[{operation:'demo.store',arguments:['spread','1,2']}]:[]},
      family:'bounded-array-literal-spread'});
    assert.equal(result.status,'locally_verified',result.reason);
    assert.equal(result.exported.public.schema,'semantic-execution/5');
    assert(result.exported.sidecar.reference.sourceChecks.completions.checked>0);
    assert(!result.exported.public.timeline.some(row=>row.line?.includes('["spread",')),
      'the private snapshot must not become a generated value or new public record kind');
  }
});

test('holes, accessors, custom prototypes and other iterators remain explicit refusals',()=>{
  for(const body of [
    'const xs=Array(2);return [...xs];',
    'const xs=[1];Object.defineProperty(xs,"0",{get:()=>7});return [...xs];',
    'const xs=[1];Object.setPrototypeOf(xs,null);return [...xs];',
    'return [...new Set([1,2])];',
    'return [...{length:1}];'
  ]){
    const result=verifyOwnedSourceCase({source:'"use strict";function run(){'+body+'}',entry:'run'});
    assert(['unsupported','runtime_failure'].includes(result.status),result.reason);
    assert.match(result.reason,/spread|Spread|accessor descriptors/);
  }
  for(const source of [
    '"use strict";function run(){return [,...[]];}',
    '"use strict";function run(){return [...[],...[],...[],...[],...[]];}'
  ])assert.equal(verifyOwnedSourceCase({source,entry:'run'}).status,'unsupported');
});

test('spread bounds stop before evaluating later side effects',()=>{
  const source='"use strict";function run(text,seen){return [...text,seen.push(9)];}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run',args:['x'.repeat(10001),[]]});
  assert.throws(()=>runtime.drive(),/spread length budget/);
  assert.deepEqual(realizeGraph(runtime.state.heap,runtime.entrySpec.arguments)[1],[]);
});
