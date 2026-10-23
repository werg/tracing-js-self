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
const assignments=new Set(['=','+=','-=','*=','/=','%=','**=',
  '&=','|=','^=','<<=','>>=','>>>=']);
const unary=new Set(['!','-','+','typeof','void','~']);
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
  function parameters(n){
    return n.params.map((p,i)=>{
      if(p.type==='RestElement' && p.argument?.type==='Identifier' && i===n.params.length-1)
        return {name:p.argument.name,default:null,rest:true};
      if(p.type==='Identifier')return {name:p.name,default:null};
      if(p.type==='AssignmentPattern'&&p.left.type==='Identifier')
        return {name:p.left.name,default:expr(p.right)};
      reject(p,'parameter pattern (identifier or scalar default required)');
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
      case 'ArrowFunctionExpression':case 'FunctionExpression':{
        if(n.async || n.generator ||
           (n.type==='FunctionExpression' && n.id))
          reject(n,'function expression parameters or mode');
        const parsedParams=parameters(n);
        const body=n.body.type==='BlockStatement'?stmt(n.body):
          {...span(n.body),type:'Block',body:[
            {...span(n.body),type:'Return',argument:expr(n.body)}]};
        return {...loc,type:'FunctionExpr',
          arrow:n.type==='ArrowFunctionExpression',
          params:parsedParams.map(p=>p.name),defaults:parsedParams.map(p=>p.default),
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
        if(n.callee.type!=='Identifier' ||
           !['Set','Error','TypeError'].includes(n.callee.name) ||
           n.arguments.some(a=>a.type==='SpreadElement') || n.arguments.length>1)
          reject(n,'NewExpression');
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
        if(n.elements.some(e=>!e || e.type==='SpreadElement'))reject(n,'sparse/spread array');
        return {...loc,type:'Array',elements:n.elements.map(expr)};
      case 'ObjectExpression':
        return {...loc,type:'Object',properties:n.properties.map(p=>{
          if(p.type!=='Property' || p.kind!=='init' || p.method || p.computed)
            reject(p,'object property form');
          const key=p.key.type==='Identifier'?p.key.name:
            p.key.type==='Literal'?String(p.key.value):null;
          if(key===null || key==='__proto__')reject(p,'object property key');
          return {key,value:expr(p.value)};
        })};
      case 'AssignmentExpression':
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
      case 'VariableDeclaration':
        if(['let','const'].includes(n.kind) && n.declarations.length===1 &&
           n.declarations[0].id.type==='ObjectPattern'){
          const d=n.declarations[0],properties=d.id.properties;
          if(!d.init||!properties.length||properties.length>32)
            reject(n,'bounded object binding requires an initializer and properties');
          const bindings=properties.map(p=>{
            if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed||
               p.value.type!=='Identifier')
              reject(p,'object binding key/target');
            const key=p.key.type==='Identifier'?p.key.name:
              p.key.type==='Literal'?String(p.key.value):null;
            if(key===null||key==='__proto__')reject(p,'object binding key');
            return {...span(p),key,name:p.value.name};
          });
          return {...loc,type:'ObjectBinding',kind:n.kind,
            init:expr(d.init),bindings};
        }
        if(!['let','const','var'].includes(n.kind)||!n.declarations.length ||
           n.declarations.some(d=>d.id.type!=='Identifier'))
          reject(n,'declaration form');
        const declarations=n.declarations.map(d=>({
          ...span(d),type:'Variable',kind:n.kind,id:d.id.name,
          init:d.init?expr(d.init):null
        }));
        return declarations.length===1?declarations[0]:
          {...loc,type:'VariableGroup',declarations};
      case 'FunctionDeclaration':{
        if(!n.id || n.generator)reject(n,'function form');
        const parsedParams=parameters(n);
        return {...loc,type:'Function',id:n.id.name,
          params:parsedParams.map(x=>x.name),defaults:parsedParams.map(x=>x.default),
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
        if(n.handler?.param && n.handler.param.type!=='Identifier')
          reject(n.handler,'destructured catch parameter');
        return {...loc,type:'Try',block:stmt(n.block),handler,
          finalizer:n.finalizer?stmt(n.finalizer):null};
      }
      case 'SwitchStatement':{
        if(!n.cases.length||n.cases.length>12||
           n.cases.some((c,i)=>c.consequent.length!==1||
             c.consequent[0].type!=='ReturnStatement'||
             (c.test&&!(c.test.type==='Literal'&&typeof c.test.value==='string'))||
             (!c.test&&i!==n.cases.length-1)))
          reject(n,'switch fallthrough or complex case');
        return {...loc,type:'Switch',discriminant:expr(n.discriminant),
          cases:n.cases.map(c=>({test:c.test?expr(c.test):null,
            body:stmt(c.consequent[0])}))};
      }
      case 'IfStatement':return {...loc,type:'If',test:expr(n.test),
        consequent:stmt(n.consequent),alternate:n.alternate?stmt(n.alternate):null};
      case 'WhileStatement':return {...loc,type:'While',test:expr(n.test),body:stmt(n.body)};
      case 'DoWhileStatement':return {...loc,type:'DoWhile',test:expr(n.test),body:stmt(n.body)};
      case 'ForOfStatement':{
        if(n.await || n.left?.type!=='VariableDeclaration' ||
           !['const','let','var'].includes(n.left.kind) ||
           n.left.declarations.length!==1 ||
           n.left.declarations[0].id.type!=='Identifier' ||
           n.left.declarations[0].init)
          reject(n,'for-of requires one simple declared binding');
        return {...loc,type:'ForOf',kind:n.left.kind,
          id:n.left.declarations[0].id.name,iterable:expr(n.right),body:stmt(n.body)};
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
        if(n.label)reject(n,'labelled loop exit');
        return {...loc,type:n.type==='BreakStatement'?'Break':'Continue'};
      case 'ExpressionStatement':return {...loc,type:'Expression',expr:expr(n.expression)};
      case 'EmptyStatement':return {...loc,type:'Empty'};
      default:reject(n,n.type);
    }
  }
  const body=parsed.body.map(stmt);
  // Resolve references against lexical scopes, including the per-loop let header.
  // Never silently turn an unknown identifier into an ambient Node global.
  function scope(statements,parent,params=[],asyncFunction=false,functionScope=false,defaults=[]) {
    const names=new Set(params);
    if(functionScope)
      for(const name of collectVarBindings(statements))names.add(name);
    for(const n of statements){
      const entries=n.type==='VariableGroup'?n.declarations:
        n.type==='ObjectBinding'?n.bindings.map(binding=>({
          id:binding.name,kind:n.kind,start:binding.start,end:binding.end
        })):
        ['Variable','Function'].includes(n.type)?[n]:[];
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
        case 'FunctionExpr':scope(n.body.body,e,n.params,false,true,n.defaults);break;
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
        case 'Array':n.elements.forEach(x=>value(x,e));break;
        case 'Object':n.properties.forEach(p=>value(p.value,e));break;
        case 'Assign':value(n.left,e);value(n.right,e);break;
        case 'Literal':break;
        default:reject(n,'unhandled expression');
      }
    }
    function statement(n,e){
      switch(n.type){
        case 'Variable':if(n.init)value(n.init,e);break;
        case 'ObjectBinding':value(n.init,e);break;
        case 'VariableGroup':n.declarations.forEach(x=>statement(x,e));break;
        case 'Function':scope(n.body.body,e,n.params,n.async,true,n.defaults);break;
        case 'Block':scope(n.body,e,[],asyncFunction);break;
        case 'Switch':
          value(n.discriminant,e);
          for(const c of n.cases){if(c.test)value(c.test,e);statement(c.body,e);}
          break;
        case 'If':
          value(n.test,e);statement(n.consequent,e);
          if(n.alternate)statement(n.alternate,e);
          break;
        case 'While':case 'DoWhile':
          value(n.test,e);statement(n.body,e);break;
        case 'ForOf':{
          value(n.iterable,e);
          const loopEnv=n.kind==='var'?e:{names:new Set([n.id]),parent:e};
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
    // Parameter initializers run before body var/lexical bindings exist and
    // cannot read the current or later parameter while it is uninitialized.
    // Validate in the narrower left-to-right parameter environment.
    defaults.forEach((initializer,i)=>{
      if(initializer)value(initializer,{
        names:new Set(params.slice(0,i)),parent
      });
    });
    statements.forEach(n=>statement(n,env));
  }
  scope(body,{names:new Set(['undefined','Object','Array','Number','Math','Promise','Set','Error','TypeError','host','NaN','Infinity','parseInt','isNaN']),parent:null},[],false,true);
  return {type:'Program',body,start:0,end:source.length,profile:TRAINING_PROFILE};
}
