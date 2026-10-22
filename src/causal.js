// Projection-local identities and strictly pre-availability guest events.
// In particular, canonical inbox state, host-arrival records, state roots, indexes,
// hashes and raw state patches are NEVER exposed to the model context.
export function causalPrefix(bundle,{throughEventId=null}={}) {
  if(bundle.manifest?.schema!=='semantic-tracing-run/1')throw new Error('Unsupported run bundle');
  const limit=throughEventId ? bundle.events.findIndex(e=>e.eventId===throughEventId) : bundle.events.length-1;
  if(throughEventId && limit<0)throw new Error('Unknown boundary');
  const visible=bundle.events.slice(0,limit+1).filter(e=>e.operation!=='external.input.arrive');
  const events={},identities=new Map(),effects=new Map(),invocations=new Map();
  function local(map,id,prefix){if(!map.has(id))map.set(id,`${prefix}${map.size+1}`);return map.get(id);}
  function opaque(v) {
    if(!Array.isArray(v))return v;
    if(v[0]==='ref'||v[0]==='promise'||v[0]==='host')return [v[0],local(identities,`${v[0]}:${v[1]}`,'r')];
    if(v[0]==='method')return ['method',opaque(v[1]),opaque(v[2])];
    return v.map((x,i)=>i>0&&Array.isArray(x)?opaque(x):x);
  }
  const rows=[];
  for(const [index,e] of visible.entries()) {
    const id=`e${index+1}`;events[e.eventId]=id;
    const row={event:id,op:e.operation};
    if(e.siteId)row.site=e.siteId;
    if(e.invocationId)row.invocation=local(invocations,e.invocationId,'c');
    const invoked=e.causes?.find(c=>c.kind==='invocation');
    if(invoked)row.child=local(invocations,invoked.frameId,'c');
    if(e.readObservations?.length)row.reads=e.readObservations.map(read=>({
      kind:read.kind,
      ...(read.envId?{env:local(identities,'env:'+read.envId,'r')}:{}),
      ...(read.objectId?{object:local(identities,'ref:'+read.objectId,'r')}:{}),
      ...(read.name?{name:read.name}:{}),
      ...(read.key?{key:read.key}:{}),
      version:read.version,
      ...(read.shapeVersion!==undefined?{shapeVersion:read.shapeVersion}:{}),
      ...(read.present!==undefined?{present:read.present}:{}),
      ...(read.value?{value:opaque(read.value)}:{}),
      supplyingEvent:read.supplyingEvent?events[read.supplyingEvent]??null:null
    }));
    if(e.operands?.length)row.operands=e.operands.map(opaque);
    if(e.operandOrigins?.length)row.producers=e.operandOrigins.map(orig=>orig?events[orig]??null:null);
    if(e.result!==null)row.result=opaque(e.result);
    if(e.operation==='call.enter') {
      const created=e.stateChanges.filter(p=>p.table==='effects'&&p.before===null);
      if(created.length)row.outgoing=created.map(p=>({effect:local(effects,p.id,'fx'),operation:p.after.operation,arguments:p.after.args.map(opaque)}));
    }
    if(e.operation==='external.input.deliver') {
      const input=e.causes.find(x=>x.kind==='input');
      const effected=e.causes.find(x=>x.kind==='effect');
      row.supplied={authority:'environment',effect:effected?local(effects,effected.effectId,'fx'):null,
        value:opaque(e.result),input:input?local(identities,`input:${input.inputId}`,'r'):null};
    }
    rows.push(row);
  }
  return {schema:'causal-interleaved-prefix/1',visibility:{futureInputs:'withheld until delivery',archiveStateAccessible:false},
    sources:bundle.sources.filter(s=>{
      const initial=bundle.initialState?.control?.a0?.activeFrameId;
      const code=bundle.initialState?.frames?.[initial]?.codeId;
      return !!code && code.startsWith(s.sourceId+':');
    }).map(s=>({sourceId:s.sourceId,text:s.text,url:s.url,goal:s.goal})),
    events:rows};
}
