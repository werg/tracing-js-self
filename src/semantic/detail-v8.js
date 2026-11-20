// V8 owns its canonical detail wire. Reusable typed operation validation lives
// in the neutral record schema; no legacy codec or harness participates here.
import {SEMANTIC_RECORD_SCHEMA,validateTypedSemanticRecord} from './record-schema.js';
import {stableAlgorithmJSON} from './ir.js';

export const DETAIL_RECORD_MAX_BYTES_V8=65536;
const hostKinds=new Set(['code','input','observe']);
const fragments=new Set(['value-open','value-part','value-close']);
const fail=message=>{throw new TypeError('Invalid semantic-trace/8 detail: '+message);};
function validate(record,role){
  validateTypedSemanticRecord(record);
  if(!record||Array.isArray(record)||Object.keys(record).length!==2||
     !Object.hasOwn(record,'kind')||!Object.hasOwn(record,'fields'))fail('exact kind and fields wrapper required');
  if(!['any','generated','observed'].includes(role))fail('record authority role');
  const {kind}=record;
  if(!Object.hasOwn(SEMANTIC_RECORD_SCHEMA,kind)||fragments.has(kind))fail('unknown or fragment record kind');
  if(role==='generated'&&hostKinds.has(kind))fail('host-controlled record cannot be generated');
  if(role==='observed'&&kind!=='observe')fail('observed detail requires an observation');
  return record;
}

export function encodeDetailedRecord(record,{role='any'}={}){
  validate(record,role);
  const line='detail '+stableAlgorithmJSON(record);
  if(Buffer.byteLength(line,'utf8')>DETAIL_RECORD_MAX_BYTES_V8)fail('record byte budget');
  return line;
}

export function decodeDetailedRecord(line,{role='any'}={}){
  if(typeof line!=='string'||!line.startsWith('detail ')||/[\r\n]/.test(line)||
     Buffer.byteLength(line,'utf8')>DETAIL_RECORD_MAX_BYTES_V8)fail('one canonical detail record required');
  let record;
  try{record=JSON.parse(line.slice(7));}catch{fail('malformed detail JSON');}
  // Exact re-encoding also rejects duplicate keys, unknown fields, alternate
  // numeric spellings, whitespace, and lone-surrogate/noncanonical escapes.
  if(encodeDetailedRecord(record,{role})!==line)fail('noncanonical detail bytes');
  return structuredClone(record);
}
