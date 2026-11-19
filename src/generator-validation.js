// Read-only linkage checks for retained owned generator continuations.
export function validateGeneratorState(state,programs,fail,ids=null){
  for(const generator of ids?[...ids].map(id=>state.heap[id]):Object.values(state.heap)){
    if(generator.kind!=='generator')continue;
    const frame=state.frames[generator.frameId],program=programs[frame?.codeId];
    if(!frame||!program?.generator||frame.generatorId!==generator.id||frame.asyncPromiseId!==null||
       !['initializing','executing','suspendedStart','suspendedYield','completed'].includes(generator.state))
      fail('Invalid owned generator continuation identity');
    if(['suspendedStart','suspendedYield'].includes(generator.state)){
      if(frame.status!=='suspended-generator'||frame.callerFrameId!==null||frame.completion?.type!=='return')
        fail('Generator suspension lost its retained frame');
      const previous=program.instructions[frame.pc-1]?.op;
      if(previous!==(generator.state==='suspendedStart'?'GENERATOR_START':frame.delegateYield?'DELEGATE_YIELD':'YIELD'))
        fail('Generator suspension has the wrong source cursor');
    }else if(generator.state==='completed'){
      if(!['completed','thrown'].includes(frame.status))fail('Completed generator has an active continuation');
    }else if(frame.status!=='running')fail('Running generator has no active frame state');
    if(frame.delegateResume&&(!['next','return','throw'].includes(frame.delegateResume.kind)||
       !Array.isArray(frame.delegateResume.value?.value)||generator.state!=='executing'))
      fail('Invalid delegated generator resume completion');
  }
}

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Resume and suspension evidence is checked before applying archive patches. */
export function validateGeneratorEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const after=id=>event.stateChanges.find(p=>p.table==='frames'&&p.id===id)?.after;
  if(instruction?.op==='DELEGATE_YIELD'){
    const value=frame.stack.at(-1)?.value,next=after(frame.id);
    if(!next?.delegateYield||next.status!=='suspended-generator'||next.callerFrameId!==null||
       !same(event.result,value)||!same(next.completion?.value,{value,origin:event.eventId}))
      fail('Delegated yield lost its exact iterator result identity');
  }
  if(instruction?.op==='DELEGATE_RESUME_KIND'){
    if(!frame.delegateResume||!same(event.result,['str',frame.delegateResume.kind])||
       !same(after(frame.id)?.delegateResume,frame.delegateResume))
      fail('Delegated resume kind disagrees with retained completion');
  }
  if(instruction?.op==='DELEGATE_RESUME_VALUE'){
    if(!frame.delegateResume||!same(event.result,frame.delegateResume.value.value)||after(frame.id)?.delegateResume!==undefined)
      fail('Delegated resume value was not consumed exactly once');
  }
  const method=event.operands[0];
  if(instruction?.op==='CALL'&&method?.[0]==='method'&&method[1]?.[0]==='builtinfn'&&
     ['Generator.next','Generator.return','Generator.throw'].includes(method[1][1])){
    const generator=method[2]?.[0]==='ref'?state.heap[method[2][1]]:null,target=state.frames[generator?.frameId];
    if(generator?.state!=='suspendedYield'||!target?.delegateYield)return;
    const next=after(target.id),sent={value:event.operands[1]??['undefined'],origin:event.operandOrigins[1]??event.eventId};
    if(!next||next.delegateYield!==undefined||next.pc!==target.pc||!same(next.stack,target.stack)||
       !same(next.delegateResume,{kind:method[1][1].slice('Generator.'.length),value:sent})||event.completion)
      fail('Delegated generator completion was not forwarded intact');
  }
}
