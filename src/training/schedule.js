// Conservative online-deterministic lane policy. This initial exporter uses
// successive meridians (no speculative parallel grouping).
import {semanticLine,fragmentLine,encodeRecord} from './format.js';

function inlineEligible(bundle,codeId,ancestry) {
  const program=bundle.programs[codeId];
  if(!program || program.async || ancestry.includes(codeId))return false;
  const meaningful=program.instructions.filter(i=>[
    'BINARY','UNARY','UPDATE_BINDING','GET_PROP','PUT_PROP','CALL','JUMP_IF_FALSE',
    'LOGICAL_JUMP','RETURN','NEW_OBJECT','NEW_ARRAY','INIT'
  ].includes(i.op));
  if(meaningful.length>24 || program.instructions.some(i=>i.op==='AWAIT'))return false;
  const sourceId=codeId.split(':')[0];
  const source=bundle.sources.find(s=>s.sourceId===sourceId);
  const declaration=bundle.programs[bundle.sources.find(s=>s.sourceId===sourceId)?.entry]
    ?.instructions.find(i=>i.op==='DEF_FN' && i.arg.codeId===codeId);
  const code=source?.text.slice(declaration?.start??0,declaration?.end??source.text.length)??'';
  return Buffer.byteLength(code,'utf8')<=512;
}
export function scheduleRecords(bundle,semantic,{maxBytes=512,maxGenerated=256}={}) {
  const assignments=new Map([[semantic.rootInvocation,{track:'t0',generation:0}]]);
  const generation=[0,0,0,0,0,0,0,0];
  const parentOf=new Map();
  const codeOf=new Map([[semantic.rootInvocation,
    bundle.initialState.frames[semantic.rootInvocation].codeId]]);
  const groups=[];
  const metadata=[];
  let generated=0;
  function append(mode,track,line,event=null) {
    const fragments=fragmentLine(line,{maxBytes});
    for(const fragment of fragments) {
      if(mode==='generated' && ++generated>maxGenerated)
        throw new RangeError('training-js/1 generated chunk limit: continuation required');
      groups.push({id:'g'+(groups.length+1),mode,
        events:[{track,record:fragment}]});
      metadata.push({group:groups.at(-1).id,semanticEvent:event?.id??null,
        journalEvent:event?.journalEvent??null});
    }
  }
  const initial=bundle.initialState.frames[semantic.rootInvocation];
  const restOf=(frame,heap,invocation)=>{
    const prog=bundle.programs[frame.codeId],idx=prog.restIndex??-1;
    if(idx<0)return null;
    const name=prog.params[idx];
    const value=bundle.initialState.envs[frame.envId]?.bindings[name]?.token?.value ??
      frame.restValue;
    if(!value||value[0]!=='ref'||!heap[value[1]])
      throw new Error('Missing owned rest parameter array for '+invocation);
    const obj=heap[value[1]];
    if(obj.kind!=='array')throw new Error('Non-array rest parameter');
    return {name,value};
  };
  const rootRest=restOf(initial,bundle.initialState.heap,semantic.rootInvocation);
  const rootRestVisible=rootRest?{...rootRest,allocation:(()=>{
    const obj=bundle.initialState.heap[rootRest.value[1]];
    return {identity:obj.id,kind:'array',shapeVersion:obj.shapeVersion??0,
      properties:Object.entries(obj.properties).map(([key,v])=>({
        key,version:obj.propertyVersions[key]??0,value:v.value}))};
  })()}:null;
  append('generated','t0',encodeRecord('enter',
    {invocation:semantic.rootInvocation,entry:bundle.entrySpec.functionName,
      code:initial.codeId,receiver:['undefined'],arguments:bundle.entrySpec.arguments,
      captures:bundle.initialState.envs[initial.envId].parent,
      ...(rootRestVisible?{rest:rootRestVisible}:{})}),null);
  for(const row of semantic.events){
    const owner=assignments.get(row.invocation);
    const track=owner?.track??'t0';
    // Environment observations cannot share a generated meridian.
    append(row.op==='observe'?'observed':'generated',track,semanticLine(row),row);
    if(row.op==='call' && row.child) {
      const ancestors=[];
      let p=row.invocation;
      while(p){
        ancestors.push(codeOf.get(p));p=parentOf.get(p);
      }
      parentOf.set(row.child,row.invocation);
      codeOf.set(row.child,row.code);
      const inline=inlineEligible(bundle,row.code,ancestors);
      let lane=track;
      if(!inline){
        const used=new Set([...assignments.values()].map(a=>a.track));
        lane=Array.from({length:8},(_,i)=>'t'+i).find(name=>!used.has(name))??track;
      }
      const index=Number(lane.slice(1));
      generation[index]++;
      assignments.set(row.child,{track:lane,generation:generation[index]});
      // A child is entered only after the parent call chunk has committed.
      // These values come from the call event; no oracle outcome is consulted.
      const childProgram=bundle.programs[row.code];
      const restIndex=childProgram.restIndex??-1;
      const rest=restIndex<0?null:{name:childProgram.params[restIndex],
        value:bundle.events.find(e=>e.eventId===row.journalEvent)
          ?.stateChanges?.find(p=>p.table==='envs' && p.before===null &&
            p.after?.bindings?.[childProgram.params[restIndex]])
          ?.after?.bindings?.[childProgram.params[restIndex]]?.token?.value};
      if(rest && (!rest.value||rest.value[0]!=='ref'))
        throw new Error('Child rest parameter lacks published allocation');
      append('generated',lane,encodeRecord('enter',
        {invocation:row.child,code:row.code,receiver:row.receiver,
          arguments:row.arguments,captures:row.captures,dependsOn:[row.id],
          ...(rest?{rest}:{})}),row);
    }
    if(row.op==='return' || row.op==='throw')assignments.delete(row.invocation);
  }
  append('generated','t0',encodeRecord('end',
    {invocation:semantic.rootInvocation,kind:bundle.finalState.control.a0.completion?.kind??'pending'}));
  return {groups,assignments:metadata,generatedChunks:generated};
}
