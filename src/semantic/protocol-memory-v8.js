// Bounded binary operations on the same public heap used by local regions.
// No native ArrayBuffer identity, owned archive, journal patch or source oracle
// crosses this interface. Only explicit construction/access/call claims do.
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {encode} from '../values.js';
import {binaryIndex,binaryInteger,binaryElement,binaryNumericKey,binaryValidIndex} from '../owned-binary-coercion.js';
import {SHARED_TYPES,newArrayBuffer,newSharedBuffer,newSharedView,newSharedDataView,
  isOwnedBuffer,isOwnedTypedView,isOwnedDataView,effectiveSharedLength,effectiveDataViewLength,
  readSharedElement,writeSharedElement,readSharedDataView,writeSharedDataView,
  DATA_VIEW_GETTERS,DATA_VIEW_SETTERS,growSharedBuffer,atomicSharedElement} from '../owned-shared-memory.js';
import {isBinaryMemoryKind,validateBinaryMemoryState} from '../binary-memory-validation.js';

export const MEMORY_PROFILE_V8='owned-binary-memory/1';
export const MEMORY_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'memory.construct':['kind','constructor','name','backing','arguments'],
  'memory.get':['kind','object','key','result'],
  'memory.set':['kind','object','key','value'],
  'memory.call':['kind','method','receiver','arguments','name','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const constructors=new Set(['ArrayBuffer','SharedArrayBuffer','DataView',...Object.keys(SHARED_TYPES)]);
const methods=new Set(['ArrayBuffer.isView','ArrayBuffer.prototype.slice','SharedArrayBuffer.prototype.slice',
  'SharedArrayBuffer.prototype.grow','TypedArray.prototype.subarray',
  ...[...DATA_VIEW_GETTERS,...DATA_VIEW_SETTERS].map(name=>'DataView.prototype.'+name),
  ...['load','store','add','sub','and','or','xor','exchange','compareExchange','wait','notify'].map(name=>'Atomics.'+name)]);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Binary-memory identity');};
export function validateMemoryRecordV8(record,{value:validateValue}){
  const fields=MEMORY_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'binary-memory record');
  for(const key of ['name','backing','object'])if(Object.hasOwn(record,key)&&record[key]!==null)id(record[key]);
  if(record.kind==='memory.construct')id(record.name);
  if(record.kind==='memory.get'||record.kind==='memory.set')id(record.object);
  if(record.kind==='memory.construct'&&!constructors.has(record.constructor))throw new TypeError('Unknown binary-memory constructor');
  if(Object.hasOwn(record,'arguments')){
    assertAlgorithmDataArray(record.arguments,'binary-memory arguments');
    if(record.arguments.length>64)throw new RangeError('Binary-memory argument bound');record.arguments.forEach(validateValue);
  }
  if(record.kind==='memory.get'||record.kind==='memory.set'){
    assertAlgorithmDataArray(record.key,'binary-memory key');
    if(record.key.length!==2||record.key[0]!=='str'||typeof record.key[1]!=='string')throw new TypeError('Binary-memory string key required');
  }
  if(record.kind==='memory.call'){
    if(!methods.has(record.method))throw new TypeError('Unknown binary-memory method');
    if(record.receiver!==null){validateValue(record.receiver);if(record.receiver[0]!=='ref')throw new TypeError('Binary-memory receiver identity');}
  }
  for(const key of ['value','result'])if(Object.hasOwn(record,key))validateValue(record[key]);
  return true;
}
function node(controller,id,api){const result=controller.heap.get(id);api.require(result&&isBinaryMemoryKind(result.kind),'known binary-memory object required');return result;}
function stored(owned){const {id,version,...value}=owned;return {...value,properties:new Map()};}
function allocate(controller,name,value,api){api.fresh(controller,name);controller.heap.set(name,stored(value));}
const undefinedValue=['undefined'];
const absent=value=>value===undefined||value[0]==='undefined';
function bufferOptions(controller,value,api){
  if(absent(value))return undefined;
  api.require(value[0]==='ref','shared buffer options require an ordinary data object');
  const options=api.heapNode(controller,value[1]);
  api.require(options.kind==='object'&&['ordinary',null,undefined].includes(options.prototype), 'shared buffer option prototype profile');
  const descriptor=api.ownDescriptor(options,['str','maxByteLength']);
  api.require(!descriptor||descriptor.kind==='data','shared buffer option getter requires its call protocol');
  return absent(descriptor?.value)?undefined:binaryIndex(descriptor.value);
}
function construct(controller,record,api){
  const args=record.arguments,type=record.constructor,input=args[0]??undefinedValue;
  if(type==='ArrayBuffer'||type==='SharedArrayBuffer'){
    api.require(record.backing===null,'buffer construction has no second backing identity');
    const length=binaryIndex(input);api.require(length<=1024,'binary-memory byte bound');
    if(type==='ArrayBuffer')api.require(absent(args[1]),'resizable ArrayBuffer requires its own profile');
    const max=type==='SharedArrayBuffer'?bufferOptions(controller,args[1],api):undefined;
    allocate(controller,record.name,type==='ArrayBuffer'?newArrayBuffer(record.name,length):newSharedBuffer(record.name,length,max),api);return;
  }
  let backing=input[0]==='ref'?controller.heap.get(input[1]):null,offset,length;
  if(type==='DataView'){
    api.require(isOwnedBuffer(backing)&&record.backing===null,'DataView needs an existing backing buffer');
    offset=binaryIndex(args[1]);length=absent(args[2])?undefined:binaryIndex(args[2]);
    allocate(controller,record.name,newSharedDataView(record.name,{...backing,id:input[1]},offset,length),api);return;
  }
  if(isOwnedBuffer(backing)){
    api.require(record.backing===null,'existing typed-array backing must not be allocated again');
    offset=binaryIndex(args[1]);api.require(offset%SHARED_TYPES[type].bytes===0,'typed-array byte alignment');
    length=absent(args[2])?undefined:binaryIndex(args[2]);backing={...backing,id:input[1]};
  }else{
    api.require(input[0]!=='ref'&&record.backing!==null&&record.backing!==record.name,'typed-array scalar construction requires a distinct fresh buffer');
    length=binaryIndex(input);offset=0;api.require(length*SHARED_TYPES[type].bytes<=1024,'binary-memory byte bound');
    backing=newArrayBuffer(record.backing,length*SHARED_TYPES[type].bytes);allocate(controller,record.backing,backing,api);
  }
  allocate(controller,record.name,newSharedView(record.name,backing,type,offset,length),api);
}
export function readMemoryPropertyV8(controller,object,key,api){
  const value=node(controller,object,api);
  if(isOwnedBuffer(value)){
    if(key==='byteLength'||key==='maxByteLength')return ['num',value[key]];
    if(value.kind==='array-buffer'&&['resizable','detached'].includes(key))return ['bool',false];
    if(value.kind==='shared-int32-buffer'&&key==='growable')return ['bool',value.growable];
  }else{
    const buffer=node(controller,value.bufferId,api);
    if(key==='buffer')return ['ref',value.bufferId];
    if(key==='byteOffset')return ['num',value.byteOffset];
    if(isOwnedDataView(value)&&key==='byteLength')return ['num',effectiveDataViewLength({...buffer,id:value.bufferId},value)];
    if(isOwnedTypedView(value)){
      const length=effectiveSharedLength(buffer,value),width=SHARED_TYPES[value.elementType].bytes;
      if(key==='length')return ['num',length];if(key==='byteLength')return ['num',length*width];
      if(key==='BYTES_PER_ELEMENT')return ['num',width];
      const index=binaryNumericKey(key);
      if(index!==undefined)return binaryValidIndex(index,length)?readSharedElement({...buffer,id:value.bufferId},value,index):undefinedValue;
    }
  }
  api.require(false,'binary-memory property requires a separate profile');
}
function invoke(controller,record,api){
  const {method,arguments:args}=record;
  const allocation=['TypedArray.prototype.subarray','ArrayBuffer.prototype.slice','SharedArrayBuffer.prototype.slice'].includes(method);
  api.require(allocation?(record.name!==null):(record.name===null),'binary-memory allocation claim');
  if(method==='ArrayBuffer.isView'){
    api.require(record.receiver===null,'ArrayBuffer.isView is a static operation');
    const value=args[0]?.[0]==='ref'?controller.heap.get(args[0][1]):null;
    return ['bool',isOwnedTypedView(value)||isOwnedDataView(value)];
  }
  if(method.startsWith('Atomics.')){
    api.require(record.receiver===null&&args[0]?.[0]==='ref','Atomics operation requires a view argument');
    const view=node(controller,args[0][1],api);api.require(view.kind==='shared-int32-view','single-agent Atomics requires shared typed storage');
    const buffer=node(controller,view.bufferId,api),operation=method.slice(8),index=binaryIndex(args[1]);
    api.require(binaryValidIndex(index,effectiveSharedLength(buffer,view)),'atomic view bounds');
    const backing={...buffer,id:view.bufferId},result=atomicSharedElement(backing,view,operation,index,args.slice(2));
    buffer.bytes=backing.bytes;return result;
  }
  api.require(record.receiver?.[0]==='ref','binary-memory receiver is required');
  const receiver=node(controller,record.receiver[1],api);
  if(method.startsWith('DataView.prototype.')){
    api.require(isOwnedDataView(receiver),'DataView receiver');
    const operation=method.slice('DataView.prototype.'.length),setter=DATA_VIEW_SETTERS.includes(operation),
      index=binaryIndex(args[0]),element=SHARED_TYPES[operation.slice(3)+'Array'];
    const buffer=node(controller,receiver.bufferId,api),backing={...buffer,id:receiver.bufferId};
    const converted=setter?binaryElement(args[1]??undefinedValue,element):null;
    const littleEndian=args[setter?2:1]??['bool',false];
    // ToBoolean never calls user code; even a reference is truthy.
    const truth=api.truthy(littleEndian);
    if(setter){writeSharedDataView(backing,receiver,operation,index,encode(converted),truth);buffer.bytes=backing.bytes;return undefinedValue;}
    return readSharedDataView(backing,receiver,operation,index,truth);
  }
  if(method==='TypedArray.prototype.subarray'){
    api.require(isOwnedTypedView(receiver),'typed-array subarray receiver');
    const buffer=node(controller,receiver.bufferId,api),full=effectiveSharedLength(buffer,receiver);
    const clip=n=>n<0?Math.max(0,full+n):Math.min(full,n),begin=clip(binaryInteger(args[0])),end=absent(args[1])?full:clip(binaryInteger(args[1]));
    allocate(controller,record.name,newSharedView(record.name,{...buffer,id:receiver.bufferId},receiver.elementType,
      receiver.byteOffset+begin*SHARED_TYPES[receiver.elementType].bytes,absent(args[1])&&receiver.lengthTracking?undefined:Math.max(0,end-begin)),api);
    return ['ref',record.name];
  }
  if(method==='SharedArrayBuffer.prototype.grow'){
    api.require(receiver.kind==='shared-int32-buffer','growable shared buffer receiver');growSharedBuffer(receiver,binaryIndex(args[0]));return undefinedValue;
  }
  const shared=method==='SharedArrayBuffer.prototype.slice';
  api.require(receiver.kind===(shared?'shared-int32-buffer':'array-buffer'),'buffer slice receiver');
  const clip=n=>n<0?Math.max(0,receiver.byteLength+n):Math.min(receiver.byteLength,n),
    begin=clip(binaryInteger(args[0])),end=absent(args[1])?receiver.byteLength:clip(binaryInteger(args[1])),length=Math.max(0,end-begin),
    output=shared?newSharedBuffer(record.name,length):newArrayBuffer(record.name,length);
  output.bytes=receiver.bytes.slice(begin,begin+length);allocate(controller,record.name,output,api);return ['ref',record.name];
}
export function applyMemoryRecordV8(controller,record,api){
  if(!MEMORY_RECORD_FIELDS[record.kind])return false;
  for(const value of record.arguments??[])api.known(controller,value);
  if(record.kind==='memory.construct')construct(controller,record,api);
  else if(record.kind==='memory.get'){
    const expected=readMemoryPropertyV8(controller,record.object,record.key[1],api);
    api.require(api.eq(expected,record.result),'false binary-memory read claim');
  }else if(record.kind==='memory.set'){
    api.known(controller,record.value);const view=node(controller,record.object,api);api.require(isOwnedTypedView(view),'indexed typed-array write required');
    const buffer=node(controller,view.bufferId,api),index=binaryNumericKey(record.key[1]);
    api.require(index!==undefined,'ordinary typed-array properties require their own protocol');
    const converted=binaryElement(record.value,SHARED_TYPES[view.elementType]);
    if(binaryValidIndex(index,effectiveSharedLength(buffer,view))){const backing={...buffer,id:view.bufferId};
      writeSharedElement(backing,view,index,encode(converted));buffer.bytes=backing.bytes;}
  }else{
    const expected=invoke(controller,record,api);api.require(api.eq(expected,record.result),'false binary-memory call result');
  }
  return true;
}
export function restoreMemoryStateV8(controller,api){
  const heap=Object.create(null),ids=new Set();
  for(const [id,value]of controller.heap)if(isBinaryMemoryKind(value.kind)){
    api.require(!Object.hasOwn(value,'id')&&!Object.hasOwn(value,'version'),'public binary-memory node has private archive fields');
    api.require(value.properties instanceof Map&&value.properties.size===0,'binary-memory ordinary properties are outside the profile');
    const {properties,...rest}=value;heap[id]={id,...api.copy(rest),version:0};ids.add(id);
  }
  validateBinaryMemoryState({heap},message=>api.require(false,message),ids);return {valid:true,objects:ids.size};
}
