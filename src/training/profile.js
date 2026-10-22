// Versioned, fail-closed Acorn -> owned bytecode frontend for training-js/1.
// Parsing is not execution: the compiler/runtime own semantics.
import {parse as acornParse} from 'acorn';
import {encode} from '../values.js';

export const TRAINING_PROFILE='training-js/1';
export const TRAINING_PARSER='acorn/8.15.0:training-js/1';
const binaries=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=']);
const logical=new Set(['&&','||','??']);
const unary=new Set(['!','-','+','typeof']);
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
      case 'UnaryExpression':
        if(!unary.has(n.operator))reject(n,'unary operator');
        return {...loc,type:'Unary',operator:n.operator,argument:expr(n.argument)};
      case 'BinaryExpression':case 'LogicalExpression':
        if(!(n.type==='BinaryExpression'?binaries:logical).has(n.operator))reject(n,'binary operator');
        return {...loc,type:'Binary',operator:n.operator,left:expr(n.left),right:expr(n.right)};
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
           !['Identifier','MemberExpression'].includes(n.left.type) ||
           (n.left.type==='MemberExpression' && n.operator!=='='))
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
      case 'ExpressionStatement':return {...loc,type:'Expression',expr:expr(n.expression)};
      case 'EmptyStatement':return {...loc,type:'Empty'};
      default:reject(n,n.type);
    }
  }
  const body=parsed.body.map(stmt);
  // Check references against declared lexical bindings, never Node globals.
  function scope(statements,parent,params=[]) {
    const names=new Set(params);
    for(const n of statements)if(['Variable','Function'].includes(n.type)){
      if(names.has(n.id))reject(n,'duplicate lexical binding');
      names.add(n.id);
    }
    const env={names,parent};
    const has=(name,e=env)=>!!e&&(e.names.has(name)||has(name,e.parent));
    function value(n){
      switch(n.type){
        case 'Identifier':if(!has(n.name))reject(n,'unbound identifier '+n.name);break;
        case 'Unary':value(n.argument);break;
        case 'Binary':value(n.left);value(n.right);break;
        case 'Member':value(n.object);value(n.property);break;
        case 'Call':value(n.callee);n.args.forEach(value);break;
        case 'Array':n.elements.forEach(value);break;
        case 'Object':n.properties.forEach(p=>value(p.value));break;
        case 'Assign':value(n.left);value(n.right);break;
        case 'Literal':break;
        default:reject(n,'unhandled expression');
      }
    }
    function statement(n) {
      switch(n.type){
        case 'Variable':if(n.init)value(n.init);break;
        case 'Function':scope(n.body.body,env,n.params);break;
        case 'Block':scope(n.body,env);break;
        case 'If':value(n.test);statement(n.consequent);
          if(n.alternate)statement(n.alternate);break;
        case 'While':value(n.test);statement(n.body);break;
        case 'Return':if(n.argument)value(n.argument);break;
        case 'Expression':value(n.expr);break;
        case 'Empty':break;
        default:reject(n,'unhandled statement');
      }
    }
    statements.forEach(statement);
  }
  scope(body,{names:new Set(['undefined']),parent:null});
  return {type:'Program',body,start:0,end:source.length,profile:TRAINING_PROFILE};
}
