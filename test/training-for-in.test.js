import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeDifferential} from './helpers/runtime-frontier.js';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';

test('for-in walks enumerable string keys with numeric order and prototype shadowing',()=>{
  runtimeDifferential('const p={z:1,2:2,a:3};const o=Object.create(p);o.b=4;o[1]=5;o.a=6;let keys=[];for(const k in o)keys.push(k);return keys;');
  runtimeDifferential('let gets=0;const p={x:1,y:2};const o=Object.create(p);Object.defineProperty(o,"x",{get(){gets++;return 3;},enumerable:false});o[Symbol.iterator]=()=>{throw 9;};let keys=[];for(const k in o)keys.push(k);return [keys,gets];');
  runtimeDifferential('let gets=0;const o={get x(){gets++;return 1;},[Symbol("hidden")]:2};let keys=[];for(const k in o)keys.push(k);return [keys,gets];');
  runtimeDifferential('let keys=[];const a=[,4,,6];a.extra=3;for(const k in a)keys.push(k);return keys;');
});
test('for-in coerces primitive sources without using the iterator protocol',()=>{
  runtimeDifferential('let out=[];for(const k in "A💡")out.push(k);for(const k in null)out.push(k);for(const k in undefined)out.push(k);for(const k in 3)out.push(k);for(const k in Symbol("x"))out.push(k);return out;');
  runtimeDifferential('let calls=0;const o={a:1,[Symbol.iterator](){calls++;throw 9;},return(){calls++;}};let out=[];for(const k in o){out.push(k);break;}return [out,calls];');
  runtimeDifferential('class C {x=1;m(){return 2;}static s=3;static f(){}}const a=new C();let own=[],stat=[];for(const k in a)own.push(k);for(const k in C)stat.push(k);return [own,stat];');
});
test('in converts an object property key only after validating its right operand',()=>{
  runtimeDifferential('let calls=0;let key={toString(){calls++;return "x";}};let found=key in {x:1};return [found,calls];');
  runtimeDifferential('let calls=0;let key={toString(){calls++;return "x";}};let name="";try{name=key in 1;}catch(e){name=e.name;}return [name,calls];');
});
test('HasProperty and deletion use the shared Promise property store',()=>{
  runtimeDifferential('const p=Promise.resolve(6);p.own=3;const a="then" in p;const b=Reflect.has(p,"own");const d=delete p.own;return [a,b,d,"own" in p];');
});
test('for-in lexical cells var bindings labels and finally retain their meanings',()=>{
  runtimeDifferential('let fs=[];for(let k in {a:1,b:2})fs.push(()=>k);return [fs[0](),fs[1]()];');
  runtimeDifferential('let fs=[];for(var k in {a:1,b:2})fs.push(()=>k);return [fs[0](),fs[1](),k];');
  runtimeDifferential('const k={a:1};try{for(let k in k){}}catch(e){return e.name;}');
  runtimeDifferential('let log=[];outer:for(const a in {x:1,y:2}){for(const b in {a:1,b:2}){try{log.push(a+b);continue outer;}finally{log.push("finally");}}}return log;');
  runtimeDifferential('let out=[];for(const {length:n} in {abc:1,de:2})out.push(n);return out;');
  runtimeDifferential('const o={a:1,b:2};let out=[];for(const k in o){o[k]+=3;out.push(o[k]);}return out;');
});
test('for-in rechecks captured keys after mutation while ignoring later additions',()=>{
  runtimeDifferential('const o={a:1,b:2,c:3};let out=[];for(const k in o){out.push(k);if(k==="a"){delete o.b;o.d=4;}}return out;');
  runtimeDifferential('const p={a:1,b:2};const o=Object.create(p);o.x=1;let out=[];for(const k in o){out.push(k);if(k==="x"){delete o.x;o.y=2;}}return out;');
  runtimeDifferential('const p={x:1};const o={x:2};Object.setPrototypeOf(o,p);let out=[];for(const k in o){delete o.x;out.push(k);}return out;');
  runtimeDifferential('const o={a:1,toString:2};let out=[];for(const k in o){if(k==="a")delete o.toString;out.push(k);}return out;');
});
test('enumeration cursor is serialized independently and forged order is rejected',()=>{
  const source='"use strict";function run(){let keys=[];for(const key in {b:2,1:1,a:3})keys.push(key);return keys;}';
  const original=createRuntime().startEntry({text:source,functionName:'run'});
  while(!Object.values(original.state.heap).some(x=>x.kind==='enumerator'&&x.nextIndex===1))original.step();
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key])=>key!=='adapters'))));
  const restored=Object.assign(createRuntime(),snapshot);original.drive();restored.drive();
  assert.deepEqual(JSON.parse(JSON.stringify(original.exportRun())),JSON.parse(JSON.stringify(restored.exportRun())));
  const bundle=restored.exportRun();assert.equal(validateBundle(bundle).valid,true);
  const forged=structuredClone(bundle),event=forged.events.find(e=>e.stateChanges.some(p=>p.before===null&&p.after?.kind==='enumerator'));
  event.stateChanges.find(p=>p.after?.kind==='enumerator').after.keys.reverse();
  assert.throws(()=>validateBundle(forged),/lost key order/);
});
test('proxy enumeration requires its trap protocol',()=>{
  for(const body of ['for(const k in new Proxy({a:1},{})){}']){
    const runtime=createRuntime().startEntry({text:'"use strict";function run(){'+body+'}',functionName:'run'});
    assert.throws(()=>runtime.drive(),/For-in/);
  }
});

test('for-in retains V8 candidates when prototypes or enumerability change',()=>{
  runtimeDifferential('const p={b:3,c:4};const o=Object.create(p);o.a=1;o.b=2;const out=[];for(const k in o){out.push(k);if(k==="a")Object.setPrototypeOf(o,{b:8,c:9,newKey:10});}return out;');
  runtimeDifferential('const p={c:4};const o=Object.create(p);o.a=1;o.b=2;const out=[];for(const k in o){out.push(k);if(k==="a")Object.setPrototypeOf(o,null);}return out;');
  runtimeDifferential('const p={b:3,c:4};const o=Object.create(p);o.a=1;o.b=2;const out=[];for(const k in o){out.push(k);if(k==="a"){delete o.b;Object.defineProperty(p,"b",{enumerable:false});Object.defineProperty(p,"c",{enumerable:false});}}return out;');
});
