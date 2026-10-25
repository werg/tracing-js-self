// Private source-execution completion facts: a RETURN opcode does not
// necessarily close a guest invocation. The owned frame transition is the
// authority for actual exit after catch/finally routing.
export function normalizeCompletionFacts(bundle) {
  const facts=new Map();
  for(const event of bundle.events){
    if(!['call.return','completion.finally.end','completion.throw','job.enter',
      'completion.catch.bind'].includes(event.operation))
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
    const frame=event.stateChanges.find(p=>p.table==='frames' &&
      p.id===event.invocationId);
    if(!frame)continue;
    const status=frame.after?.status;
    if(event.operation==='completion.catch.bind'){
      const introduced=event.stateChanges.filter(p=>p.table==='envs'&&p.after &&
        p.before===null).flatMap(p=>Object.entries(p.after.bindings??{}));
      if(introduced.length!==1||introduced[0][1].kind!=='catch'||
         !Array.isArray(introduced[0][1].token?.value))
        throw new TypeError('Catch binding lacks committed owned data cell');
      const [name,binding]=introduced[0];
      facts.set(event.eventId,{operation:'catch-bind',name,
        value:binding.token.value,invocation:event.invocationId,
        journalEvent:event.eventId});
      continue;
    }
    if(event.operation==='call.return'){
      if(!Array.isArray(event.result))
        throw new TypeError('Completion evidence missing evaluated return value');
      const actual=status==='completed';
      const pending=frame.after?.handlers?.at(-1)?.pending;
      if(!actual && pending?.type!=='return')
        throw new TypeError('Return did not commit or save a pending outcome');
      facts.set(event.eventId,{operation:actual?'return':'transfer',
        kind:'return',value:event.result,
        ...(actual?{}:{handler:'finally'}),
        invocation:event.invocationId,journalEvent:event.eventId});
    }else if(event.operation==='completion.finally.end'){
      const pending=frame.before?.handlers?.at(-1)?.pending;
      if(!pending)throw new TypeError('Finally completion lost its prior outcome');
      if(status==='completed'&&pending.type==='return' &&
         Array.isArray(pending.value?.value)){
        facts.set(event.eventId,{operation:'return',kind:'return',
          value:pending.value.value,invocation:event.invocationId,
          journalEvent:event.eventId});
      }else if(status==='thrown'&&pending.type==='throw'){
        // The classified error boundary is deliberately a distinct contract:
        // do not synthesize an ordinary data return from a native exception.
        facts.set(event.eventId,{operation:'unhandled-throw',
          ...(Array.isArray(frame.after.completion?.value?.value)?{value:frame.after.completion.value.value}:{}),
          invocation:event.invocationId,journalEvent:event.eventId});
      }
    }else if(event.operation==='completion.throw'){
      const routed=frame.after?.status;
      const input=event.operands?.[0]??event.completion?.value?.value;
      if(Array.isArray(input))
        facts.set(event.eventId,{operation:routed==='thrown'?'throw':'transfer',
          kind:'throw',value:input,handler:routed==='thrown'?null:'catch-or-finally',
          invocation:event.invocationId,journalEvent:event.eventId});
    }
  }
  return facts;
}
