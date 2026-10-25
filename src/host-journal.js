// Structural host-input authority checks over archived mutations only.
// Does not import or invoke the runtime, replay guest code, or claim native/spec correctness.
import { isDeepStrictEqual } from 'node:util';
import {validatePreparedRequest} from './host/validate-request.js';
import {hostOperation,SUBSCRIPTION_CLOSERS} from './host/operations.js';

// Check external scalar and data-graph bytes independently of the runtime and
// production result encoder. Native identities never enter the owned heap.
function canonicalScalar(value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 1) return value[0] === 'null' || value[0] === 'undefined';
  if (value.length !== 2) return false;
  const [kind, payload] = value;
  switch (kind) {
    case 'bool': return typeof payload === 'boolean';
    case 'str': return typeof payload === 'string';
    case 'bigint': return typeof payload === 'string' && /^(0|-?[1-9]\d*)$/.test(payload);
    case 'num':
      return (typeof payload === 'number' && Number.isFinite(payload) &&
        !Object.is(payload, -0)) || ['-0', 'NaN', '+Infinity', '-Infinity'].includes(payload);
    default: return false;
  }
}
function externalGraph(graph,event,fail){
  const bad=message=>fail('External result graph: '+message,event.eventId);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(graph)||Object.keys(graph).sort().join(',')!=='objects,roots,schema'||
      graph.schema!=='owned-graph/1'||!Array.isArray(graph.roots)||graph.roots.length!==1||
      !Array.isArray(graph.objects)||graph.objects.length>256||
      Buffer.byteLength(JSON.stringify(graph))>65536)bad('invalid bounded envelope');
  const identities=new Map();let properties=0;
  for(const node of graph.objects){
    if(!object(node)||typeof node.id!=='string'||! /^[a-z][a-z0-9:_-]*$/.test(node.id)||
       identities.has(node.id)||!['object','array'].includes(node.kind)||
       !Array.isArray(node.properties)||
       !Object.keys(node).every(key=>['id','kind','prototype','properties'].includes(key))||
       Object.hasOwn(node,'prototype')&&(node.kind!=='object'||node.prototype!==null))
      bad('invalid data identity');
    identities.set(node.id,node);
  }
  const value=tag=>{
    if(tag?.[0]==='ref'){
      if(tag.length!==2||!identities.has(tag[1]))bad('dangling external identity');
    }else if(!canonicalScalar(tag))bad('invalid data scalar');
  };
  value(graph.roots[0]);
  for(const node of graph.objects){
    const keys=new Set();
    for(const member of node.properties){
      if(!object(member)||Object.keys(member).sort().join(',')!=='key,value'||
         typeof member.key!=='string'||member.key==='__proto__'||keys.has(member.key)||
         ++properties>4096)bad('invalid property or graph limit');
      keys.add(member.key);value(member.value);
    }
    if(node.kind==='array'){
      const length=node.properties.find(member=>member.key==='length')?.value;
      if(length?.[0]!=='num'||!Number.isSafeInteger(length[1])||length[1]<0||length[1]>4096||
         [...keys].some(key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)>=length[1]))
        bad('invalid array shape');
    }
  }
  return identities;
}

