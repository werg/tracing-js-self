// Source-defined, local abstraction boundaries. Eligibility only inspects
// committed owned values; it never invokes a getter, iterator or guest hook.
import {parse} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {encode} from '../values.js';
import {evaluateWitnessExpression} from '../training/witness-check.js';
import {hashAlgorithmData} from './program.js';
import {verifyExperimentalModuleNamespacePlan} from './module-namespace-state-v8.js';
import {verifyBoundModuleSchedulerPlanV8} from './module-scheduler-plan-v8.js';
import {assertAlgorithmFields,assertAlgorithmValue,stableAlgorithmJSON} from './ir.js';
import {tryLowerJavaScriptV8} from './lower-v8.js';

export const REGION_PROGRAM_VERSION='semantic-region-program/1';
export const REGION_EXECUTION_VERSION='semantic-execution/8';
export const REGION_TRACE_VERSION='semantic-trace/8';
export const REGION_CONTEXT_VERSION='semantic-context/8';
export const REGION_CONTINUATION_VERSION='semantic-continuation/8';
export const REGION_PROFILE='compositional-regions/1';
export const REGION_LIMITS=Object.freeze({operations:16,nodes:128,depth:16,regions:256});
const binary=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=','&','|','^','<<','>>','>>>']);
const unary=new Set(['!','+','-','~','typeof','void']);
const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
const copy=structuredClone;
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint'].includes(value[0]);
function refuse(message){const error=new TypeError('Local region: '+message);error.category='unsupported.region-profile';throw error;}
function children(node,visit){
  for(const [key,value] of Object.entries(node??{}))if(!['start','end','loc','raw'].includes(key)){
    if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
    else if(value?.type)visit(value);
  }
}
function walk(node,visit){if(!node?.type)return;visit(node);children(node,child=>walk(child,visit));}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

/** Conservative, machine-readable effect/identity footprint, not a purity guess. */
export function analyzeRegionEffects(node){
  const reads=new Set(),writes=new Set(),calls=new Set();
  let mayThrow=false,maySuspend=false,allocates=false,identityEscapes=false,cleanup=false,propertyAccess=false;
  walk(node,current=>{
    if(current.type==='Identifier')reads.add(current.name);
    if(current.type==='VariableDeclarator'&&current.id.type==='Identifier')writes.add(current.id.name);
    if(['AssignmentExpression','UpdateExpression'].includes(current.type)){
      const target=current.left??current.argument;
      if(target.type==='Identifier')writes.add(target.name);else {propertyAccess=true;mayThrow=true;}
    }
    if(['CallExpression','NewExpression','TaggedTemplateExpression'].includes(current.type)){
      const callee=current.callee??current.tag;
      calls.add(callee?.type==='Identifier'?callee.name:'guest-or-hook');mayThrow=true;
    }
    if(['MemberExpression','ChainExpression'].includes(current.type)){propertyAccess=true;mayThrow=true;}
    if(['ArrayExpression','ObjectExpression','NewExpression',...functions].includes(current.type))allocates=true;
    if(['ThrowStatement','BinaryExpression','UnaryExpression'].includes(current.type))mayThrow=true;
    if(['AwaitExpression','YieldExpression'].includes(current.type))maySuspend=true;
    if(current.type==='ReturnStatement')identityEscapes=true;
    if(current.type==='TryStatement'&&current.finalizer||['ForOfStatement','ForInStatement'].includes(current.type))cleanup=true;
  });
  return {reads:[...reads].sort(),writes:[...writes].sort(),calls:[...calls].sort(),
    mayThrow,maySuspend,allocates,identityEscapes,cleanup,propertyAccess};
}

