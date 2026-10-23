import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence} from 'tracing-js-self/training';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
const strict=body=>'"use strict";\n'+body;
function verified(body,args=[]){
  const res=verifyTrainingCase({source:strict(body),entry:'f',args,maxGenerated:1024});
  assert.equal(res.status,'locally_verified',JSON.stringify(res));
  const check=recheckIndependentTrainingEvidence(JSON.parse(JSON.stringify(res.exported)));
  assert.equal(check.valid,true,JSON.stringify(check));
  return res.exported;
}
test('multiple lexical declarations evaluate left-to-right and preserve TDZ',()=>{
  verified('function f(x){let a=x+1,b=a*2,c=b-2;const data={a,b,c};return [data.a,data.b,data.c];}',[4]);
  assert.notEqual(verifyTrainingCase({source:strict('function f(){let x=y,y=2;return x;}'),entry:'f'}).status,'locally_verified');
});
test('object shorthand supports lexical inputs and identical named values',()=>{
  verified('function f(a,b){const c=3;const obj={a,b,c};return [obj.a,obj.b,obj.c];}',[4,5]);
});
test('sequence expressions execute each side effect exactly once',()=>{
  verified('function f(o){let q=(o.n++,o.n+2,o.n*3);return [q,o.n];}',[{n:1}]);
});
test('arithmetic and bitwise compound assignments preserve source results',()=>{
  verified('function f(o){let a=2n,b=4;a**=b;const x={n:9};x.n*=3;x.n>>=2;let v=3;v|=8;v^=2;v<<=1;return [a,x.n,v];}');
  verified('function f(x){x/=2;x%=3;x**=2;return x;}',[15]);
  verified('function f(o){let n=3;n>>>=1;o.x &= n;return [o.x,n];}',[{x:9}]);
});
test('typescript natlang body supports shorthand, declarations and compound operators',()=>{
  class EvalFailure extends Error{constructor(message,events){super(message);this.events=events;}}
  const trace=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:b=>trace.push(b)});
  const result=env.execute({code:'let n: number = self.n, k: number = 2; n *= k; const val = {n,k}; return val.n + val.k;',
    body:true,scope:{n:4},path:'natlang://syntax.ts'});
  assert.equal(result.result,10);
  assert.equal(trace.length,1);
});
test('unsupported destructuring and spread are rejected without fallback',()=>{
  for(const body of [
    'function f(o){let {x}=o;return x;}',
    'function f(o){return {...o};}',
    'function f(a){return [...a];}'
  ])assert.equal(verifyTrainingCase({source:strict(body),entry:'f',args:[{x:2}]}).status,'unsupported');
});
