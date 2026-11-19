// A deliberately narrow scheduling profile: one scalar host call at a time,
// with each asynchronous call immediately awaited. No callbacks, catches,
// finally blocks, shared state, or detached work are silently abstracted.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {BINARY_OPERATIONS,UNARY_OPERATIONS,encodeAlgorithmScalar} from './operations.js';
import {normalizeAlgorithm} from './normalize-algorithm.js';
import {validateAlgorithm} from './ir.js';
import {hostOperation} from '../host/operations.js';

export const SERIAL_EFFECT_PROFILE='serial-scalar-effects/1';
const copy=value=>structuredClone(value);
const hash=text=>createHash('sha256').update(text).digest('hex');
const sourceSpan=node=>({start:node.start,end:node.end});
function refuse(message){
  const error=new TypeError('Algorithm effect lowering: '+message);
  error.category='unsupported.algorithm-profile';throw error;
}
const directCall=node=>node?.type==='CallExpression'&&!node.optional&&
  node.callee.type==='MemberExpression'&&!node.callee.computed&&!node.callee.optional&&
  node.callee.object.type==='Identifier'&&node.callee.object.name==='host'&&
  node.callee.property.type==='Identifier';

export function lowerEffectfulJavaScript({source,entry}={}){
  if(typeof source!=='string'||typeof entry!=='string')refuse('source and entry are required');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  if(ast.body[0]?.directive!=='use strict')refuse('explicit strict source is required');
  if(ast.body.some(node=>node.type!=='FunctionDeclaration'&&
      !(node.type==='ExpressionStatement'&&node.directive==='use strict')))
    refuse('top-level work or retained state requires detailed execution');
  const functions=ast.body.filter(node=>node.type==='FunctionDeclaration');
  if(new Set(functions.map(fn=>fn.id.name)).size!==functions.length||functions.some(fn=>fn.id.name==='host'))
    refuse('duplicate function bindings');
  const fn=functions.find(node=>node.id.name===entry);
  if(!fn||!fn.async||fn.generator||fn.params.some(param=>param.type!=='Identifier'))
    refuse('a simple asynchronous entry is required');
  const names=fn.params.map(param=>param.name);
  if(new Set(names).size!==names.length||names.includes('host')||names.includes(entry))
    refuse('ambiguous or shadowed entry bindings');
  const inputs=names.map((name,index)=>({id:'a'+index,type:'scalar'}));
  const scope=new Map(names.map((name,index)=>[name,{op:'input',id:'a'+index}]));
  const steps=[],boundaries=[],regions=[];
  let nextValue=0,nextRequest=0,ended=false,nodes=0;
  function expression(node){
    if(!node||++nodes>128)refuse('pure region node budget');
    let term;
    if(node.type==='Literal'&&!node.regex){
      if(typeof node.value==='bigint')refuse('BigInt exceptions require a detailed effect profile');
      try{term={op:'literal',value:encodeAlgorithmScalar(node.value)};}
      catch{refuse('nonprimitive literal');}
    }else if(node.type==='Identifier'&&scope.has(node.name))term=copy(scope.get(node.name));
    else if(node.type==='UnaryExpression'&&node.prefix&&UNARY_OPERATIONS[node.operator])
      term={op:UNARY_OPERATIONS[node.operator],args:[expression(node.argument)]};
    else if(node.type==='BinaryExpression'&&BINARY_OPERATIONS[node.operator])
      term={op:BINARY_OPERATIONS[node.operator],args:[expression(node.left),expression(node.right)]};
    else if(node.type==='ConditionalExpression')term={op:'select',args:
      [expression(node.test),expression(node.consequent),expression(node.alternate)]};
    else if(node.type==='LogicalExpression'&&['&&','||','??'].includes(node.operator))
      term={op:{'&&':'and','||':'or','??':'coalesce'}[node.operator],args:[expression(node.left),expression(node.right)]};
    else refuse('uncertified expression, capture, helper, or data hook');
    // No sampled value, inferred observation type, dead-code removal, or
    // helper argument substitution can erase a potential exception here.
    regions.push({rule:'bounded-pure-region/1',source:sourceSpan(node),
      liveInputs:[...scope.keys()],term:copy(term)});
    return term;
  }
  function call(node,awaited){
    if(!directCall(node))refuse('only direct certified host calls may cross an effect boundary');
    const operation='demo.'+node.callee.property.name;
    if(!['demo.readAsync','demo.store'].includes(operation))
      refuse('operation is outside the serial counter profile');
    const spec=hostOperation(operation);
    if((spec.kind==='promise')!==awaited)
      refuse('asynchronous calls must be immediately awaited; synchronous calls must not be awaited');
    if(node.arguments.length!==spec.arity||node.arguments.some(arg=>arg.type==='SpreadElement'))
      refuse('exact host argument arity is required');
    const id='r'+nextRequest++,boundary='b'+boundaries.length,value='v'+nextValue++;
    const args=node.arguments.map(expression);
    steps.push({kind:'request',id,boundary,operation,arguments:args});
    steps.push({kind:'observe',id:value,request:id});
    boundaries.push({id:boundary,request:id,operation,source:sourceSpan(node),
      awaited,sourceDigest:hash(source),capability:operation,
      observationDomain:'non-bigint-scalar/1'});
    return {op:'ref',id:value};
  }
  function value(node){
    if(node?.type==='AwaitExpression')return call(node.argument,true);
    if(directCall(node))return call(node,false);
    return expression(node);
  }
  for(const statement of fn.body.body){
    if(statement.type==='ExpressionStatement'&&statement.directive==='use strict')continue;
    if(ended)refuse('unreachable source work is outside the serial profile');
    if(statement.type==='VariableDeclaration'&&['const','let'].includes(statement.kind)){
      for(const declaration of statement.declarations){
        if(declaration.id.type!=='Identifier'||!declaration.init||scope.has(declaration.id.name)||
            declaration.id.name==='host'||functions.some(helper=>helper.id.name===declaration.id.name))
          refuse('declarations must be fresh initialized lexical scalar bindings');
        let term=value(declaration.init);
        if(!['input','ref','literal'].includes(term.op)){
          const id='v'+nextValue++;steps.push({kind:'compute',id,term});term={op:'ref',id};
        }
        scope.set(declaration.id.name,term);
      }
    }else if(statement.type==='ExpressionStatement'&&directCall(statement.expression)){
      call(statement.expression,false);
    }else if(statement.type==='ExpressionStatement'&&statement.expression.type==='AwaitExpression'){
      call(statement.expression.argument,true);
    }else if(statement.type==='ReturnStatement'){
      let term=statement.argument?value(statement.argument):{op:'literal',value:['undefined']};
      if(!['input','ref','literal'].includes(term.op)){
        const id='v'+nextValue++;steps.push({kind:'compute',id,term});term={op:'ref',id};
      }
      steps.push({kind:'return',value:term});ended=true;
    }else refuse('control flow, mutation, callbacks, and cleanup retain detailed boundaries');
  }
  if(!ended||!boundaries.length)refuse('a completed effectful entry is required');
  const core=normalizeAlgorithm({schema:'semantic-algorithm/1',profile:'ecmascript-primitive/1',inputs,steps});
  validateAlgorithm(core);
  // Normalization may rename values, but semantic boundaries retain lexical
  // dispatch order and never rely on a response from the future.
  const requests=core.steps.filter(step=>step.kind==='request');
  if(requests.length!==boundaries.length)refuse('normalization changed effect multiplicity');
  const mapped=boundaries.map((boundary,index)=>({...boundary,id:requests[index].boundary,
    request:requests[index].id}));
  return {core,provenance:{schema:'semantic-lowering/1',profile:SERIAL_EFFECT_PROFILE,
    sourceDigest:hash(source),entry,source:sourceSpan(fn),regions,boundaries:mapped,
    preconditions:['non-BigInt scalar inputs and observations','one outstanding request',
      'immediate await for each promise','no callbacks or cleanup','no retained or shared state']}};
}
