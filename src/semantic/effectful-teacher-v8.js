// Teacher-only bridge: reuse owned event/cell/completion projection while every
// selected transition executes in the public v8 shared machine. No private
// archive or extension hook is available to the serving harness.
import {RegionExecutionHarness} from './region-harness.js';
import {compileSourceProjection} from './source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from './source-compiler-v8.js';
import {encodeProtocolRecordV8} from './protocol-codec-v8.js';
import {isDeepStrictEqual} from 'node:util';
import {createSourceClaimCoordinatorV8,immutableSourceDataV8} from './source-claim-coordinator-v8.js';
import {createBaseSourceComponentV8,BASE_SOURCE_COMPONENT_V8} from './source-projection-base-v8.js';
import {SHARED_PROTOCOL_SOURCE_IDS_V8} from './protocol-source-claims-v8.js';
import {parse} from 'acorn';

export const EFFECTFUL_REGION_TEACHER_SCHEMA_V8='semantic-region-teacher-adapter/1';
const copy=structuredClone;
const fail=message=>{const error=new TypeError('V8 effectful source projection: '+message);
  error.category='unsupported.effectful-region-source';throw error;};
const facades=new WeakMap();
function forkBridge(bridge){
  const {inner,...outer}=bridge,functions={},data={};
  for(const [key,value]of Object.entries(inner))
    (typeof value==='function'?functions:data)[key]=value;
  // This teacher harness consumes recorded observations only. A native live
  // transport must never be cloned or invoked while preparing source output.
  if(Object.keys(inner.services).length||inner.journal||inner.inflight.size||inner.abortControllers.size||
    inner.completionWaiters.size||inner.runnableListeners.size||inner.wakeWaiters.size)
    fail('source preparation cannot own live native services');
  const staged=Object.assign(Object.create(Object.getPrototypeOf(bridge)),copy(outer)),
    selected=Object.assign(Object.create(Object.getPrototypeOf(inner)),copy(data),functions);
  for(const [id,activation]of selected.invocations)
    Object.setPrototypeOf(activation.controller,Object.getPrototypeOf(inner.invocations.get(id).controller));
  staged.inner=selected;staged.bindRealmReadiness();return staged;
}

function facade(bridge,contexts=[],allowHost=false){
  function publicReceipt(receipt){
    bridge.sync();
    if(!receipt?.sequence)return receipt;
    // A host operation can publish more than one receipt. For example, a
    // result can retire its callback handler, and reconciliation publishes its
    // evidence before that result. Preserve the actual returned receipt rather
    // than attributing the final side effect to the source event. Observations
    // retain their exact order even when protocol records or compact regions
    // change the number of public generated records.
    const observed=bridge.inner.timeline.filter(row=>row.mode==='observed'&&row.kind!=='model-context'),
      index=observed.findIndex(row=>row.sequence===receipt.sequence);
    if(index<0||!isDeepStrictEqual(observed[index],receipt))fail('host receipt is not in committed history');
    const row=bridge.timeline.filter(item=>item.mode==='observed')[index],
      {schema,sequence,ownerSequence,traceFormat,mode,kind,...fields}=receipt;
    if(!row||row.mode!==mode||row.kind!==kind||!isDeepStrictEqual(row.fields,fields))
      fail('host receipt differs from its public observation');
    return {sequence:row.sequence,mode,kind,...copy(fields)};
  }
  const host={
    // Stored contexts are private snapshots: prepareModelContext clones its
    // return value before storing it, and exportEpisode clones on exposure.
    // Copy only the append-only index while staging; no handler can mutate a
    // previous snapshot through either facade. The live machine still forks.
    fork(){return facade(forkBridge(bridge),contexts.slice(),allowHost);},
    commitPrepared(staged){
      const prepared=facades.get(staged);if(!prepared)fail('unknown prepared source harness');
      const nextBridge=prepared.bridge,nextContexts=prepared.contexts.slice();
      // All fallible copying finishes before publication. Binding swaps do
      // not spread an arbitrarily large prefix or invoke a post-commit hook.
      bridge=nextBridge;contexts=nextContexts;
    },
    publishProgram(options){
      if(!allowHost&&options.capabilities?.length)fail('external capabilities require the host source profile');
      return bridge.publishProgram(options);
    },
    admitInvocation(options){
      return bridge.admitInvocation(options);
    },
    prepareModelContext(owner){const context=bridge.modelContext(owner);contexts.push(copy(context));return context;},
    selected(owner,line){
      return bridge.select(owner,line);
    },
    checkpoint(){return bridge.checkpoint();},
    exportEpisode({sourceLineage=null}={}){return {public:bridge.exportEpisode(),contexts:copy(contexts),sidecar:{sourceLineage}};},
    get timeline(){
      bridge.sync();return bridge.timeline.map(({sequence,mode,kind,fields})=>({sequence,mode,
        kind:kind==='protocol'?'semantic':kind,...copy(fields)}));
    }
  };
  for(const name of ['invocations','intents','handlers','realms','callbacks','programs','sourceAvailability'])
    Object.defineProperty(host,name,{get:()=>bridge.inner[name]});
  // These are source availability bookkeeping, not guest or host execution.
  for(const name of ['evictSource','restoreSource'])host[name]=(...args)=>{
    return publicReceipt(bridge.inner[name](...args));
  };
  for(const name of ['deliverResult','postEvent','reconcile','registerEventHandler','closeEventHandler'])
    host[name]=(...args)=>publicReceipt(bridge[name](...args));
  for(const name of ['record','deliverReadyEvents'])
    host[name]=(...args)=>publicReceipt(bridge.inner[name](...args));
  facades.set(host,{get bridge(){return bridge;},get contexts(){return contexts;}});
  return host;
}

