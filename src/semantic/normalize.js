// Canonical semantic projection of the authoritative journal.
// This is a source-anchored derived record, not executable bytecode or a state
// replacement. Every record retains an audit pointer to the committed event.
import {isDeepStrictEqual} from 'node:util';
import {validateBundle} from '../validation.js';

const selection={
  'binding.initialize':'value','binding.write':'value','binding.update':'write',
  'binding.read':'read','binding.default.guard':'read',
  'primitive.binary':'value','primitive.unary':'value','template.substitute':'value',
  'function.define':'alloc','object.allocate':'alloc','array.allocate':'alloc',
  'property.read':'read','property.write':'write','property.update':'write',
  'call.enter':'call','call.return':'return','completion.throw':'throw',
  'control.branch':'branch','environment.iteration':'carry','async.await':'await',
  'external.input.deliver':'observe','job.enter':'resume'
};
function allocation(p) {
  const obj=p.after;
  return {identity:p.id,kind:obj.kind,
    codeId:obj.codeId??null,capture:obj.closureEnvId??null,
    shapeVersion:obj.shapeVersion??0,
    properties:Object.entries(obj.properties??{}).map(([key,record])=>({
      key,version:obj.propertyVersions?.[key]??0,value:record.value
    }))};
}
function changes(before,after) {
  if (!after?.properties)return [];
  const keys=new Set([...Object.keys(before?.properties??{}),...Object.keys(after.properties)]);
  const result=[];
  for(const key of keys){
    const old=before?.properties?.[key],next=after.properties[key];
    if(isDeepStrictEqual(old,next))continue;
    result.push({key,present:next!==undefined,oldVersion:before?.propertyVersions?.[key]??0,
      version:after.propertyVersions?.[key]??0,value:next?.value??null,
      origin:next?.origin??null});
  }
  return result;
}
export function normalizeJournal(bundle) {
  validateBundle(bundle);
  const output=[],mapping={};
  const lastControl=new Map();
  const arithmetic=new Map();
  const sites=new Map(bundle.sites.map(s=>[s.siteId,s]));
  const root=bundle.initialState.control.a0.activeFrameId;
  if(!root)throw new Error('No root invocation');
  for(const e of bundle.events) {
    // Private arrival must never be an observed or generated target.
    if(e.operation==='external.input.arrive')continue;
    let op=selection[e.operation];
    let inputs=e,owned=null;
    if(e.operation==='primitive.binary') {
      const created=e.stateChanges.find(p=>p.kind==='operation.create');
      if(created) {
        // Starting an owned operation has not produced a value. Keep its
        // committed inputs, never a register read from the eventual final state.
        arithmetic.set(created.id,{event:e,record:created.record});
        continue;
      }
    }
    if(e.operation==='spec.operation.complete') {
      const completed=e.stateChanges.find(p=>p.kind==='operation.complete');
      owned=arithmetic.get(completed?.id);
      if(!owned)throw new Error('Owned arithmetic completion has no committed start');
      inputs=owned.event;
      // The compact training trace emits one source-level operation only when
      // its owned continuation completes. Phase values remain archive evidence.
      op=e.completion.type==='normal'?'value':e.completion.type==='throw'?'throw':'end';
      arithmetic.delete(completed.id);
    }
    if(e.operation==='control.jump') {
      const change=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      if(change && change.after.pc<=change.before.pc)op='loop';
    }
    // Getter/setter/proxy-trap dispatch is an effective user-function call.
    // It is not modeled as a mysterious internal [[Get]] or [[Set]] step.
    const invoked=e.causes?.find(c=>c.kind==='invocation');
    if(invoked && e.operation!=='call.enter')op='call';
    if(!op)continue;
    const args=inputs.operands??[];
    const source=sites.get(e.siteId);
    const r={id:'e'+(output.length+1),journalEvent:e.eventId,op,
      invocation:e.invocationId??null,site:e.siteId??null,
      source:source?{start:source.start,end:source.end,codeId:source.codeId}:null,
      dependsOn:[...new Set((inputs.operandOrigins??[]).filter(id=>mapping[id]).map(id=>mapping[id]))],
      control: e.invocationId?lastControl.get(e.invocationId)??null:null,
      operands:args,result:e.result,reads:[],writes:[]};
    if(owned)r.arithmetic={algorithm:owned.record.algorithm,operator:owned.record.operator};
    if(e.completion) {
      // Archive token origins are audit details; visible data dependencies use
      // the semantic IDs above. Keep unsupported distinct from guest throws.
      const {type,errorType,message,feature}=e.completion;
      r.completion={type,...(errorType?{errorType}:{}),...(message?{message}:{}),
        ...(feature?{feature}:{})};
    }
    if(op==='branch'||op==='loop') {
      const frame=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      r.decision=op==='branch'?e.result?.[1]:'backedge';
      r.successor=frame?.after?.pc??null; // private audit mapping only
      if(op==='branch') {
        const inst=bundle.programs[e.codeId]?.instructions.find(i=>i.siteId===e.siteId);
        if(!inst || !['JUMP_IF_FALSE','LOGICAL_JUMP'].includes(inst.op) ||
           e.result?.[0]!=='bool'||typeof e.result[1]!=='boolean'||!args.length)
          throw new Error('Missing source-level branch evidence');
        r.test=args[0];
        r.path=inst.op==='JUMP_IF_FALSE'?(e.result[1]?'else':'then'):
          (e.result[1]?'use-left':'evaluate-right');
      }
      lastControl.set(e.invocationId,r.id);
    }
    if(op==='carry') {
      const reads=e.readObservations?.filter(x=>x.kind==='binding')??[];
      const created=e.stateChanges.find(p=>p.table==='envs'&&p.before===null);
      if(!reads.length||!created)
        throw new Error('Iteration copy has no committed source and destination');
      const copies=reads.map(read=>{
        const copied=created.after?.bindings?.[read.name];
        if(!copied || copied.version!==read.version ||
           !isDeepStrictEqual(copied.token?.value,read.value))
          throw new Error('Iteration copy lost a captured value or version');
        return {from:{env:read.envId,key:read.name,version:read.version},
          to:{env:created.id,key:read.name,version:copied.version??0}};
      });
      if(copies.length===1){r.from=copies[0].from;r.to=copies[0].to;}
      else r.copies=copies;
    }
    if(op==='call') {
      const child=e.causes?.find(c=>c.kind==='invocation');
      const effect=e.causes?.find(c=>c.kind==='effect');
      if(child){
        // A builtin call can allocate a collection *before* invoking its
        // first guest callback. Publish that allocation on the call record.
        const additions=e.stateChanges.filter(p=>p.table==='heap'&&p.before===null);
        if(additions.length)r.allocations=additions.map(allocation);
        for(const p of e.stateChanges.filter(p=>p.table==='heap'&&p.before!==null))
          for(const change of changes(p.before,p.after))
            r.writes.push({kind:'property',object:p.id,...change,
              shapeBefore:p.before?.shapeVersion??0,shapeAfter:p.after?.shapeVersion??0});
        r.child=child.frameId;
        const created=e.stateChanges.find(p=>p.table==='frames' && p.id===child.frameId);
        r.code=created?.after?.codeId??null;
        const activationEnv=created?.after?.envId??null;
        const createdEnv=e.stateChanges.find(p=>p.table==='envs'&&p.id===activationEnv);
        r.captures=createdEnv?.after?.parent??null;
        r.receiver=created?.after?.thisValue??['undefined'];
        const params=bundle.programs[r.code]?.params??[];
        r.arguments=params.map(name=>createdEnv?.after?.bindings?.[name]?.token?.value??['undefined']);
      } else if(effect) {
        op=r.op='request';
        const created=e.stateChanges.find(p=>p.table==='effects' && p.id===effect.effectId);
        r.effect=effect.effectId;r.operation=created?.after?.operation??null;
        r.arguments=created?.after?.request?JSON.parse(created.after.request.payload):[];
        r.codec=created?.after?.request?.codec??null;
        r.payload=created?.after?.request?.payload??null;
        r.signature=created?.after?.request?.signature??null;
      } else {
        // Do not collapse a heap-mutating builtin into an opaque scalar leaf.
        const heapPatches=e.stateChanges.filter(p=>p.table==='heap');
        const allocated=heapPatches.filter(p=>p.before===null);
        if(allocated.length){
          r.op='alloc';
          r.allocations=allocated.map(allocation);
        }else if(heapPatches.length)r.op='write';
        else r.op='value';
        for(const p of heapPatches.filter(p=>p.before!==null))
          for(const entry of changes(p.before,p.after))
            r.writes.push({kind:'property',object:p.id,...entry,
              shapeBefore:p.before?.shapeVersion??0,shapeAfter:p.after?.shapeVersion??0});
      }
    }
    if(op==='return'||op==='throw') {
      // Callback completion can update a surrounding collection as one
      // committed continuation. Publish the exact mutation, not a final diff.
      for(const p of e.stateChanges.filter(p=>p.table==='heap'&&p.before!==null))
        for(const change of changes(p.before,p.after))
          r.writes.push({kind:'property',object:p.id,...change,
            shapeBefore:p.before?.shapeVersion??0,shapeAfter:p.after?.shapeVersion??0});
      const frame=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      r.destination=frame?.after?.callerFrameId??null;
    }
    if(op==='alloc') {
      const heap=e.stateChanges.filter(p=>p.table==='heap' && p.before===null);
      r.allocations=heap.map(allocation);
    }
    if(['binding.write','binding.initialize','binding.update','function.define'].includes(e.operation)) {
      for(const p of e.stateChanges.filter(p=>p.table==='envs')) {
        const instruction=bundle.programs[e.codeId]?.instructions.find(x=>x.siteId===e.siteId);
        const key=typeof instruction?.arg==='string'?instruction.arg:instruction?.arg?.name;
        const b=key&&p.before?.bindings?.[key],a=key&&p.after?.bindings?.[key];
        if(a && !isDeepStrictEqual(a,b))
          r.writes.push({kind:'cell',env:p.id,key,previous:b?.version??0,
            version:a.version??0,value:a.token?.value??null});
      }
    }
    if(['binding.update','property.update'].includes(e.operation)) {
      const update=bundle.programs[e.codeId]?.instructions.find(x=>x.siteId===e.siteId)?.arg;
      if(!update || !['++','--'].includes(update.operator))
        throw new Error('Malformed owned update');
      r.update={operator:update.operator,prefix:update.prefix};
    }
    if(['property.write','property.update'].includes(e.operation)) {
      for(const p of e.stateChanges.filter(p=>p.table==='heap')) {
        const all=changes(p.before,p.after);
        for(const entry of all)r.writes.push({kind:'property',object:p.id,...entry,
          shapeBefore:p.before?.shapeVersion??0,shapeAfter:p.after?.shapeVersion??0});
      }
    }
    if(e.readObservations?.length)r.reads=e.readObservations.map(x=>({...x}));
    if(e.operation==='external.input.deliver') {
      r.authority='environment';
      r.effect=e.causes.find(x=>x.kind==='effect')?.effectId??null;
      r.input=e.causes.find(x=>x.kind==='input')?.inputId??null;
    }
    if(e.operation==='job.enter')r.promise=e.causes.find(x=>x.kind==='promise')?.promiseId??null;
    if(e.operation==='async.await')r.promise=e.causes.find(x=>x.kind==='promise')?.promiseId??null;
    mapping[e.eventId]=r.id;
    output.push(r);
  }
  // Rewrite supply-edge event references from journal IDs to semantic IDs. A
  // supplied literal/housekeeping op remains an archive-only provenance edge.
  for(const row of output)for(const read of row.reads)
    if(read.supplyingEvent)read.supplyingSemantic=mapping[read.supplyingEvent]??null;
  return {schema:'semantic-record/1',rootInvocation:root,events:output,
    journalMapping:mapping,semanticCount:output.length,journalCount:bundle.events.length};
}

export function validateSemantic(bundle,record) {
  const canonical=normalizeJournal(bundle);
  if(!isDeepStrictEqual(record,canonical))
    throw new Error('Semantic projection disagrees with the authoritative journal');
  const seen=new Set();
  for(const event of record.events) {
    for(const dep of [...event.dependsOn,event.control].filter(Boolean))
      if(!seen.has(dep))throw new Error('Future or missing semantic dependency at '+event.id);
    if(seen.has(event.id))throw new Error('Duplicate semantic event');
    seen.add(event.id);
  }
  return {valid:true,semanticEvents:record.events.length,journalEvents:bundle.events.length};
}
