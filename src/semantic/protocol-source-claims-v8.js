// Declarative teacher-only ownership for the direct protocol projector.
// These predicates inspect frozen current-prefix data. They cannot emit a
// public record, read a future event, or invoke an imperative adapter.
import {SHARED_TYPES} from '../owned-shared-memory.js';

export const ORDINARY_PROTOCOL_SOURCE_V8='ordinary-protocol-source/1';
const memory='owned-binary-memory/1',iterator='builtin-iterator/1',generator='synchronous-generator-source/1',
  construction='class-private-source/1',custom='custom-iterator-source/1',completion='ordinary-completions-source/1',
  number='primitive-conversion-source/1',proxy='ordinary-data-proxy-source/1',map='ordinary-array-map-source/1',enumeration='ordinary-for-in/1',
  collection='owned-collections/1',reflection='proxy-reflection-source/1';
const memoryKinds=new Set(['array-buffer','shared-int32-buffer','typed-array','shared-int32-view','data-view','shared-data-view']);
const constructors=new Set(['ArrayBuffer','SharedArrayBuffer','DataView',...Object.keys(SHARED_TYPES)]);
const iteratorNames=new Set(['Array.prototype.values','Array.prototype.keys','Array.prototype.entries',
  'String.prototype.iterator','Set.prototype.values','Set.prototype.keys','Set.prototype.entries',
  'Map.prototype.keys','Map.prototype.values','Map.prototype.entries','Iterator.next','Iterator.identity']);
const baseBuiltins=new Set(['Array.prototype.push','Array.prototype.pop','Symbol','Symbol.for','Symbol.keyFor',
  'Symbol.prototype.toString','Symbol.prototype.valueOf','Object.hasOwn','Reflect.has','Reflect.deleteProperty','Reflect.ownKeys','Object.keys',
  'Object.getOwnPropertyNames','Object.getOwnPropertySymbols','Object.entries','Object.values','Object.defineProperty','Object.preventExtensions',
  'Function.prototype.hasInstance','Object.setPrototypeOf','Object.create','Object.getPrototypeOf','Object.getOwnPropertyDescriptor','Object.isExtensible']);
const constructionOps=new Set(['CLASS_CREATE','SET_HOME_OBJECT','CLASS_INITIALIZER','CLASS_FINISH','CLASS_CONSTRUCTOR_GUARD',
  'SUPER_CONSTRUCTOR','SUPER_CALL','SUPER_FORWARD_CALL','SUPER_BIND','THIS','NEW_TARGET','PROPERTY_KEY',
  'PRIVATE_DEFINE','PRIVATE_GET','PRIVATE_GET_METHOD','PRIVATE_SET','PRIVATE_HAS','PRIVATE_UPDATE','DEFINE_LITERAL_PROP']);
const delegateOps=new Set(['LOGICAL_JUMP','REQUIRE_OBJECT','BINARY','DELEGATE_RESUME_KIND','DELEGATE_RESUME_VALUE',
  'DELEGATE_YIELD','LEAVE_SCOPE','RETURN','ITERATOR_THROW_MISSING']);
const ordinaryOperations=new Set(['property.read','property.write','property.update','property.delete','primitive.binary','primitive.unary',
  'binding.update','binding.read','binding.initialize','binding.write','call.return','completion.throw','control.jump',
  'environment.iteration','binding.default.guard']);
