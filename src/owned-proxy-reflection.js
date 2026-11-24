// Owned Proxy reflection. Selected callbacks are ordinary guest frames.
// This module performs no host operation on guest values.
const operations=new Set(['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions']);
const primitive=value=>!['ref','intrinsic','builtinfn','promise'].includes(value?.[0]);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function prototype(state,node,api){
  const value=api.objectPrototype(node);
  if(value===null)return ['null'];
  if(value.endsWith?.('.prototype'))return ['intrinsic',value];
  return ['ref',value];
}
function target(state,pending){
  const node=state.heap[pending.target[1]];
  if(node?.kind!=='object')throw new TypeError('Proxy reflection requires its ordinary target internal-method boundary');
  return node;
}
function fault(state,pending,value,api){
  const node=target(state,pending),extensible=node.extensible!==false,truth=api.truthy(value),op=pending.operation;
  if(op==='getPrototypeOf'){
    if(primitive(value)&&value[0]!=='null')return "'getPrototypeOf' on proxy: trap returned neither object nor null";
    if(!extensible&&!equal(value,prototype(state,node,api)))
      return "'getPrototypeOf' on proxy: proxy target is non-extensible but the trap did not return its actual prototype";
  }else if(op==='setPrototypeOf'){
    if(truth&&!extensible&&!equal(pending.arguments[0],prototype(state,node,api)))
      return "'setPrototypeOf' on proxy: trap returned truish for setting a new prototype on the non-extensible proxy target";
    if(!truth&&pending.caller==='Object.setPrototypeOf')return "'setPrototypeOf' on proxy: trap returned falsish for property 'undefined'";
  }else if(op==='isExtensible'){
    if(truth!==extensible)return "'isExtensible' on proxy: trap result does not reflect extensibility of proxy target (which is '"+extensible+"')";
  }else if(truth&&extensible)return "'preventExtensions' on proxy: trap returned truish but the proxy target is extensible";
  else if(!truth&&pending.caller==='Object.preventExtensions')return "'preventExtensions' on proxy: trap returned falsish";
  return null;
}
function normal(pending,value,api){
  if(pending.operation==='getPrototypeOf')return value;
  if(pending.operation==='isExtensible'||pending.caller.startsWith('Reflect.'))return ['bool',api.truthy(value)];
  return pending.object;
}
export function startOwnedProxyReflection(runtime,state,frame,caller,args,origin,api){
  const operation=caller.split('.')[1],object=args[0]?.value??['undefined'],node=object[0]==='ref'?state.heap[object[1]]:null;
  if(!operations.has(operation)||!['Object','Reflect'].includes(caller.split('.')[0])||node?.kind!=='proxy')return null;
  const parameters=operation==='setPrototypeOf'?[args[1]?.value??['undefined']]:[];
  if(operation==='setPrototypeOf'&&primitive(parameters[0])&&parameters[0][0]!=='null')
    api.guestFault('TypeError','Object prototype may only be an Object or null: '+String(parameters[0][1]));
  const routed=api.proxyRoute(state.heap,object,operation);
  const pending={operation,caller,object,arguments:parameters,route:routed.route,target:routed.target,
    handler:routed.handler??routed.route.at(-1).handler,callee:routed.method??['undefined'],waitingFrameId:null};
  const storage=target(state,pending);
  if(routed.kind==='trap'){
    if(!runtime.callableGuest(state,routed.method)||state.heap[routed.method[1]]?.async)
      throw new TypeError('Proxy reflection trap must be a synchronous owned callable');
    const callable=state.heap[routed.method[1]],child=runtime.newFrame(state,callable.codeId,callable.closureEnvId,frame.id,null,
      [routed.target,...parameters].map(value=>({value,origin})),runtime.functionThis(callable,routed.handler),callable.id);
    pending.waitingFrameId=child;frame.pendingProxyReflection=pending;state.control.a0.activeFrameId=child;
    return {child,reads:routed.observations};
  }
  let value;
  if(operation==='getPrototypeOf')value=prototype(state,storage,api);
  else if(operation==='isExtensible')value=['bool',storage.extensible!==false];
  else if(operation==='preventExtensions'){storage.extensible=false;value=normal(pending,['bool',true],api);}
  else{
    const requested=parameters[0],previous=prototype(state,storage,api);
    let success=equal(requested,previous)||storage.extensible!==false;
    if(success&&requested[0]==='ref'){
      let current=requested,seen=new Set();
      while(current[0]==='ref'){
        if(current[1]===storage.id){success=false;break;}
        if(seen.has(current[1]))throw new TypeError('Existing Proxy prototype cycle');seen.add(current[1]);
        const next=state.heap[current[1]];if(next?.kind!=='object')throw new TypeError('Proxy prototype traversal requires ordinary storage');
        current=prototype(state,next,api);
      }
    }
    if(!success&&caller==='Object.setPrototypeOf')api.guestFault('TypeError','Cannot set prototype of non-extensible object');
    if(success&&!equal(previous,requested)){storage.prototype=requested[0]==='null'?null:requested[1];storage.shapeVersion++;}
    value=normal(pending,['bool',success],api);
  }
  return {value,reads:routed.observations};
}
export function finishOwnedProxyReflection(runtime,state,frame,child,value,origin,api){
  const pending=frame.pendingProxyReflection;
  if(pending?.waitingFrameId!==child.id)return null;
  delete frame.pendingProxyReflection;
  const message=fault(state,pending,value,api);
  if(message){
    const completion={type:'throw',errorType:'TypeError',message,origin};
    completion.value=runtime.caughtError(state,completion,origin);
    state.control.a0.activeFrameId=frame.id;runtime.routeCompletion(state,frame,completion,origin);
    return {abrupt:true};
  }
  return {value:normal(pending,value,api)};
}
