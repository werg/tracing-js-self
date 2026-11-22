import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {delimiter,join} from 'node:path';
import {RegionExecutionHarness} from '../src/semantic/region-harness.js';
import {sharedRegionState} from '../src/semantic/regions.js';
import {applyProtocolRecordV8,restoreProtocolStateV8} from '../src/semantic/protocol-state-v8.js';
import {linkEvaluatedModules} from '../src/evaluated-modules.js';
import {buildExperimentalModuleNamespacePlanFromLinker,
  createExperimentalModuleNamespaceState,applyExperimentalModuleNamespaceTransition}
  from '../src/semantic/module-namespace-state-v8.js';

const enabled=Boolean(process.env.MEGATOKEN_ROOT&&process.env.MEGATOKEN_PYTHON);
const plain=value=>JSON.parse(JSON.stringify(value));

test('experimental JS and independent Python namespace cells agree through aliases, TDZ and atomic refusals',
  {skip:!enabled},()=>{
  const modules={
    'main.js':'import * as ns from "./cells.js"; export function run(){return Object.keys(ns);}',
    'cells.js':'export let value=1; export {value as alias}; export const fixed=2;'
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',
    experimentalNamespacePlan:true});
  const plan=buildExperimentalModuleNamespacePlanFromLinker(linked);
  const steps=[
    {kind:'namespace.create',namespaceId:'o15',moduleFile:'cells.js'},
    {kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num',1]},
    {kind:'cell.initialize',cell:'cells.js#value',value:['num',1]},
    {kind:'cell.initialize',cell:'cells.js#fixed',value:['num',2]},
    {kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value']},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',1]},
    {kind:'cell.write',cell:'cells.js#value',value:['num',9]},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',9]},
    {kind:'namespace.descriptor',namespaceId:'o15',exportName:'value',
      value:{value:['num',9],writable:true,enumerable:true,configurable:false}},
    {kind:'cell.write',cell:'cells.js#fixed',value:['num',3]},
    {kind:'namespace.keys',namespaceId:'o15',names:['value','alias','fixed']},
    {kind:'namespace.create',namespaceId:'o16',moduleFile:'cells.js'},
    {kind:'cell.initialize',cell:'cells.js#value',value:['num',10]},
    {kind:'cell.write',cell:'cells.js#value',value:['bool','true']},
    {kind:'cell.write',cell:'cells.js#value',value:['ref','obj9']},
    {kind:'cell.write',cell:'cells.js#value',value:['num','NaN']},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num','NaN']},
    {kind:'cell.write',cell:'cells.js#value',value:['bigint','123456789012345678901234567890']},
    {kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['bigint','123456789012345678901234567890']}
  ];
  let state=createExperimentalModuleNamespaceState(plan);const outcomes=[];
  for(const step of steps){
    const before=plain(state);
    try{const result=applyExperimentalModuleNamespaceTransition(plan,state,step);
      state=result.state;outcomes.push({status:'accepted',state:plain(state),result:result.result===undefined?null:plain(result.result)});
    }catch(error){assert.match(error.message,/Experimental module namespace/);
      assert.deepEqual(plain(state),before);outcomes.push({status:'refused',state:plain(state)});
    }
  }
  assert.equal(outcomes.filter(row=>row.status==='refused').length,7);
  const python=String.raw`import copy, json, sys
from megatoken.data.module_namespace_state_v8 import (
    build_experimental_module_namespace_plan,
    create_experimental_module_namespace_state,
    apply_experimental_module_namespace_transition,
)
request=json.load(sys.stdin)
plan=build_experimental_module_namespace_plan(
    modules=request["modules"], entry_module="main.js",
    cells=request["linkPlan"]["cells"], namespaces=request["linkPlan"]["namespaces"])
state=create_experimental_module_namespace_state(plan)
outcomes=[]
for step in request["steps"]:
    before=copy.deepcopy(state)
    try:
        result=apply_experimental_module_namespace_transition(plan,state,step)
        state=result["state"]
        outcomes.append({"status":"accepted","state":state,"result":result["result"]})
    except ValueError:
        assert state==before
        outcomes.append({"status":"refused","state":state})
print(json.dumps({"plan":plan,"outcomes":outcomes},ensure_ascii=True))
`;
  const child=spawnSync(process.env.MEGATOKEN_PYTHON,['-c',python],{
    input:JSON.stringify({modules,linkPlan:linked.metadata.namespaceSourcePlan,steps}),
    encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
    env:{...process.env,PYTHONPATH:[join(process.env.MEGATOKEN_ROOT,'src'),process.env.PYTHONPATH]
      .filter(Boolean).join(delimiter)}
  });
  assert.equal(child.status,0,child.stderr||child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout),{plan:plain(plan),outcomes});
});

