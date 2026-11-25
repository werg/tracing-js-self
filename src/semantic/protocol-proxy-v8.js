// Bounded Proxy operations reuse the shared ordinary-property and call
// semantics. Target, handler, callback and receiver keep their identities.
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {parse} from 'acorn';
import {stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
import {allocateIntrinsicErrorV8} from './protocol-intrinsic-error-v8.js';
import {constructionCallReceiverV8} from './protocol-construction-v8.js';

export const PROXY_PROFILE_V8='ordinary-data-proxy/1';
export const PROXY_STATE_V8_SCHEMA='semantic-proxy-call-state/1';
export const PROXY_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'proxy.create':['kind','name','target','handler'],
  'proxy.revocable':['kind','proxy','revoke','result','target','handler'],
  'proxy.revoke':['kind','object'],
  'proxy.getMethod.begin':['kind','id','operation','object','target','handler','receiver','key','child','getter'],
  'proxy.getMethod.finish':['kind','id','completion'],
  'proxy.revoked.fault':['kind','object','operation','error'],
  'proxy.get':['kind','object','key','result','route'],
  'proxy.set':['kind','object','key','value','success','route'],
  'proxy.has':['kind','object','key','result','route'],
  'proxy.delete':['kind','object','key','success','route'],
  'proxy.get.call':['kind','id','object','owner','receiver','key','child','route'],
  'proxy.set.call':['kind','id','object','owner','receiver','key','value','child','strict','route'],
  'proxy.has.call':['kind','id','object','owner','receiver','key','child','route'],
  'proxy.delete.call':['kind','id','object','owner','receiver','key','child','strict','route'],
  'proxy.delete.fault':['kind','object','key','error','route'],
  'proxy.fault':['kind','id','error'],
  'proxy.finish':['kind','id','completion']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const PROXY_HEAP_FIELDS=Object.freeze(['kind','target','handler','properties']);
export const PROXY_CALL_FIELDS=Object.freeze(['id','operation','parent','child','object','owner','receiver','target','handler','route','key','value','callee','strict']);
export const PROXY_GET_METHOD_FIELDS=Object.freeze(['id','phase','operation','parent','child','object','target','handler','receiver','key','getter','rawReturn','method']);
const traps=['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor',
  'defineProperty','has','get','set','deleteProperty','ownKeys','apply','construct'];
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Proxy identity');};
function validateRouteSnapshot(route,value){
  assertAlgorithmDataArray(route,'Proxy retained route');if(!route.length||route.length>64)throw new TypeError('Proxy route bound');
  for(const row of route){
    assertAlgorithmFields(row,['object','target','handler','method'],'Proxy route row');
    id(row.object);value(row.target);value(row.handler);value(row.method);
    if(row.target[0]!=='ref'||row.handler[0]!=='ref')throw new TypeError('Proxy route identities');
  }
}

export function hasProxySourceCallableV8(source,code){
  if(typeof code!=='string'||!/^Proxy\.revoke:[^\s]{1,256}$/.test(code)||typeof source!=='string')return false;
  try{
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});let found=false;
    const visit=node=>{
      if(!node||typeof node!=='object'||found)return;
      if(Array.isArray(node)){for(const child of node)visit(child);return;}
      if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&
        node.callee.computed===false&&node.callee.object?.type==='Identifier'&&node.callee.object.name==='Proxy'&&
        node.callee.property?.type==='Identifier'&&node.callee.property.name==='revocable'){found=true;return;}
      for(const [key,value] of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
    };
    visit(ast);return found;
  }catch{return false;}
}

