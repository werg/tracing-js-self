// Callback authority and input validation are read-only. Both the original
// runtime and archive validator check the committed request, never current
// mutable argument objects or a lookalike native callback token.
import {isDeepStrictEqual} from 'node:util';
import {hostOperation} from './host/operations.js';
import {validateOwnedGraph} from './host/graph-codec.js';
import {encode,decode} from './values.js';
import {stringPropertyKey} from './property-keys.js';

const requireValue=(condition,message)=>{if(!condition)throw new TypeError(message);};
const scalar=value=>{
  try{return isDeepStrictEqual(encode(decode(value)),value);}catch{return false;}
};

export function validateExternalCallbackJob(state,job,{arrival=false}={}){
  const effect=state.effects[job?.effectId],fn=state.heap[job?.functionId];
  requireValue(effect?.dispatch==='dispatched'&&fn?.kind==='function',
    'Callback handle was not passed by this guest invocation or lacks a dispatched effect');
  if(arrival)requireValue(effect.external==='pending'||
    effect.external==='completed'&&effect.subscription?.state==='active',
  'Callback requires an outstanding dispatched effect or active subscription');
  const spec=hostOperation(effect.operation),returns=Object.hasOwn(job,'returnId');
  requireValue(job.kind==='external-callback'&&Array.isArray(job.args)&&job.args.length<=32&&
    Object.keys(job).sort().join(',')===(returns?
      'args,effectId,functionId,inputGraph,kind,returnId':'args,effectId,functionId,kind'),
  'Invalid external callback job');
  if(returns){
    requireValue(spec.callbackGraph&&spec.kind==='promise'&&!fn.generatorFunction,
      'Return-value callbacks require an asynchronous callback-graph operation');
    requireValue(typeof job.returnId==='string'&&/^[a-z][a-z0-9:_-]{0,127}$/.test(job.returnId),
      'Invalid callback return identity');
    const graph=JSON.parse(effect.request.payload);
    validateOwnedGraph(graph,{callbackGraph:true});
    requireValue([...graph.roots,...graph.objects.flatMap(node=>node.properties.map(p=>p.value))]
      .some(value=>value[0]==='callback'&&value[1]===job.functionId),
    'Callback handle was not passed by this guest invocation');
    validateOwnedGraph(job.inputGraph);
    requireValue(job.inputGraph.roots.length===job.args.length+1&&
      isDeepStrictEqual(job.inputGraph.roots.slice(1),job.args),
    'Callback receiver and arguments must share one input graph');
    if(arrival)requireValue(!state.control.a0.queue.some(prior=>prior.returnId===job.returnId)&&
      !Object.values(state.frames).some(frame=>frame.externalCallbackReturn?.id===job.returnId),
    'Duplicate callback return identity');
  }else{
    requireValue(!fn.async&&spec.callbackIndices.some(index=>
      effect.args[index]?.[0]==='ref'&&effect.args[index][1]===job.functionId),
    'Callback handle was not passed by this guest invocation in a declared notification slot');
    requireValue(job.args.every(scalar),'Notification callbacks require primitive arguments');
  }
  return {effect,fn,returns};
}

/** Independently relate imported graph identities to the new owned frame. */
export function validateExternalCallbackEntry(state,event,job,programs){
  const {fn,returns}=validateExternalCallbackJob(state,job);
  const invocation=event.causes.filter(c=>c.kind==='invocation');
  const frames=event.stateChanges.filter(p=>p.table==='frames'&&p.before===null);
  const frame=frames[0]?.after;
  requireValue(invocation.length===1&&frames.length===1&&invocation[0].frameId===frame?.id&&
    frame.codeId===fn.codeId&&frame.callerFrameId===null&&frame.reactionJob===true&&
    event.causes.length===2&&event.causes.some(c=>c.kind==='effect'&&c.effectId===job.effectId),
  'Callback entry differs from its owned closure or effect');
  if(!returns)return;
  const continuation=frame.externalCallbackReturn,identities=continuation?.graphIdentities;
  requireValue(continuation?.id===job.returnId&&continuation.effectId===job.effectId&&
    continuation.functionId===job.functionId&&Array.isArray(identities)&&
    identities.length===job.inputGraph.objects.length&&
    new Set(identities.map(item=>item.target)).size===identities.length&&
    identities.every((item,index)=>item.source===job.inputGraph.objects[index].id&&
      typeof item.target==='string'&&!Object.hasOwn(state.heap,item.target)),
  'Callback entry lost its exact input graph identity map');
  const mapping=new Map(identities.map(item=>[item.source,item.target]));
  const value=tag=>tag[0]==='ref'?['ref',mapping.get(tag[1])]:tag;
  const imported=event.stateChanges.filter(p=>p.table==='heap'&&p.before===null);
  const program=programs[fn.codeId],restIndex=program.restIndex??-1;
  requireValue(imported.length===identities.length+(restIndex<0?0:1),
    'Callback entry has unrelated heap allocations');
  for(const node of job.inputGraph.objects){
    const id=mapping.get(node.id),entity=imported.find(p=>p.id===id)?.after;
    const properties=Object.fromEntries(node.properties.map(p=>[stringPropertyKey(p.key),
      {value:value(p.value),origin:event.eventId}]));
    requireValue(entity?.kind===node.kind&&entity.id===id&&
      isDeepStrictEqual(entity.properties,properties)&&
      (node.prototype===null?entity.prototype===null:!Object.hasOwn(entity,'prototype')),
    'Callback input graph was changed while entering owned execution');
  }
  const env=event.stateChanges.find(p=>p.table==='envs'&&p.id===frame.envId)?.after;
  requireValue(env?.parent===fn.closureEnvId,'Callback entry lost its captured environment');
  for(const [index,name] of program.params.entries()){
    const actual=env.bindings[name]?.token?.value;
    if(index===restIndex){
      const rest=imported.find(p=>p.id===actual?.[1])?.after;
      const args=job.args.slice(index).map(value);
      requireValue(actual?.[0]==='ref'&&!mapping.has(actual[1])&&rest?.kind==='array'&&
        isDeepStrictEqual(rest.properties.length?.value,['num',args.length])&&
        args.every((item,i)=>isDeepStrictEqual(rest.properties[String(i)]?.value,item)),
      'Callback rest arguments changed at entry');
    }else requireValue(isDeepStrictEqual(actual,job.args[index]?value(job.args[index]):['undefined']),
      'Callback argument aliases changed at entry');
  }
  const receiver=fn.arrow?(fn.lexicalThisFrameId?
    state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):value(job.inputGraph.roots[0]);
  requireValue(isDeepStrictEqual(frame.thisValue,receiver),'Callback receiver changed at entry');
}
