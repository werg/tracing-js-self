// Strict public witness language. This grammar does not expose VM frames,
// property versions, journal origins, or the normalized teacher event stream.
import {encodeTraceText,decodeTraceText} from './trace-text.js';
import {COMPLETION_POLICIES,canonicalCompletionPolicy,
  SEMANTIC_RECORD_KINDS as WITNESS_KINDS,SEMANTIC_RECORD_SCHEMA as WITNESS_SCHEMA,
  SEMANTIC_RECORD_REQUIRED as WITNESS_REQUIRED,assertValue,validateExpression,validateGraph,
  validateSemanticRecord as validateWitness} from '../semantic/record-schema.js';
export {COMPLETION_POLICIES,canonicalCompletionPolicy,WITNESS_KINDS,WITNESS_SCHEMA,
  WITNESS_REQUIRED,assertValue,validateExpression,validateGraph,validateWitness};
function fail(message){throw new TypeError('Invalid '+WITNESS_VERSION+': '+message);}

export const WITNESS_VERSION='semantic-trace/6';
export const CONTEXT_VERSION='semantic-context/6';
export const EXECUTION_VERSION='semantic-execution/6';
export const CONTINUATION_VERSION='semantic-continuation/6';
export const HARNESS_PROFILE='selected-harness/2';
export const SUPERVISION_VERSION='semantic-supervision/2';
export const SELECTED_STATE_FIELDS=Object.freeze(['schema','heap','locals','captureAliases','stack',
  'continuations','ready','callReturn','pending','completion','randomState']);
export const MODEL_CONTEXT_INTERVAL=32;

export const HARNESS_RECORD_SCHEMAS=Object.freeze(Object.fromEntries(Object.entries({
  program:['programId','digest','entry','source','sites','functions','capabilities','dependencies','sourceMap','languageProfile','module','sourceMetadata'],
  invocation:['programId','invocationId','realmId','triggerId','completionPolicy','realmPolicy','inputGraph','entry','sourceDigest','receiver','closureId','activation','parentInvocationId','taskRevision','deadline','bindings','ingressKey'],
  semantic:['invocationId','traceFormat','line'],
  handler:['subscriptionId','programId','realmId','trackId','realmPolicy','entry','queueLimit','closureId','lifetime','ownerInvocationId'],
  event:['subscriptionId','eventId','invocationId','triggerId','programId','realmId'],
  'handler-close':['subscriptionId','discarded'],
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
export const HARNESS_COMMON_FIELDS=Object.freeze(['schema','session','sequence','ownerSequence','track','mode','kind']);
export function validateHarnessRecord(record){
  const spec=Object.hasOwn(HARNESS_RECORD_SCHEMAS,record?.kind)?HARNESS_RECORD_SCHEMAS[record.kind]:null;
  if(!spec||record.schema!==EXECUTION_VERSION||record.mode!==spec.mode||
     HARNESS_COMMON_FIELDS.concat(spec.required).some(field=>!Object.hasOwn(record,field))||
     Object.keys(record).some(field=>![...HARNESS_COMMON_FIELDS,...spec.required,...spec.optional].includes(field)))
    throw new TypeError('Invalid '+EXECUTION_VERSION+' record schema, authority or fields');
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
  if(record.kind==='model-context'){
    const stateFields=['selectedState','realmPrefixDigest','visibleThrough'];
    if(stateFields.some(field=>Object.hasOwn(record,field))){
      const state=record.selectedState;
      if(!stateFields.every(field=>Object.hasOwn(record,field))||
        !state||typeof state!=='object'||Array.isArray(state)||
        Object.keys(state).length!==SELECTED_STATE_FIELDS.length||
        SELECTED_STATE_FIELDS.some(field=>!Object.hasOwn(state,field))||
        state.schema!==CONTINUATION_VERSION||
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
    const decoded=decodeWitness(record.line);
    if(record.kind==='semantic'&&(record.traceFormat!==WITNESS_VERSION||['code','input','observe'].includes(decoded.kind))||
       record.kind==='result'&&decoded.kind!=='observe')throw new TypeError('Invalid harness witness authority');
  }
  return true;
}
export function encodeWitness(kind,fields){
  validateWitness(kind,fields);
  return encodeTraceText(kind,fields);
}
export function decodeWitness(line){
  if(typeof line!=='string'||/[\r\n]/.test(line))fail('multiline record');
  const {kind,fields}=decodeTraceText(line);
  if(encodeWitness(kind,fields)!==line)fail('noncanonical bytes');
  return {kind,fields};
}

export function fragmentWitness(line,{maxBytes=512}={}){
  decodeWitness(line);
  if(Buffer.byteLength(line,'utf8')<=maxBytes)return [line];
  const id='r'+Buffer.byteLength(line,'utf8');
  const opening=encodeWitness('value-open',{id,type:'semantic-record'});
  const close=encodeWitness('value-close',{id});
  if([opening,close].some(v=>Buffer.byteLength(v,'utf8')>maxBytes))
    throw new RangeError('Witness fragment framing exceeds capacity');
  const parts=[];let buffer='';
  for(const char of line){
    const attempt=buffer+char;
    if(Buffer.byteLength(encodeWitness('value-part',{id,data:attempt}),'utf8')>maxBytes){
      if(!buffer)throw new RangeError('Witness scalar too large for fragment');
      parts.push(encodeWitness('value-part',{id,data:buffer}));buffer=char;
    }else buffer=attempt;
  }
  if(buffer)parts.push(encodeWitness('value-part',{id,data:buffer}));
  return [opening,...parts,close];
}
export function restoreWitness(lines){
  const restored=[];
  for(let i=0;i<lines.length;i++){
    const {kind,fields}=decodeWitness(lines[i]);
    if(kind!=='value-open'){
      if(['value-part','value-close'].includes(kind))
        throw new SyntaxError('Orphaned witness transport fragment');
      restored.push(lines[i]);continue;
    }
    if(fields.type!=='semantic-record')throw new SyntaxError('Unknown transport fragment type');
    let data='',closed=false;
    for(++i;i<lines.length;i++){
      const piece=decodeWitness(lines[i]);
      if(piece.fields.id!==fields.id)throw new SyntaxError('Interleaved witness fragments');
      if(piece.kind==='value-close'){closed=true;break;}
      if(piece.kind!=='value-part'||!piece.fields.data)
        throw new SyntaxError('Invalid witness fragment');
      data+=piece.fields.data;
    }
    if(!closed)throw new SyntaxError('Incomplete witness fragment');
    decodeWitness(data);
    if(fields.id!=='r'+Buffer.byteLength(data,'utf8'))
      throw new SyntaxError('Witness fragment identity mismatch');
    restored.push(data);
  }
  return restored;
}
