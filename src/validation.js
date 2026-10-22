// Read-only validation. Does not import the evaluator or call its mutation routines.
import { readFileSync } from 'node:fs';
import { validateHostJournal } from './host-journal.js';
import { validateSpecEvent, applySpecCommand } from './spec-validation.js';
const clone = x => structuredClone(x);
const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const operations = JSON.parse(readFileSync(new URL('../catalog/operations.json',import.meta.url),'utf8'));
const known = new Set(operations.entries.map(e=>e.operationId));
export class TraceValidationError extends Error {
  constructor(message,eventId=null){super(eventId?`${message} at ${eventId}`:message);this.name='TraceValidationError';this.eventId=eventId;}
}
function fail(message,eventId=null){throw new TraceValidationError(message,eventId);}
/** Apply the canonical per-entity typed patches to an independently held state. */
export function reconstruct(bundle,{throughEventId=null}={}) {
  if(!['semantic-tracing-run/1','semantic-tracing-run/2'].includes(bundle.manifest?.schema))fail('Unknown run schema');
  const state=clone(bundle.initialState);
  const sites=new Set(bundle.sites.map(s=>s.siteId));
  const seen=new Set();
  for(let i=0;i<bundle.events.length;i++) {
    const e=bundle.events[i];
    if(e.eventId!==`a0:e${i+1}`||e.sequence!==i+1)fail('Event ordering/identity violation',e.eventId);
    if(!known.has(e.operation)||e.catalogRef!==`${e.operation}/1`)fail('Unknown catalog operation',e.eventId);
    if(e.siteId && !sites.has(e.siteId))fail('Unresolved source site',e.eventId);
    if(e.before!==`q${i}`||e.after!==`q${i+1}`)fail('Invalid state-root sequence',e.eventId);
    for(const origin of e.operandOrigins) {
      if(origin && !seen.has(origin))fail('Missing or future operand producer',e.eventId);
    }
    const patched=new Set();
    if(e.completion && !['spec.operation.complete','completion.throw','external.input.deliver',
      'job.enter','binding.read','binding.write','property.read','property.write','call.enter'].includes(e.operation))
      fail('Completion metadata without an owned completion operation',e.eventId);
    validateSpecEvent(state,e,fail);
    for(const p of e.stateChanges) {
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
    if(bundle.manifest.schema==='semantic-tracing-run/2') {
      const delivered=e.operation==='external.input.deliver'
        ? state.inputs[e.causes.find(c=>c.kind==='input')?.inputId] : null;
      const hostThrow=delivered?.abrupt && state.effects[delivered.effectId]?.kind==='synchronous';
      const c=e.completion;
      if(e.operation==='completion.throw'||hostThrow||(c && (e.operation!=='spec.operation.complete'||c.type==='throw'))) {
        if(c?.type!=='throw')fail('Missing guest throw completion',e.eventId);
        if(e.operation==='completion.throw'||hostThrow){
          if(hostThrow ? !eq(c.value,{value:delivered.value,origin:e.eventId}) :
             !eq(e.operands,[c.value?.value]) || !eq(e.operandOrigins,[c.value?.origin]))
            fail('Throw completion value/provenance mismatch',e.eventId);
        }else if(e.operation==='job.enter'){
          const p=state.promises[e.causes.find(x=>x.kind==='promise')?.promiseId];
          if(p?.status!=='rejected'||!eq(c.value,p.value)||
             !eq(e.result,p.value.value))
            fail('Awaited rejection reason/provenance mismatch',e.eventId);
        }else if(e.operation!=='spec.operation.complete'){
          if(!['ReferenceError','TypeError','RangeError'].includes(c.errorType) ||
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
          if(!rejection&&(['failed','unsupported'].includes(state.control.a0.status)||active?.status!=='running'||
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
