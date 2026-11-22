import test from 'node:test';
import assert from 'node:assert/strict';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker} from '../src/semantic/module-namespace-state-v8.js';
import {applyProtocolRecordV8,createProtocolStateV8,restoreProtocolStateV8,
  assertProtocolDetailCompatible} from '../src/semantic/protocol-state-v8.js';
import {encodeProtocolRecordV8,decodeProtocolRecordV8} from '../src/semantic/protocol-codec-v8.js';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const modules={
  'main.js':'import * as ns from "./view.js"; import {update} from "./cells.js"; export function run(){const keys=Object.keys(ns);update(9);const key="alias";return ns[key];}',
  'view.js':'export {value,value as alias,fixed} from "./cells.js";',
  'cells.js':'export let value=1; export const fixed=2; export function update(next){value=next;}'
};
function sourcePlan(){
  return buildExperimentalModuleNamespacePlanFromLinker(linkEvaluatedModules({
    modules,entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true
  }));
}
function controller(){return {
  heap:new Map(),locals:new Map(),captureAliases:new Map(),receiver:['undefined'],
  stack:['invocation1'],frameFunctions:new Map([['invocation1','run']]),
  pending:null,lastReturn:null,completion:null,protocol:createProtocolStateV8(),
  ready:[],effects:new Map(),jobs:new Map(),strictRequests:false,moduleNamespacePlan:sourcePlan()
};}
const apply=(c,...records)=>{for(const record of records){
  assert.deepEqual(decodeProtocolRecordV8(encodeProtocolRecordV8(record)),record);
  applyProtocolRecordV8(c,record);
}return c;};
function names(c){const p=c.moduleNamespacePlan,ns=p.namespaces[0];
  return {ns,value:p.cells.find(x=>x.file==='cells.js'&&x.local==='value'),
    fixed:p.cells.find(x=>x.file==='cells.js'&&x.local==='fixed')};
}
function initialize(c){
  const {value,fixed}=names(c);
  return apply(c,{kind:'cell.initialize',cell:value.id,loweredName:value.loweredName,value:['num',1]},
    {kind:'cell.initialize',cell:fixed.id,loweredName:fixed.loweredName,value:['num',2]});
}
function create(c){return apply(c,{kind:'namespace.create',namespaceId:'o15',moduleFile:names(c).ns.file});}
function refuses(c,record,pattern){const before=structuredClone(c);
  assert.throws(()=>applyProtocolRecordV8(c,record),pattern);assert.deepEqual(c,before);
}
const descriptor=value=>({value,writable:true,enumerable:true,configurable:false});

