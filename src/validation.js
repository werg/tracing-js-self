import {validateGeneratorState,validateGeneratorEvent} from './generator-validation.js';
import {validatePrivateEvent} from './private-validation.js';
import {validateTemplateEvent} from './template-validation.js';
import {validateEnumerationEvent} from './enumeration-validation.js';
import {validateReceiverEvent} from './receiver-validation.js';
import {validateCallAdapterEvent} from './call-adapter-validation.js';
import {validateConstructionEvent} from './construction-validation.js';
import {validateSuperEvent} from './super-validation.js';
import {isBinaryMemoryKind,validateBinaryMemoryState,validateBinaryMemoryEvent} from './binary-memory-validation.js';
import {validateNumberConversionState,validateNumberConversionEvent} from './number-conversion-validation.js';
import {validatePropertyKeyConversionState,validatePropertyKeyConversionEvent} from './property-key-conversion-validation.js';
import {validatePromiseResolutionState,validatePromiseResolutionEvent} from './promise-resolution-validation.js';
import {validateScriptSequenceState,validateScriptSequenceEvent} from './script-validation.js';
import {validateScriptHostEvent} from './script-host-validation.js';
import {validateExternalCallbackJob,validateExternalCallbackEntry} from './external-callback-validation.js';
// Read-only validation. Does not import the evaluator or call its mutation routines.
import { readFileSync } from 'node:fs';
import {validateSymbolReferences,validateSymbolAllocation} from './symbol-validation.js';
import { validateHostJournal } from './host-journal.js';
import { validateSpecEvent, applySpecCommand } from './spec-validation.js';
const clone = x => structuredClone(x);
const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const operations = JSON.parse(readFileSync(new URL('../catalog/operations.json',import.meta.url),'utf8'));
const known = new Set(operations.entries.map(e=>e.operationId));
// Independently declared constructor paths which complete, throw or refuse
// through their own algorithms before the generic unsupported fallback.
const handledConstructors=new Set(['Symbol','Error','EvalError','RangeError','ReferenceError',
  'SyntaxError','TypeError','URIError','Promise','Set','ArrayBuffer','SharedArrayBuffer','DataView',
  'Int8Array','Uint8Array','Int16Array','Uint16Array','Int32Array','Uint32Array',
  'BigInt64Array','BigUint64Array','Float32Array','Float64Array']);
