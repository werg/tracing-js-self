import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,validateTrainingExport} from 'tracing-js-self/training';
import {validateBundle,replayExact} from 'tracing-js-self';

function check(body,args=[]){
  const result=verifyTrainingCase({source:'"use strict";\n'+body,entry:'f',
    args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(result.exported.sidecar.operationAudit.status,'agreed');
  assert.equal(result.exported.sidecar.branchAudit.status,'agreed');
  assert.equal(validateTrainingExport(result.exported).valid,true);
  const archive=structuredClone(result.exported.sidecar.archive);
  assert.equal(validateBundle(archive).valid,true);
  assert.equal(replayExact(archive).valid,true);
}
test('owned UTF-16 string property reads and scalar leaves match V8',()=>{
  check(`function f(s){return [s.length,s[1],s[100],s.charCodeAt(1),s.charAt(0),
    s.indexOf('ab'),s.startsWith('a'),s.endsWith('B'),s.substring(1),
    s.toLowerCase(),s.trim(),s.slice(-2),s.charAt(0).toUpperCase()];}`,[' abB ']);
  check('function f(s){return [s.length,s[1],s[2],s.at(-2)];}', ['A😀B']);
});
test('owned bounded string substr preserves V8 index and length semantics',()=>{
  check(`function f(s){return [s.substr(0,2),s.substr(-2),s.substr(1,3),
    s.substr(100,2),s.substr(3,-1)];}`, ['a😀bc']);
  check('function f(s){return s.substr(0,s.indexOf("\\n"));}', ['one\\ntwo']);
});
test('owned dense array search, copy and mutation match V8',()=>{
  check(`function f(a){const copy=a.slice(1),joined=a.join('-'),concat=a.concat([9]);
    const before=a.indexOf(2),last=a.lastIndexOf(2);
    const removed=a.splice(1,1,8,7),size=a.unshift(5),first=a.shift();
    return [copy,joined,concat,before,last,removed,size,first,a,a.length];}`,[[1,2,3]]);
  check(`function f(a){const x=a.splice(-2),y=a.splice(0,0,0);
    return [x,y,a,a.indexOf(0),a.lastIndexOf(0)];}`,[[1,0,3]]);
});
test('unmodeled callbacks and coercions never silently pass',()=>{
  for(const [body,args] of [
    ['function f(o){return "a".includes(o);}',[{}]],
    ['function f(o){return [1,2].join(o);}',[{}]],
    ['function f(o){return [o].join(",");}',[{}]]
  ]){
    const result=verifyTrainingCase({source:'"use strict"; '+body,entry:'f',args});
    assert.notEqual(result.status,'locally_verified',body);
  }
});
