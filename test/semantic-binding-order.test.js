import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedExecutionLifecycleV8} from '../src/semantic/lifecycle-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {stableAlgorithmJSON} from '../src/semantic/ir.js';
import {BINDING_ORDER_FIXTURES_V8} from '../fixtures/semantic-regions/binding-order.js';

const copy=structuredClone;
function reverseKeys(value){
  if(Array.isArray(value))return value.map(reverseKeys);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])]));
  return value;
}
function ready(Core,fixture){
  const harness=new Core({sessionId:'binding-order'});
  harness.publishProgram({programId:'p',source:fixture.source,entry:fixture.entry});
  const request={programId:'p',invocationId:'call',trackId:'worker',realmId:'realm',triggerId:'outside',
    args:copy(fixture.args),bindings:copy(fixture.bindings)};
  return {harness,request};
}
function assertBindings(harness,aliases,values){
  const controller=harness.invocations.get('call').controller;
  assert.deepEqual([...controller.captureAliases],aliases);
  assert.deepEqual(aliases.map(([,cell])=>controller.locals.get(cell)),values);
}
function reseal(packet){const {integrity,...body}=packet;return {...body,integrity:hashAlgorithmData(body)};}

for(const [name,Core]of [['v6',SelectedExecutionHarness],['v8',SelectedExecutionLifecycleV8]]){
  for(const fixture of BINDING_ORDER_FIXTURES_V8)test(name+' '+fixture.id+' survives canonical recovery and reordered duplicate ingress',()=>{
    const {harness,request}=ready(Core,fixture),receipt=harness.admitInvocation(request);
    assertBindings(harness,fixture.expectedAliases,fixture.expectedValues);
    const packet=harness.checkpoint();
    assert.deepEqual(harness.admitInvocation(reverseKeys(request)),receipt);
    assert.deepEqual(harness.checkpoint(),packet,'an identical reordered delivery must not mutate state');
    for(const wire of [stableAlgorithmJSON(packet),JSON.stringify(reverseKeys(packet))]){
      const restored=Core.restore(JSON.parse(wire));
      assertBindings(restored,fixture.expectedAliases,fixture.expectedValues);
      assert.deepEqual(restored.checkpoint(),packet);
      assert.deepEqual(restored.admitInvocation(reverseKeys(request)),receipt);
      assert.deepEqual(restored.checkpoint(),packet);
      const changed=copy(request),binding=Object.keys(changed.bindings)[0];
      changed.bindings[binding]=1-changed.bindings[binding];
      assert.throws(()=>restored.admitInvocation(changed),/Conflicting duplicate invocation payload/);
      assert.deepEqual(restored.checkpoint(),packet,'a conflicting duplicate must not mutate state');
      restored.selected('call',Core.encodeRecord('return',{value:['num',fixture.declaredParameters.length?5:7]}));
      restored.selected('call',Core.encodeRecord('end',{kind:'return'}));
      const replay=Core.replay(JSON.parse(stableAlgorithmJSON(restored.exportEpisode())));
      assertBindings(replay,fixture.expectedAliases,fixture.expectedValues);
    }
    const changed=copy(packet);
    changed.invocations[0][1].controller.captureAliases.reverse();
    assert.throws(()=>Core.restore(reseal(changed)),/contradicts committed public history/,
      'a fresh checksum must not authorize a private alias-order change');
  });

  test(name+' source parameter overrides keep source positions while extras append deterministically',()=>{
    const fixture={source:'"use strict";function run(z,a){return z-a;}',entry:'run',args:[9,4],
      bindings:{b:0,a:0,z:1}}, {harness,request}=ready(Core,fixture);
    harness.admitInvocation(request);
    const aliases=[['z','a0b0'],['a','a0b1'],['b','a0b2']],values=[['num',4],['num',9],['num',9]];
    assertBindings(harness,aliases,values);
    assertBindings(Core.restore(JSON.parse(stableAlgorithmJSON(harness.checkpoint()))),aliases,values);
  });

  test(name+' an ordinary __proto__ parameter remains an own lexical binding',()=>{
    const fixture={source:'"use strict";function run(__proto__,z){return __proto__-z;}',entry:'run',
      args:[9,4],bindings:Object.fromEntries([['z',1],['__proto__',0]])}, {harness,request}=ready(Core,fixture);
    harness.admitInvocation(request);
    const aliases=[['__proto__','a0b0'],['z','a0b1']],values=[['num',9],['num',4]];
    assertBindings(harness,aliases,values);
    assertBindings(Core.restore(JSON.parse(stableAlgorithmJSON(harness.checkpoint()))),aliases,values);
  });

  test(name+' invalid binding metadata is refused before changing public or private state',()=>{
    const {harness,request}=ready(Core,BINDING_ORDER_FIXTURES_V8[0]),before=harness.checkpoint();
    let reads=0;
    const accessor=Object.defineProperty({},'z',{enumerable:true,get(){reads++;return 0;}});
    const proxy=new Proxy({z:0},{ownKeys(){reads++;return ['z'];}});
    for(const bindings of [null,[],new Map([['z',0]]),accessor,proxy,{'':0},{z:-1},{z:2},{z:0.5},{z:NaN}]){
      assert.throws(()=>harness.admitInvocation({...request,bindings}));
      assert.deepEqual(harness.checkpoint(),before);
    }
    assert.equal(reads,0,'binding metadata must be inspected without invoking accessors or proxy traps');
    harness.admitInvocation(request);
    assertBindings(harness,BINDING_ORDER_FIXTURES_V8[0].expectedAliases,BINDING_ORDER_FIXTURES_V8[0].expectedValues);
  });

  test(name+' direct controller object and ordered Map options retain the same aliases and values',()=>{
    const source='"use strict";function run(z,a){return z-a;}';
    const h=new Core();h.publishProgram({programId:'p',source,entry:'run'});
    const context=[h.programs.get('p').code,Core.encodeRecord('input',{graph:{roots:[],objects:[]}})],
      initialBindings={z:['num',9],a:['num',4]},captureAliases={z:'zcell',a:'acell'};
    const object=new Core.Controller(context,{initialBindings,captureAliases}),
      mapped=new Core.Controller(context,{initialBindings:new Map(Object.entries(initialBindings)),
        captureAliases:new Map(Object.entries(captureAliases))});
    assert.deepEqual(mapped.segmentPacket(),object.segmentPacket());
    assert.deepEqual([...object.captureAliases],[['z','zcell'],['a','acell']]);
    assert.deepEqual([...object.locals],[['zcell',['num',9]],['acell',['num',4]]]);
  });
}

