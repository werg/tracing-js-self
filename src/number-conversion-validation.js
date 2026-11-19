// Read-only checks for archived Number callback continuations. This validator
// does not import or execute the owned conversion mutation helper.
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['operation','input','siteId','index','method','phase','waitingFrameId','result'];
export function validateNumberConversionState(state,programs,sites,fail){
  for(const frame of Object.values(state.frames)){
    const pending=frame.pendingNumberConversion;if(pending===undefined)continue;
    if(!pending||Object.keys(pending).length!==fields.length||fields.some(key=>!Object.hasOwn(pending,key))||
      pending.operation!=='Number'||!sites.has(pending.siteId)||![-1,0,1].includes(pending.index)||
      !['waiting','returned'].includes(pending.phase)||pending.input?.[0]!=='ref'||
      !['object','array'].includes(state.heap[pending.input[1]]?.kind)||pending.method?.[0]!=='ref')
      fail('Invalid Number conversion continuation fields');
    const method=state.heap[pending.method[1]],child=state.frames[pending.waitingFrameId];
    if(method?.kind!=='function'||method.async||programs[method.codeId]?.generator||
      !child||child.callerFrameId!==frame.id||child.codeId!==method.codeId||
      !eq(child.thisValue,method.arrow?method.lexicalThis:pending.input))
      fail('Number conversion callback identity or receiver mismatch');
    if(pending.phase==='waiting'?(pending.result!==null||['completed','thrown','unsupported'].includes(child.status)):
      (child.status!=='completed'||!Array.isArray(pending.result)||!eq(child.completion?.value?.value,pending.result)))
      fail('Number conversion callback completion phase mismatch');
  }
}
export function validateNumberConversionEvent(state,event,programs,fail){
  const changes=event.stateChanges.filter(change=>change.table==='frames'&&
    !eq(change.before?.pendingNumberConversion,change.after?.pendingNumberConversion));
  const sourceFrame=state.frames[event.invocationId],instruction=programs[sourceFrame?.codeId]?.instructions[sourceFrame?.pc];
  for(const change of changes){
    const before=change.before?.pendingNumberConversion,after=change.after?.pendingNumberConversion;
    if(!before){
      const raw=event.operands[0],callee=raw?.[0]==='method'?raw[1]:raw;
      if(event.operation!=='call.enter'||instruction?.op!=='CALL'||change.id!==event.invocationId||
        !eq(callee,['intrinsic','Number'])||!eq(after.input,event.operands[1])||after.siteId!==event.siteId||after.phase!=='waiting')
        fail('Number continuation was created outside its source call');
    }else if(before.phase==='waiting'&&after){
      const child=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===before.waitingFrameId)?.after;
      if(after.phase!=='returned'||!eq({...after,phase:'waiting',result:null},before)||
        child?.status!=='completed'||!eq(child.completion?.value?.value,after.result))
        fail('Number callback did not retain its actual return value');
    }else if(before.phase==='waiting'){
      const child=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===before.waitingFrameId)?.after;
      if(child?.status!=='thrown')fail('Number callback continuation disappeared before completion');
    }else{
      if(event.operation!=='intrinsic.number.resume'||event.invocationId!==change.id||event.siteId!==before.siteId)
        fail('Number continuation resumed outside its source operation');
      if(after&&(!eq(after.input,before.input)||after.siteId!==before.siteId||after.phase!=='waiting'||
        before.index!==0||after.index!==1||after.waitingFrameId===before.waitingFrameId))
        fail('Number fallback selected an invalid successor callback');
    }
    if(after?.phase==='waiting'){
      const childPatch=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===after.waitingFrameId),
        child=childPatch?.after,program=programs[child?.codeId],
        environment=event.stateChanges.find(patch=>patch.table==='envs'&&patch.id===child?.envId)?.after,
        args=after.index===-1?[['str','number']]:[];
      if(childPatch?.before!==null||!program||!environment||
        !event.causes.some(cause=>cause.kind==='invocation'&&cause.frameId===child.id))
        fail('Number callback did not enter a fresh invocation');
      for(const [index,name] of program.params.entries()){
        const binding=environment.bindings[name],expected=args[index]??['undefined'];
        if(binding?.kind!=='parameter'||binding.initialized===!!program.parameterExpressions)
          fail('Number callback parameter initialization mismatch');
        if(index===(program.restIndex??-1)){
          const tag=binding.token?.value,array=tag?.[0]==='ref'&&event.stateChanges.find(patch=>patch.table==='heap'&&patch.id===tag[1])?.after,
            extras=args.slice(index);
          if(array?.kind!=='array'||!eq(array.properties.length?.value,['num',extras.length])||
            extras.some((value,i)=>!eq(array.properties[String(i)]?.value,value)))
            fail('Number callback rest arguments mismatch');
        }else if(!eq(binding.token?.value,expected))fail('Number callback arguments or conversion hint mismatch');
      }
    }
  }
  if(event.operation==='intrinsic.number.resume'&&
    (!sourceFrame?.pendingNumberConversion||sourceFrame.pendingNumberConversion.phase!=='returned'))
    fail('Number resume has no returned callback');
}
