// Versioned, fail-closed Acorn -> owned bytecode frontend for training-js/1.
// Parsing is not execution: the compiler/runtime own semantics.
import {parse as acornParse} from 'acorn';
import {encode} from '../values.js';
import {collectVarBindings} from '../frontend.js';
import {supportsPinnedRegExp} from '../owned-pinned-regexp.js';

export const TRAINING_PROFILE='training-js/1';
export const TRAINING_PARSER='acorn/8.15.0:training-js/1';
const binaries=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
  '&','|','^','<<','>>','>>>']);
const logical=new Set(['&&','||','??']);
const assignments=new Set(['=','&&=','||=','??=','+=','-=','*=','/=','%=','**=',
  '&=','|=','^=','<<=','>>=','>>>=']);
const unary=new Set(['!','-','+','typeof','void','~']);
const ownedConstructors=new Set(['Set','Error','TypeError','Symbol','Promise','SharedArrayBuffer','DataView',
  'Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array',
  'BigInt64Array','BigUint64Array','Float32Array','Float64Array']);
const reject=(node,why) => {throw new SyntaxError(
  'Unsupported training-js/1 '+why+' at '+(node.start ?? '?')+':'+(node.end ?? '?'));};

export function parseTraining(source) {
  if(typeof source!=='string')throw new TypeError('Training source must be text');
  const parsed=acornParse(source,{ecmaVersion:2022,sourceType:'script',locations:true,
    allowAwaitOutsideFunction:false,allowReturnOutsideFunction:false});
  if(parsed.body[0]?.type!=='ExpressionStatement' ||
     parsed.body[0].directive!=='use strict')
    reject(parsed,'explicit "use strict" directive is required');
  // Top-level initialization is modeled only for literal scalars and
  // explicitly owned references to immutable Math methods. Arbitrary module
  // execution, getters, function calls and mutable initialization fail closed.
  const staticGlobal=n=>(n?.type==='Identifier'&&n.name==='undefined') ||
    n?.type==='Literal'&&(!n.regex ||
    supportsPinnedRegExp(n.regex.pattern,n.regex.flags)) ||
    n?.type==='MemberExpression'&&!n.computed&&
    n.object?.type==='Identifier'&&n.object.name==='Math'&&
    ['ceil','floor','min','max'].includes(n.property?.name);
  if(parsed.body.slice(1).some(n=>n.type!=='FunctionDeclaration' &&
    !(n.type==='VariableDeclaration'&&n.declarations.every(d=>
      d.id.type==='Identifier'&&staticGlobal(d.init)))))
    reject(parsed,'top-level declaration must be a function or static owned data');

  // A reproducible Math.random() fixture is observable only at a direct,
  // source-identifiable call site. Aliasing/computed getters would hide the
  // PRNG step from the serving controller and therefore fail closed.
  function requireDirectRandom(node,parent=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){
      for(const member of node)requireDirectRandom(member,parent);
      return;
    }
    if(node.type==='MemberExpression'&&node.object?.type==='Identifier'&&
       node.object.name==='Math' &&
       (node.computed?node.property?.value==='random':node.property?.name==='random')){
      if(node.computed||parent?.type!=='CallExpression'||parent.callee!==node||
         parent.arguments.length!==0||parent.optional)
        reject(node,'Math.random must be a direct zero-argument call');
    }
    for(const [key,child] of Object.entries(node))
      if(!['start','end','loc'].includes(key))requireDirectRandom(child,node);
  }
  requireDirectRandom(parsed);

  const span=n=>({start:n.start,end:n.end});
  function patternTree(root,{assignment=false}={}){
    const names=[],budget={count:0};
    function pattern(node,depth=0){
      if(++budget.count>32||depth>4)reject(node,'destructuring shape exceeds bounded depth/nodes');
      const at=span(node);
      if(node.type==='Identifier'){
        names.push({...at,name:node.name});return {...at,type:'PatternName',name:node.name};
      }
      if(assignment&&node.type==='MemberExpression')return {...at,type:'PatternMember',target:expr(node)};
      if(node.type==='AssignmentPattern')return {...at,type:'PatternDefault',
        target:pattern(node.left,depth+1),fallback:expr(node.right)};
      if(node.type==='ArrayPattern')return {...at,type:'PatternArray',elements:node.elements.map((item,index)=>
        item===null?{...at,index,target:{...at,type:'PatternSkip'}}:
        {...span(item),index,rest:item.type==='RestElement',target:pattern(item.type==='RestElement'?item.argument:item,depth+1)})};
      if(node.type==='ObjectPattern')return {...at,type:'PatternObject',entries:node.properties.map(item=>{
        if(item.type==='RestElement')return {...span(item),rest:true,target:pattern(item.argument,depth+1)};
        if(item.type!=='Property'||item.kind!=='init'||item.method)reject(item,'object binding property form');
        const key=item.computed?null:item.key.type==='Identifier'?item.key.name:
          item.key.type==='Literal'?String(item.key.value):null;
        if(!item.computed&&key===null)reject(item,'object binding key');
        return {...span(item),key,computedKey:item.computed?expr(item.key):null,target:pattern(item.value,depth+1)};
      })};
      reject(node,'destructuring target');
    }
    return {pattern:pattern(root),bindings:names};
  }
  function parameters(n){
    return n.params.map((parameter,i)=>{
      const rest=parameter.type==='RestElement',p=rest?parameter.argument:parameter;
      if(rest&&i!==n.params.length-1)reject(parameter,'rest parameter position');
      const target=p.type==='AssignmentPattern'?p.left:p;
      const fallback=p.type==='AssignmentPattern'?expr(p.right):null;
      if(target.type==='Identifier')return {...span(parameter),name:target.name,default:fallback,rest};
      if(!['ArrayPattern','ObjectPattern'].includes(target.type))reject(target,'parameter pattern');
      const parsed=patternTree(target);
      return {...span(parameter),name:'[[parameter '+i+']]',default:fallback,rest,...parsed};
    });
  }
  function expr(n) {
    if(!n)reject(parsed,'missing expression');
    const loc=span(n);
    switch(n.type) {
      case 'Literal':
        // Retain nonexecuted RegExp syntax without pretending the owned VM
        // implements RegExp. Execution of this node is a terminal refusal.
        if(n.regex){
          // Only the exact pinned CR/LF delimiters have a bounded owned scanner.
          // Everything else is compiled as unreachable-or-refused syntax.
          if(supportsPinnedRegExp(n.regex.pattern,n.regex.flags))
            return {...loc,type:'OwnedPinnedRegExp',pattern:n.regex.pattern,flags:n.regex.flags};
          return {...loc,type:'DeferredRegExp',pattern:n.regex.pattern,flags:n.regex.flags};
        }
        return {...loc,type:'Literal',value:encode(n.bigint!==undefined?BigInt(n.bigint):n.value),raw:n.raw};
      case 'Identifier':return {...loc,type:'Identifier',name:n.name};
      case 'ThisExpression':return {...loc,type:'This'};
      case 'ArrowFunctionExpression':case 'FunctionExpression':{
        if(n.generator)
          reject(n,'function expression parameters or mode');
        const parsedParams=parameters(n);
        const body=n.body.type==='BlockStatement'?stmt(n.body):
          {...span(n.body),type:'Block',body:[
            {...span(n.body),type:'Return',argument:expr(n.body)}]};
        return {...loc,type:'FunctionExpr',
          arrow:n.type==='ArrowFunctionExpression',async:n.async,
          name:n.id?.name??null,
          params:parsedParams.map(p=>p.name),defaults:parsedParams.map(p=>p.default),
          parameterSites:parsedParams.map(span),
          parameterPatterns:parsedParams.map(p=>p.pattern?{pattern:p.pattern,bindings:p.bindings}:null),
          parameterNames:parsedParams.flatMap(p=>[p.name,...(p.bindings??[]).map(b=>b.name)]),
          restIndex:parsedParams.findIndex(p=>p.rest),body};
      }
      case 'TemplateLiteral':
        if(n.quasis.length!==n.expressions.length+1||
           n.quasis.some(q=>typeof q.value.cooked!=='string'))
          reject(n,'unhandled template literal escape');
        return {...loc,type:'Template',quasis:n.quasis.map(q=>q.value.cooked),
          expressions:n.expressions.map(expr)};
      case 'AwaitExpression':
        return {...loc,type:'Await',argument:expr(n.argument)};
      case 'UnaryExpression':
        if(!unary.has(n.operator))reject(n,'unary operator');
        return {...loc,type:'Unary',operator:n.operator,argument:expr(n.argument)};
      case 'BinaryExpression':case 'LogicalExpression':
        if(!(n.type==='BinaryExpression'?binaries:logical).has(n.operator))reject(n,'binary operator');
        return {...loc,type:'Binary',operator:n.operator,left:expr(n.left),right:expr(n.right)};
      case 'SequenceExpression':
        if(n.expressions.length<2)reject(n,'empty sequence');
        return {...loc,type:'Sequence',expressions:n.expressions.map(expr)};
      case 'ConditionalExpression':
        return {...loc,type:'Conditional',test:expr(n.test),
          consequent:expr(n.consequent),alternate:expr(n.alternate)};
      case 'UpdateExpression':
        if(!['Identifier','MemberExpression'].includes(n.argument.type))
          reject(n,'update target');
        return {...loc,type:'Update',operator:n.operator,prefix:n.prefix,
          ...(n.argument.type==='Identifier'
            ?{name:n.argument.name}:{argument:expr(n.argument)})};
      case 'ChainExpression':{
        // A single short-circuit region, retaining receiver and evaluation
        // order rather than copying a computed key or invoking native eval.
        const steps=[];
        let current=n.expression;
        while(current.type==='MemberExpression'||current.type==='CallExpression'){
          if(current.type==='MemberExpression'){
            if(current.object.type==='Super'||current.property.type==='PrivateIdentifier')
              reject(current,'optional super/private member');
            steps.unshift({...span(current),type:'member',optional:!!current.optional,
              property:current.computed?expr(current.property):
                {...span(current.property),type:'Literal',value:encode(current.property.name)}});
            current=current.object;
          }else{
            if(current.arguments.filter(a=>a.type==='SpreadElement').length>4)
              reject(current,'optional chain spread budget');
            steps.unshift({...span(current),type:'call',optional:!!current.optional,
              args:current.arguments.map(a=>a.type==='SpreadElement'?
                {...span(a),type:'Spread',argument:expr(a.argument)}:expr(a))});
            current=current.callee;
          }
        }
        if(!steps.some(step=>step.optional))reject(n,'chain without optional step');
        if(current.type==='Identifier' && ['eval','Function','require'].includes(current.name) &&
           steps.some(step=>step.type==='call'))
          reject(n,'dynamic source or host call');
        // Optional method calls retain the receiver-carrying GET_METHOD
        // token. The VM guards its callable payload before consuming args.
        return {...loc,type:'OptionalChain',base:expr(current),steps};
      }
      case 'MemberExpression':
        if(n.optional || n.object.type==='Super')reject(n,'member receiver');
        return {...loc,type:'Member',object:expr(n.object),property:n.computed?expr(n.property):
          {...span(n.property),type:'Literal',value:encode(n.property.name)}};
      case 'NewExpression':
        if(n.callee.type!=='Identifier'||n.arguments.some(a=>a.type==='SpreadElement')||
           n.arguments.length>3)reject(n,'NewExpression');
        if(n.callee.name==='Proxy'){
          if(n.arguments.length!==2)reject(n,'Proxy requires target and handler');
          return {...loc,type:'Proxy',target:expr(n.arguments[0]),handler:expr(n.arguments[1])};
        }
        if(!ownedConstructors.has(n.callee.name))reject(n,'NewExpression');
        return {...loc,type:'Construct',callee:n.callee.name,args:n.arguments.map(expr)};
      case 'CallExpression':
        if(n.optional || n.arguments.filter(a=>a.type==='SpreadElement').length>4)
          reject(n,'spread/optional call');
        if(n.callee.type==='Identifier' && ['eval','Function','require'].includes(n.callee.name))
          reject(n,'dynamic source or host call');
        return {...loc,type:'Call',callee:expr(n.callee),
          args:n.arguments.map(a=>a.type==='SpreadElement'?
            {...span(a),type:'Spread',argument:expr(a.argument)}:expr(a))};
      case 'ArrayExpression':
        if(n.elements.filter(e=>e?.type==='SpreadElement').length>4)
          reject(n,'array literal spread budget');
        return {...loc,type:'Array',elements:n.elements.map(e=>e===null?null:e.type==='SpreadElement'?
          {...span(e),type:'Spread',argument:expr(e.argument)}:expr(e))};
      case 'ObjectExpression':
        return {...loc,type:'Object',properties:n.properties.map(p=>{
          if(p.type==='SpreadElement')return {...span(p),kind:'spread',value:expr(p.argument)};
          if(p.type!=='Property'||!['init','get','set'].includes(p.kind))
            reject(p,'object property form');
          const key=p.computed?null:p.key.type==='Identifier'?p.key.name:
            p.key.type==='Literal'?String(p.key.value):null;
          if(!p.computed&&key===null)reject(p,'object property key');
          const kind=key==='__proto__'&&!p.computed&&!p.shorthand&&!p.method&&p.kind==='init'
            ?'prototype':p.kind;
          return {...span(p),key,computedKey:p.computed?expr(p.key):null,kind,value:expr(p.value)};
        })};
      case 'AssignmentExpression':
        if(n.operator==='='&&['ArrayPattern','ObjectPattern'].includes(n.left.type))
          return {...loc,type:'PatternAssignment',kind:'assignment',init:expr(n.right),...patternTree(n.left,{assignment:true})};
        if(!assignments.has(n.operator) ||
           !['Identifier','MemberExpression'].includes(n.left.type))
          reject(n,'assignment form');
        return {...loc,type:'Assign',operator:n.operator,left:expr(n.left),right:expr(n.right)};
      default:reject(n,n.type);
    }
  }
  function stmt(n) {
    const loc=span(n);
    switch(n.type) {
      case 'BlockStatement':return {...loc,type:'Block',body:n.body.map(stmt)};
      case 'VariableDeclaration':{
        if(!['let','const','var'].includes(n.kind)||!n.declarations.length)reject(n,'declaration form');
        const declarations=n.declarations.map(d=>{
          if(d.id.type==='Identifier')return {...span(d),type:'Variable',kind:n.kind,
            id:d.id.name,init:d.init?expr(d.init):null};
          if(!d.init)reject(d,'destructuring requires an initializer');
          return {...span(d),type:'PatternBinding',kind:n.kind,init:expr(d.init),...patternTree(d.id)};
        });
        return declarations.length===1?declarations[0]:{...loc,type:'VariableGroup',declarations};
      }
      case 'FunctionDeclaration':{
        if(!n.id || n.generator)reject(n,'function form');
        const parsedParams=parameters(n);
        return {...loc,type:'Function',id:n.id.name,
          params:parsedParams.map(x=>x.name),defaults:parsedParams.map(x=>x.default),
          parameterSites:parsedParams.map(span),
          parameterPatterns:parsedParams.map(p=>p.pattern?{pattern:p.pattern,bindings:p.bindings}:null),
          parameterNames:parsedParams.flatMap(p=>[p.name,...(p.bindings??[]).map(b=>b.name)]),
          restIndex:parsedParams.findIndex(p=>p.rest),async:n.async,body:stmt(n.body)};
      }
      case 'ReturnStatement':return {...loc,type:'Return',argument:n.argument?expr(n.argument):null};
      case 'ThrowStatement':
        return {...loc,type:'Throw',argument:expr(n.argument)};
      case 'TryStatement':{
        const handler=n.handler?{
          param:n.handler.param?.type==='Identifier'?n.handler.param.name:null,
          body:stmt(n.handler.body)
        }:null;
        if(n.handler?.param&&n.handler.param.type!=='Identifier'){
          handler.param='[[catch '+n.handler.start+']]';
          handler.body.body.unshift({...span(n.handler.param),type:'PatternBinding',kind:'let',
            init:{...span(n.handler.param),type:'Identifier',name:handler.param},...patternTree(n.handler.param)});
        }
        return {...loc,type:'Try',block:stmt(n.block),handler,
          finalizer:n.finalizer?stmt(n.finalizer):null};
      }
      case 'SwitchStatement':{
        if(n.cases.length>128)reject(n,'switch case budget');
        return {...loc,type:'Switch',discriminant:expr(n.discriminant),
          cases:n.cases.map(c=>({...span(c),test:c.test?expr(c.test):null,
            body:c.consequent.map(stmt)}))};
      }
      case 'LabeledStatement':return {...loc,type:'Label',label:n.label.name,body:stmt(n.body)};
      case 'IfStatement':return {...loc,type:'If',test:expr(n.test),
        consequent:stmt(n.consequent),alternate:n.alternate?stmt(n.alternate):null};
      case 'WhileStatement':return {...loc,type:'While',test:expr(n.test),body:stmt(n.body)};
      case 'DoWhileStatement':return {...loc,type:'DoWhile',test:expr(n.test),body:stmt(n.body)};
      case 'ForOfStatement':{
        if(n.await || n.left?.type!=='VariableDeclaration' ||
           !['const','let','var'].includes(n.left.kind) ||
           n.left.declarations.length!==1 ||n.left.declarations[0].init)
          reject(n,'for-of requires one simple declared binding');
        const target=n.left.declarations[0].id;
        const array=target.type==='ArrayPattern'&&n.left.kind!=='var';
        if(target.type!=='Identifier'&&!array)
          reject(target,'for-of binding form');
        let bindings=null;
        if(array){
          if(!target.elements.length||target.elements.length>32||
             target.elements.some(x=>x?.type!=='Identifier'&&
               !(x?.type==='AssignmentPattern'&&x.left.type==='Identifier')))
            reject(target,'for-of array binding requires 1..32 identifiers');
          bindings=target.elements.map((element,index)=>({
            ...span(element),index,
            name:element.type==='Identifier'?element.name:element.left.name,
            fallback:element.type==='AssignmentPattern'?expr(element.right):null
          }));
          if(new Set(bindings.map(x=>x.name)).size!==bindings.length)
            reject(target,'duplicate for-of array binding');
        }
        return {...loc,type:'ForOf',kind:n.left.kind,
          id:bindings?null:target.name,bindings,
          iterable:expr(n.right),body:stmt(n.body)};
      }
      case 'ForStatement':{
        let init=null;
        if(n.init?.type==='VariableDeclaration'){
          if(!['let','var'].includes(n.init.kind)||!n.init.declarations.length ||
             n.init.declarations.length>8 || n.init.declarations.some(d=>
               d.id.type!=='Identifier'||(n.init.kind==='let'&&!d.init)))
            reject(n.init,'for initializer (1..8 initialized let or var bindings required)');
          init=stmt(n.init);
        }else if(n.init)init=expr(n.init);
        const body=stmt(n.body);
        // A distinct environment is captured by functions defined in each iteration.
        return {...loc,type:'For',init,test:n.test?expr(n.test):null,
          update:n.update?expr(n.update):null,body};
      }
      case 'BreakStatement':case 'ContinueStatement':
        return {...loc,type:n.type==='BreakStatement'?'Break':'Continue',label:n.label?.name??null};
      case 'ExpressionStatement':return {...loc,type:'Expression',expr:expr(n.expression)};
      case 'EmptyStatement':return {...loc,type:'Empty'};
      default:reject(n,n.type);
    }
  }
  const body=parsed.body.map(stmt);
  // Resolve references against lexical scopes, including the per-loop let header.
  // Never silently turn an unknown identifier into an ambient Node global.
  function scope(statements,parent,params=[],asyncFunction=false,functionScope=false,defaults=[],patterns=[]) {
    const names=new Set(params);
    if(functionScope)
      for(const name of collectVarBindings(statements))names.add(name);
    for(const n of statements){
      const entries=(n.type==='VariableGroup'?n.declarations:[n]).flatMap(d=>
        d.type==='PatternBinding'?d.bindings.map(binding=>({id:binding.name,kind:d.kind,...span(binding)})):
        ['Variable','Function'].includes(d.type)?[d]:[]);
      for(const d of entries){
        if(d.kind==='var')continue;
        if(names.has(d.id))reject(d,'duplicate lexical binding');
        names.add(d.id);
      }
    }
    const env={names,parent};
    const has=(name,e)=>!!e&&(e.names.has(name)||has(name,e.parent));
    function value(n,e){
      switch(n.type){
        case 'Identifier':
          if(!has(n.name,e))reject(n,'unbound identifier '+n.name);
          break;
        case 'Template':n.expressions.forEach(x=>value(x,e));break;
        case 'FunctionExpr':scope(n.body.body,n.name?{names:new Set([n.name]),parent:e}:e,
          n.parameterNames??n.params,n.async,true,n.defaults,n.parameterPatterns);break;
        case 'Await':
          if(!asyncFunction)reject(n,'await outside async function');
          value(n.argument,e);break;
        case 'Unary':
          // ECMAScript typeof on an unresolvable name is defined as 'undefined';
          // a declared but uninitialized lexical binding still throws (TDZ).
          if(n.operator==='typeof' && n.argument.type==='Identifier' &&
             !has(n.argument.name,e))break;
          value(n.argument,e);break;
        case 'Binary':value(n.left,e);value(n.right,e);break;
        case 'Sequence':n.expressions.forEach(x=>value(x,e));break;
        case 'Conditional':
          value(n.test,e);value(n.consequent,e);value(n.alternate,e);break;
        case 'Update':
          if(n.argument)value(n.argument,e);
          else if(!has(n.name,e))reject(n,'unbound update target '+n.name);
          break;
        case 'OptionalChain':
          value(n.base,e);
          for(const step of n.steps){
            if(step.type==='member')value(step.property,e);
            else for(const arg of step.args)
              value(arg.type==='Spread'?arg.argument:arg,e);
          }
          break;
        case 'Member':value(n.object,e);value(n.property,e);break;
        case 'Call':value(n.callee,e);n.args.forEach(x=>value(x.type==='Spread'?x.argument:x,e));break;
        case 'Construct':if(!has(n.callee,e))reject(n,'unbound constructor');
          n.args.forEach(x=>value(x,e));break;
        case 'DeferredRegExp':case 'OwnedPinnedRegExp':break;
        case 'Array':n.elements.forEach(x=>{if(x)value(x.type==='Spread'?x.argument:x,e);});break;
        case 'Proxy':value(n.target,e);value(n.handler,e);break;
        case 'Object':n.properties.forEach(p=>{if(p.computedKey)value(p.computedKey,e);value(p.value,e);});break;
        case 'Assign':value(n.left,e);value(n.right,e);break;
        case 'PatternAssignment':statement(n,e);break;
        case 'Literal':case 'This':break;
        default:reject(n,'unhandled expression');
      }
    }
    function statement(n,e){
      switch(n.type){
        case 'Variable':if(n.init)value(n.init,e);break;
        case 'PatternBinding':case 'PatternAssignment':{
          // Guard the modeled Array.isArray intrinsic against lexical
          // shadowing even when the array occurs under an object pattern.
          function hasArray(node){
            if(node.type==='PatternArray')return true;
            if(node.type==='PatternDefault')return hasArray(node.target);
            if(node.type==='PatternObject')
              return node.entries.some(item=>hasArray(item.target));
            return false;
          }
          if(hasArray(n.pattern))
            for(let cursor=e;cursor?.parent;cursor=cursor.parent)
              if(cursor.names.has('Array'))
                reject(n,'array pattern requires unshadowed owned Array intrinsic');
          function defaults(node){
            if(node.type==='PatternName'&&n.kind==='assignment'){if(!has(node.name,e))reject(node,'unbound assignment '+node.name);}
            else if(node.type==='PatternMember')value(node.target,e);
            else if(node.type==='PatternDefault'){
              value(node.fallback,e);defaults(node.target);
            }else if(node.type==='PatternObject')
              node.entries.forEach(item=>{
                if(item.computedKey)value(item.computedKey,e);
                defaults(item.target);
              });
            else if(node.type==='PatternArray')
              node.elements.forEach(item=>defaults(item.target));
          }
          value(n.init,e);defaults(n.pattern);break;
        }
        case 'VariableGroup':n.declarations.forEach(x=>statement(x,e));break;
        case 'Function':scope(n.body.body,e,n.parameterNames??n.params,n.async,true,n.defaults,n.parameterPatterns);break;
        case 'Block':scope(n.body,e,[],asyncFunction);break;
        case 'Switch':{
          value(n.discriminant,e);
          scope(n.cases.flatMap(c=>[...(c.test?[{type:'Expression',expr:c.test}]:[]),...c.body]),e,[],asyncFunction);
          break;
        }
        case 'Label':statement(n.body,e);break;
        case 'If':
          value(n.test,e);statement(n.consequent,e);
          if(n.alternate)statement(n.alternate,e);
          break;
        case 'While':case 'DoWhile':
          value(n.test,e);statement(n.body,e);break;
        case 'ForOf':{
          value(n.iterable,e);
          const loopEnv=n.kind==='var'?e:{
            names:new Set(n.bindings?n.bindings.map(x=>x.name):[n.id]),parent:e
          };
          if(n.bindings)
            for(let cursor=loopEnv;cursor?.parent;cursor=cursor.parent)
              if(cursor.names.has('Array'))
                reject(n,'for-of array binding requires unshadowed owned Array');
          for(const binding of n.bindings??[])
            if(binding.fallback)value(binding.fallback,loopEnv);
          statement(n.body,loopEnv);
          break;
        }
        case 'For':{
          const declarations=n.init?.type==='VariableGroup'?n.init.declarations:
            n.init?.type==='Variable'?[n.init]:[];
          const loopEnv=declarations[0]?.kind==='let'
            ?{names:new Set(declarations.map(d=>d.id)),parent:e}:e;
          if(n.init){
            if(['Variable','VariableGroup'].includes(n.init.type))
              statement(n.init,loopEnv);
            else value(n.init,loopEnv);
          }
          if(n.test)value(n.test,loopEnv);
          if(n.update)value(n.update,loopEnv);
          statement(n.body,loopEnv);
          break;
        }
        case 'Try':
          statement(n.block,e);
          if(n.handler)
            scope(n.handler.body.body,e,n.handler.param===null?[]:[n.handler.param],asyncFunction);
          if(n.finalizer)statement(n.finalizer,e);
          break;
        case 'Throw':value(n.argument,e);break;
        case 'Return':if(n.argument)value(n.argument,e);break;
        case 'Expression':value(n.expr,e);break;
        case 'Break':case 'Continue':case 'Empty':break;
        default:reject(n,'unhandled statement');
      }
    }
    // All parameter names shadow the outer scope during initialization.
    // Runtime initialization order enforces TDZ for the current/later names;
    // closures may capture those names and call them after initialization.
    // Body bindings never enter an initializer's lexical environment.
    defaults.forEach(initializer=>{
      if(initializer)value(initializer,{
        names:new Set(params),parent
      });
    });
    for(const parsed of patterns??[])if(parsed)statement({type:'PatternBinding',kind:'parameter',
      init:{type:'Literal'},pattern:parsed.pattern},{names:new Set(params),parent});
    statements.forEach(n=>statement(n,env));
  }
  scope(body,{names:new Set(['undefined','Object','Array','Number','BigInt','String','Symbol','Reflect','Math','Promise','Set','Error','TypeError','Date','console','host','NaN','Infinity','parseInt','isNaN','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval','SharedArrayBuffer','DataView',...ownedConstructors,'Atomics']),parent:null},[],false,true);
  return {type:'Program',body,start:0,end:source.length,profile:TRAINING_PROFILE};
}
