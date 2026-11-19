// Bounded Proxy operations reuse the shared ordinary-property and call
// semantics. Target, handler, callback and receiver keep their identities.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';

export const PROXY_PROFILE_V8='ordinary-data-proxy/1';
export const PROXY_STATE_V8_SCHEMA='semantic-proxy-call-state/1';
export const PROXY_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'proxy.create':['kind','name','target','handler'],
  'proxy.get':['kind','object','key','result'],
  'proxy.set':['kind','object','key','value','success'],
  'proxy.get.call':['kind','id','object','key','child'],
  'proxy.set.call':['kind','id','object','key','value','child'],
  'proxy.finish':['kind','id','completion']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const PROXY_HEAP_FIELDS=Object.freeze(['kind','target','handler','properties']);
export const PROXY_CALL_FIELDS=Object.freeze(['id','operation','parent','child','object','target','handler','key','value','callee']);
const traps=['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor',
  'defineProperty','has','get','set','deleteProperty','ownKeys','apply','construct'];
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Proxy identity');};
export function validateProxyRecordV8(record,{value}){
  if(!isAlgorithmDataRecord(record))throw new TypeError('Proxy record must be ordinary data');
  const fields=PROXY_RECORD_FIELDS[record.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'ordinary Proxy record');
  if(record.kind==='proxy.create'){id(record.name);value(record.target);value(record.handler);}
  else if(record.kind==='proxy.finish'){
    id(record.id);assertAlgorithmFields(record.completion,['kind','value'],'Proxy completion');
    if(!['normal','throw'].includes(record.completion.kind))throw new TypeError('Proxy completion kind');value(record.completion.value);
  }
  else{id(record.object);value(record.key);if(!['str','symbol'].includes(record.key[0]))throw new TypeError('Proxy property key');
    if(record.kind.endsWith('.call')){id(record.id);id(record.child);}
    if(record.kind!=='proxy.get.call')value(record.kind==='proxy.get'?record.result:record.value);
    if(record.kind==='proxy.set'&&typeof record.success!=='boolean')throw new TypeError('Proxy set result');}
  return true;
}
function ordinary(controller,reference,api,label){
  api.known(controller,reference);api.require(reference[0]==='ref',label+' identity');
  const node=api.heapNode(controller,reference[1]);api.require(node.kind==='object'&&[undefined,null,'ordinary'].includes(node.prototype),
    label+' must have an ordinary object prototype');
  for(const key of api.order(node)){
    const descriptor=api.ownDescriptor(node,Array.isArray(key)?key:['str',key]);
    api.require(descriptor?.kind==='data',label+' accessors require their own protocol');
  }
  return node;
}
function route(controller,node,api){
  const target=ordinary(controller,node.target,api,'Proxy target'),handler=ordinary(controller,node.handler,api,'Proxy handler');
  for(const trap of traps){const method=api.ownDescriptor(handler,['str',trap]);
    api.require(!method||['undefined','null'].includes(method.value[0])||['get','set'].includes(trap)&&
      method.value[0]==='ref'&&api.heapNode(controller,method.value[1]).kind==='closure',
      'Proxy trap '+trap+' requires its explicit call boundary');}
  return {target,handler};
}
function state(controller,api){return api.state(controller).proxyCalls??={schema:PROXY_STATE_V8_SCHEMA,pending:[]};}
const argumentsFor=row=>[row.target,row.key,...(row.operation==='set'?[row.value]:[]),['ref',row.object]];
export function assertProxyNextV8(controller,record,api){
  const pending=controller.protocol?.proxyCalls?.pending.at(-1);
  if(pending&&!controller.stack.includes(pending.child))
    api.require(record.kind==='proxy.finish'&&record.id===pending.id,'pending Proxy callback requires its finish');
  return true;
}
export function applyProxyRecordV8(controller,record,api){
  if(!PROXY_RECORD_FIELDS[record.kind])return false;
  if(record.kind==='proxy.finish'){
    const pending=state(controller,api).pending.at(-1),completion=controller.lastReturn;
    api.require(pending?.id===record.id&&controller.stack.at(-1)===pending.parent&&!controller.stack.includes(pending.child)&&
      ['return','throw'].includes(completion?.kind),'Proxy finish lacks its callback completion');
    const node=controller.heap.get(pending.object);api.require(node?.kind==='proxy','known Proxy identity required');
    const {target}=route(controller,node,api);
    let expected={kind:'throw',value:completion.value};
    if(completion.kind==='return'){
      if(pending.operation==='set')api.require(api.truthy(completion.value),'false Proxy set trap needs its abrupt completion boundary');
      const descriptor=api.ownDescriptor(target,pending.key);
      if(descriptor&&!descriptor.configurable&&!descriptor.writable)
        api.require(api.eq(descriptor.value,pending.operation==='get'?completion.value:pending.value),
          'Proxy trap violates frozen target data invariant');
      expected={kind:'normal',value:pending.operation==='get'?completion.value:pending.value};
    }
    api.require(api.eq(record.completion,expected),'false Proxy callback completion');
    state(controller,api).pending.pop();return true;
  }
  if(record.kind==='proxy.create'){
    api.fresh(controller,record.name);const node={kind:'proxy',target:api.copy(record.target),handler:api.copy(record.handler),properties:new Map()};
    route(controller,node,api);controller.heap.set(record.name,node);state(controller,api);return true;
  }
  const node=controller.heap.get(record.object);api.require(node?.kind==='proxy','known Proxy identity required');
  const {handler}=route(controller,node,api);api.knownKey(controller,record.key);
  const operation=record.kind.startsWith('proxy.get')?'get':'set',method=api.ownDescriptor(handler,['str',operation])?.value??['undefined'];
  if(record.kind.endsWith('.call')){
    const pending=state(controller,api).pending;
    api.require(pending.length<64&&!pending.some(row=>row.id===record.id),'Proxy pending call identity/bound');
    api.require(method[0]==='ref'&&api.heapNode(controller,method[1]).kind==='closure','Proxy call requires a live owned trap');
    if(operation==='set')api.known(controller,record.value);
    const row={id:record.id,operation,parent:controller.stack.at(-1),child:record.child,object:record.object,
      target:api.copy(node.target),handler:api.copy(node.handler),key:api.copy(record.key),value:operation==='set'?api.copy(record.value):null,
      callee:api.copy(method)};
    api.call(controller,{child:row.child,callee:row.callee,receiver:row.handler,arguments:argumentsFor(row)});
    pending.push(row);return true;
  }
  api.require(['undefined','null'].includes(method[0]),'Proxy trap requires its explicit call boundary');
  if(record.kind==='proxy.get'){
    const found=api.resolveProperty(controller,node.target[1],record.key);
    api.require(!found.descriptor||found.descriptor.kind==='data','Proxy getter requires its call boundary');
    const expected=found.descriptor?.value??['undefined'];api.known(controller,record.result);
    api.require(api.eq(record.result,expected),'false Proxy data read');
  }else{
    api.known(controller,record.value);
    // With every handler trap absent, Receiver.[[GetOwnProperty]] and
    // Receiver.[[DefineOwnProperty]] forward to this same ordinary target.
    const success=api.directSet(controller,{object:node.target[1],receiver:node.target,key:record.key,value:record.value});
    api.require(record.success===success,'false Proxy assignment result');
  }
  return true;
}
export function restoreProxyStateV8(controller,snapshot,api){
  let count=0;
  for(const [identity,node]of controller.heap)if(node.kind==='proxy'){
    id(identity);assertAlgorithmFields(node,PROXY_HEAP_FIELDS,'ordinary Proxy heap node');
    api.require(node.properties instanceof Map&&node.properties.size===0,'Proxy has invented own storage');
    route(controller,node,api);count++;
  }
  if(snapshot===null){api.require(!count,'Proxy heap lacks its declared call state');return {valid:true,proxies:0,calls:0};}
  assertAlgorithmFields(snapshot,['schema','pending'],'Proxy call state');
  api.require(snapshot.schema===PROXY_STATE_V8_SCHEMA,'Proxy call state schema');
  assertAlgorithmDataArray(snapshot.pending,'pending Proxy calls');api.require(snapshot.pending.length<=64,'Proxy call bound');
  const seen=new Set();
  for(const row of snapshot.pending){
    assertAlgorithmFields(row,PROXY_CALL_FIELDS,'Proxy pending call');
    for(const identity of [row.id,row.parent,row.child,row.object])id(identity);
    api.require(!seen.has(row.id)&&['get','set'].includes(row.operation),'Proxy pending call identity');seen.add(row.id);
    const node=controller.heap.get(row.object);api.require(node?.kind==='proxy'&&api.eq(node.target,row.target)&&api.eq(node.handler,row.handler),
      'Proxy pending target/handler identities');
    api.knownKey(controller,row.key);api.known(controller,row.callee);
    const callee=api.heapNode(controller,row.callee[1]);
    api.require(row.callee[0]==='ref'&&callee.kind==='closure'&&controller.frameFunctions.get(row.child)===callee.code&&
      controller.frameFunctions.has(row.parent),'Proxy pending callback source identity');
    if(row.operation==='get')api.require(row.value===null,'Proxy get has no assignment operand');else api.known(controller,row.value);
    api.require(api.eq(controller.locals.get(row.child+':this'),callee.functionKind==='arrow'?callee.lexicalReceiver:row.handler),
      'Proxy callback retained receiver');
    if(controller.stack.includes(row.child)){
      api.require(controller.stack.indexOf(row.child)===controller.stack.indexOf(row.parent)+1,'Proxy callback stack relationship');
      const call=controller.protocol.callFrames.find(call=>call.child===row.child);
      api.require(call&&api.eq(call.arguments,argumentsFor(row)),'Proxy callback retained arguments');
    }else api.require(row===snapshot.pending.at(-1)&&controller.stack.at(-1)===row.parent&&
      ['return','throw'].includes(controller.lastReturn?.kind),'Proxy finished callback owner');
  }
  return {valid:true,proxies:count,calls:seen.size};
}
export const hasProxyStateV8=node=>node?.kind==='proxy';
