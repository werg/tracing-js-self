// Emit real JavaScript for exactly the external calls dispatched by an owned
// run. Guest computation is NOT reconstructed or re-executed.
import {validateBundle} from './validation.js';

/**
 * Compile the immutable, canonical-json/1 external side effects of a
 * validated run into a synchronous JS function body.
 *
 * Usage: new Function('effects',compileExternalEffectsJS(bundle))(handlers)
 *
 * This replays dispatches in order, not asynchronous settlements. The caller
 * supplies effect functions; compiling never invokes them. Handler return
 * values do not feed back into guest execution.
 */
export function compileExternalEffectsJS(bundle){
  validateBundle(bundle);
  const created=new Map(),dispatched=new Set(),calls=[];
  for(const event of bundle.events){
    if(event.operation==='call.enter'){
      for(const patch of event.stateChanges){
        if(patch.table==='effects'&&patch.before===null){
          if(created.has(patch.id))throw new TypeError('Duplicate external effect');
          created.set(patch.id,patch.after);
        }
      }
    }
    if(event.operation!=='effect.dispatch')continue;
    const causes=event.causes.filter(c=>c.kind==='effect');
    if(causes.length!==1||typeof causes[0].effectId!=='string')
      throw new TypeError('Ambiguous effect dispatch');
    const id=causes[0].effectId,fx=created.get(id);
    if(!fx||dispatched.has(id)||fx.request?.codec!=='canonical-json/1')
      throw new TypeError('Missing or duplicate canonical effect dispatch');
    dispatched.add(id);
    // validateBundle has already independently checked the immutable payload
    // against the committed argument graph and operation signature.
    const args=JSON.parse(fx.request.payload);
    if(!Array.isArray(args))throw new TypeError('Invalid materialized arguments');
    calls.push({operation:fx.operation,args});
  }
  const names=[...new Set(calls.map(c=>c.operation))];
  const lines=['"use strict";',
    'if (effects === null || typeof effects !== "object") throw new TypeError("Expected effect handlers");'];
  // Validate all handlers before invoking the first one, so a missing later
  // capability cannot cause partial external execution.
  for(const name of names){
    lines.push('if (typeof effects['+JSON.stringify(name)+'] !== "function") '+
      'throw new TypeError('+JSON.stringify('Missing effect handler: '+name)+');');
  }
  for(const call of calls){
    lines.push('effects['+JSON.stringify(call.operation)+'](...'+
      JSON.stringify(call.args)+');');
  }
  return lines.join('\n')+'\n';
}
