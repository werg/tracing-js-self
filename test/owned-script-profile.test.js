import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRuntime} from '../src/runtime.js';
import {validateBundle,reconstruct} from '../src/validation.js';
import {replayExact} from '../src/replay.js';
import {parseTraining,parseOwnedScript} from '../src/training/profile.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';

function execute(texts){
  const runtime=createRuntime();
  const sources=texts.map((text,index)=>runtime.registerSource({text,url:`script${index}.js`,scriptProfile:true}));
  runtime.startScriptSequence(sources);
  const exit=runtime.drive(),bundle=runtime.exportRun();
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
  return {runtime,exit,bundle};
}
const binding=(bundle,name)=>bundle.finalState.envs[
  bundle.finalState.control.a0.scriptSequence.environmentId].bindings[name].token.value;
const official=name=>readFileSync(new URL(`../fixtures/test262-harness/${name}`,import.meta.url),'utf8');

test('owned global scripts retain original source bytes and share declarations only when entered',()=>{
  const texts=['var before=typeof later;var shared=3;',
    'function later(){return shared+4;}var shared;var result=later();'];
  const {exit,bundle}=execute(texts);
  assert.equal(exit.kind,'terminated');
  assert.equal(bundle.manifest.profile,'owned-script/1');
  assert.deepEqual(bundle.sources.map(source=>source.text),texts);
  assert.deepEqual(binding(bundle,'before'),['str','undefined']);
  assert.deepEqual(binding(bundle,'result'),['num',7]);
  assert.equal(bundle.events.filter(event=>event.operation==='script.enter').length,1);
  const enter=bundle.events.find(event=>event.operation==='script.enter');
  const restored=reconstruct(bundle,{throughEventId:enter.eventId});
  assert.equal(restored.control.a0.scriptSequence.nextIndex,2);
  assert.equal(restored.frames[restored.control.a0.activeFrameId].pc,0);
  assert.equal(restored.envs[restored.control.a0.scriptSequence.environmentId].bindings.later,undefined);
});

test('a strict test does not change the strictness of prior separately parsed harness functions',()=>{
  const {bundle}=execute(['function harness(){return 1;}','"use strict";function subject(){return harness();}var result=subject();']);
  const declaration=name=>Object.values(bundle.programs).flatMap(program=>program.instructions)
    .find(instruction=>instruction.op==='DEF_FN'&&instruction.arg.name===name);
  assert.equal(bundle.programs[declaration('harness').arg.codeId].strict,false);
  assert.equal(bundle.programs[declaration('subject').arg.codeId].strict,true);
  assert.deepEqual(binding(bundle,'result'),['num',1]);
  assert.doesNotThrow(()=>parseOwnedScript('var x=1; x++;'));
  assert.throws(()=>parseTraining('var x=1; x++;'),/explicit.*use strict/);
  assert.throws(()=>parseTraining('"use strict";var x=someFunction();'),/top-level declaration/);
});