export class TraceValidationError extends Error {
  constructor(message,eventId=null){super(eventId?`${message} at ${eventId}`:message);this.name='TraceValidationError';this.eventId=eventId;}
}
function fail(message,eventId=null){throw new TraceValidationError(message,eventId);}
// A bounded-profile stop is not a guest throw. Check its owning instruction and
// complete terminal transition independently before accepting that distinction.
function validateUnsupportedCompletion(state,event,programs){
  const control=state.control.a0,frame=state.frames[event.invocationId];
  const instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  if(!frame||control.activeFrameId!==frame.id||frame.status!=='running'||
     event.codeId!==frame.codeId||instruction?.siteId!==event.siteId)
    fail('Unsupported completion lacks its active instruction',event.eventId);
  let consumed,feature;
  if(event.operation==='execution.unsupported'&&instruction.op==='UNSUPPORTED_EXPRESSION'){
    consumed=0;feature=instruction.arg;
  }else if(event.operation==='object.construct'&&instruction.op==='CONSTRUCT'&&
      Number.isSafeInteger(instruction.arg)&&instruction.arg>=0){
    consumed=instruction.arg+1;
    const constructor=frame.stack.at(-consumed)?.value;
    if(constructor?.[0]!=='intrinsic'&&
       !(constructor?.[0]==='ref'&&state.heap[constructor[1]]?.kind==='proxy'))
      fail('Unsupported constructor lacks its owned input',event.eventId);
    if(constructor[0]==='intrinsic'&&handledConstructors.has(constructor[1]))
      fail('Owned constructor cannot become a generic unsupported completion',event.eventId);
    feature='Constructor requires owned semantics: '+String(constructor[1]);
  }else if(event.operation==='property.read'&&['GET_PROP','GET_METHOD'].includes(instruction.op)&&
      eq(frame.stack.at(-2)?.value,['intrinsic','Math'])&&
      eq(frame.stack.at(-1)?.value,['str','random'])&&!Number.isInteger(control.randomSeed)){
    consumed=2;feature='Math.random requires an explicit deterministic fixture seed';
  }else fail('Unsupported completion is not an owned profile stop',event.eventId);
  const completion={type:'unsupported',feature};
  const operands=consumed?frame.stack.slice(-consumed):[];
  if(typeof feature!=='string'||!feature||frame.stack.length<consumed||
     !eq(event.completion,completion)||!eq(event.operands,operands.map(token=>token.value))||
     !eq(event.operandOrigins,operands.map(token=>token.origin))||event.result!==null||
     !eq(event.causes,[])||!eq(event.readObservations,[])||event.stateChanges.length!==2)
    fail('Invalid owned unsupported completion',event.eventId);
  const framePatch=event.stateChanges.find(p=>p.table==='frames'&&p.id===frame.id);
  const controlPatch=event.stateChanges.find(p=>p.table==='control'&&p.id==='a0');
  if(!eq(framePatch?.after,{...frame,pc:frame.pc+1,
       stack:frame.stack.slice(0,frame.stack.length-consumed),status:'unsupported',
       completion,version:frame.version+1})||
     !eq(controlPatch?.after,{...control,status:'unsupported',activeFrameId:null,
       failure:{kind:'unsupported',frameId:frame.id,completion},version:control.version+1}))
    fail('Unowned terminal unsupported completion',event.eventId);
}
/** Apply the canonical per-entity typed patches to an independently held state. */
export function reconstruct(bundle,{throughEventId=null}={}) {
  if(bundle.manifest?.schema!=='semantic-tracing-run/2')fail('Unknown run schema');
  const state=clone(bundle.initialState);
  validateSymbolReferences(state,state.heap,fail);
  const generatorIds=new Set(Object.values(state.heap).filter(entity=>entity.kind==='generator'||entity.kind==='function'&&bundle.programs[entity.codeId]?.generator).map(entity=>entity.id));
  validateGeneratorState(state,bundle.programs,fail,generatorIds);
  const binaryIds=new Set(Object.values(state.heap).filter(entity=>isBinaryMemoryKind(entity.kind)).map(entity=>entity.id));
  validateBinaryMemoryState(state,fail,binaryIds);
  const sites=new Set(bundle.sites.map(s=>s.siteId));
  validateNumberConversionState(state,bundle.programs,sites,fail);
  validatePropertyKeyConversionState(state,bundle.programs,sites,fail);
  validatePromiseResolutionState(state,fail);
  validateScriptSequenceState(state,bundle,fail,{initial:true});
  const seen=new Set();
  const parameterTdzOrigins=new Map();
  for(let i=0;i<bundle.events.length;i++) {
    const e=bundle.events[i];
    if(e.eventId!==`a0:e${i+1}`||e.sequence!==i+1)fail('Event ordering/identity violation',e.eventId);
    if(!known.has(e.operation)||e.catalogRef!==`${e.operation}/1`)fail('Unknown catalog operation',e.eventId);
    if(e.siteId && !sites.has(e.siteId))fail('Unresolved source site',e.eventId);
    if(e.before!==`q${i}`||e.after!==`q${i+1}`)fail('Invalid state-root sequence',e.eventId);
    for(const origin of e.operandOrigins) {
      if(origin && !seen.has(origin))fail('Missing or future operand producer',e.eventId);
    }
    const job=e.operation==='job.enter'?state.control.a0.queue[0]:null;
    const queuedBefore=job?state.control.a0.queue.slice(1):null;
    if(e.completion?.parameterTdz&&e.completion.origin!==e.eventId){
      const c=e.completion,frame=state.frames[e.invocationId];
      const operation=state.operations[frame?.operationId];
      // Coercion first commits the original fault into its owned operation,
      // then propagates that identical completion at a later spec boundary.
      // The original read remains the error's identity and allocation origin.
      if(e.operation!=='spec.operation.complete'||operation?.frameId!==frame?.id||
         operation?.phase!=='complete'||!eq(operation.completion,c)||
         !eq(parameterTdzOrigins.get(c.origin),c))
        fail('Invalid propagated parameter TDZ exception',e.eventId);
    }else if(e.completion?.parameterTdz){
      const c=e.completion,frame=state.frames[e.invocationId];
      const instruction=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
      const name=typeof instruction?.arg==='string'?instruction.arg:instruction?.arg?.name;
      let environment=frame?.envId;
      while(environment&&!Object.hasOwn(state.envs[environment]?.bindings??{},name))
        environment=state.envs[environment]?.parent;
      const binding=state.envs[environment]?.bindings?.[name];
      const value=c.value?.value,allocation=e.stateChanges.find(p=>
        p.table==='heap'&&p.before===null&&p.id===value?.[1]);
      if(!['GET','TYPEOF_BINDING','SET','UPDATE_BINDING'].includes(instruction?.op)||
         instruction.siteId!==e.siteId||c.type!=='throw'||c.errorType!=='ReferenceError'||
         c.origin!==e.eventId||c.value?.origin!==e.eventId||value?.[0]!=='ref'||
         binding?.kind!=='parameter'||binding.initialized||
         !eq(c.parameterTdz,{environment,name})||
         c.message!==`Cannot access '${name}' before initialization`||
         allocation?.after?.kind!=='object'||allocation.after.declaredError!=='ReferenceError'||
         !eq(allocation.after.properties,{name:{value:['str','ReferenceError'],origin:e.eventId},
           message:{value:['str',c.message],origin:e.eventId}}))
        fail('Invalid committed parameter TDZ exception',e.eventId);
      parameterTdzOrigins.set(e.eventId,clone(c));
    }
    if(e.operation==='external.callback.enqueue'){
      const effect=e.causes.filter(c=>c.kind==='effect');
      const patch=e.stateChanges.find(p=>p.table==='control'&&p.id==='a0');
      const job=patch?.after?.queue?.at(-1);
      if(effect.length!==1||e.stateChanges.length!==1||!job||
         job.kind!=='external-callback'||job.effectId!==effect[0].effectId||
         state.effects[job.effectId]?.dispatch!=='dispatched'||
         !(state.effects[job.effectId]?.external==='pending'||
           state.effects[job.effectId]?.external==='completed'&&state.effects[job.effectId]?.subscription?.state==='active')||
         !Array.isArray(job.args)||!eq(job.args,e.operands)||
         !eq(patch.after.queue.slice(0,-1),state.control.a0.queue))
        fail('External callback must enqueue a registered owned job',e.eventId);
      try{validateExternalCallbackJob(state,job,{arrival:true});}
      catch(error){fail(error.message,e.eventId);}
    }
    if(e.operation==='job.enter'){
      if(job?.kind==='external-callback'){
        try{validateExternalCallbackEntry(state,e,job,bundle.programs);}
        catch(error){fail(error.message,e.eventId);}
      }else if(job?.kind==='microtask'){
        if(typeof job.functionId!=='string'||
           state.heap[job.functionId]?.kind!=='function'||
           e.causes.filter(c=>c.kind==='invocation').length!==1||
           e.causes.some(c=>c.kind==='promise'))
          fail('Microtask entry lacks an owned queued callback',e.eventId);
      }else if(job?.kind==='promise-adopt'){
        const adopter=state.promises[job.promiseId],target=state.promises[job.targetId];
        if(adopter?.status!=='pending'||!target||adopter.adopting!==target.id||adopter===target||
           e.causes.length!==1||e.causes[0].kind!=='promise'||e.causes[0].promiseId!==adopter.id||
           !eq(e.result,['promise',adopter.id]))
          fail('Queued Promise adoption lacks its target and resolving owner',e.eventId);
      }else if(job?.kind==='thenable'){
         const p=state.promises[job.promiseId];
         if(!p||p.status!=='pending'||p.thenableSerial!==job.serial||
            state.heap[job.thenId]?.kind!=='function'||!(state.heap[job.thenableId]??state.promises[job.thenableId])||
            job.receiver!==undefined&&!eq(job.receiver,['promise',job.thenableId])||
            e.causes.filter(c=>c.kind==='promise'&&c.promiseId===p.id).length!==1||
            e.causes.filter(c=>c.kind==='invocation').length!==1)
           fail('Queued thenable is not backed by an owned function and promise',e.eventId);
       }else if(!job || !state.promises[job.promiseId] ||
         state.promises[job.promiseId].status==='pending' ||
         e.causes.filter(c=>c.kind==='promise').length!==1 ||
         e.causes.find(c=>c.kind==='promise').promiseId!==job.promiseId)
        fail('Job entry does not consume the next settled promise observer',e.eventId);
      if(job?.kind==='adoption'){
        const adopter=state.promises[job.resultId];
        if(adopter?.status!=='pending'||adopter.adopting!==job.promiseId)
          fail('Promise adoption reaction has no matching pending owner',e.eventId);
      }
    }
    if(e.operation==='host.task.enter'){
      const control=state.control.a0;
      if(control.activeFrameId||control.queue.length||!control.timers?.length)
        fail('Virtual host task preempted guest microtasks or active work',e.eventId);
      const selected=[...control.timers].sort((a,b)=>a.at-b.at||a.order-b.order)[0];
      const clock=e.stateChanges.find(p=>p.table==='control'&&p.id==='a0')?.after;
      const invocation=e.causes.find(c=>c.kind==='invocation')?.frameId;
      const nextFrame=e.stateChanges.find(p=>p.table==='frames'&&p.id===invocation)?.after;
      if(!clock||!nextFrame||nextFrame.codeId!==state.heap[selected.functionId]?.codeId||
         clock.activeFrameId!==invocation||!nextFrame.reactionJob||
         clock.now!==Math.max(control.now,selected.at)||
         clock.timerTurns!==control.timerTurns+1||clock.timerTurns>128||
         e.causes.length!==1||!eq(e.result,['num',clock.now])||
         clock.timers.some(t=>t.id===selected.id&&selected.kind==='timeout'))
        fail('Virtual host task turn is not independently accounted',e.eventId);
    }
    const patched=new Set();
    if(e.completion && !['spec.operation.complete','completion.throw','external.input.deliver',
      'job.enter','binding.read','binding.write','binding.update','primitive.unary',
      'property.read','property.write','property.update','primitive.binary','reference.this','call.return','call.enter','proxy.allocate',
      'object.construct','completion.finally.end','execution.unsupported','regexp.allocate','intrinsic.number.resume',
      'property.key.convert','property.key.resume'].includes(e.operation))
      fail('Completion metadata without an owned completion operation',e.eventId);
    validateSpecEvent(state,e,fail);
    validateGeneratorEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validatePrivateEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateTemplateEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateEnumerationEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateReceiverEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateCallAdapterEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateConstructionEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateSuperEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validateBinaryMemoryEvent(e,message=>fail(message,e.eventId));
    validateNumberConversionEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validatePropertyKeyConversionEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    validatePromiseResolutionEvent(state,e,message=>fail(message,e.eventId));
    validateScriptSequenceEvent(state,e,bundle,message=>fail(message,e.eventId));
    validateScriptHostEvent(state,e,bundle.programs,message=>fail(message,e.eventId));
    if(e.operation==='execution.unsupported'||e.completion?.type==='unsupported'&&
       e.operation!=='spec.operation.complete')validateUnsupportedCompletion(state,e,bundle.programs);
    for(const p of e.stateChanges) {
      validateSymbolAllocation(p,e,message=>fail(message,e.eventId));
      if(patched.has(`${p.table}:${p.id}`))fail('Double application of mutation',e.eventId);
      patched.add(`${p.table}:${p.id}`);
      if(p.table==='operations') {
        if(bundle.manifest.schema!=='semantic-tracing-run/2')fail('Spec commands require run schema 2',e.eventId);
        applySpecCommand(state,p,e,seen,fail);continue;
      }
      if(!['counters','envs','heap','promises','frames','effects','inputs','control'].includes(p.table)||p.kind!==`${p.table}.replace`)fail('Invalid typed mutation',e.eventId);
      if(typeof p.id!=='string'||!p.id||['__proto__','constructor','prototype'].includes(p.id))
        fail('Invalid mutation entity ID',e.eventId);
      if(!Object.hasOwn(state,p.table)||!state[p.table]||typeof state[p.table]!=='object'||Array.isArray(state[p.table]))
        fail('Missing or invalid mutation table',e.eventId);
      if(p.before!==null && (!p.before||typeof p.before!=='object'||Array.isArray(p.before)||
         !Number.isSafeInteger(p.before.version)||p.before.version<0))
        fail('Invalid prior entity record',e.eventId);
      if(p.after!==null && (!p.after||typeof p.after!=='object'||Array.isArray(p.after)||
         (Object.hasOwn(p.after,'id')&&p.after.id!==p.id)))
        fail('Invalid replacement entity record',e.eventId);
      const previous=Object.hasOwn(state[p.table],p.id)?state[p.table][p.id]:null;
      if(!eq(previous,p.before))fail('Mutation precondition mismatch',e.eventId);
      if(p.after && p.after.version!==(p.before?.version??0)+1)fail('Invalid record version',e.eventId);
      if(p.after===null)delete state[p.table][p.id];else state[p.table][p.id]=clone(p.after);
    }
    for(const patch of e.stateChanges)if(patch.table==='heap'&&(patch.after?.kind==='generator'||patch.after?.kind==='function'&&bundle.programs[patch.after.codeId]?.generator))generatorIds.add(patch.id);
    validateGeneratorState(state,bundle.programs,message=>fail(message,e.eventId),generatorIds);
    for(const patch of e.stateChanges)if(patch.table==='heap'&&isBinaryMemoryKind(patch.after?.kind))binaryIds.add(patch.id);
    validateBinaryMemoryState(state,message=>fail(message,e.eventId),binaryIds);
    validateNumberConversionState(state,bundle.programs,sites,message=>fail(message,e.eventId));
    validatePropertyKeyConversionState(state,bundle.programs,sites,message=>fail(message,e.eventId));
    validatePromiseResolutionState(state,message=>fail(message,e.eventId));
    validateScriptSequenceState(state,bundle,message=>fail(message,e.eventId));
    validateSymbolReferences({operands:e.operands,result:e.result,changed:e.stateChanges.map(p=>p.after??p.record??null)},state.heap,message=>fail(message,e.eventId));
    if(job && !eq(state.control.a0.queue.slice(0,queuedBefore.length),queuedBefore))
      fail('Guest job FIFO order changed during entry',e.eventId);
    if(bundle.manifest.schema==='semantic-tracing-run/2') {
      const delivered=e.operation==='external.input.deliver'
        ? state.inputs[e.causes.find(c=>c.kind==='input')?.inputId] : null;
      const hostThrow=delivered?.abrupt && state.effects[delivered.effectId]?.kind==='synchronous';
      const c=e.completion;
      if(e.operation==='completion.throw'||hostThrow||(c&&c.type!=='unsupported'&&
          (e.operation!=='spec.operation.complete'||c.type==='throw'))) {
        if(c?.type!=='throw')fail('Missing guest throw completion',e.eventId);
        if(e.operation==='completion.throw'||hostThrow){
          if(hostThrow ? !eq(c.value,{value:delivered.value,origin:e.eventId}) :
             !eq(e.operands,[c.value?.value]) || !eq(e.operandOrigins,[c.value?.origin]))
            fail('Throw completion value/provenance mismatch',e.eventId);
        }else if(e.operation==='call.enter'&&e.operands[0]?.[0]==='method'&&
          eq(e.operands[0][1],['builtinfn','Generator.throw'])&&
          state.heap[e.operands[0][2]?.[1]]?.kind==='generator'&&c.errorType===undefined){
          const expected={value:e.operands[1]??['undefined'],origin:e.operandOrigins[1]??e.eventId};
          if(!eq(c.value,expected))fail('Generator throw value/provenance mismatch',e.eventId);
        }else if(e.operation==='job.enter'){
          const p=state.promises[e.causes.find(x=>x.kind==='promise')?.promiseId];
          if(p?.status!=='rejected'||!eq(c.value,p.value)||
             !eq(e.result,p.value.value))
            fail('Awaited rejection reason/provenance mismatch',e.eventId);
        }else if(e.operation!=='spec.operation.complete'){
          if(!['ReferenceError','TypeError','RangeError','SyntaxError'].includes(c.errorType) ||
             typeof c.message!=='string'||c.origin!==e.eventId)
            fail('Invalid classified guest exception',e.eventId);
        }
        if(state.control.a0.status==='failed'){
          const failure=state.control.a0.failure,frame=state.frames[failure?.frameId];
          if(!eq(failure?.completion,c)||!eq(frame?.completion,c)||
             frame?.status!=='thrown'||state.control.a0.activeFrameId!==null)
            fail('Unowned terminal throw completion',e.eventId);
        }else{
          const active=state.frames[state.control.a0.activeFrameId];
          const rejection=Object.values(state.frames).some(f=>f.status==='thrown'&&f.asyncPromiseId&&
            eq(f.completion,c)&&state.promises[f.asyncPromiseId]?.status==='rejected');
          const reactionRejection=Object.values(state.frames).some(f=>f.status==='thrown'&&
            (f.reactionPromiseId||f.finallyReaction?.resultId)&&eq(f.completion,c)&&
            state.promises[f.reactionPromiseId??f.finallyReaction.resultId]?.status==='rejected');
          const resolutionRejection=Object.values(state.frames).some(f=>f.status==='thrown'&&
            f.promiseThenLookup?.delivered&&eq(f.completion,c)&&
            state.promises[f.promiseThenLookup.promiseId]?.status==='rejected');
          const pendingCoercion=Object.values(state.frames).some(f=>{
            const pending=f.pendingCoercionThrow, operation=state.operations[f.operationId];
            const methodId=operation?.coercion?.waitingFrameId;
            return pending&&eq(pending,c)&&methodId&&
              state.frames[methodId]?.status==='thrown' &&
              eq(state.frames[methodId].completion,c);
          });
          const executorCompletion=Object.values(state.frames).some(f=>f.status==='thrown'&&
             f.promiseExecutorTarget&&eq(f.completion,c)&&
             (state.promises[f.promiseExecutorTarget]?.status==='rejected'||
              state.promises[f.promiseExecutorTarget]?.resolverCalled));
          const callbackRejection=e.stateChanges.some(p=>p.table==='frames'&&
            p.before?.externalCallbackReturn&&p.after?.status==='thrown'&&
            eq(p.after.externalCallbackReturn,p.before.externalCallbackReturn)&&
            eq(p.after.completion,c)&&state.control.a0.activeFrameId===null);
           const thenableRejection=Object.values(state.frames).some(f=>f.status==='thrown'&&
             f.thenableJob&&eq(f.completion,c)&&
             (state.promises[f.thenableJob.promiseId]?.thenableLocked===true||
              state.promises[f.thenableJob.promiseId]?.thenableSerial>f.thenableJob.serial));
           // A thenable that calls resolve() and then throws ignores the throw.
           // It remains an executed guest abrupt completion, not a second
           // promise rejection, and is validated against the locked capability.
           if(!rejection&&!reactionRejection&&!resolutionRejection&&!pendingCoercion&&!executorCompletion&&!thenableRejection&&!callbackRejection&&(['failed','unsupported'].includes(state.control.a0.status)||active?.status!=='running'||
             !active.handlers?.some(h=>h.phase==='catch'||h.phase==='finally')))
            fail('Guest throw was not routed to a handler or async rejection',e.eventId);
        }
      }
    }
    seen.add(e.eventId);
    if(throughEventId===e.eventId)return state;
  }
  if(throughEventId)fail('Unknown event ID');
  return state;
}
export function validateBundle(bundle) {
  const state=reconstruct(bundle);
  if(!eq(state,bundle.finalState))fail('Final state does not match reconstructed state');
  if(!eq(bundle.checkpoints?.q0,bundle.initialState))fail('Initial checkpoint differs from initial state');
  if(!eq(bundle.effects,state.effects)||!eq(bundle.inputs,state.inputs))
    fail('Exported host tables differ from reconstructed final state');
  let index=0, previous='q0', chunkNumber=0;
  for(const c of bundle.chunks) {
    chunkNumber++;
    if(c.chunkId!==`a0:c${chunkNumber}`||c.agentId!=='a0'||c.policy!=='accumulate-until-wait/1')
      fail('Invalid chunk identity or policy');
    if(c.before!==previous||c.firstEvent!==index+1||c.lastEvent!==index+c.eventIds.length)fail('Invalid chunk boundary');
    if(!eq(c.eventIds,bundle.events.slice(index,c.lastEvent).map(e=>e.eventId)))fail('Chunk event index incomplete');
    if(c.after!==`q${c.lastEvent}`||!bundle.checkpoints[c.after])fail('Missing end-state checkpoint');
    const atEnd=c.lastEvent?reconstruct(bundle,{throughEventId:`a0:e${c.lastEvent}`}):bundle.initialState;
    if(!eq(bundle.checkpoints[c.after],atEnd))fail('Checkpoint boundary does not reconstruct');
    const memberEvents=bundle.events.slice(index,c.lastEvent);
    const effects=[...new Set(memberEvents.flatMap(e=>e.causes.filter(x=>x.kind==='effect').map(x=>x.effectId)))];
    const inputs=[...new Set(memberEvents.flatMap(e=>e.causes.filter(x=>x.kind==='input').map(x=>x.inputId)))];
    if(!eq(c.effects,effects)||!eq(c.inputs,inputs))fail('Chunk host-cause index mismatch');
    const pendingEffects=Object.values(atEnd.effects).filter(e=>e.external==='pending').map(e=>e.id);
    const waitingOn=Object.values(atEnd.frames).filter(f=>f.status==='blocked'||f.status==='suspended')
      .map(f=>f.blockedOn??f.awaiting).filter(Boolean);
    if(!eq(c.exit?.pendingEffects,pendingEffects)||!eq(c.exit?.waitingOn,waitingOn))
      fail('Chunk pending/waiting summary mismatch');
    previous=c.after;index=c.lastEvent;
  }
  if(index!==bundle.events.length)fail('Unsealed journal events');
  validateHostJournal(bundle,fail);
  return {valid:true,eventCount:bundle.events.length,chunkCount:bundle.chunks.length,effectCount:Object.keys(bundle.effects).length,
    evidence:'state reconstruction, referential and lifecycle structure only; not executable or native reference replay'};
}
