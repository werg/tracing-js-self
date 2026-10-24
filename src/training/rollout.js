// Actual selected records commit before independent expected outcome is consulted.
import {isDeepStrictEqual} from 'node:util';
import {restoreWitness} from './format.js';
import {SemanticController} from './controller.js';

export function evaluateSelectedTrajectory({groups,referenceGroups=null,referenceOutcome=null}){
  let invalid=null,firstReferenceTraceDifference=null,controller=null;
  const start=groups.findIndex(g=>g.mode==='generated');
  if(start<2)return {valid:false,invalid:{category:'context',message:'No observed context'}};
  try {
    const context=restoreWitness(groups.slice(0,start).flatMap(g=>g.events.map(e=>e.record)));
    controller=new SemanticController(context);
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
