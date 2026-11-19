// Source-only, bounded JavaScript lowering. No recorded answers, future host
// observations, or runtime allocation labels participate in these decisions.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {encode} from '../values.js';
import {validateAlgorithm} from './ir.js';
import {normalizeAlgorithm} from './normalize-algorithm.js';
import {BINARY_OPERATIONS,UNARY_OPERATIONS} from './operations.js';

export const JAVASCRIPT_LOWERING_VERSION='semantic-javascript-lowering/1';
const span=node=>({start:node.start,end:node.end});
const named=(node,name)=>node?.type==='Identifier'&&node.name===name;
const statements=node=>node.type==='BlockStatement'?node.body:[node];
const bodyOf=fn=>fn.body.body.filter(node=>!node.directive);
const literal=value=>({term:{op:'literal',value:encode(value)},type:
  value===null?'null':typeof value});
const primitive=value=>value&&!value.privateObject&&!value.loopIndex&&!value.array;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const UNINITIALIZED=Object.freeze({uninitialized:true});
const withoutMutation=node=>{
  if(!node||typeof node!=='object')return true;
  if(['AssignmentExpression','UpdateExpression'].includes(node.type))return false;
  return Object.values(node).every(value=>Array.isArray(value)?value.every(withoutMutation):
    !value||typeof value!=='object'||withoutMutation(value));
};

export class AlgorithmLoweringError extends TypeError {
  constructor(message,node=null){
    super('Algorithm lowering: '+message);
    this.name='AlgorithmLoweringError';
    this.category='unsupported.algorithm-lowering';
    this.disposition='detailed-fallback';
    if(node)this.site=span(node);
  }
}
const ensure=(condition,message,node)=>{if(!condition)throw new AlgorithmLoweringError(message,node);};

class Scope {
  constructor(parent=null){this.parent=parent;this.bindings=new Map();}
  declare(name,value,mutable,node){
    ensure(!this.bindings.has(name),'duplicate lexical binding',node);
    const binding={name,value,mutable,node};this.bindings.set(name,binding);return binding;
  }
  resolve(name){return this.bindings.get(name)??this.parent?.resolve(name);}
}

/**
 * Lower an explicitly strict, closed, ordinary function under a declared
 * primitive/ordinary-array domain. A refusal is an instruction to preserve the
 * detailed trace, never permission to execute source outside the owned runtime.
 * Numeric operators narrow otherwise unconstrained inputs to Number. This is a
 * public guard, not an inference from the one observed input. It makes the
 * admitted private computations total and permits safe temporary elimination.
 */
