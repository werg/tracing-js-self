// Deterministic inspection over a complete public witness prefix.
// The renderer never looks at teacher source-execution futures or private heap.
import {decodeWitness} from './format.js';
import {SemanticController} from './controller.js';
import {renderSemanticRecord} from '../semantic/record-render.js';

export function renderWitness(record) {
  return renderSemanticRecord(decodeWitness(record));
}
export function inspectWitnessPrefix(context,generated,options={}) {
  if(!Array.isArray(context)||!Array.isArray(generated))
    throw new TypeError('Semantic inspection requires explicit public context and trajectory');
  const selected=new SemanticController(context,options);
  const rendered=context.map(renderWitness);
  for(const record of generated){
    // No future record is inspected before the current step commits.
    selected.commit(record);
    rendered.push(renderWitness(record));
  }
  return {rendered,completion:selected.completion,
    firstWitnessViolation:selected.firstWitnessViolation,
    observableGraph:selected.completion?selected.observedGraph():null};
}
