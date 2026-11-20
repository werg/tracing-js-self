// Strict public witness language. This grammar does not expose VM frames,
// property versions, journal origins, or the normalized teacher event stream.
import {encodeTraceText,decodeTraceText} from './trace-text.js';
import {validateLifecycleRecord} from '../semantic/lifecycle-schema.js';
import {COMPLETION_POLICIES,canonicalCompletionPolicy,
  SEMANTIC_RECORD_KINDS as WITNESS_KINDS,SEMANTIC_RECORD_SCHEMA as WITNESS_SCHEMA,
  SEMANTIC_RECORD_REQUIRED as WITNESS_REQUIRED,assertValue,validateExpression,validateGraph,
  validateSemanticRecord} from '../semantic/record-schema.js';
export {COMPLETION_POLICIES,canonicalCompletionPolicy,WITNESS_KINDS,WITNESS_SCHEMA,
  WITNESS_REQUIRED,assertValue,validateExpression,validateGraph};
function fail(message){throw new TypeError('Invalid '+WITNESS_VERSION+': '+message);}

export const WITNESS_VERSION='semantic-trace/6';
export const CONTEXT_VERSION='semantic-context/6';
export const EXECUTION_VERSION='semantic-execution/6';
export const CONTINUATION_VERSION='semantic-continuation/6';
export const HARNESS_PROFILE='selected-harness/2';
export const SUPERVISION_VERSION='semantic-supervision/2';
export {SELECTED_STATE_FIELDS,MODEL_CONTEXT_INTERVAL,
  LIFECYCLE_RECORD_SCHEMAS as HARNESS_RECORD_SCHEMAS,
  LIFECYCLE_COMMON_FIELDS as HARNESS_COMMON_FIELDS} from '../semantic/lifecycle-schema.js';
export function validateHarnessRecord(record){
  return validateLifecycleRecord(record,{executionVersion:EXECUTION_VERSION,
    traceVersion:WITNESS_VERSION,continuationVersion:CONTINUATION_VERSION,decodeRecord:decodeWitness});
}
export function validateWitness(kind,fields){
  try{return validateSemanticRecord(kind,fields);}
  catch(error){fail(error.message.replace(/^Invalid semantic record: /,''));}
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
