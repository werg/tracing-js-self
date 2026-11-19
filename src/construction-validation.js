// Read-only receiver initialization and retained construction linkage checks.
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=tag=>['ref','promise','intrinsic','builtinfn','hostfn'].includes(tag?.[0]);
export function validateConstructionEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const after=id=>event.stateChanges.find(p=>p.table==='frames'&&p.id===id)?.after??state.frames[id];
  for(const patch of event.stateChanges)if(patch.table==='frames'&&patch.after?.constructKind){
    const value=patch.after,constructor=state.heap[value.constructorId]??event.stateChanges.find(p=>p.table==='heap'&&p.id===value.constructorId)?.after;
    if(constructor?.kind!=='function'||constructor.codeId!==value.codeId||value.newTarget?.[0]!=='ref'||
       (state.heap[value.newTarget[1]]??event.stateChanges.find(p=>p.table==='heap'&&p.id===value.newTarget[1])?.after)?.kind!=='function')
      fail('Construction frame lost constructor or newTarget identity');
    if(value.constructKind==='base'){
      if(!value.thisInitialized||!eq(value.thisValue,value.constructReceiver))fail('Base construction lost its allocated receiver');
    }else if(value.constructKind==='derived'){
      if(!constructor.derivedConstructor||typeof value.thisInitialized!=='boolean'||!Array.isArray(value.constructorArguments)||
         !value.thisInitialized&&!eq(value.thisValue,['undefined']))fail('Derived construction has an invalid receiver state');
    }else fail('Unknown constructor kind');
    if(patch.before&&(!eq(patch.before.newTarget,value.newTarget)||patch.before.constructorId!==value.constructorId||patch.before.constructKind!==value.constructKind))
      fail('Retained constructor identity changed');
    if(patch.before?.thisInitialized!==value.thisInitialized&&patch.before&&instruction?.op!=='SUPER_BIND')
      fail('Derived this initialized outside super binding');
  }
  if(instruction?.op==='SUPER_BIND'){
    const owner=frame.thisBindingFrameId?state.frames[frame.thisBindingFrameId]:frame,value=frame.stack.at(-1)?.value;
    if(owner.constructKind!=='derived'||!object(value))fail('Super binding has no derived object result');
    if(owner.thisInitialized){
      if(event.completion?.errorType!=='ReferenceError'||!eq(after(owner.id).thisValue,owner.thisValue))fail('Repeated super binding failed to preserve the existing receiver');
      return;
    }
    if(!after(owner.id).thisInitialized||!eq(after(owner.id).thisValue,value))fail('Super result did not initialize the receiver');
    const constructor=state.heap[owner.constructorId];
    if(constructor.instanceInitializer){
      const invocation=event.causes.find(c=>c.kind==='invocation')?.frameId,initializer=after(invocation);
      if(!initializer||initializer.codeId!==state.heap[constructor.instanceInitializer[1]].codeId||
         !eq(initializer.thisValue,value)||!eq(initializer.superInitializedResult,value)||initializer.callerFrameId!==frame.id)
        fail('Derived fields lost their post-super initialization continuation');
    }else if(!eq(event.result,value))fail('Super completion lost its receiver');
  }
  if(instruction?.op==='THIS'){
    const owner=frame.thisBindingFrameId?state.frames[frame.thisBindingFrameId]:frame;
    if(owner.thisInitialized===false&&event.completion?.errorType!=='ReferenceError')fail('Uninitialized derived this did not throw');
  }
}
