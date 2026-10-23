import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {RTL_PATTERN} from '../src/owned-rtl-pattern.js';

function verified(source,entry,args){
  const result=verifyTrainingCase({source:'"use strict";\n'+source,
    entry,args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const e=JSON.parse(JSON.stringify(result.exported));
  assert.equal(validateTrainingExport(e).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(e).valid,true);
  assert.equal(validateBundle(e.sidecar.archive).valid,true);
  assert.equal(replayExact(e.sidecar.archive).valid,true);
  return e;
}
test('regex escape executes each guest switch callback and its return',()=>{
  const e=verified(String.raw`function f(s){return s.replace(/[<>&]/g,function(m){
    switch(m){case '<':return '&lt;';case '>':return '&gt;';
      case '&':return '&amp;';default:return m;}
  });}`,'f',['<a&b>']);
  assert(e.sidecar.semantic.events.filter(x=>x.op==='call'&&x.child).length>=3);
});
test('capture groups and unknown names follow the guest callback',()=>{
  verified(String.raw`const re=/{([^}]+)}/g;
    function f(s,v){return s.replace(re,(m,g)=>v[g]??m);}`,
    'f',['Hi {name} / {missing} / {n}',{name:'Alice',n:23}]);
});
test('positional format invokes owned decimal parseInt and rest reads',()=>{
  verified(String.raw`const re=/{(\d+)}/g;
    function f(s,...args){return s.replace(re,function(m,g){
      const i=parseInt(g,10);return isNaN(i)||i<0||i>=args.length?m:args[i];
    });}`,'f',['{0};{1};{9}',2,'done']);
});
test('pinned Unicode RTL includes BMP and surrogate ranges',()=>{
  const source='let cached=undefined;function get(){return /'+RTL_PATTERN+
    '/;}function f(s){if(!cached)cached=get();return cached.test(s);}';
  verified(source,'f',['abc']);
  verified(source,'f',['\u05D0\u05D1']);
  verified(source,'f',['\uD802\uDC00']);
});
test('unmodeled patterns and fallthrough switches fail closed',()=>{
  for(const source of [
    String.raw`function f(s){return s.replace(/\w+/g,m=>m+'!');}`,
    String.raw`function f(s){switch(s){case 'a':break;default:return 2;}return 1;}`,
    String.raw`function f(s){return s.replace(/[<>&]/i,m=>m);}`
  ]){
    const r=verifyTrainingCase({source:'"use strict";\n'+source,entry:'f',args:['a']});
    assert.notEqual(r.status,'locally_verified');
  }
});
