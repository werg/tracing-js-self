import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal} from '../semantic/normalize.js';
import {replayExact} from '../replay.js';
import {validateBundle} from '../validation.js';
import {compileWitness} from './compact.js';
import {verifyWitnessEvidence} from './witness-evidence.js';
import {EXECUTION_VERSION,CONTEXT_VERSION,WITNESS_VERSION,SUPERVISION_VERSION} from './format.js';
import {scheduleRecords} from './schedule.js';
import {auditPublicCausality} from './causal-audit.js';
import {verifyVisibleExport} from './visibility.js';
import {evaluateSelectedTrajectory} from './rollout.js';
import {referenceOutcome,ownedOutcome} from './reference.js';

export function exportTraining(runtime,{maxBytes=512,maxGenerated=4096,
  maxOperators=1}={}){
  const bundle=runtime.exportRun();
  validateBundle(bundle);replayExact(bundle);
  const semantic=normalizeJournal(bundle);
  const compiled=compileWitness(bundle,semantic,{maxOperators});
  const verification=verifyWitnessEvidence(bundle,semantic,compiled);
  if(compiled.generated.length>maxGenerated)
    throw new RangeError('Semantic witness logical record budget exceeded');
  const reference=referenceOutcome({
    source:bundle.sources.find(s=>s.sourceId===bundle.entrySpec.sourceId).text,
    entry:bundle.entrySpec.functionName,args:bundle.entrySpec.arguments,
    initialHeap:bundle.initialState.heap,
    randomSeed:bundle.initialState.control.a0.randomSeed??null
  });
  const owned=ownedOutcome(runtime);
  if(!isDeepStrictEqual(reference,owned))
    throw new Error('Independent V8 outcome differs from owned source execution');
  const exported={
    public:{schema:EXECUTION_VERSION,profile:bundle.manifest.profile,
      traceFormat:WITNESS_VERSION,contextFormat:CONTEXT_VERSION,
      completionPolicy:'immediate-root',
      groups:scheduleRecords(compiled,maxBytes)},
    sidecar:{schema:SUPERVISION_VERSION,admission:'locally_verified',
      referenceStatus:'agreed',archive:bundle,semantic,compiled,
      verification,reference,limits:{maxBytes,maxGenerated,maxOperators}}
  };
  validateTrainingExport(exported);
  return exported;
}

export function validateTrainingExport(exported){
  const pub=exported?.public,side=exported?.sidecar;
  if(pub?.schema!==EXECUTION_VERSION||pub.traceFormat!==WITNESS_VERSION||
     pub.contextFormat!==CONTEXT_VERSION||pub.completionPolicy!=='immediate-root'||
     side?.schema!==SUPERVISION_VERSION||!Array.isArray(pub.groups))
    throw new TypeError('Unsupported version-three semantic demonstration');
  verifyVisibleExport(exported);
  const {maxBytes,maxOperators}=side.limits;
  validateBundle(side.archive);replayExact(side.archive);
  const compiled=compileWitness(side.archive,side.semantic,{maxOperators});
  if(!isDeepStrictEqual(compiled,side.compiled))
    throw new Error('Artifact integrity: stored compact compiler bytes changed');
  verifyWitnessEvidence(side.archive,side.semantic,compiled);
  const reference=referenceOutcome({
    source:side.archive.sources.find(s=>s.sourceId===side.archive.entrySpec.sourceId).text,
    entry:side.archive.entrySpec.functionName,
    args:side.archive.entrySpec.arguments,
    initialHeap:side.archive.initialState.heap,
    randomSeed:side.archive.initialState.control.a0.randomSeed??null
  });
  if(!isDeepStrictEqual(reference,side.reference))
    throw new Error('Artifact integrity: independently rerun V8 outcome changed');
  const expected=scheduleRecords(compiled,maxBytes);
  if(!isDeepStrictEqual(expected,pub.groups))
    throw new Error('Artifact integrity: physical transport or loss mask differs');
  if(pub.groups.some(g=>g.events.some(e=>
    Buffer.byteLength(e.record,'utf8')>maxBytes)))
    throw new RangeError('Witness transport exceeds byte capacity');
  auditPublicCausality(pub,{maxBytes});
  const result=evaluateSelectedTrajectory({groups:pub.groups,referenceOutcome:side.reference});
  if(!result.valid||result.correctness!=='correct'||result.firstWitnessViolation)
    throw new Error('Artifact integrity: selected canonical witness fails independent outcome/checker');
  return {valid:true,logicalRecords:compiled.generated.length,
    generatedPhysical:pub.groups.filter(g=>g.mode==='generated').length};
}

