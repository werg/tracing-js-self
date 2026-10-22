import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const value=(r,name)=>Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
  .find(([k])=>k===name)?.[1]?.token?.value;
const verify=(r,kind='terminated')=>{
  assert.equal(r.drive().kind,kind);
  const bundle=JSON.parse(JSON.stringify(r.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return bundle;
};
test('then reactions and await resume in FIFO subscription order',()=>{
  const r=createRuntime().start(`let order='';
    function a(x){order+='a';return x+1;}
    function c(x){order+='c';return x;}
    async function b(){await p;order+='b';}
    let p=Promise.resolve(1);let out=p.then(a);b();p.then(c);
    async function read(){let v=await out;order+=v;}read();`);
  const bundle=verify(r);
  assert.deepEqual(value(r,'order'),['str','abc2']);
  assert.equal(bundle.events.filter(x=>x.operation==='job.enter').length,4);
});
test('a thrown then handler rejects and finally preserves the original reason',()=>{
  const r=createRuntime().start(`let result='';
    function fail(x){throw 'fail';}
    function cleanup(){result+='cleanup:';return 99;}
    let p=Promise.resolve(2).then(fail).finally(cleanup);
    async function read(){try{await p;}catch(e){result+=e;}}read();`);
  const bundle=verify(r);
  assert.deepEqual(value(r,'result'),['str','cleanup:fail']);
  assert(Object.values(bundle.finalState.promises).some(x=>x.status==='rejected'));
});
test('non-callable handlers pass through and callable catch recovers',()=>{
  const r=createRuntime().start(`let result=0;
    function recover(x){return x+5;}
    let p=Promise.reject(7).then(null).catch(recover).finally(null);
    async function read(){result=await p;}read();`);
  verify(r);
  assert.deepEqual(value(r,'result'),['num',12]);
});
test('async then callback resolves through its owned inner guest promise',()=>{
  const r=createRuntime().start(`let result=0;
    async function twice(x){let v=await Promise.resolve(x+1);return v*2;}
    let p=Promise.resolve(4).then(twice);
    async function read(){result=await p;}read();`);
  verify(r);
  assert.deepEqual(value(r,'result'),['num',10]);
});
test('finally defers fulfillment until returned host-backed guest promise settles',()=>{
  const r=createRuntime().start(`let result='waiting';
    function after(){return host.readAsync('cleanup');}
    let p=Promise.resolve(5).finally(after);
    async function read(){result=await p;}read();`);
  assert.equal(r.drive().kind,'waiting');
  assert.deepEqual(value(r,'result'),['str','waiting']);
  const effect=Object.values(r.state.effects)[0];
  const input=r.recordInputArrival({effectId:effect.id,kind:'completion',value:11});
  assert.deepEqual(value(r,'result'),['str','waiting']);
  r.deliverInput(input.inputId);
  verify(r);
  assert.deepEqual(value(r,'result'),['num',5]);
});
test('returned self-reference rejects the derived promise with guest TypeError',()=>{
  const r=createRuntime().start(`let name='';
    function self(){return p;}
    let p=Promise.resolve(1).then(self);
    async function read(){try{await p;}catch(e){name=e.name;}}read();`);
  verify(r);
  assert.deepEqual(value(r,'name'),['str','TypeError']);
});
test('pending host promise queues callback only after public delivery',()=>{
  const r=createRuntime().start(`let result=0;
    function plus(x){return x+1;}
    let p=host.readAsync('pending').then(plus);
    async function read(){result=await p;}read();`);
  assert.equal(r.drive().kind,'waiting');
  const effect=Object.values(r.state.effects)[0];
  const input=r.recordInputArrival({effectId:effect.id,kind:'completion',value:41});
  assert.deepEqual(value(r,'result'),['num',0]);
  r.deliverInput(input.inputId);
  verify(r);
  assert.deepEqual(value(r,'result'),['num',42]);
});
test('forged reaction job order fails structural validation',()=>{
  const r=createRuntime().start(`function one(x){return x;}
    let p=Promise.resolve(3);p.then(one);p.then(one);`);
  const bundle=verify(r);
  const target=bundle.events.find(e=>e.operation==='job.enter');
  assert(target);
  const patch=target.stateChanges.find(p=>p.table==='control');
  assert(patch);
  patch.after.queue.unshift({kind:'await',frameId:'nonexistent',promiseId:'p1'});
  assert.throws(()=>validateBundle(bundle),/FIFO order|precondition|mismatch/);
});
