// Bounded public-source proofs for whole, effect-free invocation regions.
// This module never executes guest source, reads a teacher archive, or consults
// a future observation. Every operation is an explicit primitive rule.
import {parse} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {encode,decode} from '../values.js';
import {evaluateWitnessExpression} from './witness-check.js';

const ensure=(ok,message)=>{if(!ok)throw new TypeError('Semantic region: '+message);};
const span=node=>({start:node.start,end:node.end});
const named=(node,name)=>node?.type==='Identifier'&&node.name===name;
const zero=node=>node?.type==='Literal'&&node.value===0;
const binary=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=','&','|','^','<<','>>','>>>']);
const unary=new Set(['!','+','-','~','typeof','void']);
const scalar=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint'].includes(value[0]);
const bodyOf=fn=>fn.body.body.filter(node=>node.directive!=='use strict');

export function inspectSemanticRegion(source,entry){
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  ensure(ast.body[0]?.directive==='use strict','explicit strict source required');
  ensure(ast.body.every(node=>node.type==='FunctionDeclaration'||node.directive==='use strict'),
    'top-level initialization is outside the region');
  const declarations=ast.body.filter(node=>node.type==='FunctionDeclaration');
  const functions=new Map(declarations.map(node=>[node.id.name,node]));
  ensure(functions.size===declarations.length&&functions.has(entry),'unambiguous named entry required');
  const ordinary=fn=>{
    ensure(fn&&!fn.async&&!fn.generator&&fn.params.every(node=>node.type==='Identifier'),
      'ordinary functions with simple parameters required');
    ensure(new Set(fn.params.map(node=>node.name)).size===fn.params.length,'distinct parameters required');
  };
  const fn=functions.get(entry);ordinary(fn);
  const parameters=fn.params.map(node=>node.name),body=bodyOf(fn);
  const budget={nodes:0,operators:0,calls:0},decisionSites=[];
  function inspect(node,names,stack){
    ensure(++budget.nodes<=32,'expression node bound exceeded');
    if(node?.type==='Literal'){
      ensure(!node.regex&&(node.value===null||['number','boolean','string','bigint'].includes(typeof node.value)),
        'only primitive literals can be summarized');return;
    }
    if(node?.type==='Identifier'){ensure(names.has(node.name),'uncommitted or ambient binding');return;}
    if(node?.type==='UnaryExpression'&&node.prefix&&unary.has(node.operator)){
      ensure(++budget.operators<=8,'operator bound exceeded');inspect(node.argument,names,stack);return;
    }
    if(node?.type==='BinaryExpression'&&binary.has(node.operator)){
      ensure(++budget.operators<=8,'operator bound exceeded');
      inspect(node.left,names,stack);inspect(node.right,names,stack);return;
    }
    if(node?.type==='ConditionalExpression'){
      ensure(++budget.operators<=8,'operator bound exceeded');
      decisionSites.push({site:span(node.test),source:span(node),kind:'conditional'});
      for(const child of [node.test,node.consequent,node.alternate])inspect(child,names,stack);return;
    }
    if(node?.type==='LogicalExpression'&&['&&','||','??'].includes(node.operator)){
      ensure(++budget.operators<=8,'operator bound exceeded');
      decisionSites.push({site:span(node),source:span(node),kind:'logical',operator:node.operator});
      inspect(node.left,names,stack);inspect(node.right,names,stack);return;
    }
    if(node?.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&
       !names.has(node.callee.name)&&functions.has(node.callee.name)){
      const callee=functions.get(node.callee.name);ordinary(callee);
      ensure(!stack.includes(callee.id.name)&&++budget.calls<=4,'recursive or excessive helper calls');
      ensure(node.arguments.length===callee.params.length,'exact helper arity required');
      for(const argument of node.arguments)inspect(argument,names,stack);
      const body=bodyOf(callee);
      ensure(body.length===1&&body[0].type==='ReturnStatement'&&body[0].argument,
        'helper must return one bounded primitive expression');
      inspect(body[0].argument,new Set(callee.params.map(node=>node.name)),[...stack,callee.id.name]);return;
    }
    throw new TypeError('Semantic region: observable or unsupported expression');
  }
  if(body.length===1&&body[0].type==='ReturnStatement'&&body[0].argument){
    inspect(body[0].argument,new Set(parameters),[entry]);
    return {profile:decisionSites.length?'pure-control-helper/1':'pure-helper/1',entry,
      parameters,region:span(fn),expression:body[0].argument,functions,decisionSites,budget};
  }
  ensure(parameters.length===1&&body.length===3,'not a supported pure region');
  const [initial,loop,returned]=body;
  ensure(initial.type==='VariableDeclaration'&&initial.kind==='let'&&initial.declarations.length===1&&
    initial.declarations[0].id.type==='Identifier'&&zero(initial.declarations[0].init),
    'sum requires a zero-initialized accumulator');
  const accumulator=initial.declarations[0].id.name;
  ensure(loop.type==='ForStatement'&&loop.init?.type==='VariableDeclaration'&&loop.init.kind==='let'&&
    loop.init.declarations.length===1&&loop.init.declarations[0].id.type==='Identifier'&&
    zero(loop.init.declarations[0].init),'sum requires a zero-initialized counted loop');
  const index=loop.init.declarations[0].id.name;
  ensure(new Set([parameters[0],accumulator,index]).size===3,'sum bindings must be distinct');
  ensure(loop.test?.type==='BinaryExpression'&&loop.test.operator==='<'&&named(loop.test.left,index)&&
    loop.test.right.type==='MemberExpression'&&!loop.test.right.computed&&!loop.test.right.optional&&
    named(loop.test.right.object,parameters[0])&&named(loop.test.right.property,'length'),
    'sum bound must be the unchanged array length');
  ensure(loop.update?.type==='UpdateExpression'&&loop.update.operator==='++'&&!loop.update.prefix&&
    named(loop.update.argument,index),'sum requires a single postfix index increment');
  ensure(loop.body.type==='BlockStatement'&&loop.body.body.length===1&&
    loop.body.body[0].type==='ExpressionStatement','sum body contains additional statements');
  const addition=loop.body.body[0].expression;
  ensure(addition.type==='AssignmentExpression'&&addition.operator==='+='&&named(addition.left,accumulator)&&
    addition.right.type==='MemberExpression'&&addition.right.computed&&!addition.right.optional&&
    named(addition.right.object,parameters[0])&&named(addition.right.property,index),
    'sum body must add exactly the current array element');
  ensure(returned.type==='ReturnStatement'&&named(returned.argument,accumulator),
    'sum must return its accumulator without further work');
  return {profile:'dense-array-sum/1',entry,parameters,region:span(fn),functions,
    decisionSites:[],budget,loop:{...span(loop),accumulator,index,test:span(loop.test),addition:span(addition)}};
}