function expression(node,budget={nodes:0},depth=0){
  if(!node||++budget.nodes>REGION_LIMITS.nodes||depth>REGION_LIMITS.depth)refuse('expression bound');
  if(node.type==='Literal'&&!node.regex){
    const value=encode(node.value);if(!scalar(value))refuse('nonprimitive literal');
    return {op:'literal',value};
  }
  if(node.type==='Identifier')return node.name==='undefined'?{op:'literal',value:['undefined']}:{op:'local',name:node.name};
  if(node.type==='UnaryExpression'&&unary.has(node.operator))return {op:'unary',operator:node.operator,arg:expression(node.argument,budget,depth+1)};
  if(node.type==='BinaryExpression'&&binary.has(node.operator))return {op:'binary',operator:node.operator,
    left:expression(node.left,budget,depth+1),right:expression(node.right,budget,depth+1)};
  if(node.type==='LogicalExpression'&&['&&','||','??'].includes(node.operator))return {op:'logical',operator:node.operator,
    left:expression(node.left,budget,depth+1),right:expression(node.right,budget,depth+1)};
  if(node.type==='ConditionalExpression')return {op:'select',test:expression(node.test,budget,depth+1),
    consequent:expression(node.consequent,budget,depth+1),alternate:expression(node.alternate,budget,depth+1)};
  refuse('expression requires detailed property, call, allocation or completion semantics');
}
function statements(node){
  if(node.type==='VariableDeclaration')return node.declarations.map(decl=>{
    if(decl.id.type!=='Identifier')refuse('binding pattern');
    return {kind:'bind',binding:decl.id.name,term:decl.init?expression(decl.init):{op:'literal',value:['undefined']}};
  });
  if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
    const item=node.expression;if(item.left.type!=='Identifier')refuse('visible object mutation');
    const term=expression(item.right),operator=item.operator.slice(0,-1);
    if(item.operator!=='='&&!binary.has(operator))refuse('assignment operator');
    return [{kind:'bind',binding:item.left.name,term:item.operator==='='?term:
      {op:'binary',operator,left:{op:'local',name:item.left.name},right:term}}];
  }
  if(node.type==='ReturnStatement')return [{kind:'return',term:node.argument?expression(node.argument):{op:'literal',value:['undefined']}}];
  refuse('statement requires a detailed boundary');
}
function termLocals(term,result=new Set()){
  if(term?.op==='local')result.add(term.name);
  for(const child of Object.values(term??{}))if(child&&typeof child==='object'&&!Array.isArray(child))termLocals(child,result);
  return result;
}

