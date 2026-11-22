// Observed program authority for the bounded acyclic module scheduler profile.
import {parse} from 'acorn';
import {hashAlgorithmData} from './program.js';
import {assertAlgorithmFields} from './ir.js';
import {buildModuleSchedulerPlanV8,verifyModuleSchedulerPlanV8} from './module-scheduler-state-v8.js';

export const BOUND_MODULE_SCHEDULER_PLAN_V8='semantic-bound-module-scheduler-plan/1';
export const MODULE_SCHEDULER_FUNCTIONS_V8=Object.freeze({asyncDriver:'__traced_eval_async',syncDriver:'__traced_eval_sync',
  failure:'__traced_eval_failed',startAsync:'__traced_eval_start_async'});
const fail=message=>{throw new TypeError('Bound module scheduler plan: '+message);};
const completionRegistration=`function __traced_eval_start_async(record){
    if(record.started)throw new TypeError('Module body already started');
    record.started=true;
    record.execution=__traced_eval_async(record);
    record.execution.then(function(){__traced_eval_fulfilled(record);},
      function(error){__traced_eval_failed(record,error);});
  }`;
function sourceModuleRecords(source,modulePlan){
  const positions=new Map(modulePlan.modules.map(row=>[row.file,row.index])),
    records=source.split('\n').filter(line=>/^  __traced_eval_modules\[\d+\]=\{index:/.test(line));
  if(records.length!==modulePlan.modules.length)fail('source module record inventory differs');
  for(const [index,module]of modulePlan.modules.entries()){
    const expected=`  __traced_eval_modules[${index}]={index:${index},entry:${module.file===modulePlan.entryModule},hasTLA:${module.hasTLA},dependencies:[${module.dependencies.map(file=>positions.get(file)).join(',')}],`;
    if(!records[index].startsWith(expected))fail('source module dependencies or TLA differ');
  }
}
function functions(source){
  const found=new Map(),ast=parse(source,{ecmaVersion:2026,sourceType:'script'});
  function walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}
    if(node.type==='FunctionDeclaration'&&Object.values(MODULE_SCHEDULER_FUNCTIONS_V8).includes(node.id?.name)){
      if(found.has(node.id.name))fail('duplicate driver source');found.set(node.id.name,node);
    }
    for(const [key,value]of Object.entries(node))if(!['start','end','loc'].includes(key))walk(value);
  }walk(ast);
  for(const [kind,name]of Object.entries(MODULE_SCHEDULER_FUNCTIONS_V8)){
    const node=found.get(name);if(!node||Boolean(node.async)!==(kind==='asyncDriver')||node.generator)fail('exact scheduler helper source required');
  }
  const start=found.get(MODULE_SCHEDULER_FUNCTIONS_V8.startAsync),calls=[];
  if(source.slice(start.start,start.end)!==completionRegistration)fail('exact completion registration source required');
  function find(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(find);return;}
    if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&node.callee.property.name==='then')calls.push(node);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc'].includes(key))find(value);
  }find(start.body);
  if(calls.length!==1||calls[0].arguments.length!==2||calls[0].arguments.some(node=>node.type!=='FunctionExpression'||node.async||node.generator))
    fail('exact completion reaction source required');
  return {...MODULE_SCHEDULER_FUNCTIONS_V8,fulfilled:'function:'+calls[0].arguments[0].start,rejected:'function:'+calls[0].arguments[1].start};
}
export function buildBoundModuleSchedulerPlanFromLinkerV8(linked){
  if(linked.metadata.requiresModuleNamespace||linked.metadata.cycles?.length)fail('namespace/cyclic graphs require a separate profile');
  const body={schema:BOUND_MODULE_SCHEDULER_PLAN_V8,sourceDigest:hashAlgorithmData(linked.source),entry:linked.entryFunction,
    modulePlan:buildModuleSchedulerPlanV8(linked.metadata),functions:functions(linked.source)};
  return {...body,digest:hashAlgorithmData(body)};
}
export function verifyBoundModuleSchedulerPlanV8(plan,{source,entry}={}){
  assertAlgorithmFields(plan,['schema','sourceDigest','entry','modulePlan','functions','digest'],'bound module plan');
  const {digest,...body}=plan;
  if(plan.schema!==BOUND_MODULE_SCHEDULER_PLAN_V8||hashAlgorithmData(body)!==digest||
    typeof plan.entry!=='string'||!plan.entry||!/^[0-9a-f]{64}$/.test(plan.sourceDigest))fail('plan envelope');
  verifyModuleSchedulerPlanV8(plan.modulePlan);
  assertAlgorithmFields(plan.functions,[...Object.keys(MODULE_SCHEDULER_FUNCTIONS_V8),'fulfilled','rejected'],'module functions');
  if(Object.entries(MODULE_SCHEDULER_FUNCTIONS_V8).some(([key,value])=>plan.functions[key]!==value)||
    !/^function:\d+$/.test(plan.functions.fulfilled)||!/^function:\d+$/.test(plan.functions.rejected)||
    plan.functions.fulfilled===plan.functions.rejected)fail('source function identities');
  if(source!==undefined&&(hashAlgorithmData(source)!==plan.sourceDigest||entry!==plan.entry||
    hashAlgorithmData(functions(source))!==hashAlgorithmData(plan.functions)))fail('plan differs from active source program');
  if(source!==undefined)sourceModuleRecords(source,plan.modulePlan);
  return plan;
}