export function validateProxyRecordV8(record,{value}){
  if(!isAlgorithmDataRecord(record))throw new TypeError('Proxy record must be ordinary data');
  let fields=PROXY_RECORD_FIELDS[record.kind];if(!fields)return false;
  if(record.kind==='proxy.has'&&Object.hasOwn(record,'id'))fields=[...fields,'id'];
  assertAlgorithmFields(record,fields,'ordinary Proxy record');
  if(record.kind==='proxy.create'){id(record.name);value(record.target);value(record.handler);}
  else if(record.kind==='proxy.revocable'){id(record.proxy);id(record.revoke);id(record.result);value(record.target);value(record.handler);
    if(new Set([record.proxy,record.revoke,record.result]).size!==3)throw new TypeError('Proxy revocable identities');}
  else if(record.kind==='proxy.revoke'){id(record.object);}
  else if(record.kind==='proxy.getMethod.begin'){
    id(record.id);id(record.child);id(record.object);value(record.target);value(record.handler);value(record.receiver);
    value(record.key);value(record.getter);
    if(record.operation!=='has'||record.target[0]!=='ref'||record.handler[0]!=='ref'||
      record.receiver[0]!=='ref'||record.getter[0]!=='ref'||!['str','symbol'].includes(record.key[0]))
      throw new TypeError('Proxy GetMethod getter selection');
  }else if(record.kind==='proxy.getMethod.finish'){
    id(record.id);assertAlgorithmFields(record.completion,['kind','value'],'Proxy GetMethod completion');
    if(!['normal','throw'].includes(record.completion.kind))throw new TypeError('Proxy GetMethod completion kind');
    value(record.completion.value);
  }else if(record.kind==='proxy.revoked.fault'){id(record.object);id(record.error);
    if(!['get','set','has','deleteProperty'].includes(record.operation))throw new TypeError('Proxy revoked operation');}
  else if(record.kind==='proxy.fault'){id(record.id);id(record.error);}
  else if(record.kind==='proxy.delete.fault'){id(record.object);id(record.error);value(record.key);
    if(!['str','symbol'].includes(record.key[0]))throw new TypeError('Proxy property key');
    validateRouteSnapshot(record.route,value);}
  else if(record.kind==='proxy.finish'){
    id(record.id);assertAlgorithmFields(record.completion,['kind','value'],'Proxy completion');
    if(!['normal','throw'].includes(record.completion.kind))throw new TypeError('Proxy completion kind');value(record.completion.value);
  }
  else{id(record.object);value(record.key);if(!['str','symbol'].includes(record.key[0]))throw new TypeError('Proxy property key');
    validateRouteSnapshot(record.route,value);
    if(record.kind==='proxy.has'&&Object.hasOwn(record,'id'))id(record.id);
    if(record.kind.endsWith('.call')){id(record.id);id(record.child);id(record.owner);value(record.receiver);
      if(record.receiver[0]!=='ref')throw new TypeError('Proxy operation receiver identity');}
    if(['proxy.delete.call','proxy.set.call'].includes(record.kind)&&typeof record.strict!=='boolean')throw new TypeError('Proxy caller strict flag');
    if(['proxy.get','proxy.has'].includes(record.kind))value(record.result);
    if(record.kind==='proxy.has'&&record.result[0]!=='bool')throw new TypeError('Proxy has result must be Boolean');
    if(record.kind==='proxy.set'||record.kind==='proxy.set.call')value(record.value);
    if(['proxy.set','proxy.delete'].includes(record.kind)&&typeof record.success!=='boolean')throw new TypeError('Proxy Boolean result');}
  return true;
}
function ordinary(controller,reference,api,label){
  api.known(controller,reference);api.require(reference[0]==='ref',label+' identity');
  const node=api.heapNode(controller,reference[1]);api.require(node.kind==='object'&&
    [undefined,null,'ordinary','Object.prototype'].includes(node.prototype),
    label+' must have an ordinary object prototype');
  return node;
}
function route(controller,node,api){
  // Target identity may itself be a Proxy. Internal-method dispatch is retained
  // by deriveRoute; this structural check never re-reads a selected trap.
  if(api.eq(node.target,['null'])||api.eq(node.handler,['null'])){
    api.require(api.eq(node.target,['null'])&&api.eq(node.handler,['null']),'Proxy partial revocation');
    return {target:null,handler:null,revoked:true};
  }
  api.known(controller,node.target);api.require(node.target[0]==='ref','Proxy target identity');
  const target=controller.heap.get(node.target[1]);
  api.require(target&&['object','array','proxy'].includes(target.kind),'Proxy target object identity');
  const handler=ordinary(controller,node.handler,api,'Proxy handler');
  return {target,handler};
}
const trapName=operation=>operation==='delete'?'deleteProperty':operation;
function method(controller,node,api,operation){
  const {handler}=route(controller,node,api),name=trapName(operation),
    selected=api.resolveProperty(controller,node.handler[1],['str',name],{forHas:true}).descriptor;
  api.require(!selected||selected.kind==='data','Proxy trap accessor requires its explicit getter boundary');
  return selected?.value??['undefined'];
}
export function selectProxyTrapV8(controller,handlerRef,operation,api){
  const handler=ordinary(controller,handlerRef,api,'Proxy handler'),name=trapName(operation),
    descriptor=api.resolveProperty(controller,handlerRef[1],['str',name],{forHas:true}).descriptor;
  return {descriptor:descriptor?api.copy(descriptor):null,
    value:descriptor?.kind==='data'?api.copy(descriptor.value):null,
    getter:descriptor?.kind==='accessor'?api.copy(descriptor.get):null};
}
export function deriveProxyRouteV8(controller,object,operation,api){
  const result=deriveRoute(controller,object,operation,api);
  return {route:api.copy(result.rows),owner:result.owner,target:api.copy(result.target),
    handler:result.rows.length?api.copy(result.rows.at(-1).handler):null,
    method:api.copy(result.selected),terminal:result.terminal};
}
export function validateRetainedProxyRouteV8(controller,row,api,options){
  return retainedRoute(controller,row,api,options);
}
function deriveRoute(controller,object,operation,api){
  const rows=[],visited=new Set();let identity=object,node=controller.heap.get(identity),target=null,owner=null,selected=['undefined'];
  while(node?.kind==='proxy'){
    api.require(!visited.has(identity)&&rows.length<64,'Proxy target route cycle/bound');visited.add(identity);
    api.require(!api.eq(node.target,['null'])&&!api.eq(node.handler,['null']),'Proxy route is revoked and requires its derived abrupt record');
    const found=method(controller,node,api,operation),entry={object:identity,target:api.copy(node.target),
      handler:api.copy(node.handler),method:api.copy(found)};
    rows.push(entry);target=api.copy(node.target);owner=identity;selected=found;
    if(!['undefined','null'].includes(found[0]))break;
    identity=target[1];node=controller.heap.get(identity);
  }
  api.require(node&&['object','array','proxy'].includes(node.kind),'Proxy target requires its internal method boundary');
  return {rows,owner,target,selected,terminal:node};
}
function retainedRoute(controller,row,api,{selectedTrap=true}={}){
  validateRouteSnapshot(row.route,v=>api.known(controller,v));
  api.require(row.route[0].object===row.object&&row.route.at(-1).object===row.owner,
    'Proxy retained route endpoints');
  for(let index=0;index<row.route.length;index++){
    const entry=row.route[index],node=controller.heap.get(entry.object);
    api.require(node?.kind==='proxy'&&(
      api.eq(node.target,['null'])&&api.eq(node.handler,['null'])||
      api.eq(node.target,entry.target)&&api.eq(node.handler,entry.handler)),
      'Proxy retained route target/handler identities');
    api.known(controller,entry.method);
    if(index<row.route.length-1){
      api.require(['undefined','null'].includes(entry.method[0])&&entry.target[0]==='ref'&&
        entry.target[1]===row.route[index+1].object,'Proxy retained transparent route edge');
    }else if(selectedTrap)api.require(!['undefined','null'].includes(entry.method[0]),
      'Proxy retained route has no selected trap');
  }
  return controller.heap.get(row.route.at(-1).target[1]);
}
function state(controller,api){return api.state(controller).proxyCalls??={schema:PROXY_STATE_V8_SCHEMA,pending:[],getMethods:[]};}
function removeOwn(target,key,api){
  const wanted=key[0]==='symbol'?symbolPropertyKey(key[1]):stringPropertyKey(key[1]);
  const match=map=>{for(const stored of map?.keys?.()??[])if(api.eq(stored,wanted))return stored;return undefined;};
  const property=match(target.properties),descriptor=match(target.descriptors);
  if(property!==undefined)target.properties.delete(property);
  if(descriptor!==undefined)target.descriptors.delete(descriptor);
  if(target.keyOrder)target.keyOrder=target.keyOrder.filter(stored=>!api.eq(stored,wanted));
}
const argumentsFor=row=>[row.target,row.key,...(row.operation==='set'?[row.value]:[]),
  ...(['get','set'].includes(row.operation)?[row.receiver]:[])];
