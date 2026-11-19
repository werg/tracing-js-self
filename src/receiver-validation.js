// Receiver and new.target reads are proven from retained owned frame identity.
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function validateReceiverEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  for(const patch of event.stateChanges){
    if(patch.table==='frames'&&patch.after?.thisBindingFrameId){
      const owner=state.frames[patch.after.thisBindingFrameId];
      if(!owner||!owner.newTarget||patch.before&&patch.before.thisBindingFrameId!==patch.after.thisBindingFrameId)
        fail('Lexical receiver lost its constructor frame identity');
    }
    if(patch.table==='heap'&&patch.after?.lexicalThisFrameId){
      if(patch.before){
        if(patch.before.lexicalThisFrameId!==patch.after.lexicalThisFrameId)fail('Captured lexical receiver identity changed');
      }else if(instruction?.op!=='MAKE_FUNCTION'||!patch.after.arrow||
        patch.after.lexicalThisFrameId!==(frame.thisBindingFrameId??frame.id)||
        !(frame.thisBindingFrameId||frame.newTarget))fail('Arrow captured an unrelated receiver frame');
    }
  }
  if(!['THIS','NEW_TARGET'].includes(instruction?.op)||event.completion?.type==='throw')return;
  const owner=frame.thisBindingFrameId?state.frames[frame.thisBindingFrameId]:frame;
  const expected=instruction.op==='THIS'?owner.thisValue:owner.newTarget??['undefined'];
  if(!eq(event.result,expected))fail('Receiver or new.target completion disagrees with its owned frame');
}
