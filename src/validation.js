// Read-only validation. Does not import the evaluator or call its mutation routines.
import { readFileSync } from 'node:fs';
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
  if(bundle.manifest?.schema!=='semantic-tracing-run/1')fail('Unknown run schema');
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
    for(const p of e.stateChanges) {
      if(!['counters','envs','heap','promises','frames','effects','inputs','control'].includes(p.table)||p.kind!==`${p.table}.replace`)fail('Invalid typed mutation',e.eventId);
      if(patched.has(`${p.table}:${p.id}`))fail('Double application of mutation',e.eventId);
      patched.add(`${p.table}:${p.id}`);
      if(!state[p.table]||!eq(state[p.table][p.id]??null,p.before))fail('Mutation precondition mismatch',e.eventId);
      if(p.after && p.after.version!==(p.before?.version??0)+1)fail('Invalid record version',e.eventId);
      if(p.after===null)delete state[p.table][p.id];else state[p.table][p.id]=clone(p.after);
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
  let index=0, previous='q0';
  for(const c of bundle.chunks) {
    if(c.before!==previous||c.firstEvent!==index+1||c.lastEvent!==index+c.eventIds.length)fail('Invalid chunk boundary');
    if(!eq(c.eventIds,bundle.events.slice(index,c.lastEvent).map(e=>e.eventId)))fail('Chunk event index incomplete');
    if(c.after!==`q${c.lastEvent}`||!bundle.checkpoints[c.after])fail('Missing end-state checkpoint');
    const atEnd=c.lastEvent?reconstruct(bundle,{throughEventId:`a0:e${c.lastEvent}`}):bundle.initialState;
    if(!eq(bundle.checkpoints[c.after],atEnd))fail('Checkpoint boundary does not reconstruct');
    previous=c.after;index=c.lastEvent;
  }
  if(index!==bundle.events.length)fail('Unsealed journal events');
  const dispatches=new Set();const deliveries=new Set();
  for(const event of bundle.events) {
    if(event.operation==='effect.dispatch') {
      const fx=event.causes.find(x=>x.kind==='effect')?.effectId;
      if(!fx||dispatches.has(fx))fail('Repeated or unowned dispatch',event.eventId);
      dispatches.add(fx);
    }
    if(event.operation==='external.input.deliver') {
      const id=event.causes.find(x=>x.kind==='input')?.inputId;
      if(!id||deliveries.has(id))fail('Duplicate/unowned input delivery',event.eventId);
      deliveries.add(id);
    }
  }
  for(const fx of Object.values(bundle.effects)) {
    if(fx.dispatch==='dispatched'&&!dispatches.has(fx.id))fail(`Effect ${fx.id} lacks dispatch journal`);
    if(fx.inputIds.some(id=>bundle.inputs[id]?.effectId!==fx.id))fail(`Effect ${fx.id} input linkage invalid`);
  }
  for(const input of Object.values(bundle.inputs)) {
    if(input.status==='delivered'&&!deliveries.has(input.id))fail(`Input ${input.id} lacks delivery`);
  }
  return {valid:true,eventCount:bundle.events.length,chunkCount:bundle.chunks.length,effectCount:Object.keys(bundle.effects).length,
    evidence:'state reconstruction, referential and lifecycle structure only; not executable or native reference replay'};
}
