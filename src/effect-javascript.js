// JavaScript effect dispatch compilation. No guest JS program reconstruction.
import {validateBundle} from './validation.js';

const quote=JSON.stringify;
const fail=message=>{throw new TypeError('Executable effects: '+message);};

/**
 * Emit a JS function body for already-recorded external dispatches. This is
 * intentionally a re-execution of external operations, NOT runtime replay:
 * there is no live guest to receive results. Only canonical JSON arguments
 * can be reified. Callback-bearing guest values are not supported.
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
    if(!fx||seen.has(id)||fx.request?.codec!=='canonical-json/1')
      fail('missing or duplicate canonical effect dispatch');
    seen.add(id);
    calls.push({operation:fx.operation,args:JSON.parse(fx.request.payload)});
  }
  const names=[...new Set(calls.map(c=>c.operation))];
  const lines=['"use strict";',
    'if (!effects || typeof effects !== "object") throw new TypeError("Expected effect handlers");'];
  // Preflight before executing any effects.
  for(const name of names)lines.push('if (typeof effects['+quote(name)+
    '] !== "function") throw new TypeError('+quote('Missing effect handler: '+name)+');');
  for(const {operation,args} of calls)
    lines.push('effects['+quote(operation)+'](...'+quote(args)+');');
  return lines.join('\n')+'\n';
}

/**
 * Generate one *live* external invocation. The corresponding effect must
 * already have been dispatched (and therefore journaled) by the owned VM.
 * The returned string is a function body, not a module or closure.
 *
 * new Function('effects','bridge',code)(services,createOwnedEffectBridge(runtime))
 *
 * Async service promises and synchronous completions are fed to the owned
 * runtime exactly once; never resume guest execution inside a native callback.
 */
export function compilePendingEffectJS(runtime,effectId){
  const fx=runtime?.state?.effects?.[effectId];
  if(!fx||fx.id!==effectId||fx.dispatch!=='dispatched'||
     fx.external!=='pending'||fx.request?.codec!=='canonical-json/1'||
     typeof fx.operation!=='string'||typeof fx.request.payload!=='string')
    fail('expected an owned, already-dispatched pending effect');
  let args;
  try{args=JSON.parse(fx.request.payload);}catch{fail('invalid canonical payload');}
  if(!Array.isArray(args)||JSON.stringify(args)!==fx.request.payload)
    fail('noncanonical effect payload');
  // This codec is data-only. A callback may not be serialized to null,
  // silently dropped, or run natively as a substitute for an owned function.
  if(fx.args.some(arg=>!Array.isArray(arg)||
      !['str','bool','num','null','ref'].includes(arg[0])))
    fail('unsupported callback or non-JSON guest argument');
  const operation=quote(fx.operation),id=quote(effectId);
  return [
    '"use strict";',
    'if (!effects || typeof effects['+operation+'] !== "function") throw new TypeError("Missing effect handler");',
    'if (!bridge || typeof bridge.settle !== "function") throw new TypeError("Missing owned settlement bridge");',
    'let outcome;',
    'try { outcome=effects['+operation+'](...'+fx.request.payload+'); }',
    'catch (error) { bridge.settle('+id+',String(error && error.message || error),true); return; }',
    'Promise.resolve(outcome).then(',
    '  value=>bridge.settle('+id+',value,false),',
    '  error=>bridge.settle('+id+',String(error && error.message || error),true)',
    ');'
  ].join('\n')+'\n';
}

/**
 * Authoritative one-shot return channel into the existing owned runtime.
 * Call runtime.drive() yourself at legal service points after a settlement.
 * The bridge does not invoke unowned JS callbacks or allow reentry while an
 * adapter is running; callback-capable APIs still need an owned callback ABI.
 */
export function createOwnedEffectBridge(runtime){
  if(!runtime||typeof runtime.recordInputArrival!=='function'||
     typeof runtime.deliverInput!=='function')fail('expected an owned runtime');
  const received=new Set();
  return Object.freeze({
    settle(effectId,value,abrupt=false){
      if(received.has(effectId))fail('duplicate settlement');
      const fx=runtime.state.effects[effectId];
      if(!fx||fx.dispatch!=='dispatched'||fx.external!=='pending')
        fail('effect not pending in this owned runtime');
      if(typeof abrupt!=='boolean')fail('invalid settlement status');
      received.add(effectId);
      try {
        const {inputId}=runtime.recordInputArrival({effectId,
          kind:fx.kind==='promise'?'completion':'immediate',value,abrupt});
        runtime.deliverInput(inputId);
      }catch(error){received.delete(effectId);throw error;}
    }
  });
}