test('registered namespace records use the actual shared live cells and heap allocations',()=>{
  const c=create(initialize(controller())),{ns,value}=names(c);
  assert.deepEqual(c.locals.get(ns.namespaceName),['ref','o15']);
  assert.equal(c.heap.get('o15').namespacePlanDigest,c.moduleNamespacePlan.digest);
  apply(c,{kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o16'});
  assert.deepEqual([...c.heap.get('o16').properties],[['length',['num',3]],['0',['str','alias']],
    ['1',['str','fixed']],['2',['str','value']]]);
  apply(c,{kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',1]},
    {kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['num',9]},
    {kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num',9]},
    {kind:'namespace.descriptor',namespaceId:'o15',exportName:'alias',value:descriptor(['num',9]),resultId:'o17'});
  assert.deepEqual([...c.heap.get('o17').properties],[['value',['num',9]],['writable',['bool',true]],
    ['enumerable',['bool',true]],['configurable',['bool',false]]]);
  assert(!Object.hasOwn(c.heap.get('o15'),'cells'),'namespace objects contain references, never duplicate cell values');
  assert.equal(restoreProtocolStateV8(c,structuredClone(c.protocol)).valid,true);
});

test('TDZ, const, wrong aliases, malformed results and duplicate identities fail atomically',()=>{
  const c=create(controller()),{value,fixed}=names(c);
  refuses(c,{kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num',1]},/TDZ/);
  refuses(c,{kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o16'},/TDZ/);
  refuses(c,{kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['num',1]},/before initialization/);
  initialize(c);
  for(const record of [
    {kind:'cell.initialize',cell:value.id,loweredName:value.loweredName,value:['num',1]},
    {kind:'cell.write',cell:fixed.id,loweredName:fixed.loweredName,value:['num',3]},
    {kind:'cell.write',cell:value.id,loweredName:fixed.loweredName,value:['num',3]},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',2]},
    {kind:'namespace.keys',namespaceId:'o15',names:['value','fixed','alias'],resultId:'o16'},
    {kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o15'},
    {kind:'namespace.create',namespaceId:'o16',moduleFile:names(c).ns.file},
    {kind:'namespace.descriptor',namespaceId:'o15',exportName:'value',value:{...descriptor(['num',1]),writable:false},resultId:'o16'},
    {kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['ref','o15']}
  ])refuses(c,record);
  const missing=controller();delete missing.moduleNamespacePlan;
  refuses(missing,{kind:'namespace.create',namespaceId:'o15',moduleFile:names(c).ns.file},/source-derived namespace plan/);
});

test('ordinary records cannot initialize or overwrite namespace cells and owner bindings',()=>{
  for(const initialized of [false,true]){
    const c=controller();if(initialized)create(initialize(c));
    const {ns,value,fixed}=names(c);
    for(const name of [ns.namespaceName,value.loweredName,fixed.loweredName]){
      refuses(c,{kind:'bind',name,value:['num',7]},/declared lifecycle/);
      refuses(c,{kind:'compute',expr:{op:'literal',value:['num',7]},result:['num',7],bind:name},/declared lifecycle/);
      refuses(c,{kind:'symbol.read',symbol:['symbol','well-known:iterator'],operation:'description',
        result:['str','Symbol.iterator'],bind:name},/declared lifecycle/);
      assert.throws(()=>assertProtocolDetailCompatible(c,{kind:'bind',fields:{name,value:['num',7]}}),/declared lifecycle/);
    }
  }
});

test('namespace transitions cannot jump over an existing Number continuation',()=>{
  const c=initialize(controller());
  apply(c,{kind:'number.begin',id:'conversion1',value:['str','3']});
  refuses(c,{kind:'namespace.create',namespaceId:'o15',moduleFile:names(c).ns.file},/Number|conversion/);
  apply(c,{kind:'number.finish',id:'conversion1',result:['num',3]});
  create(c);
});

test('ordinary objects cannot mutate namespaces and retained heap metadata remains exact',()=>{
  const c=create(initialize(controller()));
  refuses(c,{kind:'property.set',object:'o15',key:['str','value'],receiver:['ref','o15'],value:['num',3],success:true},/ordinary/);
  refuses(c,{kind:'property.get',object:'o15',key:['str','value'],receiver:['ref','o15'],result:['num',1]},/ordinary/);
  const corrupt=structuredClone(c);corrupt.heap.get('o15').namespaceExports[0].loweredName='wrong';
  assert.throws(()=>restoreProtocolStateV8(corrupt,corrupt.protocol),/source-owned plan/);
  const detached=structuredClone(c);detached.locals.delete(names(c).ns.namespaceName);
  assert.throws(()=>restoreProtocolStateV8(detached,detached.protocol),/binding differs/);
  const without=structuredClone(c);delete without.moduleNamespacePlan;
  assert.throws(()=>restoreProtocolStateV8(without,without.protocol),/published source plan/);
});

test('public program binding and checkpoint replay retain the exact plan across unrelated publications',()=>{
  const plan=sourcePlan(),h=new RegionExecutionHarness({sessionId:'namespace-public-plan'});
  h.publishProgram({programId:'p',source:'"use strict";function run(){return 1;}',entry:'run',moduleNamespacePlan:plan});
  h.admitInvocation({programId:'p',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'entry',inputGraph:{roots:[],objects:[]},realmPolicy:'fresh',completionPolicy:'call-return'});
  h.publishProgram({programId:'unrelated',source:'"use strict";function other(){return 2;}',entry:'other'});
  const {value,fixed,ns}=names(h.controller);
  for(const record of [
    {kind:'cell.initialize',cell:value.id,loweredName:value.loweredName,value:['num',1]},
    {kind:'cell.initialize',cell:fixed.id,loweredName:fixed.loweredName,value:['num',2]},
    {kind:'namespace.create',namespaceId:'o15',moduleFile:ns.file}
  ])h.select('invocation1',record);
  const packet=JSON.parse(JSON.stringify(h.checkpoint())),restored=RegionExecutionHarness.restore(packet);
  assert.deepEqual(restored.modelContext('invocation1'),h.modelContext('invocation1'));
  assert.deepEqual(restored.controller.moduleNamespacePlan,plan);
  restored.select('invocation1',{kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['num',9]});
  restored.select('invocation1',{kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',9]});
  assert.throws(()=>restored.select('invocation1',{kind:'bind',fields:{name:value.loweredName,value:['num',4]}}),/declared lifecycle/);
  assert.throws(()=>restored.select('invocation1','algorithm {}'),/explicit protocol cell transitions/);
  assert.throws(()=>restored.select('invocation1','region {}'),/explicit protocol cell transitions/);
  const altered=structuredClone(packet),state=altered.selected.invocations[0][1].state;
  state.locals.find(row=>row[0]===value.loweredName)[1]=['num',99];
  const {integrity,...body}=altered;altered.integrity=hashAlgorithmData(body);
  assert.throws(()=>RegionExecutionHarness.restore(altered),/exact public shared state/);
});

test('ordinary closure entry cannot redirect a protected live cell through captures',()=>{
  const c=create(initialize(controller())),{value}=names(c);
  apply(c,{kind:'bind',name:'shadow',value:['num',1]},
    {kind:'allocate',name:'o30',objectKind:'closure',length:null,properties:[],code:'helper',
      captures:[{binding:value.loweredName,cell:'shadow'}],functionKind:'ordinary',lexicalReceiver:null});
  refuses(c,{kind:'call',child:'guest1',callee:['ref','o30'],receiver:['undefined'],arguments:[]},/source-owned cell mapping/);
});
