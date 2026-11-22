import test from 'node:test';
import assert from 'node:assert/strict';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {
  buildExperimentalModuleNamespacePlan,\n  buildExperimentalModuleNamespacePlanFromLinker,
  createExperimentalModuleNamespaceState,
  applyExperimentalModuleNamespaceTransition,
  verifyExperimentalModuleNamespacePlan
} from '../src/semantic/module-namespace-state-v8.js';\nimport {linkEvaluatedModules} from '../src/evaluated-modules.js';

const modules={'main.js':'import * as ns from "./cells.js"; export function run(){ return Object.keys(ns); }',
  'cells.js':'export let value=1; export {value as alias}; export const fixed=2;'};
const plan=()=>buildExperimentalModuleNamespacePlan({
  modules,entryModule:'main.js',
  cells:[
    {file:'cells.js',local:'value',kind:'let',mutable:true},
    {file:'cells.js',local:'fixed',kind:'const',mutable:false}
  ],
  namespaces:[{file:'cells.js',exports:[
    {name:'alias',file:'cells.js',local:'value'},
    {name:'fixed',file:'cells.js',local:'fixed'},
    {name:'value',file:'cells.js',local:'value'}
  ]}]
});

test('experimental namespace plan is derived from canonical linker source records',()=>{
  const ordinary=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});\n  assert.equal(Object.hasOwn(ordinary.metadata,'namespaceSourcePlan'),false);\n  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  const source=buildExperimentalModuleNamespacePlanFromLinker(linked);
  assert.equal(source.schema,'semantic-module-namespace-plan/1');
  assert.deepEqual(source.namespaces,[{file:'cells.js',exports:[
    {name:'alias',cell:'cells.js#value'},
    {name:'fixed',cell:'cells.js#fixed'},
    {name:'value',cell:'cells.js#value'}
  ]}]);
  const forged=structuredClone(linked);
  forged.metadata.namespaceSourcePlan.namespaces[0].exports[0].local='missing';
  assert.throws(()=>buildExperimentalModuleNamespacePlanFromLinker(forged),/does not resolve/);
});

test('experimental namespace plan binds aliases to live canonical source cells',()=>{
  const source=plan();assert.equal(verifyExperimentalModuleNamespacePlan(source),true);
  const state=createExperimentalModuleNamespaceState(source,{
    'cells.js#value':{initialized:true,value:['num',1]},
    'cells.js#fixed':{initialized:true,value:['num',2]}
  });
  let transition=applyExperimentalModuleNamespaceTransition(source,state,{
    kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'});
  let result=applyExperimentalModuleNamespaceTransition(source,transition.state,{
    kind:'namespace.keys',namespaceId:'obj1',names:['alias','fixed','value']});
  assert.deepEqual(result.result,['alias','fixed','value']);
  result=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'namespace.read',namespaceId:'obj1',exportName:'alias',value:['num',1]});
  transition=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'cell.write',cell:'cells.js#value',value:['num',9]});
  result=applyExperimentalModuleNamespaceTransition(source,transition.state,{
    kind:'namespace.read',namespaceId:'obj1',exportName:'alias',value:['num',9]});
  assert.deepEqual(result.result,['num',9]);
  result=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'namespace.descriptor',namespaceId:'obj1',exportName:'value',
    value:{value:['num',9],writable:true,enumerable:true,configurable:false}});
  assert.deepEqual(result.result,{value:['num',9],writable:true,enumerable:true,configurable:false});
});

test('experimental namespace reads enforce TDZ and malformed transitions are atomic',()=>{
  const source=plan();
  const initial=createExperimentalModuleNamespaceState(source);
  const created=applyExperimentalModuleNamespaceTransition(source,initial,{
    kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'}).state;
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.read',namespaceId:'obj1',exportName:'value',value:['num',1]}),/before its source binding is initialized/);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.keys',namespaceId:'obj1',names:['value','fixed','alias']}),/own-key result differs/);
  assert.deepEqual(created,applyExperimentalModuleNamespaceTransition(source,initial,{
    kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'}).state);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'cell.write',cell:'cells.js#fixed',value:['num',3]}),/write is not allowed/);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.read',namespaceId:'obj1',exportName:'notExported',value:['num',0]}),/missing export/);
});

test('experimental plan refuses numeric export names and changed source/link tables',()=>{
  const base=plan();
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules:{'main.js':'','cells.js':''},entryModule:'main.js',
    cells:[{file:'cells.js',local:'value',kind:'let',mutable:true}],
    namespaces:[{file:'cells.js',exports:[{name:'2',file:'cells.js',local:'value'}]}]
  }),/malformed/);
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules,entryModule:'main.js',
    cells:[{file:'cells.js',local:'fixed',kind:'const',mutable:true}],
    namespaces:[{file:'cells.js',exports:[]}]
  }),/malformed/);
  assert.throws(()=>createExperimentalModuleNamespaceState(plan(),{
    'cells.js#value':{initialized:true,value:['num','garbage']}
  }),/initial cell value is malformed/);
  assert.throws(()=>createExperimentalModuleNamespaceState(plan(),{
    'cells.js#fixed':{initialized:true,value:['null',1]}
  }),/initial cell value is malformed/);
  assert.throws(()=>createExperimentalModuleNamespaceState(plan(),{
    'cells.js#fixed':{initialized:true,value:['num',-0]}
  }),/initial cell value is malformed/);
  const changed={...base,modules:base.modules.map(row=>({...row}))};
  changed.modules[0].sourceDigest=hashAlgorithmData('changed');
  assert.throws(()=>verifyExperimentalModuleNamespacePlan(changed),/integrity differs/);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(base,{
    schema:'semantic-module-namespace-state/1',planDigest:'0'.repeat(64),cells:{},namespaces:{}
  },{kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'}),/not bound/);
  const state=createExperimentalModuleNamespaceState(base);
  const forged=structuredClone(state);forged.cells['cells.js#value']={initialized:true,value:['num',77],version:-1};
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(base,forged,{
    kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'
  }),/state is not bound|cell state is malformed/);
});
