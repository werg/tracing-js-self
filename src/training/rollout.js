// Strict free-running diagnostic: the selected model bytes are committed as-is.
// Reference targets are consulted only AFTER each selected record commits, for
// reporting first divergence; no predictor control or heap update uses them.
import {isDeepStrictEqual} from 'node:util';
import {decode} from '../values.js';
import {describeGraph} from './graph.js';
import {restoreLines,decodeRecord} from './format.js';
import {SemanticController} from './controller.js';

function project(controller) {
  const seen=new Map();
  function materialize(tag) {
    if(tag[0]!=='ref')return decode(tag);
    const identity=tag[1];
    if(seen.has(identity))return seen.get(identity);
    const entity=controller.heap.get(identity);
    if(!entity || !['array','object'].includes(entity.kind))
      throw new Error('Returned graph contains an unowned reference');
    const length=entity.kind==='array' && entity.properties.get('length');
    const result=entity.kind==='array'?new Array(decode(length.value)):{};
    seen.set(identity,result);
    for(const [key,property] of entity.properties){
      if(entity.kind==='array'&&key==='length')continue;
      Object.defineProperty(result,key,{value:materialize(property.value),
        configurable:true,enumerable:true,writable:true});
    }
    return result;
  }
  return describeGraph([
    ...controller.input.graph.roots.map(materialize),
    materialize(controller.completion.value)
  ]);
}

export function evaluateSelectedTrajectory({groups,referenceGroups=null,referenceOutcome=null,
    maxGenerated=256,maxPacketBytes=65536}={}) {
  if(!Array.isArray(groups)||!groups.length)
    throw new TypeError('Rollout requires the model-selected group records');
  const index=groups.findIndex(g=>g.mode==='generated');
  if(index<1 || groups.slice(0,index).some(g=>g.mode!=='observed'))
    throw new TypeError('Rollout requires an observed source/input prefix');
  const prefix=restoreLines(groups.slice(0,index).map(g=>g.events[0].record));
  const controller=new SemanticController(prefix,{maxGenerated,maxPacketBytes});
  let divergence=null,invalid=null;
  for(let cursor=index;cursor<groups.length;cursor++) {
    const group=groups[cursor];
    if(!['observed','generated'].includes(group.mode) ||
       !Array.isArray(group.events)||group.events.length!==1) {
      invalid={index:cursor,category:'meridian',message:'Malformed selected group'};
      break;
    }
    const {track,record}=group.events[0];
    try {
      if(group.mode==='generated')controller.commitGenerated(record,{track});
      else controller.commitObserved(record,{track});
    }catch(error){
      invalid={index:cursor,category:error.category??'invalid_trace',message:error.message};
      break;
    }
    if(referenceGroups && divergence===null) {
      const expected=referenceGroups[cursor];
      if(!expected || expected.mode!==group.mode ||
         expected.events?.[0]?.record!==record || expected.events?.[0]?.track!==track){
        let category='trace';
        try {
          const actual=decodeRecord(record),gold=decodeRecord(expected?.events?.[0]?.record);
          if(actual.kind==='branch'||actual.kind==='loop')category='control';
          else if(actual.kind==='write')category='mutation';
          else if(actual.kind==='call'||actual.kind==='enter')category='invocation';
          else if(actual.kind==='read')category='read';
          else if(actual.kind==='value')category='value';
          else if(gold.kind!==actual.kind)category='operation';
        }catch{category='serialization';}
        divergence={index:cursor,category,observed:record};
      }
    }
  }
  // A syntactically acceptable prefix is not a completed execution. Missing
  // end records (including cuts inside a fragmented record) are invalid.
  if(!invalid && !controller.completion)
    invalid={index:groups.length,category:'incomplete',
      message:controller.open?'Model stopped inside a fragmented record':
        'Model stopped without a committed terminal end record'};
  let correctness='incomplete',actualGraph=null;
  if(!invalid && controller.completion){
    try {
      actualGraph=project(controller);
      if(referenceOutcome?.kind==='return')
        correctness=isDeepStrictEqual(actualGraph,referenceOutcome.graph)?'correct':'state_mismatch';
      else correctness='unverified';
    }catch(error){
      invalid={index:groups.length,category:'graph',message:error.message};
    }
  }
  return {valid:invalid===null,invalid,firstDivergence:divergence,
    completion:structuredClone(controller.completion),correctness,actualGraph,
    committedGroups:controller.history.length,generatedGroups:controller.generated};
}
