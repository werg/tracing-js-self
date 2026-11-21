import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

function run(source,{async=false}={}){
  const runtime=createRuntime();
  const names=['assert.js','sta.js',...(async?['doneprintHandle.js']:[])];
  const sources=names.map(name=>runtime.registerSource({
    text:readFileSync(new URL('../fixtures/test262-harness/'+name,import.meta.url),'utf8'),
    url:'harness/'+name,scriptProfile:true}));
  sources.push(runtime.registerSource({text:source,url:'test/control.js',scriptProfile:true}));
  runtime.startScriptSequence(sources);
  const exit=runtime.drive(),bundle=runtime.exportRun();
  assert.equal(validateBundle(bundle).valid,true);assert.equal(replayExact(bundle).valid,true);
  return {exit,bundle};
}

test('original assert.throws observes declared owned error constructor identity',()=>{
  const good=run('assert.throws(TypeError,function(){throw new TypeError("bad");});'+
    'assert.throws(ReferenceError,function(){return missingName;});'+
    'assert.throws(RangeError,function(){throw RangeError("bad");});'+
    'assert.sameValue(typeof URIError,"function");');
  assert.equal(good.exit.kind,'terminated');
  for(const source of ['assert.throws(TypeError,function(){throw new RangeError("bad");});',
    'assert.throws(TypeError,function(){});'])
    assert.equal(run(source).exit.kind,'runtime.failure');
  const forged=structuredClone(good.bundle);
  const read=forged.events.find(event=>event.operation==='property.read'&&event.operands[1]?.[1]==='constructor'&&event.result?.[0]==='intrinsic');
  read.result=['intrinsic','RangeError'];
  assert.throws(()=>validateBundle(forged),/observation result changed/);
});

test('ordinary in checks owned descriptor presence, prototype ancestry and symbols without invoking accessors',()=>{
  const {exit}=run('var calls=0;var parent={present:undefined};var value=Object.create(parent);'+
    'Object.defineProperty(value,"getter",{get:function(){calls++;return 1;}});'+
    'var key=Symbol("key");value[key]=undefined;'+
    'assert.sameValue("present" in value,true);assert.sameValue("getter" in value,true);'+
    'assert.sameValue(key in value,true);assert.sameValue("missing" in value,false);'+
    'assert.sameValue("toString" in value,true);assert.sameValue("missing" in Object.create(null),false);'+
    'assert.sameValue(calls,0);assert.throws(TypeError,function(){return "x" in 1;});');
  assert.equal(exit.kind,'terminated');
  const valid=run('var value={x:1};assert.sameValue("x" in value,true);').bundle;
  const forged=structuredClone(valid);
  forged.events.find(event=>event.operation==='primitive.binary'&&event.operands[0]?.[1]==='x').result=['bool',false];
  assert.throws(()=>validateBundle(forged),/observation result changed/);
  assert.throws(()=>run('var proxy=new Proxy({x:1},{});"x" in proxy;'),/Unsupported ordinary in-operator/);
});

test('original async harness records owned print after Promise reaction jobs and rejects forged output',()=>{
  const success=run('Promise.resolve(7).then(function(value){assert.sameValue(value,7);$DONE();});',{async:true});
  assert.equal(success.exit.kind,'terminated');
  assert.deepEqual(success.bundle.finalState.control.a0.test262Output.map(item=>item.value),
    [['str','Test262:AsyncTestComplete']]);
  const failure=run('$DONE(new Error("bad"));',{async:true});
  assert.deepEqual(failure.bundle.finalState.control.a0.test262Output.map(item=>item.value),
    [['str','Test262:AsyncTestFailure:Error: bad']]);
  const forged=structuredClone(success.bundle);
  const print=forged.events.find(event=>event.operation==='call.enter'&&event.operands[0]?.[1]==='print');
  print.stateChanges.find(patch=>patch.table==='control').after.test262Output[0].value=['str','forged'];
  assert.throws(()=>validateBundle(forged),/print output or frame transition/);
});
