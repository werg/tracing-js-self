// Private source-execution completion facts: a RETURN opcode does not
// necessarily close a guest invocation. The owned frame transition is the
// authority for actual exit after catch/finally routing.
export function normalizeCompletionFacts(bundle) {
  const facts=new Map();
  for(const event of bundle.events){
    if(!['call.return','completion.finally.end','completion.throw'].includes(event.operation))
      continue;
    const frame=event.stateChanges.find(p=>p.table==='frames' &&
      p.id===event.invocationId);
    if(!frame)continue;
    const status=frame.after?.status;
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