/** Definitions depend only on source. Source spans are kept in private provenance. */
export function defineRegionProgram({source,entry,moduleNamespacePlan,moduleSchedulerPlan}={}){
  if(typeof source!=='string'||typeof entry!=='string')refuse('exact source and entry required');
  if(moduleSchedulerPlan!==undefined){
    if(moduleNamespacePlan!==undefined)refuse('module scheduler/namespace composition requires its own profile');
    verifyBoundModuleSchedulerPlanV8(moduleSchedulerPlan,{source,entry});
  }
  if(moduleNamespacePlan!==undefined){
    verifyExperimentalModuleNamespacePlan(moduleNamespacePlan);
    if(moduleNamespacePlan.namespaces.length===0)refuse('module namespace source plan cannot be empty');
  }
  const ast=parse(source,{ecmaVersion:2026,sourceType:'script'}),declared=[];
  if(ast.body[0]?.directive!=='use strict')refuse('explicit strict source required');
  walk(ast,node=>{if(functions.has(node.type)&&node.body.type==='BlockStatement')declared.push(node);});
  if(!declared.some(fn=>fn.type==='FunctionDeclaration'&&fn.id.name===entry))refuse('entry function missing');
  const regions=[],locations=[];
  const globalBindings=new Map();
  walk(ast,node=>{
    const names=node.type==='VariableDeclarator'&&node.id.type==='Identifier'?[node.id.name]:
      functions.has(node.type)?node.params.filter(item=>item.type==='Identifier').map(item=>item.name):
      node.type==='CatchClause'&&node.param?.type==='Identifier'?[node.param.name]:[];
    for(const name of names)globalBindings.set(name,(globalBindings.get(name)??0)+1);
  });
  for(const fn of declared){
    const owner=fn.type==='FunctionDeclaration'?fn.id.name:'function:'+fn.start;
    // The current selected compiler allocates shadowed cells dynamically. A
    // repeated binding needs a lexical mapping, so it stays detailed here.
    const counts=new Map(),mutable=new Set(fn.params.filter(param=>param.type==='Identifier').map(param=>param.name));
    for(const param of fn.params)if(param.type==='Identifier')counts.set(param.name,(counts.get(param.name)??0)+1);
    const bindNames=node=>{
      if(node!==fn.body&&functions.has(node.type))return;
      if(node.type==='VariableDeclarator'&&node.id.type==='Identifier')counts.set(node.id.name,(counts.get(node.id.name)??0)+1);
      if(node.type==='VariableDeclaration'&&node.kind!=='const')for(const decl of node.declarations)
        if(decl.id.type==='Identifier')mutable.add(decl.id.name);
      if(node.type==='CatchClause'&&node.param?.type==='Identifier')counts.set(node.param.name,(counts.get(node.param.name)??0)+1);
      children(node,bindNames);
    };bindNames(fn.body);
    const ambiguous=new Set([...globalBindings].filter(([,count])=>count>1).map(([name])=>name));
    let pending=[],nodes=[];
    const flush=()=>{
      if(!pending.length)return;
      const inputs=new Set(),outputs=new Set();
      for(const step of pending){for(const name of termLocals(step.term))if(!outputs.has(name))inputs.add(name);
        if(step.binding)outputs.add(step.binding);}
      const body={id:'r'+regions.length,owner,kind:'compact',profile:'local-primitive-block/1',
        inputs:[...inputs],outputs:[...outputs],operations:pending,
        effects:{reads:[...inputs],writes:[...outputs],calls:[],mayThrow:true,maySuspend:false,
          allocates:false,identityEscapes:false,cleanup:false,propertyAccess:false},
        completion:pending.at(-1).kind==='return'?'return':'normal',obligations:[]};
      regions.push({...body,digest:hashAlgorithmData(body)});
      locations.push({id:body.id,start:nodes[0].start,end:nodes.at(-1).end,
        statements:nodes.map(node=>({start:node.start,end:node.end}))});pending=[];nodes=[];
    };
    for(const node of fn.body.body){
      let steps;try{steps=statements(node);
        if(steps.some(step=>ambiguous.has(step.binding)||[...termLocals(step.term)].some(name=>ambiguous.has(name))))steps=null;
        if(node.type==='ExpressionStatement'&&!mutable.has(node.expression.left.name))steps=null;
        if(globalBindings.has('undefined'))walk(node,item=>{if(item.type==='Identifier'&&item.name==='undefined')steps=null;});
      }catch{steps=null;}
      if(!steps){flush();continue;}
      if(pending.length+steps.length>REGION_LIMITS.operations)flush();
      pending.push(...steps);nodes.push(node);if(steps.at(-1)?.kind==='return')flush();
    }
    flush();
  }
  if(regions.length>REGION_LIMITS.regions)refuse('region count bound');
  const lowered=tryLowerJavaScriptV8({source,entry});
  const body={schema:REGION_PROGRAM_VERSION,traceFormat:REGION_TRACE_VERSION,profile:REGION_PROFILE,
    source,entry,sourceDigest:hashAlgorithmData(source),regions,algorithm:lowered.status==='lowered'?lowered.core:null,
    ...(moduleNamespacePlan!==undefined?{moduleNamespacePlan:copy(moduleNamespacePlan)}:{}),
    ...(moduleSchedulerPlan!==undefined?{moduleSchedulerPlan:copy(moduleSchedulerPlan)}:{})};
  return {program:freeze({...body,definitionDigest:hashAlgorithmData(body)}),
    provenance:{schema:'semantic-region-provenance/1',locations}};
}
export function validateRegionProgram(program){
  const fields=['schema','traceFormat','profile','source','entry','sourceDigest','regions','algorithm','definitionDigest'];
  if(Object.hasOwn(program??{},'moduleNamespacePlan'))fields.push('moduleNamespacePlan');
  if(Object.hasOwn(program??{},'moduleSchedulerPlan'))fields.push('moduleSchedulerPlan');
  assertAlgorithmFields(program,fields,'region program');
  const expected=defineRegionProgram(program).program;
  if(!isDeepStrictEqual(program,expected))throw new TypeError('Region source or immutable definition changed');
  return true;
}

export function sharedRegionState(controller){
  const packet=controller.segmentPacket();
  const fields=['heap','locals','stack','effects','jobs','ready','randomState','pending','lastReturn','completion',
    'receiver','captureAliases','continuations','reactionSequence','blockedSync','callReturn','activeJob','scheduler',
    'frameFunctions','jobErrors'];
  const result=Object.fromEntries(fields.map(key=>[key,copy(packet[key])]));
  result.heap=[...controller.heap].map(([id,node])=>[id,{...copy(node),properties:copy([...node.properties]),
    ...(node.descriptors instanceof Map?{descriptors:copy([...node.descriptors])}:{}),
    ...(node.privateElements instanceof Map?{privateElements:copy([...node.privateElements])}:{})}]);
  result.protocol=copy(controller.protocol??null);
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>controller.maxPacketBytes)
    throw new RangeError('Shared region state exceeds the committed continuation byte bound');
  return result;
}
/** Transactional staging preserves the same value types as the live machine. */
export function cloneRegionController(controller){
  return Object.assign(Object.create(Object.getPrototypeOf(controller)),copy(controller));
}
export function regionEntry(program,region,controller,cutoff){
  return {definition:program.definitionDigest,region:region.id,regionDigest:region.digest,
    visibleThrough:cutoff,stateDigest:hashAlgorithmData(sharedRegionState(controller))};
}
const literal=value=>({op:'literal',value});
function truth(value){if(value[0]==='ref')return true;
  return evaluateWitnessExpression({op:'unary',operator:'!',arg:literal(value)}).value[1]===false;}

