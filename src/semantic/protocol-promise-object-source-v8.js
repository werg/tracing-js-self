// Source correspondence for Promise ordinary state. These operations use the
// same public heap, descriptors and accessor calls as ordinary objects.
import {isDeepStrictEqual as eq} from 'node:util';
import {propertyKeyValue,stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
import {descriptor,orderedKeys} from './protocol-source-shapes-v8.js';
import {describeProtocolObjectV8} from './protocol-state-v8.js';
import {isPromiseIntrinsicValueV8,promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';
import {sourceHasSyntaxV8} from './source-projection-base-v8.js';
import {sharedProtocolSourceEventV8} from './protocol-source-claims-v8.js';

export const PROMISE_OBJECT_SOURCE_V8='promise-object-source/1';
const copy=structuredClone,select=value=>value?.[0]==='method'?value[1]:value;
const objectCalls=new Set(['Object.defineProperty','Object.getOwnPropertyDescriptor','Object.hasOwn',
  'Object.prototype.hasOwnProperty','Object.setPrototypeOf','Object.getPrototypeOf',
  'Object.preventExtensions','Object.isExtensible','Object.create','Object.keys',
  'Object.getOwnPropertyNames','Object.getOwnPropertySymbols','Reflect.ownKeys']);
const nodeFor=(state,value)=>value?.[0]==='promise'?state.promises[value[1]]:
  value?.[0]==='ref'||value?.[0]==='intrinsic'&&value[1]==='Promise.prototype'?state.heap[value[1]]:null;
const rich=node=>node&&(['promise'].includes(node.kind)||Object.keys(node.accessors??{}).length||
  Object.keys(node.dataAttributes??{}).length||node.extensible===false||
  node.prototype!==undefined&&!['Object.prototype','Array.prototype','Function.prototype'].includes(node.prototype));
const intrinsicPrototype=value=>value?.[0]==='intrinsic'&&['Promise.prototype','Object.prototype'].includes(value[1]);
function method(event){const callable=select(event.operands?.[0]);return callable?.[0]==='builtinfn'?callable[1]:null;}
export function promiseObjectSourceEventV8(view,{event,row}){
  if(!view.components[PROMISE_OBJECT_SOURCE_V8])return false;
  const pending=view.components[PROMISE_OBJECT_SOURCE_V8].accessors??[],base=event.operands?.[0];
  if(event.operation==='call.enter'&&objectCalls.has(method(event)))return true;
  if(['property.read','property.write','property.update'].includes(event.operation)){
    if(intrinsicPrototype(base)||base?.[0]==='promise')return true;
    if(rich(nodeFor(view.owned,base))&&!sharedProtocolSourceEventV8(view,{event,row}))return true;
    if(base?.[0]==='intrinsic'&&['Promise','Object'].includes(base[1])&&event.operands?.[1]?.[1]==='prototype')return true;
  }
  return Boolean(row?.child&&event.stateChanges.some(change=>change.table==='frames'&&change.id===row.child&&
    change.after?.promiseConstructorLookup));
}
export function promiseObjectSourceAllocationV8(view,input){
  return Boolean(view.components[PROMISE_OBJECT_SOURCE_V8]&&input.identity==='Promise.prototype');
}
export function promiseObjectSourceCompletionV8(view,exit){
  return ['return','throw','unhandled-throw'].includes(exit.operation)&&
    (view.components[PROMISE_OBJECT_SOURCE_V8]?.accessors??[]).some(([frame])=>frame===exit.invocation);
}
function key(value){
  if(value?.[0]==='symbol')return copy(value);
  if(value?.[0]==='str')return copy(value);
  if(['num','bool','null','undefined'].includes(value?.[0]))return ['str',String(value.length===1?
    value[0]==='null'?null:undefined:value[1])];
  throw new TypeError('Promise object source: observable key conversion requires its own protocol');
}
const storage=value=>value[0]==='symbol'?symbolPropertyKey(value[1]):stringPropertyKey(value[1]);
function projectedDescriptor(ctx,node,property){const d=descriptor(node,property);if(!d)return null;
  return d.kind==='data'?{...d,value:ctx.tag(d.value)}:{...d,get:ctx.tag(d.get),set:ctx.tag(d.set)};}
function projectedPrototype(ctx,node){const p=node.prototype;
  if(p===null)return null;
  if(['Promise.prototype','Object.prototype'].includes(p))return ['ref',promiseIntrinsicIdV8(p)];
  if(p===undefined||['Array.prototype','Function.prototype'].includes(p))return 'ordinary';
  return ['ref',ctx.identity(p)];
}
export function createPromiseObjectTeacherV8(){
  function initialize(ctx,event){const owner=ctx.rootFor(event?.invocationId),controller=ctx.controller(owner);
    if(!controller.protocol?.promiseObjects?.initialized)
      ctx.emitProtocol(owner,{kind:'promise.intrinsics'},event,'source-promise-intrinsics/1');
  }
  function parameters(ctx,event,child,owner){const frame=event.stateChanges.find(c=>c.table==='frames'&&c.id===child)?.after,
    env=event.stateChanges.find(c=>c.table==='envs'&&c.id===frame?.envId)?.after;
    for(const [name,binding]of Object.entries(env?.bindings??{}))if(binding.initialized)
      ctx.emit(owner,'bind',{name:ctx.cell(env.id,name),value:ctx.tag(binding.token.value)},event,'source-accessor-parameter');
  }
  function finish(ctx,event,exit){const state=ctx.componentState(PROMISE_OBJECT_SOURCE_V8),
    pending=state.accessors.find(([frame])=>frame===exit.invocation)?.[1];
    if(!pending)ctx.refuse('Promise accessor completion lacks its original receiver and call');
    if(pending.finished)return;
    const changed=event.stateChanges.find(c=>c.table==='frames'&&c.id===exit.invocation)?.after,
      completion=changed?.completion;
    if(!['return','throw'].includes(completion?.type))ctx.refuse('Promise accessor completion kind');
    const value=ctx.tag(completion.value.value),invocation=ctx.frameId(exit.invocation);
    ctx.emitProtocol(pending.owner,{kind:completion.type,invocation,value},event,'source-promise-accessor-return/1');
    ctx.emitProtocol(pending.owner,{kind:'property.finish',id:pending.id,completion:{kind:completion.type==='throw'?'throw':'normal',
      value:completion.type==='throw'||pending.operation==='get'?value:pending.value}},event,'source-promise-accessor-finish/1');
    pending.finished=true;
  }
  return {id:PROMISE_OBJECT_SOURCE_V8,
    initialize:()=>({sequence:0,accessors:[]}),
    claims:{value:(_view,value)=>isPromiseIntrinsicValueV8(value),allocation:promiseObjectSourceAllocationV8,
      event:promiseObjectSourceEventV8,completion:promiseObjectSourceCompletionV8},
    prepare:{value:(_view,value)=>({kind:'intrinsic-reference',value}),
      allocation:(_view,input)=>({kind:'intrinsic-prototype',identity:input.identity}),
      event:(_view,{event})=>({kind:'promise-object-event',event:event.eventId}),
      completion:(_view,exit)=>({kind:'promise-property-completion',invocation:exit.invocation})},
    tag(ctx,value){initialize(ctx,null);return ['ref',promiseIntrinsicIdV8(value[1])];},
    allocation(ctx,event,fields){if(fields.name!==promiseIntrinsicIdV8('Promise.prototype'))ctx.refuse('undeclared intrinsic allocation');
      initialize(ctx,event);return true;},
    beforeEvent(ctx,event){
      if(!event)return;
      const view={owned:ctx.state,components:{[PROMISE_OBJECT_SOURCE_V8]:ctx.componentState(PROMISE_OBJECT_SOURCE_V8)}};
      if(promiseObjectSourceEventV8(view,{event})||event.stateChanges.some(c=>c.table==='heap'&&c.id==='Promise.prototype'))initialize(ctx,event);
      // A getter can synchronously create a reaction or begin an await when it
      // returns. Finish its checked property call before publishing those jobs.
      for(const [frame,pending]of ctx.componentState(PROMISE_OBJECT_SOURCE_V8).accessors)
        if(!pending.finished&&event.stateChanges.some(c=>c.table==='frames'&&c.id===frame&&['completed','thrown'].includes(c.after?.status)))
          finish(ctx,event,{invocation:frame});
    },
    event(ctx,event,row){const owner=ctx.rootFor(event.invocationId),base=event.operands?.[0],
      raw=select(event.result),name=method(event),state=ctx.componentState(PROMISE_OBJECT_SOURCE_V8),
      child=event.stateChanges.find(c=>c.table==='frames'&&c.before===null&&c.after?.promiseConstructorLookup)?.after;
      if(child){
        const lookup=child.promiseConstructorLookup,receiver=ctx.tag(lookup.receiver),
          property=propertyKeyValue(lookup.property),id='promiseaccess'+(++state.sequence),invocation=ctx.registerFrame(child.id,owner);
        if(lookup.continuation.kind==='adopt')ctx.refuse('adoption constructor access requires its active intrinsic call scope');
        if(!eq(child.thisValue,lookup.receiver)||row?.child!==child.id)ctx.refuse('constructor getter receiver or child differs');
        ctx.emitProtocol(owner,{kind:'property.get.call',id,child:invocation,object:receiver[1],key:property,receiver},event,'source-promise-constructor-call/1');
        parameters(ctx,event,child.id,owner);state.accessors.push([child.id,{id,operation:'get',value:null,owner,finished:false,lookup:copy(lookup)}]);return true;
      }
      if(event.operation==='property.read'||event.operation==='property.write'){
        if(base?.[0]==='intrinsic'&&['Promise','Object'].includes(base[1])&&event.operands[1]?.[1]==='prototype'){
          ctx.emitProtocol(owner,{kind:'promise.intrinsic.get',base:base[1],key:['str','prototype'],result:ctx.tag(raw)},event,'source-intrinsic-prototype/1');return true;
        }
        const receiver=ctx.tag(base),property=key(event.operands[1]);
        if(receiver[0]!=='ref')ctx.refuse('ordinary property receiver required');
        if(row?.child){
          ctx.allocations(row,owner,event);
          const operation=event.operation==='property.read'?'get':'set',id='promiseaccess'+(++state.sequence),
            invocation=ctx.registerFrame(row.child,owner),value=operation==='set'?ctx.tag(event.operands[2]):null;
          ctx.emitProtocol(owner,{kind:'property.'+operation+'.call',id,child:invocation,object:receiver[1],key:property,receiver,
            ...(operation==='set'?{value}:{})},event,'source-promise-accessor-call/1');
          parameters(ctx,event,row.child,owner);state.accessors.push([row.child,{id,operation,value,owner,finished:false}]);return true;
        }
        if(event.operation==='property.read')ctx.emitProtocol(owner,{kind:'property.get',object:receiver[1],key:property,receiver,
          result:ctx.tag(raw)},event,'source-promise-property-read/1');
        else ctx.emitProtocol(owner,{kind:'property.set',object:receiver[1],key:property,receiver,value:ctx.tag(event.operands[2]),success:true},event,'source-promise-property-write/1');
        return true;
      }
      const args=event.operands.slice(1),target=args[0],object=ctx.tag(target)?.[1],
        changed=event.stateChanges.find(c=>['heap','promises'].includes(c.table)&&c.id===target?.[1])?.after,
        current=nodeFor(ctx.state,target);
      if(name==='Object.create'){
        const allocated=event.stateChanges.find(c=>c.table==='heap'&&c.before===null&&c.id===raw?.[1])?.after;
        if(raw?.[0]!=='ref'||allocated?.kind!=='object'||orderedKeys(allocated).length||
          args[1]&&args[1][0]!=='undefined')ctx.refuse('Object.create requires its declared empty ordinary allocation');
        const identity=ctx.identity(raw[1]),prototype=projectedPrototype(ctx,allocated),
          expected=target?.[0]==='null'?null:ctx.tag(target);
        if(!eq(prototype,expected))ctx.refuse('Object.create prototype differs from its original argument');
        ctx.emitProtocol(owner,{kind:'allocate',name:identity,objectKind:'object',length:null,
          properties:[],code:null,captures:[],functionKind:null,lexicalReceiver:null},event,'source-object-create-allocation/1');
        ctx.emitProtocol(owner,{kind:'property.prototype',object:identity,prototype,success:true},event,'source-object-create-prototype/1');
        ctx.claimDataIdentity(raw[1]);return true;
      }
      if(name==='Object.defineProperty'){
        const property=key(args[1]),after=changed??current;
        if(!after)ctx.refuse('property definition lacks its actual receiver state');
        const d=projectedDescriptor(ctx,after,storage(property));
        if(!d||!eq(raw,target))ctx.refuse('property definition did not complete on its original receiver');
        ctx.emitProtocol(owner,{kind:'property.define',object,key:property,descriptor:d,success:true},event,'source-promise-property-definition/1');return true;
      }
      if(name==='Object.hasOwn'){
        ctx.emitProtocol(owner,{kind:'property.hasOwn',object,key:key(args[1]),result:ctx.tag(raw)},event,'source-own-property/1');return true;
      }
      if(name==='Object.getOwnPropertyDescriptor'){
        const property=key(args[1]),d=projectedDescriptor(ctx,current,storage(property)),identity=raw?.[0]==='ref'?ctx.identity(raw[1]):null;
        ctx.emitProtocol(owner,{kind:'property.descriptor',object,key:property,descriptor:d,name:identity},event,'source-own-descriptor/1');
        if(identity)ctx.claimDataIdentity(raw[1]);return true;
      }
      if(name==='Object.getPrototypeOf'||name==='Object.isExtensible'){
        ctx.emitProtocol(owner,{kind:name==='Object.getPrototypeOf'?'property.getPrototypeOf':'property.isExtensible',object,
          result:ctx.tag(raw)},event,'source-object-reflection/1');return true;
      }
      if(name==='Object.setPrototypeOf'){
        if(!changed&&!current)ctx.refuse('prototype mutation lacks receiver storage');
        ctx.emitProtocol(owner,{kind:'property.prototype',object,prototype:projectedPrototype(ctx,changed??current),success:true},event,'source-object-prototype/1');return true;
      }
      if(name==='Object.preventExtensions'){
        ctx.emitProtocol(owner,{kind:'property.preventExtensions',object},event,'source-object-extensibility/1');return true;
      }
      if(['Object.keys','Object.getOwnPropertyNames','Object.getOwnPropertySymbols','Reflect.ownKeys'].includes(name)){
        const allocated=event.stateChanges.find(c=>c.table==='heap'&&c.id===raw?.[1])?.after;
        if(raw?.[0]!=='ref'||allocated?.kind!=='array')ctx.refuse('own keys requires its actual result array');
        const length=allocated.properties.length.value[1],keys=Array.from({length},(_,i)=>ctx.tag(allocated.properties[i].value)),
          mode={'Object.keys':'enumerable-strings','Object.getOwnPropertyNames':'strings','Object.getOwnPropertySymbols':'symbols','Reflect.ownKeys':'own'}[name];
        ctx.emitProtocol(owner,{kind:'property.keys',object,mode,name:ctx.identity(raw[1]),keys},event,'source-own-keys/1');
        ctx.claimDataIdentity(raw[1]);return true;
      }
      ctx.refuse('ordinary Promise reflection operation requires its source continuation: '+name);
    },
    completion(ctx,event,row,exit){finish(ctx,event,exit);
      const pending=ctx.componentState(PROMISE_OBJECT_SOURCE_V8).accessors.find(([frame])=>frame===exit.invocation)?.[1],
        continuation=pending?.lookup?.continuation;
      if(continuation?.kind==='await'){
        const parent=event.stateChanges.find(c=>c.table==='frames'&&c.id===continuation.frameId)?.after;
        if(parent?.status==='suspended')ctx.awaitFrame(parent.id,parent.awaiting,event);
      }
      return true;
    },
    checkEvent(ctx,event){const controller=ctx.controller(ctx.rootInvocation);
      if(!controller.protocol?.promiseObjects?.initialized)return true;
      for(const change of event.stateChanges)if(['heap','promises'].includes(change.table)&&change.after){
        const node=change.after,id=ctx.identity(change.id);
        if((change.table==='promises'||change.id==='Promise.prototype')&&controller.heap.has(id)){
          const actual=describeProtocolObjectV8(controller,id),expected={kind:change.table==='promises'?'promise':'object',
            prototype:projectedPrototype(ctx,node),extensible:node.extensible!==false,
            properties:orderedKeys(node).map(k=>({key:propertyKeyValue(k),descriptor:projectedDescriptor(ctx,node,k)}))};
          if(!eq(actual,expected))ctx.refuse('Promise descriptors/prototype differ from current owned state: '+change.id);
        }
      }
      return true;
    }
  };
}
export function createPromiseObjectSourceAdapterV8(input={}){
  if(!sourceHasSyntaxV8(input,node=>node.type==='Identifier'&&node.name==='Promise'||/Function/.test(node.type)&&node.async))return null;
  return {id:PROMISE_OBJECT_SOURCE_V8,sourceComponent:createPromiseObjectTeacherV8(),sourceProfile:PROMISE_OBJECT_SOURCE_V8};
}