test('official pinned assert and sta execute unchanged, including a real failing assertion',()=>{
  const lock=JSON.parse(official('snapshot.lock.json'));
  for(const [name,pin] of Object.entries(lock.files))
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../fixtures/test262-harness/${name}`,import.meta.url))).digest('hex'),pin.sha256,name);
  const harness=[official('assert.js'),official('sta.js')];
  assert.equal(execute([...harness,'assert.sameValue(1,1);assert.notSameValue(1,2);']).exit.kind,'terminated');
  const failed=execute([...harness,'assert.sameValue(1,2);']);
  assert.equal(failed.exit.kind,'runtime.failure');
  const thrown=failed.exit.failure.completion.value.value;
  assert.equal(thrown[0],'ref');
  const error=failed.bundle.finalState.heap[thrown[1]];
  assert.match(error.properties.message.value[1],/Expected SameValue/);
  assert.equal(failed.bundle.sources[0].text,harness[0]);
  assert.equal(failed.bundle.sources[1].text,harness[1]);
});

test('script entry rejects forged state, source, invocation and unrelated sequence mutation',()=>{
  const {bundle}=execute(['var x=1;','var result=x+1;']);
  const mutate=edit=>{
    const forged=structuredClone(bundle);
    edit(forged.events.find(event=>event.operation==='script.enter'),forged);
    assert.throws(()=>validateBundle(forged),/Script entry|Script sequence|script sequence/);
  };
  mutate(event=>{event.sourceId='src1';});
  mutate(event=>{event.causes[0].frameId='f1';});
  mutate(event=>{event.stateChanges.find(p=>p.table==='frames').after.envId='e1';});
  mutate(event=>{event.stateChanges.find(p=>p.table==='control').after.scriptSequence.nextIndex=1;});
  mutate(event=>{event.stateChanges.find(p=>p.table==='envs').after.bindings.x.token.value=['num',99];});
  mutate((event,forged)=>{
    const prior=forged.events.find(item=>item.operation==='call.return');
    prior.stateChanges.find(p=>p.table==='control').after.scriptSequence.nextIndex=2;
  });
  const forged=structuredClone(bundle);forged.sources[1].parser='bounded-pratt/2';
  assert.throws(()=>replayExact(forged),/registered script sequence/);
});

test('a failed earlier script never executes later source and declaration collisions fail closed',()=>{
  const failed=execute(['throw 1;','var shouldNotRun=1;']);
  assert.equal(failed.exit.kind,'runtime.failure');
  assert.equal(failed.bundle.finalState.control.a0.scriptSequence.nextIndex,1);
  assert(!failed.bundle.events.some(event=>event.operation==='script.enter'));
  const runtime=createRuntime();
  runtime.startScriptSequence(['let taken=1;','var taken=2;'].map(text=>runtime.registerSource({text,scriptProfile:true})));
  assert.throws(()=>runtime.drive(),/global declaration collision/);
});

test('ordinary scripts do not receive the linked module namespace constructor',()=>{
  const runtime=createRuntime();
  assert.throws(()=>runtime.registerSource({
    text:'__traced_eval_create_module_namespace([]);',url:'ordinary.js',
    scriptProfile:true,moduleNamespaceIntrinsic:true
  }),/generated Test262 module entry/);
  const source=runtime.registerSource({
    text:'__traced_eval_create_module_namespace([]);',url:'ordinary.js',scriptProfile:true
  });
  runtime.start(source);
  const exit=runtime.drive(),bundle=runtime.exportRun();
  assert.equal(exit.kind,'runtime.failure');
  assert.equal(exit.failure.completion.errorType,'ReferenceError');
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});

test('an ordinary script cannot call the generated module namespace constructor',()=>{
  const linked=linkEvaluatedModules({modules:{
    'base.js':'export let value=1;',
    'main.js':`import * as ns from './base.js';
      export function run(){return Object.keys(ns).length;}`
  },entryModule:'main.js',evaluateOnly:true});
  assert.equal(linked.metadata.requiresModuleNamespace,true);
  const runtime=createRuntime(),harness=runtime.registerSource({
    text:`var namespaceDenied;
      try{__traced_eval_create_module_namespace([]);namespaceDenied='called';}
      catch(error){namespaceDenied=error.name;}`,
    url:'ordinary-harness.js',scriptProfile:true
  }),module=runtime.registerSource({text:linked.source,
    url:'owned-test262-module://test/control.js',scriptProfile:true,
    moduleNamespaceIntrinsic:true}),invocation=runtime.registerSource({
    text:'__traced_eval_entry({args:[]});',url:'ordinary-invocation.js',scriptProfile:true
  });
  runtime.startScriptSequence([harness,module,invocation]);
  const exit=runtime.drive(),bundle=runtime.exportRun();
  assert.equal(exit.kind,'terminated');
  assert.deepEqual(binding(bundle,'namespaceDenied'),['str','TypeError']);
  assert.equal(Object.values(bundle.finalState.heap)
    .filter(entity=>entity.kind==='module-namespace').length,1);
  assert.equal(validateBundle(bundle).valid,true);
  assert.equal(replayExact(bundle).valid,true);
});
