// Source-guided reasoning normalization. These transformations are deliberately
// narrower than execution equivalence: they only combine verified pure values,
// never reorder calls, writes, branches, or externally visible work.
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {decodeWitness,encodeWitness,validateExpression} from './format.js';
import {checkWitnessClaim} from './witness-check.js';

const same=isDeepStrictEqual;
const contains=(outer,inner)=>outer&&inner&&
  outer.start<=inner.start&&outer.end>=inner.end;
const sameInvocation=(a,b)=>(a.invocation??'i1')===(b.invocation??'i1');

function sourceExpressions(source) {
  const nodes=new Map();
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  function visit(value) {
    if(Array.isArray(value)) {for(const part of value)visit(part);return;}
    if(!value||typeof value!=='object')return;
    // Keep only the source tree privately. The model never sees AST sites.
    // Branch decisions may refer to identifiers, unary truth tests, and
    // nested pure expressions, not just a flat comparison.
    if(['BinaryExpression','AssignmentExpression','Identifier','UnaryExpression',
        'Literal','MemberExpression'].includes(value.type))
      nodes.set(value.start+':'+value.end,value);
    for(const [key,child] of Object.entries(value))
      if(!['start','end','loc','raw'].includes(key))visit(child);
  }
  visit(ast);
  return nodes;
}
function union(a,b){return [...new Set([...a,...b])];}
function mergedCertificate(a,b,rule) {
  return {record:0,rule,semanticEvents:union(a.semanticEvents,b.semanticEvents),
    journalEvents:union(a.journalEvents,b.journalEvents),
    ...((contains(b.span,a.span)?b.span:a.span)?
      {span:contains(b.span,a.span)?b.span:a.span}:{})};
}