export function lowerJavaScript({source,entry,inputTypes=null,maxOperations=128,maxHelperDepth=8}={}){
  ensure(typeof source==='string'&&typeof entry==='string','source and named entry are required');
  ensure(Number.isInteger(maxOperations)&&maxOperations>0&&maxOperations<=256,'invalid operation budget');
  ensure(Number.isInteger(maxHelperDepth)&&maxHelperDepth>0&&maxHelperDepth<=16,'invalid helper depth');
  let ast;
  try{ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});}
  catch(error){throw new AlgorithmLoweringError('source parse failed: '+error.message);}
  ensure(ast.body[0]?.directive==='use strict','explicit strict source required',ast);
  ensure(ast.body.every(node=>node.type==='FunctionDeclaration'||node.directive==='use strict'),
    'top-level initialization or effects require a detailed boundary',ast);
  const declarations=ast.body.filter(node=>node.type==='FunctionDeclaration');
  const functions=new Map(declarations.map(fn=>[fn.id.name,fn]));
  ensure(functions.size===declarations.length&&functions.has(entry),'unambiguous named entry required');
  const ordinary=fn=>ensure(fn&&!fn.async&&!fn.generator&&fn.body.type==='BlockStatement'&&
    fn.params.every(param=>param.type==='Identifier')&&
    new Set(fn.params.map(param=>param.name)).size===fn.params.length,
    'ordinary functions with distinct simple parameters required',fn);
  const entryFunction=functions.get(entry);ordinary(entryFunction);
  ensure(inputTypes===null||Array.isArray(inputTypes)&&inputTypes.length===entryFunction.params.length&&
    inputTypes.every(type=>['scalar','number','dense-number-array'].includes(type)),
    'input domain must declare one supported type per parameter');
  const inputs=entryFunction.params.map((param,index)=>({id:'a'+index,type:inputTypes?.[index]??'scalar'}));
  const inputById=new Map(inputs.map(input=>[input.id,input]));
  const rules=[],sourceSites=[],hints={inputs:entryFunction.params.map(param=>param.name)};
  let nodes=0,calls=0;
  const record=(rule,node,conditions)=>{rules.push({rule,version:1,site:span(node),conditions});};
  record('lexical-alpha-normalization',entryFunction,
    ['Lexical bindings resolve by scope; semantic inputs use parameter order.','Data keys and capability names are not renamed.']);

  function scalar(value,node){ensure(primitive(value),'observable or unsupported object identity',node);return value;}
  function constrainInput(id,type,node){
    const input=inputById.get(id);ensure(input,'unknown semantic input',node);
    ensure(input.type==='scalar'||input.type===type,'incompatible input domain requirements',node);
    input.type=type;
  }
  // Proving totality is deliberately conservative. BigInt arithmetic, unknown
  // objects, coercion hooks, RNG, calls and exceptional work never disappear.
  function numeric(value,node){
    scalar(value,node);
    function visit(term){
      if(term.op==='literal')ensure(term.value[0]!=='bigint','BigInt arithmetic requires a detailed boundary',node);
      else if(term.op==='input')constrainInput(term.id,'number',node);
      else if(term.op==='fold_left')return;
      else if(term.op==='ref')ensure(term.id==='element'||/^acc\d+$/.test(term.id),'unbound numeric reference',node);
      else for(const argument of term.args??[])visit(argument);
    }
    // A previously established scalar result cannot coerce an object or a
    // BigInt, even when its own inputs are more general (e.g. typeof, equality).
    if(!['number','string','boolean','undefined','null'].includes(value.type))visit(value.term);
    ensure(value.type!=='bigint','BigInt arithmetic requires a detailed boundary',node);
    return value;
  }
  function operation(operator,args,node,{unary=false}={}){
    args.forEach(value=>scalar(value,node));
    const name=(unary?UNARY_OPERATIONS:BINARY_OPERATIONS)[operator];
    ensure(typeof name==='string','unsupported primitive operator '+operator,node);
    let type='scalar';
    if(unary){
      if(['+','-','~'].includes(operator)){numeric(args[0],node);type='number';}
      else type=operator==='!'?'boolean':operator==='typeof'?'string':'undefined';
    }else if(['===','!==','==','!=','<','<=','>','>='].includes(operator))type='boolean';
    else if(operator==='+'&&args.some(value=>value.type==='string'))type='string';
    else {args.forEach(value=>numeric(value,node));type='number';}
    sourceSites.push({kind:'operation',operation:name,site:span(node)});
    return {term:{op:name,args:args.map(value=>value.term)},type};
  }
  function privateKey(node){
    ensure(node.type==='MemberExpression'&&!node.optional,'ordinary own data access required',node);
    const key=!node.computed&&node.property.type==='Identifier'?node.property.name:
      node.computed&&node.property.type==='Literal'&&['string','number'].includes(typeof node.property.value)?String(node.property.value):null;
    ensure(key!==null&&key!=='__proto__','static ordinary data key required',node);
    return key;
  }
  function assignmentTarget(node,scope,context){
    if(node.type==='Identifier'){
      const binding=scope.resolve(node.name);
      ensure(binding&&binding.mutable&&!binding.value.uninitialized,'assignment requires an initialized mutable local binding',node);
      ensure(!binding.value?.loopIndex,'loop index may change only at the certified update',node);
      return {get:()=>binding.value,set:value=>{binding.value=value;}};
    }
    if(node.type==='MemberExpression'){
      const object=expression(node.object,scope,context);
      ensure(object.privateObject,'input or escaping object mutation requires a visible state change',node);
      const key=privateKey(node);
      ensure(object.fields.has(key),'private updates require an existing own data property',node);
      return {get:()=>object.fields.get(key),set:value=>{
        scalar(value,node);object.fields.set(key,value);
        record('private-object-scalar-replacement',node,
          ['Fresh ordinary data object.','All aliases remain local.','No getter, prototype hook, callback capture, or effect exposure.']);
      }};
    }
    throw new AlgorithmLoweringError('unsupported assignment target',node);
  }
  function expression(node,scope,context){
    ensure(node&&++nodes<=maxOperations,'expression budget exceeded',node??entryFunction);
    if(node.type==='Literal'){
      ensure(!node.regex&&(node.value===null||['number','string','boolean','bigint'].includes(typeof node.value)),
        'only primitive literals are admitted',node);
      return literal(node.value);
    }
    if(node.type==='Identifier'){
      const binding=scope.resolve(node.name);
      ensure(binding&&!binding.value.uninitialized,'ambient, uninitialized, or captured binding '+node.name,node);
      return binding.value;
    }
    if(node.type==='UnaryExpression'&&node.prefix)return operation(node.operator,
      [expression(node.argument,scope,context)],node,{unary:true});
    if(node.type==='BinaryExpression')return operation(node.operator,
      [expression(node.left,scope,context),expression(node.right,scope,context)],node);
    if(node.type==='ConditionalExpression'){
      ensure(withoutMutation(node.consequent)&&withoutMutation(node.alternate),
        'lazy alternatives cannot mutate private state without a join proof',node);
      const args=[node.test,node.consequent,node.alternate].map(child=>scalar(expression(child,scope,context),child));
      return {term:{op:'select',args:args.map(value=>value.term)},
        type:args[1].type===args[2].type?args[1].type:'scalar'};
    }
    if(node.type==='LogicalExpression'&&['&&','||','??'].includes(node.operator)){
      ensure(withoutMutation(node),'short-circuit mutation requires a state join proof',node);
      const args=[node.left,node.right].map(child=>scalar(expression(child,scope,context),child));
      return {term:{op:{'&&':'and','||':'or','??':'coalesce'}[node.operator],args:args.map(value=>value.term)},
        type:args[0].type===args[1].type?args[0].type:'scalar'};
    }
    if(node.type==='ObjectExpression'){
      const fields=new Map();
      for(const property of node.properties){
        ensure(property.type==='Property'&&property.kind==='init'&&!property.method&&!property.computed,
          'private objects require ordinary static data properties',property);
        const key=property.key.type==='Identifier'?property.key.name:
          property.key.type==='Literal'?String(property.key.value):null;
        ensure(key!==null&&key!=='__proto__'&&!fields.has(key),'private object key is not ordinary or unique',property);
        fields.set(key,scalar(expression(property.value,scope,context),property.value));
      }
      record('private-object-scalar-replacement',node,
        ['Fresh ordinary object literal.','No methods, accessors, spread, or prototype override.','All field values are primitive.']);
      return {privateObject:true,fields};
    }
    if(node.type==='MemberExpression'&&!node.optional){
      const object=expression(node.object,scope,context);
      if(object.privateObject){
        const key=privateKey(node);
        ensure(object.fields.has(key),'private reads require an existing own data property',node);
        return object.fields.get(key);
      }
      if(context.loop&&object.term?.op==='input'&&object.term.id===context.loop.inputId&&node.computed&&
        node.property.type==='Identifier'&&scope.resolve(node.property.name)?.value?.loopIndex)
        return {term:{op:'ref',id:'element'},type:'number'};
      throw new AlgorithmLoweringError('input property access, hooks, or unsupported traversal require a detailed boundary',node);
    }
    if(node.type==='AssignmentExpression'){
      const target=assignmentTarget(node.left,scope,context),previous=target.get();
      const right=expression(node.right,scope,context);
      const value=node.operator==='='?right:operation(node.operator.slice(0,-1),[previous,right],node);
      ensure(node.operator==='='||node.operator.endsWith('=')&&!['&&=','||=','??='].includes(node.operator),
        'unsupported assignment operator',node);
      target.set(value);return value;
    }
    if(node.type==='UpdateExpression'&&['++','--'].includes(node.operator)){
      const target=assignmentTarget(node.argument,scope,context),previous=scalar(target.get(),node);
      numeric(previous,node);
      // ++/-- perform ToNumeric before adding, and postfix returns that
      // converted old value. A string field must never turn into concatenation.
      const converted=previous.type==='number'||previous.term?.op==='input'?previous:
        operation('+',[previous],node,{unary:true});
      const value=operation(node.operator==='++'?'+':'-',[{...converted,type:'number'},literal(1)],node);
      target.set(value);return node.prefix?value:converted;
    }
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'){
      ensure(!scope.resolve(node.callee.name)&&functions.has(node.callee.name),
        'unknown, shadowed, or effectful call requires a boundary',node);
      const fn=functions.get(node.callee.name);ordinary(fn);
      ensure(node.arguments.length===fn.params.length&&!node.arguments.some(arg=>arg.type==='SpreadElement'),
        'pure helper requires exact argument arity',node);
      ensure(!context.stack.includes(fn.id.name)&&context.stack.length<maxHelperDepth&&++calls<=32,
        'recursive or excessive helper expansion',node);
      const args=node.arguments.map(arg=>expression(arg,scope,context));
      ensure(args.every(value=>!value.privateObject&&!value.loopIndex),
        'private object or induction identity cannot escape into a helper',node);
      record('bounded-pure-helper-expansion',node,
        ['Exact arity and left-to-right argument evaluation.','No receiver, recursion, ambient state, or effects.','Only bounded total primitive work may disappear.']);
      return executeFunction(fn,args,{stack:[...context.stack,fn.id.name]});
    }
    throw new AlgorithmLoweringError('observable or unsupported expression '+node.type,node);
  }

  function predeclare(list,scope){
    for(const node of list)if(node.type==='VariableDeclaration'){
      ensure(['let','const'].includes(node.kind),'var hoisting requires a detailed boundary',node);
      for(const declaration of node.declarations){
        ensure(declaration.id.type==='Identifier'&&declaration.init,'simple initialized local required',declaration);
        if(scope.bindings.get(declaration.id.name)?.node===declaration)continue;
        scope.declare(declaration.id.name,UNINITIALIZED,node.kind==='let',declaration);
      }
    }
  }
  function runStatements(list,scope,context,{allowReturn=true}={}){
    // Lexical cells exist throughout their scope, including the initializer's
    // temporal dead zone. Delaying declaration until after lowering the RHS
    // would accidentally capture an outer binding with the same spelling.
    predeclare(list,scope);
    for(let index=0;index<list.length;index++){
      const node=list[index];
      if(node.type==='EmptyStatement'||node.directive)continue;
      if(node.type==='VariableDeclaration'){
        ensure(['let','const'].includes(node.kind),'var hoisting requires a detailed boundary',node);
        for(const declaration of node.declarations){
          ensure(declaration.id.type==='Identifier'&&declaration.init,'simple initialized local required',declaration);
          const value=expression(declaration.init,scope,context);
          scope.bindings.get(declaration.id.name).value=value;
          record('private-value-propagation',declaration,
            ['Lexical def-use substitution.','Source expression is total under declared input guards.','No escape or external observer.']);
        }
      }else if(node.type==='ExpressionStatement')expression(node.expression,scope,context);
      else if(node.type==='BlockStatement'){
        const result=runStatements(node.body,new Scope(scope),context,{allowReturn});
        if(result)return result;
      }else if(node.type==='ReturnStatement'){
        ensure(allowReturn,'early loop completion is outside the fold profile',node);
        return {returned:true,value:scalar(node.argument?expression(node.argument,scope,context):literal(undefined),node)};
      }else if(node.type==='IfStatement'){
        ensure(allowReturn,'conditional loop work is outside the fold profile',node);
        ensure(withoutMutation(node)&&list.slice(index+1).every(withoutMutation),
          'selection mutations require a state join proof',node);
        const test=scalar(expression(node.test,scope,context),node.test);
        // Only terminal selection is admitted. Each branch receives the same
        // immutable prefix; branch mutations would need a state join proof.
        const safeBranch=branch=>!branch||statements(branch).every(row=>row.type==='ReturnStatement'||
          row.type==='IfStatement'&&safeBranch(row.consequent)&&safeBranch(row.alternate)||
          row.type==='BlockStatement'&&safeBranch(row));
        ensure(safeBranch(node.consequent)&&safeBranch(node.alternate),
          'selection with mutable branch state requires a detailed region',node);
        const remainder=list.slice(index+1);
        const left=runStatements([...statements(node.consequent),...remainder],new Scope(scope),context);
        const right=runStatements([...(node.alternate?statements(node.alternate):[]),...remainder],new Scope(scope),context);
        ensure(left?.returned&&right?.returned,'selection must complete both continuations',node);
        record('pure-selection',node,['Both continuations are effect-free.','Predicate and lazy alternatives remain explicit.']);
        return {returned:true,value:{term:{op:'select',args:[test.term,left.value.term,right.value.term]},
          type:left.value.type===right.value.type?left.value.type:'scalar'}};
      }else throw new AlgorithmLoweringError('unsupported statement '+node.type,node);
    }
    return null;
  }

  function increment(node,name){
    return node?.type==='UpdateExpression'&&node.operator==='++'&&named(node.argument,name)||
      node?.type==='AssignmentExpression'&&named(node.left,name)&&(
        node.operator==='+='&&node.right.type==='Literal'&&node.right.value===1||
        node.operator==='='&&node.right.type==='BinaryExpression'&&node.right.operator==='+'&&
        named(node.right.left,name)&&node.right.right.type==='Literal'&&node.right.right.value===1);
  }
  function foldFunction(fn,scope,context){
    const body=bodyOf(fn),positions=body.flatMap((node,index)=>
      ['ForStatement','WhileStatement','ForOfStatement'].includes(node.type)?[index]:[]);
    if(!positions.length)return null;
    ensure(positions.length===1,'multiple loops require separate certified regions',fn);
    const position=positions[0],loop=body[position];
    ensure(!runStatements(body.slice(0,position),scope,context),'entry returns before its loop',loop);
    let inputValue,indexName=null,loopBody=statements(loop.body),iterationName=null;
    const loopScope=new Scope(scope);
    if(loop.type==='ForOfStatement'){
      ensure(!loop.await&&loop.left.type==='VariableDeclaration'&&['let','const'].includes(loop.left.kind)&&
        loop.left.declarations.length===1&&loop.left.declarations[0].id.type==='Identifier'&&!loop.left.declarations[0].init,
        'for-of requires one lexical element binding and ordinary iteration',loop);
      inputValue=expression(loop.right,scope,context);iterationName=loop.left.declarations[0].id.name;
      loopScope.declare(iterationName,{term:{op:'ref',id:'element'},type:'number'},loop.left.kind==='let',loop.left);
    }else{
      if(loop.type==='ForStatement'){
        ensure(loop.init?.type==='VariableDeclaration'&&loop.init.kind==='let'&&loop.init.declarations.length===1&&
          loop.init.declarations[0].id.type==='Identifier','counted for requires a local zero index',loop);
        runStatements([loop.init],loopScope,context);
        indexName=loop.init.declarations[0].id.name;
        ensure(increment(loop.update,indexName),'counted for requires one ascending index update',loop.update??loop);
      }else{
        ensure(loop.test?.type==='BinaryExpression'&&loop.test.left.type==='Identifier',
          'while requires an explicit index test',loop);
        indexName=loop.test.left.name;
        const last=loopBody.at(-1);
        ensure(last?.type==='ExpressionStatement'&&increment(last.expression,indexName),
          'while requires one final ascending index update',loop);
        loopBody=loopBody.slice(0,-1);
      }
      const indexBinding=loopScope.resolve(indexName);
      ensure(indexBinding?.mutable&&same(indexBinding.value?.term,{op:'literal',value:['num',0]}),
        'fold index must start at positive zero',loop);
      ensure(loop.test?.type==='BinaryExpression'&&loop.test.operator==='<'&&named(loop.test.left,indexName)&&
        loop.test.right.type==='MemberExpression'&&!loop.test.right.computed&&!loop.test.right.optional&&
        named(loop.test.right.property,'length'),'fold bound must be the unchanged array length',loop);
      inputValue=expression(loop.test.right.object,scope,context);
      indexBinding.value={loopIndex:true};
    }
    ensure(inputValue?.term?.op==='input','fold requires one original ordinary-array input',loop);
    constrainInput(inputValue.term.id,'dense-number-array',loop);
    const originals=new Map([...scope.bindings.values()].map(binding=>[binding,binding.value]));
    ensure([...originals.values()].every(value=>!value.privateObject),'fold private object state needs a separate proof',loop);
    const candidates=[...scope.bindings.values()].filter(binding=>binding.mutable&&binding.name!==indexName&&
      same(binding.value?.term,{op:'literal',value:['num',0]}));
    const markers=new Map(candidates.map((binding,index)=>[binding,{op:'ref',id:'acc'+index}]));
    for(const binding of candidates)binding.value={term:markers.get(binding),type:'number'};
    runStatements(loopBody,loopScope,{...context,loop:{inputId:inputValue.term.id}},{allowReturn:false});
    const changed=candidates.filter(binding=>!same(binding.value?.term,markers.get(binding)));
    ensure([...originals].every(([binding,value])=>candidates.includes(binding)||binding.value===value),
      'fold changes state besides its accumulator',loop);
    ensure(changed.length===1,'fold must update exactly one live accumulator',loop);
    const accumulator=changed[0];
    ensure(same(originals.get(accumulator)?.term,{op:'literal',value:['num',0]}),
      'fold accumulator must start at positive zero',loop);
    ensure(same(accumulator.value?.term,{op:'add',args:[markers.get(accumulator),{op:'ref',id:'element'}]}),
      'fold step must add the current element after the accumulator exactly once',loop);
    for(const binding of candidates)binding.value=originals.get(binding);
    accumulator.value={term:{op:'fold_left',input:inputValue.term,initial:{op:'literal',value:['num',0]},
      step:'add',order:'ascending',profile:'dense-number-array/1'},type:'number'};
    record('ordered-numeric-fold',loop,
      ['Ordinary dense array with only length and own numeric elements.','Finite binary64 elements; at most 128 iterations.',
        'Initial accumulator is positive zero.','Strictly ascending traversal, one add per element, original binary64 order.',
        'No input mutation, custom iterator, hooks, callbacks, early exits, or effects.']);
    sourceSites.push({kind:'fold',syntax:loop.type,site:span(loop),accumulator:accumulator.name,
      ...(indexName?{index:indexName}:{element:iterationName})});
    const result=runStatements(body.slice(position+1),scope,context);
    ensure(result?.returned,'fold requires an explicit scalar completion',fn);
    return result.value;
  }
  function executeFunction(fn,args,context){
    ordinary(fn);ensure(args.length===fn.params.length,'exact helper arity required',fn);
    const scope=new Scope();fn.params.forEach((param,index)=>scope.declare(param.name,args[index],true,param));
    predeclare(bodyOf(fn),scope);
    const folded=foldFunction(fn,scope,context);
    if(folded)return folded;
    const result=runStatements(bodyOf(fn),scope,context);
    ensure(result?.returned,'explicit scalar completion required',fn);return result.value;
  }
  const value=executeFunction(entryFunction,inputs.map(input=>({term:{op:'input',id:input.id},type:'scalar'})),{stack:[entry]});
  let core;
  try{
    core=normalizeAlgorithm({schema:'semantic-algorithm/1',profile:'ecmascript-primitive/1',inputs,
      steps:[{kind:'compute',id:'v0',term:value.term},{kind:'return',value:{op:'ref',id:'v0'}}]});
    validateAlgorithm(core);
  }catch(error){throw new AlgorithmLoweringError('normalized core exceeds the bounded profile: '+error.message,entryFunction);}
  return {core,provenance:{schema:JAVASCRIPT_LOWERING_VERSION,
    sourceDigest:createHash('sha256').update(source).digest('hex'),entry,region:span(entryFunction),
    rules,sourceSites,hints,inputGuards:inputs.map(input=>({...input})),
    liveInputs:inputs.map(input=>input.id),liveOutputs:core.steps.filter(step=>step.kind==='compute').map(step=>step.id),effectBoundaries:[],
    budget:{visitedExpressions:nodes,helperExpansions:calls,maxOperations,maxHelperDepth},
    equivalenceScope:'declared-input-domain; no source recovery or all-JavaScript equivalence claim'}};
}

export function tryLowerJavaScript(options){
  try{return {status:'lowered',...lowerJavaScript(options)};}
  catch(error){
    if(!(error instanceof AlgorithmLoweringError))throw error;
    return {status:'refused',disposition:error.disposition,category:error.category,reason:error.message,
      ...(error.site?{site:error.site}:{})};
  }
}
