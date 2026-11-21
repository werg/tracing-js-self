// Read-only reference/ToPropertyKey checks. The evaluated base, key, remaining
// operand stack and source pc are archive data, never reconstructed by rerunning
// the source expression. This validator imports no runtime or mutation kernel.
import {conversionWaiting,conversionReturned,validatePrimitiveConversionRecord,
  validatePrimitiveConversionAdvance,validatePrimitiveConversionReturn} from './primitive-conversion-validation.js';

const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['pc','opcode','stackIndex','stack','cacheBinding','conversion'];
const bindingFields=['envId','name','token','version'];
const shape=(record,keys)=>record&&typeof record==='object'&&!Array.isArray(record)&&
  Object.keys(record).length===keys.length&&keys.every(key=>Object.hasOwn(record,key));
function reference(frame,instruction,state,fail){
  const op=instruction?.op,offset=op==='PUT_PROP'?2:
    ['GET_PROP','GET_METHOD','UPDATE_PROP','PROPERTY_KEY'].includes(op)||op==='DUP2'&&instruction.arg?.cachePropertyKey===true?1:null;
  if(offset===null)fail('PropertyKey continuation does not belong to a reference instruction');
  const stackIndex=frame.stack.length-offset,key=frame.stack[stackIndex],base=frame.stack[stackIndex-1];
  if(key?.value[0]!=='ref'||!['object','array'].includes(state.heap[key.value[1]]?.kind)||
    op!=='PROPERTY_KEY'&&(!base||['null','undefined'].includes(base.value[0])))
    fail('PropertyKey continuation lacks an owned key or coercible base');
  let cacheBinding=null;
  if(op==='GET_PROP'&&instruction.arg?.cachePropertyKey){
    const name=instruction.arg.cachePropertyKey;
    if(typeof name!=='string'||!/^\[\[logical key [1-9]\d*\]\]$/.test(name))
      fail('PropertyKey cache must be an internal logical reference binding');
    let env=state.envs[frame.envId];const seen=new Set();
    while(env&&!Object.hasOwn(env.bindings,name)){
      if(seen.has(env.id))fail('PropertyKey reference has a cyclic environment');
      seen.add(env.id);env=state.envs[env.parent];
    }
    const cell=env?.bindings[name];
    if(cell?.kind!=='const'||!cell.initialized||!eq(cell.token.value,key.value))
      fail('PropertyKey cache binding lost its evaluated input');
    cacheBinding={envId:env.id,name,token:cell.token,version:cell.version};
  }
  return {pc:frame.pc,opcode:op,stackIndex,stack:frame.stack,cacheBinding,
    conversion:{operation:'PropertyKey',input:key.value,siteId:instruction.siteId,index:-1,
      method:null,phase:'select',waitingFrameId:null,result:null}};
}
function retainedReferenceMatches(actual,expected){
  return shape(actual,fields)&&actual.pc===expected.pc&&actual.opcode===expected.opcode&&
    actual.stackIndex===expected.stackIndex&&eq(actual.stack,expected.stack)&&eq(actual.cacheBinding,expected.cacheBinding)&&
    eq(actual.conversion?.input,expected.conversion.input)&&actual.conversion?.siteId===expected.conversion.siteId;
}
export function validatePropertyKeyConversionState(state,programs,sites,fail){
  for(const frame of Object.values(state.frames)){
    const pending=frame.pendingPropertyKeyConversion;if(pending===undefined)continue;
    const instruction=programs[frame.codeId]?.instructions[frame.pc],expected=reference(frame,instruction,state,fail);
    if(!retainedReferenceMatches(pending,expected)||
      pending.cacheBinding!==null&&!shape(pending.cacheBinding,bindingFields))
      fail('PropertyKey continuation changed its retained stack, source pc or cache binding');
    validatePrimitiveConversionRecord(pending.conversion,'PropertyKey',frame,state,programs,sites,fail);
  }
}
function checkCachedBinding(state,event,binding,value,fail){
  if(!binding)return;
  const patch=event.stateChanges.find(change=>change.table==='envs'&&change.id===binding.envId),
    before=state.envs[binding.envId]?.bindings[binding.name],after=patch?.after?.bindings[binding.name];
  if(!before||!after||!eq(after,{...before,token:{value,origin:event.eventId},version:before.version+1}))
    fail('PropertyKey result was not stored in its retained logical reference');
  const expected={...state.envs[binding.envId],version:patch.after.version,
    bindings:{...state.envs[binding.envId].bindings,[binding.name]:after}};
  if(!eq(patch.after,expected))fail('PropertyKey cache update changed an unrelated lexical binding');
}
export function validatePropertyKeyConversionEvent(state,event,programs,fail){
  const stage=['property.key.convert','property.key.resume'].includes(event.operation);
  let ownChange=null;
  if(stage){
    const parent=state.frames[event.invocationId],instruction=programs[parent?.codeId]?.instructions[parent?.pc],
      prior=parent?.pendingPropertyKeyConversion,resume=event.operation==='property.key.resume';
    if(!parent||state.control.a0.activeFrameId!==parent.id||parent.status!=='running'||
      (resume?!conversionReturned(prior?.conversion):!!prior))
      fail('PropertyKey conversion has no active reference or returned callback');
    const expectedReference=reference(parent,instruction,state,fail),before=resume?prior:expectedReference;
    if(event.siteId!==instruction.siteId||event.codeId!==parent.codeId||event.sourceId!==parent.codeId.split(':')[0]||
      resume&&!retainedReferenceMatches(prior,expectedReference))
      fail('PropertyKey conversion lost its source reference identity');
    ownChange=event.stateChanges.find(change=>change.table==='frames'&&change.id===parent.id);
    if(!ownChange?.after)fail('PropertyKey conversion lost its parent frame');
    const after=ownChange.after.pendingPropertyKeyConversion;
    if(after&&!retainedReferenceMatches(after,before))fail('PropertyKey callback replaced its retained reference');
    const decision=validatePrimitiveConversionAdvance(before.conversion,after?.conversion,parent.id,state,event,programs,fail);
    if(!decision.fault){
      const stack=structuredClone(before.stack);
      if(!decision.method)stack[before.stackIndex]={value:decision.value,origin:event.eventId};
      if(ownChange.after.pc!==parent.pc||!eq(ownChange.after.stack,stack)||
        !eq(event.operands,[before.conversion.input])||!eq(event.operandOrigins,[before.stack[before.stackIndex].origin]))
        fail('PropertyKey conversion changed an operand or advanced the source instruction');
      if(!decision.method)checkCachedBinding(state,event,before.cacheBinding,decision.value,fail);
    }
  }
  for(const change of event.stateChanges){
    if(change.table!=='frames'||eq(change.before?.pendingPropertyKeyConversion,change.after?.pendingPropertyKeyConversion)||change===ownChange)continue;
    const before=change.before?.pendingPropertyKeyConversion,after=change.after?.pendingPropertyKeyConversion;
    if(!conversionWaiting(before?.conversion))fail('PropertyKey continuation changed outside its source conversion');
    validatePrimitiveConversionReturn(before.conversion,after?.conversion,state,event,fail,programs);
    if(after&&(!retainedReferenceMatches(after,before)||change.before.pc!==change.after.pc||!eq(change.before.stack,change.after.stack)))
      fail('PropertyKey callback changed its suspended reference');
  }
}
