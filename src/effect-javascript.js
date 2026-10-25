// The only JS emitter for externally visible calls. The guest interpreter
// remains responsible for all computations, callbacks and promise continuations.
import {validateBundle} from './validation.js';
import {hostOperation} from './host/operations.js';

const quote=JSON.stringify;
const fail=message=>{throw new TypeError('Executable effects: '+message);};

function argumentsJS(fx) {
  const spec=hostOperation(fx.operation);
  const request=fx.request;
  if(!request||request.schema!=='host-request/1'||
     request.codec!=='canonical-json/1'||
     request.operation!==fx.operation||request.signature!==spec.signature)
    fail('unregistered canonical host request');
  let args;
  try{args=JSON.parse(request.payload);}catch{fail('invalid canonical payload');}
  if(!Array.isArray(args)||args.length!==spec.arity||
     JSON.stringify(args)!==request.payload)
    fail('noncanonical effect payload');
  const rendered=args.map((value,index)=>{
    if(!spec.callbackIndices?.includes(index))return quote(value);
    const keys=value&&typeof value==='object'&&!Array.isArray(value)?
      Object.keys(value):[];
    const callbackId=value?.$ownedCallback;
    if(keys.length!==1||keys[0]!=='$ownedCallback'||
       typeof callbackId!=='string'||!/^o[1-9][0-9]*$/.test(callbackId))
      fail('invalid owned callback token');
    return 'bridge.callback('+quote(fx.id)+','+quote(callbackId)+')';
  });
  return {rendered,hasCallback:(spec.callbackIndices?.length??0)>0};
}

/** Re-execute the *external side effects* in an already validated archive.
 * Never call guest JS in the native engine. To reenter a guest callback, supply
 * bridge.callback(effectId,callbackId), which MUST deliver to the owned VM.
 * This is not interpreter replay; invoking it can repeat real side effects.
 */
export function compileExternalEffectsJS(bundle){
  validateBundle(bundle);
  const created=new Map(),seen=new Set(),calls=[];
  for(const event of bundle.events){
    if(event.operation==='call.enter')
      for(const patch of event.stateChanges)
        if(patch.table==='effects'&&patch.before===null){
          if(created.has(patch.id))fail('duplicate effect creation');
          created.set(patch.id,patch.after);
        }
    if(event.operation!=='effect.dispatch')continue;
    const causes=event.causes.filter(c=>c.kind==='effect');
    if(causes.length!==1)fail('ambiguous effect dispatch');
    const id=causes[0].effectId,fx=created.get(id);
    if(!fx||seen.has(id))fail('missing or duplicate canonical effect dispatch');
    seen.add(id);
    calls.push({fx,...argumentsJS(fx)});
  }
  const names=[...new Set(calls.map(c=>c.fx.operation))];
  const lines=['"use strict";',
    'if(!effects||typeof effects!=="object")throw new TypeError("Expected effect handlers");'];
  for(const name of names)
    lines.push('if(typeof effects['+quote(name)+']!=="function")throw new TypeError('+
      quote('Missing effect handler: '+name)+');');
  if(calls.some(c=>c.hasCallback))
    lines.push('if(!bridge||typeof bridge.callback!=="function")throw new TypeError("Missing owned callback bridge");');
  for(const {fx,rendered} of calls)
    lines.push('effects['+quote(fx.operation)+'](...['+rendered.join(',')+']);');
  return lines.join('\n')+'\n';
}

/** Emit one live effect invocation after the owned VM journals dispatch.
 *
 * new Function('effects','bridge',source)(handlers,bridge)
 *
 * bridge.settle receives both synchronous outcomes and native Promise
 * fulfillment/rejection. bridge.callback creates only host trampolines;
 * their bodies must be queued back into the owned VM, not run here.
 */
export function compilePendingEffectJS(runtime,effectId){
  const fx=runtime?.state?.effects?.[effectId];
  if(!fx||fx.id!==effectId||fx.dispatch!=='dispatched'||
     fx.external!=='pending')
    fail('expected an owned, already-dispatched pending effect');
  const {rendered,hasCallback}=argumentsJS(fx);
  const operation=quote(fx.operation),id=quote(effectId);
  return [
    '"use strict";',
    'if(!effects||typeof effects['+operation+']!=="function")throw new TypeError("Missing effect handler");',
    'if(!bridge||typeof bridge.settle!=="function"'+
      (hasCallback?'||typeof bridge.callback!=="function"':'')+
      ')throw new TypeError("Missing owned effect bridge");',
    'let outcome;',
    'try{outcome=effects['+operation+'](...['+rendered.join(',')+']);}',
    'catch(error){bridge.settle('+id+',String(error&&error.message||error),true);return;}',
    'Promise.resolve(outcome).then(',
    '  value=>bridge.settle('+id+',value,false),',
    '  error=>bridge.settle('+id+',String(error&&error.message||error),true)',
    ');'
  ].join('\n')+'\n';
}

/** Standalone, synchronous API for a caller operating an owned VM directly.
 * Call runtime.drive() at a legal point after callback enqueue/delivery. The
 * native callback only QUEUES the original owned function; its return value
 * is undefined and must not be used as a native synchronous guest return.
 */
export function createOwnedEffectBridge(runtime){
  if(!runtime||typeof runtime.recordInputArrival!=='function'||
     typeof runtime.deliverInput!=='function'||
     typeof runtime.recordExternalCallback!=='function')
    fail('expected an owned runtime');
  const received=new Set();
  return Object.freeze({
    callback(effectId,callbackId){
      const fx=runtime.state.effects[effectId];
      if(!fx||fx.external!=='pending'||fx.dispatch!=='dispatched')
        fail('callback effect is not pending');
      return (...args)=>{
        runtime.recordExternalCallback({effectId,callbackId,args});
        return undefined;
      };
    },
    settle(effectId,value,abrupt=false){
      if(received.has(effectId))fail('duplicate settlement');
      const fx=runtime.state.effects[effectId];
      if(!fx||fx.dispatch!=='dispatched'||fx.external!=='pending')
        fail('effect not pending in this owned runtime');
      if(typeof abrupt!=='boolean')fail('invalid settlement status');
      received.add(effectId);
      try{
        const {inputId}=runtime.recordInputArrival({effectId,
          kind:fx.kind==='promise'?'completion':'immediate',value,abrupt});
        runtime.deliverInput(inputId);
      }catch(error){received.delete(effectId);throw error;}
    }
  });
}
