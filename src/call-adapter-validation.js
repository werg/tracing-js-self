// Read-only source linkage for call/apply. The public call still enters the
// original closure; adapter arguments are not the closure's argument list.
import {symbolPropertyKey,stringPropertyKey} from './property-keys.js';
import {ownedGlobalProperty} from './owned-global-object.js';
import {ownedHasOwnProperty} from './owned-has-property.js';
const names=new Set(['Function.prototype.call','Function.prototype.apply','Reflect.apply']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),undefinedValue=['undefined'];
export function callAdapterInvocation(event){
  if(event.operation!=='call.enter')return null;
  const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw;
  if(callee?.[0]!=='builtinfn'||!names.has(callee[1]))return null;
  const reflect=callee[1]==='Reflect.apply';
  return {name:callee[1],callee:reflect?event.operands[1]??undefinedValue:raw?.[0]==='method'?raw[2]:undefinedValue,
    receiver:event.operands[reflect?2:1]??undefinedValue,
    arguments:callee[1]==='Function.prototype.call'?event.operands.slice(2):
      (event.readObservations??[]).slice(1).map(read=>read.value)};
}
function dataRead(state,receiver,key,fail){
  const original=state.heap[receiver],visited=new Set();let node=original;
  if(!['object','array'].includes(node?.kind))fail('Apply requires an owned ordinary argument list');
  for(;;){
    if(!['object','array'].includes(node?.kind)||visited.has(node.id)||Object.hasOwn(node.accessors??{},key))
      fail('Apply argument read requires an acyclic ordinary data chain');
    visited.add(node.id);
    if(Object.hasOwn(node.properties,key)){
      const slot=node.properties[key];
      return {kind:'property',objectId:original.id,key,version:original.propertyVersions?.[key]??0,
        shapeVersion:original.shapeVersion??0,present:Object.hasOwn(original.properties,key),
        value:slot.value,supplyingEvent:slot.origin??null};
    }
    const prototype=node.prototype===undefined?(node.kind==='array'?'Array.prototype':'Object.prototype'):node.prototype;
    if(prototype===null||['Array.prototype','Object.prototype'].includes(prototype))
      return {kind:'property',objectId:original.id,key,version:original.propertyVersions?.[key]??0,
        shapeVersion:original.shapeVersion??0,present:false,value:undefinedValue,supplyingEvent:null};
    node=state.heap[prototype];
  }
}
function scalarLength(value,fail){
  if(!['undefined','null','bool','num','str'].includes(value?.[0]))fail('Apply length requires scalar Number conversion');
  const number=value[0]==='undefined'?NaN:value[0]==='null'?0:value[0]==='num'&&typeof value[1]==='string'?
    ({'-0':-0,NaN:NaN,'+Infinity':Infinity,'-Infinity':-Infinity})[value[1]]:Number(value[1]);
  const length=Number.isNaN(number)||number<=0?0:Math.floor(number);
  if(!Number.isSafeInteger(length)||length>10000)fail('Apply argument length exceeds the owned bound');
  return length;
}
export function validateCallAdapterEvent(state,event,programs,fail,sources=[]){
  const adapter=callAdapterInvocation(event);if(!adapter)return;
  const child=event.causes?.find(cause=>cause.kind==='invocation');
  const ownBuiltin=adapter.callee?.[0]==='builtinfn'&&
    ['Object.prototype.hasOwnProperty','Object.hasOwn'].includes(adapter.callee[1]);
  // Unsupported/guest-abrupt calls create no successful invocation to project.
  if(!child&&!ownBuiltin){if(!event.completion)fail('Call adapter lacks a completion or invocation');return;}
  if(event.completion&&!child)return;
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  if(instruction?.op!=='CALL'||event.causes.length!==(ownBuiltin?0:1)||event.completion)
    fail('Call adapter invocation has no source CALL');
  const count=typeof instruction.arg==='number'?instruction.arg:instruction.arg.count,
    inputs=frame.stack.slice(-count-1),expanded=[inputs[0]?.value];
  for(let index=0;index<count;index++){
    const value=inputs[index+1]?.value;
    if(instruction.arg?.spread?.includes(index)){
      if(value?.[0]!=='spread'||!Array.isArray(value[1]))fail('Call adapter spread lacks its evaluated snapshot');
      expanded.push(...value[1]);
    }else expanded.push(value);
  }
  if(!same(expanded,event.operands))fail('Call adapter operands differ from the evaluated source stack');
  const target=adapter.callee[0]==='ref'?state.heap[adapter.callee[1]]:null;
  if(!ownBuiltin&&(target?.kind!=='function'||!same(event.result,adapter.callee)))fail('Call adapter lost its owned function identity');
  const reads=[];
  if(adapter.name!=='Function.prototype.call'){
    const list=event.operands[adapter.name==='Reflect.apply'?3:2]??undefinedValue,
      empty=adapter.name==='Function.prototype.apply'&&['undefined','null'].includes(list[0]);
    if(!empty){
      if(list[0]!=='ref')fail('Apply argument list must be an object');
      const length=dataRead(state,list[1],'length',fail);reads.push(length);
      for(let index=0,size=scalarLength(length.value,fail);index<size;index++)reads.push(dataRead(state,list[1],String(index),fail));
    }
  }
  if(!same(reads,event.readObservations))fail('Apply argument reads differ from the owned array-like values');
  if(ownBuiltin){
    const method=adapter.callee[1],base=method==='Object.hasOwn'?adapter.arguments[0]??undefinedValue:adapter.receiver,
      tagged=adapter.arguments[method==='Object.hasOwn'?1:0]??undefinedValue;
    if(!['undefined','null','bool','str','num','bigint','symbol'].includes(tagged[0]))
      fail('Own property key requires its source coercion');
    const key=tagged[0]==='symbol'?symbolPropertyKey(tagged[1]):stringPropertyKey(tagged[0]==='undefined'?'undefined':tagged[0]==='null'?'null':
      tagged[0]==='num'&&tagged[1]==='-0'?'0':String(tagged[1]));
    let present;
    if(base[0]==='intrinsic'&&base[1]==='globalThis'){
      present=ownedGlobalProperty(state,key,sources)!==null;
    }else if(base[0]==='str')present=key==='length'||/^(0|[1-9]\d*)$/.test(key)&&Number(key)<base[1].length;
    else if(['bool','num','bigint','symbol'].includes(base[0]))present=false;
    else{
      const object=base[0]==='promise'?state.promises[base[1]]:base[0]==='ref'||base[0]==='intrinsic'?state.heap[base[1]]:null;
      if(!object||!['object','array','function','generator','promise'].includes(object.kind))fail('Own property adapter lost receiver storage');
      present=ownedHasOwnProperty(object,key);
    }
    if(!same(event.result,['bool',!!present]))fail('Own property adapter result differs from its actual receiver');
    const changed=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===frame.id)?.after;
    if(!changed||changed.pc!==frame.pc+1||!same(changed.stack,
      [...frame.stack.slice(0,-count-1),{value:event.result,origin:event.eventId}]))
      fail('Own property adapter changed its source continuation');
    return;
  }
  const created=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===child.frameId),
    activation=created?.after,environment=event.stateChanges.find(patch=>patch.table==='envs'&&patch.id===activation?.envId),
    receiver=target.arrow?(target.lexicalThisFrameId?state.frames[target.lexicalThisFrameId]?.thisValue:target.lexicalThis):adapter.receiver;
  if(created?.before!==null||activation?.codeId!==target.codeId||activation.callerFrameId!==frame.id||
     !same(activation.thisValue,receiver)||environment?.before!==null||environment.after?.parent!==target.closureEnvId)
    fail('Call adapter changed its callee activation or receiver');
  const program=programs[target.codeId];
  for(const [index,name]of program.params.entries()){
    const actual=environment.after.bindings[name]?.token?.value;
    if(index!==program.restIndex){
      if(!same(actual,adapter.arguments[index]??undefinedValue))fail('Call adapter changed an effective argument');
    }else{
      const rest=actual?.[0]==='ref'?event.stateChanges.find(patch=>patch.table==='heap'&&patch.id===actual[1]):null,
        values=adapter.arguments.slice(index);
      if(rest?.before!==null||rest.after?.kind!=='array'||!same(rest.after.properties.length?.value,['num',values.length])||
         Object.keys(rest.after.properties).length!==values.length+1||values.some((value,index)=>!same(rest.after.properties[String(index)]?.value,value)))
        fail('Call adapter changed its rest argument array');
    }
  }
}
