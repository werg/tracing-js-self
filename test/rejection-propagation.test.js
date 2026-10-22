import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { validateBundle } from '../src/validation.js';
import { replayExact } from '../src/replay.js';

const wire=x=>JSON.parse(JSON.stringify(x));
function value(r,name){
  return Object.values(r.state.envs).flatMap(e=>Object.entries(e.bindings))
    .find(([k])=>k===name)?.[1]?.token?.value;
}
function verify(r,kind='terminated'){
  assert.equal(r.drive().kind,kind);
  const b=wire(r.exportRun());
  assert.equal(validateBundle(b).valid,true);
  assert.equal(replayExact(b).valid,true);
  return b;
}

test('await of explicitly rejected promise routes into catch then finally',()=>{
  const r=createRuntime().start(`let result='';let count=0;
    async function work(){try {await Promise.reject('no');result='missed';}
      catch(e){result=e;}finally{count+=1;}}
    work();`);
  const b=verify(r);
  assert.deepEqual(value(r,'result'),['str','no']);
  assert.deepEqual(value(r,'count'),['num',1]);
  assert(b.events.some(e=>e.operation==='job.enter'&&e.completion?.type==='throw'));
});

test('async throw before first await is rejected, not thrown into synchronous caller',()=>{
  const r=createRuntime().start(`let before=0;let result='';
    async function failing(){throw 'async failure';}
    async function collecting(){try{await failing();}catch(e){result=e;}}
    collecting();before=1;`);
  verify(r);
  assert.deepEqual(value(r,'before'),['num',1]);
  assert.deepEqual(value(r,'result'),['str','async failure']);
  assert(Object.values(r.state.promises).some(p=>p.status==='rejected'));
});

test('adopting a rejected promise delivers its original rejection reason',()=>{
  const r=createRuntime().start(`let caught='';
    async function source(){throw 'reason';}
    async function adopt(){return source();}
    async function consumer(){try{await adopt();}catch(e){caught=e;}}
    consumer();`);
  verify(r);
  assert.deepEqual(value(r,'caught'),['str','reason']);
  assert(Object.values(r.state.promises).filter(p=>p.status==='rejected').length>=2);
});

test('host asynchronous rejection becomes guest-visible at delivery only',()=>{
  const r=createRuntime().start(`let caught='none';
    async function consumer(){try{await host.readAsync('A');}
      catch(e){caught=e;}}consumer();`);
  assert.equal(r.drive().kind,'waiting');
  const effect=Object.values(r.state.effects)[0];
  const arrival=r.recordInputArrival({effectId:effect.id,kind:'completion',value:'outside',abrupt:true});
  assert.deepEqual(value(r,'caught'),['str','none']);
  r.deliverInput(arrival.inputId);
  verify(r);
  assert.deepEqual(value(r,'caught'),['str','outside']);
});

test('implicit binding, invocation, property and array-length errors reach catch',()=>{
  const r=createRuntime().start(`let errors='';
    try{let x=missing;}catch(e){errors+=e.name+',';}
    try{const x=2;x=4;}catch(e){errors+=e.name+',';}
    try{let y=null;let z=y.name;}catch(e){errors+=e.name+',';}
    try{let a=[];a.length=-1;}catch(e){errors+=e.name+',';}
    try{let f=4;f();}catch(e){errors+=e.name;}`);
  const b=verify(r);
  assert.deepEqual(value(r,'errors'),['str','ReferenceError,TypeError,TypeError,RangeError,TypeError']);
  assert(b.events.filter(e=>e.completion?.errorType).length>=5);
});

test('uncaught async rejection without awaiting is not a synchronous agent crash',()=>{
  const r=createRuntime().start(`async function failed(){throw 7;}failed();let later=12;`);
  verify(r);
  assert.deepEqual(value(r,'later'),['num',12]);
  assert(Object.values(r.state.promises).some(p=>p.status==='rejected'));
});

test('forged awaited rejection metadata is independently rejected',()=>{
  const r=createRuntime().start(`async function f(){try{await Promise.reject('bad');}catch(e){}}f();`);
  const b=verify(r);
  const target=b.events.find(e=>e.operation==='job.enter'&&e.completion);
  assert(target);
  target.completion.value.value=['str','forged'];
  assert.throws(()=>validateBundle(b),/Awaited rejection/);
});
