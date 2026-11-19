// A separately declared v8 record family. This does not extend the v6/v7
// detailed grammar or admit Symbol values into semantic-algorithm/2.
import {assertAlgorithmFields,assertAlgorithmDataArray,assertAlgorithmValue,
  stableAlgorithmJSON,isAlgorithmDataRecord} from './ir.js';
import {PROTOCOL_MACHINE_ADAPTERS_V8} from './protocol-machine-extensions-v8.js';

export const PROTOCOL_RECORD_V8_SCHEMA='semantic-protocol-record/1';
export const PROTOCOL_RECORD_V8_PREFIX='protocol ';
const baseFields={
  'symbol.create':['kind','id','description'],
  'symbol.for':['kind','id','key'],
  'symbol.read':['kind','symbol','operation','result','bind'],
  allocate:['kind','name','objectKind','length','properties','code','captures','functionKind','lexicalReceiver'],
  bind:['kind','name','value'],
  compute:['kind','expr','result','bind'],
  choose:['kind','expr','decision','path'],
  call:['kind','child','callee','receiver','arguments'],
  return:['kind','value','invocation'],throw:['kind','value','invocation'],
  end:['kind','completion'],
  'property.define':['kind','object','key','descriptor','success'],
  'property.get':['kind','object','key','receiver','result'],
  'property.set':['kind','object','key','receiver','value','success'],
  'property.delete':['kind','object','key','success'],
  'property.keys':['kind','object','mode','name','keys'],
  'property.prototype':['kind','object','prototype','success'],
  'property.preventExtensions':['kind','object'],
  'property.get.call':['kind','id','child','object','key','receiver'],
  'property.set.call':['kind','id','child','object','key','receiver','value'],
  'property.finish':['kind','id','completion']
};
const extensionRecords=new Map();
for(const adapter of PROTOCOL_MACHINE_ADAPTERS_V8){
  if(typeof adapter.id!=='string'||!adapter.id||typeof adapter.validateRecord!=='function'||typeof adapter.applyRecord!=='function')
    throw new TypeError('Protocol machine extension requires identity, validator and evaluator');
  for(const [kind,fields]of Object.entries(adapter.recordFields)){
    if(Object.hasOwn(baseFields,kind)||extensionRecords.has(kind))throw new TypeError('Duplicate protocol record '+kind);
    assertAlgorithmDataArray(fields,'protocol extension fields');extensionRecords.set(kind,adapter);
  }
}
export const PROTOCOL_RECORD_V8_FIELDS=Object.freeze(Object.fromEntries(Object.entries({...baseFields,
  ...Object.fromEntries([...extensionRecords].map(([kind,adapter])=>[kind,adapter.recordFields[kind]]))
}).map(([kind,fields])=>[kind,Object.freeze([...fields])])));
const fail=message=>{throw new TypeError('Invalid '+PROTOCOL_RECORD_V8_SCHEMA+': '+message);};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('identity');};
const boolean=value=>{if(typeof value!=='boolean')fail('boolean');};
const list=(value,label)=>{assertAlgorithmDataArray(value,label);if(value.length>4096)fail(label+' bound');};
export function validateProtocolValueV8(value){
  assertAlgorithmDataArray(value,'protocol value');
  if(value[0]==='symbol'){
    list(value,'symbol value');if(value.length!==2)fail('symbol shape');id(value[1]);return true;
  }
  assertAlgorithmValue(value);return true;
}
export function validateProtocolKeyV8(key){
  list(key,'property key');if(key.length!==2||!['str','symbol'].includes(key[0])||typeof key[1]!=='string')fail('tagged property key');
  if(key[0]==='symbol')id(key[1]);return true;
}
export function validateProtocolDescriptorV8(descriptor){
  if(!isAlgorithmDataRecord(descriptor))fail('descriptor must be ordinary data');
  if(descriptor?.kind==='data'){
    assertAlgorithmFields(descriptor,['kind','value','writable','enumerable','configurable'],'data descriptor');
    validateProtocolValueV8(descriptor.value);boolean(descriptor.writable);
  }else if(descriptor?.kind==='accessor'){
    assertAlgorithmFields(descriptor,['kind','get','set','enumerable','configurable'],'accessor descriptor');
    for(const field of ['get','set']){
      validateProtocolValueV8(descriptor[field]);if(!['ref','undefined'].includes(descriptor[field][0]))fail('accessor must be an owned closure or undefined');
    }
  }else fail('descriptor kind');
  boolean(descriptor.enumerable);boolean(descriptor.configurable);return true;
}
function expression(term,depth=0,budget={remaining:128}){
  if(!isAlgorithmDataRecord(term))fail('expression must be ordinary data');
  if(--budget.remaining<0||depth>16)fail('expression bound');
  if(term?.op==='literal'){assertAlgorithmFields(term,['op','value'],'protocol literal');validateProtocolValueV8(term.value);}
  else if(term?.op==='local'){assertAlgorithmFields(term,['op','name'],'protocol local');id(term.name);}
  else if(term?.op==='unary'){
    assertAlgorithmFields(term,['op','operator','arg'],'protocol unary');
    if(!['!','+','-','~','typeof','void'].includes(term.operator))fail('unary operator');expression(term.arg,depth+1,budget);
  }else if(term?.op==='binary'){
    assertAlgorithmFields(term,['op','operator','left','right'],'protocol binary');
    if(!['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!=','&','|','^','<<','>>','>>>'].includes(term.operator))fail('binary operator');
    expression(term.left,depth+1,budget);expression(term.right,depth+1,budget);
  }else fail('expression requires a separate property/call boundary');
}
function completion(value){
  assertAlgorithmFields(value,['kind','value'],'protocol completion');
  if(!['normal','throw'].includes(value.kind))fail('completion kind');validateProtocolValueV8(value.value);
}
export function validateProtocolRecordV8(record){
  if(!isAlgorithmDataRecord(record))fail('record must be ordinary data');
  const fields=PROTOCOL_RECORD_V8_FIELDS[record?.kind];if(!fields)fail('record kind');
  assertAlgorithmFields(record,fields,'protocol record');
  const adapter=extensionRecords.get(record.kind);
  if(adapter){if(adapter.validateRecord(record,{value:validateProtocolValueV8})!==true)fail('extension record validation');return true;}
  for(const field of ['id','name','object','child','invocation'])if(Object.hasOwn(record,field))id(record[field]);
  if(Object.hasOwn(record,'bind')&&record.bind!==null)id(record.bind);
  for(const field of ['value','result','decision','receiver','callee','symbol'])
    if(Object.hasOwn(record,field))validateProtocolValueV8(record[field]);
  if(Object.hasOwn(record,'success'))boolean(record.success);
  if(Object.hasOwn(record,'expr'))expression(record.expr);
  if(record.kind.startsWith('property.')&&Object.hasOwn(record,'key'))validateProtocolKeyV8(record.key);
  if(record.kind==='symbol.create'){
    validateProtocolValueV8(record.description);if(!['str','undefined'].includes(record.description[0]))fail('symbol description');
  }
  if(record.kind==='symbol.for'&&typeof record.key!=='string')fail('registry key');
  if(record.kind==='symbol.read'&&(record.symbol[0]!=='symbol'||!['description','keyFor','toString'].includes(record.operation)))fail('symbol read operation');
  if(record.kind==='allocate'){
    if(!['object','array','closure'].includes(record.objectKind))fail('allocation kind');
    if(record.objectKind==='array'){
      if(!Number.isSafeInteger(record.length)||record.length<0||record.length>4096)fail('array length');
    }else if(record.length!==null)fail('non-array length');
    list(record.properties,'allocation properties');
    for(const member of record.properties){assertAlgorithmFields(member,['key','value'],'property');validateProtocolKeyV8(member.key);validateProtocolValueV8(member.value);}
    list(record.captures,'closure captures');
    const bindings=new Set();for(const capture of record.captures){assertAlgorithmFields(capture,['binding','cell'],'capture');id(capture.binding);id(capture.cell);
      if(bindings.has(capture.binding))fail('duplicate capture binding');bindings.add(capture.binding);}
    if(record.objectKind==='closure'){
      id(record.code);if(!['ordinary','arrow'].includes(record.functionKind))fail('closure function kind');
      if(record.functionKind==='arrow')validateProtocolValueV8(record.lexicalReceiver);
      else if(record.lexicalReceiver!==null)fail('ordinary function lexical receiver');
    }else if(record.code!==null||record.captures.length||record.functionKind!==null||record.lexicalReceiver!==null)fail('non-closure metadata');
  }
  if(record.kind==='call'){
    if(record.callee[0]!=='ref')fail('callable identity');list(record.arguments,'call arguments');record.arguments.forEach(validateProtocolValueV8);
  }
  if(record.kind==='choose'&&!['then','else','evaluate-right','use-left'].includes(record.path))fail('choice path');
  if(record.kind==='property.define')validateProtocolDescriptorV8(record.descriptor);
  if(record.kind==='property.keys'){
    if(!['own','strings','symbols','enumerable-strings'].includes(record.mode))fail('own-key mode');
    list(record.keys,'own keys');record.keys.forEach(validateProtocolKeyV8);
  }
  if(record.kind==='property.prototype'&&record.prototype!==null&&record.prototype!=='ordinary'){
    validateProtocolValueV8(record.prototype);if(record.prototype[0]!=='ref')fail('prototype');
  }
  if(record.kind==='property.finish')completion(record.completion);
  if(record.kind==='end'&&!['return','throw'].includes(record.completion))fail('terminal completion');
  return true;
}
export function encodeProtocolRecordV8(record){validateProtocolRecordV8(record);return PROTOCOL_RECORD_V8_PREFIX+stableAlgorithmJSON(record);}
export function decodeProtocolRecordV8(line){
  if(typeof line!=='string'||!line.startsWith(PROTOCOL_RECORD_V8_PREFIX)||Buffer.byteLength(line,'utf8')>65536)fail('canonical line');
  let record;try{record=JSON.parse(line.slice(PROTOCOL_RECORD_V8_PREFIX.length));}catch{fail('JSON');}
  validateProtocolRecordV8(record);if(encodeProtocolRecordV8(record)!==line)fail('noncanonical bytes');return record;
}