// The same declarative domains are available to the shared effectful source
// engine. Its base and Promise peers exclude only these explicit domains;
// arbitrary extensions still have to prove unique ownership.
// These protocol families can participate in Promise source projection without
// introducing an independent whole-episode teacher. Their events are still
// claimed through the same prefix coordinator and retained-state transaction.
export const SHARED_PROTOCOL_SOURCE_IDS_V8=Object.freeze([memory,number,proxy,reflection,iterator,map,enumeration,generator,custom,completion,collection]);
const callee=value=>value?.[0]==='method'?value[1]:value;
const builtin=value=>['intrinsic','builtinfn'].includes(value?.[0])?value[1]:null;
const selected=value=>value?.[0]==='method'?value[1]:value;
const heap=(view,value)=>value?.[0]==='ref'?view.owned.heap[value[1]]:null;
const frame=view=>view.owned.frames[view.event?.invocationId];
const state=(view,id)=>view.components[id]??{};
const has=(pairs,key)=>pairs?.some(([id])=>id===key)??false;
const at=(pairs,key)=>pairs?.find(([id])=>id===key)?.[1];
const enabled=(view,id)=>Object.hasOwn(view.components,id);
const delegates=view=>Boolean(frame(view)?.generatorId&&view.instruction&&
  state(view,generator).delegateSites?.includes(view.instruction.start+':'+view.instruction.end));
const ordinaryPrototype=view=>view.event.stateChanges.some(change=>change.table==='heap'&&change.after?.kind==='function'&&
  change.after.prototypeInitialized&&!change.before?.prototypeInitialized&&!change.after.classConstructor&&!change.after.generatorFunction);

