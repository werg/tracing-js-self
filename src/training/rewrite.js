// Source-guided reasoning normalization. These transformations are deliberately
// narrower than execution equivalence: they only combine verified pure values,
// never reorder calls, writes, branches, or externally visible work.
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'acorn';
import {decodeWitness,encodeWitness,validateExpression} from './format.js';

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
    if(value.type==='BinaryExpression')
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
  const emitted=[];
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
      if(index>=0&&index<arguments_.length&&same(arguments_[index],leaf.value))
        return {op:'input',index};
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
      if(node){
        const expr=item.fields.expr;
        item.fields={...item.fields,expr:{...expr,
          left:substitution(expr.left,node.left,invocation),
          right:substitution(expr.right,node.right,invocation)}};
      }
      const previous=emitted.at(-1);
      if(maxOperators>1 && previous?.kind==='compute' &&
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
    if(item.kind==='bind'||(item.kind==='compute'&&item.fields.bind)){
      const name=item.kind==='bind'?item.fields.name:item.fields.bind;
      locals.set(name,{value:item.kind==='bind'?item.fields.value:item.fields.result,
        sourceName:localNames.get(name),invocation});
    }
  }
  return {generated:emitted.map(item=>encodeWitness(item.kind,item.fields)),
    certificates:emitted.map((item,record)=>({...item.cert,record}))};
}
