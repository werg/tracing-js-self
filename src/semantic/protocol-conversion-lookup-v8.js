// Descriptor-only lookup shared by the two public conversion continuations.
// Materialized Object.prototype is live realm state, including deletion and
// accessors. Builtin leaves are selected only by their actual intrinsic identity.
import {promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';

const missing=()=>({descriptor:'missing',value:['undefined'],builtin:null});
const builtin=name=>({descriptor:'builtin',value:['undefined'],builtin:name});
export function assertSupportedConversionMethodV8(controller,value,api){
  if(value?.[0]!=='ref')return;
  const node=controller.heap.get(value[1]);
  api.require(node?.kind!=='proxy'&&!(node?.kind==='intrinsic'&&['function','constructor'].includes(node.callableKind)),
    'intrinsic or Proxy conversion callable requires its own protocol');
}

export function lookupConversionPropertyV8(controller,input,key,api){
  let current=input[1];const seen=new Set();
  for(;;){
    api.require(!seen.has(current),'cyclic primitive conversion prototype');seen.add(current);
    const node=api.heapNode(controller,current);
    api.require(['object','array','closure'].includes(node.kind),'ordinary primitive conversion prototype');
    const descriptor=api.ownDescriptor(node,key);
    if(descriptor){
      const value=descriptor.kind==='accessor'?descriptor.get:descriptor.value,
        method=descriptor.kind==='data'&&value[0]==='ref'?controller.heap.get(value[1]):null;
      if(method?.kind==='intrinsic'&&method.callableKind==='function'&&key[0]==='str'){
        if(key[1]==='valueOf'&&method.intrinsicName==='Object.prototype.valueOf')return builtin('Object.valueOf');
        if(key[1]==='toString'&&method.intrinsicName==='Object.prototype.toString')return builtin('Object.toString');
      }
      return {descriptor:descriptor.kind,value,builtin:null};
    }
    const prototype=node.prototype===undefined?'ordinary':node.prototype;
    if(prototype===null)return missing();
    if(prototype==='ordinary'){
      api.require(node.kind!=='closure'||!(key[0]==='str'&&key[1]==='toString'||
        key[0]==='symbol'&&key[1]==='well-known:toStringTag'),
        'function intrinsic prototype requires its own conversion profile');
      // These Array.prototype methods take precedence over Object.prototype.
      if(node.kind==='array'&&key[0]==='str'){
        if(key[1]==='toString')return builtin('Array.toString');
        if(key[1]==='join')return builtin('Array.prototype.join');
      }
      if(controller.protocol?.promiseObjects?.initialized&&current!==promiseIntrinsicIdV8('Object.prototype')){
        current=promiseIntrinsicIdV8('Object.prototype');continue;
      }
      // Without materialized intrinsics the original ordinary profile is
      // pristine. Initialization replaces this fallback with the shared row.
      if(key[0]==='str'&&key[1]==='valueOf')return builtin('Object.valueOf');
      if(key[0]==='str'&&key[1]==='toString')return builtin('Object.toString');
      return missing();
    }
    api.known(controller,prototype);api.require(prototype[0]==='ref','conversion prototype identity');current=prototype[1];
  }
}
