import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {compileExternalEffectsJS} from '../src/effect-javascript.js';

function archive(source){
  const run=createRuntime({adapters:{
    'demo.store':()=>({kind:'normal',value:undefined}),
    'demo.readNumber':()=>({kind:'normal',value:3})
  }}).start(source);
  assert.equal(run.drive().kind,'terminated');
  return run.exportRun();
}

test('emitted JavaScript is directly executable and repeats dispatch order and exact snapshots',()=>{
  const bundle=archive('let o={n:2};host.store("a",o);o.n=9;host.store("b",o);');
  const javascript=compileExternalEffectsJS(bundle);
  assert.equal(typeof javascript,'string');
  assert(!javascript.includes('host.store('));
  const received=[];
  new Function('effects',javascript)({
    'demo.store':(...args)=>received.push(args)
  });
  assert.deepEqual(received,[['a',{n:2}],['b',{n:9}]]);
});

test('effects are not invoked during compilation, nor if required capabilities are missing',()=>{
  const bundle=archive('host.store("a",1);host.readNumber("k");');
  const javascript=compileExternalEffectsJS(bundle);
  const received=[];
  assert.throws(()=>new Function('effects',javascript)({
    'demo.store':(...args)=>received.push(args)
  }),/Missing effect handler: demo.readNumber/);
  assert.deepEqual(received,[]);
  new Function('effects',javascript)({
    'demo.store':(...args)=>received.push(args),
    'demo.readNumber':(...args)=>received.push(args)
  });
  assert.deepEqual(received,[['a',1],['k']]);
});

test('empty effects return runnable JS and invalid host payloads are rejected',()=>{
  const clean=archive('let x=2+3;');
  assert.equal(new Function('effects',compileExternalEffectsJS(clean))({}),undefined);
  const corrupted=archive('host.store("a",1);');
  const call=corrupted.events.find(e=>e.operation==='call.enter'&&
    e.stateChanges.some(p=>p.table==='effects'&&p.before===null));
  call.stateChanges.find(p=>p.table==='effects').after.request.payload='["a",99]';
  assert.throws(()=>compileExternalEffectsJS(corrupted),/Host request|materialized|mismatch/);
});
