// Source-only recognition of bounded pure regions. No runtime observations or
// coincident output values participate in the choice of an abstraction.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {encodeAlgorithmScalar as scalar,BINARY_OPERATIONS,UNARY_OPERATIONS} from './operations.js';
import {lowerJavaScript,AlgorithmLoweringError} from './lower-js.js';
import {ALGORITHM_V8_SCHEMA,ALGORITHM_V8_PROFILE,validateAlgorithmV8,ALGORITHM_V8_INPUT_TYPES} from './algorithm-v8.js';

const literal=value=>({term:{op:'literal',value:scalar(value)},type:value===null?'null':typeof value,total:true});
const op=(name,...args)=>({op:name,args});
const named=(node,name)=>node?.type==='Identifier'&&node.name===name;
const statements=node=>node?.type==='BlockStatement'?node.body:node?[node]:[];
const span=node=>({start:node.start,end:node.end});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const UNINITIALIZED=Object.freeze({uninitialized:true});
const fail=(message,node)=>{throw new AlgorithmLoweringError('v8 '+message,node);};
const ensure=(condition,message,node)=>{if(!condition)fail(message,node);};
const scalarValue=(value,node)=>{ensure(value&&!value.fn&&!value.blocked&&(!value.induction||value.term),'scalar/data value required',node);return value;};
const allocated=term=>term&&typeof term==='object'&&(['array','object'].includes(term.op)||term.op==='traverse'&&['map','filter','scan'].includes(term.mode)||Object.values(term).some(child=>Array.isArray(child)?child.some(allocated):child&&typeof child==='object'&&allocated(child)));
function mayThrow(term){
  if(['input','ref','lexical','literal'].includes(term.op))return false;
  if(['get','project','traverse','fold_left'].includes(term.op))return true;
  if(['array','object','let'].includes(term.op))return true;
  return !['equal','not_equal','select','and','or','coalesce','default_undefined','not','void'].includes(term.op)||term.args.some(mayThrow);
}
class Scope {
  constructor(parent=null){this.parent=parent;this.bindings=new Map();}
  declare(name,value,mutable,node){ensure(!this.bindings.has(name),'duplicate binding',node);
    const binding={name,value,mutable,node};this.bindings.set(name,binding);return binding;}
  resolve(name){return this.bindings.get(name)??this.parent?.resolve(name);}
}
function cloneScope(scope,mapping=new Map()){
  if(!scope)return {scope:null,mapping};
  const parent=cloneScope(scope.parent,mapping).scope,result=new Scope(parent);mapping.set(scope,result);
  for(const [name,binding] of scope.bindings)result.bindings.set(name,{...binding});
  return {scope:result,mapping};
}
function bindings(scope){return scope?[...bindings(scope.parent),...scope.bindings.values()]:[];}
function patternNames(pattern){
  if(pattern.type==='Identifier')return [pattern.name];
  if(pattern.type==='AssignmentPattern')return patternNames(pattern.left);
  if(pattern.type==='ObjectPattern')return pattern.properties.flatMap(p=>p.type==='RestElement'?patternNames(p.argument):patternNames(p.value));
  if(pattern.type==='ArrayPattern')return pattern.elements.flatMap(p=>p?patternNames(p):[]);
  if(pattern.type==='RestElement')return patternNames(pattern.argument);
  fail('unsupported binding pattern',pattern);
}
function finalize(term,scopes=[]){
  if(term.op==='lexical'){
    for(let depth=0;depth<scopes.length;depth++){
      const index=scopes[depth].indexOf(term.token);if(index!==-1)return {op:'bound',depth,index};
    }
    fail('unresolved lexical identity');
  }
  if(term.op==='let')return {op:'let',bindings:term.bindings.map((binding,i)=>finalize(binding,[term.names.slice(0,i),...scopes])),
    body:finalize(term.body,[term.names,...scopes])};
  if(term.op==='traverse')return {...term,input:finalize(term.input,scopes),initial:term.initial===null?null:finalize(term.initial,scopes),
    callback:{arity:term.callback.params.length,body:finalize(term.callback.body,[term.callback.params,...scopes])}};
  if(term.op==='project')return {...term,object:finalize(term.object,scopes)};
  if(term.op==='get')return {...term,object:finalize(term.object,scopes),key:finalize(term.key,scopes)};
  if(term.op==='array')return {...term,items:term.items.map(child=>finalize(child,scopes))};
  if(term.op==='object')return {...term,properties:term.properties.map(p=>({key:p.key,value:finalize(p.value,scopes)}))};
  if(term.op==='fold_left')return {...term,input:finalize(term.input,scopes),initial:finalize(term.initial,scopes)};
  return term.args?{...term,args:term.args.map(child=>finalize(child,scopes))}:{...term};
}
function wrap(context,term){
  if(!context.bindings.length)return term;
  // A sole returned allocation keeps its identity without an unnecessary name.
  if(context.bindings.length===1&&term.op==='lexical'&&term.token===context.names[0])return context.bindings[0];
  return {op:'let',names:context.names,bindings:context.bindings,body:term};
}

