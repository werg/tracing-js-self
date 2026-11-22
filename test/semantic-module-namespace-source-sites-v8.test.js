import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from '../src/semantic/module-namespace-state-v8.js';
import {deriveExperimentalModuleNamespaceSourceSites} from '../src/semantic/module-namespace-source-sites-v8.js';

test('experimental source sites bind namespace getters to unique linker cells',()=>{
  const linked=linkEvaluatedModules({modules:{
    'main.js':"import * as ns from './cells.js';export function run(){return Object.keys(ns);}",
    'cells.js':"export let value=1;export {value as alias};"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const sites=deriveExperimentalModuleNamespaceSourceSites({source:linked.source,moduleNamespacePlan:plan});
  assert.equal(sites.length,1);
  assert.deepEqual(sites[0].exports,[{name:'alias',cell:'cells.js#value',
    loweredName:'__traced_eval_m1_value',getterStart:sites[0].exports[0].getterStart,
    getterEnd:sites[0].exports[0].getterEnd},
    {name:'value',cell:'cells.js#value',loweredName:'__traced_eval_m1_value',
      getterStart:sites[0].exports[1].getterStart,getterEnd:sites[0].exports[1].getterEnd}]);
});

test('experimental source sites reject getter drift and unplanned namespace initializers',()=>{
  const linked=linkEvaluatedModules({modules:{
    'main.js':"import * as ns from './cells.js';export function run(){return Object.keys(ns);}",
    'cells.js':"export let value=1;"
  },entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  assert.throws(()=>deriveExperimentalModuleNamespaceSourceSites({
    source:linked.source.replace('()=>(__traced_eval_m1_value)','async ()=>(__traced_eval_m1_value)'),moduleNamespacePlan:plan
  }),/pure read of its source-owned live cell/);
  const drift=linked.source.replace('()=>(__traced_eval_m1_value)','()=> (1)');
  assert.throws(()=>deriveExperimentalModuleNamespaceSourceSites({source:drift,moduleNamespacePlan:plan}),
    /pure read of its source-owned live cell/);
  assert.throws(()=>deriveExperimentalModuleNamespaceSourceSites({
    source:linked.source+'\nconst __traced_eval_namespace_9=__traced_eval_create_module_namespace([]);',
    moduleNamespacePlan:plan
  }),/unplanned module namespace initializer/);
});
