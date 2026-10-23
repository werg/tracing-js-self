import test from 'node:test';
import assert from 'node:assert/strict';
import {executeWithNativeServices} from 'tracing-js-self/native';
import {validateBundle,replayExact} from 'tracing-js-self';

test('native async service B arrives before A; the guest awaits its own order',async()=>{
  const stores=[];
  const {bundle,progress}=await executeWithNativeServices({
    text:`async function go(){let a=host.readAsync('A');let b=host.readAsync('B');
      let x=await a;let y=await b;host.store('sum',x+y);}go();`,
    services:{
      'demo.readAsync':({args})=>args[0]==='A'?
        new Promise(resolve=>setTimeout(()=>resolve(10),15)):Promise.resolve(20),
      'demo.store':({args})=>{stores.push(args);}
    }
  });
  assert.equal(progress.kind,'terminated');
  assert.deepEqual(stores,[['sum',30]]);
  const arrivals=bundle.events.filter(e=>e.operation==='external.input.arrive');
  const reads=Object.values(bundle.effects).filter(e=>e.operation==='demo.readAsync');
  assert.equal(arrivals.length,3);
  assert.equal(arrivals[0].causes.find(c=>c.kind==='effect').effectId,reads[1].id);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('native synchronous return stays blocked until journaled input delivery',async()=>{
  const stores=[];
  const {bundle,progress}=await executeWithNativeServices({
    text:'let x=host.readNumber("offset")+4;host.store("answer",x);',
    services:{'demo.readNumber':()=>8,'demo.store':({args})=>{stores.push(args);}}
  });
  assert.equal(progress.kind,'terminated');
  assert.deepEqual(stores,[['answer',12]]);
  assert.equal(bundle.events.filter(e=>e.operation==='external.input.arrive').length,2);
  assert.equal(bundle.events.filter(e=>e.operation==='external.input.deliver').length,2);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('native rejection reaches guest async catch and is not replayed natively',async()=>{
  const stores=[];
  const {bundle,progress}=await executeWithNativeServices({
    text:`async function run(){try{await host.readAsync('bad');}
      catch(e){host.store('error',e);}}run();`,
    services:{'demo.readAsync':async()=>{throw new Error('native-failed');},
      'demo.store':({args})=>{stores.push(args);}}
  });
  assert.equal(progress.kind,'terminated');
  assert.deepEqual(stores,[['error','native-failed']]);
  assert.equal(replayExact(bundle).valid,true);
});

test('native service driver refuses unknown operations and orphaned waits',async()=>{
  await assert.rejects(executeWithNativeServices({text:'host.readNumber("missing");'}),
    /without a registered native service/);
  await assert.rejects(executeWithNativeServices({text:'let x=1;',
    services:{'x.bad':()=>1}}),/Unregistered host operation/);
});

test('aborting a native wait does not fabricate a guest input',async()=>{
  const abort=new AbortController();
  const run=executeWithNativeServices({
    text:'host.readAsync("never");',
    services:{'demo.readAsync':()=>new Promise(()=>{})},
    signal:abort.signal
  });
  abort.abort(new Error('Abort requested'));
  await assert.rejects(run,/Abort requested/);
});
