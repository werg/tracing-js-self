import {proxyDescriptorTrapResult,proxyOwnKeysTrapResult,proxyDescriptorFields,readProxyPartialDescriptor,proxyPartialDescriptorFields,completeProxyDescriptor,compatibleProxyDescriptor,proxyDefineTrapFault} from './proxy-reflection-descriptors.js';
import {ordinaryGet} from './spec-operations.js';
import {ownedHasProperty} from './owned-has-property.js';
import {propertyKeyValue} from './property-keys.js';
// Owned Proxy reflection. Selected callbacks are ordinary guest frames.
// This module performs no host operation on guest values.
const operations=new Set(['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor','ownKeys','defineProperty']);
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
function reflectData(state,pending,value,api,direct=false){
  const storage=target(state,pending),context={
    eq:equal,truthy:api.truthy,extensible:()=>storage.extensible!==false,
    ownDescriptor(key){
      const name=api.valueKey(key),accessor=storage.accessors?.[name],slot=storage.properties?.[name];
      if(accessor)return {kind:'accessor',get:accessor.get.value,set:accessor.set.value,
        enumerable:accessor.enumerable,configurable:accessor.configurable};
      if(!slot)return null;
      return {kind:'data',value:slot.value,writable:true,enumerable:true,configurable:true,...storage.dataAttributes?.[name]};
    },
    keys:()=>api.ownPropertyKeys(storage).map(propertyKeyValue),
    callable:value=>value[0]==='builtinfn'||value[0]==='ref'&&state.heap[value[1]]?.kind==='function',
    read(object,key){
      const name=api.valueKey(key),found=ordinaryGet(state.heap,object,name);
      if(!found)throw new TypeError('Proxy descriptor/list getter requires its owned continuation');
      return {present:ownedHasProperty(state.heap,object,name),value:found.method.value};
    },
    display:key=>api.proxyDeletePropertyDisplay(state.heap,api.valueKey(key))
  };
  if(pending.operation==='defineProperty')return {fault:proxyDefineTrapFault(value,pending.arguments[0],pending.definition,pending.caller,context)};
  if(pending.operation==='getOwnPropertyDescriptor')
    return direct?{descriptor:context.ownDescriptor(pending.arguments[0])}:proxyDescriptorTrapResult(value,pending.arguments[0],context);
  return direct?{keys:context.keys()}:proxyOwnKeysTrapResult(value,context);
}
function materialize(runtime,state,pending,value,origin,api,direct=false){
  const computed=reflectData(state,pending,value,api,direct);
  if(computed.fault)return {fault:computed.fault};
  if(pending.operation==='getOwnPropertyDescriptor'&&!computed.descriptor)return {value:['undefined']};
  const array=pending.operation==='ownKeys',id=runtime.next(state,'obj'),
    node=state.heap[id]={id,kind:array?'array':'object',properties:{},propertyVersions:{},shapeVersion:0,version:0},
    fields=array?computed.keys.map((value,index)=>[String(index),value]):proxyDescriptorFields(computed.descriptor);
  if(array){node.properties.length={value:['num',0],origin};node.propertyVersions.length=0;}
  for(const [key,value]of fields)api.putOwn(node,key,value,origin);
  return {value:['ref',id]};
}
function fault(state,pending,value,api){
  if(['getOwnPropertyDescriptor','ownKeys','defineProperty'].includes(pending.operation))return reflectData(state,pending,value,api).fault??null;
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
  const parameters=operation==='defineProperty'?[args[1]?.value??['undefined'],args[2]?.value??['undefined']]:
    ['setPrototypeOf','getOwnPropertyDescriptor'].includes(operation)?[args[1]?.value??['undefined']]:[];
  if(['getOwnPropertyDescriptor','defineProperty'].includes(operation))parameters[0]=propertyKeyValue(api.valueKey(parameters[0]));
  if(operation==='setPrototypeOf'&&primitive(parameters[0])&&parameters[0][0]!=='null')
    api.guestFault('TypeError','Object prototype may only be an Object or null: '+String(parameters[0][1]));
  const definition=operation==='defineProperty'?readProxyPartialDescriptor(parameters[1],{
    truthy:api.truthy,callable:value=>runtime.callableGuest(state,value),
    read(value,key){
      const name=api.valueKey(key),found=ordinaryGet(state.heap,value,name);
      if(!found)throw new TypeError('Proxy input descriptor getter requires owned continuation');
      return {present:ownedHasProperty(state.heap,value,name),value:found.method.value};
    }
  }):null;
  const routed=api.proxyRoute(state.heap,object,operation);
  const pending={operation,caller,object,arguments:parameters,route:routed.route,target:routed.target,
    handler:routed.handler??routed.route.at(-1).handler,callee:routed.method??['undefined'],waitingFrameId:null,definition,descriptorObject:null};
  const storage=target(state,pending);
  if(routed.kind==='trap'){
    if(!runtime.callableGuest(state,routed.method)||state.heap[routed.method[1]]?.async)
      throw new TypeError('Proxy reflection trap must be a synchronous owned callable');
    if(operation==='defineProperty'){
      const id=runtime.next(state,'obj'),descriptor=state.heap[id]={id,kind:'object',properties:{},propertyVersions:{},shapeVersion:0,version:0};
      for(const [key,value]of proxyPartialDescriptorFields(definition))api.putOwn(descriptor,key,value,origin);
      pending.descriptorObject=id;
    }
    const callbackArgs=operation==='defineProperty'?[parameters[0],['ref',pending.descriptorObject]]:parameters;
    const callable=state.heap[routed.method[1]],child=runtime.newFrame(state,callable.codeId,callable.closureEnvId,frame.id,null,
      [routed.target,...callbackArgs].map(value=>({value,origin})),runtime.functionThis(callable,routed.handler),callable.id);
    pending.waitingFrameId=child;frame.pendingProxyReflection=pending;state.control.a0.activeFrameId=child;
    return {child,reads:routed.observations};
  }
  if(operation==='defineProperty'){
    const name=api.valueKey(parameters[0]),accessor=storage.accessors?.[name],slot=storage.properties?.[name],
      current=accessor?{kind:'accessor',get:accessor.get.value,set:accessor.set.value,enumerable:accessor.enumerable,configurable:accessor.configurable}:
        slot?{kind:'data',value:slot.value,writable:true,enumerable:true,configurable:true,...storage.dataAttributes?.[name]}:null,
      completed=completeProxyDescriptor(definition,current),success=compatibleProxyDescriptor(current,completed,storage.extensible!==false,equal);
    if(!success&&caller==='Object.defineProperty')api.guestFault('TypeError','Cannot redefine a non-configurable property');
    if(success){
      if(completed.kind==='data'){
        api.putOwn(storage,name,completed.value,origin,{literal:true});
        if(storage.accessors)delete storage.accessors[name];
        storage.dataAttributes??={};storage.dataAttributes[name]={writable:completed.writable,enumerable:completed.enumerable,configurable:completed.configurable};
      }else{
        if(!current)(storage.propertyOrder??=api.ownPropertyKeys(storage)).push(name);
        storage.accessors??={};storage.accessors[name]={get:{value:completed.get,origin},set:{value:completed.set,origin},
          enumerable:completed.enumerable,configurable:completed.configurable};
        delete storage.properties[name];if(storage.dataAttributes)delete storage.dataAttributes[name];
        storage.propertyVersions[name]=(storage.propertyVersions[name]??0)+1;storage.shapeVersion++;
      }
    }
    return {value:normal(pending,['bool',success],api),reads:routed.observations};
  }
  if(['getOwnPropertyDescriptor','ownKeys'].includes(operation)){
    const output=materialize(runtime,state,pending,null,origin,api,true);return {...output,reads:routed.observations};
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
  return ['getOwnPropertyDescriptor','ownKeys'].includes(pending.operation)?
    materialize(runtime,state,pending,value,origin,api):{value:normal(pending,value,api)};
}
