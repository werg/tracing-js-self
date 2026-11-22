import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {delimiter,join} from 'node:path';
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
    {kind:'namespace.create',namespaceId:'obj1',moduleFile:'cells.js'},
    {kind:'namespace.read',namespaceId:'obj1',exportName:'value',value:['num',1]},
    {kind:'cell.initialize',cell:'cells.js#value',value:['num',1]},
    {kind:'cell.initialize',cell:'cells.js#fixed',value:['num',2]},
    {kind:'namespace.keys',namespaceId:'obj1',names:['alias','fixed','value']},
    {kind:'namespace.read',namespaceId:'obj1',exportName:'alias',value:['num',1]},
    {kind:'cell.write',cell:'cells.js#value',value:['num',9]},
    {kind:'namespace.read',namespaceId:'obj1',exportName:'alias',value:['num',9]},
    {kind:'namespace.descriptor',namespaceId:'obj1',exportName:'value',
      value:{value:['num',9],writable:true,enumerable:true,configurable:false}},
    {kind:'cell.write',cell:'cells.js#fixed',value:['num',3]},
    {kind:'namespace.keys',namespaceId:'obj1',names:['value','alias','fixed']},
    {kind:'namespace.create',namespaceId:'obj2',moduleFile:'cells.js'},
    {kind:'cell.initialize',cell:'cells.js#value',value:['num',10]},
    {kind:'cell.write',cell:'cells.js#value',value:['bool','true']},
    {kind:'cell.write',cell:'cells.js#value',value:['ref','obj9']},
    {kind:'cell.write',cell:'cells.js#value',value:['num','NaN']},
    {kind:'namespace.read',namespaceId:'obj1',exportName:'alias',value:['num','NaN']},
    {kind:'cell.write',cell:'cells.js#value',value:['bigint','123456789012345678901234567890']},
    {kind:'namespace.read',namespaceId:'obj1',exportName:'value',value:['bigint','123456789012345678901234567890']}
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