// Returns a new record/certificate pair; public records never contain source
// offsets, certificates, or any teacher-private correspondence information.
export function rewriteSemanticWitness({generated,certificates,source,entry,
    program,inputGraph,localNames,maxOperators=4}) {
  if(generated.length!==certificates.length)
    throw new TypeError('Witness and private certificates disagree');
  const binaries=sourceExpressions(source);
  const params=program.functions.find(f=>f.name===entry)?.params??[];
  const locals=new Map();
  const inputAliases=new Set();
  // A bounded copy of *public*, already-observed ordinary own-data slots.
  // Do not infer prototype/getter reads, missing properties or other exotic
  // behavior from source syntax alone. Writes advance this view in order.
  const dataSlots=new Map(inputGraph.objects.filter(o=>o.kind==='object')
    .map(o=>[o.id,new Map(o.properties.map(p=>[p.key,p.value]))]));
  const emitted=[];
  function scalar(value) {
    if(value===null)return ['null'];
    if(typeof value==='boolean')return ['bool',value];
    if(typeof value==='string')return ['str',value];
    if(typeof value==='bigint')return ['bigint',String(value)];
    if(typeof value==='number')return ['num',Object.is(value,-0)?'-0':
      Number.isNaN(value)?'NaN':value===Infinity?'+Infinity':
      value===-Infinity?'-Infinity':value];
    return null;
  }
  // A branch can be made explanatory without manufacturing the execution:
  // only literal/committed-local/input scalar operands may be reconstructed,
  // and the independent bounded primitive evaluator checks its actual decision.
  const explainableBinary=new Set([
    '+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=',
    '&','|','^','<<','>>','>>>'
  ]);
  // Only primitive, side-effect-free source expressions are candidates for
  // reconstruction. Accessors, calls, assignments, updates, short-circuit
  // execution and other potentially observable work remain separate.
  function sourceOperand(node,invocation,pendingAliases,depth=0) {
    if(!node||depth>8)return null;
    if(node.type==='Literal'&&!node.regex) {
      const value=scalar(node.bigint!==undefined?BigInt(node.bigint):node.value);
      return value?{op:'literal',value}:null;
    }
    if(node.type==='UnaryExpression'&&
       ['!','+','-','~','typeof','void'].includes(node.operator)){
      const arg=sourceOperand(node.argument,invocation,pendingAliases,depth+1);
      return arg?{op:'unary',operator:node.operator,arg}:null;
    }
    if(node.type==='BinaryExpression'&&explainableBinary.has(node.operator)){
      const left=sourceOperand(node.left,invocation,pendingAliases,depth+1);
      const right=sourceOperand(node.right,invocation,pendingAliases,depth+1);
      return left&&right?{op:'binary',operator:node.operator,left,right}:null;
    }
    if(node.type==='MemberExpression'&&!node.optional&&
       !node.computed&&node.property?.type==='Identifier'){
      const base=sourceOperand(node.object,invocation,pendingAliases,depth+1);
      if(base?.op!=='local')return null;
      const index=/^arg([0-9]+)$/.exec(base.name);
      const value=locals.get(base.name)?.value??
        (index?arguments_[Number(index[1])]:null);
      if(value?.[0]!=='ref')return null;
      const own=dataSlots.get(value[1]);
      const key=node.property.name;
      // Only an already-present own *data* slot can be read without a guest
      // lookup/callback. The independent primitive checker verifies its value.
      return own?.has(key)?{op:'read',object:value[1],key}:null;
    }
    if(node.type!=='Identifier')return null;
    for(const [name,item] of [...locals].reverse())
      if(item.sourceName===node.name&&
         (item.invocation===invocation||item.invocation==='i1'))
        return {op:'local',name};
    if(invocation==='i1'){
      const index=params.indexOf(node.name);
      if(index>=0&&index<arguments_.length){
        pendingAliases.add(index);
        return {op:'local',name:'arg'+index};
      }
    }
    return null;
  }
  function checkedCondition(node,invocation,claimed){
    const pending=new Set();
    const expr=sourceOperand(node,invocation,pending);
    if(!expr||expr.op==='literal')return null;
    try{validateExpression(expr,{maxOperators});}
    catch{return null;}
    const available=new Map([...locals].map(([name,item])=>[name,item.value]));
    for(const index of pending)available.set('arg'+index,arguments_[index]);
    // The reconstructed explanation must agree with the already-observed
    // decision using only previously committed public values.
    const check=checkWitnessClaim(expr,claimed,{locals:available,
      readProperty:(id,key)=>{
        const own=dataSlots.get(id);
        if(!own?.has(key))throw new TypeError('Uncertified property read');
        return own.get(key);
      }});
    if(!check.consistent)return null;
    for(const index of pending)inputAliases.add(index);
    return expr;
  }
  const arguments_=inputGraph.roots;
  function substitution(leaf,node,invocation) {
    if(leaf?.op!=='literal'||node?.type!=='Identifier')return leaf;
    const candidates=[...locals].reverse();
    for(const [name,record] of candidates){
      if(record.sourceName===node.name&&same(record.value,leaf.value)&&
         (record.invocation===invocation||record.invocation==='i1'))
        return {op:'local',name};
    }
    if(invocation==='i1'){
      const index=params.indexOf(node.name);
      if(index>=0&&index<arguments_.length&&same(arguments_[index],leaf.value)){
        inputAliases.add(index);
        return {op:'local',name:'arg'+index};
      }
    }
    return leaf;
  }
  for(let index=0;index<generated.length;index++){
    const decoded=decodeWitness(generated[index]);
    const item={kind:decoded.kind,fields:decoded.fields,cert:certificates[index]};
    const invocation=item.fields.invocation??'i1';
    if(item.kind==='compute'&&item.fields.expr.op==='binary'){
      const span=item.cert.span;
      const node=span&&binaries.get(span.start+':'+span.end);
      if(node&&['BinaryExpression','AssignmentExpression'].includes(node.type) &&
         (node.type==='BinaryExpression'||
          node.operator===item.fields.expr.operator+'=')){
        const expr=item.fields.expr;
        item.fields={...item.fields,expr:{...expr,
          left:substitution(expr.left,node.left,invocation),
          right:substitution(expr.right,node.right,invocation)}};
      }
      const previous=emitted.at(-1);
      if(maxOperators>1 && previous?.kind==='compute' &&
         // Random is deterministic but stateful. The current controller only
         // advances the seed for a top-level random step; do not hide it in
         // an enclosing expression or subsequent draws will be repeated.
         previous.fields.expr.op!=='random' &&
         !previous.fields.bind && sameInvocation(previous.fields,item.fields) &&
         contains(item.cert.span,previous.cert.span) &&
         !same(item.cert.span,previous.cert.span) && node &&
         previous.cert.span){
        const expr=item.fields.expr;
        const left=node.left?.start===previous.cert.span.start &&
          node.left?.end===previous.cert.span.end &&
          expr.left.op==='literal'&&same(expr.left.value,previous.fields.result);
        const right=node.right?.start===previous.cert.span.start &&
          node.right?.end===previous.cert.span.end &&
          expr.right.op==='literal'&&same(expr.right.value,previous.fields.result);
        if(left!==right){
          const combined={...expr,
            ...(left?{left:previous.fields.expr}:{right:previous.fields.expr})};
          let withinBudget=false;
          try{withinBudget=validateExpression(combined,{maxOperators}).operatorCount<=maxOperators;}
          catch {/* Keep the separate statements when the bounded language is exceeded. */}
          if(withinBudget){
            emitted.pop();
            item.fields={...item.fields,expr:combined};
            item.cert=mergedCertificate(previous.cert,item.cert,'fuse-expression/1');
          }
        }
      }
    }
    if(item.kind==='choose'&&item.fields.expr.op==='literal'){
      const span=item.cert.span;
      const node=span&&binaries.get(span.start+':'+span.end);
      const expression=checkedCondition(node,invocation,item.fields.decision);
      if(expression){
        item.fields={...item.fields,expr:expression};
        // A checked source-level choice already explains its primitive test.
        // Pure, unbound intermediates wholly inside that test add no state
        // or effects, and merely make the model repeat the same calculation.
        // Never cross a binding, mutation, call, allocation or random draw.
        while(emitted.length){
          const previous=emitted.at(-1);
          if(previous.kind!=='compute'||previous.fields.bind||
             previous.fields.expr.op==='random'||
             !sameInvocation(previous.fields,item.fields)||
             !contains(item.cert.span,previous.cert.span))break;
          emitted.pop();
          item.cert=mergedCertificate(previous.cert,item.cert,'fold-choice/1');
        }
      }
    }
    if(item.kind==='bind'&&!item.fields.from){
      const previous=emitted.at(-1);
      if(previous?.kind==='compute'&&!previous.fields.bind &&
         sameInvocation(previous.fields,item.fields) &&
         same(previous.fields.result,item.fields.value) &&
         // An assignment immediately following its calculation is a single
         // semantic step; no observable record can intervene.
         (contains(item.cert.span,previous.cert.span) ||
          contains(previous.cert.span,item.cert.span))){
        emitted.pop();
        item.kind='compute';
        item.fields={...previous.fields,bind:item.fields.name};
        item.cert=mergedCertificate(previous.cert,item.cert,'fuse-bind/1');
      }
    }
    emitted.push(item);
    if(item.kind==='write'&&dataSlots.has(item.fields.object)){
      if(item.fields.key==='__proto__')dataSlots.delete(item.fields.object);
      else if(item.fields.present)dataSlots.get(item.fields.object)
        .set(item.fields.key,item.fields.value);
      else dataSlots.get(item.fields.object).delete(item.fields.key);
    }
    if(item.kind==='bind'||(item.kind==='compute'&&item.fields.bind)){
      const name=item.kind==='bind'?item.fields.name:item.fields.bind;
      locals.set(name,{value:item.kind==='bind'?item.fields.value:item.fields.result,
        sourceName:localNames.get(name),invocation});
    }
  }
  // Explicit initial argument aliases use existing v3 local semantics, so the
  // pinned native consumer does not need a new primitive expression variant.
  const aliases=[...inputAliases].sort((a,b)=>a-b).map(index=>({
    kind:'bind',fields:{name:'arg'+index,value:arguments_[index]},
    cert:{rule:'input-alias/1',semanticEvents:[],journalEvents:[]}
  }));
  const result=[...aliases,...emitted];
  return {generated:result.map(item=>encodeWitness(item.kind,item.fields)),
    certificates:result.map((item,record)=>({...item.cert,record}))};
}
