// Canonical semantic projection of the authoritative journal.
// This is a source-anchored derived record, not executable bytecode or a state
// replacement. Every record retains an audit pointer to the committed event.
import {isDeepStrictEqual} from 'node:util';
import {decode} from '../values.js';
import {validateBundle} from '../validation.js';

const selection={
  'binding.initialize':'value','binding.write':'value','binding.read':'read',
  'primitive.binary':'value','primitive.unary':'value',
  'function.define':'alloc','object.allocate':'alloc','array.allocate':'alloc',
  'property.read':'read','property.write':'write',
  'call.enter':'call','call.return':'return','completion.throw':'throw',
  'control.branch':'branch','async.await':'await',
  'external.input.deliver':'observe','job.enter':'resume'
};
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
  const sites=new Map(bundle.sites.map(s=>[s.siteId,s]));
  const root=bundle.initialState.control.a0.activeFrameId;
  if(!root)throw new Error('No root invocation');
  for(const e of bundle.events) {
    // Private arrival must never be an observed or generated target.
    if(e.operation==='external.input.arrive')continue;
    let op=selection[e.operation];
    if(e.operation==='control.jump') {
      const change=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      if(change && change.after.pc<=change.before.pc)op='loop';
    }
    if(!op)continue;
    const args=e.operands??[];
    const source=sites.get(e.siteId);
    const r={id:'e'+(output.length+1),journalEvent:e.eventId,op,
      invocation:e.invocationId??null,site:e.siteId??null,
      source:source?{start:source.start,end:source.end,codeId:source.codeId}:null,
      dependsOn:[...new Set((e.operandOrigins??[]).filter(id=>mapping[id]).map(id=>mapping[id]))],
      control: e.invocationId?lastControl.get(e.invocationId)??null:null,
      operands:args,result:e.result,reads:[],writes:[]};
    if(op==='branch'||op==='loop') {
      const frame=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      r.decision=op==='branch'?e.result?.[1]: 'backedge';
      r.successor=frame?.after?.pc??null;
      lastControl.set(e.invocationId,r.id);
    }
    if(op==='call') {
      const child=e.causes?.find(c=>c.kind==='invocation');
      const effect=e.causes?.find(c=>c.kind==='effect');
      if(child){
        r.child=child.frameId;
        const created=e.stateChanges.find(p=>p.table==='frames' && p.id===child.frameId);
        r.code=created?.after?.codeId??null;
        r.receiver=args[0]?.[0]==='method'?args[0][2]:null;
        r.arguments=args.slice(1);
      } else if(effect) {
        op=r.op='request';
        const created=e.stateChanges.find(p=>p.table==='effects' && p.id===effect.effectId);
        r.effect=effect.effectId;r.operation=created?.after?.operation??null;
        r.arguments=created?.after?.args??[];
      } else r.op='value'; // builtin result
    }
    if(op==='return'||op==='throw') {
      const frame=e.stateChanges.find(p=>p.table==='frames' && p.id===e.invocationId);
      r.destination=frame?.after?.callerFrameId??null;
    }
    if(op==='alloc') {
      const heap=e.stateChanges.filter(p=>p.table==='heap' && p.before===null);
      r.allocations=heap.map(p=>({identity:p.id,kind:p.after.kind,
        codeId:p.after.codeId??null,capture:p.after.closureEnvId??null}));
    }
    if(e.operation==='binding.write' || e.operation==='binding.initialize') {
      for(const p of e.stateChanges.filter(p=>p.table==='envs')) {
        const instruction=bundle.programs[e.codeId]?.instructions.find(x=>x.siteId===e.siteId);
        const key=instruction?.arg;
        const b=key&&p.before?.bindings?.[key],a=key&&p.after?.bindings?.[key];
        if(a && !isDeepStrictEqual(a,b))
          r.writes.push({kind:'cell',env:p.id,key,previous:b?.version??0,
            version:a.version??0,value:a.token?.value??null});
      }
    }
    if(e.operation==='property.write') {
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