/** Statically chosen teacher components only; never serialized as model input. */
export function createEffectfulRegionAdapterV8({extensions=[],allowHost=false}={}){
  const ids=extensions.map(extension=>extension.id);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)
    fail('distinct source extension identities required');
  const components=[createBaseSourceComponentV8(),...extensions].sort((a,b)=>a.id.localeCompare(b.id)),
    byId=new Map(components.map(component=>[component.id,component])),coordinator=createSourceClaimCoordinatorV8(components);
  let states={},current=null,context=null,eventView=null,sourceNodes=new Map();
  function view(){return current?.view??{source:context.source,owned:context.state,components:states,...eventView};}
  function currentValues(claimView,...sources){
    const values=new Map();
    function visit(value){
      if(!value||typeof value!=='object')return;
      if(Array.isArray(value)&&typeof value[0]==='string'){
        const input=immutableSourceDataV8(value);let accepted=false;
        for(const component of components)if(component.claims?.value){
          const claimed=component.claims.value(claimView,input);
          if(typeof claimed!=='boolean')fail('value claim must return a boolean: '+component.id);
          accepted=accepted||claimed;
        }
        if(accepted){values.set(JSON.stringify(value),value);return;}
      }
      for(const item of Object.values(value))visit(item);
    }
    for(const source of sources)visit(source);
    // The source projection may materialize an absent argument or default
    // receiver. This is a language value, not a future owned observation.
    visit(['undefined']);return values;
  }
  function allocationInput(identity,node){return {identity,kind:node.kind==='function'?'closure':node.kind,node};}
  function apply(planned,method,...args){
    const component=byId.get(planned.owner),handler=component[method];
    if(typeof handler!=='function')fail('claimed source slot has no handler: '+planned.owner+'/'+method);
    const result=handler(context,...args,planned.prepared);
    if(['event','completion'].includes(method)?result!==true:result===false||result===null||result===undefined)
      fail('claimed source handler declined: '+planned.owner+'/'+planned.id);
    return result;
  }
  return Object.freeze({schema:EFFECTFUL_REGION_TEACHER_SCHEMA_V8,
    projectionStateProfiles:Object.freeze(ids.filter(id=>SHARED_PROTOCOL_SOURCE_IDS_V8.includes(id))),
    createHarness:options=>facade(new RegionExecutionHarness(options),[],allowHost),
    replay:artifact=>RegionExecutionHarness.replay(artifact),
    restore:packet=>facade(RegionExecutionHarness.restore(packet),[],allowHost),
    encodeProtocol:encodeProtocolRecordV8,
    setup(ctx){context=ctx;
      const visit=node=>{if(!node||typeof node!=='object')return;
        if(Array.isArray(node)){node.forEach(visit);return;}
        if(typeof node.type==='string')sourceNodes.set(node.start+':'+node.end,node);
        for(const [key,child]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(child);
      };visit(copy(parse(ctx.source,{ecmaVersion:'latest',sourceType:'script'})));
      for(const component of components)states[component.id]=copy(immutableSourceDataV8(component.initialize?.(
        immutableSourceDataV8({source:ctx.source,programs:ctx.bundle.programs}))??{}));
    },
    componentState(id){if(!Object.hasOwn(states,id))fail('unknown component state');return states[id];},
    beginEvent(event,row,fact){
      if(current)fail('nested source event transaction');
      const frame=event&&context.state.frames[event.invocationId],
        instruction=frame&&context.bundle.programs[frame.codeId]?.instructions[frame.pc];
      eventView={event:event??null,row:row??null,fact:fact??null,
        instruction:instruction&&event&&instruction.siteId===event.siteId&&frame.codeId===event.codeId?instruction:null,
        sourceNode:instruction&&event&&instruction.siteId===event.siteId&&frame.codeId===event.codeId?
          sourceNodes.get(instruction.start+':'+instruction.end)??null:null};
      const priorStates=states,claimView=immutableSourceDataV8(view());
      states=copy(states);current={priorStates,view:claimView};
      const exits=fact?[fact,...(fact.unwound??[])]:[],allocations=new Map();
      // An initial or deferred closure can be published when a current value
      // first names it. Reserve its ownership before any event preparation.
      for(const [identity,node]of Object.entries(context.state.heap))
        if(node.kind==='function'&&!context.controller(context.rootInvocation).heap.has(context.identity(identity)))
          allocations.set(identity,allocationInput(identity,node));
      for(const change of event?.stateChanges??[])if(['heap','promises'].includes(change.table)&&change.before===null)
        allocations.set(change.id,allocationInput(change.id,change.table==='promises'?{...change.after,kind:'promise'}:change.after));
      const values=currentValues(claimView,context.state,event,row,fact),slots=[
        ...(event?[{kind:'event',id:event.eventId,input:{event,row:row??null}}]:[]),
        ...[...allocations].map(([identity,input])=>({kind:'allocation',id:'allocation:'+identity,input})),
        ...[...values].map(([key,input])=>({kind:'value',id:'value:'+key,input})),
        ...exits.map(exit=>({kind:'completion',id:event.eventId+'/'+exit.invocation,input:exit}))];
      const planned=coordinator.plan({view:claimView,slots});
      Object.assign(current,{event:planned.find(item=>item.kind==='event'),
        completions:planned.filter(item=>item.kind==='completion'),
        allocations:new Map(planned.filter(item=>item.kind==='allocation').map(item=>[item.id,item])),
        values:new Map(planned.filter(item=>item.kind==='value').map(item=>[JSON.stringify(item.input),item]))});
      return planned.map(({kind,id,owner})=>({kind,id,owner}));
    },
    endEvent(){current=null;eventView=null;},
    abortEvent(){if(current)states=current.priorStates;current=null;eventView=null;},
    isValue(value){
      if(!current)fail('value query requires a prepared source event');
      return current.values.has(JSON.stringify(value));
    },
    tag(value){
      const key=JSON.stringify(value),planned=current?.values.get(key);
      if(!planned)fail('value has no prepared owner: '+key);
      if(planned.owner===BASE_SOURCE_COMPONENT_V8)return value[0]==='promise'?['ref',value[1]]:
        value[0]==='ref'?['ref',context.identity(value[1])]:copy(value);
      return apply(planned,'tag',immutableSourceDataV8(value));
    },
    allocation(_context,event,fields){
      const identity=Object.keys(context.state.heap).find(id=>context.identity(id)===fields.name)??fields.name,
        node=event?.stateChanges.find(change=>change.table==='heap'&&change.id===identity)?.after??context.state.heap[identity];
      if(!node)fail('allocation has no current owned identity');
      let planned=current?.allocations.get('allocation:'+identity);
      if(!planned)fail('allocation has no prepared owner: '+identity);
      return planned.owner===BASE_SOURCE_COMPONENT_V8?null:apply(planned,'allocation',event,fields);
    },
    event(_context,event,row){
      if(!current||current.event.id!==event.eventId)fail('event has no prepared owner');
      return current.event.owner===BASE_SOURCE_COMPONENT_V8?false:apply(current.event,'event',event,row);
    },
    completion(_context,event,row,fact){
      if(!fact)return false;
      const invocations=[];
      for(const planned of current.completions)if(planned.owner!==BASE_SOURCE_COMPONENT_V8){
        if(!invocations.length&&byId.get(planned.owner)?.completionWritesHandled!==true)
          context.writes(row??{},context.rootFor(planned.input.invocation),event);
        apply(planned,'completion',event,row,planned.input);invocations.push(planned.input.invocation);
      }
      return invocations.length?{invocations}:false;
    },
    beforeEvent(ctx,event,row){
      const failures=[];
      for(const component of components)if(component.beforeEvent){
        try{if(component.beforeEvent(ctx,event,row)===false)fail('source precondition failed: '+component.id);}
        catch(error){failures.push(error);}
      }
      if(failures.length)throw failures[0];
    },
    checkEvent(ctx,event,row){
      if(!event)return;
      const frozen=current.view,input=immutableSourceDataV8({event,row:row??null});
      const failures=[];
      for(const component of components)if(component.checkEvent){
        try{
          const observes=component.observes?component.observes(frozen,input):true;
          if(typeof observes!=='boolean')fail('observer applicability must return a boolean: '+component.id);
          if(observes&&component.checkEvent(ctx,event,row)!==true)
            fail('complete source-state comparison failed: '+component.id);
        }catch(error){failures.push(error);}
      }
      if(failures.length)throw failures[0];
    }
  });
}

export function compileEffectfulRegionWitnessV8(bundle,{maxGenerated=16384,extensions=[],allowHost=false,...options}={}){
  const regionAdapter=createEffectfulRegionAdapterV8({extensions,allowHost});
  return compileSourceProjection(bundle,{realmPolicy:'fresh',sessionId:'protocol-source',sourceLineage:null,...options,
    maxGenerated,semanticRegions:false,localStateCompaction:false,regionAdapter,
    projectionClient:SOURCE_PROJECTION_CLIENT_V8});
}
