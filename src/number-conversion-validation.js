// Number is a static client of the shared, independently checked conversion
// protocol. Its original eight-field callback record and ordinary event bytes
// stay unchanged; getters add explicit retained return phases.
import {conversionWaiting,conversionReturned,validatePrimitiveConversionRecord,
  validatePrimitiveConversionAdvance,validatePrimitiveConversionReturn} from './primitive-conversion-validation.js';

const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function validateNumberConversionState(state,programs,sites,fail){
  for(const frame of Object.values(state.frames)){
    const pending=frame.pendingNumberConversion;
    if(pending!==undefined)validatePrimitiveConversionRecord(pending,'Number',frame,state,programs,sites,fail);
  }
}
function sourceCall(frame,instruction){
  if(instruction?.op!=='CALL')return null;
  const count=typeof instruction.arg==='number'?instruction.arg:instruction.arg.count,
    callee=frame.stack.at(-count-1)?.value,fn=callee?.[0]==='method'?callee[1]:callee;
  if(!eq(fn,['intrinsic','Number']))return null;
  const raw=frame.stack.slice(frame.stack.length-count),args=[];
  for(const [index,item] of raw.entries()){
    if(instruction.arg?.spread?.includes(index)){
      if(item.value[0]!=='spread')return null;
      args.push(...item.value[1]);
    }else args.push(item.value);
  }
  if(args[0]?.[0]!=='ref')return null;
  return {input:args[0],prefix:frame.stack.slice(0,frame.stack.length-count-1)};
}
export function validateNumberConversionEvent(state,event,programs,fail){
  const sourceFrame=state.frames[event.invocationId],instruction=programs[sourceFrame?.codeId]?.instructions[sourceFrame?.pc],
    call=event.operation==='call.enter'&&sourceFrame?sourceCall(sourceFrame,instruction):null,
    resumed=event.operation==='intrinsic.number.resume';
  let ownChange=null;
  if(call||resumed){
    const prior=sourceFrame?.pendingNumberConversion;
    if(state.control.a0.activeFrameId!==sourceFrame?.id||sourceFrame?.status!=='running'||
      resumed&&!conversionReturned(prior)||call&&prior)
      fail('Number conversion has no active source call or returned callback');
    ownChange=event.stateChanges.find(change=>change.table==='frames'&&change.id===sourceFrame.id);
    const before=call?{operation:'Number',input:call.input,siteId:instruction.siteId,index:-1,
      method:null,phase:'select',waitingFrameId:null,result:null}:prior;
    if(!ownChange?.after||event.siteId!==before.siteId)
      fail('Number conversion lost its source continuation');
    const expected=validatePrimitiveConversionAdvance(before,ownChange.after.pendingNumberConversion,
      sourceFrame.id,state,event,programs,fail);
    if(!expected.fault){
      const stack=call?call.prefix:sourceFrame.stack,
        nextStack=expected.method?stack:[...stack,{value:expected.value,origin:event.eventId}];
      if(ownChange.after.pc!==sourceFrame.pc+(call?1:0)||!eq(ownChange.after.stack,nextStack))
        fail('Number conversion changed its suspended operand stack or source pc');
    }
  }
  for(const change of event.stateChanges){
    if(change.table!=='frames'||eq(change.before?.pendingNumberConversion,change.after?.pendingNumberConversion)||change===ownChange)continue;
    const before=change.before?.pendingNumberConversion,after=change.after?.pendingNumberConversion;
    if(!conversionWaiting(before))fail('Number continuation changed outside its source operation');
    validatePrimitiveConversionReturn(before,after,state,event,fail);
    if(after&&(change.before.pc!==change.after.pc||!eq(change.before.stack,change.after.stack)))
      fail('Number callback changed its caller operand stack');
  }
}
