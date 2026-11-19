// Bounded def-use normalization. No value sampling, constant folding,
// reassociation, effect reordering, or source-name heuristics occur here.
import {validateAlgorithm,validateTerm} from './ir.js';

const copy=value=>structuredClone(value);
const numeric=new Set(['add','subtract','multiply','divide','remainder','power','bit_and','bit_or','bit_xor',
  'shift_left','shift_right','unsigned_shift_right','positive','negate','bit_not']);
const comparisons=new Set(['less','less_equal','greater','greater_equal','equal','not_equal','loose_equal','loose_not_equal']);

export function mapAlgorithmTerm(term,mapper){
  let next;
  if(term.op==='project')next={...term,object:mapAlgorithmTerm(term.object,mapper)};
  else if(term.op==='fold_left')next={...term,input:mapAlgorithmTerm(term.input,mapper),
    initial:mapAlgorithmTerm(term.initial,mapper)};
  else if(Array.isArray(term.args))next={...term,args:term.args.map(arg=>mapAlgorithmTerm(arg,mapper))};
  else next=copy(term);
  return mapper(next);
}
function mapStep(step,mapper){
  if(step.kind==='compute')return {...step,term:mapAlgorithmTerm(step.term,mapper)};
  if(step.kind==='request')return {...step,arguments:step.arguments.map(term=>mapAlgorithmTerm(term,mapper))};
  if(step.kind==='write')return {...step,object:mapAlgorithmTerm(step.object,mapper),value:mapAlgorithmTerm(step.value,mapper)};
  if(step.kind==='return'||step.kind==='throw')return {...step,value:mapAlgorithmTerm(step.value,mapper)};
  return copy(step);
}
function stepTerms(step){
  if(step.kind==='compute')return [step.term];if(step.kind==='request')return step.arguments;
  if(step.kind==='write')return [step.object,step.value];
  if(step.kind==='return'||step.kind==='throw')return [step.value];return [];
}
function counts(core){
  const uses=new Map();
  for(const step of core.steps){
    for(const term of stepTerms(step))mapAlgorithmTerm(term,node=>{
      if(node.op==='ref')uses.set(node.id,(uses.get(node.id)??0)+1);return node;
    });
    if(step.kind==='suspend')for(const id of step.live)uses.set(id,(uses.get(id)??0)+1);
  }
  return uses;
}
function termType(term,types){
  if(term.op==='literal')return term.value[0]==='num'?'number':term.value[0]==='ref'?'data':'scalar';
  if(term.op==='input'||term.op==='ref')return types.get(term.id)??'unknown';
  if(term.op==='fold_left')return 'number';
  if(numeric.has(term.op)&&term.args.every(arg=>termType(arg,types)==='number'))return 'number';
  if(comparisons.has(term.op)||['not','type_of','void'].includes(term.op))return 'scalar';
  if(['select','and','or','coalesce'].includes(term.op)){
    const children=term.op==='select'?term.args.slice(1):term.args;
    const kinds=children.map(arg=>termType(arg,types));return kinds.every(kind=>kind===kinds[0])?kinds[0]:'scalar';
  }
  return 'unknown';
}
/** Totality is a proof over declared types, never a check on one sampled value. */
export function isTotalAlgorithmTerm(term,types=new Map()){
  if(['literal','input','ref'].includes(term.op))return true;
  if(term.op==='project')return false;
  if(term.op==='fold_left')return termType(term.input,types)==='dense-number-array'&&
    termType(term.initial,types)==='number'&&isTotalAlgorithmTerm(term.initial,types);
  if(!term.args.every(arg=>isTotalAlgorithmTerm(arg,types)))return false;
  if(['select','and','or','coalesce','not','void'].includes(term.op))return true;
  const childTypes=term.args.map(arg=>termType(arg,types));
  if(['equal','not_equal'].includes(term.op))return true;
  if(term.op==='type_of')return childTypes[0]!=='unknown';
  if(numeric.has(term.op)||comparisons.has(term.op))return childTypes.every(type=>type==='number');
  return false;
}

function canonicalNames(core){
  const inputNames=new Map(core.inputs.map((input,i)=>[input.id,'a'+i]));
  const valueNames=new Map(),requestNames=new Map(),boundaries=new Map();
  let valueIndex=0,requestIndex=0;
  const rewrite=node=>node.op==='input'?{op:'input',id:inputNames.get(node.id)}:
    node.op==='ref'?{op:'ref',id:valueNames.get(node.id)}:node;
  const steps=[];
  for(const original of core.steps){
    const step=mapStep(original,rewrite);
    if(step.kind==='compute'||step.kind==='observe'){
      step.id='v'+valueIndex++;valueNames.set(original.id,step.id);
    }
    if(step.kind==='request'){
      step.id='r'+requestIndex++;requestNames.set(original.id,step.id);
      if(!boundaries.has(original.boundary))boundaries.set(original.boundary,'b'+boundaries.size);
      step.boundary=boundaries.get(original.boundary);
    }
    if(step.kind==='observe')step.request=requestNames.get(original.request);
    if(step.kind==='suspend'){
      step.requests=original.requests.map(id=>requestNames.get(id));
      step.live=original.live.map(id=>valueNames.get(id));
    }
    steps.push(step);
  }
  return {schema:core.schema,profile:core.profile,
    inputs:core.inputs.map((input,i)=>({id:'a'+i,type:input.type})),steps};
}

/** Deterministic fixed-point passes bounded by the number of removable steps. */
export function normalizeAlgorithm(core){
  validateAlgorithm(core);
  let current=copy(core);
  for(let pass=0;pass<=core.steps.length;pass++){
    const useCounts=counts(current),types=new Map(current.inputs.map(input=>[input.id,input.type]));
    let changed=false;
    for(let i=0;i<current.steps.length;i++){
      const step=current.steps[i];
      if(step.kind!=='compute'){
        if(step.kind==='observe')types.set(step.id,'unknown');continue;
      }
      const total=isTotalAlgorithmTerm(step.term,types);
      if(!useCounts.has(step.id)&&total){current.steps.splice(i,1);changed=true;break;}
      const next=current.steps[i+1];
      // A total one-use value can move only into the immediately following
      // pure computation or completion, never across an effect or observation.
      if(total&&useCounts.get(step.id)===1&&next&&
        (next.kind==='compute'||['return','throw'].includes(next.kind)&&['literal','input','ref'].includes(step.term.op))&&
        stepTerms(next).some(term=>validateTerm(term).dependencies.includes(step.id))){
        const replacement=mapStep(next,node=>node.op==='ref'&&node.id===step.id?copy(step.term):node);
        try{
          stepTerms(replacement).forEach(term=>validateTerm(term));
          current.steps.splice(i,2,replacement);changed=true;break;
        }catch{/* Keep the exact bounded representation when fusion exceeds its term budget. */}
      }
      types.set(step.id,termType(step.term,types));
    }
    if(!changed){const result=canonicalNames(current);validateAlgorithm(result);return result;}
  }
  throw new Error('Algorithm normalization exceeded its monotone pass budget');
}
