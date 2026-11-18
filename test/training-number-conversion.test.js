import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,validateBundle,replayExact} from 'tracing-js-self';
import {describeGraph,realizeGraph} from '../src/training/graph.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

function compare(body){
  const source='"use strict";function run(){'+body+'}';
  const runtime=createRuntime().startEntry({text:source,functionName:'run'});
  assert.equal(runtime.drive().kind,'terminated');
  const archive=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
  assert.deepEqual(describeGraph(realizeGraph(runtime.state.heap,[runtime.result])),
    describeGraph([Function(source+';return run();')()]));
  return source;
}

test('Number preserves omitted/undefined, signed zero, NaN and scalar conversions',()=>{
  compare('return [Number(),Number(undefined),Number(null),Number(false),Number(true),'+
    'Number(""),Number("  7.5  "),Number("-0"),Number(-0),Number("invalid"),'+
    'Number(NaN),Number(Infinity),Number(-Infinity),Number("0x10"),Number(2n)];');
});

test('Number evaluates all arguments in order while converting only the first',()=>{
  compare('const seen=[];function mark(x){seen.push(x);return x;}'+
    'const result=Number(mark("7"),mark(2),{valueOf:()=>{throw 9;}});return [result,seen];');
});

test('primitive Number calls pass independent source, intermediate and public replay gates',async()=>{
  for(const source of [
    compare('return [Number(),Number(undefined),Number(null),Number("-0"),Number("7.5")];'),
    compare('const x="3",y="4";if(Number.isNaN(Number(x))||Number.isNaN(Number(y))){return -1;}'+
      'return Math.sqrt(Number(x)*Number(x)+Number(y)*Number(y));')
  ]){
    const result=await verifyEffectfulTrainingCase({source,entry:'run',fixture:{calls:[]},
      family:'primitive-number-conversion-regression'});
    assert.equal(result.status,'locally_verified',result.reason);
  }
});

test('Number object coercion remains an explicit unsupported operation',()=>{
  for(const value of ['{}','[1]','{valueOf:()=>7}']){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){return Number('+value+');}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/Number conversion requires a primitive/);
    assert.equal(Object.keys(runtime.state.effects).length,0);
  }
});
