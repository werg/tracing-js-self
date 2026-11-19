// Independent V8 receipts for executed source-level control decisions.
// Source tests are evaluated once and no interpreter state enters this oracle.
import {parse as parseAcorn} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal} from '../semantic/normalize.js';
import {referenceOutcome} from './reference.js';

function sourceBranchNodes(source) {
  const ast=parseAcorn(source,{ecmaVersion:2022,sourceType:'script'});
  const nodes=[];
  function visit(node) {
    if(Array.isArray(node)){for(const item of node)visit(item);return;}
    if(!node||typeof node!=='object')return;
    if(['IfStatement','WhileStatement','DoWhileStatement',
      'ForStatement','ConditionalExpression'].includes(node.type)&&node.test)
      nodes.push({start:node.test.start,end:node.test.end,
        site:String(node.test.start)+':'+node.test.end,kind:'test'});
    if(node.type==='AssignmentExpression'&&['&&=','||=','??='].includes(node.operator))
      nodes.push({start:node.start,end:node.end,site:String(node.start)+':'+node.end,kind:'assignment',operator:node.operator.slice(0,-1),node});
    if(node.type==='LogicalExpression')
      nodes.push({start:node.left.start,end:node.left.end,
        site:String(node.start)+':'+node.end,kind:'logical',operator:node.operator});
    for(const [key,child] of Object.entries(node))
      if(!['start','end','loc'].includes(key))visit(child);
  }
  visit(ast);
  return nodes;
}
export function instrumentBranchSource(source) {
  const nodes=sourceBranchNodes(source),assignments=nodes.filter(n=>n.kind==='assignment');
  const usedNames=new Set(source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g)??[]);let serial=0;
  const fresh=()=>{let name;do{name='__tracingAssign'+serial++;}while(usedNames.has(name));usedNames.add(name);return name;};
  function render(start,end){
    const captures=nodes.filter(n=>n.kind!=='assignment'&&n.start>=start&&n.end<=end);
    const starts=new Map(),ends=new Map();
    for(const n of captures){
      if(!starts.has(n.start))starts.set(n.start,[]);if(!ends.has(n.end))ends.set(n.end,[]);
      starts.get(n.start).push(n);ends.get(n.end).push(n);
    }
    let text='';
    for(let i=start;i<=end;i++){
      for(const n of (ends.get(i)??[]).sort((a,b)=>b.start-a.start))text+='))';
      for(const n of (starts.get(i)??[]).sort((a,b)=>b.end-a.end))
        text+=n.kind==='test'?'globalThis.__tracingBranch('+JSON.stringify(n.site)+',(':
          'globalThis.__tracingLogical('+JSON.stringify(n.site)+','+JSON.stringify(n.operator)+',(';
      if(i===end)break;
      const replacement=assignments.filter(n=>n.start===i&&n.end<=end).sort((a,b)=>b.end-a.end)[0];
      if(replacement){
        const {node,operator,site}=replacement,left=node.left,right=render(node.right.start,node.right.end),
          capture=target=>'globalThis.__tracingLogical('+JSON.stringify(site)+','+JSON.stringify(operator)+','+target+')';
        if(left.type==='Identifier'){
          const name=source.slice(left.start,left.end);
          text+='('+capture(name)+' '+operator+' ('+name+'=('+right+')))';
        }else if(left.type==='MemberExpression'&&!left.optional&&left.property.type!=='PrivateIdentifier'&&left.object.type!=='Super'){
          const receiver=fresh(),key=fresh(),raw=fresh(),object=render(left.object.start,left.object.end),
            property=left.computed?render(left.property.start,left.property.end):JSON.stringify(left.property.name),target=receiver+'['+key+']';
          // Preserve evaluation of the receiver/key expressions once. Native
          // Get/Put retain their own key conversion semantics. Arrow wrappers
          // keep lexical this; generated bindings cannot shadow source names.
          const converted=raw;
          text+='(('+receiver+','+raw+')=>(('+key+')=>('+capture(target)+' '+operator+' ('+target+'=('+right+'))))('+converted+'))(('+object+'),('+property+'))';
        }else throw new TypeError('Unsupported logical assignment reference instrumentation');
        i=replacement.end-1;
      }else text+=source[i];
    }
    return text;
  }
  return render(0,source.length);
}

export function compareBranchObservations(expected,observed) {
  if(!Array.isArray(expected)||!Array.isArray(observed))
    throw new TypeError('Branch observations must be arrays');
  for(let i=0;i<Math.max(expected.length,observed.length);i++)
    if(!isDeepStrictEqual(expected[i],observed[i]))
      return {status:'mismatch',checked:i,index:i,
        expected:expected[i]??null,observed:observed[i]??null};
  return {status:'agreed',checked:expected.length};
}

export function auditReferenceBranches({source,entry,args,initialHeap,bundle,reference}) {
  const schema='reference-branches/1';
  const normalized=normalizeJournal(bundle);
  const journalById=new Map(bundle.events.map(e=>[e.eventId,e]));
  const expected=[];
  // Guest parameter defaults generate conditional jumps without corresponding
  // source-level branch expressions. Keep those branch events in the archive,
  // but do not compare them to V8 source-level control receipts.
  const sourceSites=new Set(sourceBranchNodes(source).map(node=>node.site));
  for(const row of normalized.events){
    if(journalById.get(row.journalEvent)?.operation!=='control.branch')continue;
    if(row.source&&!sourceSites.has(String(row.source.start)+':'+row.source.end))
      continue;
    if(!row.source||row.source.start>=row.source.end||
       row.result?.[0]!=='bool'||typeof row.result[1]!=='boolean')
      return {schema,status:'unverified',reason:'Unverifiable owned branch event',
        eventId:row.journalEvent};
    expected.push({site:String(row.source.start)+':'+row.source.end,
      decision:row.result});
  }
  const observed=referenceOutcome({source:instrumentBranchSource(source),
    entry,args,initialHeap,observeBranches:true,
    randomSeed:bundle.initialState.control.a0.randomSeed??null});
  if(!['return','throw'].includes(observed.kind)||observed.kind!==reference.kind)
    return {schema,status:'unverified',
      reason:'Instrumented V8 branch run did not complete',
      referenceKind:observed.kind,message:observed.message??null};
  if(!isDeepStrictEqual(observed.graph,reference.graph))
    return {schema,status:'mismatch',
      reason:'Control instrumentation altered observable graph'};
  return {schema,...compareBranchObservations(expected,observed.decisions),
    covered:{branches:expected.length}};
}