export function evaluateSemanticRegion(region,args,{heap=new Map(),maxIterations=128}={}){
  ensure(Array.isArray(args)&&args.length===region.parameters.length,'exact entry arguments required');
  if(region.loop){
    ensure(args[0]?.[0]==='ref','sum requires one ordinary dense array');
    const node=heap.get(args[0][1]);
    ensure(node?.kind==='array'&&node.properties instanceof Map,'sum input is not an ordinary array');
    const length=node.properties.get('length');
    ensure(length?.[0]==='num'&&Number.isSafeInteger(length[1])&&length[1]>=0&&length[1]<=maxIterations,
      'sum iteration bound exceeded');
    ensure(node.properties.size===length[1]+1,'sum refuses holes or extra properties');
    let total=0;
    for(let i=0;i<length[1];i++){
      const value=node.properties.get(String(i));
      ensure(value?.[0]==='num'&&Number.isFinite(decode(value)),
        'sum requires dense finite numeric values');
      total+=decode(value);
    }
    return {result:encode(total),iterations:length[1],accumulator:region.loop.accumulator};
  }
  ensure(args.every(scalar),'pure helper arguments must be primitive values');
  const decisions=[];
  const primitive=node=>({op:'literal',value:node});
  function evaluate(node,locals){
    if(node.type==='Literal')return encode(node.value);
    if(node.type==='Identifier')return locals.get(node.name);
    if(node.type==='UnaryExpression')return evaluateWitnessExpression({op:'unary',operator:node.operator,
      arg:primitive(evaluate(node.argument,locals))}).value;
    if(node.type==='BinaryExpression')return evaluateWitnessExpression({op:'binary',operator:node.operator,
      left:primitive(evaluate(node.left,locals)),right:primitive(evaluate(node.right,locals))}).value;
    if(node.type==='ConditionalExpression'){
      const chosen=Boolean(decode(evaluate(node.test,locals)));
      decisions.push({site:span(node.test),selected:chosen?'consequent':'alternate'});
      return evaluate(chosen?node.consequent:node.alternate,locals);
    }
    if(node.type==='LogicalExpression'){
      const left=evaluate(node.left,locals),value=decode(left);
      const right=node.operator==='&&'?Boolean(value):node.operator==='||'?!value:value===null||value===undefined;
      decisions.push({site:span(node),selected:right?'right':'left'});
      return right?evaluate(node.right,locals):left;
    }
    const fn=region.functions.get(node.callee.name);
    const values=node.arguments.map(argument=>evaluate(argument,locals));
    return evaluate(bodyOf(fn)[0].argument,new Map(fn.params.map((param,i)=>[param.name,values[i]])));
  }
  const result=evaluate(region.expression,new Map(region.parameters.map((name,i)=>[name,args[i]])));
  return {result,...(region.profile==='pure-control-helper/1'?{decisions}:{})};
}

export function checkSemanticRegionClaim(source,entry,inputArguments,claim,environment={}){
  ensure(claim.entry===entry&&isDeepStrictEqual(claim.arguments,inputArguments),
    'claim must use the current entry and exact committed input arguments');
  const region=inspectSemanticRegion(source,entry);
  ensure(claim.profile===region.profile,'profile differs from the public source');
  const expected=evaluateSemanticRegion(region,inputArguments,environment);
  const compared={result:claim.result,...(region.loop?{iterations:claim.iterations,accumulator:claim.accumulator}:{}),
    ...(region.profile==='pure-control-helper/1'?{decisions:claim.decisions}:{})};
  return {consistent:isDeepStrictEqual(compared,expected),claimed:compared,expected,
    profile:region.profile,sourceRegion:region.region,
    ...(isDeepStrictEqual(compared,expected)?{}:{reason:'Region result, executed control path, or loop relation is false'})};
}
