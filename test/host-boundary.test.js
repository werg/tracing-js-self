import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/runtime.js';
import {validateBundle} from '../src/validation.js';
import {validateHostJournal} from '../src/host-journal.js';
import {replayExact} from '../src/replay.js';
import {causalPrefix} from '../src/causal.js';

test('host request is JSON materialized before dispatch, immutable, and never re-executed in replay',()=>{
  const calls=[];
  const runtime=createRuntime({adapters:{
    'demo.store':({effectId,operation,args,request})=>{
      assert.equal(operation,'demo.store');
      assert.equal(typeof effectId,'string');
      assert.deepEqual(args,['item',{score:1,nested:[true,null,'x']}]);
      assert(Object.isFrozen(args) && Object.isFrozen(args[1]) &&
        Object.isFrozen(args[1].nested),'adapter receives immutable materialized data');
      assert.equal(request.schema,'host-request/1');
      assert.equal(request.signature,'demo.store/1');
      assert.equal(request.codec,'canonical-json/1');
      assert.equal(request.payload,'["item",{"score":1,"nested":[true,null,"x"]}]');
      calls.push(request.payload);
      return {kind:'normal',value:undefined};
    }
  }}).start('let x={score:1,nested:[true,null,"x"]};host.store("item",x);x.score=99;');
  assert.equal(runtime.drive().kind,'terminated');
  const wire=Object.values(runtime.state.effects)[0].request;
  assert.equal(wire.payload,'["item",{"score":1,"nested":[true,null,"x"]}]');
  assert.equal(wire.graphVersions.length,2);
  assert.equal(wire.graphVersions[0].properties.score,1);
  assert.deepEqual(calls,[wire.payload]);
  const bundle=runtime.exportRun();
  assert(validateBundle(bundle).valid);
  assert(replayExact(bundle).valid);
  assert.deepEqual(calls,[wire.payload],'replay cannot invoke an external adapter');
  const causal=causalPrefix(bundle);
  const outgoing=causal.events.find(e=>e.outgoing)?.outgoing[0];
  assert.equal(outgoing.payload,wire.payload);
  assert.equal(outgoing.codec,'canonical-json/1');
  assert.equal(outgoing.signature,'demo.store/1');
  assert.equal(causal.events.some(e=>e.operation==='external.input.arrive'),false);
});

test('independent host journal verifier detects altered materialization despite valid effect metadata',()=>{
  const runtime=createRuntime({adapters:{
    'demo.store':()=>({kind:'normal',value:undefined})
  }}).start('let x={n:2};host.store("x",x);');
  assert.equal(runtime.drive().kind,'terminated');
  const archive=runtime.exportRun();
  const call=archive.events.find(e=>e.operation==='call.enter' &&
    e.stateChanges.some(p=>p.table==='effects'&&p.before===null));
  const effect=call.stateChanges.find(p=>p.table==='effects').after;
  effect.request.payload='["x",{"n":9}]';
  assert.throws(
    ()=>validateHostJournal(archive,(message)=>{throw new Error(message);}),
    /materialized bytes differ from committed argument graph/
  );
});

test('unregistered external argument forms fail before creating or dispatching any effect',()=>{
  const code=[
    'host.store("k",undefined);',
    'host.store("k",-0);',
    'host.store("k",NaN);',
    'let a={};a.self=a;host.store("k",a);',
    'let a={x:1};host.store("k",[a,a]);',
    'host.readAsync(3);',
    'host.store("k");'
  ];
  for(const source of code){
    let dispatched=0;
    const runtime=createRuntime({adapters:{
      'demo.store':()=>{dispatched++;return {kind:'normal',value:undefined};},
      'demo.readAsync':()=>{dispatched++;return {kind:'pending'};}
    }}).start(source);
    assert.throws(()=>runtime.drive(),/codec|argument|string|number|cycle|alias|JSON|not defined/i,source);
    assert.equal(Object.keys(runtime.state.effects).length,0,source);
    assert.equal(dispatched,0,source);
    assert.equal(runtime.events.filter(e=>e.operation==='effect.dispatch').length,0);
  }
});

test('external method contracts prevent extra or mistyped arguments',()=>{
  for(const code of [
    'host.readNumber("x",1);',
    'host.readAsync();',
    'host.store(5,1);'
  ]){
    const runtime=createRuntime().start(code);
    assert.throws(()=>runtime.drive(),/expects|operation key/);
    assert.equal(Object.keys(runtime.state.effects).length,0);
  }
});
