import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from 'tracing-js-self/training/diagnostic';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
const strict=code=>'"use strict";\n'+code;
function verified(code,args=[]){
  const result=verifyTrainingCase({source:strict(code),entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const episode=JSON.parse(JSON.stringify(result.exported));
  const evidence=recheckIndependentTrainingEvidence(episode);
  assert.equal(evidence.valid,true,JSON.stringify(evidence));
  assert(evidence.operations>0);
  return episode;
}
test('interpolated primitive templates have independent executed expression receipts',()=>{
  const source='function f(a,b){let x=`result: ${a}, ${b}!`;return [x,`plain\\nvalue`];}';
  const result=verified(source,[3,4n]);
  assert.equal(result.sidecar.operationAudit.covered.templates,2);
});
test('template ToString handles special numeric and other scalar values',()=>{
  const source='function f(a,b,c){return `[${a}][${b}][${c}]`;}';
  for(const args of [[undefined,null,-0],[NaN,Infinity,false],
     [true,0n,-123n],[-Infinity,'x',0]]){
    const result=verified(source,args);
    assert.equal(result.sidecar.operationAudit.covered.templates,1);
  }
});
test('substitutions execute exactly once in source order',()=>{
  const source='function f(o){function next(){o.n+=1;return o.n;}return `${next()}-${next()}-${o.n}`;}';
  const result=verified(source,[{n:0}]);
  assert.equal(result.sidecar.operationAudit.covered.templates,1);
});
test('object substitution fails closed without native guest ToString',()=>{
  const result=verifyTrainingCase({
    source:strict('function f(o){return `${o}`;}'),entry:'f',args:[{}]});
  assert.notEqual(result.status,'locally_verified');
});
test('natlang TS frontend lowers templates via owned JS runtime',()=>{
  class EvalFailure extends Error{constructor(message,events){super(message);this.events=events;}}
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:b=>traces.push(b)});
  const result=env.execute({code:'const num: number = self.n; return `n=${num + 3}`;',
    body:true,scope:{n:4},path:'natlang://template.ts'});
  assert.equal(result.result,'n=7');
  assert.equal(traces.length,1);
  assert.equal(traces[0].manifest.profile,'training-js/1');
});
