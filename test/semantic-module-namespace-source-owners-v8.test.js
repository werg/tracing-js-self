import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {createRuntime} from '../src/runtime.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from '../src/semantic/module-namespace-state-v8.js';
import {deriveExperimentalModuleNamespaceOwnersV8} from '../src/semantic/module-namespace-source-owners-v8.js';

function executeLinked(linked){
  const runtime=createRuntime({maxSteps:20000}).startEntry({
    text:linked.source,functionName:linked.entryFunction,args:[linked.entryInput],
    allowAsync:true,moduleNamespaceIntrinsic:true
  });
  assert.equal(runtime.drive().kind,'terminated');
  return {bundle:runtime.exportRun()};
}

test('private namespace source owners map each initializer to one owned callsite',()=>{
  const modules={
    'main.js':"import * as left from './left.js';import * as right from './right.js';export function run(){return [Object.keys(left),Object.keys(right)];}",
    'left.js':"export const first=1;",
    'right.js':"export const second=2;"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',
    experimentalNamespacePlan:true});
  const owned=executeLinked(linked);
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const owners=deriveExperimentalModuleNamespaceOwnersV8({
    source:linked.source,moduleNamespacePlan:plan,bundle:owned.bundle
  });
  assert.deepEqual(owners.map(row=>row.file),['left.js','right.js']);
  assert.equal(new Set(owners.map(row=>row.siteId)).size,2);
  for(const row of owners){
    const event=owned.bundle.events.find(item=>item.siteId===row.siteId&&item.operation==='call.enter');
    assert.ok(event);
    assert.ok(event.stateChanges.some(change=>change.table==='heap'&&
      change.after?.kind==='module-namespace'&&change.after.id===event.result?.[1]));
    assert.ok(row.exports.every(item=>typeof item.loweredName==='string'));
  }
});

test('private namespace owner derivation rejects source drift and duplicate sites',()=>{
  const modules={
    'main.js':"import * as ns from './left.js';export function run(){return Object.keys(ns);}",
    'left.js':"export const value=1;"
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',
    experimentalNamespacePlan:true});
  const owned=executeLinked(linked);
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const owner=deriveExperimentalModuleNamespaceOwnersV8({source:linked.source,moduleNamespacePlan:plan,bundle:owned.bundle})[0];
  const duplicate=structuredClone(owned.bundle);
  duplicate.sites.push(structuredClone(duplicate.sites.find(site=>site.siteId===owner.siteId)));
  assert.throws(()=>deriveExperimentalModuleNamespaceOwnersV8({source:linked.source,moduleNamespacePlan:plan,bundle:duplicate}),
    /initializer callsite does not map to one owned source site/);
  assert.throws(()=>deriveExperimentalModuleNamespaceOwnersV8({
    source:linked.source+'\nconst __traced_eval_namespace_8=__traced_eval_create_module_namespace([]);',
    moduleNamespacePlan:plan,bundle:owned.bundle
  }),/unplanned module namespace initializer/);
});
