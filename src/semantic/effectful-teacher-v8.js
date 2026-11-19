// Teacher-only bridge: reuse owned event/cell/completion projection while every
// selected transition executes in the public v8 shared machine. No private
// archive or extension hook is available to the serving harness.
import {RegionExecutionHarness} from './region-harness.js';
import {compileEffectfulWitness} from '../training/effectful-compiler.js';
import {decodeWitness,encodeWitness} from '../training/format.js';
import {encodeDetailedRecord,decodeDetailedRecord} from './detailed-v7.js';
import {encodeProtocolRecordV8} from './protocol-codec-v8.js';

export const EFFECTFUL_REGION_TEACHER_SCHEMA_V8='semantic-region-teacher-adapter/1';
const copy=structuredClone;
const fail=message=>{const error=new TypeError('V8 effectful source projection: '+message);
  error.category='unsupported.effectful-region-source';throw error;};

function facade(bridge,contexts=[]){
  const host={
    publishProgram(options){
      if(options.capabilities?.length)fail('the initial scheduler source profile has no external capabilities');
      return bridge.publishProgram(options);
    },
    admitInvocation(options){
      if(options.realmPolicy!=='fresh')fail('the scheduler source profile requires a fresh invocation');
      return bridge.admitInvocation(options);
    },
    prepareModelContext(owner){const context=bridge.modelContext(owner);contexts.push(copy(context));return context;},
    selected(owner,line){
      return bridge.select(owner,line.startsWith('protocol ')?line:encodeDetailedRecord(decodeWitness(line),{role:'generated'}));
    },
    checkpoint(){return bridge.checkpoint();},
    exportEpisode({sourceLineage=null}={}){return {public:bridge.exportEpisode(),contexts:copy(contexts),sidecar:{sourceLineage}};},
    get timeline(){
      bridge.sync();return bridge.timeline.map(({sequence,mode,kind,fields})=>({sequence,mode,
        kind:kind==='protocol'?'semantic':kind,...copy(fields),
        ...(fields.line?.startsWith('detail ')?{line:encodeWitness(...((record)=>[record.kind,record.fields])(
          decodeDetailedRecord(fields.line,{role:mode==='observed'?'observed':'generated'})))}:{})}));
    }
  };
  for(const name of ['invocations','intents','handlers','realms','callbacks','programs','sourceAvailability'])
    Object.defineProperty(host,name,{get:()=>bridge.inner[name]});
  // These are source availability bookkeeping, not guest or host execution.
  for(const name of ['evictSource','restoreSource'])host[name]=(...args)=>{
    const result=bridge.inner[name](...args);bridge.sync();return result;
  };
  for(const name of ['deliverResult','postEvent','record','reconcile','registerEventHandler','closeEventHandler','deliverReadyEvents'])
    host[name]=()=>fail('external lifecycle is outside the initial scheduler source profile: '+name);
  return host;
}

/** Statically chosen teacher components only; never serialized as model input. */
export function createEffectfulRegionAdapterV8({extensions=[]}={}){
  const ids=extensions.map(extension=>extension.id);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)
    fail('distinct source extension identities required');
  return Object.freeze({schema:EFFECTFUL_REGION_TEACHER_SCHEMA_V8,
    createHarness:options=>facade(new RegionExecutionHarness(options)),
    replay:artifact=>RegionExecutionHarness.replay(artifact),
    restore:packet=>facade(RegionExecutionHarness.restore(packet)),
    encodeProtocol:encodeProtocolRecordV8,
    setup(context){for(const extension of extensions)extension.setup?.(context);},
    event(context,event,row){
      for(const extension of extensions)if(extension.event?.(context,event,row)===true)return true;
      return false;
    },
    checkEvent(context,event,row){for(const extension of extensions)
      if(extension.checkEvent&&extension.checkEvent(context,event,row)!==true)
        fail('complete source-state comparison failed: '+extension.id);}
  });
}

export function compileEffectfulRegionWitnessV8(bundle,{maxGenerated=16384,extensions=[]}={}){
  const regionAdapter=createEffectfulRegionAdapterV8({extensions});
  return compileEffectfulWitness(bundle,{realmPolicy:'fresh',sessionId:'protocol-source',sourceLineage:null,
    maxGenerated,semanticRegions:false,localStateCompaction:false,regionAdapter});
}
