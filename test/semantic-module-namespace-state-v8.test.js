import test from 'node:test';
import assert from 'node:assert/strict';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {
  buildExperimentalModuleNamespacePlan,
  buildExperimentalModuleNamespacePlanFromLinker,
  createExperimentalModuleNamespaceState,
  applyExperimentalModuleNamespaceTransition,
  verifyExperimentalModuleNamespacePlan
} from '../src/semantic/module-namespace-state-v8.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';

const modules={'main.js':'import * as ns from "./cells.js"; export function run(){ return Object.keys(ns); }',
  'cells.js':'export let value=1; export {value as alias}; export const fixed=2;'};
const plan=()=>buildExperimentalModuleNamespacePlan({
  modules,entryModule:'main.js',
  cells:[
    {file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'},
    {file:'cells.js',local:'fixed',kind:'const',mutable:false,loweredName:'__traced_eval_m1_fixed'}
  ],
  namespaces:[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[
    {name:'alias',file:'cells.js',local:'value'},
    {name:'fixed',file:'cells.js',local:'fixed'},
    {name:'value',file:'cells.js',local:'value'}
  ]}]
});


test('public region program carries the immutable normalized experimental namespace plan',()=>{
  const modulePlan=plan(),source='"use strict"; function entry(){return 1;}';
  const harness=new RegionExecutionHarness({sessionId:'namespace-plan'});
  harness.publishProgram({programId:'program1',source,entry:'entry',moduleNamespacePlan:modulePlan});
  const row=harness.exportEpisode().timeline.find(item=>item.kind==='program');
  assert.deepEqual(row.fields.regionProgram.moduleNamespacePlan,modulePlan);
  const changed=structuredClone(harness.exportEpisode());
  const program=changed.timeline.find(item=>item.kind==='program');
  program.fields.regionProgram.moduleNamespacePlan.namespaces[0].namespaceName='__traced_eval_namespace_7';
  assert.throws(()=>RegionExecutionHarness.replay(changed),/integrity differs|definition changed|program publication changed/);
});

test('experimental namespace plan is derived from canonical linker source records',()=>{
  const ordinary=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run'});
  assert.equal(Object.hasOwn(ordinary.metadata,'namespaceSourcePlan'),false);
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true});
  const source=buildExperimentalModuleNamespacePlanFromLinker(linked);
  assert.equal(source.schema,'semantic-module-namespace-plan/1');
  assert.deepEqual(source.namespaces,[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[
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
    kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'});
  let result=applyExperimentalModuleNamespaceTransition(source,transition.state,{
    kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value']});
  assert.deepEqual(result.result,['alias','fixed','value']);
  result=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',1]});
  transition=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'cell.write',cell:'cells.js#value',value:['num',9]});
  result=applyExperimentalModuleNamespaceTransition(source,transition.state,{
    kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',9]});
  assert.deepEqual(result.result,['num',9]);
  result=applyExperimentalModuleNamespaceTransition(source,result.state,{
    kind:'namespace.descriptor',namespaceId:'o15',exportName:'value',
    value:{value:['num',9],writable:true,enumerable:true,configurable:false}});
  assert.deepEqual(result.result,{value:['num',9],writable:true,enumerable:true,configurable:false});
});

test('experimental namespace reads enforce TDZ and malformed transitions are atomic',()=>{
  const source=plan();
  const initial=createExperimentalModuleNamespaceState(source);
  const created=applyExperimentalModuleNamespaceTransition(source,initial,{
    kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'}).state;
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num',1]}),/before its source binding is initialized/);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.keys',namespaceId:'o15',names:['value','fixed','alias']}),/own-key result differs/);
  assert.deepEqual(created,applyExperimentalModuleNamespaceTransition(source,initial,{
    kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'}).state);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'cell.write',cell:'cells.js#fixed',value:['num',3]}),/write is not allowed/);
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(source,created,{
    kind:'namespace.read',namespaceId:'o15',exportName:'notExported',value:['num',0]}),/missing export/);
});

test('experimental plan refuses numeric export names and changed source/link tables',()=>{
  const base=plan();
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules:{'main.js':'','cells.js':''},entryModule:'main.js',
    cells:[{file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'}],
    namespaces:[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[{name:'2',file:'cells.js',local:'value'}]}]
  }),/malformed/);
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules,entryModule:'main.js',
    cells:[{file:'cells.js',local:'fixed',kind:'const',mutable:true,loweredName:'__traced_eval_m1_fixed'}],
    namespaces:[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[]}]
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
  },{kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'}),/not bound/);
  const state=createExperimentalModuleNamespaceState(base);
  const forged=structuredClone(state);forged.cells['cells.js#value']={initialized:true,value:['num',77],version:-1};
  assert.throws(()=>applyExperimentalModuleNamespaceTransition(base,forged,{
    kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'
  }),/state is not bound|cell state is malformed/);
});

test('experimental cell records require unique linker-stable lowered names',()=>{
  const fields={modules,entryModule:'main.js',namespaces:[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[]}],
    cells:[{file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'value'}]};
  assert.throws(()=>buildExperimentalModuleNamespacePlan(fields),/cell record is malformed/);
  assert.throws(()=>buildExperimentalModuleNamespacePlan({...fields,cells:[
    {file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'},
    {file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'}
  ]}),/duplicate canonical source cell or lowered binding/);
});

test('experimental lowered-name mapping must preserve local suffix and module identity',()=>{
  const source=plan(),badSuffix=structuredClone(source);
  badSuffix.cells[0].loweredName='__traced_eval_m1_other';
  assert.throws(()=>verifyExperimentalModuleNamespacePlan(badSuffix),/malformed/);
  const mixed=structuredClone(source);
  mixed.cells.find(row=>row.file==='cells.js'&&row.local==='fixed').loweredName='__traced_eval_m2_fixed';
  assert.throws(()=>verifyExperimentalModuleNamespacePlan(mixed),/module indices are inconsistent/);
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules,entryModule:'main.js',namespaces:[{file:'cells.js',namespaceName:'__traced_eval_namespace_0',exports:[]}],
    cells:[
      {file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'},
      {file:'main.js',local:'entry',kind:'let',mutable:true,loweredName:'__traced_eval_m1_entry'}
    ]
  }),/module indices are inconsistent/);
});

test('experimental namespace records require a unique generated linker binding',()=>{
  assert.throws(()=>buildExperimentalModuleNamespacePlan({
    modules,entryModule:'main.js',cells:[
      {file:'cells.js',local:'value',kind:'let',mutable:true,loweredName:'__traced_eval_m1_value'}
    ],namespaces:[{file:'cells.js',namespaceName:'invalid',exports:[]}]
  }),/namespace link record is malformed/);
});