export function lowerJavaScriptV8({source,entry,inputTypes=null,maxOperations=1024,maxHelperDepth=8}={}){
  ensure(typeof source==='string'&&typeof entry==='string','source and explicit named entry required');
  ensure(Number.isSafeInteger(maxOperations)&&maxOperations>0&&maxOperations<=4096,'operation budget');
  let ast;try{ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});}catch(error){fail('parse: '+error.message);}
  ensure(ast.body[0]?.directive==='use strict','explicit strict source required',ast);
  ensure(ast.body.every(n=>n.type==='FunctionDeclaration'||n.directive==='use strict'),'top-level effects require regions',ast);
  const functions=new Map(ast.body.filter(n=>n.type==='FunctionDeclaration').map(n=>[n.id.name,n]));
  const fn=functions.get(entry);ensure(fn,'entry function missing',ast);
  const ordinary=node=>ensure(node&&!node.async&&!node.generator&&node.params.every(p=>p.type!=='RestElement'),
    'ordinary synchronous function with bounded parameters required',node);
  ordinary(fn);
  ensure(inputTypes===null||Array.isArray(inputTypes)&&inputTypes.length===fn.params.length&&
    inputTypes.every(type=>ALGORITHM_V8_INPUT_TYPES.includes(type)),'input type declaration');
  const inputs=fn.params.map((param,index)=>({id:'a'+index,type:inputTypes?.[index]??'value'}));
  const inputById=new Map(inputs.map(x=>[x.id,x]));let nodes=0,tokens=0,helpers=0;
  const rules=[],sites=[],token=()=> 't'+tokens++;
  const rule=(name,node,conditions)=>rules.push({rule:name,version:1,site:span(node),conditions});
  const context=extra=>({bindings:[],names:[],stack:[],conditional:false,scopeMap:new Map(),...extra});
  const pin=(value,ctx,node)=>{
    if(value.fn||['literal','input','ref','lexical'].includes(value.term.op))return value;
    if(!allocated(value.term)&&(value.total===true||value.total!==false&&!mayThrow(value.term)))return value;
    ensure(!ctx.conditional,'allocating or potentially throwing branch work requires a local detailed boundary',node);
    const name=token();ctx.names.push(name);ctx.bindings.push(value.term);
    return {...value,term:{op:'lexical',token:name}};
  };
  function constrain(value,type,node){
    if(value.term?.op==='input'){
      const input=inputById.get(value.term.id);
      ensure(input,'unknown input domain',node);
      if(type==='data'&&input.type.includes('array')||type==='dense-primitive-array'&&input.type==='dense-number-array')return;
      const compatible=input.type==='value'||input.type==='scalar'||input.type===type||input.type==='data'&&type.includes('array')||
        input.type==='dense-primitive-array'&&type==='dense-number-array'||input.type==='nullable-data'&&type==='data';
      ensure(compatible,'incompatible input domains',node);input.type=type;
    }
  }
  function number(value,node){
    scalarValue(value,node);ensure(!['array','object','bigint'].includes(value.type),'numeric conversion requires a guarded primitive',node);
    if(value.term.op==='input'){constrain(value,'number',node);value.type='number';}
    if(value.originArray){constrain(value.originArray,'dense-number-array',node);value.type='number';}
    return value;
  }
  function operation(operator,args,node,unary=false){
    args.forEach(value=>scalarValue(value,node));
    const name=(unary?UNARY_OPERATIONS:BINARY_OPERATIONS)[operator];ensure(name,'unsupported operator '+operator,node);
    let type='scalar';
    if(unary){
      if(['+','-','~'].includes(operator)){number(args[0],node);type='number';}
      else type=operator==='!'?'boolean':operator==='typeof'?'string':'undefined';
    }else if(['===','!==','==','!=','<','<=','>','>='].includes(operator))type='boolean';
    else if(operator==='+'&&args.some(x=>x.type==='string'))type='string';
    else {args.forEach(x=>number(x,node));type='number';}
    sites.push({kind:'operation',operation:name,site:span(node)});return {term:op(name,...args.map(x=>x.term)),type,total:args.every(x=>x.total!==false)&&args.every(x=>!['scalar','object','array'].includes(x.type))};
  }
  function select(test,left,right){return {term:equal(left.term,right.term)?left.term:op('select',test.term,left.term,right.term),
    type:left.type===right.type?left.type:'scalar',total:test.total!==false&&left.total!==false&&right.total!==false};}
  function fork(scope,ctx){const cloned=cloneScope(scope);return {scope:cloned.scope,ctx:{...ctx,conditional:true,
    scopeMap:new Map([...ctx.scopeMap,...cloned.mapping])}};}
  function join(scope,left,right,test,node){
    for(const binding of bindings(scope)){
      const l=left.scopeMap.get(findScope(scope,binding))?.bindings.get(binding.name)?.value??binding.value,
        r=right.scopeMap.get(findScope(scope,binding))?.bindings.get(binding.name)?.value??binding.value;
      if(l===r||equal(l,r)){binding.value=l;continue;}
      ensure(!l?.fn&&!r?.fn&&!l?.uninitialized&&!r?.uninitialized,'branch join of unavailable/function identity',node);
      scalarValue(l,node);scalarValue(r,node);binding.value=select(test,l,r);
    }
  }
  function findScope(scope,binding){for(let current=scope;current;current=current.parent)
    if(current.bindings.get(binding.name)===binding)return current;return null;}
  function readProperty(object,key,node,nullable=false){
    scalarValue(object,node);scalarValue(key,node);constrain(object,nullable?'nullable-data':'data',node);
    return {term:key.term.op==='literal'&&key.term.value[0]==='str'?
      {op:'project',object:object.term,key:key.term.value[1]}:{op:'get',object:object.term,key:key.term},type:'scalar',total:false};
  }
  function bind(pattern,value,scope,ctx,{declare=false,mutable=false}={}){
    if(pattern.type==='Identifier'){
      const binding=scope.resolve(pattern.name);
      if(declare){ensure(binding,'binding was not predeclared',pattern);binding.value=pin(value,ctx,pattern);}
      else{ensure(binding?.mutable&&!binding.value.uninitialized,'initialized mutable assignment required',pattern);binding.value=pin(value,ctx,pattern);}
      return;
    }
    if(pattern.type==='AssignmentPattern'){
      const skipped=fork(scope,ctx),selected=fork(scope,ctx),fallback=expression(pattern.right,selected.scope,selected.ctx);
      const predicate={term:op('equal',value.term,literal(undefined).term),type:'boolean',total:true};
      join(scope,selected.ctx,skipped.ctx,predicate,pattern);
      return bind(pattern.left,{term:op('default_undefined',value.term,fallback.term),type:value.type===fallback.type?value.type:'scalar'},scope,ctx,{declare,mutable});
    }
    if(pattern.type==='ObjectPattern'){
      constrain(value,'data',pattern);
      ensure(pattern.properties.length||value.term.op==='input'||value.type==='object','nested empty object pattern requires a boundary',pattern);
      for(const property of pattern.properties){
        ensure(property.type==='Property'&&property.kind==='init','object rest requires enumeration profile',property);
        const key=property.computed?expression(property.key,scope,ctx):literal(property.key.type==='Identifier'?property.key.name:String(property.key.value));
        bind(property.value,readProperty(value,key,property),scope,ctx,{declare,mutable});
      }
      return;
    }
    if(pattern.type==='ArrayPattern'){
      constrain(value,'dense-primitive-array',pattern);
      pattern.elements.forEach((element,index)=>{if(element){ensure(element.type!=='RestElement','array rest needs a sliced allocation',element);
        bind(element,readProperty(value,literal(String(index)),element),scope,ctx,{declare,mutable});}});return;
    }
    fail('unsupported binding pattern',pattern);
  }
  function predeclare(list,scope){
    for(const node of list){
      if(node.type==='VariableDeclaration'){
        ensure(['let','const'].includes(node.kind),'var requires a separate hoisting profile',node);
        for(const declaration of node.declarations)for(const name of patternNames(declaration.id)){
          if(scope.bindings.get(name)?.node===declaration)continue;
          scope.declare(name,UNINITIALIZED,node.kind==='let',declaration);
        }
      }else if(node.type==='FunctionDeclaration')scope.declare(node.id.name,{fn:node,closure:scope},false,node);
    }
  }
  function resolveFunction(node,scope,ctx){
    if(['ArrowFunctionExpression','FunctionExpression'].includes(node.type))return {fn:node,closure:scope};
    if(node.type==='Identifier'){
      const local=scope.resolve(node.name)?.value;if(local?.fn)return {...local,closure:ctx.scopeMap.get(local.closure)??local.closure};
      if(!local&&functions.has(node.name))return {fn:functions.get(node.name),closure:null};
    }
    fail('callback/helper must be a source-known pure function',node);
  }
  function executeFunction(target,args,ctx,node){
    ordinary(target.fn);
    ensure(!ctx.stack.includes(target.fn)&&ctx.stack.length<maxHelperDepth&&++helpers<=64,'recursive/excessive helper expansion',node);
    const callCtx=context({...ctx,bindings:[],names:[],stack:[...ctx.stack,target.fn]});
    const closure=target.closure?cloneScope(target.closure).scope:null;
    for(const binding of bindings(closure))binding.mutable=false;
    const callScope=new Scope(closure),params=target.fn.params;
    for(const param of params)for(const name of patternNames(param))callScope.declare(name,UNINITIALIZED,true,param);
    params.forEach((param,index)=>bind(param,args[index]??literal(undefined),callScope,callCtx,{declare:true}));
    if(target.fn.body.type!=='BlockStatement')return {value:expression(target.fn.body,callScope,callCtx),ctx:callCtx};
    const result=run(target.fn.body.body,callScope,callCtx);ensure(result?.returned,'helper requires explicit return',target.fn);
    return {value:result.value,ctx:callCtx};
  }
  function traverse(mode,input,callback,initial,scope,ctx,node){
    constrain(input,'dense-primitive-array',node);
    const params=Array.from({length:mode==='fold'||mode==='scan'?4:3},token),isFold=params.length===4;
    const args=params.map((name,index)=>({term:{op:'lexical',token:name},
      type:index===(isFold?2:1)?'number':index===(isFold?3:2)?'array':isFold&&index===0?initial.type:'scalar',
      total:true,...(index===(isFold?1:0)?{originArray:input}:{})}));
    const result=executeFunction(callback,args,ctx,node);
    const term={op:'traverse',mode,input:input.term,initial:isFold?initial.term:null,
      callback:{params,body:wrap(result.ctx,result.value.term)},profile:'dense-primitive-array/1',order:'ascending'};
    rule('ordered-'+mode,node,['Original array intrinsic or certified ascending loop.','Dense primitive own-data input with no replacement/hook.','Pure checked callback; no shared mutation; explicit laziness and order.']);
    return {term,type:['map','filter','scan'].includes(mode)?'array':['some','every'].includes(mode)?'boolean':mode==='find_index'?'number':result.value.type};
  }
  function expression(node,scope,ctx){
    ensure(node&&++nodes<=maxOperations,'expression budget',node??fn);
    if(node.type==='Literal'){ensure(!node.regex,'RegExp requires a matching profile',node);return literal(node.value);}
    if(node.type==='Identifier'){
      const binding=scope.resolve(node.name);
      if(!binding&&['undefined','NaN','Infinity'].includes(node.name))return literal({undefined:undefined,NaN:NaN,Infinity:Infinity}[node.name]);
      ensure(binding&&!binding.value.uninitialized,'unbound/TDZ identifier '+node.name,node);return binding.value;
    }
    if(['ArrowFunctionExpression','FunctionExpression'].includes(node.type))return {fn:node,closure:scope};
    if(node.type==='UnaryExpression')return operation(node.operator,[expression(node.argument,scope,ctx)],node,true);
    if(node.type==='BinaryExpression')return operation(node.operator,[expression(node.left,scope,ctx),expression(node.right,scope,ctx)],node);
    if(node.type==='ConditionalExpression'||node.type==='LogicalExpression'){
      const logical=node.type==='LogicalExpression',test=scalarValue(expression(logical?node.left:node.test,scope,ctx),node);
      const left=fork(scope,ctx),right=fork(scope,ctx);
      let l,r,predicate=test;
      if(logical){
        const rhs=scalarValue(expression(node.right,right.scope,right.ctx),node.right);
        const name={'&&':'and','||':'or','??':'coalesce'}[node.operator];ensure(name,'logical operator',node);
        predicate=node.operator==='&&'?test:node.operator==='||'?{term:op('not',test.term),type:'boolean'}:
          {term:op('or',op('equal',test.term,literal(null).term),op('equal',test.term,literal(undefined).term)),type:'boolean'};
        join(scope,right.ctx,left.ctx,predicate,node);
        return {term:op(name,test.term,rhs.term),type:test.type===rhs.type?test.type:'scalar'};
      }
      l=scalarValue(expression(node.consequent,left.scope,left.ctx),node.consequent);
      r=scalarValue(expression(node.alternate,right.scope,right.ctx),node.alternate);
      join(scope,left.ctx,right.ctx,predicate,node);return select(test,l,r);
    }
    if(node.type==='ChainExpression'){const result=expression(node.expression,scope,{...ctx,chain:true});
      const {chainNullish,...value}=result;return value;}
    if(node.type==='MemberExpression'){
      const object=expression(node.object,scope,ctx);
      if(object.induction)fail('induction identity cannot be object',node);
      let nullish=object.chainNullish??null;
      if(node.optional){
        const own=op('or',op('equal',object.term,literal(null).term),op('equal',object.term,literal(undefined).term));
        nullish=nullish?op('or',nullish,own):own;
      }
      let key;
      if(node.computed&&nullish){
        const skipped=fork(scope,ctx),selected=fork(scope,ctx);key=expression(node.property,selected.scope,selected.ctx);
        join(scope,skipped.ctx,selected.ctx,{term:nullish,type:'boolean',total:true},node);
      }else key=node.computed?expression(node.property,scope,ctx):literal(node.property.name);
      if(ctx.loop&&equal(object.term,ctx.loop.input.term)&&node.computed&&node.property.type==='Identifier'&&
        scope.resolve(node.property.name)?.value?.induction)return ctx.loop.element;
      const result=readProperty(object,key,node,node.optional);
      if(!nullish)return result;
      rule('lazy-optional-data-read',node,['Object/key evaluated in source order; key lookup only on non-nullish path.','No accessors or proxy behavior.']);
      return {...select({term:nullish,type:'boolean',total:true},literal(undefined),result),...(ctx.chain?{chainNullish:nullish}:{})};
    }
    if(node.type==='ArrayExpression'){
      ensure(node.elements.every(x=>x&&x.type!=='SpreadElement'),'dense literals without spread required',node);
      return {term:{op:'array',items:node.elements.map(x=>scalarValue(expression(x,scope,ctx),x).term)},type:'array',emptyArray:node.elements.length===0};
    }
    if(node.type==='ObjectExpression'){
      const properties=[],keys=new Set();
      for(const property of node.properties){ensure(property.type==='Property'&&property.kind==='init'&&!property.method&&!property.computed,
        'ordinary static object data required',property);
        const key=property.key.type==='Identifier'?property.key.name:String(property.key.value);
        ensure(key!=='__proto__'&&!keys.has(key),'unique ordinary object key',property);keys.add(key);
        properties.push({key,value:scalarValue(expression(property.value,scope,ctx),property).term});}
      return {term:{op:'object',properties},type:'object'};
    }
    if(node.type==='AssignmentExpression'){
      if(node.left.type!=='Identifier'){
        ensure(node.operator==='='&&['ObjectPattern','ArrayPattern'].includes(node.left.type),'visible writes require shared region state',node);
        const rhs=expression(node.right,scope,ctx);bind(node.left,rhs,scope,ctx);return rhs;
      }
      const binding=scope.resolve(node.left.name);ensure(binding?.mutable&&!binding.value.uninitialized&&!binding.value.induction,'mutable local assignment',node);
      const previous=binding.value;
      if(['&&=','||=','??='].includes(node.operator)){
        const operator=node.operator.slice(0,-1),rhsNode={...node,type:'LogicalExpression',operator,left:node.left,right:node.right};
        const value=expression(rhsNode,scope,ctx);binding.value=value;return value;
      }
      const rhs=expression(node.right,scope,ctx),value=node.operator==='='?rhs:operation(node.operator.slice(0,-1),[previous,rhs],node);
      binding.value=pin(value,ctx,node);return binding.value;
    }
    if(node.type==='UpdateExpression'){
      ensure(node.argument.type==='Identifier','visible updates require shared region state',node);
      const binding=scope.resolve(node.argument.name);ensure(binding?.mutable&&!binding.value.uninitialized&&!binding.value.induction,'mutable local update',node);
      const previous=number(binding.value,node),converted=previous.type==='number'||previous.term.op==='input'?previous:operation('+',[previous],node,true),
        next=operation(node.operator==='++'?'+':'-',[converted,literal(1)],node);
      binding.value=next;return node.prefix?next:converted;
    }
    if(node.type==='SequenceExpression'){let last;for(const item of node.expressions){last=expression(item,scope,ctx);if(item!==node.expressions.at(-1))pin(last,ctx,item);}return last;}
    if(node.type==='CallExpression'&&!node.optional){
      if(node.callee.type==='MemberExpression'&&!node.callee.optional&&!node.callee.computed){
        const modes={reduce:'fold',map:'map',filter:'filter',find:'find',findIndex:'find_index',some:'some',every:'every'},mode=modes[node.callee.property.name];
        ensure(mode,'unknown/possibly effectful method call',node);
        const input=expression(node.callee.object,scope,ctx);ensure(node.arguments.length===(mode==='fold'?2:1),'callback method arity',node);
        const callback=resolveFunction(node.arguments[0],scope,ctx),initial=mode==='fold'?expression(node.arguments[1],scope,ctx):null;
        return traverse(mode,input,callback,initial,scope,ctx,node);
      }
      const target=resolveFunction(node.callee,scope,ctx),args=node.arguments.map(arg=>{
        ensure(arg.type!=='SpreadElement','spread helper arguments require a call profile',arg);return pin(expression(arg,scope,ctx),ctx,arg);});
      const result=executeFunction(target,args,ctx,node);
      rule('immutable-pure-helper',node,['Source-known function, bounded acyclic expansion.','Captured cells are read only; receiver-free call.']);
      return {...result.value,term:wrap(result.ctx,result.value.term)};
    }
    fail('unsupported pure expression '+node.type,node);
  }
  function run(list,scope,ctx){
    predeclare(list,scope);
    for(let position=0;position<list.length;position++){
      const node=list[position];
      if(node.directive||['EmptyStatement','FunctionDeclaration'].includes(node.type))continue;
      if(node.type==='VariableDeclaration')for(const declaration of node.declarations){
        const value=declaration.init?expression(declaration.init,scope,ctx):literal(undefined);
        bind(declaration.id,pin(value,ctx,declaration),scope,ctx,{declare:true});
      }else if(node.type==='ExpressionStatement')pin(expression(node.expression,scope,ctx),ctx,node);
      else if(node.type==='ReturnStatement')return {returned:true,value:scalarValue(node.argument?expression(node.argument,scope,ctx):literal(undefined),node)};
      else if(node.type==='BlockStatement'){const result=run(node.body,new Scope(scope),ctx);if(result)return result;}
      else if(node.type==='IfStatement'){
        const test=scalarValue(expression(node.test,scope,ctx),node),left=fork(scope,ctx),right=fork(scope,ctx);
        let l=run(statements(node.consequent),new Scope(left.scope),left.ctx),r=run(statements(node.alternate),new Scope(right.scope),right.ctx);
        if(l?.returned||r?.returned){
          const rest=list.slice(position+1);
          if(!l)l=run(rest,left.scope,left.ctx);if(!r)r=run(rest,right.scope,right.ctx);
          ensure(l?.returned&&r?.returned,'both selected continuations need a return',node);
          return {returned:true,value:select(test,l.value,r.value)};
        }
        join(scope,left.ctx,right.ctx,test,node);
        rule('structured-scalar-state-join',node,['Separate symbolic branch states.','Same lazy predicate for every changed local.','No visible mutation, guest calls or allocation across the join.']);
      }else if(['ForStatement','WhileStatement','ForOfStatement'].includes(node.type)){
        const result=loop(node,list.slice(position+1),scope,ctx);if(result)return result;
      }else fail('unsupported pure statement '+node.type,node);
    }
    return null;
  }
  function increment(node,name){return node?.type==='UpdateExpression'&&node.operator==='++'&&named(node.argument,name)||
    node?.type==='AssignmentExpression'&&named(node.left,name)&&node.operator==='+='&&node.right.type==='Literal'&&node.right.value===1;}
  function loop(node,remainder,scope,ctx){
    let input,indexName=null,elementName=null,body=statements(node.body),local=new Scope(scope);
    if(node.type==='ForOfStatement'){
      ensure(!node.await&&node.left.type==='VariableDeclaration'&&node.left.declarations.length===1&&node.left.declarations[0].id.type==='Identifier',
        'bounded for-of binding',node);
      input=expression(node.right,scope,ctx);elementName=node.left.declarations[0].id.name;
    }else{
      if(node.type==='ForStatement'){
        ensure(node.init?.type==='VariableDeclaration'&&node.init.kind==='let'&&node.init.declarations.length===1,'local for index',node);
        indexName=node.init.declarations[0].id.name;
        ensure(node.init.declarations[0].init?.type==='Literal'&&node.init.declarations[0].init.value===0&&increment(node.update,indexName),'ascending zero-based for',node);
      }else{
        indexName=node.test?.left?.name;const binding=scope.resolve(indexName);
        ensure(binding?.mutable&&equal(binding.value.term,literal(0).term)&&body.at(-1)?.type==='ExpressionStatement'&&increment(body.at(-1).expression,indexName),
          'ascending zero-based while with final increment',node);body=body.slice(0,-1);
      }
      ensure(node.test?.type==='BinaryExpression'&&node.test.operator==='<'&&named(node.test.left,indexName)&&
        node.test.right.type==='MemberExpression'&&!node.test.right.computed&&named(node.test.right.property,'length'),'unchanged dense array loop bound',node);
      input=expression(node.test.right.object,scope,ctx);local.declare(indexName,{induction:true},false,node);
    }
    constrain(input,'dense-number-array',node);
    const params=Array.from({length:4},token),element={term:{op:'lexical',token:params[1]},type:'number',originArray:input},
      index={term:{op:'lexical',token:params[2]},type:'number'};
    if(elementName)local.declare(elementName,element,false,node);
    if(indexName)local.bindings.get(indexName).value={...index,induction:true};
    const loopCtx=context({...ctx,bindings:[],names:[],loop:{input,element},conditional:false});
    // A terminal search loop maps directly to its early-stopping traversal.
    const only=body.filter(x=>x.type!=='EmptyStatement');
    if(only.length===1&&only[0].type==='IfStatement'&&!only[0].alternate&&statements(only[0].consequent).length===1&&
      statements(only[0].consequent)[0].type==='ReturnStatement'&&remainder.length===1&&remainder[0].type==='ReturnStatement'){
      const condition=expression(only[0].test,local,loopCtx),found=expression(statements(only[0].consequent)[0].argument,local,loopCtx),
        absent=remainder[0].argument?expression(remainder[0].argument,scope,ctx):literal(undefined);
      let mode,predicate=condition;
      if(equal(found.term,element.term)&&equal(absent.term,literal(undefined).term))mode='find';
      else if(equal(found.term,index.term)&&equal(absent.term,literal(-1).term))mode='find_index';
      else if(equal(found.term,literal(true).term)&&equal(absent.term,literal(false).term))mode='some';
      else if(equal(found.term,literal(false).term)&&equal(absent.term,literal(true).term)){
        mode='every';predicate={term:condition.term.op==='not'?condition.term.args[0]:op('not',condition.term),type:'boolean'};
      }
      ensure(mode,'early completion does not match a search/quantifier profile',node);
      const mapping=new Map([[params[1],params[0]],[params[2],params[1]],[params[3],params[2]]]);
      const rename=term=>term.op==='lexical'?{...term,token:mapping.get(term.token)??term.token}:term.args?{...term,args:term.args.map(rename)}:
        term.op==='project'?{...term,object:rename(term.object)}:term;
      rule('ordered-'+mode,node,['Early return only on predicate match; matching absent result.','Ascending dense numeric traversal.']);
      return {returned:true,value:{term:{op:'traverse',mode,input:input.term,initial:null,
        callback:{params:params.slice(0,3),body:rename(predicate.term)},profile:'dense-primitive-array/1',order:'ascending'},type:found.type}};
    }
    // Recognize fresh private output builders before considering a scalar fold.
    // The builder has no alias, escaped reference, earlier read, or captured
    // observer, so its allocation/push bookkeeping can become one traversal.
    const pushNode=statement=>statement?.type==='ExpressionStatement'&&statement.expression.type==='CallExpression'&&
      !statement.expression.optional&&statement.expression.callee.type==='MemberExpression'&&
      !statement.expression.callee.computed&&named(statement.expression.callee.property,'push')&&
      statement.expression.callee.object.type==='Identifier'&&statement.expression.arguments.length===1?
        statement.expression:null;
    const filter=only.length===1&&only[0].type==='IfStatement'&&!only[0].alternate&&
      statements(only[0].consequent).length===1?only[0]:null;
    const push=pushNode(filter?statements(filter.consequent)[0]:only.at(-1));
    const output=push?scope.resolve(push.callee.object.name):null;
    if(output?.value.emptyArray){
      const builder=output.value,allocationIndex=builder.term.op==='lexical'?ctx.names.indexOf(builder.term.token):-1,
        aliases=bindings(scope).filter(binding=>binding!==output&&binding.value.term&&equal(binding.value.term,builder.term));
      const mentions=(term,name)=>term&&typeof term==='object'&&(term.op==='lexical'&&term.token===name||
        Object.values(term).some(child=>Array.isArray(child)?child.some(item=>mentions(item,name)):mentions(child,name)));
      ensure(allocationIndex>=0&&!aliases.length&&!bindings(scope).some(binding=>binding.value.fn)&&
        ctx.bindings.every((term,index)=>index===allocationIndex||!mentions(term,builder.term.token)),
        'array builder escaped, aliased, captured or was observed before traversal',node);
      const before=new Map(bindings(scope).map(binding=>[binding,binding.value])),prelude=filter?[]:only.slice(0,-1);
      const assigned=new Set();
      const scan=n=>{if(!n||typeof n!=='object')return;
        if(['AssignmentExpression','UpdateExpression'].includes(n.type)&&(n.left??n.argument).type==='Identifier')assigned.add((n.left??n.argument).name);
        for(const child of Object.values(n))if(Array.isArray(child))child.forEach(scan);else if(child&&typeof child==='object')scan(child);};
      prelude.forEach(scan);
      const accumulators=bindings(scope).filter(binding=>binding.mutable&&binding.name!==indexName&&assigned.has(binding.name));
      ensure(accumulators.length<=1,'scan needs one scalar accumulator',node);
      const accumulator=accumulators[0];
      if(accumulator){number(accumulator.value,node);accumulator.value={term:{op:'lexical',token:params[0]},type:'number',total:true};}
      ensure(!run(prelude,local,loopCtx),'builder step cannot complete early',node);
      const predicate=filter?expression(filter.test,local,loopCtx):null,result=expression(push.arguments[0],local,loopCtx);
      let mode=filter?'filter':accumulator?'scan':'map',callback=result.term;
      if(filter){ensure(equal(result.term,element.term),'filter must retain the original element',push);callback=predicate.term;}
      if(accumulator)ensure(equal(result.term,accumulator.value.term),'scan pushes its updated accumulator',push);
      for(const [binding,value] of before)ensure(binding===accumulator||binding.value===value,
        'builder callback changes an external private binding',node);
      const initial=accumulator?before.get(accumulator).term:null;
      for(const [binding,value] of before)binding.value=value;
      let callbackParams=params;
      if(mode!=='scan'){
        const mapping=new Map([[params[1],params[0]],[params[2],params[1]],[params[3],params[2]]]);
        const rename=value=>Array.isArray(value)?value.map(rename):value&&typeof value==='object'?
          value.op==='lexical'?{...value,token:mapping.get(value.token)??value.token}:
            Object.fromEntries(Object.entries(value).map(([key,child])=>[key,rename(child)])):value;
        callback=rename(wrap(loopCtx,callback));callbackParams=params.slice(0,3);
      }else callback=wrap(loopCtx,callback);
      const traversal={term:{op:'traverse',mode,input:input.term,initial,
        callback:{params:callbackParams,body:callback},profile:'dense-primitive-array/1',order:'ascending'},type:'array'};
      ctx.names.splice(allocationIndex,1);ctx.bindings.splice(allocationIndex,1);
      output.value=pin(traversal,ctx,node);
      if(accumulator){
        const length={op:'project',object:output.value.term,key:'length'};
        accumulator.value={term:op('select',length,
          {op:'get',object:output.value.term,key:op('subtract',length,literal(1).term)},initial),type:'number',total:true};
      }
      if(node.type==='WhileStatement')scope.resolve(indexName).value={term:{op:'project',object:input.term,key:'length'},type:'number',total:true};
      rule('ordered-'+mode+'-builder',node,['Fresh unaliased output array; no earlier observations or captures.',
        'Ascending dense numeric input; pure checked step.','Canonical traversal preserves result allocation and final accumulator.']);
      return null;
    }
    const original=bindings(scope).filter(binding=>binding.mutable&&binding.name!==indexName&&binding.value.term),
      before=new Map(original.map(binding=>[binding,binding.value]));
    const assigned=new Set();
    const inspect=n=>{if(!n||typeof n!=='object')return;
      if((n.type==='AssignmentExpression'||n.type==='UpdateExpression')&&(n.left??n.argument).type==='Identifier')assigned.add((n.left??n.argument).name);
      for(const child of Object.values(n))if(Array.isArray(child))child.forEach(inspect);else if(child&&typeof child==='object')inspect(child);};
    body.forEach(inspect);
    const changed=original.filter(binding=>assigned.has(binding.name));ensure(changed.length>0&&changed.length<=8,'one to eight private accumulators required',node);
    const multi=changed.length>1;
    for(const [i,binding] of changed.entries()){
      const value=before.get(binding);if(value.type==='scalar')number(value,node);
      binding.value={term:multi?{op:'project',object:{op:'lexical',token:params[0]},key:'s'+i}:{op:'lexical',token:params[0]},
        type:value.type==='scalar'?'number':value.type};
    }
    ensure(!run(body,local,loopCtx),'fold body cannot return',node);
    const result=multi?{op:'object',properties:changed.map((binding,i)=>({key:'s'+i,value:binding.value.term}))}:changed[0].value.term,
      initial=multi?{op:'object',properties:changed.map((binding,i)=>({key:'s'+i,value:before.get(binding).term}))}:before.get(changed[0]).term;
    for(const [binding,value] of before)binding.value=value;
    const term={op:'traverse',mode:'fold',input:input.term,initial,
      callback:{params,body:wrap(loopCtx,result)},profile:'dense-primitive-array/1',order:'ascending'};
    const folded=multi?pin({term,type:'object'},ctx,node):{term,type:changed[0].value.type,total:true};
    for(const [i,binding] of changed.entries())binding.value=multi?{term:{op:'project',object:folded.term,key:'s'+i},type:before.get(binding).type}:folded;
    if(node.type==='WhileStatement')scope.resolve(indexName).value={term:{op:'project',object:input.term,key:'length'},type:'number',total:true};
    rule('ordered-structured-fold',node,['Ascending dense numeric input; finite bounds.','Checked step and explicit initial state.','One or several private accumulators; state joins remain lazy.']);
    return null;
  }
  const rootScope=new Scope(),rootCtx=context({stack:[fn]});
  fn.params.forEach(param=>patternNames(param).forEach(name=>rootScope.declare(name,UNINITIALIZED,true,param)));
  fn.params.forEach((param,index)=>bind(param,{term:{op:'input',id:'a'+index},type:inputs[index].type==='number'?'number':'scalar',total:true},rootScope,rootCtx,{declare:true}));
  try{
    const result=run(fn.body.body,rootScope,rootCtx);ensure(result?.returned,'explicit completion required',fn);
    const term=finalize(wrap(rootCtx,result.value.term));
    const core={schema:ALGORITHM_V8_SCHEMA,profile:ALGORITHM_V8_PROFILE,inputs,
      steps:[{kind:'compute',id:'v0',term},{kind:'return',value:{op:'ref',id:'v0'}}]};validateAlgorithmV8(core);
    return {core,provenance:{schema:'semantic-javascript-lowering/2',sourceDigest:createHash('sha256').update(source).digest('hex'),
      entry,region:span(fn),rules,sourceSites:sites,inputGuards:inputs.map(x=>({...x})),effectBoundaries:[],
      liveInputs:inputs.map(x=>x.id),liveOutputs:['v0'],budget:{visitedExpressions:nodes,helperExpansions:helpers,maxOperations,maxHelperDepth},
      equivalenceScope:'declared-input-domain; owned and native admission remain separate'}};
  }catch(error){
    if(!(error instanceof AlgorithmLoweringError))throw error;
    // Existing proved private-object scalarization is still useful. It is
    // validated as /1 before embedding unchanged meanings into the /2 core.
    try{const old=lowerJavaScript({source,entry,inputTypes});
      const core={...old.core,schema:ALGORITHM_V8_SCHEMA,profile:ALGORITHM_V8_PROFILE};validateAlgorithmV8(core);
      return {core,provenance:{...old.provenance,schema:'semantic-javascript-lowering/2',legacyRuleEmbedding:true}};
    }catch{throw error;}
  }
}
export function tryLowerJavaScriptV8(options){
  try{return {status:'lowered',...lowerJavaScriptV8(options)};}
  catch(error){if(!(error instanceof AlgorithmLoweringError))throw error;
    return {status:'refused',disposition:'detailed-fallback',category:error.category,reason:error.message,...(error.site?{site:error.site}:{})};}
}
