// Versioned, fail-closed Acorn -> owned bytecode frontend for training-js/1.
// Parsing is not execution: the compiler/runtime own semantics.
import {parse as acornParse} from 'acorn';
import {encode} from '../values.js';

export const TRAINING_PROFILE='training-js/1';
export const TRAINING_PARSER='acorn/8.15.0:training-js/1';
const binaries=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
  '&','|','^','<<','>>','>>>']);
const logical=new Set(['&&','||','??']);
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
  if(parsed.body.slice(1).some(n=>n.type!=='FunctionDeclaration'))
    reject(parsed,'top-level code must only declare functions');

  const span=n=>({start:n.start,end:n.end});
  function expr(n) {
    if(!n)reject(parsed,'missing expression');
    const loc=span(n);
    switch(n.type) {
      case 'Literal':
        if(n.regex)reject(n,'regular expression');
        return {...loc,type:'Literal',value:encode(n.bigint!==undefined?BigInt(n.bigint):n.value),raw:n.raw};
      case 'Identifier':return {...loc,type:'Identifier',name:n.name};
      case 'TemplateLiteral':
        if(n.quasis.length!==n.expressions.length+1||
           n.quasis.some(q=>typeof q.value.cooked!=='string'))
          reject(n,'unhandled template literal escape');
        return {...loc,type:'Template',quasis:n.quasis.map(q=>q.value.cooked),
          expressions:n.expressions.map(expr)};
      case 'UnaryExpression':
        if(!unary.has(n.operator))reject(n,'unary operator');
        return {...loc,type:'Unary',operator:n.operator,argument:expr(n.argument)};
      case 'BinaryExpression':case 'LogicalExpression':
        if(!(n.type==='BinaryExpression'?binaries:logical).has(n.operator))reject(n,'binary operator');
        return {...loc,type:'Binary',operator:n.operator,left:expr(n.left),right:expr(n.right)};
      case 'ConditionalExpression':
        return {...loc,type:'Conditional',test:expr(n.test),
          consequent:expr(n.consequent),alternate:expr(n.alternate)};
      case 'UpdateExpression':
        if(!['Identifier','MemberExpression'].includes(n.argument.type))
          reject(n,'update target');
        return {...loc,type:'Update',operator:n.operator,prefix:n.prefix,
          ...(n.argument.type==='Identifier'
            ?{name:n.argument.name}:{argument:expr(n.argument)})};
      case 'MemberExpression':
        if(n.optional || n.object.type==='Super')reject(n,'member receiver');
        return {...loc,type:'Member',object:expr(n.object),property:n.computed?expr(n.property):
          {...span(n.property),type:'Literal',value:encode(n.property.name)}};
      case 'CallExpression':
        if(n.optional || n.arguments.some(a=>a.type==='SpreadElement'))reject(n,'spread/optional call');
        if(n.callee.type==='Identifier' && ['eval','Function','require'].includes(n.callee.name))
          reject(n,'dynamic source or host call');
        return {...loc,type:'Call',callee:expr(n.callee),args:n.arguments.map(expr)};
      case 'ArrayExpression':
        if(n.elements.some(e=>!e || e.type==='SpreadElement'))reject(n,'sparse/spread array');
        return {...loc,type:'Array',elements:n.elements.map(expr)};
      case 'ObjectExpression':
        return {...loc,type:'Object',properties:n.properties.map(p=>{
          if(p.type!=='Property' || p.kind!=='init' || p.method || p.computed || p.shorthand)
            reject(p,'object property form');
          const key=p.key.type==='Identifier'?p.key.name:
            p.key.type==='Literal'?String(p.key.value):null;
          if(key===null || key==='__proto__')reject(p,'object property key');
          return {key,value:expr(p.value)};
        })};
      case 'AssignmentExpression':
        if(!['=','+=','-='].includes(n.operator) ||
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
        if(!['let','const'].includes(n.kind)||n.declarations.length!==1 ||
           n.declarations[0].id.type!=='Identifier')reject(n,'declaration form');
        return {...loc,type:'Variable',kind:n.kind,id:n.declarations[0].id.name,
          init:n.declarations[0].init?expr(n.declarations[0].init):null};
      case 'FunctionDeclaration':
        if(!n.id || n.async || n.generator || n.params.some(x=>x.type!=='Identifier'))
          reject(n,'function form');
        return {...loc,type:'Function',id:n.id.name,params:n.params.map(x=>x.name),
          async:false,body:stmt(n.body)};
      case 'ReturnStatement':return {...loc,type:'Return',argument:n.argument?expr(n.argument):null};
      case 'IfStatement':return {...loc,type:'If',test:expr(n.test),
        consequent:stmt(n.consequent),alternate:n.alternate?stmt(n.alternate):null};
      case 'WhileStatement':return {...loc,type:'While',test:expr(n.test),body:stmt(n.body)};
      case 'DoWhileStatement':return {...loc,type:'DoWhile',test:expr(n.test),body:stmt(n.body)};
      case 'ForStatement':{
        let init=null;
        if(n.init?.type==='VariableDeclaration'){
          if(n.init.kind!=='let'||n.init.declarations.length!==1||
             n.init.declarations[0].id.type!=='Identifier'||!n.init.declarations[0].init)
            reject(n.init,'for initializer (one initialized let binding required)');
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
  function scope(statements,parent,params=[]) {
    const names=new Set(params);
    for(const n of statements)if(['Variable','Function'].includes(n.type)){
      if(names.has(n.id))reject(n,'duplicate lexical binding');
      names.add(n.id);
    }
    const env={names,parent};
    const has=(name,e)=>!!e&&(e.names.has(name)||has(name,e.parent));
    function value(n,e){
      switch(n.type){
        case 'Identifier':
          if(!has(n.name,e))reject(n,'unbound identifier '+n.name);
          break;
        case 'Template':n.expressions.forEach(x=>value(x,e));break;
        case 'Unary':
          // ECMAScript typeof on an unresolvable name is defined as 'undefined';
          // a declared but uninitialized lexical binding still throws (TDZ).
          if(n.operator==='typeof' && n.argument.type==='Identifier' &&
             !has(n.argument.name,e))break;
          value(n.argument,e);break;
        case 'Binary':value(n.left,e);value(n.right,e);break;
        case 'Conditional':
          value(n.test,e);value(n.consequent,e);value(n.alternate,e);break;
        case 'Update':
          if(n.argument)value(n.argument,e);
          else if(!has(n.name,e))reject(n,'unbound update target '+n.name);
          break;
        case 'Member':value(n.object,e);value(n.property,e);break;
        case 'Call':value(n.callee,e);n.args.forEach(x=>value(x,e));break;
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
        case 'Function':scope(n.body.body,e,n.params);break;
        case 'Block':scope(n.body,e);break;
        case 'If':
          value(n.test,e);statement(n.consequent,e);
          if(n.alternate)statement(n.alternate,e);
          break;
        case 'While':case 'DoWhile':
          value(n.test,e);statement(n.body,e);break;
        case 'For':{
          const loopEnv=n.init?.type==='Variable'
            ?{names:new Set([n.init.id]),parent:e}:e;
          if(n.init){
            if(n.init.type==='Variable')statement(n.init,loopEnv);
            else value(n.init,loopEnv);
          }
          if(n.test)value(n.test,loopEnv);
          if(n.update)value(n.update,loopEnv);
          statement(n.body,loopEnv);
          break;
        }
        case 'Return':if(n.argument)value(n.argument,e);break;
        case 'Expression':value(n.expr,e);break;
        case 'Break':case 'Continue':case 'Empty':break;
        default:reject(n,'unhandled statement');
      }
    }
    statements.forEach(n=>statement(n,env));
  }
  scope(body,{names:new Set(['undefined','Object','Array','Number','Math']),parent:null});
  return {type:'Program',body,start:0,end:source.length,profile:TRAINING_PROFILE};
}
