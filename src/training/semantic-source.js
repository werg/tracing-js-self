// Source-aware explanations for the model-facing witness. Source is only a
// candidate explanation: the committed public state and the independent
// primitive evaluator decide whether the claim can be emitted.
// This module neither executes guest JavaScript nor consults a future state.
import {validateExpression} from './format.js';
import {checkWitnessClaim} from './witness-check.js';

const binary=new Set(['+','-','*','/','%','**','<','<=','>','>=','===','!==',
  '==','!=','&','|','^','<<','>>','>>>']);
const unary=new Set(['!','+','-','~','typeof','void']);

function scalar(value) {
  if(value===null)return ['null'];
  if(value===undefined)return ['undefined'];
  if(typeof value==='boolean')return ['bool',value];
  if(typeof value==='string')return ['str',value];
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number')return ['num',Object.is(value,-0)?'-0':
    Number.isNaN(value)?'NaN':value===Infinity?'+Infinity':
    value===-Infinity?'-Infinity':value];
  return null;
}

// Only plain, already-present *own data* properties may appear as a read.
// In particular, a source member expression is not evidence that a getter,
// proxy trap or inherited lookup can be silently reduced to a read primitive.
function member(node,scope) {
  if(node.optional||node.object?.type!=='Identifier')return null;
  const key=node.computed?
    node.property?.type==='Literal'&&(typeof node.property.value==='string'||
      typeof node.property.value==='number')?String(node.property.value):null:
    node.property?.type==='Identifier'?node.property.name:null;
  if(key===null)return null;
  const base=scope.resolveLocal(node.object.name);
  if(base?.value?.[0]!=='ref'||!scope.hasOwnData(base.value[1],key))return null;
  return {op:'read',object:base.value[1],key};
}

function lower(node,scope,depth=0) {
  if(!node||depth>8)return null;
  if(node.type==='Literal'&&!node.regex){
    const value=scalar(node.value);
    return value?{op:'literal',value}:null;
  }
  if(node.type==='Identifier'){
    const binding=scope.resolveLocal(node.name);
    return binding?{op:'local',name:binding.name}:null;
  }
  if(node.type==='MemberExpression')return member(node,scope);
  if(node.type==='UnaryExpression'&&node.prefix&&unary.has(node.operator)){
    const arg=lower(node.argument,scope,depth+1);
    return arg?{op:'unary',operator:node.operator,arg}:null;
  }
  if(node.type==='BinaryExpression'&&binary.has(node.operator)){
    const left=lower(node.left,scope,depth+1),right=lower(node.right,scope,depth+1);
    return left&&right?{op:'binary',operator:node.operator,left,right}:null;
  }
  // Calls, assignments, updates, short-circuit evaluation, await, optional
  // access and constructors may execute arbitrary guest code; never infer
  // their results from their source spelling.
  return null;
}
function checked(node,value,scope,maxOperators) {
  const expression=lower(node,scope);
  if(!expression)return null;
  try {
    validateExpression(expression,{maxOperators});
    const claim=checkWitnessClaim(expression,value,{
      locals:scope.locals,readProperty:scope.readProperty});
    return claim.consistent?expression:null;
  }catch{
    return null;
  }
}

export function sourceLinkedDecision(node,value,scope,{maxOperators=8}={}) {
  const test=['IfStatement','WhileStatement','DoWhileStatement','ForStatement',
    'ConditionalExpression'].includes(node?.type)?node.test:node;
  const expression=checked(test,value,scope,maxOperators);
  return expression?.op==='literal'?null:expression;
}

export function sourceLinkedComputation(expr,node,scope) {
  if(expr?.op!=='binary')return expr;
  if(node?.type==='BinaryExpression'?node.operator!==expr.operator:
     node?.type==='AssignmentExpression'?node.operator!==expr.operator+'=':true)
    return expr;
  // An evaluated operand is not replaced by a lookalike source term. Only an
  // identifier or known ordinary own-property *already committed* to the
  // visible state may replace it, and its exact observed value must agree.
  const substitute=(leaf,source)=>{
    if(leaf?.op!=='literal'||!['Identifier','MemberExpression'].includes(source?.type))
      return leaf;
    return checked(source,leaf.value,scope,8)??leaf;
  };
  return {...expr,left:substitute(expr.left,node.left),
    right:substitute(expr.right,node.right)};
}
