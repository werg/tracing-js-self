// V8 may fulfill a Promise with an ordinary data reference only when reading
// its `then` property cannot invoke guest code or schedule assimilation work.
// The shared legacy controller does not implement those observable jobs.
import {PROTOCOL_MACHINE_API_V8} from './protocol-state-v8.js';
import {validateSemanticRecord as validateWitness} from './record-schema.js';
import {assertPlainPromiseResolutionWithApiV8} from './promise-resolution-shape-v8.js';

export function assertPlainPromiseResolutionV8(controller,value){
  return assertPlainPromiseResolutionWithApiV8(controller,value,PROTOCOL_MACHINE_API_V8);
}

export function assertObservedPromiseResolutionV8(controller,{effect,status,result,graph}){
  // Reconciliation records its receipt before the legacy delivery path runs.
  // Validate explicit observations here, including rejected data graphs, so
  // malformed graph data cannot leave a receipt for a refused delivery.
  if(['fulfilled','rejected'].includes(status)&&result!==null&&result!==undefined)
    validateWitness('observe',{effect,status,result,...(graph?{graph}:{})});
  if(status!=='fulfilled'||!controller.effects.get(effect)?.promise||result?.[0]!=='ref')return;
  // A validated fresh result graph contains only data objects and arrays,
  // with data properties and no references into the existing owned heap.
  // Existing identities must still pass the same proof as selected resolves.
  if(!controller.heap.has(result[1])&&Array.isArray(graph?.objects)&&
      graph.objects.some(node=>node.id===result[1]))return;
  assertPlainPromiseResolutionV8(controller,result);
}
