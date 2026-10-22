import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.js';
import { validateBundle } from '../src/validation.js';
import { replayExact } from '../src/replay.js';

const wire=x=>JSON.parse(JSON.stringify(x));
const binding=(runtime,name)=>Object.values(runtime.state.envs)
  .flatMap(e=>Object.entries(e.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;
const check=(runtime,kind='terminated')=>{
  assert.equal(runtime.drive().kind,kind);
  const bundle=wire(runtime.exportRun());
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return bundle;
};
const run=(source)=>{const runtime=createRuntime().start(source);check(runtime);return runtime;};

test('explicit primitive throw is caught without terminating; catch binding stays lexical',()=>{
  const runtime=run('let output=0; try {throw 7;} catch (e) {output=e+2;}');
  assert.deepEqual(binding(runtime,'output'),['num',9]);
  assert.equal(runtime.state.control.a0.failure,undefined);
  assert(runtime.events.some(e=>e.operation==='completion.catch.bind'));
  assert(runtime.events.some(e=>e.operation==='completion.throw'));
  assert.throws(()=>createRuntime().start('try {}'),/catch or finally/);
  assert.throws(()=>createRuntime().start('break;').drive(),/outside loop/);
  assert.throws(()=>createRuntime().start('continue;').drive(),/outside loop/);
  assert.throws(()=>createRuntime().start('try {throw 1;} catch(e) {let e=3;}'),/Duplicate catch/);
});

test('unwind through a synchronous call and retain identity of thrown guest object',()=>{
  const runtime=run('function fail(){let object={x:13};throw object;} let value=0;'+
    'try {fail();value=99;} catch (e) {value=e.x;}');
  assert.deepEqual(binding(runtime,'value'),['num',13]);
  assert(Object.values(runtime.state.frames).some(f=>f.status==='thrown'));
});

test('normal, exceptional and return completions execute finally exactly once',()=>{
  const runtime=run(`let count=0;let total=0;
    try {total=1;} finally {count+=1;}
    try {throw 4;} catch(e) {total+=e;} finally {count+=1;}
    function calculate(){
      try {return 3;} finally {count+=1;}
    }
    total+=calculate();`);
  assert.deepEqual(binding(runtime,'total'),['num',8]);
  assert.deepEqual(binding(runtime,'count'),['num',3]);
});

test('finally completion overrides pending return; outer handler catches throws',()=>{
  const runtime=run(`function change(){try{return 2;}finally{return 9;}}
    function fail(){try{return 4;}finally{throw "from-finally";}}
    let first=change(),second='';
    try {fail();}catch(e){second=e;}`);
  assert.deepEqual(binding(runtime,'first'),['num',9]);
  assert.deepEqual(binding(runtime,'second'),['str','from-finally']);
});

test('rethrow from catch executes finally before the outer catch',()=>{
  const runtime=run(`let value='';try{
    try{throw 'A';}catch(e){throw e+'B';}finally{value='finally';}
  }catch(e){value=value+':'+e;}`);
  assert.deepEqual(binding(runtime,'value'),['str','finally:AB']);
  const optional=run('let v=0;try{throw 3;}catch{v=5;}');
  assert.deepEqual(binding(optional,'v'),['num',5]);
});

test('break and continue restore lexical scopes and respect nested finally boundaries',()=>{
  const runtime=run(`let i=0;let count=0;let seq='';
    while(i<5){
      i+=1;
      try {
        if(i===2)continue;
        if(i===4)break;
        seq=seq+i;
      }finally{count+=1;}
    }
    let outer=0;
    try{while(outer<3){outer+=1;break;}count+=10;}finally{count+=100;}`);
  assert.deepEqual(binding(runtime,'i'),['num',4]);
  assert.deepEqual(binding(runtime,'seq'),['str','13']);
  assert.deepEqual(binding(runtime,'count'),['num',114]);
});

test('owned arithmetic TypeError/RangeError are catchable guest data errors',()=>{
  const runtime=run(`let name='', message='', other='';
    try{let x=1n+2;}catch(e){name=e.name;message=e.message;}
    try{let y=7n/0n;}catch(e){other=e.name;}`);
  assert.deepEqual(binding(runtime,'name'),['str','TypeError']);
  assert.deepEqual(binding(runtime,'message'),['str','Cannot mix BigInt and Number in arithmetic']);
  assert.deepEqual(binding(runtime,'other'),['str','RangeError']);
  const completions=runtime.events.filter(e=>e.operation==='spec.operation.complete');
  assert.equal(completions.filter(e=>e.completion?.type==='throw').length,2);
});

test('synchronous host failures become catchable only on input delivery',()=>{
  const runtime=createRuntime().start(`let result='unseen';
    try {host.readNumber('x');result='missed';}
    catch(e){result=e;}`);
  assert.equal(runtime.drive().kind,'waiting');
  const effect=Object.values(runtime.state.effects)[0];
  const arrived=runtime.recordInputArrival({effectId:effect.id,kind:'immediate',value:'failure',abrupt:true});
  assert.deepEqual(binding(runtime,'result'),['str','unseen']);
  runtime.deliverInput(arrived.inputId);
  check(runtime);
  assert.deepEqual(binding(runtime,'result'),['str','failure']);
});

test('unhandled throws and unsupported coercions keep distinct terminal outcomes',()=>{
  const r=createRuntime().start('try {throw 1;} finally {let a=2;}');
  const bundle=check(r,'runtime.failure');
  assert.equal(bundle.finalState.control.a0.failure.completion.type,'throw');
  const unsupported=createRuntime().start('try {let o={};let v=o+1;}catch(e){host.store("bad",2);}');
  check(unsupported,'unsupported');
  assert.equal(Object.keys(unsupported.state.effects).length,0);
});

test('structural checks and same-interpreter replay reject forged caught completions',()=>{
  const r=run('let v=0;try{throw 11;}catch(e){v=e;}');
  const b=wire(r.exportRun());
  const throwing=b.events.find(e=>e.operation==='completion.throw');
  throwing.completion.value.value=['num',12];
  assert.throws(()=>validateBundle(b),/provenance/);
});