function displayPropertyKey(controller,key){
  if(key[0]==='str')return key[1];
  if(key[0]==='symbol'){
    const id=key[1];let description;
    if(id.startsWith('well-known:'))description='Symbol.'+id.slice('well-known:'.length);
    else{
      const row=controller.protocol?.symbols?.find(symbol=>symbol.id===id);
      description=row?.description?.[0]==='str'?row.description[1]:'';
    }
    return 'Symbol('+description+')';
  }
  throw new TypeError('Proxy delete key display');
}
function strictDeleteMessage(controller,key){
  return "'deleteProperty' on proxy: trap returned falsish for property '"+displayPropertyKey(controller,key)+"'";
}
function strictSetMessage(controller,key){
  return "'set' on proxy: trap returned falsish for property '"+displayPropertyKey(controller,key)+"'";
}
function directDeleteMessage(controller,targetRef,key){
  const target=controller.heap.get(targetRef?.[1]),
    brand=target?.kind==='array'?'[object Array]':target?.prototype===null?'[object Object]':'#<Object>';
  return "Cannot delete property '"+displayPropertyKey(controller,key)+"' of "+brand;
}
function proxyFaultMessage(controller,pending,api){
  const node=controller.heap.get(pending.target[1]),completion=controller.lastReturn,
    descriptor=api.ownDescriptor(node,pending.key),truth=api.truthy(completion.value);
  if(pending.operation==='has'&&!truth&&descriptor&&
    (descriptor.configurable===false||node.extensible===false)){
    const display=displayPropertyKey(controller,pending.key);
    return descriptor.configurable===false?
      "'has' on proxy: trap returned falsish for property '"+display+
        "' which exists in the proxy target as non-configurable":
      "'has' on proxy: trap returned falsish for property '"+display+
        "' but the proxy target is not extensible";
  }
  if(pending.operation==='delete'&&truth&&descriptor&&
    (descriptor.configurable===false||node.extensible===false)){
    const display=displayPropertyKey(controller,pending.key);
    return descriptor.configurable===false?
      "'deleteProperty' on proxy: trap returned truish for property '"+display+
        "' which is non-configurable in the proxy target":
      "'deleteProperty' on proxy: trap returned truish for property '"+display+
        "' but the proxy target is non-extensible";
  }
  if(pending.operation==='delete'&&pending.strict&&!truth)
    return strictDeleteMessage(controller,pending.key);
  if(pending.operation==='set'&&pending.strict&&!truth)
    return strictSetMessage(controller,pending.key);
  if(['get','set'].includes(pending.operation)&&descriptor&&!descriptor.configurable){
    if(pending.operation==='set'&&!truth)return null;
    if(descriptor.kind==='data'&&!descriptor.writable&&
      !api.eq(descriptor.value,pending.operation==='get'?completion.value:pending.value))
      return 'Proxy '+pending.operation+' trap contradicted a non-configurable, non-writable target property';
    if(descriptor.kind==='accessor'&&
      (pending.operation==='set'?descriptor.set[0]==='undefined':
        descriptor.get[0]==='undefined'&&completion.value[0]!=='undefined'))
      return 'Proxy '+pending.operation+' trap contradicted a non-configurable target accessor';
  }
  return null;
}
export function assertProxyNextV8(controller,record,api){
  const proxyState=controller.protocol?.proxyCalls,lookup=proxyState?.getMethods?.at(-1),
    propertyCall=lookup&&controller.protocol?.pendingCalls?.find(row=>row.id===lookup.id);
  if(lookup?.phase==='selected'){
    if(!controller.frameFunctions.has(lookup.child))
      api.require(record.kind==='property.get.call'&&record.id===lookup.id&&record.child===lookup.child&&
        record.object===lookup.handler[1]&&api.eq(record.key,['str','has'])&&api.eq(record.receiver,lookup.receiver),
        'Proxy GetMethod selection requires its exact handler getter call');
    else if(propertyCall&&!controller.stack.includes(lookup.child))
      api.require(record.kind==='property.finish'&&record.id===lookup.id,
        'Proxy GetMethod getter completion requires property.finish');
    else if(!propertyCall&&!controller.stack.includes(lookup.child))
      api.require(record.kind==='proxy.getMethod.finish'&&record.id===lookup.id,
        'Proxy GetMethod property completion requires its retained finish');
  }else if(lookup?.phase==='returned'){
    const expected=lookup.method[0]==='undefined'?'proxy.has':'proxy.has.call';
    api.require(record.kind===expected&&record.id===lookup.id,
      'Proxy GetMethod result requires its matching has operation');
  }
  const pending=proxyState?.pending.at(-1);
  if(pending&&!controller.stack.includes(pending.child))
    api.require(['proxy.finish','proxy.fault'].includes(record.kind)&&record.id===pending.id,
      'pending Proxy callback requires its finish or derived fault');
  return true;
}
export function applyProxyRecordV8(controller,record,api){
  if(!PROXY_RECORD_FIELDS[record.kind])return false;
  if(record.kind==='proxy.revoke'){
    const node=controller.heap.get(record.object);api.require(node?.kind==='proxy','known Proxy identity required');
    if(!api.eq(node.target,['null'])&&!api.eq(node.handler,['null'])){
      node.target=['null'];node.handler=['null'];
    }
    state(controller,api);return true;
  }
  if(record.kind==='proxy.getMethod.begin'){
    const proxyState=state(controller,api),node=controller.heap.get(record.object);
    api.require(proxyState.getMethods.length<64&&!proxyState.getMethods.some(row=>row.id===record.id)&&
      !proxyState.pending.some(row=>row.id===record.id)&&!controller.protocol.pendingCalls.some(row=>row.id===record.id),
      'Proxy GetMethod identity or bound');
    api.require(node?.kind==='proxy'&&api.eq(node.target,record.target)&&api.eq(node.handler,record.handler),
      'Proxy GetMethod requires the live selected target and handler');
    ordinary(controller,record.target,api,'Proxy GetMethod target');
    const handler=ordinary(controller,record.handler,api,'Proxy GetMethod handler'),
      descriptor=api.ownDescriptor(handler,['str','has']);
    api.knownKey(controller,record.key);api.known(controller,record.receiver);api.known(controller,record.getter);
    api.require(api.eq(record.receiver,record.handler)&&descriptor?.kind==='accessor'&&
      api.eq(descriptor.get,record.getter)&&record.getter[0]==='ref'&&
      api.heapNode(controller,record.getter[1]).kind==='closure',
      'Proxy GetMethod must retain its exact own getter and handler receiver');
    api.require(!controller.frameFunctions.has(record.child)&&controller.stack.length>0,
      'Proxy GetMethod getter child is not fresh');
    proxyState.getMethods.push({id:record.id,phase:'selected',operation:record.operation,parent:controller.stack.at(-1),
      child:record.child,object:record.object,target:api.copy(record.target),handler:api.copy(record.handler),
      receiver:api.copy(record.receiver),key:api.copy(record.key),getter:api.copy(record.getter),rawReturn:null,method:null});
    return true;
  }
  if(record.kind==='proxy.getMethod.finish'){
    const proxyState=state(controller,api),lookup=proxyState.getMethods.at(-1),returned=controller.lastReturn;
    api.require(lookup?.id===record.id&&lookup.phase==='selected'&&controller.stack.at(-1)===lookup.parent&&
      !controller.stack.includes(lookup.child)&&controller.frameFunctions.has(lookup.child)&&
      !controller.protocol.pendingCalls.some(row=>row.id===lookup.id)&&returned&&['return','throw'].includes(returned.kind),
      'Proxy GetMethod finish lacks its exact returned getter call');
    const expected={kind:returned.kind==='throw'?'throw':'normal',value:api.copy(returned.value)};
    api.require(api.eq(record.completion,expected),'false Proxy GetMethod completion');
    if(returned.kind==='throw'){proxyState.getMethods.pop();return true;}
    let method;
    if(['undefined','null'].includes(returned.value[0]))method=['undefined'];
    else{
      api.require(returned.value[0]==='ref'&&api.heapNode(controller,returned.value[1]).kind==='closure',
        'non-callable Proxy GetMethod result is outside the bounded profile');
      method=api.copy(returned.value);
    }
    lookup.phase='returned';lookup.rawReturn=api.copy(returned.value);lookup.method=method;return true;
  }
  if(record.kind==='proxy.revoked.fault'){
    const node=controller.heap.get(record.object);api.require(node?.kind==='proxy'&&
      api.eq(node.target,['null'])&&api.eq(node.handler,['null']),'revoked Proxy fault requires both cleared internal slots');
    api.fresh(controller,record.error);
    const value=allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',
      message:"Cannot perform '"+record.operation+"' on a proxy that has been revoked"},api);
    controller.lastReturn={kind:'throw',value};return true;
  }
  if(record.kind==='proxy.delete.fault'){
    const node=controller.heap.get(record.object);api.require(node?.kind==='proxy','known Proxy identity required');
    api.knownKey(controller,record.key);
    const derived=deriveRoute(controller,record.object,'delete',api);
    api.require(api.eq(record.route,derived.rows)&&['undefined','null'].includes(derived.selected[0]),
      'direct strict delete fault requires an absent trap on the retained route');
    const target=ordinary(controller,derived.target,api,'Proxy target'),descriptor=api.ownDescriptor(target,record.key);
    api.require(descriptor&&descriptor.configurable===false,'direct strict delete fault requires a live non-configurable target property');
    api.fresh(controller,record.error);
    const value=allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',
      message:directDeleteMessage(controller,derived.target,record.key)},api);
    controller.lastReturn={kind:'throw',value};return true;
  }
  if(record.kind==='proxy.fault'){
    const pending=state(controller,api).pending.at(-1);
    api.require(pending?.id===record.id&&controller.stack.at(-1)===pending.parent&&
      !controller.stack.includes(pending.child)&&controller.lastReturn?.kind==='return',
      'Proxy fault lacks its normal callback completion');
    const message=proxyFaultMessage(controller,pending,api);
    api.require(message!==null,'Proxy fault is not derived from the retained operation');
    api.fresh(controller,record.error);
    const value=allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',message},api);
    controller.lastReturn={kind:'throw',value};state(controller,api).pending.pop();return true;
  }
  if(record.kind==='proxy.finish'){
    const pending=state(controller,api).pending.at(-1),completion=controller.lastReturn;
    api.require(pending?.id===record.id&&controller.stack.at(-1)===pending.parent&&!controller.stack.includes(pending.child)&&
      ['return','throw'].includes(completion?.kind),'Proxy finish lacks its callback completion');
    const node=controller.heap.get(pending.object);api.require(node?.kind==='proxy','known Proxy identity required');
    const target=retainedRoute(controller,pending,api);
    let expected={kind:'throw',value:completion.value};
    if(completion.kind==='return'){
      api.require(proxyFaultMessage(controller,pending,api)===null,
        'Proxy operation requires its derived abrupt boundary');
      const truth=api.truthy(completion.value),descriptor=api.ownDescriptor(target,pending.key);
      if(pending.operation==='set')api.require(truth||!pending.strict,'strict false Proxy set trap needs its caller fault');
      if(pending.operation==='has'&&!truth&&descriptor){
        api.require(descriptor.configurable===true&&target.extensible!==false,'Proxy has trap violates target invariant');
      }else if(pending.operation==='delete'&&truth&&descriptor){
        api.require(descriptor.configurable===true&&target.extensible!==false,'Proxy delete trap violates target invariant');
      }else if(['get','set'].includes(pending.operation)&&descriptor&&!descriptor.configurable){
        if(descriptor.kind==='data'&&!descriptor.writable)
          api.require(api.eq(descriptor.value,pending.operation==='get'?completion.value:pending.value),
            'Proxy trap violates frozen target data invariant');
        else if(descriptor.kind==='accessor')
          api.require(pending.operation==='get'&&(descriptor.get[0]!=='undefined'||completion.value[0]==='undefined')||
            pending.operation==='set'&&descriptor.set[0]!=='undefined','Proxy trap violates target accessor invariant');
      }
      const value=['has','delete'].includes(pending.operation)?['bool',truth]:
        pending.operation==='get'?completion.value:pending.value;
      expected={kind:'normal',value};
    }
    api.require(api.eq(record.completion,expected),'false Proxy callback completion');
    state(controller,api).pending.pop();return true;
  }
  if(record.kind==='proxy.create'){
    api.fresh(controller,record.name);const node={kind:'proxy',target:api.copy(record.target),handler:api.copy(record.handler),properties:new Map()};
    route(controller,node,api);controller.heap.set(record.name,node);state(controller,api);return true;
  }
  if(record.kind==='proxy.revocable'){
    api.fresh(controller,record.proxy);api.fresh(controller,record.revoke);api.fresh(controller,record.result);
    const node={kind:'proxy',target:api.copy(record.target),handler:api.copy(record.handler),properties:new Map()};
    route(controller,node,api);
    const revoker={kind:'closure',code:'Proxy.revoke:'+record.proxy,captures:[],functionKind:'ordinary',
      lexicalReceiver:null,prototype:'ordinary',properties:new Map([['length',['num',0]],['name',['str','']]]),
      descriptors:new Map([['length',{kind:'data',writable:false,enumerable:false,configurable:true}],
        ['name',{kind:'data',writable:false,enumerable:false,configurable:true}]]),keyOrder:['length','name']};
    const result={kind:'object',prototype:'ordinary',properties:new Map([
      ['proxy',['ref',record.proxy]],['revoke',['ref',record.revoke]]])};
    controller.heap.set(record.proxy,node);controller.heap.set(record.revoke,revoker);
    controller.heap.set(record.result,result);state(controller,api);return true;
  }
  const node=controller.heap.get(record.object);api.require(node?.kind==='proxy','known Proxy identity required');
  api.knownKey(controller,record.key);
  const operation=record.kind.split('.')[1],proxyState=state(controller,api),
    lookup=(operation==='has'&&typeof record.id==='string')?
      proxyState.getMethods.find(row=>row.id===record.id):null;
  let derived;
  if(lookup){
    api.require(lookup.phase==='returned'&&lookup.operation==='has'&&lookup.object===record.object&&
      api.eq(lookup.key,record.key)&&controller.lastReturn?.kind==='return'&&
      api.eq(controller.lastReturn.value,lookup.rawReturn),
      'Proxy has differs from its retained GetMethod result');
    const proxyNode=controller.heap.get(lookup.object);
    api.require(proxyNode?.kind==='proxy'&&(
      api.eq(proxyNode.target,['null'])&&api.eq(proxyNode.handler,['null'])||
      api.eq(proxyNode.target,lookup.target)&&api.eq(proxyNode.handler,lookup.handler)),
      'Proxy GetMethod lost its retained target or handler');
    const rows=[{object:lookup.object,target:api.copy(lookup.target),handler:api.copy(lookup.handler),method:api.copy(lookup.method)}];
    derived={rows,owner:lookup.object,target:api.copy(lookup.target),handler:api.copy(lookup.handler),
      selected:api.copy(lookup.method),terminal:controller.heap.get(lookup.target[1])};
  }else{
    if(record.kind==='proxy.has'&&Object.hasOwn(record,'id'))
      api.require(false,'Proxy has lookup identity is not retained');
    derived=deriveRoute(controller,record.object,operation,api);
  }
  const selected=derived.selected,targetRef=derived.target,handlerRef=derived.handler??derived.rows.at(-1).handler;
  api.require(api.eq(record.route,derived.rows),'Proxy operation route differs from live entry lookup');
  if(record.kind.endsWith('.call')){
    const pending=proxyState.pending;
    api.require(pending.length<64&&!pending.some(row=>row.id===record.id),'Proxy pending call identity/bound');
    api.require(record.owner===derived.owner&&api.eq(record.receiver,['ref',record.object]),
      'Proxy original receiver or trap owner differs');
    api.require(selected[0]==='ref'&&api.heapNode(controller,selected[1]).kind==='closure','Proxy call requires a live owned trap');
    ordinary(controller,targetRef,api,'Proxy trap target invariant boundary');
    if(operation==='set')api.known(controller,record.value);
    const strict=['delete','set'].includes(operation)?record.strict:false,
      row={id:record.id,operation,parent:controller.stack.at(-1),child:record.child,object:record.object,
      owner:derived.owner,receiver:api.copy(record.receiver),route:api.copy(derived.rows),
      target:api.copy(targetRef),handler:api.copy(handlerRef),key:api.copy(record.key),value:operation==='set'?api.copy(record.value):null,
      callee:api.copy(selected),strict};
    api.call(controller,{child:row.child,callee:row.callee,receiver:row.handler,arguments:argumentsFor(row)});
    pending.push(row);if(lookup)proxyState.getMethods.pop();return true;
  }
  api.require(['undefined','null'].includes(selected[0]),'Proxy trap requires its explicit call boundary');
  ordinary(controller,targetRef,api,'Proxy target');
  if(record.kind==='proxy.has'){
    const found=api.resolveProperty(controller,targetRef[1],record.key,{forHas:true});
    api.require(api.eq(record.result,['bool',found.descriptor!==null]),'false Proxy existence result');
    if(lookup)proxyState.getMethods.pop();
  }else if(record.kind==='proxy.delete'){
    const descriptor=api.ownDescriptor(controller.heap.get(targetRef[1]),record.key),
      success=!descriptor||descriptor.configurable===true;
    api.require(record.success===success,'false Proxy deletion result');
    if(success)removeOwn(route(controller,node,api).target,record.key,api);
  }else if(record.kind==='proxy.get'){
    const found=api.resolveProperty(controller,targetRef[1],record.key);
    api.require(!found.descriptor||found.descriptor.kind==='data','Proxy getter requires its call boundary');
    const expected=found.descriptor?.value??['undefined'];api.known(controller,record.result);
    api.require(api.eq(record.result,expected),'false Proxy data read');
  }else{
    api.known(controller,record.value);
    // A proxy [[Set]] with no set trap reaches the proxy receiver's
    // [[GetOwnProperty]] and [[DefineOwnProperty]] methods. Forwarding both
    // straight to the target is valid only when those two traps are absent.
    for(const entry of derived.rows)for(const trap of ['getOwnPropertyDescriptor','defineProperty']){
      const selectedDescriptor=api.resolveProperty(controller,entry.handler[1],['str',trap],{forHas:true}).descriptor;
      api.require(!selectedDescriptor||selectedDescriptor.kind==='data'&&
        ['undefined','null'].includes(selectedDescriptor.value[0]),
        'Proxy transparent set requires its receiver descriptor/definition call boundary');
    }
    api.require(derived.rows.length===1,'nested transparent set receiver methods require their call boundary');
    const success=api.directSet(controller,{object:targetRef[1],receiver:targetRef,key:record.key,value:record.value});
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
  for(const [identity,node]of controller.heap)if(node.kind==='proxy'&&!api.eq(node.target,['null'])){
    const visited=new Set([identity]);let target=controller.heap.get(node.target[1]);
    while(target?.kind==='proxy'){
      api.require(!visited.has(target.id),'Proxy target graph contains a cycle');visited.add(target.id);
      target=controller.heap.get(target.target?.[1]);
    }
  }
  if(snapshot===null){api.require(!count,'Proxy heap lacks its declared call state');return {valid:true,proxies:0,calls:0,lookups:0};}
  assertAlgorithmFields(snapshot,['schema','pending','getMethods'],'Proxy call state');
  api.require(snapshot.schema===PROXY_STATE_V8_SCHEMA,'Proxy call state schema');
  assertAlgorithmDataArray(snapshot.pending,'pending Proxy calls');api.require(snapshot.pending.length<=64,'Proxy call bound');
  assertAlgorithmDataArray(snapshot.getMethods,'pending Proxy GetMethod calls');
  api.require(snapshot.getMethods.length<=64,'Proxy GetMethod call bound');
  const seen=new Set();let priorDepth=-1;
  for(const row of snapshot.pending){
    assertAlgorithmFields(row,PROXY_CALL_FIELDS,'Proxy pending call');
    for(const identity of [row.id,row.parent,row.child,row.object,row.owner])id(identity);
    api.require(!seen.has(row.id)&&['get','set','has','delete'].includes(row.operation),'Proxy pending call identity');seen.add(row.id);
    const node=controller.heap.get(row.object);api.require(node?.kind==='proxy'&&
      row.route?.[0]?.object===row.object&&row.route.at(-1)?.object===row.owner,
      'Proxy pending route identities');
    retainedRoute(controller,row,api);
    const ownerNode=controller.heap.get(row.owner),ownerRevoked=ownerNode?.kind==='proxy'&&
      api.eq(ownerNode.target,['null'])&&api.eq(ownerNode.handler,['null']);
    api.require(api.eq(row.target,row.route.at(-1).target)&&api.eq(row.handler,row.route.at(-1).handler)&&
      (ownerRevoked||api.eq(ownerNode?.handler,row.handler)),'Proxy pending target/handler identities');
    api.known(controller,row.receiver);api.require(api.eq(row.receiver,['ref',row.object]),'Proxy retained receiver differs from original operation');

    api.require(typeof row.strict==='boolean'&&(['delete','set'].includes(row.operation)||row.strict===false),
      'Proxy pending strict-delete context');
    api.knownKey(controller,row.key);api.known(controller,row.callee);
    const callee=api.heapNode(controller,row.callee[1]);
    api.require(row.callee[0]==='ref'&&callee.kind==='closure'&&controller.frameFunctions.get(row.child)===callee.code&&
      controller.frameFunctions.has(row.parent),'Proxy pending callback source identity');
    if(row.operation==='get'||row.operation==='has'||row.operation==='delete')
      api.require(row.value===null,'Proxy operation has no assignment operand');
    else api.known(controller,row.value);
    const defaultReceiver=callee.functionKind==='arrow'?callee.lexicalReceiver:row.handler,
      selectedReceiver=constructionCallReceiverV8(controller,row.callee,defaultReceiver,api)??defaultReceiver;
    api.require(api.eq(controller.locals.get(row.child+':this'),selectedReceiver),
      'Proxy callback retained receiver');
    if(controller.stack.includes(row.child)){
      const depth=controller.stack.indexOf(row.child);
      api.require(depth===controller.stack.indexOf(row.parent)+1&&depth>priorDepth,'Proxy callback stack relationship/order');
      priorDepth=depth;
      const call=controller.protocol.callFrames.find(call=>call.child===row.child);
      api.require(call&&api.eq(call.callee,row.callee)&&api.eq(call.arguments,argumentsFor(row)),
        'Proxy callback retained callee/arguments');
    }else api.require(row===snapshot.pending.at(-1)&&controller.stack.at(-1)===row.parent&&
      ['return','throw'].includes(controller.lastReturn?.kind),'Proxy finished callback owner');
  }
  for(const lookup of snapshot.getMethods){
    assertAlgorithmFields(lookup,PROXY_GET_METHOD_FIELDS,'Proxy GetMethod call');
    for(const identity of [lookup.id,lookup.parent,lookup.child,lookup.object])id(identity);
    api.require(!seen.has(lookup.id)&&lookup.operation==='has'&&['selected','returned'].includes(lookup.phase),
      'Proxy GetMethod identity or phase');seen.add(lookup.id);
    const node=controller.heap.get(lookup.object);
    api.require(node?.kind==='proxy'&&(
      api.eq(node.target,['null'])&&api.eq(node.handler,['null'])||
      api.eq(node.target,lookup.target)&&api.eq(node.handler,lookup.handler)),
      'Proxy GetMethod lost its retained Proxy target/handler');
    ordinary(controller,lookup.target,api,'Proxy GetMethod target');
    const handler=ordinary(controller,lookup.handler,api,'Proxy GetMethod handler');
    api.known(controller,lookup.receiver);api.require(api.eq(lookup.receiver,lookup.handler),
      'Proxy GetMethod getter receiver differs from its handler');
    api.knownKey(controller,lookup.key);api.known(controller,lookup.getter);
    api.require(lookup.getter[0]==='ref','Proxy GetMethod getter identity');
    const getter=api.heapNode(controller,lookup.getter[1]),
      pendingCall=controller.protocol.pendingCalls.find(row=>row.id===lookup.id);
    api.require(getter.kind==='closure'&&controller.frameFunctions.has(lookup.parent),
      'Proxy GetMethod getter source identity');
    const childActive=controller.frameFunctions.has(lookup.child);
    if(!childActive){
      api.require(api.eq(node.target,lookup.target)&&api.eq(node.handler,lookup.handler),
        'Proxy GetMethod selection cannot be revoked before its getter call');
      api.require(lookup.phase==='selected'&&!pendingCall&&!controller.stack.includes(lookup.child)&&
        controller.stack.at(-1)===lookup.parent&&lookup.rawReturn===null&&lookup.method===null,
        'Proxy GetMethod selection is not awaiting its exact getter call');
      const descriptor=api.ownDescriptor(handler,['str','has']);
      api.require(descriptor?.kind==='accessor'&&api.eq(descriptor.get,lookup.getter),
        'Proxy GetMethod selected accessor differs from the live handler getter');
    }else{
      api.require(controller.frameFunctions.get(lookup.child)===getter.code,
        'Proxy GetMethod getter invocation source differs');
      const effectiveReceiver=constructionCallReceiverV8(controller,lookup.getter,lookup.receiver,api)??lookup.receiver;
      api.require(api.eq(controller.locals.get(lookup.child+':this'),effectiveReceiver),
        'Proxy GetMethod getter receiver activation');
      if(pendingCall){
        api.require(lookup.phase==='selected'&&lookup.rawReturn===null&&lookup.method===null&&
          pendingCall.operation==='get'&&pendingCall.child===lookup.child&&
          pendingCall.object===lookup.handler[1]&&api.eq(pendingCall.key,['str','has'])&&
          api.eq(pendingCall.receiver,lookup.receiver)&&api.eq(pendingCall.callee,lookup.getter)&&
          pendingCall.parent===lookup.parent&&pendingCall.value===null,
          'Proxy GetMethod differs from its shared property getter call');
        const call=controller.protocol.callFrames.find(frame=>frame.child===lookup.child);
        if(call)api.require(api.eq(call.callee,lookup.getter)&&call.parent===lookup.parent&&
          api.eq(call.arguments,[]),'Proxy GetMethod active getter call frame differs');
        if(controller.stack.includes(lookup.child))api.require(controller.stack.indexOf(lookup.child)>
          controller.stack.indexOf(lookup.parent),'Proxy GetMethod getter stack order');
        else api.require(controller.stack.at(-1)===lookup.parent&&
          ['return','throw'].includes(controller.lastReturn?.kind),'Proxy GetMethod getter has no returned completion');
      }else if(lookup.phase==='selected'){
        api.require(!controller.stack.includes(lookup.child)&&controller.stack.at(-1)===lookup.parent&&
          ['return','throw'].includes(controller.lastReturn?.kind)&&lookup.rawReturn===null&&lookup.method===null,
          'Proxy GetMethod property completion is not retained');
      }else{
        api.require(!controller.stack.includes(lookup.child)&&controller.stack.at(-1)===lookup.parent&&
          controller.lastReturn?.kind==='return'&&api.eq(controller.lastReturn.value,lookup.rawReturn),
          'Proxy GetMethod returned value differs from its retained completion');
        const method=['undefined','null'].includes(lookup.rawReturn?.[0])?['undefined']:lookup.rawReturn;
        api.require(lookup.rawReturn!==null&&api.eq(lookup.method,method)&&
          (method[0]==='undefined'||method[0]==='ref'&&api.heapNode(controller,method[1]).kind==='closure'),
          'Proxy GetMethod method identity differs from its raw return');
      }
    }
  }
  return {valid:true,proxies:count,calls:snapshot.pending.length,lookups:snapshot.getMethods.length};
}
export const hasProxyStateV8=node=>node?.kind==='proxy';