const eventClaims={
  [reflection](view,{event,row}){
    const name=builtin(callee(row?.operands?.[0]??event.operands?.[0]));
    return event.operation==='call.return'&&has(state(view,reflection).callbacks,event.invocationId)||
      event.operation==='call.enter'&&['getPrototypeOf','setPrototypeOf','isExtensible','preventExtensions','getOwnPropertyDescriptor','ownKeys','defineProperty'].some(
        op=>name==='Object.'+op||name==='Reflect.'+op)&&heap(view,row?.operands?.[1]??event.operands?.[1])?.kind==='proxy';
  },
  [memory](view,{event,row}){
    if(!row)return false;
    const raw=row.operands[0],name=builtin(callee(raw));
    return event.operation==='object.construct'&&raw?.[0]==='intrinsic'&&constructors.has(raw[1])||
      ['property.read','property.write'].includes(event.operation)&&memoryKinds.has(heap(view,raw)?.kind)||
      event.operation==='call.enter'&&typeof name==='string'&&(name==='ArrayBuffer.isView'||
        /^(DataView|TypedArray|ArrayBuffer|SharedArrayBuffer)\.prototype\./.test(name)||name.startsWith('Atomics.'));
  },
  [enumeration](view){return ['FOR_IN_CREATE','FOR_IN_NEXT'].includes(view.instruction?.op);},
  [number](_view,{event}){return ['intrinsic.number.resume','property.key.convert','property.key.resume'].includes(event.operation)||
    event.operation==='call.enter'&&builtin(callee(event.operands[0]))==='Number';},
  [proxy](view,{event,row}){return event.operation==='proxy.allocate'||
    ['property.read','property.write'].includes(event.operation)&&heap(view,row?.operands[0])?.kind==='proxy'||
    event.operation==='primitive.binary'&&view.instruction?.op==='BINARY'&&view.instruction.arg==='in'&&
      heap(view,row?.operands[1])?.kind==='proxy'||
    event.operation==='property.delete'&&(heap(view,row?.operands[0])?.kind==='proxy'||
      event.completion?.type==='throw'&&view.instruction?.op==='DELETE_PROP'&&
      heap(view,frame(view)?.stack?.at(-2)?.value)?.kind==='proxy')||
    event.operation==='call.return'&&has(state(view,proxy).callbacks,event.invocationId);},
  [map](view,{event,row}){
    const own=state(view,map),plan=at(own.plans,event.invocationId),callback=at(own.callbacks,event.invocationId);
    return has(own.callbacks,event.invocationId)&&event.stateChanges.some(change=>change.table==='frames'&&
      change.id===event.invocationId&&['completed','thrown'].includes(change.after?.status)&&
      !['LOOP_ENTER','TRY_ENTER','BIND_CATCH','TRY_NORMAL','END_FINALLY'].includes(view.instruction?.op))||
      Boolean(callback?.generatorCallback&&event.operation==='call.return')||
      Boolean(plan&&plan.waitingFrameId===null&&event.operation==='call.enter')||
      Boolean(row&&event.operation==='property.read'&&!row.child&&builtin(selected(row.result))==='Array.prototype.map')||
      Boolean(row&&event.operation==='call.enter'&&builtin(callee(row.operands[0]))==='Array.prototype.map');
  },
  [completion](view){return Boolean(frame(view)&&!frame(view).generatorId&&
    ['LOOP_ENTER','TRY_ENTER','BIND_CATCH','TRY_NORMAL','END_FINALLY'].includes(view.instruction?.op));},
  [custom](view,{event}){
    const inst=view.instruction,node=view.sourceNode,own=state(view,custom),point=node?.start+':'+node?.end;
    if(!inst)return false;
    const base=heap(view,event.operands?.[0]),output=selected(event.result);
    if(own.asyncLoop&&event.operands.length>=2&&['object','array','function'].includes(base?.kind)&&
      (event.operation==='property.write'&&inst.op!=='APPEND_ARRAY'||event.operation==='property.read'&&
        !['builtinfn','intrinsic'].includes(output?.[0])))return true;
    if(own.defaults?.includes(point)&&inst.op==='BINARY'||own.rests?.includes(point)&&inst.op==='APPEND_ARRAY')return true;
    const pattern=node?.type==='ArrayPattern'&&own.patterns?.includes(point);
    if(node?.type!=='ForOfStatement'&&!pattern)return false;
    return ['REQUIRE_OBJECT','LOGICAL_JUMP','PENDING_THROW'].includes(inst.op)||node.await&&inst.op==='UNARY'||
      ['INIT','GET'].includes(inst.op)&&(/^\[\[(?:(?:async|sync) )?iterator next [0-9]+\]\]$/.test(inst.arg)&&event.result?.[0]==='method'||
        pattern&&event.result?.[0]==='method');
  },
  [collection](view,{event,row}){
    const raw=row?.operands?.[0]??event.operands?.[0],name=builtin(callee(raw));
    if(event.operation==='object.construct'&&raw?.[0]==='intrinsic'&&['Set','Map'].includes(raw[1]))return true;
    const baseValue=event.operation==='property.read'?row?.operands?.[0]:
      raw?.[0]==='method'?raw[2]:null,base=heap(view,baseValue),kind=base?.kind;
    if(event.operation==='property.read'&&['set','map'].includes(kind)){
      const key=row?.operands?.[1],methods=kind==='set'?['add','has','delete','clear']:['get','set','has','delete','clear'];
      return key?.[0]==='str'&&(key[1]==='size'||methods.includes(key[1]));
    }
    return Boolean(event.operation==='call.enter'&&
      (name?.startsWith('Set.prototype.')&&['add','has','delete','clear'].includes(name.slice(14))||
       name?.startsWith('Map.prototype.')&&['get','set','has','delete','clear'].includes(name.slice(14)))&&
      ['set','map'].includes(heap(view,raw?.[0]==='method'?raw[2]:null)?.kind));
  },
  [iterator](view,{event,row}){
    const inst=view.instruction;
    if(inst?.op==='ITERATOR_ARRAY_GUARD'||inst?.op==='SPREAD')return true;
    if(inst?.op==='APPEND_ARRAY'&&view.sourceNode?.type==='ArrayExpression')return true;
    if(!row)return false;
    if(event.operation==='primitive.binary'&&inst?.op==='BINARY'&&inst.arg==='>'&&
      state(view,iterator).arrayLoops?.includes(event.invocationId+':'+row.source?.start+':'+row.source?.end))return true;
    const base=heap(view,row.operands[0]);
    if(event.operation==='property.read'&&!row.child&&base?.kind!=='generator'&&row.operands.length>1)
      return iteratorNames.has(builtin(selected(row.result)))||base?.kind==='iterator';
    if(event.operation!=='call.enter'||row.child)return false;
    const raw=row.operands[0],name=builtin(callee(raw));
    return iteratorNames.has(name)&&heap(view,raw?.[0]==='method'?raw[2]:null)?.kind!=='generator'&&
      !(delegates(view)&&name==='Iterator.next');
  },
  [generator](view,{event,row}){
    const current=frame(view),inst=view.instruction;
    if(at(state(view,map).callbacks,event.invocationId)?.generatorCallback&&event.operation==='call.return')return false;
    if(delegates(view)&&(delegateOps.has(inst.op)||['INIT','GET'].includes(inst.op)&&/^\[\[delegate next /.test(inst.arg)||
      event.operation==='call.enter'&&event.operands[0]?.[1]?.[1]==='Iterator.next'))return true;
    if(current?.generatorId&&['TRY_ENTER','TRY_NORMAL','BIND_CATCH','END_FINALLY'].includes(inst?.op))return true;
    if(['GENERATOR_START','YIELD'].includes(inst?.op))return true;
    if(current?.generatorId&&['RETURN','THROW'].includes(inst?.op)&&['call.return','completion.throw'].includes(event.operation))return true;
    if(event.operation==='property.read'&&!row?.child&&heap(view,row?.operands?.[0])?.kind==='generator')return true;
    if(event.operation!=='call.enter')return false;
    const raw=event.operands[0],fn=callee(raw),name=builtin(fn);
    return Boolean(heap(view,fn)?.generatorFunction)||
      ['Generator.next','Generator.return','Generator.throw','Iterator.identity'].includes(name)&&
      heap(view,raw?.[0]==='method'?raw[2]:null)?.kind==='generator';
  },
  [construction](view){
    const op=view.instruction?.op;
    if(!op||['property.key.convert','property.key.resume'].includes(view.event.operation))return false;
    if(op==='CONSTRUCT')return view.event.operands[0]?.[0]==='ref';
    return constructionOps.has(op)||ordinaryPrototype(view)&&['GET_PROP','GET_METHOD'].includes(op)||op.startsWith('SUPER_');
  }
};
function standardEventClaims(view,input){return Object.entries(eventClaims).filter(([id,claim])=>enabled(view,id)&&claim(view,input)).map(([id])=>id);}
const moduleNamespace='experimental-module-namespace-source/1';
function experimentalModuleNamespaceEvent(view,{event,row}){
  const own=state(view,moduleNamespace),names=new Set(own.cellNames??[]),writes=row?.writes??[];
  if(event.operation==='call.enter'&&own.ownerSiteIds?.includes(event.siteId))return true;
  if([...new Set((own.pendingCreates??[]).map(([,item])=>item))].some(item=>
    item.invocationId===event.invocationId&&event.operation==='binding.initialize'&&
    writes.some(write=>write.key===item.namespaceName)))return true;
  if(['binding.initialize','binding.write','binding.update'].includes(event.operation)&&
    writes.some(write=>write.kind==='cell'&&names.has(write.key)))return true;
  if(event.operation==='call.enter'&&['Object.keys','Object.getOwnPropertyDescriptor'].includes(
    builtin(callee(event.operands?.[0])))&&event.operands?.[1]?.[0]==='ref'&&
    view.owned.heap?.[event.operands[1][1]]?.kind==='module-namespace')return true;
  if((own.operations??[]).some(([,operation])=>operation.waitingFrameId===event.invocationId)&&
    ['binding.read','call.return'].includes(event.operation))return true;
  if(event.operation==='property.read'&&event.operands?.[0]?.[0]==='ref'&&
    view.owned.heap?.[event.operands[0][1]]?.kind==='module-namespace')return true;
  return false;
}
function ordinaryEvent(view,input){
  if(enabled(view,moduleNamespace)&&experimentalModuleNamespaceEvent(view,input))return false;
  if(standardEventClaims(view,input).length)return false;
  const {event,row}=input;
  // An Array#map callback's completion belongs to the map adapter, which must
  // both finish the nested public call and advance or abruptly terminate the
  // retained map continuation. Ordinary completion syntax inside that
  // callback is still handled at its own source events.
  if(has(state(view,map).callbacks,event.invocationId)&&event.stateChanges.some(change=>change.table==='frames'&&
    change.id===event.invocationId&&['completed','thrown'].includes(change.after?.status)))return false;
  if(!row)return !event.stateChanges.some(change=>change.table==='heap');
  if(event.operation==='call.enter')return Boolean(row.child&&callee(row.operands[0])?.[0]==='ref')||baseBuiltins.has(builtin(callee(row.operands[0])));
  return Boolean(row.allocations?.length||row.arithmetic||['carry','branch'].includes(row.op)||ordinaryOperations.has(event.operation));
}
function completionOwners(view,change){
  const routedGenerator=change.after?.completion?.type==='throw'&&view.event?.operation==='completion.throw'&&
    view.event.stateChanges.filter(row=>row.table==='frames'&&row.after?.generatorId&&
      row.before?.generatorId===row.after.generatorId&&row.before.handlers?.length!==row.after.handlers?.length);
  return [...(change.after?.generatorId||routedGenerator?.length===1?[generator]:[]),
    ...(enabled(view,moduleNamespace)&&(state(view,moduleNamespace).operations??[]).some(([,operation])=>
      operation.waitingFrameId===change.id)?[moduleNamespace]:[]),
    ...[[construction,'roles'],[number,'callbacks'],[proxy,'callbacks'],[reflection,'callbacks'],[map,'callbacks'],[custom,'accessors']]
      .filter(([id,key])=>has(state(view,id)[key],change.id)).map(([id])=>id)];
}
function allocationOwner(view,node){
  if(node.generatorFunction||node.kind==='generator')return generator;
  if(node.kind==='function'&&enabled(view,construction))return construction;
  if(memoryKinds.has(node.kind))return memory;
  if(node.kind==='set'||node.kind==='map')return collection;
  if(node.kind==='iterator')return iterator;
  if(node.kind==='enumerator')return enumeration;
  if(node.kind==='proxy')return proxy;
  return ['object','array','function','symbol'].includes(node.kind)?ORDINARY_PROTOCOL_SOURCE_V8:null;
}
export function protocolSourceClaimsV8(id){
  if(id!==ORDINARY_PROTOCOL_SOURCE_V8&&!Object.hasOwn(eventClaims,id))return null;
  return {
    event:(view,input)=>id===ORDINARY_PROTOCOL_SOURCE_V8?ordinaryEvent(view,input):eventClaims[id](view,input),
    completion:(view,change)=>{const owners=completionOwners(view,change);
      return id===ORDINARY_PROTOCOL_SOURCE_V8?owners.length===0:owners.includes(id);},
    allocation:(view,node)=>allocationOwner(view,node)===id
  };
}
export function sharedProtocolSourceEventV8(view,input){
  return SHARED_PROTOCOL_SOURCE_IDS_V8.some(id=>enabled(view,id)&&eventClaims[id](view,input));
}
export function sharedProtocolSourceAllocationV8(view,input){
  return SHARED_PROTOCOL_SOURCE_IDS_V8.some(id=>enabled(view,id)&&allocationOwner(view,input.node)===id);
}
export function sharedProtocolSourceCompletionV8(view,exit){
  const change=view.event?.stateChanges.find(change=>change.table==='frames'&&change.id===exit.invocation);
  return Boolean(change&&completionOwners(view,change).some(id=>SHARED_PROTOCOL_SOURCE_IDS_V8.includes(id)&&enabled(view,id)));
}
