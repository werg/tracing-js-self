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

