// Independent source-boundary observations for the bounded synchronous profile.
// The VM never receives a journal operand: V8 executes instrumented source with
// separately reconstructed entry inputs. Only deterministic scalar-producing
// unary/binary and supported compound-assignment expressions are covered.
import {parse as parseAcorn} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal} from '../semantic/normalize.js';
import {referenceOutcome} from './reference.js';

const observedOperations=new Set([
  'primitive.binary','primitive.unary','spec.operation.complete','binding.update','property.update'
]);

export function instrumentOperationSource(source) {
  const ast=parseAcorn(source,{ecmaVersion:2022,sourceType:'script'});
  const nodes=[];
  function visit(value){
    if(Array.isArray(value)){for(const child of value)visit(child);return;}
    if(!value||typeof value!=='object')return;
    if(value.type==='BinaryExpression'||value.type==='UnaryExpression'||
       (value.type==='AssignmentExpression'&&['+=','-='].includes(value.operator))||
       value.type==='UpdateExpression')
      nodes.push({start:value.start,end:value.end,site:String(value.start)+':'+value.end});
    for(const [name,child] of Object.entries(value))
      if(name!=='start'&&name!=='end'&&name!=='loc')visit(child);
  }
  visit(ast);
  const opens=new Map(),closes=new Map();
  for(const n of nodes){
    if(!opens.has(n.start))opens.set(n.start,[]);
    if(!closes.has(n.end))closes.set(n.end,[]);
    opens.get(n.start).push(n);
    closes.get(n.end).push(n);
  }
  let instrumented='';
  for(let offset=0;offset<=source.length;offset++){
    // Closing a nested expression precedes closing its parent. At a shared
    // start, open the parent first. Do not split surrogate pairs in source.
    for(const n of (closes.get(offset)??[]).sort((a,b)=>b.start-a.start))
      instrumented+='))';
    for(const n of (opens.get(offset)??[]).sort((a,b)=>b.end-a.end))
      instrumented+='globalThis.__tracingCapture('+JSON.stringify(n.site)+',(';
    if(offset<source.length)instrumented+=source[offset];
  }
  return instrumented;
}

export function compareOperationObservations(expected,observed) {
  if(!Array.isArray(expected)||!Array.isArray(observed))
    throw new TypeError('Operation observations must be arrays');
  for(let i=0;i<Math.max(expected.length,observed.length);i++){
    if(!isDeepStrictEqual(expected[i],observed[i]))
      return {status:'mismatch',checked:i,index:i,
        expected:expected[i]??null,observed:observed[i]??null};
  }
  return {status:'agreed',checked:expected.length};
}

export function auditReferenceOperations({source,entry,args,initialHeap,bundle,reference}) {
  const schema='reference-operations/1';
  const normalized=normalizeJournal(bundle);
  const eventsById=new Map(bundle.events.map(event=>[event.eventId,event]));
  const expected=[],covered={binary:0,unary:0,ownedArithmetic:0,updates:0};
  const unverified=new Set();
  for(const row of normalized.events){
    const operation=eventsById.get(row.journalEvent)?.operation;
    if(!observedOperations.has(operation)){
      if(operation)unverified.add(operation);
      continue;
    }
    if(!row.source||!['value','write'].includes(row.op)||!Array.isArray(row.result))
      return {schema,status:'unverified',reason:'Uncovered primitive operation completion',
        eventId:row.journalEvent};
    expected.push({site:String(row.source.start)+':'+row.source.end,value:row.result});
    if(operation==='primitive.binary')covered.binary++;
    else if(operation==='primitive.unary')covered.unary++;
    else if(operation==='binding.update'||operation==='property.update')covered.updates++;
    else covered.ownedArithmetic++;
  }
  const observed=referenceOutcome({source:instrumentOperationSource(source),
    entry,args,initialHeap,observeOperations:true});
  if(observed.kind!=='return')
    return {schema,status:'unverified',reason:'Instrumented reference did not complete',
      referenceKind:observed.kind,message:observed.message??null};
  if(!isDeepStrictEqual(observed.graph,reference.graph))
    return {schema,status:'mismatch',reason:'Instrumentation altered the observable graph'};
  const comparison=compareOperationObservations(expected,observed.operations);
  return {schema,...comparison,covered,unverifiedFamilies:[...unverified].sort()};
}
