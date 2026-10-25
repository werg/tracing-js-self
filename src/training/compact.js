// Causal compiler from verified private history to a separate public
// computation language. Unsupported effects/refinements are refused rather
// than being hidden behind an answer-bearing constant.
import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal,validateSemantic} from '../semantic/normalize.js';
import {replayExact} from '../replay.js';
import {describeOwnedGraph} from './graph.js';
import {trainingPrefix} from './visibility.js';
import {encodeWitness,decodeWitness} from './format.js';
import {rewriteSemanticWitness} from './rewrite.js';
import {normalizeCompletionFacts} from './completion-facts.js';

export const COMPACTION_RULES=Object.freeze({
  'input/1':{boundary:'observed',effect:'publish supplied graph'},
  'primitive/1':{boundary:'primitive',effect:'preserve operator order and operand values'},
  'fuse-expression/1':{boundary:'pure expression',effect:'combine verified nested primitive expressions'},
  'fuse-bind/1':{boundary:'local',effect:'attach verified value to its binding'},
  'fold-choice/1':{boundary:'pure branch test',effect:'keep checked choice, remove redundant pure test computations'},
  'input-alias/1':{boundary:'observed input',effect:'name a supplied immutable argument value'},
  'seeded-random/1':{boundary:'primitive',effect:'advance predeclared deterministic entropy'},
  'bind/1':{boundary:'local',effect:'commit supplied value'},
  'choice/1':{boundary:'control',effect:'retain chosen path'},
  'allocate/1':{boundary:'identity',effect:'initialize committed data properties'},
  'entry-rest/1':{boundary:'root entry',effect:'publish owned root rest array from supplied arguments'},
  'call/1':{boundary:'activation',effect:'preserve dynamic guest invocation'},
  'property/1':{boundary:'mutation',effect:'preserve property value and presence'},
  'completion/1':{boundary:'terminal',effect:'preserve actual root completion'},
  'elide-private/1':{boundary:'none',effect:'no externally observable work'}
});

