import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

const value=(runtime,name)=>Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
  .find(([key])=>key===name)?.[1]?.token?.value;

function execute(source){
  const runtime=createRuntime().start(source);
  assert.equal(runtime.drive().kind,'terminated');
  const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return runtime;
}

test('Reflect.has observes ordinary own and inherited properties like the native runtime',()=>{
  const source=`let proto={inherited:1};let object=Object.create(proto);object.own=2;
    let own=Reflect.has(object,'own');let inherited=Reflect.has(object,'inherited');
    let absent=Reflect.has(object,'absent');let nullPrototype=Reflect.has(Object.create(null),'toString');
    [own,inherited,absent,nullPrototype].join(',');`;
  const expected=vm.runInNewContext(source);
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'own'),['bool',true]);
  assert.deepEqual(value(runtime,'inherited'),['bool',true]);
  assert.deepEqual(value(runtime,'absent'),['bool',false]);
  assert.deepEqual(value(runtime,'nullPrototype'),['bool',false]);
  assert.equal(expected,'true,true,false,false');
});

test('Reflect.has rejects a primitive target before property-key conversion',()=>{
  const source=`let error='';try{Reflect.has(1,Symbol('x'));}catch(e){error=e.name;}error;`;
  const expected=vm.runInNewContext(source);
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'error'),['str','TypeError']);
  assert.equal(expected,'TypeError');
});

test('delete and Reflect.deleteProperty honor configurable own descriptors',()=>{
  const source=`let object={gone:1,stay:2};Object.defineProperty(object,'stay',{configurable:false});
    let first=delete object.gone;let missing=delete object.gone;
    let blocked=Reflect.deleteProperty(object,'stay');let inherited=delete object.toString;
    [first,missing,blocked,inherited,Object.hasOwn(object,'gone'),Object.hasOwn(object,'stay')].join(',');`;
  const expected=vm.runInNewContext(source);
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'first'),['bool',true]);
  assert.deepEqual(value(runtime,'missing'),['bool',true]);
  assert.deepEqual(value(runtime,'blocked'),['bool',false]);
  assert.deepEqual(value(runtime,'inherited'),['bool',true]);
  assert.equal(expected,'true,true,false,true,false,true');
  const gone=runtime.events.find(event=>event.operation==='property.delete'&&event.readObservations?.[0]?.key==='gone');
  assert.deepEqual(gone.readObservations[0].value,['num',1]);
  assert.equal(gone.readObservations[0].version,1);
  assert.equal(gone.readObservations[0].supplyingEvent,runtime.events.find(event=>event.operation==='property.write'&&event.operands?.[1]?.[1]==='gone')?.eventId);
  const forged=JSON.parse(JSON.stringify(runtime.exportRun())),deletion=forged.events.find(event=>event.operation==='property.delete'&&event.result?.[1]===true);
  assert(deletion);
  const objectChange=deletion.stateChanges.find(change=>change.table==='heap'&&change.before?.properties?.gone);
  assert(objectChange);
  objectChange.after.properties.gone=structuredClone(objectChange.before.properties.gone);
  assert.throws(()=>validateBundle(forged),/property deletion/i);
});

test('Reflect.deleteProperty supports omitted and extra property-key arguments',()=>{
  const source=`let object={undefined:1,x:2};let omitted=Reflect.deleteProperty(object);
    let extra=Reflect.deleteProperty(object,'x','ignored');[omitted,extra,Object.hasOwn(object,'undefined'),Object.hasOwn(object,'x')].join(',');`;
  const expected=vm.runInNewContext(source);
  const runtime=execute(source);
  assert.equal(expected,'true,true,false,false');
  assert.deepEqual(value(runtime,'omitted'),['bool',true]);
  assert.deepEqual(value(runtime,'extra'),['bool',true]);
  const aliasSource=`let object={x:1};let remove=Reflect.deleteProperty;let removed=remove(object,'x');removed;`;
  const aliasRuntime=execute(aliasSource);
  assert.deepEqual(value(aliasRuntime,'removed'),['bool',true]);
});

test('delete converts null and undefined keys to ordinary property names',()=>{
  const source=`let object={null:1,undefined:2};let a=delete object[null];let b=delete object[undefined];
    [a,b,Object.hasOwn(object,'null'),Object.hasOwn(object,'undefined')].join(',');`;
  assert.equal(vm.runInNewContext(source),'true,true,false,false');
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'a'),['bool',true]);
  assert.deepEqual(value(runtime,'b'),['bool',true]);
});