test('published binding-order interoperability cases preserve all contexts across canonical replay and recovery',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/semantic-binding-order-v8.json',import.meta.url),'utf8'));
  assert.equal(fixture.schema,'semantic-binding-order-interoperability/1');
  assert.deepEqual(fixture.cases.map(row=>row.id),BINDING_ORDER_FIXTURES_V8.map(row=>row.id));
  for(const row of fixture.cases){
    for(const artifact of [row.artifact,JSON.parse(stableAlgorithmJSON(row.artifact)),reverseKeys(row.artifact)]){
      const replay=RegionExecutionHarness.replay(artifact),
        restored=RegionExecutionHarness.restore(JSON.parse(stableAlgorithmJSON(replay.checkpoint())));
      assert.deepEqual(restored.exportEpisode(),row.artifact.public);
      assert.deepEqual([...restored.controller.captureAliases],row.initialState.aliases);
      const h=new RegionExecutionHarness({sessionId:artifact.public.timeline[0].fields.session,automaticDelivery:false,now:()=>-Infinity}),contexts=[];
      for(const record of artifact.public.timeline){
        if(record.mode==='observed')h.importObserved(record);
        else{
          contexts.push(h.modelContext(record.fields.invocationId));
          h.select(record.fields.invocationId,record.fields.line);
        }
      }
      assert.deepEqual(contexts,artifact.contexts);
    }
  }
});
