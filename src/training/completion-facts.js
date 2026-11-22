// Private source-execution completion facts: a RETURN opcode does not
// necessarily close a guest invocation. The owned frame transition is the
// authority for actual exit after catch/finally routing.
export function normalizeCompletionFacts(bundle,{generators=false}={}) {
  const facts=new Map();
  for(const event of bundle.events){
    if(!['call.return','completion.finally.end','completion.throw','job.enter',
      'completion.catch.bind'].includes(event.operation)&&event.completion?.type!=='throw')
      continue;
    if(event.operation==='job.enter'){
      // Rejected await may unwind the resumed async frame in this same job;
      // no later THROW opcode exists to carry that actual body completion.
      const exited=event.stateChanges.find(p=>p.table==='frames'&&
        p.before?.status==='suspended'&&p.after?.status==='thrown');
      if(exited&&event.completion?.type==='throw'&&Array.isArray(event.completion.value?.value))
        facts.set(event.eventId,{operation:'throw',kind:'throw',value:event.completion.value.value,
          invocation:exited.id,journalEvent:event.eventId});
      continue;
    }
    // A synchronous host rejection resumes its blocked caller on observed
    // delivery, which has no source instruction invocationId of its own.
    let invocation=event.invocationId??(event.operation==='external.input.deliver'?
      event.stateChanges.find(p=>p.table==='effects')?.before?.frameId:null);
    if(generators&&event.operation==='call.enter'&&event.operands?.[0]?.[0]==='method'&&
      ['Generator.return','Generator.throw'].includes(event.operands[0][1]?.[1])){
      const receiver=event.operands[0][2],resumed=receiver?.[0]==='ref'&&event.stateChanges.find(change=>
        change.table==='frames'&&change.after?.generatorId===receiver[1]);
      if(resumed)invocation=resumed.id;
    }
    const frame=event.stateChanges.find(p=>p.table==='frames' && p.id===invocation);
    if(!frame)continue;
    const status=frame.after?.status;
    if(generators&&frame.after?.generatorId){
      // Generator creation/yield use call.return to suspend a retained frame;
      // they do not close it. A final return's event result is the fresh
      // iterator-result object, while its source completion carries the value.
      // Only the explicit shared generator profile can consume these exits.
      const completion=frame.after.completion;
      if(['completed','thrown'].includes(status)&&!['completed','thrown'].includes(frame.before?.status)){
        if(!['return','throw'].includes(completion?.type)||!Array.isArray(completion.value?.value))
          throw new TypeError('Generator exit lacks its exact retained completion');
        facts.set(event.eventId,{operation:completion.type,kind:completion.type,value:completion.value.value,
          invocation,journalEvent:event.eventId});
      }
      else continue;
    }else if(event.operation==='completion.catch.bind'){
      const introduced=event.stateChanges.filter(p=>p.table==='envs'&&p.after &&
        p.before===null).flatMap(p=>Object.entries(p.after.bindings??{}));
      if(introduced.length!==1||introduced[0][1].kind!=='catch'||
         !Array.isArray(introduced[0][1].token?.value))
        throw new TypeError('Catch binding lacks committed owned data cell');
      const [name,binding]=introduced[0];
      facts.set(event.eventId,{operation:'catch-bind',name,
        value:binding.token.value,invocation,
        journalEvent:event.eventId});
      continue;
    }else if(event.operation==='call.return'){
      if(!Array.isArray(event.result))
        throw new TypeError('Completion evidence missing evaluated return value');
      const actual=status==='completed';
      const pending=frame.after?.handlers?.at(-1)?.pending;
      if(!actual && pending?.type!=='return')
        throw new TypeError('Return did not commit or save a pending outcome');
      facts.set(event.eventId,{operation:actual?'return':'transfer',
        kind:'return',value:event.result,
        ...(actual?{}:{handler:'finally'}),
        invocation,journalEvent:event.eventId});
    }else if(event.operation==='completion.finally.end'){
      const pending=frame.before?.handlers?.at(-1)?.pending;
      if(!pending)throw new TypeError('Finally completion lost its prior outcome');
      if(status==='completed'&&pending.type==='return' &&
         Array.isArray(pending.value?.value)){
        facts.set(event.eventId,{operation:'return',kind:'return',
          value:pending.value.value,invocation,
          journalEvent:event.eventId});
      }else if(status==='thrown'&&pending.type==='throw'){
        // The classified error boundary is deliberately a distinct contract:
        // do not synthesize an ordinary data return from a native exception.
        facts.set(event.eventId,{operation:'unhandled-throw',
          ...(Array.isArray(frame.after.completion?.value?.value)?{value:frame.after.completion.value.value}:{}),
          invocation,journalEvent:event.eventId});
      }
    }else if(event.operation==='completion.throw'||event.completion?.type==='throw'){
      const routed=frame.after?.status;
      const input=event.completion?.value?.value??event.operands?.[0];
      if(Array.isArray(input))
        facts.set(event.eventId,{operation:routed==='thrown'?'throw':'transfer',
          kind:'throw',value:input,handler:routed==='thrown'?null:'catch-or-finally',
          invocation,journalEvent:event.eventId});
    }
    const fact=facts.get(event.eventId);
    if(fact&&['throw','unhandled-throw'].includes(fact.operation)){
      // A single owned throw can unwind several synchronous callers. Each
      // completed public frame needs its own exit; emitting only the leaf
      // would leave the selected root permanently open.
      const unwound=event.stateChanges.filter(change=>change.table==='frames'&&
        change.id!==fact.invocation&&change.before?.status!=='thrown'&&
        change.after?.status==='thrown'&&Array.isArray(change.after.completion?.value?.value));
      const byId=new Map(unwound.map(change=>[change.id,change]));
      fact.unwound=[];
      let caller=frame.after?.callerFrameId;
      while(byId.has(caller)){
        const change=byId.get(caller);
        fact.unwound.push({operation:'throw',kind:'throw',
          value:change.after.completion.value.value,invocation:change.id,
          journalEvent:event.eventId});
        caller=change.after.callerFrameId;
      }
      if(fact.unwound.length!==unwound.length)
        throw new Error('Throw unwind frames do not follow the owned caller chain');
    }
  }
  return facts;
}
