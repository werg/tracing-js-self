// V8 may fulfill a Promise with an ordinary data reference only when reading
// its `then` property cannot invoke guest code or schedule assimilation work.
// The shared legacy controller does not implement those observable jobs.
import {PROTOCOL_MACHINE_API_V8} from './protocol-state-v8.js';

const fail=message=>{const error=new TypeError('Region execution: '+message);error.category='region-authority';throw error;};
const primitiveKinds=new Set(['undefined','null','bool','num','str','bigint','symbol']);

export function assertPlainPromiseResolutionV8(controller,value){
  if(value?.[0]!=='ref')return;
  if(controller.heap.get(value[1])?.kind==='promise')
    fail('Promise adoption requires explicit assimilation jobs');
  // This lookup inspects owned descriptors and known prototype chains. It
  // neither reads a native property nor enters a getter or Proxy trap.
  const {descriptor}=PROTOCOL_MACHINE_API_V8.resolveProperty(controller,value[1],['str','then']);
  if(descriptor===null)return;
  if(descriptor.kind!=='data')fail('Promise then getter requires an explicit resolution protocol');
  const method=descriptor.value;
  if(method[0]==='ref'){
    const node=controller.heap.get(method[1]);
    if(!node||['closure','proxy'].includes(node.kind))
      fail('Callable Promise then requires explicit assimilation jobs');
  }else if(!primitiveKinds.has(method[0]))fail('Unmodeled Promise then requires an explicit resolution protocol');
}

export function assertObservedPromiseResolutionV8(controller,{effect,status,result,graph}){
  if(status!=='fulfilled'||!controller.effects.get(effect)?.promise||result?.[0]!=='ref')return;
  // A validated fresh result graph contains only data objects and arrays,
  // with data properties and no references into the existing owned heap.
  // Existing identities must still pass the same proof as selected resolves.
  if(!controller.heap.has(result[1])&&Array.isArray(graph?.objects)&&
      graph.objects.some(node=>node.id===result[1]))return;
  assertPlainPromiseResolutionV8(controller,result);
}
