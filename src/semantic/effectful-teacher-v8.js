// Teacher-only bridge: reuse owned event/cell/completion projection while every
// selected transition executes in the public v8 shared machine. No private
// archive or extension hook is available to the serving harness.
import {RegionExecutionHarness} from './region-harness.js';
import {compileSourceProjection} from './source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from './source-compiler-v8.js';
import {encodeProtocolRecordV8} from './protocol-codec-v8.js';
import {isDeepStrictEqual} from 'node:util';

export const EFFECTFUL_REGION_TEACHER_SCHEMA_V8='semantic-region-teacher-adapter/1';
const copy=structuredClone;
const fail=message=>{const error=new TypeError('V8 effectful source projection: '+message);
  error.category='unsupported.effectful-region-source';throw error;};

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
  return host;
}

/** Statically chosen teacher components only; never serialized as model input. */
export function createEffectfulRegionAdapterV8({extensions=[],allowHost=false}={}){
  const ids=extensions.map(extension=>extension.id);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)
    fail('distinct source extension identities required');
  return Object.freeze({schema:EFFECTFUL_REGION_TEACHER_SCHEMA_V8,
    createHarness:options=>facade(new RegionExecutionHarness(options),[],allowHost),
    replay:artifact=>RegionExecutionHarness.replay(artifact),
    restore:packet=>facade(RegionExecutionHarness.restore(packet),[],allowHost),
    encodeProtocol:encodeProtocolRecordV8,
    setup(context){for(const extension of extensions)extension.setup?.(context);},
    isValue(value){return extensions.some(extension=>extension.isValue?.(value)===true);},
    tag(value){for(const extension of extensions){const result=extension.tag?.(value);if(result!==undefined&&result!==null)return result;}return null;},
    allocation(context,event,fields){
      for(const extension of extensions){const record=extension.allocation?.(context,event,fields);if(record)return record;}
      return null;
    },
    event(context,event,row){
      for(const extension of extensions)if(extension.event?.(context,event,row)===true)return true;
      return false;
    },
    completion(context,event,row,fact){
      for(const extension of extensions){const result=extension.completion?.(context,event,row,fact);if(result)return result;}
      return false;
    },
    checkEvent(context,event,row){for(const extension of extensions)
      if(extension.checkEvent&&extension.checkEvent(context,event,row)!==true)
        fail('complete source-state comparison failed: '+extension.id);}
  });
}

export function compileEffectfulRegionWitnessV8(bundle,{maxGenerated=16384,extensions=[],allowHost=false,...options}={}){
  const regionAdapter=createEffectfulRegionAdapterV8({extensions,allowHost});
  return compileSourceProjection(bundle,{realmPolicy:'fresh',sessionId:'protocol-source',sourceLineage:null,...options,
    maxGenerated,semanticRegions:false,localStateCompaction:false,regionAdapter,
    projectionClient:SOURCE_PROJECTION_CLIENT_V8});
}
