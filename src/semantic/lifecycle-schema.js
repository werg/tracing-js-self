// Neutral lifecycle envelope shapes; each client supplies its own wire contract.
import {COMPLETION_POLICIES,assertValue} from './record-schema.js';

export const SELECTED_STATE_FIELDS=Object.freeze(['schema','heap','locals','captureAliases','stack',
  'continuations','ready','callReturn','pending','completion','randomState']);
export const MODEL_CONTEXT_INTERVAL=32;

export const LIFECYCLE_RECORD_SCHEMAS=Object.freeze(Object.fromEntries(Object.entries({
  program:['programId','digest','entry','source','sites','functions','capabilities','dependencies','sourceMap','languageProfile','module','sourceMetadata'],
  invocation:['programId','invocationId','realmId','triggerId','completionPolicy','realmPolicy','inputGraph','entry','sourceDigest','receiver','closureId','activation','parentInvocationId','taskRevision','deadline','bindings','ingressKey'],
  semantic:['invocationId','traceFormat','line'],
  handler:['subscriptionId','programId','realmId','trackId','realmPolicy','entry','queueLimit','closureId','lifetime','ownerInvocationId'],
  event:['subscriptionId','eventId','invocationId','triggerId','programId','realmId'],
  'handler-close':['subscriptionId','discarded'],
  'realm-close':['realmId','reason'],
  dispatch:['invocationId','effectId','key','attempt'],
  result:['invocationId','effectId','status','result','line','errorOrigin'],
  'source-evict':['programId','digest'],'source-read':['programId','digest','source'],
  'model-context':['invocationId','sourceReads'],cancel:['invocationId','reason','uncertain'],
  reconcile:['invocationId','effectId','disposition','evidenceId'],
  'callback-reattach':['subscriptionId','realmId','evidenceId']
}).map(([kind,required])=>[kind,Object.freeze({mode:kind==='semantic'?'generated':'observed',
  required:Object.freeze(required),optional:Object.freeze(kind==='dispatch'?['nativeAction']:
    kind==='program'?['randomSeed']:
    kind==='model-context'?['selectedState','realmPrefixDigest','visibleThrough']:[])})])));
export const LIFECYCLE_COMMON_FIELDS=Object.freeze(['schema','session','sequence','ownerSequence','track','mode','kind']);
export function validateLifecycleRecord(record,{executionVersion,traceVersion,continuationVersion,decodeRecord}){
  const spec=Object.hasOwn(LIFECYCLE_RECORD_SCHEMAS,record?.kind)?LIFECYCLE_RECORD_SCHEMAS[record.kind]:null;
  if(!spec||record.schema!==executionVersion||record.mode!==spec.mode||
     LIFECYCLE_COMMON_FIELDS.concat(spec.required).some(field=>!Object.hasOwn(record,field))||
     Object.keys(record).some(field=>![...LIFECYCLE_COMMON_FIELDS,...spec.required,...spec.optional].includes(field)))
    throw new TypeError('Invalid '+executionVersion+' record schema, authority or fields');
  for(const field of ['session','track','programId','invocationId','realmId','triggerId','subscriptionId','eventId','trackId'])
    if(record[field]!==undefined&&(typeof record[field]!=='string'||!/^[a-z][a-z0-9:_-]*$/.test(record[field])))
      throw new TypeError('Invalid harness routing identity '+field);
  if(!Number.isSafeInteger(record.sequence)||record.sequence<1||
     !Number.isSafeInteger(record.ownerSequence)||record.ownerSequence<1)
    throw new TypeError('Invalid harness sequence');
  if(record.kind==='program'&&Object.hasOwn(record,'randomSeed')&&
     (!Number.isInteger(record.randomSeed)||Object.is(record.randomSeed,-0)||
      record.randomSeed<0||record.randomSeed>0xffffffff))
    throw new TypeError('Invalid program deterministic seed');
  if(record.kind==='realm-close'&&(record.track!=='host'||typeof record.reason!=='string'||!record.reason))
    throw new TypeError('Invalid observed realm closure');
  if(record.kind==='model-context'){
    const stateFields=['selectedState','realmPrefixDigest','visibleThrough'];
    if(stateFields.some(field=>Object.hasOwn(record,field))){
      const state=record.selectedState;
      if(!stateFields.every(field=>Object.hasOwn(record,field))||
        !state||typeof state!=='object'||Array.isArray(state)||
        Object.keys(state).length!==SELECTED_STATE_FIELDS.length||
        SELECTED_STATE_FIELDS.some(field=>!Object.hasOwn(state,field))||
        state.schema!==continuationVersion||
        !(state.randomState===null||Number.isInteger(state.randomState)&&state.randomState>=0&&state.randomState<=0xffffffff)||
        !['heap','locals','captureAliases','stack','continuations','ready'].every(field=>Array.isArray(state[field]))||
        typeof record.realmPrefixDigest!=='string'||!/^[0-9a-f]{64}$/.test(record.realmPrefixDigest)||
        record.visibleThrough!==record.sequence-1)
        throw new TypeError('Selected context requires its exact state and prior public cutoff');
    }
  }
  if(record.kind==='invocation'){
    if(!COMPLETION_POLICIES.includes(record.completionPolicy)||!['fresh','retained'].includes(record.realmPolicy)||
       !['call','callback','module-init'].includes(record.activation)||
       !Number.isSafeInteger(record.taskRevision)||record.taskRevision<1||
       record.deadline!==null&&!Number.isFinite(record.deadline))throw new TypeError('Invalid invocation contract');
    assertValue(record.receiver);
  }
  if(record.line!==undefined){
    const decoded=decodeRecord(record.line);
    if(record.kind==='semantic'&&(record.traceFormat!==traceVersion||['code','input','observe'].includes(decoded.kind))||
       record.kind==='result'&&decoded.kind!=='observe')throw new TypeError('Invalid harness witness authority');
  }
  return true;
}
