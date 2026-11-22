// Descriptor-only proof shared by ordinary settlement and async completion.
// The machine API is supplied by the caller to avoid evaluator import cycles.
const primitiveKinds=new Set(['undefined','null','bool','num','str','bigint','symbol']);
const fail=message=>{const error=new TypeError('Region execution: '+message);error.category='region-authority';throw error;};
export function assertPlainPromiseResolutionWithApiV8(controller,value,api){
  if(value?.[0]!=='ref')return;
  if(controller.heap.get(value[1])?.kind==='promise')fail('Promise adoption requires explicit assimilation jobs');
  const {descriptor}=api.resolveProperty(controller,value[1],['str','then']);
  if(descriptor===null)return;
  if(descriptor.kind!=='data')fail('Promise then getter requires an explicit resolution protocol');
  const method=descriptor.value;
  if(method[0]==='ref'){
    const node=controller.heap.get(method[1]);
    if(!node||['closure','proxy'].includes(node.kind))fail('Callable Promise then requires explicit assimilation jobs');
  }else if(!primitiveKinds.has(method[0]))fail('Unmodeled Promise then requires an explicit resolution protocol');
}
