import {proxyDescriptorTrapResult,proxyOwnKeysTrapResult,proxyDescriptorFields,readProxyPartialDescriptor,proxyPartialDescriptorFields,completeProxyDescriptor,compatibleProxyDescriptor,proxyDefineTrapFault} from '../proxy-reflection-descriptors.js';
// Proxy reflection keeps each selected trap and caller algorithm explicit.
// Ordinary target queries occur after callback completion, never at entry.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {allocateIntrinsicErrorV8} from './protocol-intrinsic-error-v8.js';
import {promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';
import {deriveProxyRouteV8,validateRetainedProxyRouteV8} from './protocol-proxy-v8.js';
export const PROXY_REFLECTION_PROFILE_V8='proxy-reflection/1';
export const PROXY_REFLECTION_STATE_V8='semantic-proxy-reflection/1';
export const PROXY_REFLECTION_OPERATIONS_V8=Object.freeze(['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor','ownKeys','defineProperty']);
export const PROXY_REFLECTION_FIELDS_V8=Object.freeze({
  'proxy.reflect.call':['kind','id','object','operation','caller','arguments','child','route','descriptorObject'],
  'proxy.reflect.direct':['kind','object','operation','caller','arguments','result','route'],
  'proxy.reflect.finish':['kind','id','completion'],
  'proxy.reflect.fault':['kind','id','error']
});
export const PROXY_REFLECTION_CALL_FIELDS_V8=Object.freeze(['id','object','operation','caller','arguments','parent','child',
  'owner','target','handler','callee','route','definition','descriptorObject']);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Proxy reflection identity');};
export function validateProxyReflectionV8(record,{value}){
  if(!isAlgorithmDataRecord(record)||!PROXY_REFLECTION_FIELDS_V8[record.kind])return false;
  assertAlgorithmFields(record,PROXY_REFLECTION_FIELDS_V8[record.kind],'Proxy reflection record');
  if(record.kind==='proxy.reflect.finish'){
    id(record.id);assertAlgorithmFields(record.completion,['kind','value'],'Proxy reflection completion');
    if(!['normal','throw'].includes(record.completion.kind))throw new TypeError('Proxy reflection completion kind');
    value(record.completion.value);return true;
  }
  if(record.kind==='proxy.reflect.fault'){id(record.id);id(record.error);return true;}
  id(record.object);
  if(!PROXY_REFLECTION_OPERATIONS_V8.includes(record.operation)||
     !(record.operation==='ownKeys'?['Reflect.ownKeys']:['Object.'+record.operation,'Reflect.'+record.operation]).includes(record.caller))
    throw new TypeError('Proxy reflection operation/caller');
  assertAlgorithmDataArray(record.arguments,'Proxy reflection arguments');
  if(record.arguments.length!==(record.operation==='defineProperty'?2:['setPrototypeOf','getOwnPropertyDescriptor'].includes(record.operation)?1:0))throw new TypeError('Proxy reflection argument count');
  record.arguments.forEach(value);
  assertAlgorithmDataArray(record.route,'Proxy reflection route');
  if(record.kind==='proxy.reflect.call'){id(record.id);id(record.child);
    if(record.operation==='defineProperty')id(record.descriptorObject);
    else if(record.descriptorObject!==null)throw new TypeError('Only defineProperty has a descriptor object');
  }else value(record.result);
  return true;
}
function state(c,api){return api.state(c).proxyReflection??={schema:PROXY_REFLECTION_STATE_V8,pending:[]};}
function ordinary(c,reference,api){
  api.known(c,reference);const node=c.heap.get(reference[1]);
  api.require(reference[0]==='ref'&&node?.kind==='object','Proxy reflection target requires ordinary internal methods');
  return node;
}
export function proxyReflectionPrototypeV8(c,node,api){
  const proto=node.prototype===undefined||node.prototype==='ordinary'?['ref',promiseIntrinsicIdV8('Object.prototype')]:
    node.prototype===null?['null']:node.prototype;
  api.require(Array.isArray(proto),'Proxy reflection target prototype representation');api.known(c,proto);return proto;
}
function definitionApi(c,api){
  return {truthy:api.truthy,
    callable:value=>value[0]==='ref'&&['closure','intrinsic'].includes(c.heap.get(value[1])?.kind),
    read(object,key){
      api.known(c,object);api.require(object[0]==='ref','Proxy input descriptor object identity');
      const found=api.resolveProperty(c,object[1],key,{forHas:true}).descriptor;
      api.require(!found||found.kind==='data','Proxy input descriptor getter requires its explicit continuation');
      return {present:!!found,value:found?.value??['undefined']};
    }};
}
const callbackArguments=row=>[row.target,...(row.operation==='defineProperty'?
  [row.arguments[0],['ref',row.descriptorObject]]:row.arguments)];
const callbackScope=row=>row.operation==='defineProperty'?
  {kind:'proxy.defineProperty',definition:row.definition}:null;
function checkCallbackScope(receipt,row,api,label){
  const expected=callbackScope(row);
  if(expected===null)api.require(receipt===undefined,label+' on non-definition callback');
  else api.require(api.eq(receipt,expected),label+' differs from retained ToPropertyDescriptor');
}
function reflectionData(c,row,returned,api,direct=false){
  const target=ordinary(c,row.target,api),objectApi={
    eq:api.eq,truthy:api.truthy,extensible:()=>target.extensible!==false,
    ownDescriptor:key=>api.ownDescriptor(target,key),
    keys:()=>api.order(target).map(key=>typeof key==='string'?['str',key]:key),
    callable:value=>value[0]==='ref'&&['closure','intrinsic'].includes(c.heap.get(value[1])?.kind),
    read(object,key){
      api.known(c,object);api.require(object[0]==='ref','Proxy descriptor/list object identity');
      const found=api.resolveProperty(c,object[1],key,{forHas:true}).descriptor;
      api.require(!found||found.kind==='data','Proxy descriptor/list getter requires its explicit continuation');
      return {present:!!found,value:found?.value??['undefined']};
    },
    display(key){
      if(key[0]==='str')return key[1];
      const symbol=c.protocol.symbols.find(row=>row.id===key[1]);
      return 'Symbol('+(symbol?.kind==='well-known'?'Symbol.'+symbol.name:symbol?.description?.[1]??'')+')';
    }
  };
  if(row.operation==='defineProperty')return {fault:proxyDefineTrapFault(returned,row.arguments[0],row.definition,row.caller,objectApi)};
  if(row.operation==='getOwnPropertyDescriptor')
    return direct?{descriptor:objectApi.ownDescriptor(row.arguments[0])??null}:proxyDescriptorTrapResult(returned,row.arguments[0],objectApi);
  return direct?{keys:objectApi.keys()}:proxyOwnKeysTrapResult(returned,objectApi);
}
function materializeReflection(c,row,returned,result,api,direct=false){
  const computed=reflectionData(c,row,returned,api,direct);
  api.require(!computed.fault,'Proxy reflection requires derived fault');
  if(row.operation==='getOwnPropertyDescriptor'&&!computed.descriptor){
    api.require(api.eq(result,['undefined']),'false absent Proxy descriptor');return ['undefined'];
  }
  api.require(result[0]==='ref','Proxy descriptor/list result must be fresh ordinary storage');
  const array=row.operation==='ownKeys',properties=array?computed.keys.map((value,index)=>({key:['str',String(index)],value})):
    proxyDescriptorFields(computed.descriptor).map(([key,value])=>({key:['str',key],value}));
  api.allocate(c,{name:result[1],objectKind:array?'array':'object',length:array?computed.keys.length:null,
    properties,code:null,captures:[],functionKind:null,lexicalReceiver:null});
  return api.copy(result);
}
function normalize(c,row,value,api){
  if(row.operation==='getPrototypeOf')return api.copy(value);
  if(row.operation==='isExtensible'||row.caller.startsWith('Reflect.'))return ['bool',api.truthy(value)];
  return ['ref',row.object];
}
export function proxyReflectionFaultV8(c,row,returned,api){
  if(['getOwnPropertyDescriptor','ownKeys','defineProperty'].includes(row.operation))return reflectionData(c,row,returned,api).fault??null;
  const target=ordinary(c,row.target,api),extensible=target.extensible!==false,truth=api.truthy(returned);
  if(row.operation==='getPrototypeOf'){
    if(!['ref','null'].includes(returned[0]))return "'getPrototypeOf' on proxy: trap returned neither object nor null";
    if(!extensible&&!api.eq(returned,proxyReflectionPrototypeV8(c,target,api)))
      return "'getPrototypeOf' on proxy: proxy target is non-extensible but the trap did not return its actual prototype";
  }else if(row.operation==='setPrototypeOf'){
    if(truth&&!extensible&&!api.eq(row.arguments[0],proxyReflectionPrototypeV8(c,target,api)))
      return "'setPrototypeOf' on proxy: trap returned truish for setting a new prototype on the non-extensible proxy target";
    if(!truth&&row.caller==='Object.setPrototypeOf')return "'setPrototypeOf' on proxy: trap returned falsish for property 'undefined'";
  }else if(row.operation==='isExtensible'){
    if(truth!==extensible)return "'isExtensible' on proxy: trap result does not reflect extensibility of proxy target (which is '"+extensible+"')";
  }else if(truth&&extensible)return "'preventExtensions' on proxy: trap returned truish but the proxy target is extensible";
  else if(!truth&&row.caller==='Object.preventExtensions')return "'preventExtensions' on proxy: trap returned falsish";
  return null;
}
function validateArguments(c,row,api){
  row.arguments.forEach(v=>api.known(c,v));
  if(['getOwnPropertyDescriptor','defineProperty'].includes(row.operation))api.knownKey(c,row.arguments[0]);
  if(row.operation==='setPrototypeOf')api.require(['ref','null'].includes(row.arguments[0][0]),'Proxy prototype argument must be object or null');
}
function direct(c,row,target,api){
  if(row.operation==='defineProperty'){
    const current=api.ownDescriptor(target,row.arguments[0]),completed=completeProxyDescriptor(row.definition,current),
      success=compatibleProxyDescriptor(current,completed,target.extensible!==false,api.eq);
    api.require(success||row.caller==='Reflect.defineProperty','Object.defineProperty failure requires ordinary fault boundary');
    if(success)api.installDescriptor(target,row.arguments[0],completed);
    return row.caller==='Reflect.defineProperty'?['bool',success]:['ref',row.object];
  }
  if(['getOwnPropertyDescriptor','ownKeys'].includes(row.operation))return materializeReflection(c,row,null,row.result,api,true);
  if(row.operation==='getPrototypeOf')return proxyReflectionPrototypeV8(c,target,api);
  if(row.operation==='isExtensible')return ['bool',target.extensible!==false];
  if(row.operation==='preventExtensions'){target.extensible=false;return row.caller.startsWith('Reflect.')?['bool',true]:['ref',row.object];}
  const before=proxyReflectionPrototypeV8(c,target,api),prototype=row.arguments[0];
  let success=api.eq(before,prototype)||target.extensible!==false;
  if(success&&prototype[0]==='ref'){
    let current=prototype,seen=new Set();
    while(current[0]==='ref'){
      if(current[1]===row.target[1]){success=false;break;}
      api.require(!seen.has(current[1]),'Proxy reflection existing prototype cycle');seen.add(current[1]);
      current=proxyReflectionPrototypeV8(c,ordinary(c,current,api),api);
    }
  }
  api.require(success||row.caller==='Reflect.setPrototypeOf','Object.setPrototypeOf false result needs its ordinary fault boundary');
  if(success)target.prototype=prototype[0]==='null'?null:api.copy(prototype);
  return row.caller==='Reflect.setPrototypeOf'?['bool',success]:['ref',row.object];
}
export function assertProxyReflectionNextV8(c,record,api){
  const row=c.protocol?.proxyReflection?.pending.at(-1);
  if(row&&!c.stack.includes(row.child))api.require(['proxy.reflect.finish','proxy.reflect.fault'].includes(record.kind)&&record.id===row.id,
    'pending Proxy reflection requires completion');
  return true;
}
export function applyProxyReflectionV8(c,record,api){
  if(!PROXY_REFLECTION_FIELDS_V8[record.kind])return false;
  if(['proxy.reflect.finish','proxy.reflect.fault'].includes(record.kind)){
    const row=state(c,api).pending.at(-1),completion=c.lastReturn;
    api.require(row?.id===record.id&&c.stack.at(-1)===row.parent&&!c.stack.includes(row.child)&&
      ['return','throw'].includes(completion?.kind),'Proxy reflection lacks callback completion');
    validateRetainedProxyRouteV8(c,{...row,receiver:['ref',row.object]},api);
    checkCallbackScope(completion.proxyReflectionScope,row,api,'completed callback scope');
    if(record.kind==='proxy.reflect.fault'){
      api.require(completion.kind==='return','Proxy reflection fault requires normal trap completion');
      const message=proxyReflectionFaultV8(c,row,completion.value,api);
      api.require(message!==null,'Proxy reflection fault is not derived');
      api.fresh(c,record.error);
      const value=allocateIntrinsicErrorV8(c,{identity:record.error,errorType:'TypeError',message},api);
      c.lastReturn={kind:'throw',value};
    }else{
      if(completion.kind==='return')api.require(proxyReflectionFaultV8(c,row,completion.value,api)===null,'Proxy reflection requires derived fault');
      const expected={kind:completion.kind==='throw'?'throw':'normal',
        value:completion.kind==='throw'?completion.value:
          ['getOwnPropertyDescriptor','ownKeys'].includes(row.operation)?
            materializeReflection(c,row,completion.value,record.completion.value,api):normalize(c,row,completion.value,api)};
      api.require(api.eq(record.completion,expected),'false Proxy reflection completion');
      delete completion.proxyReflectionScope;
    }
    state(c,api).pending.pop();return true;
  }
  const node=c.heap.get(record.object);api.require(node?.kind==='proxy','Proxy reflection object identity');
  validateArguments(c,record,api);
  const definition=record.operation==='defineProperty'?readProxyPartialDescriptor(record.arguments[1],definitionApi(c,api)):null;
  const derived=deriveProxyRouteV8(c,record.object,record.operation,api);
  api.require(api.eq(record.route,derived.route),'Proxy reflection route differs from live lookup');
  const target=ordinary(c,derived.target,api);
  if(record.kind==='proxy.reflect.direct'){
    api.require(['undefined','null'].includes(derived.method[0]),'Proxy reflection requires explicit trap call');
    api.require(api.eq(record.result,direct(c,{...record,target:derived.target,definition},target,api)),'false direct Proxy reflection result');return true;
  }
  const pending=state(c,api).pending;
  api.require(pending.length<64&&!pending.some(row=>row.id===record.id),'Proxy reflection call identity/bound');
  api.require(derived.method[0]==='ref'&&api.heapNode(c,derived.method[1]).kind==='closure','Proxy reflection selected trap must be callable');
  const row={id:record.id,object:record.object,operation:record.operation,caller:record.caller,arguments:api.copy(record.arguments),
    parent:c.stack.at(-1),child:record.child,owner:derived.owner,target:api.copy(derived.target),
    handler:api.copy(derived.route.at(-1).handler),callee:api.copy(derived.method),route:api.copy(derived.route),
    definition:api.copy(definition),descriptorObject:record.descriptorObject};
  if(row.operation==='defineProperty')api.allocate(c,{name:row.descriptorObject,objectKind:'object',length:null,
    properties:proxyPartialDescriptorFields(definition).map(([key,value])=>({key:['str',key],value})),
    code:null,captures:[],functionKind:null,lexicalReceiver:null});
  api.call(c,{child:row.child,callee:row.callee,receiver:row.handler,arguments:callbackArguments(row)},
    row.operation==='defineProperty'?{proxyReflectionScope:callbackScope(row)}:{});
  pending.push(row);return true;
}
export function restoreProxyReflectionV8(c,snapshot,api){
  if(snapshot===null){
    api.require(!c.protocol?.callFrames?.some(frame=>Object.hasOwn(frame,'proxyReflectionScope'))&&
      !Object.hasOwn(c.lastReturn??{},'proxyReflectionScope'),'orphaned Proxy reflection callback scope');
    return {valid:true,calls:0};
  }
  assertAlgorithmFields(snapshot,['schema','pending'],'Proxy reflection state');
  api.require(snapshot.schema===PROXY_REFLECTION_STATE_V8,'Proxy reflection schema');
  assertAlgorithmDataArray(snapshot.pending,'Proxy reflection pending');api.require(snapshot.pending.length<=64,'Proxy reflection bound');
  const seen=new Set();let priorDepth=-1;
  for(const row of snapshot.pending){
    assertAlgorithmFields(row,PROXY_REFLECTION_CALL_FIELDS_V8,'Proxy reflection retained call');
    validateProxyReflectionV8({kind:'proxy.reflect.call',id:row.id,object:row.object,operation:row.operation,caller:row.caller,
      arguments:row.arguments,child:row.child,route:row.route,descriptorObject:row.descriptorObject},{value:v=>api.known(c,v)});
    for(const identity of [row.parent,row.owner])id(identity);
    api.require(!seen.has(row.id),'Proxy reflection duplicate call');seen.add(row.id);validateArguments(c,row,api);
    validateRetainedProxyRouteV8(c,{...row,receiver:['ref',row.object]},api);
    api.require(api.eq(row.target,row.route.at(-1).target)&&api.eq(row.handler,row.route.at(-1).handler)&&
      api.eq(row.callee,row.route.at(-1).method),'Proxy reflection retained identities');
    if(row.operation==='defineProperty'){
      api.require(isAlgorithmDataRecord(row.definition),'retained descriptor snapshot');
      api.require(Object.keys(row.definition).every(key=>['value','writable','get','set','enumerable','configurable'].includes(key)),
        'retained descriptor fields');
      for(const [key,value]of Object.entries(row.definition)){
        if(['writable','enumerable','configurable'].includes(key))api.require(typeof value==='boolean','retained descriptor flag');
        else api.known(c,value);
      }
      api.require(!('get'in row.definition||'set'in row.definition)||!('value'in row.definition||'writable'in row.definition),
        'retained descriptor data/accessor conflict');
      api.known(c,['ref',row.descriptorObject]);
    }else api.require(row.definition===null&&row.descriptorObject===null,'non-definition descriptor snapshot');
    const callee=api.heapNode(c,row.callee[1]);
    api.require(callee.kind==='closure'&&c.frameFunctions.get(row.child)===callee.code&&c.frameFunctions.has(row.parent),
      'Proxy reflection callback source identity');
    const receiver=api.callReceiver(c,row.callee,callee.functionKind==='arrow'?callee.lexicalReceiver:row.handler);
    api.require(api.eq(c.locals.get(row.child+':this'),receiver),'Proxy reflection callback receiver');
    if(c.stack.includes(row.child)){
      const depth=c.stack.indexOf(row.child),call=c.protocol.callFrames.find(call=>call.child===row.child);
      api.require(depth===c.stack.indexOf(row.parent)+1&&depth>priorDepth,'Proxy reflection callback stack order');priorDepth=depth;
      api.require(call&&api.eq(call.callee,row.callee)&&api.eq(call.arguments,callbackArguments(row)),
        'Proxy reflection callback arguments');
      checkCallbackScope(call.proxyReflectionScope,row,api,'active callback scope');
    }else{
      api.require(row===snapshot.pending.at(-1)&&c.stack.at(-1)===row.parent&&['return','throw'].includes(c.lastReturn?.kind),
        'Proxy reflection returned callback owner');
      checkCallbackScope(c.lastReturn?.proxyReflectionScope,row,api,'returned callback scope');
    }
  }
  const scopedFrames=c.protocol.callFrames.filter(frame=>Object.hasOwn(frame,'proxyReflectionScope'));
  api.require(scopedFrames.every(frame=>snapshot.pending.some(row=>row.child===frame.child&&row.operation==='defineProperty')),
    'orphaned active Proxy reflection scope');
  if(Object.hasOwn(c.lastReturn??{},'proxyReflectionScope'))
    api.require(snapshot.pending.at(-1)?.operation==='defineProperty'&&!c.stack.includes(snapshot.pending.at(-1).child),
      'orphaned returned Proxy reflection scope');
  return {valid:true,calls:seen.size};
}