function refuse(message){
  const error=new Error('Unsupported compact witness: '+message);
  error.category='unsupported.witness-projection';throw error;
}
function literal(value){return {op:'literal',value};}
function primitiveTag(value){
  if(!Array.isArray(value))refuse('missing journal operand tag');
  return value;
}
export function compileWitness(bundle,semantic=normalizeJournal(bundle),
    {maxOperators=4}={}){
  if(![1,2,4,8].includes(maxOperators))throw new RangeError('Unknown fusion policy');
  validateSemantic(bundle,semantic);
  replayExact(bundle);
  const entry=bundle.entrySpec;
  if(entry?.kind!=='function'||bundle.finalState.control.a0.completion?.kind!=='return')
    refuse('only settled owned function returns are currently certified');
  if(bundle.events.some(e=>e.operation==='spec.internal.call'||
      e.operation==='external.input.arrive'||
      e.operation==='external.input.deliver'||e.operation==='job.enter'))
    refuse('guest dispatch, cleanup or external scheduling needs invocation certificates');
  if(semantic.events.some(row=>['request','observe','await','resume','settle'].includes(row.op)))
    refuse('unsupported dynamic dispatch or pending completion');
  const source=bundle.sources.find(s=>s.sourceId===entry.sourceId);
  if(!source)refuse('source unavailable');
  const prefix=trainingPrefix(bundle);
  const analyzed=prefix.program;
  const mapping=new Map();let allocationCount=0;
  function id(key){
    if(!mapping.has(key))mapping.set(key,'o'+(++allocationCount));
    return mapping.get(key);
  }
  function tag(value){
    if(!Array.isArray(value))refuse('untyped guest value');
    return value[0]==='ref'?['ref',id(value[1])]:structuredClone(value);
  }
  const original=describeOwnedGraph(bundle.initialState.heap,entry.arguments);
  // Register identities before visiting values to preserve cycles.
  for(const node of original.objects)id(node.id);
  const context=[prefix.source,prefix.input];
  const generated=[],certificates=[],elided=[];
  function emit(kind,fields,rule,row){
    const publicFields=row?.invocation?{...fields,invocation:invocation(row.invocation)}:fields;
    const record=encodeWitness(kind,publicFields);
    generated.push(record);
    certificates.push({record:generated.length-1,rule,
      semanticEvents:row?.id?[row.id]:[],
      journalEvents:row?[row.journalEvent]:[],
      ...(row?.source?{span:row.source}:{})});
  }
  function omission(row,reason){
    elided.push({semanticEvent:row.id,journalEvent:row.journalEvent,reason,
      rule:'elide-private/1'});
  }
  // Code IDs are private compiler coordinates, not semantic function names.
  // Name only declarations with a certified source-level DEF_FN binding;
  // anonymous/dynamic dispatch keeps its existing opaque fallback.
  const sourceCallees=new Map();
  for(const program of Object.values(bundle.programs))
    for(const inst of program.instructions)
      if(inst.op==='DEF_FN'&&typeof inst.arg?.name==='string'&&
         typeof inst.arg?.codeId==='string')
        sourceCallees.set(inst.arg.codeId,inst.arg.name);
  const invocations=new Map([[semantic.rootInvocation,'i1']]);
  let invocationNumber=1;
  function invocation(frame){
    if(!invocations.has(frame))invocations.set(frame,'i'+(++invocationNumber));
    return invocations.get(frame);
  }
  const cellNames=new Map(),cellSourceNames=new Map(),committedCells=new Set();
  let cellNumber=0;
  function local(write) {
    const key=write.env+':'+write.key;
    if(!cellNames.has(key)){
      const hint=/^[a-z][a-z0-9]*$/.test(write.key)?write.key:'v';
      const name=hint+(++cellNumber);
      cellNames.set(key,name);cellSourceNames.set(name,write.key);
    }
    return cellNames.get(key);
  }
  // Root rest allocation takes place while the entry frame is created,
  // before the first journal step. It is a real guest allocation, not an
  // extra input root or a guessed future collection.
  const rootFrame=bundle.initialState.frames[semantic.rootInvocation];
  const rootProgram=rootFrame&&bundle.programs[rootFrame.codeId];
  if((rootProgram?.restIndex??-1)>=0){
    const name=rootProgram.params[rootProgram.restIndex];
    const entryEnv=bundle.initialState.envs[rootFrame.envId];
    const rest=entryEnv?.bindings?.[name]?.token?.value??rootFrame.restValue;
    const entity=rest?.[0]==='ref'?bundle.initialState.heap[rest[1]]:null;
    if(!entity||entity.kind!=='array')
      refuse('root rest parameter lacks an owned initial array');
    const len=entity.properties.length?.value?.[1];
    emit('allocate',{name:id(rest[1]),kind:'array',length:len,
      properties:Object.entries(entity.properties).filter(([key])=>key!=='length')
        .map(([key,slot])=>({key,value:tag(slot.value)}))},'entry-rest/1',null);
  }
  function writesOf(row) {
    for(const w of row.writes??[]){
      if(w.kind==='cell'){
        if(!Array.isArray(w.value))refuse('untyped local write');
        const cell=local(w);
        emit('bind',{name:cell,value:tag(w.value)},'bind/1',row);
        committedCells.add(cell);
      }else if(w.kind==='property') {
        emit('write',{object:id(w.object),key:w.key,present:w.present,
          value:w.present?tag(w.value):['undefined']},'property/1',row);
      }else refuse('unknown effective mutation kind');
    }
  }
  // Overlay the actual frame-exit facts on private normalization. New exit
  // facts from finally are inserted at their real chronological event, not
  // appended after cleanup or inferred from the eventual final answer.
  const completion=normalizeCompletionFacts(bundle);
  const normalizedByEvent=new Map();
  for(const row of semantic.events){
    const list=normalizedByEvent.get(row.journalEvent)??[];
    list.push(row);normalizedByEvent.set(row.journalEvent,list);
  }
  const effectiveRows=[];
  for(const event of bundle.events){
    const fact=completion.get(event.eventId);
    const rows=normalizedByEvent.get(event.eventId)??[];
    for(const row of rows){
      if(fact && ['return','throw'].includes(row.op)){
        if(fact.operation==='transfer'){
          effectiveRows.push({...row,op:'transfer',
            result:fact.value,transferKind:fact.kind,handler:fact.handler});
        }else if(fact.operation==='return'&&row.op==='return')
          effectiveRows.push(row);
        else refuse('unmodeled terminal throw completion');
      }else effectiveRows.push(row);
    }
    if(fact?.operation==='catch-bind'){
      effectiveRows.push({id:null,journalEvent:event.eventId,
        op:'catch-bind',invocation:fact.invocation,site:null,source:null,
        bindingName:'caught'+event.eventId.replace(/[^0-9]/g,''),
        result:fact.value,writes:[]});
    }
    if(fact?.operation==='return'&&
       !rows.some(r=>r.op==='return')){
      effectiveRows.push({id:null,journalEvent:event.eventId,
        op:'return',invocation:fact.invocation,site:null,source:null,
        result:fact.value,writes:[]});
    }
    if(fact?.operation==='unhandled-throw'||fact?.operation==='throw')
      refuse('terminal guest throw requires bounded error-value contract');
  }
  for(const row of effectiveRows){
    if(row.op==='value'&&row.source&&
       source.text.slice(row.source.start,row.source.end).trim()==='Math.random()'){
      if(prefix.schema!=='semantic-context/3'||
         bundle.initialState.control.a0.randomSeed===undefined)
        refuse('random computation lacks a published deterministic seed');
      emit('compute',{expr:{op:'random'},result:tag(row.result)},'seeded-random/1',row);
      writesOf(row);
    }else if(row.op==='value'&&row.arithmetic){
      const op=row.arithmetic.operator;
      const operands=(row.operands??[]).map(v=>tag(primitiveTag(
        Array.isArray(v)?v:v?.value)));
      if(operands.length!==2||!Array.isArray(row.result))
        refuse('incomplete bounded primitive evidence');
      // The operands are captured at operation start, before any destination
      // write. Literal operand facts cannot change after the claim commits.
      emit('compute',{expr:{op:'binary',operator:op,
        left:literal(operands[0]),right:literal(operands[1])},
        result:tag(row.result)},'primitive/1',row);
      writesOf(row);
    }else if(row.op==='branch'){
      emit('choose',{expr:literal(tag(row.test)),decision:tag(row.test),
        path:row.path},'choice/1',row);
    }else if(row.op==='alloc'){
      const allocs=row.allocations??[];
      if(!allocs.length)refuse('allocation record lacks initialized identity');
      for(const a of allocs)id(a.identity);
      for(const a of allocs){
        if(!['object','array','function','set','regexp'].includes(a.kind))
          refuse('unrepresentable owned allocation kind');
        const len=a.kind==='array'?a.properties.find(p=>p.key==='length')?.value?.[1]:null;
        emit('allocate',{name:id(a.identity),kind:a.kind==='function'?'closure':a.kind,
          ...(a.kind==='array'?{length:len}:{}),
          ...(a.kind==='function'?{code:a.codeId,
            captures:[...cellNames].filter(([key,cell])=>
              key.startsWith(a.capture+':')&&committedCells.has(cell))
              .map(([key,cell])=>({binding:key.slice(a.capture.length+1),cell}))}:{}),
          properties:a.kind==='function'?[]:
            a.properties.filter(p=>a.kind!=='array'||p.key!=='length')
              .map(p=>({key:p.key,value:tag(p.value)}))},'allocate/1',row);
      }
      writesOf(row);
    }else if(row.op==='call'){
      // Child dispatch is a first-class semantic boundary. Its callback body
      // runs under the child activation; the caller resumes at actual return.
      if(!row.child||!row.code||!Array.isArray(row.arguments))
        refuse('call lacks created owned guest frame');
      for(const a of row.allocations??[]){
        if(!['object','array','set','regexp'].includes(a.kind))
          refuse('unsupported callback collection allocation');
        const len=a.kind==='array'?a.properties.find(p=>p.key==='length')?.value?.[1]:null;
        emit('allocate',{name:id(a.identity),kind:a.kind,
          ...(a.kind==='array'?{length:len}:{}),
          properties:a.properties.filter(p=>p.key!=='length')
            .map(p=>({key:p.key,value:tag(p.value)}))},'allocate/1',row);
      }
      writesOf(row);
      emit('call',{child:invocation(row.child),callee:sourceCallees.get(row.code)??row.code,
        receiver:tag(row.receiver),arguments:row.arguments.map(tag)},'call/1',row);
    }else if(row.op==='transfer'){
      if(!['return','throw'].includes(row.transferKind)||
         !Array.isArray(row.result))
        refuse('unmodeled completion transfer');
      emit('transfer',{kind:row.transferKind,value:tag(row.result),
        handler:row.handler??'catch-or-finally'},'completion/1',row);
    }else if(row.op==='catch-bind'){
      emit('bind',{name:row.bindingName,value:tag(row.result)},'bind/1',row);
    }else if(row.op==='write'){
      writesOf(row);
    }else if(row.op==='value'){
      if((row.writes??[]).length)writesOf(row);
      else omission(row,'pure private temporary');
    }else if(row.op==='read'){
      if((row.reads??[]).some(r=>r.kind==='property'&&r.value?.[0]==='ref'&&
          r.value[1]&&!mapping.has(r.value[1])))
        refuse('behavioral property read cannot be absorbed');
      omission(row,'ordinary operand read');
    }else if(row.op==='loop'){
      omission(row,'mechanical backedge');
    }else if(row.op==='carry'){
      if(analyzed.functions.length<=1){
        omission(row,'uncaptured lexical iteration copy');
        continue;
      }
      // A loop-carried cell has a new semantic identity per iteration.
      // The copy reads the previously committed cell at this boundary.
      const copies=row.copies??[{from:row.from,to:row.to}];
      for(const item of copies){
        const from=local({env:item.from.env,key:item.from.key});
        const to=local({env:item.to.env,key:item.to.key});
        const observed=(row.reads??[]).find(read=>
          read.kind==='binding'&&read.envId===item.from.env&&
          read.name===item.from.key);
        if(!observed||!Array.isArray(observed.value))
          refuse('captured iteration copy lacks value evidence');
        emit('bind',{name:to,value:tag(observed.value),
          ...(committedCells.has(from)?{from}:{})},'bind/1',row);
        committedCells.add(to);
      }
    }else if(row.op==='return'){
      writesOf(row);
      emit('return',{value:tag(row.result)},'completion/1',row);
    }else refuse('unrecognized semantic event '+row.op);
  }
  const terminal=generated.at(-1);
  if(!terminal||!terminal.startsWith('return '))
    refuse('missing real root return boundary');
  emit('end',{kind:'return'},'completion/1',null);
  const rewritten=rewriteSemanticWitness({generated,certificates,
    source:source.text,entry:entry.functionName,program:analyzed,
    inputGraph:decodeWitness(prefix.input).fields.graph,
    localNames:cellSourceNames,maxOperators});
  return {schema:'semantic-compiler/3',context,
    generated:rewritten.generated,certificates:rewritten.certificates,
    elided,staticProgram:analyzed,
    policy:{maxOperators,maxExpressionNodes:32}};
}
