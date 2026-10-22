import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { encode,decode } from '../src/values.js';
import { validateBundle, TraceValidationError } from '../src/validation.js';
import { causalPrefix } from '../src/causal.js';
const run=(source,options={})=>{const r=createRuntime(options).start(source);return {r,progress:r.drive()};};
const binding=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings)).find(([k])=>k===name)?.[1]?.token?.value;

test('scalar codec is exact for special numbers, bigint and lone surrogates',()=>{
  for(const x of [-0,NaN,Infinity,-Infinity,42,0n,9007199254740993n,'\ud800','a\u0000b',true,false,null,undefined]){
    assert.deepEqual(encode(decode(encode(x))),encode(x));
    if(typeof x==='number')assert(Object.is(decode(encode(x)),x));
  }
  assert.throws(()=>encode({a:1}),/guest identity/);
});

test('machine executes arithmetic, loops and repeated chronological writes',()=>{
  const {r,progress}=run('let total = 0; let i = 0; while(i < 3) { total += i; i += 1; }');
  assert.equal(progress.kind,'terminated');assert.deepEqual(binding(r,'total'),['num',3]);
  assert.equal(r.events.filter(e=>e.operation==='binding.write').length,6);
  assert.equal(validateBundle(r.exportRun()).valid,true);
});

test('function activation and lexical closure state are owned records',()=>{
  const {r}=run('let x = 7; function add(y){ return x + y; } let result = add(4);');
  assert.deepEqual(binding(r,'result'),['num',11]);
  assert(Object.keys(r.state.frames).length>=2);
  assert.equal(validateBundle(r.exportRun()).valid,true);
});

test('object identity, array lengths and history are preserved',()=>{
  const {r}=run('let obj = {a: 2}; let alias = obj; alias.b = 3; let answer = obj.a + obj.b; let arr = [4, 5];');
  assert.deepEqual(binding(r,'answer'),['num',5]);
  assert.deepEqual(binding(r,'alias'),binding(r,'obj'));
  const arr=r.state.heap[binding(r,'arr')[1]];
  assert.deepEqual(arr.properties.length.value,['num',2]);
  assert.equal(validateBundle(r.exportRun()).valid,true);
});

test('uninitialized bindings, unsupported grammar and native fallback fail closed',()=>{
  assert.throws(()=>run('let a = b; let b = 2;'),/before initialization/);
  assert.throws(()=>run('eval("2 + 2");'),/not defined/);
  assert.throws(()=>run('let x = () => 42;'),SyntaxError);
  assert.throws(()=>run('let o = {__proto__: {}};'),/not implemented/);
  assert.throws(()=>run('let a={}; a.__proto__=1;'),/not implemented/);
});

test('synchronous host return stays blocked until an explicitly delivered input',()=>{
  const {r,progress}=run('host.readNumber("offset"); let after = 1;');
  assert.equal(progress.kind,'waiting');assert.equal(binding(r,'after'),undefined);
  const id=Object.values(r.state.effects)[0].id;
  const arrival=r.recordInputArrival({effectId:id,kind:'immediate',value:9});
  assert.equal(binding(r,'after'),undefined,'host arrival cannot resume a blocked frame');
  r.deliverInput(arrival.inputId);assert.equal(r.drive().kind,'terminated');
  assert.deepEqual(binding(r,'after'),['num',1]);
  assert.equal(r.chunks.length,2);assert.equal(validateBundle(r.exportRun()).valid,true);
  assert.throws(()=>r.deliverInput(arrival.inputId),/not available/);
});

test('async host input B precedes A while awaits preserve A then B consumption',()=>{
  const source=`async function work() { const a = host.readAsync('A'); const b = host.readAsync('B');
    const bias = await Promise.resolve(5); const av = await a; const bv = await b;
    host.store('sum', av + bv + bias); } work();`;
  let calls=0;
  const {r,progress}=run(source,{adapters:{'demo.store':()=>{calls++;return {kind:'normal',value:undefined};}}});
  assert.equal(progress.kind,'waiting');
  const [a,b]=Object.values(r.state.effects);
  assert.equal(r.chunks.length,1);assert.equal(r.chunks[0].exit.pendingEffects.length,2);
  assert(r.events.some(e=>e.operation==='async.await'));assert(r.events.some(e=>e.operation==='job.enter'));
  const inputB=r.recordInputArrival({effectId:b.id,kind:'completion',value:20});
  const beforeB=causalPrefix(r.exportRun(),{throughEventId:r.events.at(-1).eventId});
  assert.equal(JSON.stringify(beforeB).includes('\"num\",20]'),false,'private arrived input cannot appear in causal prefix');
  r.deliverInput(inputB.inputId);assert.equal(r.drive().kind,'waiting');
  const inputA=r.recordInputArrival({effectId:a.id,kind:'completion',value:10});r.deliverInput(inputA.inputId);
  assert.equal(r.drive().kind,'terminated');
  assert.equal(calls,1);assert.equal(r.chunks.length,3);
  assert.equal(r.state.effects[Object.keys(r.state.effects)[2]].args[1][1],35);
  assert.equal(validateBundle(r.exportRun()).valid,true);
});

test('causal prefixes are identical for different withheld future input payloads',()=>{
  const prefix=(bValue)=>{
    const {r}=run('async function f(){ const a = host.readAsync("A"); const b = host.readAsync("B"); let x = await a; let y = await b; } f();');
    const b=Object.values(r.state.effects)[1];r.recordInputArrival({effectId:b.id,kind:'completion',value:bValue});
    return causalPrefix(r.exportRun(),{throughEventId:r.events.at(-1).eventId});
  };
  assert.deepEqual(prefix(20),prefix(70000));
});

test('independent reconstruction rejects corrupted patch and missing catalog identity',()=>{
  const {r}=run('let x = 1; x += 2;');const bundle=r.exportRun();
  const mutation=bundle.events.find(e=>e.stateChanges.some(p=>p.table==='envs'&&p.before));
  const patch=mutation.stateChanges.find(p=>p.table==='envs'&&p.before);
  patch.before.version=200;
  assert.throws(()=>validateBundle(bundle),TraceValidationError);
  const changed=r.exportRun();changed.events[0].catalogRef='number.add/999';
  assert.throws(()=>validateBundle(changed),/catalog/);
});

test('native host effects dispatch exactly once and are not replayed by reconstruction',()=>{
  let writes=0;
  const {r}=run('host.store("x", 1); host.store("y", 2);',{adapters:{'demo.store':()=>{writes++;return {kind:'normal',value:undefined};}}});
  const bundle=r.exportRun();assert.equal(writes,2);
  validateBundle(bundle);assert.equal(writes,2);
  assert.equal(bundle.events.filter(e=>e.operation==='effect.dispatch').length,2);
});

test('async adapter native promises are rejected rather than delivering guest work opaquely',()=>{
  const {r}=run('host.readAsync("A");');
  assert.equal(r.chunks.length,1);
  assert.throws(()=>run('host.store("x", 1);',{adapters:{'demo.store':()=>Promise.resolve(1)}}),/native promises/);
});
