import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal,validateSemantic} from '../semantic/normalize.js';
import {semanticLine,encodeRecord,decodeRecord,restoreLines,fragmentLine} from './format.js';
import {scheduleRecords} from './schedule.js';
import {trainingPrefix,verifyVisibleExport} from './visibility.js';
import {auditPublicCausality} from './causal-audit.js';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';

function requireCompletedEntry(bundle) {
  const state=bundle.finalState,control=state.control.a0;
  if(bundle.entrySpec?.kind!=='function' || control.status!=='completed' ||
     control.activeFrameId!==null || control.failure || control.queue.length ||
     control.completion?.kind!=='return' || Object.keys(state.effects).length ||
     Object.keys(state.promises).length ||
     Object.values(state.frames).some(frame=>frame.status!=='completed') ||
     Object.values(state.operations??{}).some(operation=>operation.status!=='completed'))
    throw new TypeError('Only completed synchronous effect-free return entries may be exported');
}

export function exportTraining(runtime,{maxBytes=512,maxGenerated=256}={}) {
  const bundle=runtime.exportRun();
  if(!bundle.entrySpec)throw new TypeError('Only direct training entries may be exported');
  validateBundle(bundle);
  requireCompletedEntry(bundle);
  replayExact(bundle);
  const semantic=normalizeJournal(bundle);
  validateSemantic(bundle,semantic);
  const prefix=trainingPrefix(bundle);
  const scheduled=scheduleRecords(bundle,semantic,{maxBytes,maxGenerated});
  const observed=[...fragmentLine(prefix.source,{maxBytes}),...fragmentLine(prefix.input,{maxBytes})]
    .map(record=>({mode:'observed',events:[{track:'t0',record}]}));
  const groups=[...observed,...scheduled.groups].map((g,i)=>({...g,id:'m'+(i+1),loss:g.mode==='generated'?'semantic':'none'}));
  const exported={
    public:{schema:'semantic-execution/1',profile:bundle.manifest.profile,
      traceFormat:'semantic-trace/1',contextFormat:prefix.schema,
      completionPolicy:'immediate-return',groups},
    sidecar:{schema:'semantic-supervision/1',sourceLineage:null,
      semantic,archive:bundle,assignments:scheduled.assignments,
      generatedChunks:scheduled.generatedChunks,contextGroups:observed.length,
      limits:{maxBytes,maxGenerated},referenceStatus:'not-checked'}
  };
  validateTrainingExport(exported);
  return exported;
}
export function validateTrainingExport(exported) {
  verifyVisibleExport(exported);
  const {groups}=exported.public;
  if(!Array.isArray(groups)||groups.length<4)throw new Error('Truncated training episode');
  validateSemantic(exported.sidecar.archive,exported.sidecar.semantic);
  requireCompletedEntry(exported.sidecar.archive);
  replayExact(exported.sidecar.archive);
  const {maxBytes=512,maxGenerated=256}=exported.sidecar.limits??{};
  if(!Number.isInteger(maxBytes) || maxBytes<64 || maxBytes>1024 ||
     !Number.isInteger(maxGenerated) || maxGenerated<1)
    throw new Error('Invalid local serialization limits');
  auditPublicCausality(exported.public,{maxBytes});
  const seenGroups=new Map(),trace=[],context=[];
  const prefixCount=exported.sidecar.contextGroups;
  let open=null;
  for(const [i,group] of groups.entries()) {
    if(group.id!=='m'+(i+1) || !['observed','generated'].includes(group.mode) ||
       group.loss!==(group.mode==='observed'?'none':'semantic'))
      throw new Error('Invalid group identity/loss');
    const used=new Set();
    if(!Array.isArray(group.events)||!group.events.length)
      throw new Error('Empty meridian');
    for(const event of group.events){
      if(!/^t[0-7]$/.test(event.track)||used.has(event.track))
        throw new Error('Invalid or duplicate lane event');
      used.add(event.track);
      if(Buffer.byteLength(event.record,'utf8')>maxBytes)
        throw new Error('Record exceeds configured hard payload budget');
      const {kind,fields}=decodeRecord(event.record);
      if(i<prefixCount && group.mode!=='observed')
        throw new Error('Initial context is not observed');
      if(i>=prefixCount && group.mode==='observed' && kind!=='observe')
        throw new Error('Unjustified observed continuation');
      if(i>=prefixCount && group.mode==='generated' && ['observe','code'].includes(kind))
        throw new Error('Observed event scored as generated');
      if(open){
        if(kind==='value-part'){
          if(fields.id!==open)throw new Error('Interleaved semantic value');
        }else if(kind==='value-close'){
          if(fields.id!==open)throw new Error('Wrong completed value identity');
          open=null;
          seenGroups.set(fields.id,i);
        }else throw new Error('Interrupted serialization continuation');
      }else if(kind==='value-open')open=fields.id;
      else if(['value-part','value-close'].includes(kind))
        throw new Error('Fragment without opening definition');
      else if(fields.id)seenGroups.set(fields.id,i);
      if(i<prefixCount)context.push(event.record);
      else trace.push(event.record);
      if(i>=prefixCount && kind!=='value-part' && kind!=='value-open' && kind!=='value-close'){
        for(const id of [...(fields.dependsOn??[]),fields.control].filter(Boolean))
          if(!seenGroups.has(id)||seenGroups.get(id)>=i)
            throw new Error('Future or missing producer dependency '+id);
      }
    }
  }
  if(open)throw new Error('Incomplete serialized value');
  const expectedPrefix=trainingPrefix(exported.sidecar.archive);
  if(!isDeepStrictEqual(restoreLines(context),[expectedPrefix.source,expectedPrefix.input]))
    throw new Error('Initial context is not the source/input-only projection');
  const scheduled=scheduleRecords(exported.sidecar.archive,exported.sidecar.semantic,
    {maxBytes,maxGenerated});
  const expectedTrace=scheduled.groups.flatMap(g=>g.events.map(e=>e.record));
  if(!isDeepStrictEqual(trace,expectedTrace))
    throw new Error('Compact trace, lane or chunk allocation disagrees with committed semantic policy');
  const expectedContext=[...fragmentLine(expectedPrefix.source,{maxBytes}),
    ...fragmentLine(expectedPrefix.input,{maxBytes})];
  if(!isDeepStrictEqual(context,expectedContext))
    throw new Error('Observed context fragments differ from the declared source');
  const expectedGroups=[
    ...expectedContext.map(record=>({mode:'observed',events:[{track:'t0',record}]})),
    ...scheduled.groups
  ].map((g,i)=>({...g,id:'m'+(i+1),loss:g.mode==='generated'?'semantic':'none'}));
  if(!isDeepStrictEqual(groups,expectedGroups))
    throw new Error('Meridian order, track selection or observed/generated policy divergence');
  return {valid:true,groups:groups.length,generated:groups.filter(g=>g.mode==='generated').length};
}