/** Stage an entire pure block against a copy. Failure precedes every mutation. */
export function evaluateLocalRegion(region,controller){
  if(region?.profile!=='local-primitive-block/1')refuse('unknown compact region profile');
  const active=controller.stack.at(-1),owner=controller.frameFunctions.get(active);
  if(owner!==region.owner)refuse('region belongs to another active function');
  if(active!==controller.rootInvocation)refuse('nested frame bindings require an explicit lexical region map');
  if(controller.blockedSync||controller.completion||!active)refuse('region is not runnable');
  const locals=new Map([...controller.visibleLocals()].map(([key,value])=>[key,copy(value)]));
  for(const name of region.inputs){if(!locals.has(name))refuse('live input is unavailable: '+name);
    if(!scalar(locals.get(name)))refuse('reference input requires detailed coercion/identity handling');}
  const decisions=[],bindings=[],records=[];
  let completion={kind:'normal'};
  function evaluate(term){
    if(term.op==='literal')return copy(term.value);
    if(term.op==='local'){if(!locals.has(term.name))refuse('unbound local '+term.name);return copy(locals.get(term.name));}
    if(term.op==='select'){
      const decision=evaluate(term.test),selected=truth(decision)?'consequent':'alternate';
      decisions.push({kind:'select',selected});return evaluate(term[selected]);
    }
    if(term.op==='logical'){
      const left=evaluate(term.left),right=term.operator==='??'?['undefined','null'].includes(left[0]):
        term.operator==='&&'?truth(left):!truth(left);
      decisions.push({kind:term.operator,selected:right?'right':'left'});return right?evaluate(term.right):left;
    }
    const expr=term.op==='unary'?{op:'unary',operator:term.operator,arg:literal(evaluate(term.arg))}:
      {op:'binary',operator:term.operator,left:literal(evaluate(term.left)),right:literal(evaluate(term.right))};
    return evaluateWitnessExpression(expr).value;
  }
  for(const step of region.operations){
    const value=evaluate(step.term);assertAlgorithmValue(value,{allowReference:false});
    if(step.kind==='bind'){
      locals.set(step.binding,copy(value));bindings.push([step.binding,copy(value)]);
      // The independently evaluated compound body authorizes this local cell
      // transition. Detailed execution then uses the very same binding map.
      records.push({kind:'bind',fields:{name:step.binding,value:copy(value),invocation:active}});
    }else if(step.kind==='return'){
      completion={kind:'return',value:copy(value)};
      records.push({kind:'return',fields:{value:copy(value),invocation:active}});
    }else refuse('unknown local completion');
  }
  return {bindings,decisions,completion,records};
}

export function encodeRegionRecord(record){
  assertAlgorithmFields(record,['region','bindings','decisions','completion'],'region record');
  if(!/^r\d+$/.test(record.region))throw new TypeError('Invalid compact region identity');
  for(const binding of record.bindings){if(!Array.isArray(binding)||binding.length!==2||typeof binding[0]!=='string')throw new TypeError('Invalid region binding');
    assertAlgorithmValue(binding[1],{allowReference:false});}
  if(!['normal','return'].includes(record.completion?.kind))throw new TypeError('Invalid region completion');
  assertAlgorithmFields(record.completion,record.completion.kind==='normal'?['kind']:['kind','value'],'region completion');
  if(record.completion.kind==='return')assertAlgorithmValue(record.completion.value,{allowReference:false});
  const line='region '+stableAlgorithmJSON(record);if(Buffer.byteLength(line)>65536)throw new TypeError('Region record byte bound');
  return line;
}
export function decodeRegionRecord(line){
  if(typeof line!=='string'||!line.startsWith('region ')||/[\r\n]/.test(line)||Buffer.byteLength(line)>65536)throw new TypeError('Canonical region record required');
  let record;try{record=JSON.parse(line.slice(7));}catch{throw new TypeError('Region record JSON');}
  if(encodeRegionRecord(record)!==line)throw new TypeError('Noncanonical region record');return record;
}
