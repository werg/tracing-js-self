import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence,
  validateTrainingExport} from '../src/training/source-check.js';
import {validateBundle,replayExact} from '../src/index.js';

function check(source,args){
  const result=verifyOwnedSourceCase({source:'"use strict";\n'+source,entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  assert.equal(recheckOwnedSourceEvidence(result.exported).valid,true);
  assert.equal(validateBundle(result.exported.sidecar.archive).valid,true);
  assert.equal(replayExact(result.exported.sidecar.archive).valid,true);
}
test('owned number formatting matches V8 decimal, radix, -0 and fixed rounding',()=>{
  check('function f(x){return [x.toString(),x.toString(16),x.toFixed(1),x.toFixed(0)];}',[255.5]);
  check('function f(x){return [x.toString(),x.toFixed(2)];}',[-0]);
  check('function f(x){return [x.toString(),x.toFixed(2)];}',[NaN]);
  check('function f(x){return [x.toString(),x.toFixed(2)];}',[Infinity]);
});
test('number methods reject nonnumeric receiver and unknown methods',()=>{
  for(const [source,args] of [
    ['function f(){const g=(0).toFixed;return g(3);}',[]],
    ['function f(x){return x.toString({valueOf:()=>10});}',[5]],
    ['function f(x){return x.toPrecision(2);}',[2.12]]
  ])assert.notEqual(verifyOwnedSourceCase({source:'"use strict";\n'+source,entry:'f',args}).status,'locally_verified');
});