function importedResult(event,input,heap,fail){
  const graph=input.before.graph;
  if(!graph)return {};
  externalGraph(graph,event,fail);
  const identities=input.after?.graphIdentities;
  const nodes=event.stateChanges.filter(patch=>patch.table==='heap');
  const counters=event.stateChanges.filter(patch=>patch.table==='counters');
  if(!Array.isArray(identities)||identities.length!==graph.objects.length||
     nodes.length!==graph.objects.length||counters.length!==(nodes.length?1:0))
    fail('External graph must allocate exactly its delivered identities',event.eventId);
  const mapping=new Map();
  for(const [index,node] of graph.objects.entries()){
    const target='o'+(counters[0].before.obj+index+1);
    if(!isDeepStrictEqual(identities[index],{source:node.id,target})||Object.hasOwn(heap,target))
      fail('External graph cannot overwrite or forge owned identities',event.eventId);
    mapping.set(node.id,target);
  }
  if(nodes.length&&!isDeepStrictEqual(counters[0].after,{...counters[0].before,
      obj:counters[0].before.obj+nodes.length,version:counters[0].before.version+1}))
    fail('External graph allocation counters are inconsistent',event.eventId);
  const translate=tag=>tag[0]==='ref'?['ref',mapping.get(tag[1])]:structuredClone(tag);
  for(const node of graph.objects){
    const id=mapping.get(node.id),patch=nodes.find(item=>item.id===id);
    const properties={},propertyVersions={};
    for(const member of node.properties){
      properties[member.key]={value:translate(member.value),origin:event.eventId};
      propertyVersions[member.key]=0;
    }
    const expected={id,kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
      properties,propertyVersions,shapeVersion:0,version:1};
    if(!patch||patch.before!==null||!isDeepStrictEqual(patch.after,expected))
      fail('External graph allocation differs from immutable arrival bytes',event.eventId);
  }
  return {value:translate(graph.roots[0]),graphIdentities:identities};
}
export function validateHostJournal(bundle, fail) {
  const dispatched = new Set();
  const created = new Set();
  const createdEffects = new Map();
  const arrived = new Map(); // input ID -> effect ID
  const inputForEffect = new Map(); // bounded profile: one input per effect
  const delivered = new Set();
  const heap = structuredClone(bundle.initialState.heap);
  const effectState = structuredClone(bundle.initialState.effects);

  function patches(event, table) {
    return event.stateChanges.filter(p => p.table === table);
  }
  function onlyPatch(event, list, id, label) {
    if (list.length !== 1 || list[0].id !== id)
      fail(`Expected one ${label} mutation`, event.eventId);
    return list[0];
  }
  function cause(event, kind, key) {
    const matches = event.causes.filter(c => c.kind === kind);
    const value = matches[0]?.[key];
    if (matches.length !== 1 || typeof value !== 'string' || !value)
      fail(`Missing or ambiguous ${kind} cause`, event.eventId);
    return value;
  }
  function changedOnly(before, after, changes) {
    return before && after && isDeepStrictEqual(after, {
      ...before, ...changes, version: before.version + 1
    });
  }

  for (const [index,event] of bundle.events.entries()) {
    // Only earlier committed patches supply a request's materialization.
    // A later mutation to the same object must not rewrite this historical payload.
    if(index)for(const [table,target] of [['heap',heap],['effects',effectState]])
      for(const patch of patches(bundle.events[index-1],table)) {
        if(patch.after===null)delete target[patch.id];
        else target[patch.id]=structuredClone(patch.after);
      }
    const effects = patches(event, 'effects');
    const inputs = patches(event, 'inputs');

    if (event.operation === 'call.enter') {
      if (inputs.length || effects.length > 1)
        fail('Unexpected host mutations during call', event.eventId);
      if (!effects.length) {
        if (event.causes.some(c => c.kind === 'effect'))
          fail('Effect cause without effect creation', event.eventId);
        continue;
      }
      const p = effects[0];
      if (p.before !== null || !p.after || p.after.id !== p.id ||
          p.after.dispatch !== 'prepared' || p.after.external !== 'pending' ||
          !Array.isArray(p.after.inputIds) || p.after.inputIds.length ||
          !['promise', 'synchronous'].includes(p.after.kind) ||
          cause(event, 'effect', 'effectId') !== p.id || created.has(p.id))
        fail('Malformed effect creation', event.eventId);
      // Member calls record a receiver-bearing method token; direct calls
      // record the underlying hostfn token. Both denote one precise target.
      const callee=event.operands?.[0];
      const callable=callee?.[0]==='method'&&callee.length===3?callee[1]:callee;
      if(!event.siteId||!event.invocationId||
          p.after.frameId!==event.invocationId||
          !isDeepStrictEqual(callable,['hostfn',p.after.operation])||
          !isDeepStrictEqual(p.after.args,event.operands?.slice(1))||
          !isDeepStrictEqual(p.after.argOrigins,event.operandOrigins?.slice(1)))
        fail('External request differs from originating JS invocation or operands',
          event.eventId);
      try {validatePreparedRequest(heap,p.after);}
      catch(error) {fail(error.message,event.eventId);}
      const persistent=hostOperation(p.after.operation).callbackLifetime==='subscription';
      if(persistent?!isDeepStrictEqual(p.after.subscription,{state:'pending',token:null,closedBy:null}):
          Object.hasOwn(p.after,'subscription'))
        fail('Effect subscription ownership differs from declared callback lifetime',event.eventId);
      created.add(p.id);createdEffects.set(p.id,p.after);
      continue;
    }

    if (event.operation === 'effect.dispatch') {
      const id = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, effects, id, 'dispatch');
      if (inputs.length || !created.has(id) || dispatched.has(id) ||
          p.before?.dispatch !== 'prepared' || p.before?.external !== 'pending' ||
          !changedOnly(p.before, p.after, { dispatch: 'dispatched' }))
        fail('Invalid dispatch transition', event.eventId);
      dispatched.add(id);
      continue;
    }

    if (event.operation === 'external.callback.enqueue') {
      const effectId=cause(event,'effect','effectId');
      const createdEffect=createdEffects.get(effectId);
      const patches=event.stateChanges;
      const control=patches.find(p=>p.table==='control'&&p.id==='a0');
      const queued=control?.after?.queue?.at(-1);
      if(!dispatched.has(effectId)||!createdEffect||
         !(effectState[effectId]?.external==='pending'||
           effectState[effectId]?.external==='completed'&&
           effectState[effectId]?.subscription?.state==='active')||
         patches.length!==1||!control||
         queued?.kind!=='external-callback'||
         queued.effectId!==effectId||
         !hostOperation(createdEffect.operation).callbackIndices?.some(i=>
           createdEffect.args[i]?.[0]==='ref'&&
           createdEffect.args[i][1]===queued.functionId)||
         !isDeepStrictEqual(queued.args,event.operands)||
         !Array.isArray(queued.args)||queued.args.length>32||!queued.args.every(canonicalScalar)||
         !isDeepStrictEqual(control.after.queue.slice(0,-1),control.before?.queue)||
         control.after.version!==control.before.version+1)
        fail('Invalid owned external callback registration',event.eventId);
      continue;
    }

    if (event.operation === 'external.input.arrive') {
      const effectId = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, inputs, inputs[0]?.id, 'input creation');
      const fx = onlyPatch(event, effects, effectId, 'arrival effect');
      if(p.after?.graph){
        if(hostOperation(fx.before?.operation).resultCodec!=='owned-graph/1')
          fail('Operation has no external result graph capability',event.eventId);
        externalGraph(p.after.graph,event,fail);
        if(!isDeepStrictEqual(p.after.value,p.after.graph.roots[0]))
          fail('Arrival graph root differs from the declared result',event.eventId);
      }
      if (!dispatched.has(effectId) || inputForEffect.has(effectId) ||
          p.before !== null || p.after?.id !== p.id ||
          p.after?.effectId !== effectId || p.after.status !== 'arrived' ||
          typeof p.after.abrupt !== 'boolean' || !p.after.graph&&!canonicalScalar(p.after.value) ||
          event.stateChanges.some(patch=>!['counters','inputs','effects'].includes(patch.table)) ||
          arrived.has(p.id) || fx.before?.dispatch !== 'dispatched' ||
          fx.before?.external !== 'pending' ||
          p.after.kind !== (fx.before.kind === 'promise' ? 'completion' : 'immediate') ||
          !Array.isArray(fx.before.inputIds) ||
          !changedOnly(fx.before, fx.after, { inputIds: [...fx.before.inputIds, p.id] }))
        fail('Invalid host arrival linkage', event.eventId);
      arrived.set(p.id, effectId);
      inputForEffect.set(effectId, p.id);
      continue;
    }

    if (event.operation === 'external.input.deliver') {
      const inputId = cause(event, 'input', 'inputId');
      const effectId = cause(event, 'effect', 'effectId');
      const p = onlyPatch(event, inputs, inputId, 'input delivery');
      const fx = onlyPatch(event, effects.filter(patch=>patch.id===effectId),effectId,'delivery effect');
      const imported=importedResult(event,p,heap,fail);
      const subscription=fx.before?.subscription;
      let nextSubscription;
      if(subscription){
        if(subscription.state!=='pending'||subscription.token!==null||subscription.closedBy!==null||
           hostOperation(fx.before.operation).callbackLifetime!=='subscription')
          fail('Invalid pending subscription registration',event.eventId);
        if(!p.before.abrupt&&(p.after.value?.[0]!=='str'||Object.values(effectState).some(other=>
            other.id!==effectId&&other.operation===fx.before.operation&&
            other.subscription?.token&&isDeepStrictEqual(other.subscription.token,p.after.value))))
          fail('Subscription registration requires a unique native string token',event.eventId);
        nextSubscription={state:p.before.abrupt?'closed':'active',
          token:p.before.abrupt?null:p.after.value,closedBy:p.before.abrupt?effectId:null};
      }
      const related=effects.filter(patch=>patch.id!==effectId);
      const registration=SUBSCRIPTION_CLOSERS[fx.before?.operation];
      if(registration&&!p.before.abrupt){
        const targets=Object.values(effectState).filter(other=>other.operation===registration&&
          other.subscription?.token&&isDeepStrictEqual(other.subscription.token,fx.before.args[0]));
        if(targets.length!==1)
          fail('Subscription close token has no unique owned registration',event.eventId);
        const target=targets[0];
        if(target.subscription.state==='active'){
          const closed=onlyPatch(event,related,target.id,'subscription close');
          if(!isDeepStrictEqual(closed.before,target)||!changedOnly(closed.before,closed.after,
              {subscription:{...target.subscription,state:'closed',closedBy:effectId}}))
            fail('Unsubscribe changed a foreign or inconsistent registration',event.eventId);
          const control=patches(event,'control')[0];
          if(control?.after?.queue?.some(job=>job.kind==='external-callback'&&job.effectId===target.id))
            fail('Unsubscribe retained a queued callback for its closed registration',event.eventId);
        }else if(related.length)fail('Already closed subscription mutated again',event.eventId);
      }else if(related.length)fail('Unrelated effect changed at host delivery',event.eventId);
      if(!p.before?.graph&&patches(event,'heap').length)
        fail('Scalar host delivery cannot allocate or mutate owned data',event.eventId);
      if (arrived.get(inputId) !== effectId || delivered.has(inputId) ||
          p.before?.id !== inputId || p.before?.effectId !== effectId ||
          p.before?.status !== 'arrived' ||
          !changedOnly(p.before, p.after, { status: 'delivered',...imported }) ||
          fx.before?.dispatch !== 'dispatched' ||
          fx.before?.external !== 'pending' ||
          !fx.before.inputIds?.includes(inputId) ||
          !changedOnly(fx.before, fx.after, {
            external: p.before.abrupt ? 'rejected' : 'completed',
            ...(subscription?{subscription:nextSubscription}:{}),
            ...(fx.before.kind === 'synchronous' ? { immediate: 'completed' } : {})
          }) ||
          !isDeepStrictEqual(event.result, p.after.value))
        fail('Invalid host delivery transition', event.eventId);
      delivered.add(inputId);
      continue;
    }

    if (effects.length || inputs.length)
      fail('Host records changed outside lifecycle operation', event.eventId);
  }

  for (const fx of Object.values(bundle.effects)) {
    if (!created.has(fx.id) ||
        (fx.dispatch === 'dispatched' && !dispatched.has(fx.id)) ||
        !['prepared', 'dispatched'].includes(fx.dispatch) ||
        !Array.isArray(fx.inputIds) || fx.inputIds.length > 1 ||
        fx.inputIds.some(id => arrived.get(id) !== fx.id) ||
        (fx.external !== 'pending' && !fx.inputIds.some(id => delivered.has(id))))
      fail(`Effect ${fx.id} lifecycle is not journaled`);
  }
  for (const input of Object.values(bundle.inputs)) {
    if (arrived.get(input.id) !== input.effectId ||
        !['arrived', 'delivered'].includes(input.status) ||
        (input.status === 'delivered') !== delivered.has(input.id))
      fail(`Input ${input.id} lifecycle is not journaled`);
  }
}
