// Independent V8 receipts for executed source-level control decisions.
// Source tests are evaluated once and no interpreter state enters this oracle.
import {parse as parseAcorn} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal} from '../semantic/normalize.js';
import {referenceOutcome} from './reference.js';

export function instrumentBranchSource(source) {
  const ast=parseAcorn(source,{ecmaVersion:2022,sourceType:'script'});
  const nodes=[];
  function visit(node) {
    if(Array.isArray(node)){for(const item of node)visit(item);return;}
    if(!node||typeof node!=='object')return;
    if(['IfStatement','WhileStatement','DoWhileStatement',
      'ForStatement','ConditionalExpression'].includes(node.type)&&node.test)
      nodes.push({start:node.test.start,end:node.test.end,
        site:String(node.test.start)+':'+node.test.end,kind:'test'});
    if(node.type==='LogicalExpression')
      nodes.push({start:node.left.start,end:node.left.end,
        site:String(node.start)+':'+node.end,kind:'logical',operator:node.operator});
    for(const [key,child] of Object.entries(node))
      if(!['start','end','loc'].includes(key))visit(child);
  }
  visit(ast);
  const starts=new Map(),ends=new Map();
  for(const n of nodes){
    if(!starts.has(n.start))starts.set(n.start,[]);
    if(!ends.has(n.end))ends.set(n.end,[]);
    starts.get(n.start).push(n);ends.get(n.end).push(n);
  }
  let text='';
  for(let i=0;i<=source.length;i++){
    // Close nested captures first; open outer captures first.
    for(const n of (ends.get(i)??[]).sort((a,b)=>b.start-a.start))text+='))';
    for(const n of (starts.get(i)??[]).sort((a,b)=>b.end-a.end))
      text+=n.kind==='test'
        ?'globalThis.__tracingBranch('+JSON.stringify(n.site)+',('
        :'globalThis.__tracingLogical('+JSON.stringify(n.site)+','+
          JSON.stringify(n.operator)+',(';
    if(i<source.length)text+=source[i];
  }
  return text;
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
  for(const row of normalized.events){
    if(journalById.get(row.journalEvent)?.operation!=='control.branch')continue;
    if(!row.source||row.source.start>=row.source.end||
       row.result?.[0]!=='bool'||typeof row.result[1]!=='boolean')
      return {schema,status:'unverified',reason:'Unverifiable owned branch event',
        eventId:row.journalEvent};
    expected.push({site:String(row.source.start)+':'+row.source.end,
      decision:row.result});
  }
  const observed=referenceOutcome({source:instrumentBranchSource(source),
    entry,args,initialHeap,observeBranches:true});
  if(observed.kind!=='return')
    return {schema,status:'unverified',
      reason:'Instrumented V8 branch run did not complete',
      referenceKind:observed.kind,message:observed.message??null};
  if(!isDeepStrictEqual(observed.graph,reference.graph))
    return {schema,status:'mismatch',
      reason:'Control instrumentation altered observable graph'};
  return {schema,...compareBranchObservations(expected,observed.decisions),
    covered:{branches:expected.length}};
}