test('Reflect.deleteProperty rejects primitive targets as catchable TypeErrors',()=>{
  const source=`let error='';try{Reflect.deleteProperty(1,'x');}catch(e){error=e.name;}error;`;
  assert.equal(vm.runInNewContext(source),'TypeError');
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'error'),['str','TypeError']);
});

test('Reflect operations validate targets before an object key and deletion authenticates error identity',()=>{
  const source=`let calls=0;function keyText(){calls=calls+1;return 'x';}let key={toString:keyText};key[Symbol.toPrimitive]=keyText;
    let error='';let missing='';let hasError='';
    try{Reflect.deleteProperty(1,key);}catch(e){error=e.name;}
    try{Reflect.deleteProperty();}catch(e){missing=e.name;}
    try{Reflect.has(1,key);}catch(e){hasError=e.name;}
    [error,missing,hasError,calls].join(',');`;
  assert.equal(vm.runInNewContext(source),'TypeError,TypeError,TypeError,0');
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'calls'),['num',0]);
  for(const mutate of [
    event=>{event.completion.value.value=['ref','forged'];},
    event=>{event.completion.message='forged';},
    event=>{event.stateChanges.find(change=>change.after?.declaredError==='TypeError').after.declaredError='RangeError';}
  ]){
    const forged=JSON.parse(JSON.stringify(runtime.exportRun()));
    mutate(forged.events.find(event=>event.completion?.errorType==='TypeError'));
    assert.throws(()=>validateBundle(forged),/property deletion.*TypeError/i);
  }
});

test('deletion keeps escaped string keys separate from Symbol identities',()=>{
  const source=String.raw`let object={};let key="\u0000symbol:well-known:iterator";
    object[key]=7;object[Symbol.iterator]=9;let removed=delete object[key];
    let retained=object[Symbol.iterator];[removed,retained].join(',');`;
  assert.equal(vm.runInNewContext(source),'true,9');
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'removed'),['bool',true]);
  assert.deepEqual(value(runtime,'retained'),['num',9]);
});

test('no-op deletion rejects unrelated mutation and a forged non-strict throw',()=>{
  const runtime=execute('let other={x:1};let object={};Object.defineProperty(object,"fixed",{value:1});let removed=delete object.fixed;');
  const original=runtime.exportRun(),selected=original.events.find(event=>event.operation==='property.delete');
  for(const mutate of [
    event=>{event.completion={type:'throw',errorType:'TypeError'};},
    event=>{event.stateChanges.push({table:'heap',id:'unrelated',before:null,after:{kind:'object'}});}
  ]){
    const forged=JSON.parse(JSON.stringify(original));mutate(forged.events.find(event=>event.eventId===selected.eventId));
    assert.throws(()=>validateBundle(forged),/property deletion/i);
  }
});

test('virtual function name and length deletion stops before reporting a false result',()=>{
  const runtime=createRuntime().start('function f(){};delete f.name;');
  assert.throws(()=>runtime.drive(),/Function name\/length deletion requires owned function-property storage/);
  const absent=execute('function f(){};let removed=delete f.missing;');
  assert.deepEqual(value(absent,'removed'),['bool',true]);
  const prototype=createRuntime().start('function f(){};let value=f.prototype;let removed=delete f.prototype;');
  assert.equal(prototype.drive().kind,'terminated');
  assert.deepEqual(value(prototype,'removed'),['bool',false]);
});

test('delete retains strict failures and boxed-string exotic indices',()=>{
  const source=`let stringIndex=delete 'cat'[0];stringIndex;`;
  const runtime=execute(source);
  assert.deepEqual(value(runtime,'stringIndex'),['bool',false]);
  assert.equal(vm.runInNewContext(source),false);
  const strict=`"use strict";let object={};Object.defineProperty(object,'fixed',{configurable:false});
    let error='';try{delete object.fixed;}catch(e){error=e.name;}error;`;
  const strictRuntime=execute(strict);
  assert.deepEqual(value(strictRuntime,'error'),['str','TypeError']);
  assert.equal(vm.runInNewContext(strict),'TypeError');
});

