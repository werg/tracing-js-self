// Source correspondence for Promise ordinary state. These operations use the
// same public heap, descriptors and accessor calls as ordinary objects.
import {ERROR_CONSTRUCTORS,ERROR_PROTOTYPES} from '../owned-error-objects.js';
import {sourceInvalidInFaultV8} from './protocol-intrinsic-error-source-v8.js';
import {isDeepStrictEqual as eq} from 'node:util';
import {propertyKeyValue,stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
import {decode,encode} from '../values.js';
import {ordinaryGet} from '../spec-operations.js';
import {ownedObjectHeap} from '../owned-object-storage.js';
import {descriptor,orderedKeys} from './protocol-source-shapes-v8.js';
import {describeProtocolObjectV8} from './protocol-state-v8.js';
import {isPromiseIntrinsicValueV8,promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';
import {sourceHasSyntaxV8} from './source-projection-base-v8.js';
import {sharedProtocolSourceEventV8} from './protocol-source-claims-v8.js';
import {finishSourcePromiseAdoptionGetterV8} from './protocol-promise-adoption-source-v8.js';

export const PROMISE_OBJECT_SOURCE_V8='promise-object-source/1';
const copy=structuredClone,select=value=>value?.[0]==='method'?value[1]:value;
const objectCalls=new Set(['Function.prototype.hasInstance','Object.defineProperty','Object.getOwnPropertyDescriptor','Object.hasOwn',
  'Object.prototype.hasOwnProperty','Object.setPrototypeOf','Object.getPrototypeOf',
  'Object.preventExtensions','Object.isExtensible','Object.create','Object.keys',
  'Object.getOwnPropertyNames','Object.getOwnPropertySymbols','Reflect.ownKeys','Reflect.has','Reflect.deleteProperty']);
const nodeFor=(state,value)=>value?.[0]==='promise'?state.promises[value[1]]:
  value?.[0]==='ref'||value?.[0]==='intrinsic'&&['Promise.prototype',...ERROR_PROTOTYPES].includes(value[1])?state.heap[value[1]]:null;
const rich=node=>node&&(['promise'].includes(node.kind)||Object.keys(node.accessors??{}).length||
  Object.keys(node.dataAttributes??{}).length||node.extensible===false||
  node.prototype!==undefined&&!['Object.prototype','Array.prototype','Function.prototype'].includes(node.prototype));
const intrinsicPrototype=value=>value?.[0]==='intrinsic'&&['Promise.prototype','Object.prototype',...ERROR_PROTOTYPES].includes(value[1]);
function method(event){const callable=select(event.operands?.[0]);return callable?.[0]==='builtinfn'?callable[1]:null;}
export function promiseObjectSourceEventV8(view,{event,row}){
  if(!view.components[PROMISE_OBJECT_SOURCE_V8])return false;
  const pending=view.components[PROMISE_OBJECT_SOURCE_V8].accessors??[],base=event.operands?.[0];
  if(event.operation==='call.enter'&&objectCalls.has(method(event)))return true;
  if(view.sourceNode?.type==='BinaryExpression'&&view.sourceNode.operator==='instanceof'&&
    ['REQUIRE_OBJECT','LOGICAL_JUMP','INSTANCEOF_DEFAULT','INSTANCEOF_RESULT'].includes(view.instruction?.op))return true;
  if(event.operation==='property.delete'||event.operation==='primitive.binary'&&view.instruction?.op==='BINARY'&&view.instruction.arg==='in')return true;
  if(['property.read','property.write','property.update'].includes(event.operation)){
    if(intrinsicPrototype(base)||base?.[0]==='promise')return true;
    const property=event.operands?.[1],encodedKey=property?.[0]==='symbol'||
      property?.[0]==='str'&&property[1].startsWith('\u0000');
    if((rich(nodeFor(view.owned,base))||encodedKey)&&!sharedProtocolSourceEventV8(view,{event,row}))return true;
    if(base?.[0]==='intrinsic'&&(ERROR_CONSTRUCTORS.includes(base[1])||['Promise','Object'].includes(base[1])&&event.operands?.[1]?.[1]==='prototype'))return true;
  }
  return Boolean(row?.child&&event.stateChanges.some(change=>change.table==='frames'&&change.id===row.child&&
    change.after?.promiseConstructorLookup));
}
export function promiseObjectSourceAllocationV8(view,input){
  return Boolean(view.components[PROMISE_OBJECT_SOURCE_V8]&&['Promise.prototype',...ERROR_PROTOTYPES].includes(input.identity));
}
export function promiseObjectSourceCompletionV8(view,exit){
  return ['return','throw','unhandled-throw'].includes(exit.operation)&&
    (view.components[PROMISE_OBJECT_SOURCE_V8]?.accessors??[]).some(([frame])=>frame===exit.invocation);
}
function key(value){
  if(value?.[0]==='symbol')return copy(value);
  if(value?.[0]==='str')return copy(value);
  if(['num','bigint','bool','null','undefined'].includes(value?.[0]))return ['str',String(decode(value))];
  throw new TypeError('Promise object source: observable key conversion requires its own protocol');
}
const storage=value=>value[0]==='symbol'?symbolPropertyKey(value[1]):stringPropertyKey(value[1]);
function projectedDescriptor(ctx,node,property){const d=descriptor(node,property);if(!d)return null;
  return d.kind==='data'?{...d,value:ctx.tag(d.value)}:{...d,get:ctx.tag(d.get),set:ctx.tag(d.set)};}
function projectedPrototype(ctx,node){const p=node.prototype;
  if(p===null)return null;
  if(['Promise.prototype','Object.prototype',...ERROR_PROTOTYPES].includes(p))return ['ref',promiseIntrinsicIdV8(p)];
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
    if(pending.lookup?.continuation.kind==='adopt'){
      finishSourcePromiseAdoptionGetterV8(ctx,event,exit.invocation);pending.finished=true;return;
    }
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
    allocation(ctx,event,fields){if(!['Promise.prototype',...ERROR_PROTOTYPES].some(name=>fields.name===promiseIntrinsicIdV8(name)))ctx.refuse('undeclared intrinsic allocation');
      initialize(ctx,event);return true;},
    beforeEvent(ctx,event){
      if(!event)return;
      if(event.stateChanges.some(c=>c.table==='heap'&&['Promise.prototype',...ERROR_PROTOTYPES].includes(c.id)))initialize(ctx,event);
      // A getter can synchronously create a reaction or begin an await when it
      // returns. Finish its checked property call before publishing those jobs.
      for(const [frame,pending]of ctx.componentState(PROMISE_OBJECT_SOURCE_V8).accessors)
        if(!pending.finished&&pending.lookup?.continuation.kind!=='adopt'&&
          event.stateChanges.some(c=>c.table==='frames'&&c.id===frame&&['completed','thrown'].includes(c.after?.status)))
          finish(ctx,event,{invocation:frame});
    },
    event(ctx,event,row){initialize(ctx,event);
      const owner=ctx.rootFor(event.invocationId),base=event.operands?.[0],
      raw=select(event.result),name=method(event),state=ctx.componentState(PROMISE_OBJECT_SOURCE_V8),
      child=event.stateChanges.find(c=>c.table==='frames'&&c.before===null&&c.after?.promiseConstructorLookup)?.after;
      if(child){
        const lookup=child.promiseConstructorLookup,receiver=ctx.tag(lookup.receiver),
          property=propertyKeyValue(lookup.property),id='promiseaccess'+(++state.sequence),invocation=ctx.registerFrame(child.id,owner);
        if(lookup.continuation.kind==='adopt')ctx.refuse('adoption constructor access requires its active intrinsic call scope');
        const selected=ordinaryGet(ownedObjectHeap(ctx.state),lookup.receiver,lookup.property,{accessors:true}),
          getter=selected?.accessor?.get.value,fn=getter?.[0]==='ref'?ctx.state.heap[getter[1]]:null,
          effectiveReceiver=fn?.arrow?(fn.lexicalThisFrameId?ctx.state.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis):lookup.receiver,
          environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===child.envId)?.after;
        if(!fn||fn.async||fn.generatorFunction||child.codeId!==fn.codeId||environment?.parent!==fn.closureEnvId||
          !eq(child.thisValue,effectiveReceiver)||row?.child!==child.id)ctx.refuse('constructor getter receiver or child differs');
        ctx.emitProtocol(owner,{kind:'property.get.call',id,child:invocation,object:receiver[1],key:property,receiver},event,'source-promise-constructor-call/1');
        parameters(ctx,event,child.id,owner);state.accessors.push([child.id,{id,operation:'get',value:null,owner,finished:false,lookup:copy(lookup)}]);return true;
      }
      const currentFrame=ctx.state.frames[event.invocationId],
        inst=ctx.bundle.programs[currentFrame?.codeId]?.instructions[currentFrame?.pc];
      if(inst?.op==='REQUIRE_OBJECT'){
        if(event.operands.length!==1||!['ref','promise','intrinsic','builtinfn','hostfn'].includes(base?.[0])||!eq(raw,base))ctx.refuse('object guard requires its original reference');
        const value=ctx.tag(base);ctx.emitProtocol(owner,{kind:'compute',expr:{op:'literal',value},result:value,bind:null},event,'source-object-guard/1');return true;
      }
      if(inst?.op==='LOGICAL_JUMP'){
        if(inst.arg.operator!=='??'||!row?.test||!row.result)ctx.refuse('hasInstance selection lacks its exact nullish test');
        const value=ctx.tag(select(row.test));
        ctx.emitProtocol(owner,{kind:'choose',expr:{op:'logical-test',operator:'??',arg:{op:'literal',value}},decision:row.result,path:row.path},event,'source-hasinstance-method-selection/1');return true;
      }
      if(event.operation==='primitive.binary'){
        if(inst?.op==='INSTANCEOF_RESULT'){
          ctx.emitProtocol(owner,{kind:'compute',expr:{op:'unary',operator:'!',arg:{op:'unary',operator:'!',arg:{op:'literal',value:ctx.tag(base)}}},result:ctx.tag(raw),bind:null},event,'source-hasinstance-result/1');return true;
        }
        if(inst?.op==='INSTANCEOF_DEFAULT'){
          ctx.emitProtocol(owner,{kind:'object.hasInstance',constructor:ctx.tag(event.operands[1]),value:ctx.tag(base),result:ctx.tag(raw)},event,'source-hasinstance-default/1');return true;
        }
        if(event.completion?.type==='throw'){
          const fault=sourceInvalidInFaultV8(ctx.bundle,ctx.state,event,row);
          ctx.emitProtocol(owner,{kind:'property.fault',operation:'has',target:ctx.tag(fault.target),key:ctx.tag(fault.key),error:ctx.identity(fault.error)},event,'source-in-invalid-rhs/1');
          ctx.claimDataIdentity(fault.error);return true;
        }
        const frame=ctx.state.frames[event.invocationId],instruction=ctx.bundle.programs[frame?.codeId]?.instructions[frame.pc],
          receiver=ctx.tag(event.operands[1]);
        if(instruction?.op!=='BINARY'||instruction.arg!=='in'||receiver?.[0]!=='ref'||raw?.[0]!=='bool')
          ctx.refuse('property existence requires its original object and completed in expression');
        ctx.emitProtocol(owner,{kind:'property.has',object:receiver[1],key:key(base),result:ctx.tag(raw)},event,'source-property-existence/1');return true;
      }
      if(event.operation==='property.delete'){
        const receiver=ctx.tag(base);
        if(receiver?.[0]!=='ref'||raw?.[0]!=='bool')ctx.refuse('property deletion requires its ordinary receiver and completed boolean');
        ctx.emitProtocol(owner,{kind:'property.delete',object:receiver[1],key:key(event.operands[1]),success:raw[1]},event,'source-property-deletion/1');return true;
      }
      if(event.operation==='property.update'){
        const receiver=ctx.tag(base),property=key(event.operands[1]),old=event.operands[2],
          after=event.stateChanges.find(change=>['heap','promises'].includes(change.table)&&change.id===base?.[1])?.after,
          next=after?.properties?.[storage(property)]?.value;
        if(receiver?.[0]!=='ref'||row?.child||!['undefined','null','bool','str','num','bigint'].includes(old?.[0]))
          ctx.refuse('Promise property update requires primitive numeric conversion and data storage');
        if(!next||!['++','--'].includes(row?.update?.operator)||typeof row.update.prefix!=='boolean')
          ctx.refuse('Promise property update lacks its committed data value or source update mode');
        const literal=value=>({op:'literal',value}),numeric=old[0]==='bigint'?old:encode(Number(decode(old)));
        ctx.emitProtocol(owner,{kind:'property.get',object:receiver[1],key:property,receiver,result:ctx.tag(old)},event,'source-promise-update-read/1');
        ctx.emitProtocol(owner,{kind:'compute',expr:old[0]==='bigint'?literal(old):{op:'unary',operator:'+',arg:literal(old)},
          result:ctx.tag(numeric),bind:null},event,'source-promise-update-conversion/1');
        ctx.emitProtocol(owner,{kind:'compute',expr:{op:'binary',operator:row.update.operator==='++'?'+':'-',left:literal(numeric),
          right:literal(old[0]==='bigint'?['bigint','1']:['num',1])},result:ctx.tag(next),bind:null},event,'source-promise-update-computation/1');
        ctx.emitProtocol(owner,{kind:'property.set',object:receiver[1],key:property,receiver,value:ctx.tag(next),success:true},event,'source-promise-update-write/1');
        if(!eq(raw,row.update.prefix?next:numeric))ctx.refuse('Promise property update completion differs from its prefix/postfix mode');
        return true;
      }
      if(name==='Function.prototype.hasInstance'){
        if(base?.[0]!=='method'||event.operands.length!==2)ctx.refuse('hasInstance builtin requires its selected method receiver');
        ctx.emitProtocol(owner,{kind:'object.hasInstance',constructor:ctx.tag(base[2]),value:ctx.tag(event.operands[1]),result:ctx.tag(raw)},event,'source-hasinstance-call/1');return true;
      }
      if(event.operation==='property.read'||event.operation==='property.write'){
        if(base?.[0]==='intrinsic'&&(ERROR_CONSTRUCTORS.includes(base[1])||['Promise','Object'].includes(base[1])&&event.operands?.[1]?.[1]==='prototype')){
          ctx.emitProtocol(owner,{kind:'promise.intrinsic.get',base:base[1],key:key(event.operands[1]),result:ctx.tag(raw)},event,'source-intrinsic-prototype/1');return true;
        }
        const receiver=ctx.tag(base),property=key(event.operands[1]);
        if(receiver[0]!=='ref')ctx.refuse('ordinary property receiver required');
        const frame=ctx.state.frames[event.invocationId],instruction=ctx.bundle.programs[frame?.codeId]?.instructions[frame?.pc];
        if(event.operation==='property.write'&&instruction?.op==='DEFINE_LITERAL_PROP'){
          ctx.emitProtocol(owner,{kind:'property.define',object:receiver[1],key:property,
            descriptor:{kind:'data',value:ctx.tag(event.operands[2]),writable:true,enumerable:true,configurable:true},success:true},
            event,'source-literal-property-definition/1');return true;
        }
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
      const args=event.operands.slice(1),ownMethod=name==='Object.prototype.hasOwnProperty',
        target=ownMethod&&base?.[0]==='method'?base[2]:args[0],object=ctx.tag(target)?.[1],
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
      if(name==='Object.hasOwn'||ownMethod){
        if(ownMethod&&base?.[0]!=='method')ctx.refuse('hasOwnProperty requires its actual method receiver');
        ctx.emitProtocol(owner,{kind:'property.hasOwn',object,key:key(args[ownMethod?0:1]),result:ctx.tag(raw)},event,'source-own-property/1');return true;
      }
      if(name==='Reflect.has'){
        ctx.emitProtocol(owner,{kind:'property.has',object,key:key(args[1]??['undefined']),result:ctx.tag(raw)},event,'source-property-existence/1');return true;
      }
      if(name==='Reflect.deleteProperty'){
        if(raw?.[0]!=='bool')ctx.refuse('Reflect.deleteProperty requires its completed boolean');
        ctx.emitProtocol(owner,{kind:'property.delete',object,key:key(args[1]??['undefined']),success:raw[1]},event,'source-property-deletion/1');return true;
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
        if((change.table==='promises'||['Promise.prototype',...ERROR_PROTOTYPES].includes(change.id)||node.declaredError)&&controller.heap.has(id)){
          const actual=describeProtocolObjectV8(controller,id),expected={kind:change.table==='promises'?'promise':'object',
            prototype:projectedPrototype(ctx,node),extensible:node.extensible!==false,
            properties:orderedKeys(node).map(k=>({key:propertyKeyValue(k),descriptor:projectedDescriptor(ctx,node,k)}))};
          if(!eq(actual,expected))ctx.refuse('Promise descriptors/prototype differ from current owned state: '+change.id);
          if(node.declaredError&&controller.heap.get(id)?.declaredError!==node.declaredError)ctx.refuse('Error allocation lacks its derived intrinsic brand');
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
