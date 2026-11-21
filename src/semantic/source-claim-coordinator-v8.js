// Teacher-only ownership planning. Claims receive immutable current-prefix
// data, never a controller, journal, emit function, or a later owned event.
import {types} from 'node:util';
export const SOURCE_CLAIM_COORDINATOR_V8='semantic-source-claim-coordinator/1';
const kinds=new Set(['value','allocation','event','completion']);
function fail(message){const error=new TypeError('Source ownership: '+message);
  error.category='unsupported.source-ownership';throw error;}

export function immutableSourceDataV8(value){
  const active=new Set();
  function visit(value){
    if(value===null||['undefined','string','number','boolean','bigint'].includes(typeof value))return value;
    if(typeof value!=='object'||types.isProxy(value)||active.has(value)||
      ![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)))
      fail('claim views and plans must contain only acyclic plain data');
    active.add(value);
    const result=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));
    for(const key of Reflect.ownKeys(value)){
      if(Array.isArray(value)&&key==='length')continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))
        fail('claim views and plans cannot contain accessors or hidden properties');
      Object.defineProperty(result,key,{value:visit(descriptor.value),enumerable:true,writable:true,configurable:true});
    }
    active.delete(value);return Object.freeze(result);
  }
  return visit(value);
}

export function createSourceClaimCoordinatorV8(components){
  if(!Array.isArray(components)||types.isProxy(components)||!components.length)fail('an explicit component registry is required');
  // Snapshot registration before planning. Descriptors are inspected only
  // after transparent proxies have been rejected, so registration cannot run
  // a getter/trap or change the owner registry between events.
  function record(value,label){
    if(!value||typeof value!=='object'||types.isProxy(value)||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(label+' must be an ordinary data record');
    const result={};
    for(const key of Reflect.ownKeys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))
        fail(label+' cannot contain accessors or hidden properties');
      Object.defineProperty(result,key,{value:descriptor.value,enumerable:true});
    }
    return result;
  }
  const registry=[],ids=new Set();
  for(let index=0;index<components.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(components,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('component registry cannot contain holes or accessors');
    const source=record(descriptor.value,'source component');
    if(typeof source.id!=='string'||!source.id)fail('component identities must be unique');
    const component={...source,
      claims:Object.freeze(record(source.claims??{},'source claims')),
      prepare:Object.freeze(record(source.prepare??{},'source preparations'))};
    registry.push(Object.freeze(component));
  }
  registry.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  for(const component of registry){
    if(typeof component?.id!=='string'||!component.id||ids.has(component.id))fail('component identities must be unique');
    ids.add(component.id);
    for(const [method,kind]of [['tag','value'],['allocation','allocation'],['event','event'],['completion','completion']])
      if(component[method]!==undefined&&(typeof component[method]!=='function'||typeof component.claims?.[kind]!=='function'))
        fail('source handlers require declarative claims: '+component.id+'/'+method);
    for(const [kind,claim]of Object.entries(component.claims??{})){
      if(!kinds.has(kind)||typeof claim!=='function'||typeof component.prepare?.[kind]!=='function')
        fail('each supported slot needs a declarative claim and preparation: '+component.id+'/'+kind);
    }
  }
  function plan(request){
    const {view,slots}=immutableSourceDataV8(request);
    if(!Array.isArray(slots)||slots.length>16384)fail('invalid current-event slot inventory');
    const frozenView=view,seen=new Set(),owners=[];
    // Resolve the whole supplied inventory before invoking even a pure
    // preparation function. There is no priority, last-wins, or base fallback.
    for(const slot of slots){
      if(typeof slot?.id!=='string'||!slot.id||seen.has(slot.id)||!kinds.has(slot.kind))
        fail('slot identities must be unique and typed');
      seen.add(slot.id);
      const input=slot.input,claimed=[];
      for(const component of registry){
        const claim=component.claims?.[slot.kind];if(!claim)continue;
        const accepted=claim(frozenView,input);
        if(typeof accepted!=='boolean')fail('claim must return a boolean: '+component.id+'/'+slot.id);
        if(accepted)claimed.push(component);
      }
      if(claimed.length!==1)fail((claimed.length?'ambiguous':'missing')+' owner for '+slot.kind+' '+slot.id+
        (claimed.length?': '+claimed.map(component=>component.id).join(', '):'')+
        (slot.kind==='event'&&slot.input?.event?` at ${slot.input.event.operation}/${slot.input.event.invocationId}/${slot.input.event.eventId}`:''));
      owners.push({id:slot.id,kind:slot.kind,input,component:claimed[0]});
    }
    return Object.freeze(owners.map(({id,kind,input,component})=>{
      const prepared=component.prepare[kind](frozenView,input);
      if(prepared===false||prepared===null||prepared===undefined)
        fail('claimed slot has no prepared transition: '+component.id+'/'+id);
      return Object.freeze({id,kind,owner:component.id,input,prepared:immutableSourceDataV8(prepared)});
    }));
  }
  return Object.freeze({schema:SOURCE_CLAIM_COORDINATOR_V8,ids:Object.freeze([...ids]),plan});
}
