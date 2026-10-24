import {isDeepStrictEqual} from 'node:util';
import {normalizeJournal} from '../semantic/normalize.js';
import {replayExact} from '../replay.js';
import {validateBundle} from '../validation.js';
import {compileWitness} from './compact.js';
import {verifyWitnessEvidence} from './witness-evidence.js';
import {encodeWitness,decodeWitness,EXECUTION_VERSION,CONTEXT_VERSION,
  WITNESS_VERSION,SUPERVISION_VERSION} from './witness-ir.js';
import {WitnessController} from './witness-controller.js';
import {referenceOutcome,ownedOutcome} from './reference.js';

export function fragmentWitness(line,{maxBytes=512}={}){
  decodeWitness(line);
  if(Buffer.byteLength(line,'utf8')<=maxBytes)return [line];
  const id='r'+Buffer.byteLength(line,'utf8');
  const opening=encodeWitness('value-open',{id,type:'semantic-record'});
  const close=encodeWitness('value-close',{id});
  if([opening,close].some(v=>Buffer.byteLength(v,'utf8')>maxBytes))
    throw new RangeError('Witness fragment framing exceeds capacity');
  const parts=[];let buffer='';
  for(const char of line){
    const attempt=buffer+char;
    if(Buffer.byteLength(encodeWitness('value-part',{id,data:attempt}),'utf8')>maxBytes){
      if(!buffer)throw new RangeError('Witness scalar too large for fragment');
      parts.push(encodeWitness('value-part',{id,data:buffer}));buffer=char;
    }else buffer=attempt;
  }
  if(buffer)parts.push(encodeWitness('value-part',{id,data:buffer}));
  return [opening,...parts,close];
}
export function restoreWitness(lines){
  const restored=[];
  for(let i=0;i<lines.length;i++){
    const {kind,fields}=decodeWitness(lines[i]);
    if(kind!=='value-open'){
      if(['value-part','value-close'].includes(kind))
        throw new SyntaxError('Orphaned witness transport fragment');
      restored.push(lines[i]);continue;
    }
    if(fields.type!=='semantic-record')throw new SyntaxError('Unknown transport fragment type');
    let data='',closed=false;
    for(++i;i<lines.length;i++){
      const piece=decodeWitness(lines[i]);
      if(piece.fields.id!==fields.id)throw new SyntaxError('Interleaved witness fragments');
      if(piece.kind==='value-close'){closed=true;break;}
      if(piece.kind!=='value-part'||!piece.fields.data)
        throw new SyntaxError('Invalid witness fragment');
      data+=piece.fields.data;
    }
    if(!closed)throw new SyntaxError('Incomplete witness fragment');
    decodeWitness(data);
    if(fields.id!=='r'+Buffer.byteLength(data,'utf8'))
      throw new SyntaxError('Witness fragment identity mismatch');
    restored.push(data);
  }
  return restored;
}
function groupify(compiled,maxBytes){
  const groups=[];
  const append=(mode,logical)=>{
    for(const record of fragmentWitness(logical,{maxBytes}))
      groups.push({id:'m'+(groups.length+1),mode,
        loss:mode==='observed'?'none':'semantic',
        events:[{track:'t0',record}]});
  };
  for(const line of compiled.context)append('observed',line);
  for(const line of compiled.generated)append('generated',line);
  return groups;
}

export function exportWitnessTraining(runtime,{maxBytes=512,maxGenerated=4096,
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
      groups:groupify(compiled,maxBytes)},
    sidecar:{schema:SUPERVISION_VERSION,admission:'locally_verified',
      referenceStatus:'agreed',archive:bundle,semantic,compiled,
      verification,reference,limits:{maxBytes,maxGenerated,maxOperators}}
  };
  validateWitnessTrainingExport(exported);
  return exported;
}

export function validateWitnessTrainingExport(exported){
  const pub=exported?.public,side=exported?.sidecar;
  if(pub?.schema!==EXECUTION_VERSION||pub.traceFormat!==WITNESS_VERSION||
     pub.contextFormat!==CONTEXT_VERSION||pub.completionPolicy!=='immediate-root'||
     side?.schema!==SUPERVISION_VERSION||!Array.isArray(pub.groups))
    throw new TypeError('Unsupported version-three semantic demonstration');
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
  const expected=groupify(compiled,maxBytes);
  if(!isDeepStrictEqual(expected,pub.groups))
    throw new Error('Artifact integrity: physical transport or loss mask differs');
  if(pub.groups.some(g=>g.events.some(e=>
    Buffer.byteLength(e.record,'utf8')>maxBytes)))
    throw new RangeError('Witness transport exceeds byte capacity');
  const result=evaluateWitnessTrajectory({groups:pub.groups,referenceOutcome:side.reference});
  if(!result.valid||result.correctness!=='correct'||result.firstWitnessViolation)
    throw new Error('Artifact integrity: selected canonical witness fails independent outcome/checker');
  return {valid:true,logicalRecords:compiled.generated.length,
    generatedPhysical:pub.groups.filter(g=>g.mode==='generated').length};
}

export function evaluateWitnessTrajectory({groups,referenceGroups=null,referenceOutcome=null}){
  let invalid=null,firstReferenceTraceDifference=null,controller=null;
  const start=groups.findIndex(g=>g.mode==='generated');
  if(start<2)return {valid:false,invalid:{category:'context',message:'No observed context'}};
  try {
    const context=restoreWitness(groups.slice(0,start).flatMap(g=>g.events.map(e=>e.record)));
    controller=new WitnessController(context);
    // Fragments are transport only. A complete logical record commits at
    // its close and must never change the public heap mid-fragment.
    const after=groups.slice(start);
    const decoded=restoreWitness(after.flatMap(g=>g.events.map(e=>e.record)));
    for(const [index,line] of decoded.entries())controller.commit(line);
    if(!controller.completion)
      invalid={category:'incomplete',message:'Selected trajectory lacks root end'};
    if(referenceGroups&&!isDeepStrictEqual(groups,referenceGroups)){
      const mismatch=groups.findIndex((g,i)=>!isDeepStrictEqual(g,referenceGroups[i]));
      firstReferenceTraceDifference={index:mismatch,category:'text-only'};
    }
  }catch(error){
    invalid={category:error.category??'invalid_trace',message:error.message};
  }
  let correctness='unverified',actualGraph=null;
  if(!invalid&&controller?.completion){
    try{
      actualGraph=controller.observedGraph();
      if(referenceOutcome?.kind==='return')
        correctness=isDeepStrictEqual(actualGraph,referenceOutcome.graph)?
          'correct':'state_mismatch';
    }catch(error){
      invalid={category:error.category??'graph',message:error.message};
    }
  }
  return {valid:!invalid,invalid,correctness,actualGraph,
    completion:controller?.completion??null,
    firstReferenceTraceDifference,
    firstWitnessViolation:controller?.firstWitnessViolation??null,
    observableMismatch:correctness==='state_mismatch'?{
      expected:referenceOutcome?.graph,actual:actualGraph}:null,
    logicalRecords:controller?.history.length??0,
    physicalGroups:groups.length};
}
