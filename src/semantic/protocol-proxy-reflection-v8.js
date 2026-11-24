// Proxy reflection keeps each selected trap and caller algorithm explicit.
// Ordinary target queries occur after callback completion, never at entry.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {allocateIntrinsicErrorV8} from './protocol-intrinsic-error-v8.js';
import {promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';
import {deriveProxyRouteV8,validateRetainedProxyRouteV8} from './protocol-proxy-v8.js';
export const PROXY_REFLECTION_PROFILE_V8='proxy-reflection/1';
export const PROXY_REFLECTION_STATE_V8='semantic-proxy-reflection/1';
export const PROXY_REFLECTION_OPERATIONS_V8=Object.freeze(['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions']);
export const PROXY_REFLECTION_FIELDS_V8=Object.freeze({
  'proxy.reflect.call':['kind','id','object','operation','caller','arguments','child','route'],
  'proxy.reflect.direct':['kind','object','operation','caller','arguments','result','route'],
  'proxy.reflect.finish':['kind','id','completion'],
  'proxy.reflect.fault':['kind','id','error']
});
export const PROXY_REFLECTION_CALL_FIELDS_V8=Object.freeze(['id','object','operation','caller','arguments','parent','child',
  'owner','target','handler','callee','route']);
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
     !['Object.'+record.operation,'Reflect.'+record.operation].includes(record.caller))
    throw new TypeError('Proxy reflection operation/caller');
  assertAlgorithmDataArray(record.arguments,'Proxy reflection arguments');
  if(record.arguments.length!==(record.operation==='setPrototypeOf'?1:0))throw new TypeError('Proxy reflection argument count');
  record.arguments.forEach(value);
  assertAlgorithmDataArray(record.route,'Proxy reflection route');
  if(record.kind==='proxy.reflect.call'){id(record.id);id(record.child);}else value(record.result);
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
function normalize(c,row,value,api){
  if(row.operation==='getPrototypeOf')return api.copy(value);
  if(row.operation==='isExtensible'||row.caller.startsWith('Reflect.'))return ['bool',api.truthy(value)];
  return ['ref',row.object];
}
export function proxyReflectionFaultV8(c,row,returned,api){
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
  if(row.operation==='setPrototypeOf')api.require(['ref','null'].includes(row.arguments[0][0]),'Proxy prototype argument must be object or null');
}
function direct(c,row,target,api){
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
        value:completion.kind==='throw'?completion.value:normalize(c,row,completion.value,api)};
      api.require(api.eq(record.completion,expected),'false Proxy reflection completion');
    }
    state(c,api).pending.pop();return true;
  }
  const node=c.heap.get(record.object);api.require(node?.kind==='proxy','Proxy reflection object identity');
  validateArguments(c,record,api);
  const derived=deriveProxyRouteV8(c,record.object,record.operation,api);
  api.require(api.eq(record.route,derived.rows),'Proxy reflection route differs from live lookup');
  const target=ordinary(c,derived.target,api);
  if(record.kind==='proxy.reflect.direct'){
    api.require(['undefined','null'].includes(derived.selected[0]),'Proxy reflection requires explicit trap call');
    api.require(api.eq(record.result,direct(c,{...record,target:derived.target},target,api)),'false direct Proxy reflection result');return true;
  }
  const pending=state(c,api).pending;
  api.require(pending.length<64&&!pending.some(row=>row.id===record.id),'Proxy reflection call identity/bound');
  api.require(derived.selected[0]==='ref'&&api.heapNode(c,derived.selected[1]).kind==='closure','Proxy reflection selected trap must be callable');
  const row={id:record.id,object:record.object,operation:record.operation,caller:record.caller,arguments:api.copy(record.arguments),
    parent:c.stack.at(-1),child:record.child,owner:derived.owner,target:api.copy(derived.target),
    handler:api.copy(derived.rows.at(-1).handler),callee:api.copy(derived.selected),route:api.copy(derived.rows)};
  api.call(c,{child:row.child,callee:row.callee,receiver:row.handler,arguments:[row.target,...row.arguments]});
  pending.push(row);return true;
}
export function restoreProxyReflectionV8(c,snapshot,api){
  if(snapshot===null)return {valid:true,calls:0};
  assertAlgorithmFields(snapshot,['schema','pending'],'Proxy reflection state');
  api.require(snapshot.schema===PROXY_REFLECTION_STATE_V8,'Proxy reflection schema');
  assertAlgorithmDataArray(snapshot.pending,'Proxy reflection pending');api.require(snapshot.pending.length<=64,'Proxy reflection bound');
  const seen=new Set();let priorDepth=-1;
  for(const row of snapshot.pending){
    assertAlgorithmFields(row,PROXY_REFLECTION_CALL_FIELDS_V8,'Proxy reflection retained call');
    validateProxyReflectionV8({kind:'proxy.reflect.call',id:row.id,object:row.object,operation:row.operation,caller:row.caller,
      arguments:row.arguments,child:row.child,route:row.route},{value:v=>api.known(c,v)});
    for(const identity of [row.parent,row.owner])id(identity);
    api.require(!seen.has(row.id),'Proxy reflection duplicate call');seen.add(row.id);validateArguments(c,row,api);
    validateRetainedProxyRouteV8(c,{...row,receiver:['ref',row.object]},api);
    api.require(api.eq(row.target,row.route.at(-1).target)&&api.eq(row.handler,row.route.at(-1).handler)&&
      api.eq(row.callee,row.route.at(-1).method),'Proxy reflection retained identities');
    const callee=api.heapNode(c,row.callee[1]);
    api.require(callee.kind==='closure'&&c.frameFunctions.get(row.child)===callee.code&&c.frameFunctions.has(row.parent),
      'Proxy reflection callback source identity');
    const receiver=api.callReceiver(c,row.callee,callee.functionKind==='arrow'?callee.lexicalReceiver:row.handler);
    api.require(api.eq(c.locals.get(row.child+':this'),receiver),'Proxy reflection callback receiver');
    if(c.stack.includes(row.child)){
      const depth=c.stack.indexOf(row.child),call=c.protocol.callFrames.find(call=>call.child===row.child);
      api.require(depth===c.stack.indexOf(row.parent)+1&&depth>priorDepth,'Proxy reflection callback stack order');priorDepth=depth;
      api.require(call&&api.eq(call.callee,row.callee)&&api.eq(call.arguments,[row.target,...row.arguments]),
        'Proxy reflection callback arguments');
    }else api.require(row===snapshot.pending.at(-1)&&c.stack.at(-1)===row.parent&&['return','throw'].includes(c.lastReturn?.kind),
      'Proxy reflection returned callback owner');
  }
  return {valid:true,calls:seen.size};
}
