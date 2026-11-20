// V8 owns its canonical detail wire. Reusable typed operation validation lives
// in the neutral record schema; no legacy codec or harness participates here.
import {types} from 'node:util';
import {SEMANTIC_RECORD_SCHEMA,validateSemanticRecord} from './record-schema.js';
import {stableAlgorithmJSON} from './ir.js';

export const DETAIL_RECORD_MAX_BYTES_V8=65536;
const hostKinds=new Set(['code','input','observe']);
const fragments=new Set(['value-open','value-part','value-close']);
const fail=message=>{throw new TypeError('Invalid semantic-trace/8 detail: '+message);};
function data(value,ancestors=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value)&&!Object.is(value,-0))return;
  if(!value||typeof value!=='object'||types.isProxy(value)||ancestors.has(value))
    fail('canonical own data required');
  if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail('plain record required');
  ancestors.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for(const key of Reflect.ownKeys(descriptors)){
    if(Array.isArray(value)&&key==='length')continue;
    const descriptor=descriptors[key];
    if(typeof key!=='string'||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)
      fail('accessors and hidden fields are not public data');
    data(descriptor.value,ancestors);
  }
  if(Array.isArray(value)&&(Object.keys(value).length!==value.length||
    Object.keys(value).some((key,index)=>key!==String(index))))fail('dense canonical array required');
  ancestors.delete(value);
}
function validate(record,role){
  data(record);
  if(!record||Array.isArray(record)||Object.keys(record).length!==2||
     !Object.hasOwn(record,'kind')||!Object.hasOwn(record,'fields'))fail('exact kind and fields wrapper required');
  if(!['any','generated','observed'].includes(role))fail('record authority role');
  const {kind,fields}=record;
  if(!Object.hasOwn(SEMANTIC_RECORD_SCHEMA,kind)||fragments.has(kind))fail('unknown or fragment record kind');
  if(role==='generated'&&hostKinds.has(kind))fail('host-controlled record cannot be generated');
  if(role==='observed'&&kind!=='observe')fail('observed detail requires an observation');
  validateSemanticRecord(kind,fields);
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