test('actual JavaScript and Python public namespace records preserve the same shared state at every cut',
  {skip:!enabled},()=>{
  const modules={
    'main.js':'import * as view from "./view.js";import {update} from "./cells.js";export function run(){const keys=Object.keys(view);update(9);return keys;}',
    'cells.js':'export let value=1;export const fixed=2;export function update(next){value=next;}',
    'view.js':'export {value,value as alias,fixed} from "./cells.js";'
  };
  const linked=linkEvaluatedModules({modules,entryModule:'main.js',exportName:'run',experimentalNamespacePlan:true}),
    plan=buildExperimentalModuleNamespacePlanFromLinker(linked),ns=plan.namespaces[0],
    value=plan.cells.find(row=>row.file==='cells.js'&&row.local==='value'),
    fixed=plan.cells.find(row=>row.file==='cells.js'&&row.local==='fixed');
  const harness=new RegionExecutionHarness({sessionId:'paired-namespace-machine'});
  harness.publishProgram({programId:'p',source:'"use strict";function run(){return 1;}',entry:'run',moduleNamespacePlan:plan});
  harness.admitInvocation({programId:'p',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',
    triggerId:'entry',inputGraph:{roots:[],objects:[]},realmPolicy:'fresh',completionPolicy:'call-return'});
  const c=harness.controller,initial=plain(sharedRegionState(c));
  const records=[
    {kind:'namespace.create',namespaceId:'o15',moduleFile:ns.file},
    {kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num',1]},
    {kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o16'},
    {kind:'cell.initialize',cell:value.id,loweredName:value.loweredName,value:['num',1]},
    {kind:'cell.initialize',cell:fixed.id,loweredName:fixed.loweredName,value:['num',2]},
    {kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o16'},
    {kind:'namespace.descriptor',namespaceId:'o15',exportName:'alias',
      value:{value:['num',1],writable:true,enumerable:true,configurable:false},resultId:'o17'},
    {kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['num',9]},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['num',9]},
    {kind:'cell.write',cell:fixed.id,loweredName:fixed.loweredName,value:['num',3]},
    {kind:'namespace.keys',namespaceId:'o15',names:['alias','fixed','value'],resultId:'o16'},
    {kind:'bind',name:value.loweredName,value:['num',99]},
    {kind:'bind',name:ns.namespaceName,value:['null']},
    {kind:'property.get',object:'o15',key:['str','value'],receiver:['ref','o15'],result:['num',9]},
    {kind:'bind',name:'ordinary',value:['num',4]},
    {kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['num','NaN']},
    {kind:'namespace.read',namespaceId:'o15',exportName:'value',value:['num','NaN']},
    {kind:'cell.write',cell:value.id,loweredName:value.loweredName,value:['bigint','123456789012345678901234567890']},
    {kind:'namespace.descriptor',namespaceId:'o15',exportName:'value',
      value:{value:['bigint','123456789012345678901234567890'],writable:true,enumerable:true,configurable:false},resultId:'o18'},
    {kind:'number.begin',id:'conversion1',value:['str','3']},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['bigint','123456789012345678901234567890']},
    {kind:'number.finish',id:'conversion1',result:['num',3]},
    {kind:'namespace.read',namespaceId:'o15',exportName:'alias',value:['bigint','123456789012345678901234567890']}
  ];
  const outcomes=[];
  for(const record of records){
    const before=plain(sharedRegionState(c));
    try{applyProtocolRecordV8(c,record);restoreProtocolStateV8(c,plain(c.protocol));
      outcomes.push({status:'accepted',state:plain(sharedRegionState(c))});}
    catch(error){assert.deepEqual(plain(sharedRegionState(c)),before,error.message);
      outcomes.push({status:'refused',state:plain(sharedRegionState(c))});}
  }
  assert(outcomes.some(row=>row.status==='refused'));
  assert.equal(outcomes.at(-1).status,'accepted');
  const python=String.raw`import copy,json,sys
from megatoken.data.protocol_v8 import apply_protocol_to_shared_state,validate_protocol_state
from megatoken.data.module_namespace_machine_v8 import validate_experimental_module_namespace_shared_state
from megatoken.data.semantic_json import stable_algorithm_json
request=json.load(sys.stdin)
state=request["initial"]
outcomes=[]
for record in request["records"]:
    before=copy.deepcopy(state)
    try:
        state=apply_protocol_to_shared_state(state,"protocol "+stable_algorithm_json(record),namespace_plan=request["plan"])
        state=json.loads(json.dumps(state))
        validate_protocol_state(state["protocol"],state["heap"],state)
        validate_experimental_module_namespace_shared_state(state,request["plan"])
        outcomes.append({"status":"accepted","state":copy.deepcopy(state)})
    except ValueError:
        assert state==before
        outcomes.append({"status":"refused","state":copy.deepcopy(state)})
print(json.dumps(outcomes,ensure_ascii=True))
`;
  const child=spawnSync(process.env.MEGATOKEN_PYTHON,['-c',python],{
    input:JSON.stringify({initial,plan,records}),encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
    env:{...process.env,PYTHONPATH:[join(process.env.MEGATOKEN_ROOT,'src'),process.env.PYTHONPATH]
      .filter(Boolean).join(delimiter)}
  });
  assert.equal(child.status,0,child.stderr||child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout),outcomes);
});
