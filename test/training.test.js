import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {verifyTrainingCase} from '../src/training/admit.js';
import {validateTrainingExport} from '../src/training/export.js';
import {parseTraining} from '../src/training/profile.js';
import {referenceOutcome} from '../src/training/reference.js';
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
  for(const escape of ['\\01','\\08','\\09','\\1','\\7'])
    assert.throws(()=>createRuntime().start('let s="'+escape+'";'),/Legacy octal escapes/);
  const zero=createRuntime().start('let s="\\0";');
  assert.equal(zero.drive().kind,'terminated');
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
  verified('function f(x){if(x)return 1;return 2;}','f',[1]);
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
  assert.equal(runtime.drive().kind,'runtime.failure');
  const bundle=runtime.exportRun();
  const event=bundle.events.find(e=>e.operation==='completion.throw');
  assert(event);
  const failure=bundle.finalState.control.a0.failure;
  assert.equal(failure.kind,'guest-abrupt');
  assert.deepEqual(failure.completion,{type:'throw',
    value:{value:['str','oops'],origin:event.operandOrigins[0]}});
  assert.deepEqual(bundle.finalState.frames[failure.frameId].completion,failure.completion);
  assert.deepEqual(event.completion,failure.completion);
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
  const branch=decodeRecord(target.events[0].record);
  branch.fields.path=branch.fields.path==='then'?'else':'then';
  target.events[0].record=encodeRecord(branch.kind,branch.fields);
  assert.throws(()=>validateTrainingExport(changed));
  const forged=structuredClone(res.exported);
  const value=forged.public.groups.find(g=>g.mode==='generated' && g.events.some(e=>e.record.startsWith('value ') && e.record.includes('"result"')));
  assert(value);
  value.events[0].record=value.events[0].record.replace('"result"', '"wrongResult"');
  assert.throws(()=>validateTrainingExport(forged));
});

test('reference input graphs are created inside the restricted V8 realm',()=>{
  const safeSource=strict('function f(a){return a;}');
  const runtime=createRuntime().startEntry({text:safeSource,functionName:'f',args:[[1,2]]});
  const source=strict('function f(a){return a.constructor.constructor("return process")();}');
  const result=referenceOutcome({source,entry:'f',args:runtime.entrySpec.arguments,
    initialHeap:runtime.initialState.heap});
  assert.equal(result.kind,'reference.error');
  assert.match(result.message,/Code generation from strings disallowed/);
});
test('the exporter rejects extra public fields and forged descriptors',()=>{
  const exported=verified('function f(x){return x+1;}','f',[1]).exported;
  for(const [field,value] of [
    ['meta',{finalState:{hidden:true}}],
    ['debug',{privateSidecar:exported.sidecar.archive}],
    ['profile','other-profile'],
    ['traceFormat','other-trace'],
    ['contextFormat','other-context'],
    ['completionPolicy','deferred']
  ]) {
    const forged=structuredClone(exported);
    forged.public[field]=value;
    assert.throws(()=>validateTrainingExport(forged),
      /Unexpected public export field|Invalid public export descriptor/);
  }
});
