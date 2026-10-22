import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {verifyTrainingCase} from '../src/training/admit.js';
import {validateTrainingExport} from '../src/training/export.js';
import {parseTraining} from '../src/training/profile.js';
import {encodeRecord,decodeRecord,fragmentLine,restoreLines} from '../src/training/format.js';

const strict=code=>'"use strict";\n'+code;
function verified(code,entry,args=[]) {
  const result=verifyTrainingCase({source:strict(code),entry,args});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  assert.equal(validateTrainingExport(result.exported).valid,true);
  return result;
}
test('known lexical divergences: hex escapes and undefined parameter',()=>{
  const r=createRuntime().start('let s="\\x41";');
  assert.equal(r.drive().kind,'terminated');
  const s=Object.values(r.state.envs).find(e=>e.bindings.s).bindings.s.token.value;
  assert.deepEqual(s,['str','A']);
  verified('function f(undefined){return undefined;}', 'f',[3]);
});
test('array truncation and noncanonical property indices match a reference',()=>{
  verified('function f(){const a=[1,2]; a.length=1;return a[1];}','f');
  verified('function f(){const a=[];a["01"]=4;return [a.length,a["01"]];}','f');
  verified('function f(){const a=[1,2,3];a.length=1;return a;}','f');
});
test('identity, aliasing, loops, function calls and closures survive the reference gate',()=>{
  const shared={x:1};
  verified('function f(a,b){if(a===b){a.x=a.x+1;} return [a,b];}','f',[shared,shared]);
  verified('function f(a,b){return a===b;}','f',[{x:1},{x:1}]);
  verified('function f(v){let i=0;while(i<3){i+=1;}return i+v;}','f',[10]);
  verified('function f(x){function g(y){return x+y;}return g(3);}','f',[9]);
  verified('function f(x){return typeof x;}','f',[{a:1}]);
  verified('function f(){return typeof f;}','f');
  verified('function f(x){return x?1:2;}','f',[1]);
});
test('cycles in input graph and returned aliases are preserved',()=>{
  const obj={a:1};obj.self=obj;
  verified('function f(s){s.a=2;return [s,s.self];}','f',[obj]);
});
test('strict profile rejects unsupported syntax and ambient globals',()=>{
  for(const code of [
    'function f(){return unknown+2;}', 'var x=1;function f(){return x;}',
    'function f(){return eval("1");}', 'function f(){return new Date();}',
    'async function f(){return 1;}', 'function f(){return a?.b;}',
    'function f(){return [,,2];}', 'function f(){return this;}'
  ]) assert.equal(verifyTrainingCase({source:strict(code),entry:'f'}).status,'unsupported');
  assert.throws(()=>parseTraining('function f(){return 1;}'),/use strict/);
});
test('explicit guest throws commit and reconstruct but are not admitted',()=>{
  const runtime=createRuntime().start('function f(){throw "oops";} f();');
  assert.equal(runtime.drive().kind,'guest.throw');
  const bundle=runtime.exportRun();
  assert.deepEqual(bundle.finalState.control.a0.completion,{kind:'throw',value:['str','oops']});
  assert(bundle.events.some(e=>e.operation==='completion.throw'));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  assert.equal(verifyTrainingCase({source:strict('function f(){throw 1;}'),entry:'f'}).status,'unsupported');
});
test('canonical trace text and multi-chunk value serialization round trip',()=>{
  const x=encodeRecord('value',{id:'e1',result:['str','hello\n\ud800'+'Q'.repeat(2400)]});
  const lines=fragmentLine(x,{maxBytes:512});
  assert(lines.length>2);
  assert(lines.every(l=>Buffer.byteLength(l,'utf8')<=512));
  assert.deepEqual(restoreLines(lines),[x]);
  assert.deepEqual(decodeRecord(x),{kind:'value',fields:{id:'e1',result:['str','hello\n\ud800'+'Q'.repeat(2400)]}});
});
test('the exporter rejects forged semantic records and future group dependencies',()=>{
  const res=verified('function f(x){let y=x+2;if(y>1)y=y+3;return y;}','f',[3]);
  const changed=structuredClone(res.exported);
  const target=changed.public.groups.find(g=>g.events.some(e=>e.record.startsWith('branch ')));
  assert(target);
  target.events[0].record=target.events[0].record.replace('"decision":false','"decision":true');
  assert.throws(()=>validateTrainingExport(changed));
  const forged=structuredClone(res.exported);
  const value=forged.public.groups.find(g=>g.events.some(e=>e.record.startsWith('value ')));
  assert(value);
  value.events[0].record=value.events[0].record.replace('"result"', '"wrongResult"');
  assert.throws(()=>validateTrainingExport(forged));
});
