import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnedSourceCase,recheckOwnedSourceEvidence} from '../src/training/source-check.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
const source=body=>'"use strict";function run(x){'+body+'}';
function check(body,args=[]){
  const r=verifyOwnedSourceCase({source:source(body),entry:'run',args,maxGenerated:4096});
  assert.equal(r.status,'locally_verified',r.reason);
  assert.equal(recheckOwnedSourceEvidence(r.exported).valid,true);
  return r;
}
test('switch evaluates one discriminant and stops testing at first match then falls through',()=>{
  const body='let events=[];function mark(v){events.push(v);return v;}let n=0;'+
    'switch(mark(x)){case mark(1):n+=1;case mark(2):n+=2;break;default:n+=4;case mark(3):n+=8;}return [n,events];';
  for(const x of [1,2,3,9])check(body,[x]);
});
test('switch shares lexical declarations and supports an empty default anywhere',()=>{
  check('let y=8;switch(x){case 1:let y=3;case 2:return y;default:return 7;}',[1]);
  check('let y=8;switch(x){case 1:let y=3;case 2:return y;default:return 7;}',[2]);
  check('let y=0;switch(x){default:case 2:y=4;break;case 3:y=5;}return y;',[0]);
  check('switch(x){}return x;',[7]);
});
test('switch break and continue resolve their distinct enclosing targets',()=>{
  check('let a=[];for(let i=0;i<4;i++){switch(i){case 1:continue;case 2:break;default:a.push(i);}a.push(9);}return a;');
});
test('labels cross nested loops and run finally exactly once',async()=>{
  const body='let a=[];outer:for(let i=0;i<3;i++){for(let j=0;j<3;j++){try{if(j===1)continue outer;a.push(i*10+j);}finally{a.push(8);}}}'+
    'block:{try{a.push(7);break block;}finally{a.push(6);}a.push(99);}return a;';
  check(body);
  check('let a=[];one:two:for(let i=0;i<3;i++){for(let j=0;j<3;j++){if(j===1)break one;a.push(j);}}return a;');
  const r=await verifyEffectfulTrainingCase({source:source(body),entry:'run',family:'label-cleanup',fixture:{calls:[]}});
  assert.equal(r.status,'locally_verified',r.reason);
  assert(r.exported.sidecar.reference.sourceChecks.completions.checked>0);
});
