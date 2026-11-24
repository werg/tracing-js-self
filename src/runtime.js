import { encode, decode, U, token, truthy, primitiveBinary, primitiveUnary } from './values.js';
import {WELL_KNOWN_SYMBOLS,wellKnownSymbol,stringPropertyKey,symbolPropertyKey,isSymbolPropertyKey,propertyKeyValue} from './property-keys.js';
import {SHARED_TYPES,SHARED_TYPE_NAMES,newArrayBuffer,isOwnedBuffer,isOwnedTypedView,isOwnedDataView,newSharedBuffer,newSharedView,newSharedDataView,effectiveDataViewLength,DATA_VIEW_GETTERS,DATA_VIEW_SETTERS,readSharedDataView,writeSharedDataView,growSharedBuffer,effectiveSharedLength,readSharedElement,writeSharedElement,atomicSharedElement} from './owned-shared-memory.js';
import {BinaryProfileError,BinaryResourceError,binaryIndex,binaryInteger,binaryElement,binaryNumericKey,binaryValidIndex} from './owned-binary-coercion.js';
import { parse, compile } from './frontend.js';
import {GENERATOR_INTRINSIC_PROTOTYPES,generatorIntrinsicParent,generatorIntrinsicProperty,generatorInstancePrototype} from './owned-generator-objects.js';
import { importGraph } from './training/graph.js';
import { parseTraining, TRAINING_PARSER, parseOwnedScript, OWNED_SCRIPT_PARSER } from './training/profile.js';
import { createArithmetic, advanceArithmetic, isOwnedArithmetic, ordinaryGet, ordinaryBuiltin, objectPrototype } from './spec-operations.js';
import { operationMutation } from './spec-mutations.js';
import {hostOperation,prepareHostRequest,HOST_METHODS,SUBSCRIPTION_CLOSERS} from './host/operations.js';
import {encodeNativeGraph,validateOwnedGraph} from './host/graph-codec.js';
import { specStep, ENGINE_REVISION } from './spec-schema.js';
import {supportsPinnedRegExp,testPinnedRegExp,scanPinnedReplacement} from './owned-pinned-regexp.js';
import {createNumberConversion,advanceNumberConversion} from './owned-number-conversion.js';
import {createPrimitiveConversion,advancePrimitiveConversion} from './owned-primitive-conversion.js';
import {ownedHasProperty,ownedHasOwnProperty} from './owned-has-property.js';
import {ensurePromisePrototype,ownedObjectStorage,ownedObjectHeap,ownedObjectValue} from './owned-object-storage.js';
import {validateExternalCallbackJob} from './external-callback-validation.js';
import {ownedGlobalProperty} from './owned-global-object.js';

class GuestFault extends Error {constructor(name,message){super(message);this.name=name;}}
const guestFault=(name,message)=>{throw new GuestFault(name,message);};
const isPrimitiveValue=value=>['undefined','null','bool','num','str','bigint','symbol'].includes(value[0]);
const ERROR_CONSTRUCTORS=['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError'];
function binaryGuest(operation){
  try{return operation();}catch(error){
    if(error instanceof BinaryProfileError)throw error;
    if(['TypeError','RangeError','SyntaxError'].includes(error.name))guestFault(error.name,error.message);
    throw error;
  }
}
function bindingTdz(binding,name){
  const error=new GuestFault('ReferenceError',`Cannot access '${name}' before initialization`);
  // Parameter initialization additionally binds its fault to the actual
  // uninitialized cell, checked independently before applying this event.
  if(binding.cell.kind==='parameter')error.parameterTdz={environment:binding.env.id,name};
  throw error;
}
const copy = value => structuredClone(value);
const freezeJson = value => {
  if(value && typeof value==='object'){
    for(const member of Object.values(value))freezeJson(member);
    Object.freeze(value);
  }
  return value;
};
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function requireDataOnly(value,path='state',seen=new WeakSet()){
  if(typeof value==='function'||typeof value==='symbol')
    throw new TypeError('Executable or symbol value in owned archive at '+path);
  if(value && typeof value==='object' && !seen.has(value)){
    seen.add(value);
    for(const [k,v] of Object.entries(value))requireDataOnly(v,path+'.'+k,seen);
  }
}
const tableNames = ['counters','envs','heap','promises','frames','effects','inputs','control','operations'];
const opNames = {
  CONST:'literal.materialize', GET:'binding.read',
  DEFAULT_GUARD:'binding.default.guard', PARAM_INIT:'binding.initialize', ENTER_BODY_ENV:'environment.enter', SET:'binding.write', UPDATE_BINDING:'binding.update', UPDATE_PROP:'property.update', DELETE_PROP:'property.delete', INIT:'binding.initialize', DECLARE:'binding.declare',
  DEF_FN:'function.define', BINARY:'primitive.binary', UNARY:'primitive.unary', POP:'stack.pop', DUP:'stack.duplicate', DUP2:'stack.duplicate',
  CALL:'call.enter', CONSTRUCT:'object.construct', NEW_PINNED_REGEXP:'regexp.allocate', UNSUPPORTED_EXPRESSION:'execution.unsupported', RETURN:'call.return', GENERATOR_START:'call.return', YIELD:'continuation.yield', THROW:'completion.throw', AWAIT:'async.await', TYPEOF_BINDING:'primitive.unary', MAKE_FUNCTION:'function.define', NEW_OBJECT:'object.allocate', NEW_ARRAY:'array.allocate', NEW_PROXY:'proxy.allocate',
  GET_TEMPLATE_OBJECT:'array.allocate', PROPERTY_KEY:'property.read', CLASS_CONSTRUCTOR_GUARD:'call.enter', CLASS_CREATE:'object.construct', CLASS_INITIALIZER:'property.write', CLASS_FINISH:'call.enter', PRIVATE_GET:'property.read', PRIVATE_GET_METHOD:'property.read', PRIVATE_HAS:'primitive.binary', PRIVATE_DEFINE:'property.write', PRIVATE_SET:'property.write', PRIVATE_UPDATE:'property.update',
  SET_HOME_OBJECT:'function.home', SUPER_REFERENCE:'reference.super', SUPER_GET:'property.read', SUPER_GET_METHOD:'property.read', SUPER_SET:'property.write', SUPER_CONSTRUCTOR:'property.read',
  DELEGATE_YIELD:'continuation.yield', DELEGATE_RESUME_KIND:'completion.pending.read', DELEGATE_RESUME_VALUE:'completion.pending.read', ITERATOR_THROW_MISSING:'call.enter',
  INSTANCEOF_DEFAULT:'primitive.binary', INSTANCEOF_RESULT:'primitive.binary',
  FOR_IN_CREATE:'object.allocate', FOR_IN_NEXT:'property.read', NEW_TARGET:'reference.this',
  SUPER_CALL:'object.construct', SUPER_FORWARD_CALL:'object.construct', SUPER_BIND:'call.enter',
  GET_PROP:'property.read', GET_METHOD:'property.read', SPREAD:'property.read', PUT_PROP:'property.write', DEFINE_LITERAL_PROP:'property.write', COPY_KEYS:'array.allocate', HAS_ENUMERABLE_OWN:'property.read', REQUIRE_COERCIBLE:'property.read', REQUIRE_OBJECT:'property.read', ITERATOR_ARRAY_GUARD:'property.read', PENDING_THROW:'completion.pending.read', APPEND_ARRAY:'property.write', TEMPLATE:'template.substitute', ENTER_SCOPE:'environment.enter',
  LEAVE_SCOPE:'environment.leave', CLONE_LOOP_ENV:'environment.iteration', JUMP:'control.jump', JUMP_IF_FALSE:'control.branch', LOGICAL_JUMP:'control.branch',
  TRY_ENTER:'completion.handler.enter', TRY_NORMAL:'completion.handler.normal',
  BIND_CATCH:'completion.catch.bind', END_FINALLY:'completion.finally.end',
  LOOP_ENTER:'control.loop.enter', LOOP_EXIT:'control.loop.exit', LOOP_JUMP:'completion.loop.jump', THIS:'reference.this'
};
const guestValue = (x) => Array.isArray(x) && (
  (x.length === 1 && ['undefined', 'null'].includes(x[0])) ||
  (x.length === 2 && (
    (x[0] === 'bool' && typeof x[1] === 'boolean') ||
    (x[0] === 'str' && typeof x[1] === 'string') ||
    (x[0] === 'bigint' && typeof x[1] === 'string' && /^(0|-?[1-9]\d*)$/.test(x[1])) ||
    (x[0] === 'num' && ((typeof x[1] === 'number' && Number.isFinite(x[1]) && !Object.is(x[1], -0)) ||
      ['-0','NaN','+Infinity','-Infinity'].includes(x[1])))
  ))
);
function lookup(draft, envId, name) {
  while(envId) {
    const env = draft.envs[envId];
    if(Object.hasOwn(env.bindings,name))return {env,name,cell:env.bindings[name]};
    envId=env.parent;
  }
  guestFault('ReferenceError',`${name} is not defined`);
}
function valueKey(tagged) {
  if(tagged[0]==='symbol')return symbolPropertyKey(tagged[1]);
  if (!['str','num','bool','null','undefined','bigint'].includes(tagged[0]))
    throw new TypeError('Property keys requiring guest coercion are unsupported');
  return stringPropertyKey(String(decode(tagged)));
}
function propertyKeySlot(frame,instruction){
  const op=instruction.op;
  if(['GET_PROP','GET_METHOD','UPDATE_PROP','DELETE_PROP','PROPERTY_KEY'].includes(op)||
    op==='DUP2'&&instruction.arg?.cachePropertyKey===true)return frame.stack.length-1;
  if(op==='BINARY'&&instruction.arg==='in')return frame.stack.length-2;
  if(op==='CALL'&&Number.isSafeInteger(instruction.arg)&&instruction.arg>=2){
    const start=frame.stack.length-instruction.arg-1,
      raw=frame.stack[start]?.value,callee=raw?.[0]==='method'?raw[1]:raw;
    if(callee?.[0]==='builtinfn'&&['Reflect.has','Reflect.deleteProperty'].includes(callee[1]))
      return start+2;
  }
  return op==='PUT_PROP'?frame.stack.length-2:null;
}
function retainedPropertyKey(frame,instruction,state){
  const stackIndex=propertyKeySlot(frame,instruction),key=frame.stack[stackIndex];
  if(stackIndex===null||key?.value[0]!=='ref')return null;
  // GetValue/PutValue perform ToObject before ToPropertyKey. A nullish base
  // must fail at the ordinary instruction without running the key's hooks.
  if(instruction.op==='BINARY'){
    const target=frame.stack[stackIndex+1]?.value;
    if(!['ref','promise','intrinsic','builtinfn','hostfn','host'].includes(target?.[0]))return null;
  }else if(instruction.op==='CALL'){
    // Reflect first validates the target, then converts the key; all call
    // arguments have already been evaluated. Refuse unrepresented exotics
    // without entering a conversion that their operation cannot finish.
    const target=frame.stack[stackIndex-1]?.value,raw=frame.stack[stackIndex-2]?.value,
      callee=raw?.[0]==='method'?raw[1]:raw,
      object=target?.[0]==='ref'?state.heap[target[1]]:
        target?.[0]==='promise'?state.promises[target[1]]:
          target?.[0]==='intrinsic'&&target[1]==='Promise.prototype'?{kind:'object'}:null;
    if(!object||!(['object','array','function','promise'].includes(object.kind)||
      callee[1]==='Reflect.deleteProperty'&&object.kind==='module-namespace'))return null;
  }else if(instruction.op!=='PROPERTY_KEY'&&['null','undefined'].includes(frame.stack[stackIndex-1]?.value[0]))return null;
  if(!['object','array'].includes(state.heap[key.value[1]]?.kind))
    throw new TypeError('PropertyKey conversion requires an owned ordinary object');
  let cacheBinding=null;
  if(instruction.op==='GET_PROP'&&instruction.arg?.cachePropertyKey){
    const name=instruction.arg.cachePropertyKey;
    if(typeof name!=='string'||!/^\[\[logical key [1-9]\d*\]\]$/.test(name))
      throw new Error('Invalid internal property reference binding');
    const {env,cell}=lookup(state,frame.envId,name);
    if(cell.kind!=='const'||!cell.initialized||!equal(cell.token.value,key.value))
      throw new Error('Property reference binding lost its original key');
    cacheBinding={envId:env.id,name,token:copy(cell.token),version:cell.version};
  }
  return {pc:frame.pc,opcode:instruction.op,stackIndex,stack:copy(frame.stack),cacheBinding,
    conversion:createPrimitiveConversion('PropertyKey',key.value,instruction.siteId)};
}
function arrayIndex(key) {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}
// A bounded owned iterator slice. Capture now, before later arguments/elements
// can mutate the input. The private snapshot preserves reference identities;
// it is never a guest value or a public semantic record.
function spreadSnapshot(heap,source) {
  const value=source.value,values=[],reads=[];
  if(value[0]==='str'){
    const text=value[1];
    for(let offset=0;offset<text.length;){
      if(values.length===10000)throw new RangeError('Owned spread length budget exceeded');
      const first=text.charCodeAt(offset),next=text.charCodeAt(offset+1);
      const width=first>=0xd800&&first<=0xdbff&&next>=0xdc00&&next<=0xdfff?2:1;
      values.push(token(['str',text.slice(offset,offset+width)],source.origin));
      offset+=width;
    }
  }else{
    const obj=value[0]==='ref'?heap[value[1]]:null;
    if(obj?.kind!=='array'||objectPrototype(obj)!=='Array.prototype'||
       Object.keys(obj.accessors??{}).length||Object.hasOwn(obj.properties,symbolPropertyKey('well-known:iterator')))
      throw new TypeError('Spread requires an ordinary dense array or primitive string');
    const length=decode(obj.properties.length.value);
    if(!Number.isSafeInteger(length)||length<0||length>10000)
      throw new RangeError('Owned spread length budget exceeded');
    const read=(key,slot)=>reads.push({kind:'property',objectId:obj.id,key,
      version:obj.propertyVersions?.[key]??0,shapeVersion:obj.shapeVersion??0,
      present:true,value:copy(slot.value),supplyingEvent:slot.origin??null});
    read('length',obj.properties.length);
    for(let i=0;i<length;i++){
      const slot=obj.properties[String(i)];
      if(!slot)throw new TypeError('Sparse spread is outside the bounded iterator profile');
      values.push(copy(slot));read(String(i),slot);
    }
  }
  return {values,reads};
}
// CreateListFromArrayLike is a read of length followed by indexed [[Get]]s,
// not iteration. Holes become undefined and inherited data remains visible.
// Getter, proxy and object-length coercion continuations need their own slice.
function callArgumentList(heap,value,{nullable=false}={}) {
  if(nullable&&['undefined','null'].includes(value[0]))return {values:[],reads:[]};
  if(value[0]!=='ref'){
    if(['undefined','null','bool','num','str','bigint','symbol'].includes(value[0]))
      guestFault('TypeError','Apply argument list must be an object');
    throw new TypeError('Apply argument list requires owned ordinary storage');
  }
  if(!['object','array'].includes(heap[value[1]]?.kind))
    throw new TypeError('Apply argument list requires owned ordinary storage');
  const length=ordinaryGet(heap,value,'length');
  if(!length)throw new TypeError('Apply argument length requires an owned data property');
  const raw=length.method.value;
  if(['symbol','bigint'].includes(raw[0]))guestFault('TypeError','Apply length cannot convert to a Number');
  if(!['undefined','null','bool','num','str'].includes(raw[0]))
    throw new TypeError('Apply argument length coercion requires its owned continuation');
  const numeric=Number(decode(raw)),size=Number.isNaN(numeric)||numeric<=0?0:Math.floor(numeric);
  if(!Number.isSafeInteger(size)||size>10000)throw new RangeError('Owned apply argument budget exceeded');
  const values=[],reads=[length.observation];
  for(let index=0;index<size;index++){
    const read=ordinaryGet(heap,value,String(index));
    if(!read)throw new TypeError('Apply indexed access requires an owned data property');
    values.push(copy(read.method));reads.push(read.observation);
  }
  return {values,reads};
}
// ES SameValue/SameValueZero over the owned value codec. Never use JS object
// equality for guest reference identities; they live in the serializable heap.
const comparableTags=new Set(['undefined','null','bool','str','num','bigint',
  'ref','promise','intrinsic','builtinfn','hostfn','symbol']);
function ownedSameValue(a,b,zeroEqual=false) {
  if(!comparableTags.has(a?.[0])||!comparableTags.has(b?.[0]))
    throw new TypeError('Unmodeled guest equality value');
  if(a[0]!==b[0])return false;
  if(a[0]==='num') {
    const x=decode(a),y=decode(b);
    return Object.is(x,y)||(zeroEqual&&x===0&&y===0);
  }
  return a[0]==='undefined'||a[0]==='null'||a[1]===b[1];
}
function scalarUpdate(previous,operator) {
  if(!['undefined','null','bool','str','num','bigint'].includes(previous[0]))
    throw new TypeError('Update coercion outside the bounded scalar profile');
  const old=previous[0]==='bigint'?decode(previous):Number(decode(previous));
  const delta=operator==='++'?1:-1;
  const next=encode(typeof old==='bigint'?old+BigInt(delta):old+delta);
  return {next,oldNumeric:encode(old)};
}
// Find a getter/setter in an owned prototype chain, without running native JS.
function propertyAccessor(heap, receiver, key) {
  let obj=heap[receiver[1]];
  const visited=new Set();
  while(obj && ['object','array','function','promise','module-namespace'].includes(obj.kind)){
    if(visited.has(obj.id))throw new Error('Cyclic owned prototype graph');
    visited.add(obj.id);
    if(Object.hasOwn(obj.properties??{},key))return null;
    if(Object.hasOwn(obj.accessors??{},key))return obj.accessors[key];
    const proto=objectPrototype(obj);
    if(proto===null||proto==='Object.prototype'||proto==='Array.prototype')return null;
    obj=heap[proto];
  }
  return null;
}
function proxyRoute(heap,receiver,operation) {
  let obj=heap[receiver[1]];
  const visited=new Set();
  while(obj?.kind==='proxy'){
    if(visited.has(obj.id))throw new TypeError('Cyclic proxy target chain');
    visited.add(obj.id);
    const handler=heap[obj.handlerId];
    if(!handler||!['object','array'].includes(handler.kind))
      throw new TypeError('Unsupported proxy handler identity');
    const trap=ordinaryGet(heap,['ref',handler.id],operation);
    if(!trap)throw new TypeError('Proxy handler accessor trap unmodeled');
    if(!['undefined','null'].includes(trap.method.value[0]))
      return {kind:'trap',method:trap.method.value,observation:trap.observation,
        target:['ref',obj.targetId],handler:['ref',handler.id],receiver};
    obj=heap[obj.targetId];
  }
  if(!obj||!['object','array'].includes(obj.kind))
    throw new TypeError('Unmodeled proxy target internal method');
  return {kind:'ordinary',target:['ref',obj.id],receiver};
}
function ownPropertyKeys(obj){
  if(obj.kind==='module-namespace')
    return [...obj.namespaceExportNames,symbolPropertyKey('well-known:toStringTag')];
  const present=key=>Object.hasOwn(obj.properties??{},key)||Object.hasOwn(obj.accessors??{},key);
  const known=[...new Set([...(obj.propertyOrder??[]),...Object.keys(obj.properties??{}),...Object.keys(obj.accessors??{})])].filter(present);
  return [...known.filter(arrayIndex).sort((a,b)=>Number(a)-Number(b)),...known.filter(key=>!arrayIndex(key)&&!isSymbolPropertyKey(key)),...known.filter(isSymbolPropertyKey)];
}
function enumerableOwn(obj,key){
  return Object.hasOwn(obj.accessors??{},key)?obj.accessors[key].enumerable:
    Object.hasOwn(obj.properties??{},key)&&obj.dataAttributes?.[key]?.enumerable!==false&&!(obj.kind==='array'&&key==='length');
}
function enumerationSnapshot(heap,source){
  const chain=[],keys=[],visited=new Set(),objects=new Set();
  if(source[0]==='str')return {chain,keys:Array.from({length:source[1].length},(_,i)=>String(i))};
  if(['undefined','null','bool','num','bigint','symbol'].includes(source[0]))return {chain,keys};
  if(source[0]!=='ref')throw new TypeError('For-in requires owned ordinary storage');
  let object=heap[source[1]];
  while(object){
    if(!['object','array','function'].includes(object.kind))throw new TypeError('For-in exotic enumeration is outside the ordinary profile');
    if(objects.has(object.id)||chain.length===128)throw new TypeError('For-in prototype chain exceeds owned budget');objects.add(object.id);
    const own=ownPropertyKeys(object).filter(key=>!isSymbolPropertyKey(key)).map(key=>[key,!!enumerableOwn(object,key)]);
    if(object.kind==='function')for(const key of ['name','length','prototype','caller','arguments'])
      if(!own.some(row=>row[0]===key))own.push([key,false]);
    const prototype=objectPrototype(object);chain.push({id:object.id,prototype,keys:own});
    for(const [key,enumerable] of own)if(!visited.has(key)){
      visited.add(key);if(enumerable)keys.push(propertyKeyValue(key)[1]);
      if(visited.size>10000)throw new RangeError('For-in key budget exceeded');
    }
    if(prototype===null||['Object.prototype','Array.prototype','Function.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(prototype))break;
    object=heap[prototype];if(!object)throw new Error('For-in prototype identity missing');
  }
  return {chain,keys};
}
function enumerationStillCompatible(heap,cursor,snapshot){
  if(snapshot.chain.length!==cursor.chain.length||snapshot.chain.some((row,index)=>
    row.id!==cursor.chain[index].id||row.prototype!==cursor.chain[index].prototype))return false;
  // Deletions are observed when a key is reached. Surviving captured
  // descriptors must keep their enumerability; additions are ignored because
  // the candidate sequence was fixed when the cursor was created.
  for(const captured of cursor.chain){
    const live=snapshot.chain.find(row=>row.id===captured.id);
    if(!live)return false;
    for(const [key,enumerable] of captured.keys){
      const current=live.keys.find(row=>row[0]===key);
      if(current&&current[1]!==enumerable)return false;
    }
  }
  return true;
}
function functionProperty(heap,object,key){
  const seen=new Set();
  while(object){
    if(!['object','array','function','generator','promise'].includes(object.kind)||seen.has(object.id))throw new TypeError('Unmodeled function prototype chain');
    seen.add(object.id);
    if(Object.hasOwn(object.properties??{},key))return {owner:object,slot:object.properties[key],attributes:object.dataAttributes?.[key]};
    if(Object.hasOwn(object.accessors??{},key))return {owner:object,accessor:object.accessors[key]};
    const proto=objectPrototype(object);
    if(GENERATOR_INTRINSIC_PROTOTYPES.includes(proto)){
      const found=generatorIntrinsicProperty(proto,key);return {slot:token(found.value),attributes:found.attributes};
    }
    if(proto==='Function.prototype'){
      if(key===symbolPropertyKey('well-known:hasInstance'))
        return {slot:token(['builtinfn','Function.prototype.hasInstance']),attributes:{writable:false}};
      if(['call','apply'].includes(key))return {slot:token(['builtinfn','Function.prototype.'+key]),
        attributes:{writable:true,enumerable:false,configurable:true}};
      return {};
    }
    if(proto===null||['Object.prototype','Array.prototype'].includes(proto))return {};
    object=heap[proto];if(!object)throw new Error('Function prototype identity missing');
  }
  return {};
}
// Ordinary [[Set]] reports failure; the source reference's strictness decides
// whether PutValue throws. Internal builtin writes keep putOwn's throwing
// contract, so Object.assign and array methods cannot silently ignore errors.
function ordinaryDataWriteFailure(heap,object,key,attributes){
  if(attributes?.writable===false){
    const property=propertyKeyValue(key),description=property[0]==='symbol'?
      (property[1].startsWith('well-known:')?['str','Symbol.'+property[1].slice(11)]:heap[property[1]]?.description):null,
      name=property[0]==='str'?property[1]:'Symbol('+(description?.[0]==='str'?description[1]:'')+')',
      receiver=object.kind==='array'?'[object Array]':objectPrototype(object)===null?'[object Object]':'#<Object>';
    return `Cannot assign to read only property '${name}' of object '${receiver}'`;
  }
  if(object.extensible===false&&!Object.hasOwn(object.properties,key)&&!Object.hasOwn(object.accessors??{},key))
    return 'Cannot add property to non-extensible object';
  return null;
}
function superProperty(heap,base,key){
  let current=base[0]==='ref'?base[1]:base[0]==='intrinsic'?base[1]:null;
  if(current===null)guestFault('TypeError','Super base is null');
  const seen=new Set();
  while(!['Object.prototype','Array.prototype','Function.prototype'].includes(current)){
    const object=heap[current];
    if(!object||!['object','array','function'].includes(object.kind)||seen.has(current))
      throw new TypeError('Super property requires an owned ordinary prototype chain');
    seen.add(current);
    if(Object.hasOwn(object.properties??{},key))return {owner:object,slot:object.properties[key],attributes:object.dataAttributes?.[key]};
    if(Object.hasOwn(object.accessors??{},key))return {owner:object,accessor:object.accessors[key]};
    current=objectPrototype(object);if(current===null)return {};
  }
  if(current==='Function.prototype'){
    if(key===symbolPropertyKey('well-known:hasInstance'))return {slot:token(['builtinfn','Function.prototype.hasInstance']),attributes:{writable:false}};
    if(['call','apply','bind','caller','arguments','constructor'].includes(key))throw new TypeError('Super Function intrinsic property is outside profile');
    if(key==='length'||key==='name')return {slot:token(key==='length'?['num',0]:['str','']),attributes:{writable:false}};
  }
  if(current==='Array.prototype'){
    if(key==='length')return {slot:token(['num',0])};
    if(key===symbolPropertyKey('well-known:iterator'))return {slot:token(['builtinfn','Array.prototype.values'])};
    if(['push','pop','includes','indexOf','lastIndexOf','slice','concat','join','splice','unshift','shift','at','filter','map','reduce','sort','some','every','find','findIndex','forEach','reverse','fill','copyWithin','toReversed','with','values','keys','entries'].includes(key))return {slot:token(['builtinfn','Array.prototype.'+key])};
    if(key==='toString')return {slot:token(['builtinfn','Array.toString'])};
    if(key in Array.prototype&&key!=='valueOf')throw new TypeError('Super Array intrinsic property is outside profile');
  }
  if(key==='toString'||key==='valueOf')return {slot:token(['builtinfn',key==='toString'?'Object.toString':'Object.valueOf'])};
  if(key in Object.prototype)throw new TypeError('Super Object intrinsic property is outside profile');
  return {};
}
function putOwn(obj,key,value,eventId,{literal=false}={}) {
  if(!literal&&obj.dataAttributes?.[key]?.writable===false)guestFault('TypeError','Cannot assign to read only property');
  if(obj.extensible===false&&!Object.hasOwn(obj.properties,key)&&!Object.hasOwn(obj.accessors??{},key))
    guestFault('TypeError','Cannot add property to non-extensible object');
  if(obj.declaredError)
    throw new TypeError('Declared error mutation is outside the bounded error profile');
  if (key === '__proto__'&&!literal) throw new TypeError('Prototype mutation is not implemented by the bounded profile');
  if (obj.kind === 'array' && key === 'length') {
    if (value[0] !== 'num') throw new TypeError('Array length coercion is outside the profile');
    const length = decode(value);
    if (!Number.isInteger(length) || length < 0 || length > 4294967295)
      guestFault('RangeError','Invalid array length');
    const old = decode(obj.properties.length.value);
    if (length < old) for (const name of Object.keys(obj.properties))
      if (arrayIndex(name) && Number(name) >= length) {
        delete obj.properties[name];
        obj.propertyVersions[name] = (obj.propertyVersions[name] ?? 0) + 1;
        obj.shapeVersion++;
      }
    obj.properties.length = token(['num',length],eventId);
    obj.propertyVersions.length = (obj.propertyVersions.length ?? 0) + 1;
    return;
  }
  const existed = Object.hasOwn(obj.properties,key);
  if(!existed&&!Object.hasOwn(obj.accessors??{},key))
    (obj.propertyOrder??=Object.keys(obj.properties).concat(Object.keys(obj.accessors??{}))).push(key);
  Object.defineProperty(obj.properties,key,{value:token(value,eventId),enumerable:true,configurable:true,writable:true});
  Object.defineProperty(obj.propertyVersions,key,{value:
    (Object.hasOwn(obj.propertyVersions,key) ? obj.propertyVersions[key] : 0) + 1,
    enumerable:true,configurable:true,writable:true});
  if (!existed) obj.shapeVersion++;
  if (obj.kind === 'array' && arrayIndex(key) && Number(key) >= decode(obj.properties.length.value)) {
    obj.properties.length = token(['num',Number(key)+1],eventId);
    obj.propertyVersions.length = (obj.propertyVersions.length ?? 0) + 1;
  }
}
function deleteOrdinaryOwn(object,key){
  const accessor=object.accessors?.[key],present=Object.hasOwn(object.properties??{},key)||!!accessor,
    success=!present||!(object.kind==='array'&&key==='length')&&
      (accessor??object.dataAttributes?.[key])?.configurable!==false;
  if(success&&present){
    if(accessor)delete object.accessors[key];else delete object.properties[key];
    if(object.dataAttributes)delete object.dataAttributes[key];
    if(object.propertyOrder)object.propertyOrder=object.propertyOrder.filter(member=>member!==key);
    object.propertyVersions[key]=(Object.hasOwn(object.propertyVersions??{},key)?object.propertyVersions[key]:0)+1;
    object.shapeVersion++;
  }
  return {accessor,present,success};
}
function diff(oldState, nextState) {
  const patches=[];
  for(const table of tableNames) {
    for(const id of new Set([...Object.keys(oldState[table]),...Object.keys(nextState[table])])) {
      const before=Object.hasOwn(oldState[table],id)?oldState[table][id]:null;
      const after=Object.hasOwn(nextState[table],id)?nextState[table][id]:null;
      if(!equal(before,after)) {
        if(after && typeof after==='object')after.version=(before?.version??0)+1;
        patches.push(table==='operations' ? operationMutation(before,after)
          : {kind:`${table}.replace`,table,id,before:copy(before),after:copy(after)});
      }
    }
  }
  return patches;
}
/** Small, independent, fail-closed runtime profile: see docs/STATUS.md. */
export class Runtime {
  constructor({adapters={},maxSteps=100000,randomSeed=null}={}) {
    if(randomSeed!==null && (!Number.isInteger(randomSeed)||randomSeed<0||randomSeed>0xffffffff))
      throw new TypeError('Deterministic random seed must be a uint32');
    this.adapters=adapters;
    this.maxSteps=maxSteps;
    this.sources=[];this.sites=[];this.programs={};this.events=[];this.chunks=[];
    this.checkpoints={};this.started=false;
    this.state={counters:{ids:{version:0,env:0,obj:0,promise:0,frame:0,effect:0,input:0,operation:0}},envs:{},heap:{},promises:{},frames:{},effects:{},inputs:{},operations:{},control:{a0:{version:0,activeFrameId:null,queue:[],timers:[],now:0,nextTimerId:0,timerTurns:0,status:'new'}}};
    if(randomSeed!==null){
      this.state.control.a0.randomSeed=randomSeed;
      this.state.control.a0.randomState=randomSeed;
    }
    this.chunkStart=0;this.chunkBefore='q0';this.result=U;
  }
  registerSource({text,url='<inline>',goal='script',trainingProfile=false,
    scriptProfile=false,moduleNamespaceIntrinsic=false}={}) {
    if(this.started)throw new Error('Source registry is frozen after start');
    if(goal!=='script')throw new SyntaxError('Only script goal is implemented');
    if(typeof text!=='string')throw new TypeError('Source text required');
    if(trainingProfile&&scriptProfile)throw new TypeError('Select one owned source profile');
    if(typeof moduleNamespaceIntrinsic!=='boolean'||
       moduleNamespaceIntrinsic&&!trainingProfile&&!scriptProfile)
      throw new TypeError('The module namespace intrinsic is reserved for linked modules');
    if(moduleNamespaceIntrinsic&&scriptProfile&&
       (!url.startsWith('owned-test262-module://')||
        !text.startsWith('"use strict";\nasync function __traced_eval_entry(self) {')))
      throw new TypeError('Script namespace capability requires a generated Test262 module entry');
    const sourceId=`src${this.sources.length+1}`;
    const compiled=compile(trainingProfile?parseTraining(text,{moduleNamespaceIntrinsic}):
      scriptProfile?parseOwnedScript(text,{moduleNamespaceIntrinsic}):parse(text));
    const rename={};
    for(const id of Object.keys(compiled.programs))rename[id]=`${sourceId}:${id}`;
    for(const [id,program] of Object.entries(compiled.programs))this.programs[rename[id]]={...program,id:rename[id],instructions:program.instructions.map(inst=>['DEF_FN','MAKE_FUNCTION'].includes(inst.op)?{...inst,arg:{...inst.arg,codeId:rename[inst.arg.codeId]},siteId:`${sourceId}:${inst.siteId}`}:{...inst,siteId:`${sourceId}:${inst.siteId}`})};
    this.sites.push(...compiled.sites.map(site=>({...site,siteId:`${sourceId}:${site.siteId}`,codeId:rename[site.codeId],sourceId})));
    const record={sourceId,text,url,goal,entry:rename[compiled.entry],
      parser:trainingProfile?TRAINING_PARSER:scriptProfile?OWNED_SCRIPT_PARSER:'bounded-pratt/2',
      ...(moduleNamespaceIntrinsic?{moduleNamespaceIntrinsic:true}:{})};
    this.sources.push(record);return record;
  }
  next(draft,kind) {const ids=draft.counters.ids;return `${kind==='operation'?'op':kind[0]}${++ids[kind]}`;}
  newEnv(draft,parent=null) {const id=this.next(draft,'env');draft.envs[id]={id,parent,bindings:{},version:0};return id;}
  newSymbol(draft,description,eventId,registeredKey=undefined){
    const id=this.next(draft,'obj');
    draft.heap[id]={id,kind:'symbol',description:copy(description),
      ...(registeredKey===undefined?{}:{registeredKey}),properties:{},propertyVersions:{},shapeVersion:0,version:0};
    return ['symbol',id];
  }
  moduleNamespaceDescriptor(draft,namespace,key,value,eventId){
    const id=this.next(draft,'obj');
    const attributes=key===symbolPropertyKey('well-known:toStringTag')?
      {writable:false,enumerable:false,configurable:false}:
      {writable:true,enumerable:true,configurable:false};
    const descriptor=draft.heap[id]={id,kind:'object',properties:{},
      propertyVersions:{},shapeVersion:0,version:0};
    for(const [name,item] of Object.entries({value,
      writable:['bool',attributes.writable],enumerable:['bool',attributes.enumerable],
      configurable:['bool',attributes.configurable]}))putOwn(descriptor,name,item,eventId);
    return ['ref',id];
  }
  startModuleNamespaceRead(draft,caller,namespace,key,kind,details,eventId){
    const accessor=Object.hasOwn(namespace.accessors??{},key)?namespace.accessors[key]:null;
    const getter=accessor?.get?.value;
    if(!getter||getter[0]!=='ref'||draft.heap[getter[1]]?.kind!=='function')
      throw new Error('Module namespace export lacks its owned live-cell getter');
    const fn=draft.heap[getter[1]];
    if(fn.async||this.programs[fn.codeId]?.generator)
      throw new Error('Module namespace live-cell getter is not synchronous');
    const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,caller.id,null,[],
      this.functionThis(fn,['ref',namespace.id]),fn.id);
    caller.pendingModuleNamespace={kind,namespaceId:namespace.id,key,
      waitingFrameId:child,...details};
    draft.control.a0.activeFrameId=child;
    return child;
  }
  finishModuleNamespaceRead(draft,caller,pending,value,eventId){
    const namespace=draft.heap[pending.namespaceId];
    if(namespace?.kind!=='module-namespace')throw new Error('Module namespace identity disappeared');
    if(pending.kind==='namespace-inspection')
      return this.finishModuleNamespaceInspection(draft,caller,namespace,pending,eventId);
    if(pending.kind==='descriptor'){
      this.stackPush(caller,this.moduleNamespaceDescriptor(draft,namespace,
        pending.key,value,eventId),eventId);
      return caller.id;
    }
    if(pending.kind==='define'){
      const outcome=this.moduleNamespaceDefinitionResult(namespace,pending.key,
        pending.descriptorFields,value,pending.reflect);
      if(outcome.error){
        if(pending.reflect){
          this.stackPush(caller,['bool',false],eventId);return caller.id;
        }
        const origin=pending.operationEventId??eventId,
          completion={type:'throw',errorType:'TypeError',message:outcome.error,origin};
        completion.value=this.caughtError(draft,completion,origin);
        return this.routeModuleNamespaceCompletion(draft,caller,completion,origin);
      }
      this.stackPush(caller,pending.reflect?['bool',true]:['ref',namespace.id],eventId);
      return caller.id;
    }
    throw new Error('Unknown module namespace continuation');
  }
  routeModuleNamespaceCompletion(draft,caller,completion,eventId){
    this.routeCompletion(draft,caller,completion,eventId);
    return caller.status==='running'?caller.id:draft.control.a0.activeFrameId;
  }
  moduleNamespaceDefinitionResult(namespace,key,fields,current,reflect){
    const attributes=key===symbolPropertyKey('well-known:toStringTag')?
      {writable:false,enumerable:false,configurable:false}:
      {writable:true,enumerable:true,configurable:false};
    const invalid=Object.hasOwn(fields,'get')||Object.hasOwn(fields,'set')||
      Object.hasOwn(fields,'configurable')&&truthy(fields.configurable)!==attributes.configurable||
      Object.hasOwn(fields,'enumerable')&&truthy(fields.enumerable)!==attributes.enumerable||
      Object.hasOwn(fields,'writable')&&truthy(fields.writable)!==attributes.writable||
      Object.hasOwn(fields,'value')&&!ownedSameValue(current,fields.value);
    return invalid?{error:'Cannot redefine property: '+key}:{ok:true};
  }
  moduleNamespaceDefine(draft,caller,namespace,key,descriptor,reflect,eventId){
    // The callers have already refused descriptor getters and inherited
    // fields. Preserve absent fields and ToPropertyDescriptor's validation
    // order before [[DefineOwnProperty]] can read a live export (and its TDZ).
    const fields={};
    for(const name of ['enumerable','configurable','value','writable','get','set']){
      if(!Object.hasOwn(descriptor.properties,name))continue;
      const value=descriptor.properties[name].value;
      if((name==='get'||name==='set')&&value[0]!=='undefined'&&
         primitiveUnary('typeof',value,draft.heap)[1]!=='function')
        guestFault('TypeError','Accessor must be a function or undefined');
      fields[name]=value;
    }
    if((Object.hasOwn(fields,'get')||Object.hasOwn(fields,'set'))&&
       (Object.hasOwn(fields,'value')||Object.hasOwn(fields,'writable')))
      guestFault('TypeError','Invalid mixed data/accessor descriptor');
    if(!Object.hasOwn(namespace.accessors??{},key)&&!Object.hasOwn(namespace.properties,key))
      return reflect?{value:['bool',false]}:
        guestFault('TypeError','Cannot redefine property: '+key);
    if(Object.hasOwn(namespace.accessors??{},key))
      return {child:this.startModuleNamespaceRead(draft,caller,namespace,key,'define',
        {descriptorFields:fields,reflect,operationEventId:eventId},eventId)};
    const outcome=this.moduleNamespaceDefinitionResult(namespace,key,fields,
      namespace.properties[key].value,reflect);
    if(outcome.error)return reflect?{value:['bool',false]}:
      guestFault('TypeError',outcome.error);
    return {value:reflect?['bool',true]:['ref',namespace.id]};
  }
  moduleNamespaceInspectionValue(draft,namespace,pending,eventId){
    if(pending.operation==='Object.keys'){
      const id=this.next(draft,'obj'),array=draft.heap[id]={id,kind:'array',
        properties:{length:token(['num',0],eventId)},propertyVersions:{length:0},
        shapeVersion:0,version:0};
      pending.keys.forEach((key,index)=>putOwn(array,String(index),['str',key],eventId));
      return ['ref',id];
    }
    if(pending.operation==='Object.seal')return ['ref',namespace.id];
    if(pending.operation==='Object.isSealed')return ['bool',true];
    if(pending.operation==='Object.freeze')return ['ref',namespace.id];
    if(pending.operation==='Object.isFrozen')return ['bool',true];
    throw new Error('Unknown module namespace inspection result');
  }
  advanceModuleNamespaceInspection(draft,caller,namespace,pending,eventId){
    while(pending.index<pending.keys.length){
      const key=pending.keys[pending.index];
      if(Object.hasOwn(namespace.accessors??{},key)){
        const child=this.startModuleNamespaceRead(draft,caller,namespace,key,
          'namespace-inspection',{operation:pending.operation,keys:pending.keys,
            index:pending.index,phase:pending.phase,
            operationEventId:pending.operationEventId},eventId);
        return {child};
      }
      // Module namespace [[OwnPropertyKeys]] also includes @@toStringTag.
      // Its own data descriptor is already known and has no live cell to read.
      pending.index++;
    }
    return {value:this.moduleNamespaceInspectionValue(draft,namespace,pending,eventId)};
  }
  startModuleNamespaceInspection(draft,caller,namespace,operation,key,eventId){
    if(operation==='Object.hasOwn'){
      const present=Object.hasOwn(namespace.properties??{},key)||
        Object.hasOwn(namespace.accessors??{},key);
      if(!present)return {value:['bool',false]};
      if(!Object.hasOwn(namespace.accessors??{},key))return {value:['bool',true]};
      return this.advanceModuleNamespaceInspection(draft,caller,namespace,
        {operation,keys:[key],index:0,phase:'read-export',operationEventId:eventId},eventId);
    }
    const keys=operation==='Object.keys'?namespace.namespaceExportNames.slice():
      ownPropertyKeys(namespace);
    return this.advanceModuleNamespaceInspection(draft,caller,namespace,
      {operation,keys,index:0,phase:'read-export',operationEventId:eventId},eventId);
  }
  finishModuleNamespaceInspection(draft,caller,namespace,pending,eventId){
    if(pending.operation==='Object.hasOwn'){
      this.stackPush(caller,['bool',true],eventId);return caller.id;
    }
    if(pending.operation==='Object.isFrozen'){
      this.stackPush(caller,['bool',false],eventId);return caller.id;
    }
    if(pending.operation==='Object.freeze'&&pending.phase==='read-export'){
      // SetIntegrityLevel first obtains the live data descriptor, then
      // [[DefineOwnProperty]] obtains it again before rejecting writable:false.
      const child=this.startModuleNamespaceRead(draft,caller,namespace,pending.key,
        'namespace-inspection',{operation:pending.operation,keys:pending.keys,
          index:pending.index,phase:'freeze-define',
          operationEventId:pending.operationEventId},eventId);
      return child;
    }
    if(pending.operation==='Object.freeze'){
      const origin=pending.operationEventId??eventId,
        completion={type:'throw',errorType:'TypeError',
          message:'Cannot redefine property: '+pending.key,origin};
      completion.value=this.caughtError(draft,completion,origin);
      return this.routeModuleNamespaceCompletion(draft,caller,completion,origin);
    }
    pending.index++;
    const outcome=this.advanceModuleNamespaceInspection(draft,caller,namespace,
      pending,eventId);
    if(outcome.child)return outcome.child;
    this.stackPush(caller,outcome.value,eventId);
    return caller.id;
  }
  symbolDescription(draft,value){
    if(value[1].startsWith('well-known:')){
      const name=value[1].slice('well-known:'.length);
      if(!WELL_KNOWN_SYMBOLS.includes(name))throw new TypeError('Unknown well-known symbol');
      return ['str','Symbol.'+name];
    }
    const entity=draft.heap[value[1]];
    if(entity?.kind!=='symbol')throw new TypeError('Unknown owned symbol');
    return entity.description;
  }
  functionProperties(draft,fn,eventId,{prototype=false}={}){
    fn.properties??={};fn.propertyVersions??={};fn.shapeVersion??=0;
    if(!prototype)return;
    if(fn.arrow||fn.async)return;
    if(this.programs[fn.codeId].generator){
      if(!fn.generatorFunction)throw new Error('Generator function metadata missing');
      return;
    }
    if(fn.nonConstructible)return;
    if(fn.prototypeInitialized)return;
    fn.prototypeInitialized=true;
    if(Object.hasOwn(fn.properties,'prototype'))return;
    const id=this.next(draft,'obj');
    draft.heap[id]={id,kind:'object',properties:{constructor:token(['ref',fn.id],eventId)},
      propertyVersions:{constructor:1},dataAttributes:{constructor:{enumerable:false,writable:true,configurable:true}},
      propertyOrder:['constructor'],shapeVersion:1,version:0};
    putOwn(fn,'prototype',['ref',id],eventId);
    fn.dataAttributes??={};fn.dataAttributes.prototype={enumerable:false,writable:true,configurable:false};
  }
  generatorFunctionProperties(draft,fn,name,eventId){
    if(!this.programs[fn.codeId].generator)return;
    if(fn.generatorFunction)throw new Error('Generator function metadata initialized twice');
    fn.generatorFunction=true;fn.nonConstructible=true;fn.prototype='GeneratorFunction.prototype';
    this.functionProperties(draft,fn,eventId);
    if(name[0]==='symbol'){
      const description=this.symbolDescription(draft,name);name=['str',description[0]==='undefined'?'':'['+description[1]+']'];
    }else if(['str','num','bool','null','undefined','bigint'].includes(name[0]))name=['str',String(decode(name))];
    else throw new TypeError('Generator inferred name requires an owned property key');
    for(const [key,value] of [['length',['num',this.programs[fn.codeId].functionLength??this.programs[fn.codeId].params.length]],['name',name]]){
      putOwn(fn,key,value,eventId);(fn.dataAttributes??={})[key]={writable:false,enumerable:false,configurable:true};
    }
    const id=this.next(draft,'obj');
    draft.heap[id]={id,kind:'object',prototype:'Generator.prototype',properties:{},propertyVersions:{},shapeVersion:0,version:0};
    putOwn(fn,'prototype',['ref',id],eventId);
    fn.dataAttributes.prototype={writable:true,enumerable:false,configurable:false};
  }
  classFunctionProperties(draft,fn,name,eventId,prefix=null){
    this.functionProperties(draft,fn,eventId);
    if(name[0]==='symbol'){
      const description=this.symbolDescription(draft,name);name=['str',description[0]==='undefined'?'':'['+description[1]+']'];
    }else name=['str',String(decode(name))];
    if(prefix!==null)name=['str',prefix+' '+name[1]];
    for(const [key,value] of [['length',['num',this.programs[fn.codeId].functionLength??this.programs[fn.codeId].params.length]],['name',name]]){
      if(Object.hasOwn(fn.properties,key)&&!fn.generatorFunction)throw new Error('Class function metadata initialized twice');
      if(fn.generatorFunction&&key==='length')continue;
      putOwn(fn,key,value,eventId,{literal:fn.generatorFunction===true});(fn.dataAttributes??={})[key]={writable:false,enumerable:false,configurable:true};
    }
  }
  ordinaryHasInstance(draft,constructor,candidate,eventId){
    const target=constructor[0]==='ref'?draft.heap[constructor[1]]:null;
    const intrinsic=constructor[0]==='intrinsic'&&!['Math','Reflect','Atomics','Object.prototype','Array.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(constructor[1]);
    if(target?.kind!=='function'&&!intrinsic&&constructor[0]!=='builtinfn')return false;
    if(!['ref','promise','intrinsic','builtinfn','hostfn'].includes(candidate[0]))return false;
    let sought;
    if(target?.kind==='function'){
      this.functionProperties(draft,target,eventId,{prototype:true});
      const prototype=target.properties.prototype?.value??U;
      if(prototype[0]==='ref')sought=prototype[1];
      else if(prototype[0]==='intrinsic'&&['Object.prototype','Array.prototype','Function.prototype'].includes(prototype[1]))sought=prototype[1];
      else if(['promise','builtinfn','hostfn','intrinsic'].includes(prototype[0]))throw new TypeError('Exotic constructor prototype outside ordinary instanceof profile');
      else guestFault('TypeError','Function has non-object prototype in instanceof check');
    }else if(intrinsic&&['Object','Array'].includes(constructor[1]))sought=constructor[1]+'.prototype';
    else if(constructor[0]==='builtinfn')guestFault('TypeError','Function has non-object prototype in instanceof check');
    else throw new TypeError('Intrinsic instanceof requires its owned prototype profile');
    let current=candidate,seen=new Set();
    while(true){
      let prototype;
      if(current[0]==='ref'){
        const object=draft.heap[current[1]];
        if(!object)throw new Error('Unknown instanceof identity');
        if(object.kind==='proxy')throw new TypeError('Proxy GetPrototypeOf requires an owned instanceof continuation');
        if(seen.has(object.id))throw new Error('Cyclic instanceof prototype');seen.add(object.id);
        prototype=objectPrototype(object);
      }else if(current[0]==='intrinsic'&&GENERATOR_INTRINSIC_PROTOTYPES.includes(current[1]))prototype=generatorIntrinsicParent(current[1]);
      else if(current[0]==='intrinsic'&&current[1]==='Object.prototype')prototype=null;
      else prototype='Object.prototype';
      if(prototype===null)return false;
      if(prototype===sought)return true;
      current=['intrinsic',prototype];
      if(!['Object.prototype','Array.prototype','Function.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(prototype))current=['ref',prototype];
      else if(prototype==='Object.prototype')return false;
    }
  }
  beginConstruction(draft,constructor,args,callerFrameId,eventId,newTarget=constructor){
    const target=constructor[0]==='ref'?draft.heap[constructor[1]]:null;
    if(target?.kind!=='function'||target.arrow||target.async||this.programs[target.codeId].generator||target.nonConstructible)
      guestFault('TypeError','Function is not a constructor');
    if(target.derivedConstructor){
      const id=this.newFrame(draft,target.codeId,target.closureEnvId,callerFrameId,null,args,U,target.id),frame=draft.frames[id];
      frame.constructKind='derived';frame.constructorId=target.id;frame.thisInitialized=false;
      frame.newTarget=newTarget;frame.constructorArguments=copy(args);return id;
    }
    const newTargetFunction=newTarget[0]==='ref'?draft.heap[newTarget[1]]:null;
    if(newTargetFunction?.kind!=='function')throw new TypeError('Owned construction needs an ordinary newTarget');
    this.functionProperties(draft,newTargetFunction,eventId,{prototype:true});
    const supplied=newTargetFunction.properties.prototype?.value??U,prototype=supplied[0]==='ref'?draft.heap[supplied[1]]:null;
    if(prototype&&!['object','array'].includes(prototype.kind))throw new TypeError('Constructor prototype outside owned ordinary object profile');
    const intrinsicPrototype=supplied[0]==='intrinsic'&&['Object.prototype','Array.prototype','Function.prototype'].includes(supplied[1])?supplied[1]:null;
    const receiver=this.next(draft,'obj');draft.heap[receiver]={id:receiver,kind:'object',
      prototype:prototype?.id??intrinsicPrototype??'Object.prototype',properties:{},propertyVersions:{},shapeVersion:0,version:0};
    if(target.instanceInitializer){
      const initializer=draft.heap[target.instanceInitializer[1]],id=this.newFrame(draft,initializer.codeId,initializer.closureEnvId,callerFrameId,null,[],['ref',receiver],initializer.id);
      draft.frames[id].afterInstanceInitialization={constructorId:target.id,args,receiver:['ref',receiver],newTarget};return id;
    }
    const id=this.newFrame(draft,target.codeId,target.closureEnvId,callerFrameId,null,args,['ref',receiver],target.id);
    draft.frames[id].constructReceiver=['ref',receiver];draft.frames[id].newTarget=newTarget;
    draft.frames[id].constructorId=target.id;draft.frames[id].constructKind='base';draft.frames[id].thisInitialized=true;return id;
  }
  newPromise(draft,status='pending',value=null) {
    const id=this.next(draft,'promise');draft.promises[id]={id,kind:'promise',prototype:'Promise.prototype',
      properties:{},propertyVersions:{},shapeVersion:0,extensible:true,
      status,value,observers:[],adopters:[],adopting:null,resolverCalled:false,thenableSerial:0,thenableLocked:false,thenableSeen:[],version:0};return id;
  }
  functionThis(fn,receiver=U){
    return !fn.arrow?receiver:fn.lexicalThisFrameId?['thisbinding',fn.lexicalThisFrameId]:fn.lexicalThis;
  }
  setHomeObject(draft,fn,home,eventId){
    if(fn.kind!=='function'||fn.arrow||home[0]!=='ref'||!['object','array','function'].includes(draft.heap[home[1]]?.kind))
      throw new Error('Invalid owned method home object');
    if(fn.homeObject)throw new Error('Method home object initialized twice');
    fn.homeObject=home;
    fn.closureEnvId=this.newEnv(draft,fn.closureEnvId);
    draft.envs[fn.closureEnvId].bindings['[[home object]]']={kind:'const',initialized:true,token:token(home,eventId),version:0};
  }
  newFrame(draft,codeId,parentEnv,callerFrameId=null,asyncPromiseId=null,args=[],thisValue=U,functionId=null,scriptEnvironmentId=null) {
    const thisBindingFrameId=thisValue[0]==='thisbinding'?thisValue[1]:null;
    if(thisBindingFrameId){
      if(!draft.frames[thisBindingFrameId])throw new Error('Lexical receiver frame is missing');
      thisValue=draft.frames[thisBindingFrameId].thisValue;
    }
    const id=this.next(draft,'frame'),envId=scriptEnvironmentId??this.newEnv(draft,parentEnv);
    const params=this.programs[codeId].params;
    const restIndex=this.programs[codeId].restIndex??-1;
    params.forEach((name,i)=>{
      let binding=args[i]??token(U);
      if(restIndex===i){
        const extras=args.slice(i);
        if(extras.length>10000)throw new RangeError('Rest argument budget exceeded');
        const id=this.next(draft,'obj');
        const array=draft.heap[id]={id,kind:'array',properties:{
          length:token(['num',extras.length])},propertyVersions:{length:0},
          shapeVersion:0,version:0};
        for(let k=0;k<extras.length;k++)putOwn(array,String(k),extras[k].value,null);
        binding=token(['ref',id]);
      }
      draft.envs[envId].bindings[name]={kind:'parameter',
        initialized:!this.programs[codeId].parameterExpressions,token:binding,version:0};
    });
    for(const name of this.programs[codeId].patternNames??[])
      draft.envs[envId].bindings[name]={kind:'parameter',initialized:false,token:token(U),version:0};
    for(const name of this.programs[codeId].parameterExpressions?[]:(this.programs[codeId].varNames??[]))
      if(!Object.hasOwn(draft.envs[envId].bindings,name))
        draft.envs[envId].bindings[name]={kind:'var',initialized:true,
          token:token(U),version:0};
    draft.frames[id]={id,codeId,pc:0,stack:[],envId,callerFrameId,asyncPromiseId,status:'running',blockedOn:null,awaiting:null,operationId:null,pendingCoercionThrow:null,handlers:[],loops:[],thisValue,version:0};
    if(thisBindingFrameId)draft.frames[id].thisBindingFrameId=thisBindingFrameId;
    if(this.programs[codeId].generator){
      const generatorId=this.next(draft,'obj');
      const target=draft.heap[functionId];
      if(target?.codeId!==codeId||target.closureEnvId!==parentEnv)throw new Error('Generator frame lost its callee identity');
      draft.heap[generatorId]={id:generatorId,kind:'generator',frameId:id,functionId,prototype:generatorInstancePrototype(draft.heap,target),state:'initializing',
        properties:{},propertyVersions:{},shapeVersion:0,version:0};
      draft.frames[id].generatorId=generatorId;
    }
    return id;
  }
  start(source) {
    if(this.started)throw new Error('Run already started');
    if(typeof source==='string')source=this.registerSource({text:source});
    if(!this.sources.some(s=>s.sourceId===source.sourceId))throw new Error('Unknown source');
    const s=this.state,global=this.newEnv(s);
    s.envs[global].bindings.host={kind:'const',initialized:true,token:token(['host','demo'])};
    s.envs[global].bindings.Promise={kind:'const',initialized:true,token:token(['intrinsic','Promise'])};
    for(const name of ['queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval'])
      s.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['builtinfn',name]),version:0};
    for(const name of ['Object','Array','Number','BigInt','String','Symbol','Reflect','Math','ArrayBuffer','SharedArrayBuffer','DataView',...SHARED_TYPE_NAMES,'Atomics'])
      s.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['intrinsic',name]),version:0};
    s.envs[global].bindings.undefined={kind:'const',initialized:true,token:token(U),version:0};
    s.envs[global].bindings.globalThis={kind:'const',initialized:true,token:token(['intrinsic','globalThis']),version:0};
    if(source.parser===OWNED_SCRIPT_PARSER){
      for(const [name,value] of [['NaN',['num','NaN']],['Infinity',['num','+Infinity']]])
        s.envs[global].bindings[name]={kind:'const',initialized:true,token:token(value),version:0};
      for(const name of ['Set',...ERROR_CONSTRUCTORS])
        s.envs[global].bindings[name]={kind:'const',initialized:true,token:token(['intrinsic',name]),version:0};
      for(const name of ['parseInt','isNaN','print'])
        s.envs[global].bindings[name]={kind:'const',initialized:true,token:token(['builtinfn',name]),version:0};
      s.control.a0.test262Output=[];
    }
    s.control.a0.globalEnvId=global;
    s.control.a0.activeFrameId=this.newFrame(s,source.entry,global);
    s.control.a0.status='running';this.started=true;
    this.initialState=copy(this.state);this.checkpoints.q0=copy(this.state);
    return this;
  }
  /** Evaluate separately parsed scripts in one fresh owned global environment.
   * Script declaration instantiation occurs at its entry, after prior scripts,
   * rather than hoisting future test declarations into harness initialization. */
  startScriptSequence(sources){
    if(this.started)throw new Error('Run already started');
    if(!Array.isArray(sources)||!sources.length||new Set(sources.map(source=>source?.sourceId)).size!==sources.length||
      sources.some(source=>source?.parser!==OWNED_SCRIPT_PARSER||!this.sources.includes(source)))
      throw new TypeError('Script sequence requires unique registered owned script sources');
    this.start(sources[0]);
    const environmentId=this.state.frames[this.state.control.a0.activeFrameId].envId;
    if(sources.some(source=>source.moduleNamespaceIntrinsic===true))
      this.state.envs[environmentId].bindings.__traced_eval_create_module_namespace={
        kind:'const',initialized:true,
        token:token(['builtinfn','__traced_eval_create_module_namespace']),version:0};
    this.state.control.a0.scriptSequence={sourceIds:sources.map(source=>source.sourceId),nextIndex:1,environmentId};
    this.entrySpec={kind:'scripts',sourceIds:sources.map(source=>source.sourceId)};
    this.initialState=copy(this.state);this.checkpoints.q0=copy(this.state);
    return this;
  }
  enterNextScript(){
    const control=this.state.control.a0,sequence=control.scriptSequence;
    if(!sequence||sequence.nextIndex>=sequence.sourceIds.length||control.activeFrameId||
      control.queue.length||['failed','unsupported'].includes(control.status)||this.prepared())
      throw new Error('No ready next owned script');
    const source=this.sources.find(source=>source.sourceId===sequence.sourceIds[sequence.nextIndex]);
    if(source?.parser!==OWNED_SCRIPT_PARSER)throw new Error('Unregistered owned script entry');
    const program=this.programs[source.entry],environment=this.state.envs[sequence.environmentId];
    // Full GlobalDeclarationInstantiation (global property descriptors and
    // lexical conflicts) remains a separate profile. Never silently overwrite
    // an earlier lexical binding while executing a harness/test sequence.
    const declarations=program.instructions.filter(inst=>inst.op==='DEF_FN').map(inst=>inst.arg.name);
    for(const name of [...program.varNames,...declarations]){
      const existing=environment.bindings[name];
      if(existing&&!['var','function'].includes(existing.kind))
        throw new TypeError('Unsupported owned script global declaration collision: '+name);
    }
    return this.commit('script.enter',s=>{
      const id=this.newFrame(s,source.entry,s.control.a0.globalEnvId,null,null,[],U,null,sequence.environmentId);
      s.control.a0.activeFrameId=id;s.control.a0.scriptSequence.nextIndex++;
      s.control.a0.status='running';delete s.control.a0.completion;
      return {operands:[['str',source.sourceId]],causes:[{kind:'invocation',frameId:id}]};
    },{sourceId:source.sourceId,codeId:source.entry});
  }
  /** Explicit invocation entry for training-js/1. The top level contains only
   * an exact strict directive and named ordinary function declarations. */
  startEntry({text,source=null,functionName,args=[],allowAsync=false,allowHost=false,
    moduleNamespaceIntrinsic=false}={}) {
    if(this.started)throw new Error('Run already started');
    if(typeof moduleNamespaceIntrinsic!=='boolean')
      throw new TypeError('Invalid internal module namespace entry option');
    if(!source)source=this.registerSource({text,trainingProfile:true,moduleNamespaceIntrinsic});
    if(source.parser!==TRAINING_PARSER)throw new SyntaxError('Entry requires the Acorn training profile');
    if(!!source.moduleNamespaceIntrinsic!==moduleNamespaceIntrinsic)
      throw new TypeError('Entry module namespace option does not match compiled source');
    const ast=parseTraining(source.text,{moduleNamespaceIntrinsic});
    if(!ast.body.length || ast.body[0].type!=='Expression' ||
       ast.body[0].expr.type!=='Literal' ||
       ast.body[0].expr.value[0]!=='str' || ast.body[0].expr.value[1]!=='use strict' ||
       ast.body.slice(1).some(n=>!['Function','Variable','VariableGroup'].includes(n.type) ||
         (n.type==='Function' && n.async && !allowAsync)))
      throw new SyntaxError('training-js/1 requires a strict owned static/function bundle');
    const definitions=this.programs[source.entry].instructions.filter(x=>x.op==='DEF_FN');
    if(new Set(definitions.map(x=>x.arg.name)).size!==definitions.length)
      throw new SyntaxError('Duplicate function declaration');
    const selected=definitions.find(x=>x.arg.name===functionName);
    if(!selected)throw new ReferenceError('Unknown entry function');
    if(this.programs[selected.arg.codeId].generator)throw new SyntaxError('Generator entry requires an ordinary consumer wrapper');
    const state=this.state, global=this.newEnv(state);
    state.envs[global].bindings.undefined={kind:'const',initialized:true,token:token(U),version:0};
    state.envs[global].bindings.NaN={kind:'const',initialized:true,token:token(['num','NaN']),version:0};
    state.envs[global].bindings.Infinity={kind:'const',initialized:true,token:token(['num','+Infinity']),version:0};
    state.envs[global].bindings.globalThis={kind:'const',initialized:true,token:token(['intrinsic','globalThis']),version:0};
    if(allowHost){
      state.envs[global].bindings.host={kind:'const',initialized:true,
        token:token(['host','demo']),version:0};
      // Clock reads are external journaled effects, never VM wall-clock reads.
      state.envs[global].bindings.Date={kind:'const',initialized:true,
        token:token(['intrinsic','Date']),version:0};
      state.envs[global].bindings.console={kind:'const',initialized:true,
        token:token(['host','platform.console']),version:0};
    }
    for(const name of ['parseInt','isNaN','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval'])
      state.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['builtinfn',name]),version:0};
    for(const name of ['Object','Array','Number','BigInt','String','Symbol','Reflect','Math','Promise','Set',...ERROR_CONSTRUCTORS,'ArrayBuffer','SharedArrayBuffer','DataView',...SHARED_TYPE_NAMES,'Atomics'])
      state.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['intrinsic',name]),version:0};
    if(moduleNamespaceIntrinsic)
      state.envs[global].bindings.__traced_eval_create_module_namespace={kind:'const',
        initialized:true,token:token(['builtinfn','__traced_eval_create_module_namespace']),version:0};
    state.control.a0.globalEnvId=global;
    const initializers=ast.body.slice(1).flatMap(n=>
      n.type==='VariableGroup'?n.declarations:n.type==='Variable'?[n]:[]);
    for(const init of initializers){
      if(Object.hasOwn(state.envs[global].bindings,init.id))
        throw new SyntaxError('Duplicate or reserved global initializer '+init.id);
      const val=init.init;
      let initial=null;
      if(val?.type==='OwnedPinnedRegExp'){
        if(!supportsPinnedRegExp(val.pattern,val.flags))
          throw new SyntaxError('Unsupported static RegExp initializer');
        const id=this.next(state,'obj');
        state.heap[id]={id,kind:'regexp',properties:{
          '[[Source]]':token(['str',val.pattern]),
          '[[Flags]]':token(['str',val.flags]),
          lastIndex:token(['num',0])
        },propertyVersions:{'[[Source]]':0,'[[Flags]]':0,lastIndex:0},
        shapeVersion:3,version:0};
        initial=['ref',id];
      }
      initial ??=val?.type==='Identifier'&&val.name==='undefined'?U:
        val?.type==='Literal'?val.value:
        val?.type==='Member' && val.object?.type==='Identifier' &&
        val.object.name==='Math' && val.property?.type==='Literal' &&
        ['ceil','floor','min','max'].includes(val.property.value?.[1])
          ?['builtinfn','Math.'+val.property.value[1]]:null;
      if(!initial)throw new SyntaxError('Unsupported static global initializer');
      state.envs[global].bindings[init.id]={kind:init.kind,initialized:true,
        token:token(initial),version:0};
    }
    for(const def of definitions){
      const id=this.next(state,'obj');
      state.heap[id]={id,kind:'function',codeId:def.arg.codeId,
        closureEnvId:global,async:!!def.arg.async,version:0};
      this.generatorFunctionProperties(state,state.heap[id],['str',def.arg.name],null);
      state.envs[global].bindings[def.arg.name]={kind:'function',initialized:true,token:token(['ref',id]),version:0};
    }
    const imported=importGraph(state,args,kind=>this.next(state,kind));
    const rootPromise=selected.arg.async?this.newPromise(state):null;
     const root=this.newFrame(state,selected.arg.codeId,global,null,rootPromise,imported.map(v=>token(v)));
    state.control.a0.activeFrameId=root;
    state.control.a0.status='running';
    this.entrySpec={kind:'function',sourceId:source.sourceId,functionName,arguments:imported,
      ...(moduleNamespaceIntrinsic?{moduleNamespaceIntrinsic:true}:{})};
    this.started=true;
    this.initialState=copy(state);
    this.checkpoints.q0=copy(state);
    return this;
  }

  commit(operation, callback, {siteId=null,sourceId=null,codeId=null,invocationId=null,operands=[]}={}) {
    const before=this.state, draft=copy(before),eventId=`a0:e${this.events.length+1}`;
    const detail=callback(draft,eventId)??{};
    const patches=diff(before,draft);
    this.state=draft;
    const event={eventId,agentId:'a0',sequence:this.events.length+1,operation,catalogRef:`${operation}/1`,siteId,sourceId,codeId,invocationId,
      operands:detail.operands??operands,operandOrigins:detail.origins??[],result:detail.result??null,
      readObservations:detail.reads??[],causes:detail.causes??[],stateChanges:patches,
      before:`q${this.events.length}`,after:`q${this.events.length+1}`,
      ...(detail.spec ? {spec:detail.spec} : {}),
      ...(detail.completion ? {completion:detail.completion} : {})};
    this.events.push(event);return event;
  }
  stackPush(frame,value,origin){frame.stack.push(token(value,origin));}
  invokePrimitiveConversion(draft,frame,method,receiver,args,eventId,goal){
    const fn=draft.heap[method[1]];
    if(fn?.kind!=='function'||fn.async||this.programs[fn.codeId].generator)
      throw new TypeError('Async/generator '+goal+' conversion callback requires its owned profile');
    const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,frame.id,null,
      args.map(value=>token(value,eventId)),this.functionThis(fn,receiver),fn.id);
    draft.control.a0.activeFrameId=child;return child;
  }
  advanceNumberConversion(draft,frame,eventId){
    const outcome=advanceNumberConversion(frame.pendingNumberConversion,{heap:draft.heap,
      invoke:(method,receiver,args)=>this.invokePrimitiveConversion(draft,frame,method,receiver,args,eventId,'Number')});
    if(outcome.fault){delete frame.pendingNumberConversion;guestFault(outcome.fault.name,outcome.fault.message);}
    if(outcome.done){delete frame.pendingNumberConversion;this.stackPush(frame,outcome.value,eventId);}
    return {reads:outcome.reads,...(outcome.done?{result:outcome.value}:{causes:[{kind:'invocation',frameId:outcome.child}]})};
  }
  advancePropertyKeyConversion(draft,frame,eventId){
    const pending=frame.pendingPropertyKeyConversion;
    if(frame.pc!==pending.pc||!equal(frame.stack,pending.stack))
      throw new Error('PropertyKey conversion lost its retained reference stack');
    const outcome=advancePrimitiveConversion(pending.conversion,{heap:draft.heap,
      invoke:(method,receiver,args)=>this.invokePrimitiveConversion(draft,frame,method,receiver,args,eventId,'PropertyKey')});
    if(outcome.fault){delete frame.pendingPropertyKeyConversion;guestFault(outcome.fault.name,outcome.fault.message);}
    if(outcome.done){
      frame.stack[pending.stackIndex]=token(outcome.value,eventId);
      const binding=pending.cacheBinding;
      if(binding){
        const cell=draft.envs[binding.envId]?.bindings[binding.name];
        if(!cell||cell.version!==binding.version||!equal(cell.token,binding.token))
          throw new Error('PropertyKey conversion lost its cached reference binding');
        cell.token=token(outcome.value,eventId);cell.version++;
      }
      delete frame.pendingPropertyKeyConversion;
    }
    return {operands:[pending.conversion.input],origins:[pending.stack[pending.stackIndex].origin],
      reads:outcome.reads,...(outcome.done?{result:outcome.value}:{causes:[{kind:'invocation',frameId:outcome.child}]})};
  }
  completeFrame(draft,frame,value,origin) {
    frame.status='completed';
    frame.completion={type:'return',value:token(value,origin)};
    if(frame.afterInstanceInitialization){
      const pending=frame.afterInstanceInitialization,target=draft.heap[pending.constructorId];
      const id=this.newFrame(draft,target.codeId,target.closureEnvId,frame.callerFrameId,null,pending.args,pending.receiver,target.id);
      draft.frames[id].constructReceiver=pending.receiver;draft.frames[id].newTarget=pending.newTarget;
      draft.frames[id].constructorId=pending.constructorId;draft.frames[id].constructKind='base';draft.frames[id].thisInitialized=true;
      draft.control.a0.activeFrameId=id;return;
    }
    if(frame.classStaticResult)value=frame.classStaticResult;
    if(frame.superInitializedResult)value=frame.superInitializedResult;
    if(frame.constructKind==='derived'&&!['ref','promise','intrinsic','builtinfn','hostfn'].includes(value[0])){
      if(value[0]!=='undefined')guestFault('TypeError','Derived constructor may only return an object or undefined');
      if(!frame.thisInitialized)guestFault('ReferenceError','Derived constructor returned before super initialized this');
      value=frame.thisValue;
    }
    if(frame.constructReceiver&&!['ref','promise','intrinsic','builtinfn','hostfn'].includes(value[0]))value=frame.constructReceiver;
    if(frame.generatorId){
      draft.heap[frame.generatorId].state='completed';
      value=this.iteratorResult(draft,value,true,origin);
    }
    this.deliverFrameValue(draft,frame,value,origin);
  }
  iteratorResult(draft,value,done,origin){
    const id=this.next(draft,'obj');
    draft.heap[id]={id,kind:'object',properties:{value:token(value,origin),done:token(['bool',done],origin)},
      propertyVersions:{value:1,done:1},shapeVersion:2,version:0};
    return ['ref',id];
  }
  suspendGenerator(draft,frame,value,origin,initial=false,direct=false){
    const generator=draft.heap[frame.generatorId];
    if(generator?.kind!=='generator')throw new Error('Yield outside owned generator frame');
    generator.state=initial?'suspendedStart':'suspendedYield';
    frame.status='suspended-generator';
    const output=initial?['ref',generator.id]:direct?value:this.iteratorResult(draft,value,false,origin);
    frame.completion={type:'return',value:token(output,origin)};
    this.deliverFrameValue(draft,frame,output,origin);frame.callerFrameId=null;
    return output;
  }
  deliverFrameValue(draft,frame,value,origin,phase=0){
    if(phase===0&&frame.asyncPromiseId){
      const waiting=this.resolvePromise(draft,frame.asyncPromiseId,value,origin);
      value=['promise',frame.asyncPromiseId];
      if(waiting){
        draft.frames[waiting].promiseThenLookup.resume={kind:'frame-return',frameId:frame.id,value,origin,phase:1};
        return;
      }
    }
    if(phase<2&&this.deliverReactionValue(draft,frame,value,origin,
      {kind:'frame-return',frameId:frame.id,value,origin,phase:2}))return;
    if(frame.promiseThenLookup&&!frame.promiseThenLookup.delivered){
      this.finishPromiseThenLookup(draft,frame,value,origin);return;
    }
    if(frame.promiseConstructorLookup&&!frame.promiseConstructorLookup.delivered){
      this.finishPromiseConstructorLookup(draft,frame,value,origin);return;
    }
    if(frame.callerFrameId){
      const caller=draft.frames[frame.callerFrameId];
      if(caller.pendingModuleNamespace?.waitingFrameId===frame.id){
        const pending=caller.pendingModuleNamespace;
        delete caller.pendingModuleNamespace;
        const nextFrame=this.finishModuleNamespaceRead(draft,caller,pending,value,origin);
        draft.control.a0.activeFrameId=nextFrame===undefined?caller.id:nextFrame;return;
      }
      if(caller.pendingNumberConversion?.waitingFrameId===frame.id){
        const pending=caller.pendingNumberConversion;
        if(!['waiting','getter-waiting'].includes(pending.phase))throw new Error('Number conversion callback returned twice');
        pending.phase=pending.phase==='getter-waiting'?'getter-returned':'returned';pending.result=copy(value);
        draft.control.a0.activeFrameId=caller.id;return;
      }
      if(caller.pendingPropertyKeyConversion?.conversion.waitingFrameId===frame.id){
        const pending=caller.pendingPropertyKeyConversion.conversion;
        if(!['waiting','getter-waiting'].includes(pending.phase))throw new Error('PropertyKey callback returned twice');
        pending.phase=pending.phase==='getter-waiting'?'getter-returned':'returned';pending.result=copy(value);
        draft.control.a0.activeFrameId=caller.id;return;
      }
      if(caller.pendingPromiseExecutor?.waitingFrameId===frame.id){
        const pending=caller.pendingPromiseExecutor;delete caller.pendingPromiseExecutor;
        this.stackPush(caller,['promise',pending.promiseId],origin);
        draft.control.a0.activeFrameId=caller.id;return;
      }
    }
    if(frame.thenableJob){draft.control.a0.activeFrameId=null;return;}
    if(frame.reactionJob){draft.control.a0.activeFrameId=null;return;}
    if(frame.callerFrameId){
      const caller=draft.frames[frame.callerFrameId];
      if(caller.pendingArrayMethod?.waitingFrameId===frame.id){
        const pending=caller.pendingArrayMethod;
        if(pending.method==='sort'){
          const cmp=['undefined','null'].includes(value[0])?0:Number(decode(value));
          if(!['undefined','null','bool','str','num'].includes(value[0]) ||
             (draft.heap[pending.arrayId].shapeVersion??0)!==pending.originalShapeVersion)
            throw new TypeError('Sort callback changed array or returned unowned numeric value');
          this.advanceSortState(pending,Number.isNaN(cmp)?0:cmp);
          pending.waitingFrameId=null;
          if(pending.phase!=='done'){
            draft.control.a0.activeFrameId=caller.id;
            return;
          }
          const sorted=draft.heap[pending.arrayId];
          pending.buffer.forEach((item,i)=>putOwn(sorted,String(i),item,origin));
          value=['ref',pending.arrayId];
          delete caller.pendingArrayMethod;
        }else{
        const out=draft.heap[pending.outputId];
        if(pending.method==='map')putOwn(out,String(pending.index),value,origin);
        else if(pending.method==='filter' && truthy(value))
          putOwn(out,String(decode(out.properties.length.value)),
            pending.currentValue,origin);
        else if(pending.method==='reduce')pending.accumulator=value;
        const matched=truthy(value),currentIndex=pending.index;
        const stop=(['some','find','findIndex'].includes(pending.method)&&matched)||
          pending.method==='every'&&!matched;
        pending.index++;
        pending.waitingFrameId=null;
        if(!stop&&pending.index<pending.length){
          draft.control.a0.activeFrameId=caller.id;
          return;
        }
        value=pending.method==='reduce'?pending.accumulator:
          pending.method==='forEach'?U:pending.method==='some'?['bool',stop]:
          pending.method==='every'?['bool',!stop]:pending.method==='find'?(stop?pending.currentValue:U):
          pending.method==='findIndex'?['num',stop?currentIndex:-1]:['ref',pending.outputId];
        delete caller.pendingArrayMethod;
        }
      }
      const replacing=caller.pendingStringReplace;
      if(replacing?.waitingFrameId===frame.id){
        if(!['undefined','null','bool','num','str','bigint'].includes(value[0]))
          throw new TypeError('Owned replacement callback must return scalar data');
        const match=replacing.matches[replacing.index];
        replacing.output+=replacing.text.slice(replacing.lastEnd,match.start)+
          String(decode(value));
        replacing.lastEnd=match.end;
        replacing.index++;
        replacing.waitingFrameId=null;
        if(replacing.index<replacing.matches.length){
          draft.control.a0.activeFrameId=caller.id;
          return;
        }
        value=['str',replacing.output+replacing.text.slice(replacing.lastEnd)];
        delete caller.pendingStringReplace;
      }
      const pending=caller.pendingProperty;
      if(pending?.waitingFrameId===frame.id){
        caller.pendingProperty=null;
        if(pending.proxy){
          // Proxy invariants inspect the target after the trap has returned:
          // the callback may have changed its descriptor in the meantime.
          // The trap frame still completed normally; any invariant failure
          // belongs to the waiting property access in its caller.
          const target=draft.heap[pending.proxy.target[1]],key=pending.proxy.key,
            data=target.properties[key],attributes=target.dataAttributes?.[key],
            accessor=target.accessors?.[key];
          let message=null;
          if(pending.kind==='set'&&!truthy(value)){
            if(pending.proxy.strict)message="'set' on proxy: trap returned falsish for property '"+key+"'";
          }else if(data&&attributes?.configurable===false&&attributes.writable===false&&
              !ownedSameValue(data.value,pending.kind==='get'?value:pending.value))
            message='Proxy '+pending.kind+' trap contradicted a non-configurable, non-writable target property';
          else if(accessor?.configurable===false&&accessor[pending.kind].value[0]==='undefined'&&
              (pending.kind==='set'||value[0]!=='undefined'))
            message='Proxy '+pending.kind+' trap contradicted a non-configurable target accessor';
          if(message){
            const completion={type:'throw',errorType:'TypeError',message,origin};
            completion.value=this.caughtError(draft,completion,origin);
            draft.control.a0.activeFrameId=caller.id;
            this.routeCompletion(draft,caller,completion,origin);return;
          }
        }
        if(pending.kind==='get'&&pending.method)value=['method',value,pending.receiver];
        if(pending.kind==='set')value=pending.value;
      }
      this.stackPush(caller,value,origin);draft.control.a0.activeFrameId=caller.id;
    }
    else {draft.control.a0.activeFrameId=null;draft.control.a0.completion={kind:'return',value};
      draft.control.a0.status='completed';if(!frame.asyncPromiseId)this.result=value;}
  }
  // V8's small-array TimSort: discover a natural run, reverse only strictly
  // descending runs, then stably binary-insert remaining entries. Every
  // comparator executes in an owned guest frame, in the same dynamic order.
  // Large arrays, exotic slots and array-mutating comparators fail closed.
  advanceSortState(p,cmp){
    const nextInsert=()=>{
      if(p.insertIndex===undefined)p.insertIndex=p.scan;
      if(p.insertIndex>=p.length){p.phase='done';p.pair=null;return;}
      p.low=0;p.high=p.insertIndex;p.phase='binary';
      p.middle=Math.floor((p.low+p.high)/2);
      p.pair=[p.buffer[p.insertIndex],p.buffer[p.middle]];
    };
    const finishRun=()=>{
      if(p.descending)p.buffer.splice(0,p.scan,...p.buffer.slice(0,p.scan).reverse());
      nextInsert();
    };
    if(p.phase==='run-first'){
      p.descending=cmp<0;
      if(p.scan<p.length){p.phase='extend';
        p.pair=[p.buffer[p.scan],p.buffer[p.scan-1]];}
      else finishRun();
    }else if(p.phase==='extend'){
      if(p.descending?cmp<0:cmp>=0){
        p.scan++;
        if(p.scan<p.length)p.pair=[p.buffer[p.scan],p.buffer[p.scan-1]];
        else finishRun();
      }else finishRun();
    }else if(p.phase==='binary'){
      if(cmp<0)p.high=p.middle;else p.low=p.middle+1;
      if(p.low<p.high){
        p.middle=Math.floor((p.low+p.high)/2);
        p.pair=[p.buffer[p.insertIndex],p.buffer[p.middle]];
      }else{
        const [item]=p.buffer.splice(p.insertIndex,1);
        p.buffer.splice(p.low,0,item);
        p.insertIndex++;
        nextInsert();
      }
    }else throw new Error('Unexpected sort continuation phase');
  }
  advanceStringReplaceCallback(draft,caller){
    const p=caller.pendingStringReplace;
    const match=p?.matches[p.index];
    if(!match || p.waitingFrameId!==null)
      throw new Error('Missing guest replacement callback');
    const fn=draft.heap[p.callbackId];
    const params=[token(['str',match.match])];
    if(match.group!==null)params.push(token(['str',match.group]));
    params.push(token(['num',match.start]),token(['str',p.text]));
    const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,caller.id,null,
      params,this.functionThis(fn),fn.id);
    p.waitingFrameId=child;
    draft.control.a0.activeFrameId=child;
    return child;
  }
  // Continue a guest Array callback in the owned VM, never by executing
  // guest functions in the host. Reads are from current heap state so callback
  // mutations cannot be silently replaced by a precomputed native array.
  advanceArrayCallback(draft,caller,origin){
    const p=caller.pendingArrayMethod;
    if(!p)throw new Error('Missing array callback continuation');
    const array=draft.heap[p.arrayId];
    if(p.method==='sort'){
      if(!p.pair||p.waitingFrameId!==null)throw new Error('Missing sort comparison');
      if((array.shapeVersion??0)!==p.originalShapeVersion)
        throw new TypeError('Sort comparator mutated target array');
      const fn=draft.heap[p.callbackId];
      const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,caller.id,null,
        p.pair.map(v=>token(v)),this.functionThis(fn),fn.id);
      p.waitingFrameId=child;
      draft.control.a0.activeFrameId=child;
      return true;
    }
    for(;p.index<p.length;p.index++){
      if(![null,'Array.prototype','Object.prototype'].includes(objectPrototype(array)))
        throw new TypeError('Array callback inherited index semantics outside profile');
      const index=String(p.index),slot=array.properties[index];
      if(Object.hasOwn(array.accessors??{},index))
        throw new TypeError('Array callback accessor continuation outside profile');
      if(!slot&&!['find','findIndex'].includes(p.method))continue;
      const value=slot?.value??U;
      const fn=draft.heap[p.callbackId];
      const params=p.method==='reduce'?
        [token(p.accumulator),token(value),token(['num',p.index]),token(['ref',p.arrayId])]:
        [token(value),token(['num',p.index]),token(['ref',p.arrayId])];
      const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,caller.id,null,params,
        this.functionThis(fn,p.thisArg??U),fn.id);
      p.currentValue=value;
      p.waitingFrameId=child;
      draft.control.a0.activeFrameId=child;
      return true;
    }
    return false;
  }
  // Await and reaction jobs share ordered owned subscriptions.
  observePromise(draft,id,observer) {
    const p=draft.promises[id];
    if(!p)throw new Error('Unknown guest promise');
    if(p.status==='pending')p.observers.push(observer);
    else draft.control.a0.queue.push({promiseId:id,...observer});
  }
  callableGuest(draft,value) {
    return value?.[0]==='ref' && draft.heap[value[1]]?.kind==='function';
  }
  settlePromise(draft,id,status,value,origin) {
    const p=draft.promises[id];
    if(!p||p.status!=='pending'||p.adopting)throw new Error('Promise already settled or adopting');
    if(!['fulfilled','rejected'].includes(status))throw new Error('Invalid promise settlement');
    p.status=status;p.value=token(value,origin);
    for(const observer of p.observers)draft.control.a0.queue.push({promiseId:id,...observer});
    p.observers=[];
  }
  rejectPromise(draft,id,reason,origin) {
    // Rejection reasons are opaque guest values, including promise identities.
    this.settlePromise(draft,id,'rejected',reason,origin);
  }
  lookupPromiseConstructor(draft,receiver,continuation,origin,property='constructor'){
    const heap=ownedObjectHeap(draft),selected=ordinaryGet(heap,receiver,property,{accessors:true});
    if(!selected)throw new TypeError('Promise constructor lookup requires owned ordinary storage');
    const getter=selected.accessor?.get.value??U;
    if(getter[0]==='undefined'){
      let outcome;
      try{outcome=this.continuePromiseConstructor(draft,selected.method?.value??U,continuation,origin);}
      catch(error){
        if(!(error instanceof GuestFault)||!['finally','adopt'].includes(continuation.kind))throw error;
        this.rejectPromiseConstructor(draft,continuation,{type:'throw',errorType:error.name,message:error.message},origin);
      }
      return {read:selected.observation,...outcome};
    }
    if(!this.callableGuest(draft,getter))throw new TypeError('Promise constructor lookup requires an owned getter');
    const target=draft.heap[getter[1]];
    if(this.programs[target.codeId].generator)
      throw new TypeError('Generator Promise constructor getters are outside the owned profile');
    const inner=target.async?this.newPromise(draft):null,
      child=this.newFrame(draft,target.codeId,target.closureEnvId,null,inner,[],this.functionThis(target,receiver),target.id);
    draft.frames[child].promiseConstructorLookup={receiver:copy(receiver),property,origin,
      continuation:copy(continuation),delivered:false};
    draft.frames[child].reactionJob=true;draft.control.a0.activeFrameId=child;
    return {child,read:selected.observation};
  }
  finishPromiseConstructorLookup(draft,frame,value,origin,completion=null){
    const lookup=frame.promiseConstructorLookup;
    if(!lookup||lookup.delivered)throw new Error('Invalid Promise constructor continuation');
    lookup.delivered=true;
    if(completion){this.rejectPromiseConstructor(draft,lookup.continuation,completion,origin);return;}
    try{this.continuePromiseConstructor(draft,value,lookup.continuation,origin);}
    catch(error){
      if(!(error instanceof GuestFault))throw error;
      this.rejectPromiseConstructor(draft,lookup.continuation,{type:'throw',errorType:error.name,message:error.message},origin);
    }
  }
  rejectPromiseConstructor(draft,continuation,completion,origin){
    if(continuation.kind==='adopt'){
      const promise=draft.promises[continuation.promiseId];promise.adopting=null;
      const reason=this.caughtError(draft,completion,origin);this.rejectPromise(draft,promise.id,reason.value,reason.origin);
      draft.control.a0.activeFrameId=null;
    }else if(continuation.kind==='finally'){
      const reason=this.caughtError(draft,completion,origin);
      this.rejectPromise(draft,continuation.reaction.resultId,reason.value,reason.origin);
      this.resumePromiseResolution(draft,continuation.after);
    }else{
      const frame=draft.frames[continuation.frameId];draft.control.a0.activeFrameId=frame.id;
      this.routeCompletion(draft,frame,completion,origin);
    }
  }
  continuePromiseConstructor(draft,constructor,continuation,origin){
    if(continuation.kind==='finally'&&continuation.stage==='resolve'){
      const value=continuation.value,same=value[0]==='promise'&&ownedSameValue(constructor,['intrinsic','Promise']),
        cleanupId=same?value[1]:this.newPromise(draft),
        next={...continuation,stage:'then',cleanupId,phase:'constructor'},
        waiting=same?null:this.resolvePromise(draft,cleanupId,value,origin);
      if(waiting){draft.frames[waiting].promiseThenLookup.resume={kind:'finally-cleanup',continuation:next,origin};return;}
      this.startFinallyCleanupThen(draft,next,origin);return;
    }
    if(['resolve','await'].includes(continuation.kind)){
      const frame=draft.frames[continuation.frameId],value=continuation.value,
        same=value[0]==='promise'&&ownedSameValue(constructor,['intrinsic','Promise']),
        promiseId=same?value[1]:this.newPromise(draft);
      draft.control.a0.activeFrameId=frame.id;
      const waiting=same?null:this.resolvePromise(draft,promiseId,value,origin);
      if(continuation.kind==='resolve'){this.stackPush(frame,['promise',promiseId],origin);return;}
      if(waiting)draft.frames[waiting].promiseThenLookup.resume={kind:'await',frameId:frame.id,promiseId};
      else this.awaitPromise(draft,frame,promiseId);
      return {promiseId,...(waiting?{child:waiting}:{})};
    }
    // SpeciesConstructor must read the constructor once, followed by @@species
    // only for object constructors. Custom species allocation remains an
    // explicit implementation refusal, separate from genuine descriptor errors.
    if(continuation.phase!=='species'){
      if(constructor[0]!=='undefined'&&!ownedSameValue(constructor,['intrinsic','Promise'])){
        if(isPrimitiveValue(constructor))guestFault('TypeError','Promise constructor must be an object');
        const object=ownedObjectStorage(draft,constructor);
        if(!object)throw new TypeError('Promise species constructor requires owned ordinary storage');
        this.lookupPromiseConstructor(draft,constructor,{...continuation,phase:'species'},origin,symbolPropertyKey('well-known:species'));
        return;
      }
    }else if(!['undefined','null'].includes(constructor[0])&&!ownedSameValue(constructor,['intrinsic','Promise'])){
      if(primitiveUnary('typeof',constructor,draft.heap)[1]!=='function')guestFault('TypeError','Promise species is not a constructor');
      throw new TypeError('Custom Promise species construction is outside the owned profile');
    }
    if(continuation.kind==='adopt'){
      this.observePromise(draft,continuation.targetId,{kind:'adoption',resultId:continuation.promiseId});
      draft.control.a0.activeFrameId=null;return;
    }
    if(continuation.kind==='finally'){
      const reaction=continuation.reaction,passed=this.newPromise(draft);
      this.observePromise(draft,continuation.cleanupId,{kind:'finally-pass',resultId:passed,
        originalStatus:reaction.originalStatus,original:reaction.original});
      const waiting=this.resolvePromise(draft,reaction.resultId,['promise',passed],origin);
      if(waiting)draft.frames[waiting].promiseThenLookup.resume=continuation.after;
      else this.resumePromiseResolution(draft,continuation.after);
      return;
    }
    if(continuation.kind!=='reaction')throw new Error('Unknown Promise constructor continuation');
    if(continuation.method==='finally'&&!continuation.finallySpecies){
      // finally computes SpeciesConstructor before Invoke(promise, "then").
      // Either lookup can change the live method. Check the method selected
      // here before entering the intrinsic then's own constructor lookup.
      const then=ordinaryGet(ownedObjectHeap(draft),continuation.receiver,'then');
      if(!then||!ownedSameValue(then.method.value,['builtinfn','Promise.prototype.then']))
        throw new TypeError('Promise finally then override requires its owned call continuation');
      this.lookupPromiseConstructor(draft,continuation.receiver,{...continuation,phase:'constructor',finallySpecies:true},origin);return;
    }
    const promiseId=this.newPromise(draft),method=continuation.method,args=continuation.args,
      reaction={kind:method==='finally'?'finally':'then',resultId:promiseId,
        onFulfilled:method==='then'?(args[0]??U):U,
        onRejected:method==='catch'?(args[0]??U):method==='then'?(args[1]??U):U,
        onFinally:method==='finally'?(args[0]??U):U};
    this.observePromise(draft,continuation.receiver[1],{kind:'reaction',reaction});
    const frame=draft.frames[continuation.frameId];this.stackPush(frame,['promise',promiseId],origin);
    draft.control.a0.activeFrameId=frame.id;
  }
  startFinallyCleanupThen(draft,continuation,origin){
    const value=['promise',continuation.cleanupId],then=ordinaryGet(ownedObjectHeap(draft),value,'then');
    if(!then||!ownedSameValue(then.method.value,['builtinfn','Promise.prototype.then']))
      throw new TypeError('Promise finally cleanup then override requires an owned call continuation');
    this.lookupPromiseConstructor(draft,value,continuation,origin);
  }
  resolvePromise(draft,id,value,origin) {
    const p=draft.promises[id];if(!p||p.status!=='pending'||p.adopting)
      throw new Error('Promise already settled or adopting another promise');
    if(value[0]==='promise'&&value[1]===id){
      const reason=this.caughtError(draft,{errorType:'TypeError',message:'Chaining cycle detected for promise'},origin);
      this.rejectPromise(draft,id,reason.value,reason.origin);return null;
    }
    if(['ref','promise'].includes(value[0])){
      const object=ownedObjectStorage(draft,value),heap=ownedObjectHeap(draft);
      if(object&&['object','array','function','generator','proxy','promise'].includes(object.kind)){
        const route=object.kind==='proxy'?proxyRoute(draft.heap,value,'get'):
          {kind:'ordinary',target:value,receiver:value};
        const target=ownedObjectStorage(draft,route.target),described=route.kind==='ordinary'?
          functionProperty(heap,target,'then'):null;
        const getter=route.kind==='trap'?route.method:described.accessor?.get.value??U;
        if(route.kind==='trap'||getter[0]!=='undefined'){
          if(route.kind==='trap'&&!this.callableGuest(draft,getter)&&!['builtinfn','hostfn'].includes(getter[0])){
            const reason=this.caughtError(draft,{errorType:'TypeError',message:'Proxy get trap is not callable'},origin);
            this.rejectPromise(draft,id,reason.value,reason.origin);return null;
          }
          if(!this.callableGuest(draft,getter))
            throw new TypeError('Promise then lookup requires an owned getter or Proxy trap');
          const fn=draft.heap[getter[1]],inner=fn.async?this.newPromise(draft):null,
            args=route.kind==='trap'?[token(route.target,origin),token(['str','then'],origin),token(value,origin)]:[],
            receiver=route.kind==='trap'?route.handler:value;
          const resume={kind:'active',frameId:draft.control.a0.activeFrameId};
          const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,null,inner,args,
            this.functionThis(fn,receiver),fn.id);
          draft.frames[child].promiseThenLookup={promiseId:id,resolution:copy(value),origin,
            resume,delivered:false,...(route.kind==='trap'?{proxyTarget:copy(route.target)}:{})};
          // A getter is synchronous protocol work. It runs before its caller
          // continues, without entering the Promise/microtask queue.
          draft.frames[child].reactionJob=true;
          draft.control.a0.activeFrameId=child;
          return child;
        }
        const method=described.slot?.value??U;
        this.resolvePromiseThen(draft,id,value,method,origin);return null;
      }
    }
    this.settlePromise(draft,id,'fulfilled',value,origin);
    return null;
  }
  resolvePromiseThen(draft,id,value,method,origin){
    const p=draft.promises[id];
    if(value[0]==='promise'&&ownedSameValue(method,['builtinfn','Promise.prototype.then'])){
      p.adopting=value[1];
      draft.control.a0.queue.push({kind:'promise-adopt',promiseId:id,targetId:value[1]});
    }else if(this.callableGuest(draft,method)){
      // Repeated identity is legal; each assimilation has its own resolving
      // pair. The driver budget, not identity, bounds a nonterminating chain.
      if(draft.control.a0.queue.length>=256)throw new RangeError('Owned thenable assimilation budget');
      const serial=++p.thenableSerial;p.thenableLocked=false;
      draft.control.a0.queue.push({kind:'thenable',promiseId:id,thenableId:value[1],thenId:method[1],serial,
        ...(value[0]==='promise'?{receiver:copy(value)}:{})});
    }else if(['builtinfn','hostfn'].includes(method[0]))
      throw new TypeError('Native thenable method outside bounded profile');
    else this.settlePromise(draft,id,'fulfilled',value,origin);
  }
  finishPromiseThenLookup(draft,frame,method,origin,completion=null){
    const lookup=frame.promiseThenLookup;
    if(!lookup||lookup.delivered||draft.promises[lookup.promiseId]?.status!=='pending')
      throw new Error('Invalid Promise then lookup continuation');
    lookup.delivered=true;
    if(!completion&&lookup.proxyTarget){
      const target=draft.heap[lookup.proxyTarget[1]],data=target.properties.then,
        attributes=target.dataAttributes?.then,accessor=target.accessors?.then;
      if(data&&attributes?.configurable===false&&attributes.writable===false&&!ownedSameValue(data.value,method)||
         accessor?.configurable===false&&accessor.get.value[0]==='undefined'&&method[0]!=='undefined')
        completion={type:'throw',errorType:'TypeError',message:'Proxy get trap contradicted a non-configurable target then property',origin};
    }
    if(completion){
      const reason=this.caughtError(draft,completion,origin);
      this.rejectPromise(draft,lookup.promiseId,reason.value,reason.origin);
    }else this.resolvePromiseThen(draft,lookup.promiseId,lookup.resolution,method,lookup.origin);
    this.resumePromiseResolution(draft,lookup.resume);
  }
  resumePromiseResolution(draft,resume){
    if(resume.kind==='active')draft.control.a0.activeFrameId=resume.frameId;
    else if(resume.kind==='frame-return')this.deliverFrameValue(draft,draft.frames[resume.frameId],resume.value,resume.origin,resume.phase);
    else if(resume.kind==='finally-adopt'){
      this.resolvePromise(draft,resume.resultId,['promise',resume.passed],resume.origin);
      this.resumePromiseResolution(draft,resume.after);
    }else if(resume.kind==='await')this.awaitPromise(draft,draft.frames[resume.frameId],resume.promiseId);
    else if(resume.kind==='finally-cleanup')this.startFinallyCleanupThen(draft,resume.continuation,resume.origin);
    else if(resume.kind==='combinator'){
      draft.control.a0.activeFrameId=resume.frameId;
      this.advancePromiseCombinator(draft,draft.frames[resume.frameId],resume.origin);
    }else throw new Error('Unknown Promise resolution continuation');
  }
  deliverReactionValue(draft,frame,value,origin,after=null){
    if(frame.finallyReaction){
      const reaction=frame.finallyReaction;delete frame.finallyReaction;
      // finally returns PromiseResolve(callback()).then(valueThunk/thrower).
      // The outer reaction then adopts that distinct promise. All three
      // scheduling boundaries remain visible even for a primitive callback
      // result, and an existing Promise is used directly by PromiseResolve.
      const continuation={kind:'finally',stage:'resolve',frameId:frame.id,value:copy(value),reaction:copy(reaction),
        after:after??{kind:'active',frameId:null}};
      if(value[0]==='promise')this.lookupPromiseConstructor(draft,value,continuation,origin);
      else this.continuePromiseConstructor(draft,U,continuation,origin);
      return true;
    }else if(frame.reactionPromiseId){
      const waiting=this.resolvePromise(draft,frame.reactionPromiseId,value,origin);
      // An async callback publishes its returned promise at its first await
      // or completion. Its later resumption must not resolve the reaction again.
      if(frame.asyncPromiseId)delete frame.reactionPromiseId;
      if(waiting){draft.frames[waiting].promiseThenLookup.resume=after??{kind:'active',frameId:null};return true;}
    }
    return false;
  }
  awaitPromise(draft,frame,promiseId){
    frame.awaiting=promiseId;this.observePromise(draft,promiseId,{kind:'await',frameId:frame.id});
    this.suspendAsync(draft,frame);
  }
  advancePromiseCombinator(draft,frame,origin){
    const pending=frame.pendingPromiseCombinator;
    if(!pending)throw new Error('Missing Promise combinator continuation');
    const array=draft.heap[pending.arrayId],result=draft.promises[pending.resultId];
    const requireIntrinsic=value=>{
      const heap=ownedObjectHeap(draft),constructor=ordinaryGet(heap,value,'constructor'),then=ordinaryGet(heap,value,'then');
      if(!constructor||!ownedSameValue(constructor.method.value,['intrinsic','Promise'])||
         !then||!ownedSameValue(then.method.value,['builtinfn','Promise.prototype.then']))
        throw new TypeError('Promise combinator constructor or then lookup requires an owned continuation');
    };
    // Combinator-specific PromiseResolve/Invoke continuations remain bounded.
    // Refuse observable constructor/then mutations instead of skipping their
    // getters or pretending a private observation was an ordinary then call.
    if(pending.index||decode(array.properties.length.value))requireIntrinsic(['promise',pending.resultId]);
    for(;;){
      const length=decode(array.properties.length.value);
      if(!Number.isInteger(length)||length<0||length>64)
        throw new RangeError('Promise combinator iterable limit exceeded');
      if(pending.index>=length)break;
      const index=pending.index++,found=ordinaryGet(draft.heap,['ref',array.id],String(index));
      if(!found)throw new TypeError('Promise combinator element requires its own getter continuation');
      const v=found.method,inputId=v.value[0]==='promise'?v.value[1]:this.newPromise(draft);
      if(v.value[0]==='promise')requireIntrinsic(v.value);
      if(result.combinator){result.combinator.values.push(null);result.combinator.remaining++;}
      const waiting=v.value[0]!=='promise'?this.resolvePromise(draft,inputId,v.value,v.origin):null;
      this.observePromise(draft,inputId,{kind:'combinator',resultId:pending.resultId,index,mode:pending.kind});
      if(waiting){
        draft.frames[waiting].promiseThenLookup.resume={kind:'combinator',frameId:frame.id,origin};return;
      }
    }
    if(result.combinator&&--result.combinator.remaining===0)this.finishPromiseCombinator(draft,result.id,origin);
    delete frame.pendingPromiseCombinator;
  }
  finishPromiseCombinator(draft,promiseId,origin){
    const comb=draft.promises[promiseId].combinator,id=this.next(draft,'obj'),values=comb.values;
    const array=draft.heap[id]={id,kind:'array',properties:{length:token(['num',values.length],origin)},
      propertyVersions:{length:0},shapeVersion:0,version:0};
    for(let index=0;index<values.length;index++)putOwn(array,String(index),values[index].value,origin);
    if(comb.kind==='any'){
      const errorId=this.next(draft,'obj'),error=draft.heap[errorId]={id:errorId,kind:'object',
        properties:{},propertyVersions:{},shapeVersion:0,version:0};
      putOwn(error,'name',['str','AggregateError'],origin);
      putOwn(error,'errors',['ref',id],origin);
      this.rejectPromise(draft,promiseId,['ref',errorId],origin);
    }else this.resolvePromise(draft,promiseId,['ref',id],origin);
  }
  suspendAsync(draft,frame) {
    frame.status='suspended';
    if(this.deliverReactionValue(draft,frame,['promise',frame.asyncPromiseId],null))return;
    if(frame.promiseThenLookup&&!frame.promiseThenLookup.delivered){
      this.finishPromiseThenLookup(draft,frame,['promise',frame.asyncPromiseId],null);return;
    }
    if(frame.promiseConstructorLookup&&!frame.promiseConstructorLookup.delivered){
      this.finishPromiseConstructorLookup(draft,frame,['promise',frame.asyncPromiseId],null);return;
    }
    if(frame.callerFrameId) {
      const caller=draft.frames[frame.callerFrameId];
      const pending=caller.pendingPromiseExecutor;
      if(pending?.waitingFrameId===frame.id){
        delete caller.pendingPromiseExecutor;
        this.stackPush(caller,['promise',pending.promiseId],null);
      }else this.stackPush(caller,['promise',frame.asyncPromiseId],null);
      draft.control.a0.activeFrameId=frame.callerFrameId;frame.callerFrameId=null;
    } else draft.control.a0.activeFrameId=null;
  }
  failFrame(draft,frame,completion) {
    // Terminal bounded-profile completion, not catch/finally propagation or
    // async rejection delivery. Preserve the distinction from unsupported code.
    const unsupported=completion.type==='unsupported';
    frame.status=unsupported?'unsupported':'thrown';frame.completion=copy(completion);
    draft.control.a0.status=unsupported?'unsupported':'failed';
    draft.control.a0.failure={kind:unsupported?'unsupported':'guest-abrupt',frameId:frame.id,completion:copy(completion)};
    draft.control.a0.activeFrameId=null;
  }
  // Owned, JSON-serializable completion routing. A handler stores the
  // environment, operand depth and loop depth at entry; no host exception or
  // native continuation is used to represent guest control flow.
  caughtError(draft,completion,eventId) {
    if(completion.value)return completion.value;
    if(!completion.errorType)throw new Error('Unrepresentable guest throw completion');
    const id=this.next(draft,'obj');
    draft.heap[id]={id,kind:'object',declaredError:completion.errorType,properties:{
      name:token(['str',completion.errorType],eventId),
      message:token(['str',completion.message??''],eventId)
    },propertyVersions:{name:1,message:1},shapeVersion:2,version:0};
    // Declared constructor identity is modeled without importing a native
    // Error. Mutable Error prototypes, stacks and instanceof remain separate.
    return token(['ref',id],eventId);
  }
  newDeclaredError(draft,name,args,eventId){
    if(args.length>1)throw new TypeError('Error options are outside the bounded error profile');
    const value=args[0]?.value??U;
    if(!['undefined','null','bool','str','num','bigint'].includes(value[0]))
      throw new TypeError('Error message requires owned scalar coercion');
    return this.caughtError(draft,{errorType:name,
      message:value[0]==='undefined'?'':String(decode(value))},eventId).value;
  }
  routeCompletion(draft,frame,completion,eventId) {
    const stop=completion.type==='jump'?completion.handlerDepth:0;
    while(frame.handlers.length>stop){
      const handler=frame.handlers.at(-1);
      if(handler.phase==='finally'){frame.handlers.pop();continue;}
      frame.envId=handler.envId;
      frame.stack.length=handler.stackDepth;
      frame.loops.length=handler.loopDepth;
      if(completion.type==='throw' && handler.phase==='try' && handler.catchPc!==null){
        handler.phase='catch';
        handler.caught=this.caughtError(draft,completion,eventId);
        frame.pc=handler.catchPc;
        return;
      }
      if(handler.finallyPc!==null){
        handler.phase='finally';handler.pending=copy(completion);
        frame.pc=handler.finallyPc;
        return;
      }
      frame.handlers.pop();
    }
    if(completion.type==='jump'){
      frame.envId=completion.envId;frame.stack.length=completion.stackDepth;
      frame.loops.length=completion.loopDepth;frame.pc=completion.targetPc;
    }else if(completion.type==='return'){
      this.completeFrame(draft,frame,completion.value.value,completion.value.origin);
    }else if(completion.type==='throw'){
      frame.status='thrown';frame.completion=copy(completion);
      if(frame.generatorId)draft.heap[frame.generatorId].state='completed';
      if(frame.promiseThenLookup&&!frame.promiseThenLookup.delivered&&!frame.asyncPromiseId){
        this.finishPromiseThenLookup(draft,frame,U,eventId,completion);
      }else if(frame.promiseConstructorLookup&&!frame.promiseConstructorLookup.delivered&&!frame.asyncPromiseId){
        this.finishPromiseConstructorLookup(draft,frame,U,eventId,completion);
      }else if(frame.thenableJob&&!frame.asyncPromiseId){
         const p=draft.promises[frame.thenableJob.promiseId];
         if(p?.status==='pending'&&p.thenableSerial===frame.thenableJob.serial&&!p.thenableLocked){
           p.thenableLocked=true;
           const reason=this.caughtError(draft,completion,eventId);
           this.rejectPromise(draft,p.id,reason.value,reason.origin);
         }
         draft.control.a0.activeFrameId=null;
       }else if(frame.asyncPromiseId){
         // Async throws reject a guest promise, never the whole agent.
        const reason=this.caughtError(draft,completion,eventId);
        this.rejectPromise(draft,frame.asyncPromiseId,reason.value,reason.origin);
        if(this.deliverReactionValue(draft,frame,['promise',frame.asyncPromiseId],eventId))return;
        if(frame.promiseThenLookup&&!frame.promiseThenLookup.delivered){
          this.finishPromiseThenLookup(draft,frame,['promise',frame.asyncPromiseId],eventId);return;
        }
        if(frame.promiseConstructorLookup&&!frame.promiseConstructorLookup.delivered){
          this.finishPromiseConstructorLookup(draft,frame,['promise',frame.asyncPromiseId],eventId);return;
        }
        if(frame.callerFrameId){
          const caller=draft.frames[frame.callerFrameId];
          const pending=caller.pendingPromiseExecutor;
          if(pending?.waitingFrameId===frame.id){
            delete caller.pendingPromiseExecutor;
            this.stackPush(caller,['promise',pending.promiseId],eventId);
          }else this.stackPush(caller,['promise',frame.asyncPromiseId],eventId);
          draft.control.a0.activeFrameId=caller.id;
        }else draft.control.a0.activeFrameId=null;
      }else if(frame.finallyReaction){
        const reason=this.caughtError(draft,completion,eventId);
        this.rejectPromise(draft,frame.finallyReaction.resultId,reason.value,reason.origin);
        draft.control.a0.activeFrameId=null;
      }else if(frame.reactionPromiseId){
        const reason=this.caughtError(draft,completion,eventId);
        this.rejectPromise(draft,frame.reactionPromiseId,reason.value,reason.origin);
        draft.control.a0.activeFrameId=null;
      }else if(frame.externalCallbackReturn){
        // A thrown callback rejects its native waiter. It cannot fail the
        // unrelated root invocation or invent the parent effect's outcome.
        frame.completion.value=this.caughtError(draft,completion,eventId);
        draft.control.a0.activeFrameId=null;
      }else if(frame.callerFrameId){
        const caller=draft.frames[frame.callerFrameId];
        if(caller.pendingPromiseExecutor?.waitingFrameId===frame.id){
           const pending=caller.pendingPromiseExecutor;delete caller.pendingPromiseExecutor;
           const p=draft.promises[pending.promiseId];
           if(p.status==='pending'&&!p.resolverCalled){
             const reason=this.caughtError(draft,completion,eventId);
             // Promise construction rejects through the same resolving pair,
             // consuming its shared first-call cell before publishing rejection.
             p.resolverCalled=true;
             this.rejectPromise(draft,p.id,reason.value,reason.origin);
           }
           this.stackPush(caller,['promise',p.id],eventId);
           draft.control.a0.activeFrameId=caller.id;return;
         }
         if(caller.pendingProperty?.waitingFrameId===frame.id)caller.pendingProperty=null;
         if(caller.pendingNumberConversion?.waitingFrameId===frame.id)delete caller.pendingNumberConversion;
         if(caller.pendingPropertyKeyConversion?.conversion.waitingFrameId===frame.id)delete caller.pendingPropertyKeyConversion;
         if(caller.pendingArrayMethod?.waitingFrameId===frame.id)delete caller.pendingArrayMethod;
         if(caller.pendingModuleNamespace?.waitingFrameId===frame.id)delete caller.pendingModuleNamespace;
        draft.control.a0.activeFrameId=caller.id;
        const waiting=caller.operationId&&draft.operations[caller.operationId]?.coercion?.waitingFrameId;
        if(waiting===frame.id)caller.pendingCoercionThrow=copy(completion);
        else this.routeCompletion(draft,caller,completion,eventId);
      }else this.failFrame(draft,frame,completion);
    }else throw new Error('Unknown guest completion');
  }
  stepArithmetic(frame) {
    const operation=this.state.operations[frame.operationId];
    if(!operation||operation.frameId!==frame.id)throw new Error('Unowned spec continuation');
    const metadata=specStep(operation);
    return this.commit(metadata.operation,(s,eventId)=>{
      const current=s.operations[operation.id],f=s.frames[frame.id];
      const detail=advanceArithmetic(current,eventId,{
        heap:s.heap,
        invoke:(method,receiver,args=[])=>{
          const target=s.heap[method[1]];
          const promiseId=target.async?this.newPromise(s):null;
          const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,args,this.functionThis(target,receiver),target.id);
          s.control.a0.activeFrameId=id;
          return id;
        },
        takeReturn:waitingId=>{
          if(!['completed','suspended-generator'].includes(s.frames[waitingId]?.status)||!f.stack.length)
            throw new Error('Missing owned conversion call result');
          return f.stack.pop();
        },
        abrupt:f.pendingCoercionThrow
      });
      f.pendingCoercionThrow=null;
      if(current.status==='completed') {
        f.operationId=null;
        if(current.completion.type==='normal')this.stackPush(f,current.completion.value.value,eventId);
        else if(current.completion.type==='throw')
          this.routeCompletion(s,f,current.completion,eventId);
        else this.failFrame(s,f,current.completion);
      }
      return detail;
    },{siteId:operation.siteId,sourceId:operation.sourceId,codeId:operation.codeId,invocationId:operation.frameId});
  }
  step() {
    if(!this.started)throw new Error('Call start first');
    const c=this.state.control.a0,frame=c.activeFrameId&&this.state.frames[c.activeFrameId];
    if(!frame||frame.status!=='running')return null;
    if(frame.operationId)return this.stepArithmetic(frame);
    if(['returned','getter-returned'].includes(frame.pendingNumberConversion?.phase)){
      const siteId=frame.pendingNumberConversion.siteId;
      return this.commit('intrinsic.number.resume',(s,eventId)=>{
        const parent=s.frames[frame.id];
        try{return this.advanceNumberConversion(s,parent,eventId);}
        catch(error){
          if(!(error instanceof GuestFault))throw error;
          const completion={type:'throw',errorType:error.name,message:error.message,origin:eventId};
          completion.value=this.caughtError(s,completion,eventId);this.routeCompletion(s,parent,completion,eventId);
          return {completion};
        }
      },{siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId,invocationId:frame.id});
    }
    if(frame.pendingStringReplace?.waitingFrameId===null){
      const siteId=frame.pendingStringReplace.siteId;
      return this.commit('call.enter',(s)=>{
        const child=this.advanceStringReplaceCallback(s,s.frames[frame.id]);
        return {causes:[{kind:'invocation',frameId:child}]};
      },{siteId,sourceId:frame.codeId.split(':')[0],
        codeId:frame.codeId,invocationId:frame.id});
    }
    if(frame.pendingArrayMethod && frame.pendingArrayMethod.waitingFrameId===null){
      const siteId=frame.pendingArrayMethod.siteId;
      return this.commit('call.enter',(s,eventId)=>{
        const parent=s.frames[frame.id];
        if(!this.advanceArrayCallback(s,parent,eventId)){
          const p=parent.pendingArrayMethod;
          const value=p.method==='reduce'?p.accumulator:p.method==='forEach'||p.method==='find'?U:
            p.method==='findIndex'?['num',-1]:p.method==='some'?['bool',false]:
            p.method==='every'?['bool',true]:['ref',p.outputId];
          delete parent.pendingArrayMethod;this.stackPush(parent,value,eventId);return {result:value};
        }
        return {causes:[{kind:'invocation',frameId:parent.pendingArrayMethod.waitingFrameId}]};
      },{siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId,invocationId:frame.id});
    }
    const inst=this.programs[frame.codeId].instructions[frame.pc];
    if(!inst)throw new Error('Program counter out of range');
    const retained=frame.pendingPropertyKeyConversion;
    if(retained&&!['returned','getter-returned'].includes(retained.conversion.phase))
      throw new Error('PropertyKey conversion is still waiting for its callback');
    const reference=retained??retainedPropertyKey(frame,inst,this.state);
    if(reference){
      const operation=retained?'property.key.resume':'property.key.convert';
      return this.commit(operation,(s,eventId)=>{
        const parent=s.frames[frame.id];
        if(!retained)parent.pendingPropertyKeyConversion=copy(reference);
        try{return this.advancePropertyKeyConversion(s,parent,eventId);}
        catch(error){
          if(!(error instanceof GuestFault))throw error;
          const completion={type:'throw',errorType:error.name,message:error.message,origin:eventId};
          completion.value=this.caughtError(s,completion,eventId);this.routeCompletion(s,parent,completion,eventId);
          return {completion};
        }
      },{siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId,invocationId:frame.id});
    }
    const {op,arg}=inst;
    return this.commit(opNames[op],(s,eventId)=>{
      const f=s.frames[frame.id], st=f.stack;f.pc++;
      const pop=()=>{if(!st.length)throw new Error(`Stack underflow: ${op}`);return st.pop();};
      const result=(v)=>{this.stackPush(f,v,eventId);return {result:v};};
      const operands=(...t)=>({operands:t.map(x=>x.value),origins:t.map(x=>x.origin)});
      try { switch(op){
        case 'CONST':return result(arg.value);
        case 'FOR_IN_CREATE':{
          const source=pop(),snapshot=enumerationSnapshot(s.heap,source.value),id=this.next(s,'obj');
          s.heap[id]={id,kind:'enumerator',source:source.value,...snapshot,nextIndex:0,done:false,
            properties:{},propertyVersions:{},shapeVersion:0,version:0};
          return {...operands(source),...result(['ref',id])};
        }
        case 'FOR_IN_NEXT':{
          const value=pop(),cursor=value.value[0]==='ref'?s.heap[value.value[1]]:null;
          if(cursor?.kind!=='enumerator')throw new Error('For-in cursor identity missing');
          if(cursor.done)return {...operands(value),...result(this.iteratorResult(s,U,true,eventId))};
          const live=enumerationSnapshot(s.heap,cursor.source);
          if(!enumerationStillCompatible(s.heap,cursor,live))
            throw new TypeError('For-in surviving key descriptor or prototype mutation outside the owned profile');
          let key;
          while(cursor.nextIndex<cursor.keys.length){
            const candidate=cursor.keys[cursor.nextIndex++];
            if(cursor.source[0]==='str'||ownedHasProperty(ownedObjectHeap(s),cursor.source,stringPropertyKey(candidate))){key=candidate;break;}
          }
          cursor.done=key===undefined;
          return {...operands(value),...result(this.iteratorResult(s,cursor.done?U:['str',key],cursor.done,eventId))};
        }
        case 'INSTANCEOF_RESULT':{const value=pop();return {...operands(value),...result(['bool',truthy(value.value)])};}
        case 'INSTANCEOF_DEFAULT':{
          const constructor=pop(),value=pop(),target=constructor.value[0]==='ref'?s.heap[constructor.value[1]]:null;
          if(target?.kind!=='function'&&!['builtinfn','hostfn'].includes(constructor.value[0])&&
             !(constructor.value[0]==='intrinsic'&&!['Math','Reflect','Atomics','Object.prototype','Array.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(constructor.value[1])))
            guestFault('TypeError','Right-hand side of instanceof is not callable');
          return {...operands(value,constructor),...result(['bool',this.ordinaryHasInstance(s,constructor.value,value.value,eventId)])};
        }
        case 'GET_TEMPLATE_OBJECT':{
          const known=s.control.a0.templateObjects?.[inst.siteId];
          if(known)return result(['ref',known]);
          const make=(values,raw=false)=>{
            const id=this.next(s,'obj'),object=s.heap[id]={id,kind:'array',properties:{length:token(['num',values.length],eventId)},
              propertyVersions:{length:1},dataAttributes:{length:{enumerable:false,writable:false,configurable:false}},shapeVersion:1,version:0};
            values.forEach((value,index)=>{
              putOwn(object,String(index),value,eventId);
              object.dataAttributes[index]={enumerable:true,writable:false,configurable:false};
            });
            if(raw)object.extensible=false;
            return object;
          };
          const raw=make(arg.raw.map(text=>['str',text]),true),cooked=make(arg.cooked);
          putOwn(cooked,'raw',['ref',raw.id],eventId);cooked.dataAttributes.raw={enumerable:false,writable:false,configurable:false};
          cooked.extensible=false;cooked.templateSite=inst.siteId;raw.templateRawOf=inst.siteId;
          (s.control.a0.templateObjects??={})[inst.siteId]=cooked.id;
          return result(['ref',cooked.id]);
        }
        case 'PROPERTY_KEY':{const value=pop();return {...operands(value),...result(propertyKeyValue(valueKey(value.value)))};}
        case 'CLASS_CONSTRUCTOR_GUARD':
          if(!f.newTarget)guestFault('TypeError','Class constructor cannot be invoked without new');
          return {};
        case 'ITERATOR_THROW_MISSING':guestFault('TypeError','Delegated iterator has no throw method');break;
        case 'DELEGATE_RESUME_KIND':
          if(!f.delegateResume)throw new Error('Missing delegated completion');
          return result(['str',f.delegateResume.kind]);
        case 'DELEGATE_RESUME_VALUE':{
          if(!f.delegateResume)throw new Error('Missing delegated value');
          const value=f.delegateResume.value;delete f.delegateResume;return {...operands(value),...result(value.value)};
        }
        case 'NEW_TARGET':{
          const owner=f.thisBindingFrameId?s.frames[f.thisBindingFrameId]:f;
          return result(owner.newTarget??U);
        }
        case 'THIS':{
          const owner=f.thisBindingFrameId?s.frames[f.thisBindingFrameId]:f;
          if(owner.thisInitialized===false)guestFault('ReferenceError','Must call super constructor before accessing this');
          if(owner.thisValue[0]==='undefined'&&!this.programs[f.codeId].strict)
            throw new TypeError('Global sloppy this is not modeled by the bounded object profile');
          return result(owner.thisValue);
        }
        case 'DECLARE':{const e=s.envs[f.envId];if(Object.hasOwn(e.bindings,arg.name))throw new SyntaxError(`Duplicate declaration ${arg.name}`);e.bindings[arg.name]={kind:arg.kind,initialized:false,token:null,version:0};return {};}
        case 'INIT':{const v=pop(),b=lookup(s,f.envId,arg);if(b.cell.initialized)throw new Error('Already initialized');b.cell.initialized=true;b.cell.token=v;b.cell.version++;return {...operands(v),result:v.value};}
        case 'PARAM_INIT':{
          const b=lookup(s,f.envId,arg);
          if(b.cell.kind!=='parameter'||b.cell.initialized)
            throw new Error('Invalid parameter initialization');
          b.cell.initialized=true;b.cell.version++;
          return {...operands(b.cell.token),result:b.cell.token.value};
        }
        case 'ENTER_BODY_ENV':{
          const parameters=s.envs[f.envId],body=this.newEnv(s,f.envId);
          for(const name of this.programs[f.codeId].varNames??[]){
            const parameter=parameters.bindings[name];
            s.envs[body].bindings[name]={kind:'var',initialized:true,
              token:parameter?copy(parameter.token):token(U),version:0};
          }
          f.envId=body;return {};
        }
        case 'GET':{const b=lookup(s,f.envId,arg);if(!b.cell.initialized)bindingTdz(b,arg);this.stackPush(f,b.cell.token.value,eventId);return {result:b.cell.token.value,reads:[{kind:'binding',envId:b.env.id,name:arg,version:b.cell.version??0,
            value:b.cell.token.value,supplyingEvent:b.cell.token.origin??null}],origins:[b.cell.token.origin]};}
        case 'TYPEOF_BINDING':{
          let current=f.envId,found=null;
          while(current){
            const env=s.envs[current];
            if(Object.hasOwn(env.bindings,arg)){
              found={env,cell:env.bindings[arg]};break;
            }
            current=env.parent;
          }
          if(!found)return result(['str','undefined']);
          if(!found.cell.initialized)
            bindingTdz(found,arg);
          const value=found.cell.token;
          const type=primitiveUnary('typeof',value.value,s.heap);
          this.stackPush(f,type,eventId);
          return {operands:[value.value],origins:[value.origin],result:type,
            reads:[{kind:'binding',envId:found.env.id,name:arg,
              version:found.cell.version??0,value:value.value,
              supplyingEvent:value.origin??null}]};
        }
        case 'DEFAULT_GUARD':{
          const b=lookup(s,f.envId,arg.name);
          if(b.cell.kind!=='parameter'||b.cell.initialized)
            throw new Error('Default guard requires an uninitialized parameter');
          const needsDefault=b.cell.token.value[0]==='undefined';
          if(!needsDefault)f.pc=arg.skipPc;
          return {result:['bool',needsDefault],
            reads:[{kind:'binding',envId:b.env.id,name:arg.name,
              version:b.cell.version??0,value:b.cell.token.value,
              supplyingEvent:b.cell.token.origin??null}]};
        }
        case 'SET':{const v=pop(),b=lookup(s,f.envId,arg);if(!b.cell.initialized){
          if(b.cell.kind==='parameter')bindingTdz(b,arg);
          guestFault('ReferenceError',`${arg} is not initialized`);
        }if(b.cell.kind==='const')guestFault('TypeError',`Assignment to constant ${arg}`);b.cell.token=v;b.cell.version=(b.cell.version??0)+1;this.stackPush(f,v.value,eventId);return {...operands(v),result:v.value};}
        case 'UPDATE_BINDING':{
          const b=lookup(s,f.envId,arg.name);
          if(!b.cell.initialized)
            bindingTdz(b,arg.name);
          const before=b.cell.token,oldVersion=b.cell.version??0;
          // ToNumeric is distinct from Addition's string concatenation.
          const {next,oldNumeric}=scalarUpdate(before.value,arg.operator);
          const returned=arg.prefix?next:oldNumeric;
          if(b.cell.kind==='const')
            guestFault('TypeError',`Assignment to constant ${arg.name}`);
          b.cell.token=token(next,eventId);
          b.cell.version=oldVersion+1;
          this.stackPush(f,returned,eventId);
          return {...operands(before),result:returned,
            reads:[{kind:'binding',envId:b.env.id,name:arg.name,
              version:oldVersion,value:before.value,
              supplyingEvent:before.origin??null}]};
        }
        case 'UPDATE_PROP':{
          const key=pop(),base=pop();
          if(['undefined','null'].includes(base.value[0]))
            guestFault('TypeError','Cannot update properties of '+base.value[0]);
          const property=valueKey(key.value);
          const obj=ownedObjectStorage(s,base.value),heap=ownedObjectHeap(s);
          if(!obj||!['object','array','promise'].includes(obj.kind))
            throw new TypeError('Proxy, function and exotic updates require owned internal methods');
          const described=functionProperty(heap,obj,property);
          if(described.accessor)
            throw new TypeError('Accessor updates need an owned getter/setter continuation');
          const found=ordinaryGet(heap,base.value,property);
          if(!found)throw new TypeError('Unowned update property read');
          const old=found.method;
          const {next,oldNumeric}=scalarUpdate(old.value,arg.operator);
          const returned=arg.prefix?next:oldNumeric;
          const failure=ordinaryDataWriteFailure(s.heap,obj,property,described.attributes);
          if(failure&&this.programs[f.codeId].strict)guestFault('TypeError',failure);
          if(failure){
            this.stackPush(f,returned,eventId);
            return {...operands(base,key,old),result:returned,reads:[found.observation]};
          }
          if(this.entrySpec?.kind==='function' && obj.kind==='array'){
            if(arrayIndex(property) &&
               Number(property)>decode(obj.properties.length.value))
              throw new TypeError('Sparse array updates are outside training-js/1');
            if(property==='length' && next[0]==='num' &&
               decode(next)>decode(obj.properties.length.value))
              throw new TypeError('Array length expansion is outside training-js/1');
          }
          putOwn(obj,property,next,eventId);
          this.stackPush(f,returned,eventId);
          return {...operands(base,key,old),result:returned,reads:[found.observation]};
        }
        case 'DELETE_PROP':{
          const key=pop(),base=pop();
          if(['undefined','null'].includes(base.value[0]))
            guestFault('TypeError','Cannot convert undefined or null to object');
          const property=valueKey(key.value),obj=ownedObjectStorage(s,base.value);
          if(['bool','num','bigint','symbol'].includes(base.value[0]))
            return {...operands(base,key),...result(['bool',true])};
          if(base.value[0]==='str'){
            const nonConfigurable=property==='length'||arrayIndex(property)&&Number(property)<base.value[1].length;
            if(nonConfigurable&&this.programs[f.codeId].strict)
              guestFault('TypeError',`Cannot delete property '${property}' of [object String]`);
            return {...operands(base,key),...result(['bool',!nonConfigurable])};
          }
          if(!obj||!['object','array','function','promise','proxy'].includes(obj.kind))
            throw new TypeError('Delete requires an owned ordinary object');
          if(obj.kind==='proxy')throw new TypeError('Proxy deleteProperty trap requires its owned call boundary');
          if(obj.kind==='function'&&['name','length'].includes(property)&&
             !Object.hasOwn(obj.properties??{},property)&&!Object.hasOwn(obj.accessors??{},property))
            throw new TypeError('Function name/length deletion requires owned function-property storage');
          if(obj.kind==='function'&&property==='prototype'&&!obj.prototypeInitialized&&
             !obj.arrow&&!obj.async&&!obj.nonConstructible&&!this.programs[obj.codeId]?.generator)
            throw new TypeError('Function prototype deletion requires owned function-property storage');
          const accessor=obj.accessors?.[property],present=Object.hasOwn(obj.properties??{},property)||!!accessor,
            success=!present||!(obj.kind==='array'&&property==='length')&&
              (accessor??obj.dataAttributes?.[property])?.configurable!==false;
          if(!success&&this.programs[f.codeId].strict)
            guestFault('TypeError',`Cannot delete property '${property}' of #<Object>`);
          const observation={kind:'property',objectId:obj.id,key:property,present,
            version:Object.hasOwn(obj.propertyVersions??{},property)?obj.propertyVersions[property]:0,
            shapeVersion:obj.shapeVersion??0,
            value:present?(Object.hasOwn(obj.properties??{},property)?obj.properties[property].value:U):U,
            supplyingEvent:present?obj.properties?.[property]?.origin??null:null};
          deleteOrdinaryOwn(obj,property);
          return {...operands(base,key),...result(['bool',success]),reads:[observation]};
        }
        case 'MAKE_FUNCTION':{
          const id=this.next(s,'obj');
          // A named expression owns an immutable self binding outside its
          // parameter/body environments. It neither leaks nor captures an
          // outer alias that a later assignment can replace.
          const closureEnvId=arg.name?this.newEnv(s,f.envId):f.envId;
          if(arg.name)s.envs[closureEnvId].bindings[arg.name]={kind:'const',
            initialized:true,token:token(['ref',id],eventId),version:0};
          s.heap[id]={id,kind:'function',codeId:arg.codeId,
            closureEnvId,async:arg.async===true,arrow:arg.arrow===true,nonConstructible:arg.nonConstructible===true,
            lexicalThis:arg.arrow?f.thisValue:null,
            ...(arg.arrow&&(f.thisBindingFrameId||f.newTarget)?{lexicalThisFrameId:f.thisBindingFrameId??f.id}:{}),version:0};
          this.generatorFunctionProperties(s,s.heap[id],arg.name?['str',arg.name]:arg.inferredName?.stack?f.stack.at(-1).value:['str',arg.inferredName??''],eventId);
          return result(['ref',id]);
        }
        case 'DEF_FN':{const e=s.envs[f.envId],id=this.next(s,'obj');s.heap[id]={id,kind:'function',codeId:arg.codeId,closureEnvId:f.envId,async:arg.async,version:0};this.generatorFunctionProperties(s,s.heap[id],['str',arg.name],eventId);e.bindings[arg.name]={kind:'function',initialized:true,token:token(['ref',id],eventId),version:0};return {result:['ref',id]};}
        case 'ENTER_SCOPE':f.envId=this.newEnv(s,f.envId);return {};
        case 'LEAVE_SCOPE':f.envId=s.envs[f.envId].parent;return {};
        case 'CLONE_LOOP_ENV':{
          const loop=f.loops.at(-1);
          if(!loop || loop.envId!==f.envId)
            throw new Error('Iteration clone outside its lexical loop');
          const original=s.envs[f.envId];
          const names=Array.isArray(arg)?arg:[arg];
          if(!names.length || new Set(names).size!==names.length)
            throw new Error('Invalid iteration binding list');
          const reads=[];
          const envId=this.newEnv(s,original.parent);
          for(const name of names){
            const binding=original.bindings[name];
            if(!binding || binding.kind!=='let' || !binding.initialized)
              throw new Error('Iteration needs initialized let bindings');
            s.envs[envId].bindings[name]=copy(binding);
            reads.push({kind:'binding',envId:original.id,name,
              version:binding.version??0,value:binding.token.value,
              supplyingEvent:binding.token.origin??null});
          }
          loop.envId=envId;
          f.envId=envId;
          return {reads};
        }
        case 'TRY_ENTER':
          f.handlers.push({...arg,envId:f.envId,stackDepth:st.length,
            loopDepth:f.loops.length,phase:'try',caught:null,pending:null});
          return {};
        case 'TRY_NORMAL':{
          const h=f.handlers.at(-1);
          if(!h || !['try','catch'].includes(h.phase))
            throw new Error('No active try/catch completion handler');
          f.envId=h.envId;st.length=h.stackDepth;f.loops.length=h.loopDepth;
          if(h.finallyPc!==null){
            h.phase='finally';h.pending={type:'normal'};f.pc=h.finallyPc;
          }else{f.handlers.pop();f.pc=h.afterPc;}
          return {};
        }
        case 'BIND_CATCH':{
          const h=f.handlers.at(-1);
          if(h?.phase!=='catch'||!h.caught)throw new Error('No caught guest completion');
          const caught=h.caught;
          f.envId=this.newEnv(s,h.envId);
          if(arg!==null)s.envs[f.envId].bindings[arg]={
            kind:'catch',initialized:true,token:caught,version:0
          };
          h.caught=null;
          return {operands:[caught.value],origins:[caught.origin],result:caught.value};
        }
        case 'END_FINALLY':{
          const h=f.handlers.at(-1);
          if(h?.phase!=='finally')throw new Error('No active finally completion');
          f.handlers.pop();f.envId=h.envId;st.length=h.stackDepth;
          f.loops.length=h.loopDepth;
          if(h.pending?.type==='normal')f.pc=h.afterPc;
          else this.routeCompletion(s,f,h.pending,eventId);
          return {};
        }
        case 'LOOP_ENTER':
          f.loops.push({...arg,envId:f.envId,stackDepth:st.length,handlerDepth:f.handlers.length});
          return {};
        case 'LOOP_EXIT':
          if(!f.loops.length)throw new Error('No active loop');
          f.loops.pop();return {};
        case 'LOOP_JUMP':{
          const kind=typeof arg==='string'?arg:arg.kind,label=typeof arg==='string'?null:arg.label;
          const index=f.loops.findLastIndex(loop=>
            (label?(loop.labels??[]).includes(label):true)&&
            (kind==='break'||loop.continuePc!==null));
          const loop=f.loops[index];
          if(!loop)throw new Error('No active target for break/continue');
          this.routeCompletion(s,f,{type:'jump',kind,
            targetPc:kind==='break'?loop.breakPc:loop.continuePc,
            envId:loop.envId,stackDepth:loop.stackDepth,
            handlerDepth:loop.handlerDepth,loopDepth:index+1},eventId);
          return {};
        }
        case 'TEMPLATE':{
          // Template substitutions perform ToString, not '+' concatenation.
          // Each substitution is observed in order. Guest coercion callbacks
          // are refused until an owned continuation models them.
          if(!Number.isInteger(arg.count)||arg.count<0||
             !Array.isArray(arg.quasis)||arg.quasis.length!==arg.count+1 ||
             arg.quasis.some(q=>typeof q!=='string'))
            throw new TypeError('Malformed owned template instruction');
          const values=Array.from({length:arg.count},()=>pop()).reverse();
          let output=arg.quasis[0];
          values.forEach((value,i)=>{
            if(!['undefined','null','bool','str','num','bigint'].includes(value.value[0]))
              throw new TypeError('Template object ToString needs an owned coercion continuation');
            output+=String(decode(value.value))+arg.quasis[i+1];
          });
          return {...operands(...values),...result(['str',output])};
        }
        case 'BINARY':{
          const b=pop(),a=pop();
          if(arg==='in'){
            if(!['ref','promise','intrinsic','builtinfn','hostfn','host'].includes(b.value[0]))
              guestFault('TypeError','Right-hand side of in is not an object');
            const key=valueKey(a.value);
            return {...operands(a,b),...result(['bool',ownedHasProperty(ownedObjectHeap(s),b.value,key)])};
          }
          if([a,b].some(value=>value.value[0]==='symbol')&&!isOwnedArithmetic(arg)&&!['===','!==','==','!='].includes(arg))
            guestFault('TypeError','Cannot convert a Symbol value to a number');
          if(!isOwnedArithmetic(arg))return {...operands(a,b),...result(primitiveBinary(arg,a.value,b.value))};
          const id=this.next(s,'operation');
          if([a,b].some(item=>item.value[0]==='ref'&&s.heap[item.value[1]]?.declaredError)&&
             !['===','!==','==','!='].includes(arg))
            throw new TypeError('Declared error coercion is outside the bounded error profile');
          s.operations[id]=createArithmetic({id,frameId:f.id,operator:arg,left:a,right:b,
            siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId});
          f.operationId=id;
          return {...operands(a,b),causes:[{kind:'spec-operation',operationId:id}]};
        }
        case 'UNARY':{
          const a=pop();
          if(a.value[0]==='symbol'&&!['typeof','!','void'].includes(arg))
            guestFault('TypeError','Cannot convert a Symbol value to a number');
          if(arg==='+' && a.value[0]==='bigint')
            guestFault('TypeError','Cannot convert a BigInt value to a number');
          return {...operands(a),...result(primitiveUnary(arg,a.value,s.heap))};
        }
        case 'POP':{const a=pop();return operands(a);}
        case 'DUP':{const a=pop();st.push(a);st.push(copy(a));return operands(a);}
        case 'DUP2':{
          if(st.length<2)throw new Error('Stack underflow: DUP2');
          const pair=st.slice(-2);
          st.push(copy(pair[0]),copy(pair[1]));
          return operands(...pair);
        }
        case 'JUMP':f.pc=arg;return {};
        case 'JUMP_IF_FALSE':{const a=pop();if(!truthy(a.value))f.pc=arg;return {...operands(a),result:['bool',!truthy(a.value)]};}
        case 'LOGICAL_JUMP':{
          const a=st.at(-1),v=a.value;
          // Optional method calls guard the callable, not the receiver-
          // carrying method token. Preserve that token for CALL on success.
          const nullable=v[0]==='method'?v[1]:v;
          const pass=arg.operator==='&&'?!truthy(v):arg.operator==='||'?truthy(v):
            nullable[0]!=='null'&&nullable[0]!=='undefined';
          if(pass)f.pc=arg.to;
          return {...operands(a),result:['bool',pass]};
        }
        case 'NEW_PINNED_REGEXP':{
          const supported=supportsPinnedRegExp(arg.pattern,arg.flags);
          if(!supported)throw new SyntaxError('Unpinned RegExp pattern or flags');
          const id=this.next(s,'obj');
          s.heap[id]={id,kind:'regexp',properties:{
            '[[Source]]':token(['str',arg.pattern],eventId),
            '[[Flags]]':token(['str',arg.flags],eventId),
            lastIndex:token(['num',0],eventId)
          },propertyVersions:{'[[Source]]':0,'[[Flags]]':0,lastIndex:0},shapeVersion:3,version:0};
          return result(['ref',id]);
        }
        case 'UNSUPPORTED_EXPRESSION':{
          const completion={type:'unsupported',feature:arg};
          this.failFrame(s,f,completion);
          return {completion};
        }
        case 'CONSTRUCT':{
          const args=[];for(let i=0;i<arg;i++)args.unshift(pop());
          const fn=pop();
          if(fn.value[0]==='ref'&&s.heap[fn.value[1]]?.kind==='function'){
            const id=this.beginConstruction(s,fn.value,args,f.id,eventId);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),causes:[{kind:'invocation',frameId:id}]};
          }
          if(fn.value[0]==='intrinsic'&&fn.value[1]==='Symbol')guestFault('TypeError','Symbol is not a constructor');
          if(fn.value[0]==='intrinsic'&&ERROR_CONSTRUCTORS.includes(fn.value[1]))
            return {...operands(fn,...args),...result(this.newDeclaredError(s,fn.value[1],args,eventId))};
          if(fn.value[0]==='intrinsic'&&fn.value[1]==='Promise'){
             if(args.length!==1||!this.callableGuest(s,args[0]?.value))
               guestFault('TypeError','Promise executor must be callable');
             const executor=s.heap[args[0].value[1]];
             // The Promise returned by an async executor is intentionally ignored.
             const p=this.newPromise(s),resolve=['builtinfn','Promise.executor.resolve:'+p],
               reject=['builtinfn','Promise.executor.reject:'+p];
             const inner=executor.async?this.newPromise(s):null;
              const id=this.newFrame(s,executor.codeId,executor.closureEnvId,f.id,inner,
               [token(resolve,eventId),token(reject,eventId)],
               this.functionThis(executor),executor.id);
             s.frames[id].promiseExecutorTarget=p;
             f.pendingPromiseExecutor={waitingFrameId:id,promiseId:p};
             s.control.a0.activeFrameId=id;
             return {...operands(fn,...args),causes:[{kind:'invocation',frameId:id}],
               result:['promise',p]};
           }
          if(fn.value[0]==='intrinsic'&&fn.value[1]==='ArrayBuffer'){
            const length=binaryGuest(()=>binaryIndex(args[0]?.value));
            if(length>1024)throw new BinaryResourceError('ArrayBuffer exceeds the 1024-byte owned profile');
            if(args[1]?.value[0]!==undefined&&args[1].value[0]!=='undefined')
              throw new BinaryProfileError('Resizable ArrayBuffer options require their own profile');
            const id=this.next(s,'obj');s.heap[id]=newArrayBuffer(id,length);
            return {...operands(fn,...args),...result(['ref',id])};
          }
           if(fn.value[0]==='intrinsic'&&fn.value[1]==='SharedArrayBuffer'){
  const length=binaryGuest(()=>binaryIndex(args[0]?.value));
  if(length>1024)throw new BinaryResourceError('SharedArrayBuffer exceeds the 1024-byte owned profile');
  let max;
  if(args[1]?.value[0]!==undefined&&args[1].value[0]!=='undefined'){
    const opts=args[1]?.value[0]==='ref'?s.heap[args[1].value[1]]:null;
    if(opts?.kind!=='object'||Object.keys(opts.accessors??{}).length)
      throw new BinaryProfileError('SAB options require an owned data-object profile');
    const supplied=opts.properties.maxByteLength?.value;
    if(supplied&&supplied[0]!=='undefined'){
      max=binaryGuest(()=>binaryIndex(supplied));
    }
  }
  if(max!==undefined&&max<length)guestFault('RangeError','Invalid maxByteLength');
  if(max>1024)throw new BinaryResourceError('SharedArrayBuffer maximum exceeds the 1024-byte owned profile');
  const id=this.next(s,'obj');s.heap[id]=newSharedBuffer(id,length,max);
  return {...operands(fn,...args),...result(['ref',id])};
}
if(fn.value[0]==='intrinsic'&&fn.value[1]==='DataView'){
  const b=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
  if(!isOwnedBuffer(b))guestFault('TypeError','DataView needs an owned ArrayBuffer or SharedArrayBuffer');
  const offset=binaryGuest(()=>binaryIndex(args[1]?.value));
  const length=args[2]?.value[0]===undefined||args[2].value[0]==='undefined'?undefined:
    binaryGuest(()=>binaryIndex(args[2].value));
  const id=this.next(s,'obj');
  s.heap[id]=binaryGuest(()=>newSharedDataView(id,b,offset,length));
  return {...operands(fn,...args),...result(['ref',id])};
}
if(fn.value[0]==='intrinsic'&&Object.hasOwn(SHARED_TYPES,fn.value[1])){
  const input=args[0]?.value??U;
  let b=input[0]==='ref'?s.heap[input[1]]:null,offset,length;
  if(isOwnedBuffer(b)){
    offset=binaryGuest(()=>binaryIndex(args[1]?.value));
    // Alignment is checked before converting the optional length.
    if(offset%SHARED_TYPES[fn.value[1]].bytes)guestFault('RangeError','Typed-array offset is not aligned');
    length=args[2]?.value[0]===undefined||args[2].value[0]==='undefined'?undefined:
      binaryGuest(()=>binaryIndex(args[2].value));
  }else{
    if(input[0]==='ref')throw new BinaryProfileError('Typed-array iterable/array-like construction requires its own profile');
    length=binaryGuest(()=>binaryIndex(input));offset=0;
    const bytes=length*SHARED_TYPES[fn.value[1]].bytes;
    if(bytes>1024)throw new BinaryResourceError('Typed-array storage exceeds the 1024-byte owned profile');
    const bufferId=this.next(s,'obj');b=s.heap[bufferId]=newArrayBuffer(bufferId,bytes);
  }
  const id=this.next(s,'obj');
  s.heap[id]=binaryGuest(()=>newSharedView(id,b,fn.value[1],offset,length));
  return {...operands(fn,...args),...result(['ref',id])};
}
if(fn.value[0]!=='intrinsic'||fn.value[1]!=='Set'){
            if(!['ref','intrinsic'].includes(fn.value[0])||fn.value[0]==='ref'&&s.heap[fn.value[1]]?.kind!=='proxy')guestFault('TypeError','Value is not a constructor');
            const completion={type:'unsupported',feature:'Constructor requires owned semantics: '+String(fn.value[1])};
            this.failFrame(s,f,completion);return {...operands(fn,...args),completion};
          }
          const input=args[0]?.value??U;
          const iterable=input[0]==='ref'?s.heap[input[1]]:null;
          if(input[0]!=='undefined'&&input[0]!=='null' &&
             (iterable?.kind!=='array'||Object.keys(iterable.accessors??{}).length))
            throw new TypeError('Set constructor requires an owned ordinary array iterable');
          const elements=[];
          if(iterable){
            const length=decode(iterable.properties.length.value);
            if(!Number.isSafeInteger(length)||length<0||length>10000)
              throw new RangeError('Set constructor iterable exceeds bounded profile');
            for(let i=0;i<length;i++){
              const entry=iterable.properties[String(i)];
              if(!entry)throw new TypeError('Sparse Set constructor iterable is unsupported');
              if(!elements.some(v=>ownedSameValue(v,entry.value,true)))
                elements.push(entry.value[0]==='num'&&decode(entry.value)===0?['num',0]:entry.value);
            }
          }
          const id=this.next(s,'obj');
          const properties={'[[Size]]':token(['num',elements.length],eventId)};
          const propertyVersions={'[[Size]]':0};
          elements.forEach((value,i)=>{properties[String(i)]=token(value,eventId);propertyVersions[String(i)]=0;});
          // These are serializable, model-visible INTERNAL slots; Set property
          // access never exposes their string names to guest code.
          s.heap[id]={id,kind:'set',properties,propertyVersions,
            shapeVersion:elements.length+1,version:0};
          return {...operands(fn,...args),...result(['ref',id])};
        }
        case 'NEW_PROXY':{
          const handler=pop(),target=pop();
          if(isPrimitiveValue(target.value)||isPrimitiveValue(handler.value))
            guestFault('TypeError','Proxy target and handler must be objects');
          if(target.value[0]!=='ref'||!['object','array','proxy'].includes(s.heap[target.value[1]]?.kind)||
             handler.value[0]!=='ref'||!['object','array'].includes(s.heap[handler.value[1]]?.kind))
            throw new TypeError('Proxy construction requires owned ordinary target and handler storage');
          const id=this.next(s,'obj');
          s.heap[id]={id,kind:'proxy',targetId:target.value[1],handlerId:handler.value[1],
            properties:{},propertyVersions:{},shapeVersion:0,version:0};
          return {...operands(target,handler),...result(['ref',id])};
        }
        case 'NEW_OBJECT':case 'NEW_ARRAY':{const id=this.next(s,'obj');s.heap[id]={id,kind:op==='NEW_ARRAY'?'array':'object',properties:{},propertyVersions:{},shapeVersion:0,version:0};if(op==='NEW_ARRAY'){s.heap[id].properties.length=token(['num',arg?.length??0],eventId);s.heap[id].propertyVersions.length=0;}return result(['ref',id]);}
        case 'SPREAD':{
          const source=pop(),snapshot=spreadSnapshot(s.heap,source);
          return {...operands(source,...snapshot.values),
            ...result(['spread',snapshot.values.map(item=>copy(item.value))]),reads:snapshot.reads};
        }
        case 'APPEND_ARRAY':{
          const item=pop(),base=pop(),obj=base.value[0]==='ref'?s.heap[base.value[1]]:null;
          if(obj?.kind!=='array'||objectPrototype(obj)!=='Array.prototype'||
             Object.keys(obj.accessors??{}).length)
            throw new TypeError('Array literal append requires an owned result array');
          if(arg.spread&&(item.value[0]!=='spread'||!Array.isArray(item.value[1])))
            throw new Error('Array literal spread lacks its evaluated snapshot');
          const values=arg.spread?item.value[1]:[item.value],start=decode(obj.properties.length.value);
          if(!Number.isSafeInteger(start)||start<0||start+values.length>10000)
            throw new RangeError('Owned array literal length budget exceeded');
          if(arg.hole)putOwn(obj,'length',['num',start+1],eventId);
          else for(let i=0;i<values.length;i++)putOwn(obj,String(start+i),values[i],eventId);
          return {...operands(base,item),...result(base.value)};
        }
        case 'GET_PROP':case 'GET_METHOD':{
          const key=pop(),base=pop();
          if(['null','undefined'].includes(base.value[0]))
            guestFault('TypeError',`Cannot read properties of ${base.value[0]}`);
          const property=valueKey(key.value);let v,read=null;
          if(base.value[0]==='intrinsic'&&base.value[1]==='Math'&&property==='random' &&
             !Number.isInteger(s.control.a0.randomSeed)){
            const completion={type:'unsupported',feature:'Math.random requires an explicit deterministic fixture seed'};
            this.failFrame(s,f,completion);
            return {...operands(base,key),completion};
          }
          if(base.value[0]==='host')v=['hostfn',base.value[1]==='demo'?(HOST_METHODS[property]??`demo.${property}`):`${base.value[1]}.${property}`];
          else if(base.value[0]==='intrinsic'&&base.value[1]==='globalThis'){
            const own=ownedGlobalProperty(s,property,this.sources);
            if(own)v=own.value;
            else if(property==='hasOwnProperty')v=['builtinfn','Object.prototype.hasOwnProperty'];
            else if(property in Object.prototype)throw new TypeError('Global inherited property requires owned ordinary storage');
            else v=U;
          }
          else if(base.value[0]==='intrinsic'&&GENERATOR_INTRINSIC_PROTOTYPES.includes(base.value[1]))
            v=generatorIntrinsicProperty(base.value[1],property).value;
          else if(['intrinsic','builtinfn','hostfn'].includes(base.value[0])&&property===symbolPropertyKey('well-known:hasInstance'))
            v=base.value[0]==='intrinsic'&&['Math','Reflect','Atomics','Object.prototype','Array.prototype'].includes(base.value[1])?U:['builtinfn','Function.prototype.hasInstance'];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Date' &&
                  property==='now')v=['hostfn','platform.dateNow'];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Atomics' &&
             ['load','store','add','sub','and','or','xor','exchange','compareExchange','wait','notify'].includes(property))
            v=['builtinfn','Atomics.'+property];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Promise' && ['resolve','reject','all','race','allSettled','any','withResolvers'].includes(property))v=['builtinfn',`Promise.${property}`];
          else if(base.value[0]==='intrinsic'&&base.value[1]==='Promise'&&property==='prototype'){
            ensurePromisePrototype(s);v=['intrinsic','Promise.prototype'];
          }
          else if(['intrinsic','builtinfn','hostfn'].includes(base.value[0])&&
            primitiveUnary('typeof',base.value,s.heap)[1]==='function'&&['call','apply'].includes(property))
            v=['builtinfn','Function.prototype.'+property];
          else if(base.value[0]==='intrinsic'&&ERROR_CONSTRUCTORS.includes(base.value[1])&&property==='name')
            v=['str',base.value[1]];
          else if(base.value[0]==='intrinsic' &&
             ((base.value[1]==='Math' &&
               ['abs','ceil','floor','trunc','round','max','min','pow','sign','sqrt','hypot','random'].includes(property)) ||
              (base.value[1]==='Number' &&
               ['isFinite','isNaN','isInteger','isSafeInteger'].includes(property)) ||
              (base.value[1]==='Array' && ['isArray','from'].includes(property))))
            v=['builtinfn',base.value[1]+'.'+property];
          else if(base.value[0]==='intrinsic'&&base.value[1]==='Symbol'){
            if(WELL_KNOWN_SYMBOLS.includes(property))v=wellKnownSymbol(property);
            else if(['for','keyFor'].includes(property))v=['builtinfn','Symbol.'+property];
            else throw new TypeError('Unmodeled Symbol static property');
          }
          else if(base.value[0]==='intrinsic'&&base.value[1]==='Reflect'&&
             ['ownKeys','apply','set','deleteProperty','defineProperty','has'].includes(property))v=['builtinfn','Reflect.'+property];
          else if(base.value[0]==='symbol'){
            if(property==='description')v=this.symbolDescription(s,base.value);
            else if(['toString','valueOf'].includes(property))v=['builtinfn','Symbol.prototype.'+property];
            else if(property===symbolPropertyKey('well-known:toPrimitive'))v=['builtinfn','Symbol.prototype.valueOf'];
            else v=U;
          }
          else if(base.value[0]==='intrinsic'&&base.value[1]==='ArrayBuffer'&&property==='isView')
            v=['builtinfn','ArrayBuffer.isView'];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' &&
             ['create','setPrototypeOf','getPrototypeOf','defineProperty','getOwnPropertyDescriptor','isFrozen','isSealed','isExtensible','preventExtensions','freeze','seal','hasOwn','keys','values','entries','assign','is','getOwnPropertySymbols','getOwnPropertyNames'].includes(property))
            v=['builtinfn',`Object.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' && property==='prototype')
            v=['intrinsic','Object.prototype'];
          else if(base.value[0]==='intrinsic'&&base.value[1]==='Object.prototype'&&property==='hasOwnProperty')
            v=['builtinfn','Object.prototype.hasOwnProperty'];
          else if(base.value[0]==='promise'||base.value[0]==='intrinsic'&&base.value[1]==='Promise.prototype'){
            const object=ownedObjectStorage(s,base.value),heap=ownedObjectHeap(s);
            if(!object)throw new ReferenceError('Unknown guest promise');
            const found=ordinaryGet(heap,base.value,property,{accessors:true});
            if(!found)throw new TypeError('Unmodeled Promise ordinary property lookup');
            if(found.accessor){
              const getter=found.accessor.get.value;
              if(getter[0]==='undefined')v=U;
              else{
                if(!this.callableGuest(s,getter)||s.heap[getter[1]].async)
                  throw new TypeError('Unsupported Promise accessor getter continuation');
                const target=s.heap[getter[1]],id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,null,[],this.functionThis(target,base.value),target.id);
                f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id};
                s.control.a0.activeFrameId=id;
                return {...operands(base,key),reads:[found.observation],causes:[{kind:'invocation',frameId:id}]};
              }
            }else v=found.method.value;
            read=found.observation;
          }
           else if(base.value[0]==='num'){
             if(['toString','toFixed'].includes(property))
               v=['builtinfn','Number.prototype.'+property];
             else if(['constructor','__proto__','valueOf'].includes(property))
               throw new TypeError('Unmodeled Number prototype property');
             else v=U;
           }
           else if(base.value[0]==='str'){
             // String primitive reads never consult the host object graph.
             const text=base.value[1];
             if(property===symbolPropertyKey('well-known:iterator'))v=['builtinfn','String.prototype.iterator'];
             else if(property==='length')v=['num',text.length];
             else if(arrayIndex(property)&&Number(property)<text.length)
               v=['str',text[Number(property)]];
             else if(['charAt','charCodeAt','at','substring','substr','slice','indexOf','lastIndexOf','includes','startsWith','endsWith','toLowerCase','toUpperCase','trim','trimStart','trimEnd','split','replace'].includes(property))
               v=['builtinfn','String.prototype.'+property];
             else if(['constructor','__proto__','valueOf','toString'].includes(property))
               throw new TypeError('Unmodeled String prototype property');
             else v=U;
           }
           else if(base.value[0]==='ref'){
             const obj=s.heap[base.value[1]];
             if(!obj)throw new ReferenceError('Unknown guest identity');
             if(obj.kind==='function'||obj.kind==='generator'){
               if(obj.kind==='function')this.functionProperties(s,obj,eventId,{prototype:property==='prototype'});
               const found=functionProperty(s.heap,obj,property);
               if(obj.kind==='function'&&['name','length'].includes(property)&&!Object.hasOwn(obj.properties,property)&&!Object.hasOwn(obj.accessors??{},property)||
                  ['constructor','__proto__','toString','valueOf','call','apply','bind'].includes(property)&&!found.slot&&!found.accessor)
                 throw new TypeError('Unmodeled function prototype reflection or call adapter');
               if(obj.kind==='function'&&['arguments','caller'].includes(property)&&!found.slot&&!found.accessor)guestFault('TypeError','Restricted strict function property');
               const accessor=found.accessor;
               if(accessor){
                 if(accessor.get.value[0]==='undefined')return {...operands(base,key),...result(op==='GET_METHOD'?['method',U,base.value]:U)};
                 const getter=s.heap[accessor.get.value[1]];
                 if(getter?.kind!=='function'||getter.async)throw new TypeError('Unsupported function getter continuation');
                 const id=this.newFrame(s,getter.codeId,getter.closureEnvId,f.id,null,[],this.functionThis(getter,base.value),getter.id);
                 f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id};s.control.a0.activeFrameId=id;
                 return {...operands(base,key),causes:[{kind:'invocation',frameId:id}]};
               }
               const slot=found.slot;v=slot?.value??U;
               return {...operands(base,key),...result(op==='GET_METHOD'?['method',v,base.value]:v),reads:[{
                 kind:'property',objectId:obj.id,key:property,present:!!slot,version:obj.propertyVersions[property]??0,
                 shapeVersion:obj.shapeVersion,value:v,supplyingEvent:slot?.origin??null}]};
             }
             if(obj.declaredError&&property==='constructor'){
               const constructor=['intrinsic',obj.declaredError];
               return {...operands(base,key),...result(op==='GET_METHOD'?['method',constructor,base.value]:constructor)};
             }
             if(obj.declaredError&&!['name','message'].includes(property))
               throw new TypeError('Declared error exposes only name and message');
             if(obj.kind==='iterator'){
               const slot=Object.hasOwn(obj.properties,property)?obj.properties[property]:null;
               if(slot)v=slot.value;
               else if(property==='next')v=['builtinfn','Iterator.next'];
               else if(property===symbolPropertyKey('well-known:iterator'))v=['builtinfn','Iterator.identity'];
               else if(property===symbolPropertyKey('well-known:toStringTag'))v=['str',obj.iterationKind==='string'?'String Iterator':'Array Iterator'];
               else if(['constructor','__proto__','toString','valueOf'].includes(property))throw new TypeError('Unmodeled iterator prototype property');
               else v=U;
               return {...operands(base,key),...result(op==='GET_METHOD'?['method',v,base.value]:v),...(slot?{reads:[{
                 kind:'property',objectId:obj.id,key:property,present:true,version:obj.propertyVersions[property]??0,
                 shapeVersion:obj.shapeVersion,value:v,supplyingEvent:slot.origin??null}]}:{})};
             }
             if(obj.kind==='regexp'){
               if(property==='test'){
                 const method=['builtinfn','RegExp.prototype.test'];
                 return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
               }
               if(property==='lastIndex'){
                 const read=obj.properties.lastIndex;
                 return {...operands(base,key),...result(read.value),reads:[{
                   kind:'property',objectId:obj.id,key:property,present:true,
                   shapeVersion:obj.shapeVersion??0,
                   version:obj.propertyVersions.lastIndex??0,value:read.value,
                   supplyingEvent:read.origin??null}]};
               }
               throw new TypeError('Unmodeled RegExp property '+property);
             }
             if(obj.kind==='array-buffer'){
  if(['byteLength','maxByteLength'].includes(property))return {...operands(base,key),...result(['num',obj.byteLength])};
  if(['resizable','detached'].includes(property))return {...operands(base,key),...result(['bool',false])};
  if(property==='slice'){
    const method=['builtinfn','ArrayBuffer.prototype.slice'];
    return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
  }
  throw new BinaryProfileError('ArrayBuffer property requires its own profile: '+String(property));
}
             if(obj.kind==='shared-int32-buffer'){
  if(property==='byteLength')return {...operands(base,key),...result(['num',obj.byteLength])};
  if(property==='maxByteLength')return {...operands(base,key),...result(['num',obj.maxByteLength??obj.byteLength])};
  if(property==='growable')return {...operands(base,key),...result(['bool',obj.growable===true])};
  if(property==='grow'){
    const method=['builtinfn','SharedArrayBuffer.prototype.grow'];
    return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
  }
  if(property==='slice'){
    const method=['builtinfn','SharedArrayBuffer.prototype.slice'];
    return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
  }
  throw new BinaryProfileError('Unmodeled SharedArrayBuffer property profile');
}
if(isOwnedDataView(obj)){
  const length=effectiveDataViewLength(s.heap[obj.bufferId],obj);
  if(property==='byteLength')return {...operands(base,key),...result(['num',length])};
  if(property==='byteOffset')return {...operands(base,key),...result(['num',obj.byteOffset])};
  if(property==='buffer')return {...operands(base,key),...result(['ref',obj.bufferId])};
  if(DATA_VIEW_GETTERS.includes(property)||DATA_VIEW_SETTERS.includes(property)){
    const method=['builtinfn','DataView.prototype.'+property];
    return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
  }
  throw new BinaryProfileError('Unmodeled DataView property profile');
}
if(isOwnedTypedView(obj)){
  const bytes=SHARED_TYPES[obj.elementType].bytes;
  const length=effectiveSharedLength(s.heap[obj.bufferId],obj);
  for(const [prop,v] of Object.entries({length,byteLength:length*bytes,
    byteOffset:obj.byteOffset,BYTES_PER_ELEMENT:bytes}))
    if(property===prop)return {...operands(base,key),...result(['num',v])};
  if(property==='buffer')return {...operands(base,key),...result(['ref',obj.bufferId])};
  if(property==='subarray'){
    const method=['builtinfn','TypedArray.prototype.subarray'];
    return {...operands(base,key),...result(op==='GET_METHOD'?['method',method,base.value]:method)};
  }
  const index=binaryNumericKey(property);
  if(index===undefined)throw new BinaryProfileError('Typed-array ordinary property needs its own profile');
  return {...operands(base,key),...result(binaryValidIndex(index,length)?readSharedElement(s.heap[obj.bufferId],obj,index):U)};
}
if(obj.kind==='set'){
               if(['has','add'].includes(property)){
                 const v=['builtinfn','Set.prototype.'+property];
                 const output=op==='GET_METHOD'?['method',v,base.value]:v;
                 return {...operands(base,key),...result(output)};
               }
               throw new TypeError('Unmodeled Set property '+property);
             }
             const route=obj.kind==='proxy'?proxyRoute(s.heap,base.value,'get'):
               {kind:'ordinary',target:base.value,receiver:base.value};
             if(route.kind==='trap'){
               const target=s.heap[route.target[1]];
               if(!['object','array'].includes(target?.kind))
                 throw new TypeError('Proxy trap target invariants require ordinary storage');
               const trap=route.method;
               if(!this.callableGuest(s,trap)||s.heap[trap[1]].async)
                 throw new TypeError('Proxy get trap must be synchronous guest function');
               const fn=s.heap[trap[1]];
               const id=this.newFrame(s,fn.codeId,fn.closureEnvId,
                 f.id,null,[token(route.target),key,token(base.value)],this.functionThis(fn,route.handler),fn.id);
               f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id,
                 proxy:{target:route.target,key:property,strict:!!this.programs[f.codeId].strict}};
               s.control.a0.activeFrameId=id;
               return {...operands(base,key),causes:[{kind:'invocation',frameId:id}],
                 reads:[route.observation]};
             }
             const accessor=propertyAccessor(ownedObjectHeap(s),route.target,property);
             if(accessor){
               const getter=accessor.get.value;
               if(getter[0]==='undefined')v=U;
               else{
                 if(!this.callableGuest(s,getter)||s.heap[getter[1]].async)
                   throw new TypeError('Unsupported accessor getter continuation');
                 const target=s.heap[getter[1]];
                 const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,null,[],this.functionThis(target,base.value),target.id);
                 f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id};
                 s.control.a0.activeFrameId=id;
                 return {...operands(base,key),causes:[{kind:'invocation',frameId:id}]};
               }
             }else{
               const found=ordinaryGet(ownedObjectHeap(s),route.target,property);
               if(!found)throw new TypeError('Unmodeled ordinary [[Get]] or exotic property');
               v=found.method.value;read=found.observation;
             }
           }
          else if(['null','undefined'].includes(base.value[0]))
             guestFault('TypeError',`Cannot read properties of ${base.value[0]}`);
           else throw new TypeError('Unsupported property receiver (no host fallback)');
          const output=op==='GET_METHOD'?['method',v,base.value]:v;
          return {...operands(base,key),...result(output),reads:read?[read]:[]};
        }
        case 'PENDING_THROW':{
          const handler=f.handlers.findLast(item=>item.phase==='finally');
          if(!handler)throw new Error('Pending completion read outside finally');
          return result(['bool',handler.pending?.type==='throw']);
        }
        case 'ITERATOR_ARRAY_GUARD':{
          const source=pop(),obj=source.value[0]==='ref'?s.heap[source.value[1]]:null;
          const key=symbolPropertyKey('well-known:iterator');
          return {...operands(source),...result(['bool',obj?.kind==='array'&&objectPrototype(obj)==='Array.prototype'&&
            !Object.hasOwn(obj.properties,key)&&!Object.hasOwn(obj.accessors??{},key)])};
        }
        case 'REQUIRE_OBJECT':{
          const value=pop();
          if(!['ref','promise','intrinsic','builtinfn','hostfn'].includes(value.value[0]))
            guestFault('TypeError','Iterator result must be an object');
          return {...operands(value),...result(value.value)};
        }
        case 'REQUIRE_COERCIBLE':{
          const value=pop();
          if(['null','undefined'].includes(value.value[0]))guestFault('TypeError','Cannot destructure null or undefined');
          return {...operands(value),...result(value.value)};
        }
        case 'COPY_KEYS':{
          const exclusions=[];for(let i=0;i<arg.exclude;i++)exclusions.unshift(pop());
          const source=pop(),value=source.value,excluded=new Set(exclusions.map(item=>valueKey(item.value)));
          let keys=[];
          if(value[0]==='ref'){
            const obj=s.heap[value[1]];
            if(!obj||!['object','array'].includes(obj.kind))
              throw new TypeError('Property copying requires ordinary owned keys');
            keys=ownPropertyKeys(obj);
          }else if(value[0]==='str')keys=Array.from({length:value[1].length},(_,i)=>String(i));
          else if(['null','undefined'].includes(value[0])&&arg.required)
            guestFault('TypeError','Cannot destructure null or undefined');
          else if(!['null','undefined','num','bool','bigint','symbol'].includes(value[0]))
            throw new TypeError('Property copying source outside profile');
          keys=keys.filter(key=>!excluded.has(key));
          if(keys.length>10000)throw new RangeError('Property copy key budget');
          const id=this.next(s,'obj'),obj=s.heap[id]={id,kind:'array',properties:{length:token(['num',keys.length],eventId)},propertyVersions:{length:0},shapeVersion:0,version:0};
          keys.forEach((key,i)=>putOwn(obj,String(i),propertyKeyValue(key),eventId));
          return {...operands(source,...exclusions),...result(['ref',id])};
        }
        case 'HAS_ENUMERABLE_OWN':{
          const key=pop(),source=pop(),name=valueKey(key.value),value=source.value;
          const present=value[0]==='str'?arrayIndex(name)&&Number(name)<value[1].length:
            value[0]==='ref'?enumerableOwn(s.heap[value[1]],name):false;
          return {...operands(source,key),...result(['bool',!!present])};
        }
        case 'SET_HOME_OBJECT':{
          const value=pop(),home=arg.name?lookup(s,f.envId,arg.name).cell.token:f.stack.at(-arg.offset);
          const fn=s.heap[value.value[1]];
          if(arg.methodName){
            const name=arg.methodName.privateName?['str',arg.methodName.privateName]:lookup(s,f.envId,arg.methodName.binding).cell.token.value;
            this.classFunctionProperties(s,fn,name,eventId,arg.methodName.prefix??null);
          }
          this.setHomeObject(s,fn,home.value,eventId);
          return {...operands(value,home),...result(value.value)};
        }
        case 'SUPER_REFERENCE':{
          const key=pop(),receiver=pop(),home=lookup(s,f.envId,'[[home object]]').cell.token;
          const parent=objectPrototype(s.heap[home.value[1]]),base=parent===null?['null']:
            ['Object.prototype','Array.prototype','Function.prototype'].includes(parent)?['intrinsic',parent]:['ref',parent];
          return {...operands(receiver,key,home),...result(['superreference',base,receiver.value,key.value])};
        }
        case 'SUPER_GET':case 'SUPER_GET_METHOD':case 'SUPER_SET':{
          const assigned=op==='SUPER_SET'?pop():null,reference=pop();
          if(reference.value[0]!=='superreference')throw new Error('Super property lost its reference');
          const [,base,receiver,key]=reference.value,property=valueKey(key),found=superProperty(s.heap,base,property);
          const inputs=[token(receiver,reference.origin),token(key,reference.origin),...(assigned?[assigned]:[])];
          if(assigned){
            if(found.accessor){
              const setter=found.accessor.set.value;
              if(setter[0]==='undefined')guestFault('TypeError','Cannot assign to a super getter without a setter');
              const fn=s.heap[setter[1]];
              if(fn?.kind!=='function'||fn.async)throw new TypeError('Super setter requires a synchronous owned continuation');
              const id=this.newFrame(s,fn.codeId,fn.closureEnvId,f.id,null,[assigned],this.functionThis(fn,receiver),fn.id);
              f.pendingProperty={kind:'set',value:assigned.value,waitingFrameId:id};s.control.a0.activeFrameId=id;
              return {...operands(...inputs),causes:[{kind:'invocation',frameId:id}]};
            }
            if(found.attributes?.writable===false)guestFault('TypeError','Cannot assign to a readonly super property');
            const object=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(!object)guestFault('TypeError','Super assignment receiver is not an object');
            if(!['object','array','function'].includes(object.kind))throw new TypeError('Super assignment requires owned ordinary receiver internal methods');
            if(object.kind==='function')this.functionProperties(s,object,eventId,{prototype:property==='prototype'});
            if(Object.hasOwn(object.accessors??{},property)||object.dataAttributes?.[property]?.writable===false)
              guestFault('TypeError','Super assignment receiver property is not writable data');
            putOwn(object,property,assigned.value,eventId);
            return {...operands(...inputs),...result(assigned.value)};
          }
          if(found.accessor&&found.accessor.get.value[0]!=='undefined'){
            const getter=s.heap[found.accessor.get.value[1]];
            if(getter?.kind!=='function'||getter.async)throw new TypeError('Super getter requires a synchronous owned continuation');
            const id=this.newFrame(s,getter.codeId,getter.closureEnvId,f.id,null,[],this.functionThis(getter,receiver),getter.id);
            f.pendingProperty={kind:'get',receiver,method:op==='SUPER_GET_METHOD',waitingFrameId:id};s.control.a0.activeFrameId=id;
            return {...operands(...inputs),causes:[{kind:'invocation',frameId:id}]};
          }
          const value=found.slot?.value??U;
          return {...operands(...inputs),...result(op==='SUPER_GET_METHOD'?['method',value,receiver]:value)};
        }
        case 'SUPER_CONSTRUCTOR':{
          const owner=f.thisBindingFrameId?s.frames[f.thisBindingFrameId]:f;
          if(owner.constructKind!=='derived')throw new Error('Super call has no derived constructor context');
          const parent=s.heap[owner.constructorId].prototype;
          return result(parent==='Function.prototype'?U:['ref',parent]);
        }
        case 'SUPER_CALL':case 'SUPER_FORWARD_CALL':{
          const owner=f.thisBindingFrameId?s.frames[f.thisBindingFrameId]:f;
          if(owner.constructKind!=='derived')throw new Error('Super call has no derived constructor context');
          let args=owner.constructorArguments;
          if(op==='SUPER_CALL'){
            const count=typeof arg==='number'?arg:arg.count,raw=[];for(let i=0;i<count;i++)raw.unshift(pop());
            args=raw.flatMap((value,i)=>arg?.spread?.includes(i)?value.value[1].map(item=>token(item,value.origin)):[value]);
          }
          if(args.length>10000)throw new RangeError('Owned super argument budget exceeded');
          const parent=s.heap[owner.constructorId].prototype;
          const constructor=op==='SUPER_CALL'?pop().value:parent==='Function.prototype'?U:['ref',parent];
          const id=this.beginConstruction(s,constructor,args,f.id,eventId,owner.newTarget);s.control.a0.activeFrameId=id;
          return {operands:[constructor,...args.map(x=>x.value)],origins:[null,...args.map(x=>x.origin)],causes:[{kind:'invocation',frameId:id}]};
        }
        case 'SUPER_BIND':{
          const value=pop(),owner=f.thisBindingFrameId?s.frames[f.thisBindingFrameId]:f;
          if(owner.thisInitialized)guestFault('ReferenceError','Super constructor already initialized this');
          if(!['ref','promise','intrinsic','builtinfn','hostfn'].includes(value.value[0]))throw new Error('Super constructor returned a primitive');
          owner.thisValue=value.value;owner.thisInitialized=true;
          const klass=s.heap[owner.constructorId];
          if(klass.instanceInitializer){
            const initializer=s.heap[klass.instanceInitializer[1]],id=this.newFrame(s,initializer.codeId,initializer.closureEnvId,f.id,null,[],value.value,initializer.id);
            s.frames[id].superInitializedResult=value.value;s.control.a0.activeFrameId=id;
            return {...operands(value),causes:[{kind:'invocation',frameId:id}]};
          }
          return {...operands(value),...result(value.value)};
        }
        case 'CLASS_CREATE':{
          const name=arg.named?pop():null,heritage=arg.derived?pop():null,value=pop(),klass=value.value[0]==='ref'?s.heap[value.value[1]]:null;
          if(klass?.kind!=='function')throw new Error('Class constructor function missing');
          klass.classConstructor=true;
          if(name)this.classFunctionProperties(s,klass,name.value,eventId);
          this.functionProperties(s,klass,eventId,{prototype:true});
          this.setHomeObject(s,klass,klass.properties.prototype.value,eventId);
          klass.dataAttributes.prototype.writable=false;
          if(heritage){
            let parentPrototype=null,parent='Function.prototype';
            if(heritage.value[0]!=='null'){
              if(heritage.value[0]==='intrinsic'&&!['Math','Reflect','Atomics','Object.prototype','Array.prototype','Function.prototype'].includes(heritage.value[1]))
                throw new TypeError('Builtin class heritage requires its owned derived-construction profile');
              const base=heritage.value[0]==='ref'?s.heap[heritage.value[1]]:null;
              if(base?.kind==='proxy')throw new TypeError('Proxy class heritage requires owned constructor internal methods');
              if(base?.kind!=='function'||base.arrow||base.async||base.nonConstructible||this.programs[base.codeId].generator)
                guestFault('TypeError','Class extends value is not an owned constructor or null');
              this.functionProperties(s,base,eventId,{prototype:true});
              const prototype=base.properties.prototype?.value??U;
              if(prototype[0]==='ref'&&['object','array'].includes(s.heap[prototype[1]]?.kind))parentPrototype=prototype[1];
              else if(prototype[0]==='intrinsic'&&['Object.prototype','Array.prototype','Function.prototype'].includes(prototype[1]))parentPrototype=prototype[1];
              else if(['ref','promise','intrinsic','builtinfn','hostfn'].includes(prototype[0]))throw new TypeError('Exotic class heritage prototype requires a separate profile');
              else if(prototype[0]!=='null')guestFault('TypeError','Class extends constructor has an invalid prototype');
              parent=base.id;
            }
            klass.derivedConstructor=true;klass.prototype=parent;
            s.heap[klass.properties.prototype.value[1]].prototype=parentPrototype;
          }
          const environment=s.envs[f.envId];
          [...new Set(arg.privateNames)].forEach((name,index)=>{
            environment.bindings['[[private '+name+']]']={kind:'const',initialized:true,
              token:token(['str','private:'+klass.id+':'+index],eventId),version:0};
          });
          return {...operands(value,...(heritage?[heritage]:[]),...(name?[name]:[])),...result(value.value)};
        }
        case 'CLASS_INITIALIZER':{
          const initializer=pop(),value=pop(),klass=s.heap[value.value[1]];
          if(klass?.classConstructor!==true||!this.callableGuest(s,initializer.value))
            throw new Error('Invalid owned class initializer');
          klass[arg.static?'staticInitializer':'instanceInitializer']=initializer.value;
          return {...operands(value,initializer),...result(value.value)};
        }
        case 'CLASS_FINISH':{
          const value=pop(),klass=s.heap[value.value[1]];
          if(klass?.classConstructor!==true)throw new Error('Invalid owned class completion');
          if(arg.name){
            const binding=lookup(s,f.envId,arg.name).cell;
            if(binding.initialized)throw new Error('Class inner name initialized twice');
            binding.initialized=true;binding.token=value;binding.version++;
          }
          if(klass.staticInitializer){
            const initializer=s.heap[klass.staticInitializer[1]],id=this.newFrame(s,initializer.codeId,initializer.closureEnvId,f.id,null,[],value.value,initializer.id);
            s.frames[id].classStaticResult=value.value;s.control.a0.activeFrameId=id;
            return {...operands(value),causes:[{kind:'invocation',frameId:id}]};
          }
          return {...operands(value),...result(value.value)};
        }
        case 'PRIVATE_GET':case 'PRIVATE_GET_METHOD':case 'PRIVATE_HAS':case 'PRIVATE_DEFINE':case 'PRIVATE_SET':case 'PRIVATE_UPDATE':{
          const supplied=['PRIVATE_DEFINE','PRIVATE_SET'].includes(op)?pop():null,base=pop();
          const binding=lookup(s,f.envId,'[[private '+arg.name+']]').cell;
          if(!binding.initialized||binding.token?.value?.[0]!=='str')throw new Error('Missing lexical private name');
          const key=binding.token.value[1],object=base.value[0]==='ref'?s.heap[base.value[1]]:null;
          if(!object&&op==='PRIVATE_DEFINE'&&['promise','intrinsic','builtinfn','hostfn'].includes(base.value[0]))
            throw new TypeError('Private initialization on an exotic result requires its owned slot profile');
          if(!object&&op==='PRIVATE_HAS'&&['promise','intrinsic','builtinfn','hostfn'].includes(base.value[0]))
            return {...operands(base),...result(['bool',false])};
          if(!object)guestFault('TypeError','Private member receiver is not an object');
          const present=Object.hasOwn(object.privateSlots??{},key);
          if(op==='PRIVATE_HAS')return {...operands(base),...result(['bool',present])};
          if(op==='PRIVATE_DEFINE'){
            if(present)guestFault('TypeError','Private member is already initialized');
            object.privateSlots??={};object.privateKinds??={};object.privateVersions??={};
            object.privateSlots[key]=token(supplied.value,eventId);object.privateKinds[key]=arg.kind;object.privateVersions[key]=1;
            return {...operands(base,supplied),...result(supplied.value)};
          }
          if(!present)guestFault('TypeError','Receiver does not have this private member');
          const old=object.privateSlots[key],read={kind:'private',objectId:object.id,key,
            version:object.privateVersions[key],value:old.value,supplyingEvent:old.origin??null};
          if(['PRIVATE_GET','PRIVATE_GET_METHOD'].includes(op))
            return {...operands(base),...result(op==='PRIVATE_GET_METHOD'?['method',old.value,base.value]:old.value),reads:[read]};
          if(object.privateKinds[key]!=='field')guestFault('TypeError','Private method is not writable');
          const updated=op==='PRIVATE_UPDATE'?scalarUpdate(old.value,arg.operator):null;
          const value=supplied?.value??updated.next;
          object.privateSlots[key]=token(value,eventId);object.privateVersions[key]++;
          return {...operands(base,...(supplied?[supplied]:[])),...result(updated&&!arg.prefix?updated.oldNumeric:value),reads:[read]};
        }
        case 'DEFINE_LITERAL_PROP':{
          const value=pop(),key=pop(),base=pop(),name=valueKey(key.value);
          const obj=base.value[0]==='ref'?s.heap[base.value[1]]:null;
          if(!['object','array','function'].includes(obj?.kind))throw new TypeError('Literal definitions require an owned ordinary object');
          if(obj.kind==='function')this.functionProperties(s,obj,eventId,{prototype:name==='prototype'});
          if(arg.kind!=='prototype'&&(obj.dataAttributes?.[name]?.configurable===false||obj.accessors?.[name]?.configurable===false))
            guestFault('TypeError','Cannot redefine non-configurable property');
          if(obj.kind==='array'&&name==='length')guestFault('TypeError','Cannot redefine non-configurable array length');
          if(arg.kind==='prototype'){
            if(value.value[0]==='null')obj.prototype=null;
            else if(value.value[0]==='ref'){
              if(!['object','array'].includes(s.heap[value.value[1]]?.kind))
                throw new TypeError('Literal prototype is outside the ordinary object profile');
              obj.prototype=value.value[1];
            }
          }else if(arg.kind==='init'){
            // Object literal definitions never call a pre-existing setter.
            putOwn(obj,name,value.value,eventId,{literal:true});
            if(obj.accessors)delete obj.accessors[name];
            if(arg.enumerable!==undefined||obj.dataAttributes?.[name]){
              obj.dataAttributes??={};Object.defineProperty(obj.dataAttributes,name,{value:
                {enumerable:arg.enumerable??true,writable:true,configurable:true},
                enumerable:true,configurable:true,writable:true});
            }
          }else if(['get','set'].includes(arg.kind)){
            if(!this.callableGuest(s,value.value))throw new TypeError('Literal accessor must be an owned function');
            const previous=Object.hasOwn(obj.accessors??{},name)?obj.accessors[name]:undefined;
            if(!previous&&!Object.hasOwn(obj.properties,name))
              (obj.propertyOrder??=Object.keys(obj.properties).concat(Object.keys(obj.accessors??{}))).push(name);
            obj.accessors??={};
            Object.defineProperty(obj.accessors,name,{value:
              {get:previous?.get??token(U),set:previous?.set??token(U),
                [arg.kind]:value,enumerable:arg.enumerable??true,configurable:true},
              enumerable:true,configurable:true,writable:true});
            delete obj.properties[name];
            if(obj.dataAttributes)delete obj.dataAttributes[name];
            Object.defineProperty(obj.propertyVersions,name,{value:
              (Object.hasOwn(obj.propertyVersions,name)?obj.propertyVersions[name]:0)+1,
              enumerable:true,configurable:true,writable:true});obj.shapeVersion++;
          }else throw new TypeError('Unknown literal property kind');
          return {...operands(base,key,value),...result(value.value)};
        }
        case 'PUT_PROP':{
          const v=pop(),key=pop(),base=pop();
          if(['null','undefined'].includes(base.value[0]))
             guestFault('TypeError',`Cannot set properties of ${base.value[0]}`);
          const property=valueKey(key.value);
          if(base.value[0]==='intrinsic'&&base.value[1]==='globalThis')
            throw new TypeError('Global object mutation requires owned global property storage');
          const object=ownedObjectStorage(s,base.value);
          if(!object)throw new TypeError('Not a writable guest object');
          if(object.kind==='iterator'&&property===symbolPropertyKey('well-known:toStringTag')&&
             !Object.hasOwn(object.properties,property)){
            if(this.programs[f.codeId].strict)guestFault('TypeError','Cannot assign inherited readonly iterator property');
            return {...operands(base,key,v),...result(v.value)};
          }
          if(object.kind==='function'||object.kind==='generator'){
            if(object.kind==='function'){
              if(['arguments','caller'].includes(property)||['name','length'].includes(property)&&!Object.hasOwn(object.properties??{},property))throw new TypeError('Function descriptor assignment outside profile');
              this.functionProperties(s,object,eventId);
            }
            const found=functionProperty(s.heap,object,property);
            if(found.attributes?.writable===false)guestFault('TypeError','Cannot assign inherited readonly function property');
            const accessor=found.accessor;
            if(accessor){
              if(accessor.set.value[0]==='undefined')guestFault('TypeError','Cannot assign to getter only property');
              const setter=s.heap[accessor.set.value[1]];
              if(setter?.kind!=='function'||setter.async)throw new TypeError('Unsupported function setter continuation');
              const id=this.newFrame(s,setter.codeId,setter.closureEnvId,f.id,null,[v],this.functionThis(setter,base.value),setter.id);
              f.pendingProperty={kind:'set',value:v.value,waitingFrameId:id};s.control.a0.activeFrameId=id;
              return {...operands(base,key,v),causes:[{kind:'invocation',frameId:id}]};
            }
            if(object.kind==='function'&&property==='prototype')object.prototypeInitialized=true;
            putOwn(object,property,v.value,eventId);return {...operands(base,key,v),...result(v.value)};
          }
          if(isOwnedTypedView(object)){
  const index=binaryNumericKey(property);
  if(index===undefined)throw new BinaryProfileError('Typed-array ordinary property assignment needs its own profile');
  const converted=binaryGuest(()=>binaryElement(v.value,SHARED_TYPES[object.elementType]));
  if(binaryValidIndex(index,effectiveSharedLength(s.heap[object.bufferId],object)))
    writeSharedElement(s.heap[object.bufferId],object,index,encode(converted));
  return {...operands(base,key,v),...result(v.value)};
}
if(object.kind==='regexp'){
            if(property!=='lastIndex'||v.value[0]!=='num' ||
               !Number.isSafeInteger(decode(v.value)) ||
               decode(v.value)<0 || decode(v.value)>10001)
              throw new TypeError('Only bounded RegExp.lastIndex writes are owned');
            putOwn(object,'lastIndex',v.value,eventId);
            return {...operands(base,key,v),...result(v.value)};
          }
          if(isOwnedBuffer(object)||isOwnedTypedView(object)||isOwnedDataView(object))
            throw new BinaryProfileError('Binary-memory ordinary property assignment needs its own profile');
          if(object.kind==='set')
            throw new TypeError('Owned intrinsic internal slots are not guest-writable properties');
          const route=object.kind==='proxy'?proxyRoute(s.heap,base.value,'set'):
            {kind:'ordinary',target:base.value,receiver:base.value};
          if(route.kind==='trap'){
            const target=s.heap[route.target[1]];
            if(!['object','array'].includes(target?.kind))
              throw new TypeError('Proxy trap target invariants require ordinary storage');
            if(!this.callableGuest(s,route.method)||s.heap[route.method[1]].async)
              throw new TypeError('Proxy set trap must be synchronous guest function');
            const fn=s.heap[route.method[1]];
            const id=this.newFrame(s,fn.codeId,fn.closureEnvId,
              f.id,null,[token(route.target),key,v,token(base.value)],this.functionThis(fn,route.handler),fn.id);
            f.pendingProperty={kind:'set',value:v.value,waitingFrameId:id,
              proxy:{target:route.target,key:property,strict:!!this.programs[f.codeId].strict}};
            s.control.a0.activeFrameId=id;
            return {...operands(base,key,v),causes:[{kind:'invocation',frameId:id}],
              reads:[route.observation]};
          }
          const obj=ownedObjectStorage(s,route.target),heap=ownedObjectHeap(s);
          const described=['object','array','promise'].includes(obj.kind)?functionProperty(heap,obj,property):null,
            accessor=described?.accessor??propertyAccessor(heap,route.target,property);
          if(accessor){
            const setter=accessor.set.value;
            if(setter[0]==='undefined'){
              if(this.programs[f.codeId].strict){
                // OrdinarySet returns false for an own or inherited accessor
                // without a setter. PutValue turns that failure into a guest
                // TypeError in strict code; it must not yield the RHS to an
                // enclosing assignment before catch/finally have run.
                const receiverKind=obj.kind==='array'?'[object Array]':
                  objectPrototype(obj)===null?'[object Object]':'#<Object>';
                guestFault('TypeError',`Cannot set property ${property} of ${receiverKind} which has only a getter`);
              }
              return {...operands(base,key,v),...result(v.value)};
            }
            if(!this.callableGuest(s,setter)||s.heap[setter[1]].async)
              throw new TypeError('Unsupported accessor setter continuation');
            const target=s.heap[setter[1]];
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,null,[v],this.functionThis(target,base.value),target.id);
            f.pendingProperty={kind:'set',value:v.value,waitingFrameId:id};
            s.control.a0.activeFrameId=id;
            return {...operands(base,key,v),causes:[{kind:'invocation',frameId:id}]};
          }
          const failure=ordinaryDataWriteFailure(s.heap,obj,property,described?.attributes);
          if(failure){
            if(this.programs[f.codeId].strict)guestFault('TypeError',failure);
            return {...operands(base,key,v),...result(v.value)};
          }
          if(this.entrySpec?.kind==='function' && obj.kind==='array') {
            const oldLength=decode(obj.properties.length.value);
            // Array length growth and out-of-range writes create actual
            // absent slots, never invented `undefined` properties. Enforce a
            // bounded heap budget while retaining ECMAScript hole semantics.
            if(arrayIndex(property) && Number(property)>10000)
              throw new RangeError('Owned sparse array index budget exceeded');
            if(property==='length' && v.value[0]==='num' &&
               decode(v.value)>10000)
              throw new RangeError('Owned array length budget exceeded');
          }
          obj.propertyVersions ??= {};
          obj.shapeVersion ??= 0;
          putOwn(obj,property,v.value,eventId);
          return {...operands(base,key,v),...result(v.value)};
        }
        case 'CALL':{
          const count=typeof arg==='number'?arg:arg.count;
          const raw=[];for(let i=0;i<count;i++)raw.unshift(pop());
          let args=[];
          for(let i=0;i<raw.length;i++){
            if(!arg?.spread?.includes(i)){args.push(raw[i]);continue;}
            const value=raw[i].value;
            if(value[0]!=='spread'||!Array.isArray(value[1]))
              throw new Error('Call spread lacks its evaluated snapshot');
            for(const member of value[1])args.push(token(member,raw[i].origin));
          }
          if(args.length>10000)throw new RangeError('Owned call argument budget exceeded');
          const fn=pop(),sourceCallArgs=args;let callable=fn.value;
          let adapterReads=[];
          let receiver=callable[0]==='method'?callable[2]:U;
          if(callable[0]==='method')callable=callable[1];
          // Builtin targets use the same dispatcher after Call/Apply has
          // selected the receiver and arguments. Guest functions keep their
          // existing owned frame path below.
          if(callable[0]==='builtinfn'&&['Function.prototype.call','Function.prototype.apply','Reflect.apply'].includes(callable[1])){
            const reflect=callable[1]==='Reflect.apply',target=reflect?args[0]?.value??U:receiver;
            if(target[0]==='builtinfn'&&['Object.prototype.hasOwnProperty','Object.hasOwn'].includes(target[1])){
              const selectedReceiver=args[reflect?1:0]?.value??U,
                selected=callable[1]==='Function.prototype.call'?{values:args.slice(1),reads:[]}:
                  callArgumentList(ownedObjectHeap(s),args[reflect?2:1]?.value??U,{nullable:!reflect});
              callable=target;receiver=selectedReceiver;args=selected.values;adapterReads=selected.reads;
            }
          }
          if(callable[0]==='builtinfn'&&['Object.prototype.hasOwnProperty','Object.hasOwn'].includes(callable[1])){
            const base=callable[1]==='Object.hasOwn'?args[0]?.value??U:receiver,
              key=valueKey(args[callable[1]==='Object.hasOwn'?1:0]?.value??U);
            if(['undefined','null'].includes(base[0]))guestFault('TypeError','Cannot convert undefined or null to object');
            let present;
            if(base[0]==='intrinsic'&&base[1]==='globalThis')present=ownedGlobalProperty(s,key,this.sources)!==null;
            else if(base[0]==='str')present=key==='length'||arrayIndex(key)&&Number(key)<base[1].length;
            else if(isPrimitiveValue(base))present=false;
            else{
              const object=ownedObjectStorage(s,base);
              if(object?.kind==='module-namespace'){
                if(sourceCallArgs!==args)throw new TypeError('Module namespace reflection through a call adapter requires its own continuation');
                const outcome=this.startModuleNamespaceInspection(s,f,object,'Object.hasOwn',key,eventId);
                if(outcome.child)return {...operands(fn,...sourceCallArgs),causes:[{kind:'invocation',frameId:outcome.child}]};
                return {...operands(fn,...sourceCallArgs),...result(outcome.value)};
              }
              if(!object||!['object','array','function','generator','promise'].includes(object.kind))
                throw new TypeError('Own property reflection requires owned ordinary storage');
              if(object.kind==='function')this.functionProperties(s,object,eventId,{prototype:key==='prototype'});
              present=ownedHasOwnProperty(object,key);
            }
            return {...operands(fn,...sourceCallArgs),reads:adapterReads,...result(['bool',present])};
          }
          if(callable[0]==='builtinfn'&&
             callable[1]==='__traced_eval_create_module_namespace'){
            const sourceId=f.codeId.slice(0,f.codeId.indexOf(':')),
              allowed=this.sources.some(source=>source.sourceId===sourceId&&
                source.moduleNamespaceIntrinsic===true);
            if(!allowed||args.length!==1)
              guestFault('TypeError','Module namespace constructor is reserved for linked module entries');
            const listValue=args[0].value,list=listValue[0]==='ref'?s.heap[listValue[1]]:null;
            if(list?.kind!=='array'||Object.keys(list.accessors??{}).length)
              throw new TypeError('Module namespace entries must be an owned dense array');
            const length=decode(list.properties.length?.value??U),names=[],accessors={};
            if(!Number.isSafeInteger(length)||length<0||length>10000)
              throw new TypeError('Module namespace export count is outside the owned limit');
            for(let index=0;index<length;index++){
              const pairRef=list.properties[String(index)]?.value,
                pair=pairRef?.[0]==='ref'?s.heap[pairRef[1]]:null;
              if(pair?.kind!=='array'||Object.keys(pair.accessors??{}).length||
                 decode(pair.properties.length?.value??U)!==2||
                 !pair.properties['0']||!pair.properties['1'])
                throw new TypeError('Module namespace export entry is malformed');
              const nameValue=pair.properties['0'].value,
                getterValue=pair.properties['1'].value,
                getter=getterValue?.[0]==='ref'?s.heap[getterValue[1]]:null;
              if(nameValue?.[0]!=='str'||!getter||getter.kind!=='function'||
                 getter.async||this.programs[getter.codeId]?.generator)
                throw new TypeError('Module namespace export needs a string name and synchronous owned getter');
              const name=nameValue[1];
              if(names.length&&names.at(-1)>=name)
                throw new TypeError('Module namespace export names must be unique and sorted');
              names.push(name);
              Object.defineProperty(accessors,name,{value:
                {get:token(getterValue,eventId),set:token(U,eventId),
                  enumerable:true,configurable:false},
                enumerable:true,configurable:true,writable:true});
            }
            const tag=symbolPropertyKey('well-known:toStringTag'),id=this.next(s,'obj');
            const namespace=s.heap[id]={id,kind:'module-namespace',prototype:null,
              extensible:false,namespaceExportNames:names,accessors,
              properties:{[tag]:token(['str','Module'],eventId)},
              dataAttributes:{[tag]:{writable:false,enumerable:false,configurable:false}},
              propertyOrder:[...names,tag],propertyVersions:Object.fromEntries(
                [...names,tag].map(name=>[name,1])),shapeVersion:names.length+1,version:0};
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn'&&['Function.prototype.call','Function.prototype.apply','Reflect.apply'].includes(callable[1])){
            const reflect=callable[1]==='Reflect.apply',targetValue=reflect?args[0]?.value??U:receiver,
              thisValue=args[reflect?1:0]?.value??U,
              target=targetValue[0]==='ref'?s.heap[targetValue[1]]:null;
            // Check callability before touching the array-like argument list.
            if(target?.kind!=='function'){
              if(['intrinsic','builtinfn','hostfn'].includes(targetValue[0])||target?.kind==='proxy')
                throw new TypeError('Call adapter requires an owned function target');
              guestFault('TypeError','Call adapter target is not callable');
            }
            const list=callable[1]==='Function.prototype.call'?{values:args.slice(1),reads:[]}:
              callArgumentList(s.heap,args[reflect?2:1]?.value??U,{nullable:!reflect});
            const promiseId=target.async?this.newPromise(s):null,
              id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,list.values,
                this.functionThis(target,thisValue),target.id);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),result:targetValue,reads:list.reads,causes:[{kind:'invocation',frameId:id}]};
          }
          if(callable[0]==='builtinfn'&&callable[1]==='Function.prototype.hasInstance')
            return {...operands(fn,...args),...result(['bool',this.ordinaryHasInstance(s,receiver,args[0]?.value??U,eventId)])};
          if(callable[0]==='builtinfn'&&receiver[0]==='ref'&&s.heap[receiver[1]]?.extensible===false&&
             ['push','pop','shift','unshift','splice'].some(method=>callable[1]==='Array.prototype.'+method))
            guestFault('TypeError','Cannot mutate frozen template array');
          if(callable[0]==='builtinfn'&&callable[1]==='Array.prototype.sort'&&receiver[0]==='ref'&&s.heap[receiver[1]]?.extensible===false)
            throw new TypeError('Sorting a frozen array requires ordered readonly write completions');
          if(callable[0]==='builtinfn'&&callable[1].startsWith('Generator.')){
            const generator=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(generator?.kind!=='generator')guestFault('TypeError','Generator receiver has no owned continuation');
            const method=callable[1].slice('Generator.'.length),sent=args[0]??token(U,eventId);
            if(method==='identity')return {...operands(fn,...args),...result(receiver)};
            if(['initializing','executing'].includes(generator.state))guestFault('TypeError','Generator is already running');
            const target=s.frames[generator.frameId],initial=generator.state==='suspendedStart';
            if(generator.state==='completed'||initial&&method!=='next'){
              generator.state='completed';target.status='completed';
              if(method==='throw'){
                const completion={type:'throw',value:sent};
                this.routeCompletion(s,f,completion,eventId);return {...operands(fn,...args),completion};
              }
              return {...operands(fn,...args),...result(this.iteratorResult(s,method==='return'?sent.value:U,true,eventId))};
            }
            if(!['suspendedStart','suspendedYield'].includes(generator.state))throw new Error('Invalid generator suspension state');
            generator.state='executing';target.status='running';target.callerFrameId=f.id;delete target.completion;
            s.control.a0.activeFrameId=target.id;
            const completion=method==='return'?{type:'return',value:sent}:method==='throw'?{type:'throw',value:sent}:null;
            const delegated=target.delegateYield===true;
            if(delegated){target.delegateResume={kind:method,value:sent};delete target.delegateYield;}
            else if(completion)this.routeCompletion(s,target,completion,eventId);
            else if(!initial)this.stackPush(target,sent.value,eventId);
            if(method==='return'&&s.control.a0.activeFrameId===f.id&&target.status==='completed')
              return {...operands(fn,...args),result:f.stack.at(-1).value};
            return {...operands(fn,...args),causes:[{kind:'invocation',frameId:target.id}],
              ...(method==='throw'&&!delegated?{completion}:{})};
          }
          if(callable[0]==='builtinfn'&&['Array.prototype.values','Array.prototype.keys','Array.prototype.entries','String.prototype.iterator'].includes(callable[1])){
            const string=callable[1]==='String.prototype.iterator';
            if(string?receiver[0]!=='str':receiver[0]!=='ref'||s.heap[receiver[1]]?.kind!=='array')
              guestFault('TypeError','Iterator method requires its owned receiver');
            const id=this.next(s,'obj');
            s.heap[id]={id,kind:'iterator',iterated:copy(receiver),nextIndex:0,done:false,
              iterationKind:string?'string':callable[1].slice('Array.prototype.'.length),
              properties:{},propertyVersions:{},shapeVersion:0,version:0};
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn'&&['Iterator.next','Iterator.identity'].includes(callable[1])){
            const iterator=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(callable[1]==='Iterator.identity')return {...operands(fn,...args),...result(receiver)};
            if(iterator?.kind!=='iterator')guestFault('TypeError','Iterator receiver has no owned state');
            let value=U;
            if(!iterator.done){
              const index=iterator.nextIndex;
              if(index>10000)throw new RangeError('Owned iterator step budget');
              if(iterator.iterationKind==='string'){
                const text=iterator.iterated[1];
                if(index>=text.length)iterator.done=true;
                else{
                  const code=text.charCodeAt(index),next=text.charCodeAt(index+1),width=
                    code>=0xd800&&code<=0xdbff&&next>=0xdc00&&next<=0xdfff?2:1;
                  value=['str',text.slice(index,index+width)];iterator.nextIndex+=width;
                }
              }else{
                const array=s.heap[iterator.iterated[1]],length=decode(array.properties.length.value);
                if(index>=length)iterator.done=true;
                else{
                  iterator.nextIndex++;
                  if(iterator.iterationKind==='keys')value=['num',index];
                  else{
                    const property=ordinaryGet(s.heap,iterator.iterated,String(index));
                    if(!property)throw new TypeError('Builtin iterator index getter requires an owned continuation');
                    value=property.method.value;
                    if(iterator.iterationKind==='entries'){
                      const pair=this.next(s,'obj');s.heap[pair]={id:pair,kind:'array',properties:{
                        0:token(['num',index],eventId),1:token(value,eventId),length:token(['num',2],eventId)},
                        propertyVersions:{0:1,1:1,length:1},shapeVersion:3,version:0};value=['ref',pair];
                    }
                  }
                }
              }
            }
            const id=this.next(s,'obj');s.heap[id]={id,kind:'object',properties:{
              value:token(value,eventId),done:token(['bool',iterator.done],eventId)},
              propertyVersions:{value:1,done:1},shapeVersion:2,version:0};
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='intrinsic'&&callable[1]==='Symbol'){
            const value=args[0]?.value??U;
            if(value[0]==='symbol')guestFault('TypeError','Cannot convert a Symbol value to a string');
            if(!['undefined','null','bool','str','num','bigint'].includes(value[0]))
              throw new TypeError('Symbol description requires owned scalar coercion');
            const description=value[0]==='undefined'?U:['str',String(decode(value))];
            return {...operands(fn,...args),...result(this.newSymbol(s,description,eventId))};
          }
          if(callable[0]==='builtinfn'&&['Symbol.for','Symbol.keyFor'].includes(callable[1])){
            const value=args[0]?.value??U;
            if(callable[1]==='Symbol.keyFor'){
              if(value[0]!=='symbol')guestFault('TypeError','Symbol.keyFor requires a symbol');
              const symbol=s.heap[value[1]];
              return {...operands(fn,...args),...result(symbol?.registeredKey===undefined?U:['str',symbol.registeredKey])};
            }
            if(value[0]==='symbol')guestFault('TypeError','Cannot convert a Symbol value to a string');
            if(!['undefined','null','bool','str','num','bigint'].includes(value[0]))
              throw new TypeError('Symbol registry key requires owned scalar coercion');
            const key=String(decode(value)),existing=Object.values(s.heap).find(entity=>entity.kind==='symbol'&&entity.registeredKey===key);
            return {...operands(fn,...args),...result(existing?['symbol',existing.id]:this.newSymbol(s,['str',key],eventId,key))};
          }
          if(callable[0]==='builtinfn'&&callable[1].startsWith('Symbol.prototype.')){
            if(receiver[0]!=='symbol')guestFault('TypeError','Symbol method requires a symbol receiver');
            const description=this.symbolDescription(s,receiver);
            return {...operands(fn,...args),...result(callable[1]==='Symbol.prototype.valueOf'?receiver:
              ['str','Symbol('+(description[0]==='undefined'?'':description[1])+')'])};
          }
          if(callable[0]==='intrinsic'&&['Number','BigInt','String'].includes(callable[1])){
            const value=args[0]?.value??U;
            if(callable[1]==='Number'&&value[0]==='ref'){
              if(!['object','array'].includes(s.heap[value[1]]?.kind))
                throw new TypeError('Number object conversion requires an owned ordinary object');
              if(f.pendingNumberConversion)throw new Error('Number conversion already active in this frame');
              f.pendingNumberConversion=createNumberConversion(value,inst.siteId);
              return {...operands(fn,...args),...this.advanceNumberConversion(s,f,eventId)};
            }
            if(value[0]==='symbol'){
              if(callable[1]!=='String')guestFault('TypeError','Cannot convert a Symbol value to a number');
              const description=this.symbolDescription(s,value);
              return {...operands(fn,...args),...result(['str','Symbol('+(description[0]==='undefined'?'':description[1])+')'])};
            }
            // An explicit primitive-only intrinsic leaf. CALL has already
            // evaluated every argument in order; unused extra arguments are
            // not coerced. Owned objects require a separate continuation and
            // must not reach native ToPrimitive or become catchable refusals.
            if(!['undefined','null','bool','str','num','bigint'].includes(value[0]))
              throw new TypeError(callable[1]+' conversion requires a primitive; owned object conversion is outside the bounded scalar profile');
            if(['str','bigint'].includes(value[0])&&value[1].length>10000)
              throw new RangeError('Primitive conversion input exceeds the bounded scalar budget');
            let converted;
            try{converted=callable[1]==='Number'?(args.length?Number(decode(value)):0):
              callable[1]==='String'?(args.length?String(decode(value)):''):BigInt(decode(value));}
            catch(error){
              // Only the scalar intrinsic can throw here. Preserve its real
              // language exception for catch/finally/replay and the oracle.
              guestFault(error.name,error.message);
            }
            return {...operands(fn,...args),...result(encode(converted))};
          }
          if(callable[0]==='builtinfn'&&callable[1].startsWith('Object.')&&
             callable[1]!=='Object.is'&&args.some(item=>item.value[0]==='ref'&&s.heap[item.value[1]]?.declaredError))
            throw new TypeError('Object descriptor and prototype operations on declared errors are outside the bounded error profile');
          if(callable[0]==='intrinsic'&&callable[1]==='Promise')
             guestFault('TypeError','Promise must be constructed with new');
          if(callable[0]==='builtinfn'&&/^Promise[.](resolve|reject|all|race|allSettled|any|withResolvers)$/.test(callable[1])&&
             !ownedSameValue(receiver,['intrinsic','Promise'])){
            if(primitiveUnary('typeof',receiver,s.heap)[1]!=='function')
              guestFault('TypeError','Promise static method requires a constructor receiver');
            throw new TypeError('Custom Promise constructor receiver requires its owned capability construction');
          }
           if(callable[0]==='builtinfn' &&
              /^Promise[.]executor[.](resolve|reject):p[0-9]+$/.test(callable[1])){
             const [,mode,pid]=callable[1].match(/^Promise[.]executor[.](resolve|reject):(p[0-9]+)$/);
             const promise=s.promises[pid];
             if(!promise)throw new Error('Unknown Promise capability');
             if(!promise.resolverCalled){
               promise.resolverCalled=true;
               if(promise.status==='pending'){
                 const value=args[0]?.value??U,origin=args[0]?.origin??eventId;
                 if(mode==='resolve')this.resolvePromise(s,pid,value,origin);
                 else this.rejectPromise(s,pid,value,origin);
               }
             }
             return {...operands(fn,...args),...result(U)};
           }
           if(callable[0]==='builtinfn'&&
  /^Promise[.]thenable[.](resolve|reject):(p[0-9]+):([0-9]+)$/.test(callable[1])){
  const [,mode,pid,serial]=callable[1].match(/^Promise[.]thenable[.](resolve|reject):(p[0-9]+):([0-9]+)$/);
  const p=s.promises[pid];
  if(!p)throw new Error('Unknown thenable promise capability');
  if(p.status==='pending'&&p.thenableSerial===Number(serial)&&!p.thenableLocked){
    p.thenableLocked=true;
    const value=args[0]?.value??U,origin=args[0]?.origin??eventId;
    if(mode==='resolve')this.resolvePromise(s,pid,value,origin);
    else this.rejectPromise(s,pid,value,origin);
  }
  return {...operands(fn,...args),...result(U)};
}
if(callable[0]==='builtinfn' && callable[1]==='queueMicrotask'){
            if(args.length!==1||!this.callableGuest(s,args[0]?.value))
              guestFault('TypeError','queueMicrotask requires one owned callable');
            if(s.control.a0.queue.filter(x=>x.kind==='microtask').length>=256)
              throw new RangeError('Owned microtask queue budget exceeded');
            s.control.a0.queue.push({kind:'microtask',functionId:args[0].value[1]});
            return {...operands(fn,...args),...result(U)};
          }
          if(callable[0]==='builtinfn' && ['setTimeout','clearTimeout','setInterval','clearInterval'].includes(callable[1])){
            const name=callable[1],c=s.control.a0;
            if(name==='clearTimeout'||name==='clearInterval'){
              if(args.length!==1 || args[0].value[0]!=='num')
                guestFault('TypeError','Timer cancellation requires an owned numeric id');
              c.timers=c.timers.filter(t=>t.id!==decode(args[0].value));
              return {...operands(fn,...args),...result(U)};
            }
            if(args.length<1||args.length>2||!this.callableGuest(s,args[0]?.value))
              guestFault('TypeError','Virtual timer requires an owned callback');
            const delay=args[1]?.value??['num',0];
            if(delay[0]!=='num'||!Number.isFinite(decode(delay))||
               decode(delay)<0||decode(delay)>10000)
              guestFault('TypeError','Virtual timer delay must be a bounded nonnegative number');
            if(c.timers.length>=128||c.nextTimerId>=1024)
              throw new RangeError('Virtual timer allocation budget exceeded');
            const id=++c.nextTimerId,ms=Math.floor(decode(delay));
            c.timers.push({id,order:id,kind:name==='setInterval'?'interval':'timeout',
              functionId:args[0].value[1],at:c.now+Math.max(ms,name==='setInterval'?1:0),
              delay:Math.max(ms,1)});
            return {...operands(fn,...args),...result(['num',id])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Array.from'){
            const value=args[0]?.value??U;
            const set=value[0]==='ref'?s.heap[value[1]]:null;
            if(set?.kind!=='set'||args.length!==1)
              throw new TypeError('Array.from requires exactly one owned Set argument');
            const length=decode(set.properties['[[Size]]'].value);
            const id=this.next(s,'obj');
            const array=s.heap[id]={id,kind:'array',properties:{
              length:token(['num',length],eventId)},propertyVersions:{length:0},
              shapeVersion:0,version:0};
            for(let i=0;i<length;i++)
              putOwn(array,String(i),set.properties[String(i)].value,eventId);
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn'&&callable[1]==='ArrayBuffer.isView'){
  const node=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
  return {...operands(fn,...args),...result(['bool',isOwnedTypedView(node)||isOwnedDataView(node)])};
}
if(callable[0]==='builtinfn'&&callable[1]==='ArrayBuffer.prototype.slice'){
  const b=receiver[0]==='ref'?s.heap[receiver[1]]:null;
  if(b?.kind!=='array-buffer')guestFault('TypeError','Invalid ArrayBuffer slice receiver');
  const clip=n=>n<0?Math.max(0,b.byteLength+n):Math.min(b.byteLength,n);
  const begin=clip(binaryGuest(()=>binaryInteger(args[0]?.value)));
  const end=args[1]?.value[0]===undefined||args[1].value[0]==='undefined'?b.byteLength:
    clip(binaryGuest(()=>binaryInteger(args[1].value)));
  const id=this.next(s,'obj'),length=Math.max(0,end-begin),out=newArrayBuffer(id,length);
  out.bytes=b.bytes.slice(begin,begin+length);s.heap[id]=out;
  return {...operands(fn,...args),...result(['ref',id])};
}
if(callable[0]==='builtinfn'&&callable[1].startsWith('DataView.prototype.')){
  const view=receiver[0]==='ref'?s.heap[receiver[1]]:null;
  if(!isOwnedDataView(view))
    guestFault('TypeError','Invalid owned DataView receiver');
  const method=callable[1].slice('DataView.prototype.'.length);
  const getter=DATA_VIEW_GETTERS.includes(method),setter=DATA_VIEW_SETTERS.includes(method);
  if(!getter&&!setter)throw new Error('Invalid DataView method');
  const min=setter?2:1;
  const offset=binaryGuest(()=>binaryIndex(args[0]?.value));
  const width=SHARED_TYPES[method.slice(3)+'Array'].bytes;
  const length=effectiveDataViewLength(s.heap[view.bufferId],view);
  // SetViewValue converts the value before checking the view bounds.
  const converted=setter?binaryGuest(()=>binaryElement(args[1]?.value??U,SHARED_TYPES[method.slice(3)+'Array'])):null;
  if(offset+width>length)guestFault('RangeError','Owned DataView byte index out of bounds');
  const littleEndian=truthy(args[min]?.value??['bool',false]);
  if(setter){
    writeSharedDataView(s.heap[view.bufferId],view,method,offset,encode(converted),littleEndian);
    return {...operands(fn,...args),...result(U)};
  }
  return {...operands(fn,...args),
    ...result(readSharedDataView(s.heap[view.bufferId],view,method,offset,littleEndian))};
}
if(callable[0]==='builtinfn'&&callable[1]==='TypedArray.prototype.subarray'){
  const view=receiver[0]==='ref'?s.heap[receiver[1]]:null;
  if(!isOwnedTypedView(view))guestFault('TypeError','Invalid subarray receiver');
  const full=effectiveSharedLength(s.heap[view.bufferId],view);
  const clip=(n,otherwise)=>n===undefined?otherwise:
    n<0?Math.max(0,full+Math.trunc(n)):Math.min(full,Math.trunc(n));
  const a=clip(binaryGuest(()=>binaryInteger(args[0]?.value)),0);
  const b=args[1]?.value[0]===undefined||args[1].value[0]==='undefined'?full:clip(binaryGuest(()=>binaryInteger(args[1].value)),full);
  const id=this.next(s,'obj');
  s.heap[id]=newSharedView(id,s.heap[view.bufferId],view.elementType,
    view.byteOffset+a*SHARED_TYPES[view.elementType].bytes,
    (args[1]?.value[0]===undefined||args[1].value[0]==='undefined')&&view.lengthTracking?undefined:Math.max(0,b-a));
  return {...operands(fn,...args),...result(['ref',id])};
}
if(callable[0]==='builtinfn'&&callable[1]==='SharedArrayBuffer.prototype.grow'){
  const b=receiver[0]==='ref'?s.heap[receiver[1]]:null;
  if(args.length!==1||b?.kind!=='shared-int32-buffer')
    guestFault('TypeError','Invalid SAB grow receiver/arity');
  if(!b.growable)guestFault('TypeError','SAB is not growable');
  const length=args[0]?.value[0]==='num'?decode(args[0].value):NaN;
  if(!Number.isSafeInteger(length)||length<b.byteLength||
     length>b.maxByteLength)guestFault('RangeError','Invalid SAB growth');
  growSharedBuffer(b,length);
  return {...operands(fn,...args),...result(U)};
}
if(callable[0]==='builtinfn'&&callable[1]==='SharedArrayBuffer.prototype.slice'){
  const b=receiver[0]==='ref'?s.heap[receiver[1]]:null;
  if(b?.kind!=='shared-int32-buffer'||args.length>2)guestFault('TypeError','Invalid SAB slice call');
  const read=(arg,fallback)=>arg?.value[0]==='num'?Math.trunc(decode(arg.value)):fallback;
  const clip=n=>n<0?Math.max(0,b.byteLength+n):Math.min(b.byteLength,n);
  const a=clip(read(args[0],0)),end=clip(read(args[1],b.byteLength));
  const id=this.next(s,'obj'),len=Math.max(0,end-a),out=newSharedBuffer(id,len);
  out.bytes=b.bytes.slice(a,a+len);s.heap[id]=out;
  return {...operands(fn,...args),...result(['ref',id])};
}
if(callable[0]==='builtinfn' && callable[1].startsWith('Set.prototype.')){
            const set=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(set?.kind!=='set')guestFault('TypeError','Set method on incompatible receiver');
            const value=args[0]?.value??U;
            const size=decode(set.properties['[[Size]]'].value);
            const present=Array.from({length:size},(_,i)=>set.properties[String(i)].value)
              .some(v=>ownedSameValue(v,value,true));
            if(callable[1]==='Set.prototype.has')
              return {...operands(fn,...sourceCallArgs),reads:adapterReads,...result(['bool',present])};
            if(callable[1]!=='Set.prototype.add')throw new TypeError('Unsupported Set method');
            if(!present){
              if(size>=10000)throw new RangeError('Set size limit');
              const normalized=value[0]==='num'&&decode(value)===0?['num',0]:value;
              putOwn(set,String(size),normalized,eventId);
              putOwn(set,'[[Size]]',['num',size+1],eventId);
            }
            return {...operands(fn,...args),...result(receiver)};
          }
          if(callable[0]==='intrinsic' && callable[1]==='Array'){
            // Array(length) creates holes, not present undefined slots. The
            // identity is owned, the length is journaled, and indexed writes
            // subsequently fill those holes in the normal mutation path.
            if(args.length>10000)throw new RangeError('Array argument budget');
            const singleLength=args.length===1 && args[0].value[0]==='num';
            const n=singleLength?decode(args[0].value):args.length;
            if(!Number.isInteger(n)||n<0||n>10000)
              throw new RangeError('Array length outside bounded profile');
            const id=this.next(s,'obj');
            const array=s.heap[id]={id,kind:'array',properties:{
              length:token(['num',n],eventId)},propertyVersions:{length:0},
              shapeVersion:0,version:0};
            if(!singleLength)args.forEach((entry,i)=>
              putOwn(array,String(i),entry.value,eventId));
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn'&&['map','filter','slice','splice','concat'].some(method=>callable[1]==='Array.prototype.'+method)){
            const array=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(array?.kind==='array'&&(objectPrototype(array)!=='Array.prototype'||
               Object.hasOwn(array.properties,'constructor')||Object.hasOwn(array.accessors??{},'constructor')))
              throw new TypeError('Array species lookup is outside the default ordinary array profile');
            if(callable[1]==='Array.prototype.concat')for(const input of [receiver,...args.map(arg=>arg.value)]){
              if(input[0]!=='ref'||!['object','array'].includes(s.heap[input[1]]?.kind))continue;
              const hook=ordinaryGet(s.heap,input,symbolPropertyKey('well-known:isConcatSpreadable'));
              if(!hook||hook.method.value[0]!=='undefined')throw new TypeError('Symbol.isConcatSpreadable requires an owned concat protocol');
            }
          }
          if(callable[0]==='ref' && s.heap[callable[1]]?.kind==='function'){
            const target=s.heap[callable[1]],promiseId=target.async?this.newPromise(s):null;
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,args,
              this.functionThis(target,receiver),target.id);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),result:['ref',callable[1]],causes:[{kind:'invocation',frameId:id}]};
          }
          if(callable[0]==='builtinfn' &&
             ['filter','map','reduce','sort','some','every','find','findIndex','forEach'].some(m=>callable[1]==='Array.prototype.'+m)){
            const array=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(!array||array.kind!=='array'||Object.keys(array.accessors??{}).length)
              throw new TypeError('Array callback needs owned array data');
            const length=decode(array.properties.length.value);
            if(!Number.isSafeInteger(length)||length<0||length>10000)
              throw new RangeError('Array callback iteration limit');
            const callback=args[0]?.value??U;
            if(!this.callableGuest(s,callback))
              guestFault('TypeError','Array callback must be a guest function');
            if(s.heap[callback[1]].async)
              throw new TypeError('Async array callback is outside the bounded profile');
            const method=callable[1].slice('Array.prototype.'.length);
            if(args.length>(method==='sort'?1:2))
              throw new TypeError('Array callback argument budget');
            if(method==='sort'&&length>64)
              throw new RangeError('Sort comparator budget exceeded');
            if(method==='reduce' && args.length>2)
              throw new TypeError('Unsupported reduce options');
            const outputId=['filter','map'].includes(method)?this.next(s,'obj'):null;
            if(outputId){s.heap[outputId]={id:outputId,kind:'array',properties:{
              length:token(['num',method==='map'?length:0],eventId)},
              propertyVersions:{length:0},shapeVersion:0,version:0};}
            let start=0,accumulator=U;
            if(method==='reduce'){
              if(args.length>1)accumulator=args[1].value;
              else {
                if(length===0)guestFault('TypeError','Reduce of empty array with no initial value');
                if(![null,'Array.prototype','Object.prototype'].includes(objectPrototype(array)))
                  throw new TypeError('Reduction inherited index semantics outside profile');
                while(start<length&&!Object.hasOwn(array.properties,String(start)))start++;
                if(start===length)guestFault('TypeError','Reduce of empty array with no initial value');
                accumulator=array.properties[String(start)].value;start++;
              }
            }
            f.pendingArrayMethod={method,arrayId:array.id,callbackId:callback[1],
              outputId,length,index:start,accumulator,waitingFrameId:null,
              siteId:inst.siteId,currentValue:U,thisArg:method==='reduce'?U:args[1]?.value??U};
            if(method==='sort'){
              const slots=[];
              for(let i=0;i<length;i++){
                const slot=array.properties[String(i)];
                if(!slot)throw new TypeError('Sparse sort outside bounded profile');
                slots.push(slot.value);
              }
              Object.assign(f.pendingArrayMethod,{buffer:slots,phase:'run-first',
                scan:2,descending:null,originalShapeVersion:array.shapeVersion??0,
                pair:length>=2?[slots[1],slots[0]]:null});
              if(length<2){delete f.pendingArrayMethod;
                return {...operands(fn,...args),...result(receiver)};}
            }
            if(this.advanceArrayCallback(s,f,eventId))
              return {...operands(fn,...args),causes:[{kind:'invocation',frameId:f.pendingArrayMethod.waitingFrameId}]};
            delete f.pendingArrayMethod;
            return {...operands(fn,...args),...result(method==='reduce'?accumulator:
              method==='forEach'||method==='find'?U:method==='findIndex'?['num',-1]:
              method==='some'?['bool',false]:method==='every'?['bool',true]:['ref',outputId])};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Number.prototype.')){
            const method=callable[1].slice('Number.prototype.'.length);
            if(receiver[0]!=='num'||!['toString','toFixed'].includes(method))
              guestFault('TypeError','Number method requires a number receiver');
            if(args.length>1 || args.some(x=>!['undefined','null','bool','str','num'].includes(x.value[0])))
              throw new TypeError('Number formatting argument outside bounded scalar profile');
            const format=args[0]?decode(args[0].value):undefined;
            const number=decode(receiver);
            // Primitive-only deterministic native intrinsic leaf. The result is
            // journaled and independently re-executed in the V8 oracle.
            // No guest object, callback, prototype access or host fallback.
            if(method==='toFixed'&&format!==undefined&&
               (!Number.isFinite(Number(format))||Number(format)<0||Number(format)>100))
              throw new TypeError('Number fixed-digit count outside supported range');
            return {...operands(fn,...args),...result(encode(
              Number.prototype[method].call(number,format)))};
          }
          if(callable[0]==='intrinsic'&&ERROR_CONSTRUCTORS.includes(callable[1]))
            return {...operands(fn,...args),...result(this.newDeclaredError(s,callable[1],args,eventId))};
          if(callable[0]==='builtinfn'&&callable[1]==='print'){
            if(!Array.isArray(s.control.a0.test262Output)||args.length!==1||args[0].value[0]!=='str')
              throw new TypeError('Owned Test262 print requires one string in the script host profile');
            if(s.control.a0.test262Output.length>=10000)throw new RangeError('Owned print budget exceeded');
            s.control.a0.test262Output.push(token(args[0].value,eventId));
            return {...operands(fn,...args),...result(U)};
          }
          if(callable[0]==='builtinfn' && ['parseInt','isNaN'].includes(callable[1])){
            if(callable[1]==='parseInt'){
              if(args.length!==2||args[0].value[0]!=='str'||
                 args[1].value[0]!=='num'||decode(args[1].value)!==10 ||
                 args[0].value[1].length>30||
                 ![...args[0].value[1]].every(c=>c>='0'&&c<='9'))
                throw new TypeError('Owned parseInt needs bounded decimal digits and radix 10');
              return {...operands(fn,...args),...result(encode(parseInt(args[0].value[1],10)))};
            }
            if(args.length!==1||args[0].value[0]!=='num')
              throw new TypeError('Owned isNaN accepts only a scalar number');
            return {...operands(fn,...args),...result(['bool',Number.isNaN(decode(args[0].value))])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='RegExp.prototype.test'){
            const regex=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(regex?.kind!=='regexp'||args.length!==1||args[0].value[0]!=='str')
              throw new TypeError('Owned RegExp test requires a pinned string operation');
            const pattern=decode(regex.properties['[[Source]]'].value);
            const flags=decode(regex.properties['[[Flags]]'].value);
            const lastIndex=decode(regex.properties.lastIndex.value);
            const outcome=testPinnedRegExp(pattern,flags,decode(args[0].value),lastIndex);
            if(flags==='g')putOwn(regex,'lastIndex',['num',outcome.nextIndex],eventId);
            return {...operands(fn,...args),...result(['bool',outcome.matched])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='String.prototype.replace' &&
             args[1]?.value[0]==='ref'){
            const regex=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
            const callback=s.heap[args[1].value[1]];
            if(receiver[0]!=='str'||args.length!==2||regex?.kind!=='regexp'||
               callback?.kind!=='function'||callback.async)
              throw new TypeError('Unsupported RegExp guest callback replacement');
            const pattern=decode(regex.properties['[[Source]]'].value);
            const flags=decode(regex.properties['[[Flags]]'].value);
            const matches=scanPinnedReplacement(pattern,flags,receiver[1]);
            // A global replacement collects matches from zero and finishes
            // matching before invoking callbacks. Callback writes to lastIndex
            // then remain visible to later callbacks and the caller.
            if(regex.dataAttributes?.lastIndex?.writable===false)
              guestFault('TypeError','Cannot assign to read only property');
            if(!Object.is(decode(regex.properties.lastIndex.value),0))
              putOwn(regex,'lastIndex',['num',0],eventId);
            if(!matches.length)return {...operands(fn,...args),...result(receiver)};
            f.pendingStringReplace={text:receiver[1],matches,index:0,lastEnd:0,
              output:'',callbackId:callback.id,waitingFrameId:null,siteId:inst.siteId};
            const child=this.advanceStringReplaceCallback(s,f);
            return {...operands(fn,...args),causes:[{kind:'invocation',frameId:child}]};
          }
          if(callable[0]==='builtinfn' && callable[1]==='String.prototype.replace') {
            if(receiver[0]!=='str'||args.length!==2||receiver[1].length>10000 ||
               args[1].value[0]!=='str'||args[1].value[1]!=='\\$&')
              throw new TypeError('Owned RegExp replacement supports only pinned escape literal');
            const regex=args[0].value[0]==='ref'?s.heap[args[0].value[1]]:null;
            if(regex?.kind!=='regexp'||
               decode(regex.properties['[[Source]]'].value)!==String.raw`[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]` ||
               decode(regex.properties['[[Flags]]'].value)!=='g')
              throw new TypeError('Unsupported RegExp replacement pattern');
            const specials=new Set('\\{}*+?|^$.[]()');
            let output='';
            for(const ch of receiver[1]) output+=(specials.has(ch)?'\\':'')+ch;
            return {...operands(fn,...args),...result(['str',output])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='String.prototype.split') {
            if(receiver[0]!=='str'||args.length!==1||receiver[1].length>10000)
              throw new TypeError('Owned line split requires one bounded string/regex');
            const regex=args[0].value[0]==='ref'?s.heap[args[0].value[1]]:null;
            if(regex?.kind!=='regexp')throw new TypeError('Only owned line RegExp splitting is supported');
            const pattern=decode(regex.properties['[[Source]]'].value);
            if(decode(regex.properties['[[Flags]]'].value)!=='' ||
               !['\\r\\n|\\r|\\n','(\\r\\n|\\r|\\n)'].includes(pattern))
              throw new TypeError('Unmodeled RegExp split pattern');
            const capturing=pattern.startsWith('(');
            const fragments=[],text=receiver[1];let last=0;
            for(let i=0;i<text.length;i++){
              if(text[i]!=='\r'&&text[i]!=='\n')continue;
              const separator=text[i]==='\r'&&text[i+1]==='\n'?'\r\n':text[i];
              fragments.push(text.slice(last,i));
              if(capturing)fragments.push(separator);
              i+=separator.length-1;last=i+1;
              if(fragments.length>10000)throw new RangeError('Owned split result limit');
            }
            fragments.push(text.slice(last));
            const id=this.next(s,'obj');
            const resultArray=s.heap[id]={id,kind:'array',properties:{
              length:token(['num',fragments.length],eventId)},propertyVersions:{length:0},
              shapeVersion:0,version:0};
            fragments.forEach((part,i)=>putOwn(resultArray,String(i),['str',part],eventId));
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('String.prototype.')){
             const method=callable[1].slice('String.prototype.'.length);
             if(receiver[0]!=='str'||!['charAt','charCodeAt','at','substring','substr','slice','indexOf','lastIndexOf','includes','startsWith','endsWith','toLowerCase','toUpperCase','trim','trimStart','trimEnd'].includes(method))
               guestFault('TypeError','String method requires a string receiver');
             if(receiver[1].length>10000||args.length>3)
               throw new RangeError('String operation outside the bounded profile');
             const values=args.map(arg=>{
               if(!['undefined','null','bool','str','num','bigint'].includes(arg.value[0]))
                 throw new TypeError('Unmodeled ToPrimitive in String method');
               return decode(arg.value);
             });
             // Explicit primitive-only intrinsic leaf, with journaled inputs
             // and result. No callback, accessor or arbitrary host fallback.
             const value=String.prototype[method].apply(receiver[1],values);
             if(typeof value==='string'&&value.length>100000)
               throw new RangeError('String result outside the bounded profile');
             return {...operands(fn,...args),...result(encode(value))};
           }
           if(callable[0]==='builtinfn' && callable[1].startsWith('Math.')){
            const method=callable[1].slice('Math.'.length);
            if(method==='random'){
              if(args.length!==0||!Number.isInteger(s.control.a0.randomState))
                throw new TypeError('Math.random requires a seeded zero-argument fixture');
              // The fixture has a versioned, stateful PRNG transition. Both the
              // seed and each resulting scalar are visible in the effective trace.
              const next=(Math.imul(s.control.a0.randomState,1664525)+1013904223)>>>0;
              s.control.a0.randomState=next;
              return {...operands(fn),...result(['num',next/4294967296])};
            }
            const numbers=args.map(a=>{
              if(!['undefined','null','bool','str','num'].includes(a.value[0]))
                guestFault('TypeError','Math numeric argument is outside the scalar leaf');
              return Number(decode(a.value));
            });
            return {...operands(fn,...args),...result(encode(Math[method](...numbers)))};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Number.is')){
            const n=args[0]?.value??U;
            const x=n[0]==='num'?decode(n):null;
            const method=callable[1].slice('Number.'.length);
            return {...operands(fn,...args),...result(['bool',
              n[0]==='num' && Number[method](x)])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Array.isArray'){
            const value=args[0]?.value??U;
            let isArray=false;
            if(value[0]==='ref'){
              const seen=new Set();
              let id=value[1];
              while(true){
                if(seen.has(id))throw new TypeError('Cyclic owned Proxy target chain');
                seen.add(id);
                const target=s.heap[id];
                if(!target)throw new ReferenceError('Unknown guest identity');
                if(target.kind==='proxy'){id=target.targetId;continue;}
                isArray=target.kind==='array';
                break;
              }
            }
            return {...operands(fn,...args),...result(['bool',isArray])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Object.is'){
            return {...operands(fn,...args),...result(['bool',
              ownedSameValue(args[0]?.value??U,args[1]?.value??U)])};
          }
          if(callable[0]==='builtinfn'&&
             ['Reflect.set','Reflect.deleteProperty','Reflect.defineProperty'].includes(callable[1])){
            const value=args[0]?.value??U,object=ownedObjectStorage(s,value);
            if(callable[1]==='Reflect.deleteProperty'&&isPrimitiveValue(value))
              guestFault('TypeError','Reflect.deleteProperty called on non-object');
            if(callable[1]==='Reflect.deleteProperty'&&object&&
               ['object','array','function','promise'].includes(object.kind)){
              const key=valueKey(args[1]?.value??U);
              if(object.kind==='function'&&['name','length'].includes(key)&&
                 !Object.hasOwn(object.properties??{},key)&&!Object.hasOwn(object.accessors??{},key))
                throw new TypeError('Function name/length deletion requires owned function-property storage');
              if(object.kind==='function'&&key==='prototype'&&!object.prototypeInitialized&&
                 !object.arrow&&!object.async&&!object.nonConstructible&&!this.programs[object.codeId]?.generator)
                throw new TypeError('Function prototype deletion requires owned function-property storage');
              const {success}=deleteOrdinaryOwn(object,key);
              return {...operands(fn,...args),...result(['bool',success])};
            }
            if(!object||object.kind!=='module-namespace')
              throw new TypeError(callable[1]+' currently requires an owned module namespace');
            const key=valueKey(args[1]?.value??U);
            if(callable[1]==='Reflect.set')
              return {...operands(fn,...args),...result(['bool',false])};
            if(callable[1]==='Reflect.deleteProperty')
              return {...operands(fn,...args),...result(['bool',
                !Object.hasOwn(object.accessors??{},key)&&!Object.hasOwn(object.properties,key)])};
            const descriptorValue=args[2]?.value??U,
              descriptor=descriptorValue[0]==='ref'?s.heap[descriptorValue[1]]:null;
            if(isPrimitiveValue(descriptorValue))
              guestFault('TypeError','Property descriptor must be an object');
            if(!descriptor||!['object','array'].includes(descriptor.kind))
              throw new TypeError('Reflect.defineProperty descriptor requires owned ordinary storage');
            if(Object.keys(descriptor.accessors??{}).length)
              throw new TypeError('Accessor descriptor fields are outside the bounded profile');
            if(![null,'Object.prototype','Array.prototype'].includes(objectPrototype(descriptor)))
              throw new TypeError('Inherited descriptor fields are outside the bounded profile');
            const outcome=this.moduleNamespaceDefine(s,f,object,key,descriptor,true,eventId);
            if(outcome.child)
              return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
            return {...operands(fn,...args),...result(outcome.value)};
          }
          if(callable[0]==='builtinfn'&&callable[1]==='Reflect.has'){
            const targetValue=args[0]?.value??U;
            // Reflect.has checks its target before converting the property key.
            // Keep the operand profile explicit: this path owns ordinary
            // identities and leaves Proxy callbacks to their call boundary.
            if(isPrimitiveValue(targetValue))guestFault('TypeError','Reflect.has called on non-object');
            const target=ownedObjectStorage(s,targetValue);
            if(!target||!['object','array','function','promise','proxy'].includes(target.kind))
              throw new TypeError('Reflect.has requires owned ordinary storage');
            if(target.kind==='proxy')throw new TypeError('Reflect.has Proxy trap requires its owned call boundary');
            const key=valueKey(args[1]?.value??U);
            return {...operands(fn,...args),...result(['bool',ownedHasProperty(ownedObjectHeap(s),targetValue,key)])};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Object.assign'){
            const ref=args[0]?.value??U;
            const target=ref[0]==='ref'?s.heap[ref[1]]:null;
            if(!target||target.kind!=='object'||
               !['Object.prototype',null].includes(objectPrototype(target))||
               Object.keys(target.accessors??{}).length)
              throw new TypeError('Object.assign needs a bounded ordinary data target');
            const copies=[];
            for(let i=1;i<args.length;i++){
              const value=args[i].value;
              if(value[0]==='null'||value[0]==='undefined')continue;
              const item=value[0]==='ref'?s.heap[value[1]]:null;
              if(!item||!['object','array'].includes(item.kind)||
                 Object.keys(item.accessors??{}).length)
                throw new TypeError('Object.assign source requires an owned data object');
              if(item===target)
                throw new TypeError('Object.assign self-source requires ordered reentrant property semantics');
              for(const key of ownPropertyKeys(item)){
                if(!enumerableOwn(item,key))continue;
                if(key==='__proto__')
                  throw new TypeError('Object.assign prototype setter not modeled');
                copies.push([key,item.properties[key].value]);
              }
            }
            for(const [key,value] of copies)putOwn(target,key,value,eventId);
            return {...operands(fn,...args),...result(ref)};
          }
          if(callable[0]==='builtinfn'&&['Object.preventExtensions','Object.isExtensible',
             'Object.seal','Object.isSealed','Object.freeze'].includes(callable[1])){
            const value=args[0]?.value??U,object=ownedObjectStorage(s,value);
            if(['Object.preventExtensions','Object.isExtensible'].includes(callable[1])&&
              !isPrimitiveValue(value)&&(!object||!['object','array','function','generator','promise','module-namespace'].includes(object.kind)))
              throw new TypeError(callable[1]+' requires owned ordinary storage');
            if(callable[1]==='Object.isExtensible')
              return {...operands(fn,...args),...result(['bool',!!object&&object.extensible!==false])};
            if(callable[1]==='Object.preventExtensions'){
              if(object)object.extensible=false;
              return {...operands(fn,...args),...result(value)};
            }
            if(object?.kind==='module-namespace'){
              const outcome=this.startModuleNamespaceInspection(s,f,object,
                callable[1],null,eventId);
              if(outcome.child)
                return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
              return {...operands(fn,...args),...result(outcome.value)};
            }
            throw new TypeError(callable[1]+' requires its bounded ordinary-object profile');
          }
          if(callable[0]==='builtinfn'&&['Object.isFrozen','Object.getOwnPropertyDescriptor'].includes(callable[1])){
            const base=args[0]?.value??U,object=ownedObjectStorage(s,base);
            if(callable[1]==='Object.isFrozen'){
              const primitive=isPrimitiveValue(base);
              if(!primitive&&(!object||!['object','array','function','generator','promise','module-namespace'].includes(object.kind)))
                throw new TypeError('Object.isFrozen requires owned ordinary storage');
              // Ordinary function name/length storage is still lazy. An empty
              // modeled key set cannot prove that a non-extensible function
              // has no configurable own properties.
              if(object?.kind==='function'&&object.extensible===false&&
                 !(object.properties?.name&&object.properties?.length))
                throw new TypeError('Object.isFrozen requires owned complete function descriptors');
              if(object?.kind==='module-namespace'){
                const outcome=this.startModuleNamespaceInspection(s,f,object,
                  callable[1],null,eventId);
                if(outcome.child)
                  return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
                return {...operands(fn,...args),...result(outcome.value)};
              }
              const frozen=primitive||object?.extensible===false&&ownPropertyKeys(object).every(key=>{
                const accessor=object.accessors?.[key],data=object.dataAttributes?.[key];
                return accessor?accessor.configurable===false:data?.configurable===false&&data.writable===false;
              });
              return {...operands(fn,...args),...result(['bool',!!frozen])};
            }
            if(!object||!['object','array','generator','promise','module-namespace'].includes(object.kind)&&!(object.kind==='function'&&object.properties?.name&&object.properties?.length))
              throw new TypeError('Own descriptor reflection requires owned ordinary storage');
            const key=valueKey(args[1]?.value??U);
            if(object.kind==='module-namespace'){
              if(Object.hasOwn(object.accessors??{},key)){
                const child=this.startModuleNamespaceRead(s,f,object,key,'descriptor',{},eventId);
                return {...operands(fn,...args),causes:[{kind:'invocation',frameId:child}]};
              }
              if(!Object.hasOwn(object.properties,key))
                return {...operands(fn,...args),...result(U)};
              return {...operands(fn,...args),...result(this.moduleNamespaceDescriptor(s,object,key,
                object.properties[key].value,eventId))};
            }
            const accessor=Object.hasOwn(object.accessors??{},key)?object.accessors[key]:null,
              slot=Object.hasOwn(object.properties,key)?object.properties[key]:null;
            if(!accessor&&!slot)return {...operands(fn,...args),...result(U)};
            const attributes=object.dataAttributes?.[key],arrayLength=object.kind==='array'&&key==='length';
            const fields=accessor?{get:accessor.get.value,set:accessor.set.value,enumerable:['bool',accessor.enumerable],configurable:['bool',accessor.configurable]}:
              {value:slot.value,writable:['bool',attributes?.writable??true],enumerable:['bool',attributes?.enumerable??!arrayLength],configurable:['bool',attributes?.configurable??!arrayLength]};
            const id=this.next(s,'obj'),descriptor=s.heap[id]={id,kind:'object',properties:{},propertyVersions:{},shapeVersion:0,version:0};
            for(const [name,value] of Object.entries(fields))putOwn(descriptor,name,value,eventId);
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn' && ['Object.hasOwn','Object.keys','Object.values','Object.entries','Object.getOwnPropertySymbols','Object.getOwnPropertyNames','Reflect.ownKeys'].includes(callable[1])){
            const base=args[0]?.value??U,obj=ownedObjectStorage(s,base);
            if(obj?.kind==='function'&&!['Object.keys','Object.values','Object.entries'].includes(callable[1])&&
               !(obj.properties?.name&&obj.properties?.length))
              throw new TypeError('Function descriptor reflection requires the complete Function profile');
            if(!obj||!['object','array','function','generator','promise','module-namespace'].includes(obj.kind))
              throw new TypeError('Object builtin requires an owned ordinary reference');
            if(callable[1]==='Object.hasOwn'){
              const property=valueKey(args[1]?.value??U);
              if(obj.kind==='module-namespace'){
                const outcome=this.startModuleNamespaceInspection(s,f,obj,
                  callable[1],property,eventId);
                if(outcome.child)
                  return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
                return {...operands(fn,...args),...result(outcome.value)};
              }
              return {...operands(fn,...args),...result(['bool',
                Object.hasOwn(obj.properties,property) ||
                Object.hasOwn(obj.accessors??{},property)])};
            }
            if(callable[1]==='Object.keys'&&obj.kind==='module-namespace'){
              const outcome=this.startModuleNamespaceInspection(s,f,obj,
                callable[1],null,eventId);
              if(outcome.child)
                return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
              return {...operands(fn,...args),...result(outcome.value)};
            }
            const keysOnly=['Object.keys','Object.getOwnPropertySymbols','Object.getOwnPropertyNames','Reflect.ownKeys'].includes(callable[1]);
            if(!keysOnly&&Object.keys(obj.accessors??{}).length)
              throw new TypeError('Ordered accessor value enumeration is outside the bounded profile');
            const keys=ownPropertyKeys(obj).filter(key=>{
              if(callable[1]==='Reflect.ownKeys')return true;
              if(callable[1]==='Object.getOwnPropertySymbols')return isSymbolPropertyKey(key);
              return !isSymbolPropertyKey(key)&&(callable[1]==='Object.getOwnPropertyNames'||enumerableOwn(obj,key));
            });
            const id=this.next(s,'obj');
            const array=s.heap[id]={id,kind:'array',properties:{length:token(['num',0],eventId)},
              propertyVersions:{length:0},shapeVersion:0,version:0};
            keys.forEach((key,i)=>{
              let member=keysOnly?propertyKeyValue(key):obj.properties[key].value;
              if(callable[1]==='Object.entries'){
                const pairId=this.next(s,'obj');
                const pair=s.heap[pairId]={id:pairId,kind:'array',
                  properties:{length:token(['num',0],eventId)},
                  propertyVersions:{length:0},shapeVersion:0,version:0};
                putOwn(pair,'0',propertyKeyValue(key),eventId);
                putOwn(pair,'1',member,eventId);
                member=['ref',pairId];
              }
              putOwn(array,String(i),member,eventId);
            });
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(callable[0]==='builtinfn' &&
              ['indexOf','lastIndexOf','slice','concat','join','splice','unshift','shift','at','reverse','fill','copyWithin','toReversed','with']
                .some(name=>callable[1]==='Array.prototype.'+name)){
             const obj=receiver[0]==='ref'?s.heap[receiver[1]]:null;
             if(!obj||obj.kind!=='array')
               guestFault('TypeError','Array method requires an array');
             const length=decode(obj.properties.length.value);
             if(!Number.isSafeInteger(length)||length<0||length>10000||
                Object.keys(obj.accessors??{}).length)
               throw new TypeError('Array method needs bounded dense own slots');
             const method=callable[1].slice('Array.prototype.'.length);
             const slots=[];
             // fill writes each selected index; it does not read the previous
             // element. Holes elsewhere remain holes. Custom prototypes can
             // supply inherited setters, which this leaf cannot bypass.
             if(method==='fill'){
               if(![null,'Array.prototype','Object.prototype'].includes(objectPrototype(obj)))
                 throw new TypeError('Array.fill inherited setters are outside the bounded profile');
             }else for(let i=0;i<length;i++){
               const slot=obj.properties[String(i)];
               if(!slot||!Array.isArray(slot.value))
                 throw new TypeError('Sparse array operation not modeled');
               slots.push(slot.value);
             }
             const numberAt=(i,missing,{undefinedDefault=false}={})=>{
               if(i>=args.length || (undefinedDefault && args[i].value[0]==='undefined'))return missing;
               const tag=args[i].value;
               if(!['undefined','null','bool','str','num'].includes(tag[0]))
                 throw new TypeError('Array index requires owned scalar coercion');
               const value=Number(decode(tag));
               return Number.isNaN(value)?0:Math.trunc(value);
             };
             const clamp=value=>value<0?Math.max(length+value,0):Math.min(value,length);
             const makeArray=values=>{
               if(values.length>10000)throw new RangeError('Array result limit');
               const id=this.next(s,'obj');
               const target=s.heap[id]={id,kind:'array',properties:{
                 length:token(['num',0],eventId)},propertyVersions:{length:0},
                 shapeVersion:0,version:0};
               values.forEach((value,i)=>putOwn(target,String(i),value,eventId));
               return ['ref',id];
             };
             const rewrite=values=>{
               if(values.length>10000)throw new RangeError('Array mutation limit');
               values.forEach((value,i)=>putOwn(obj,String(i),value,eventId));
               putOwn(obj,'length',['num',values.length],eventId);
             };
             let out;
             if(method==='at'){
                const requested=numberAt(0,0);
                const index=requested<0?length+requested:requested;
                out=index<0||index>=length?U:slots[index];
              }else if(method==='indexOf'||method==='lastIndexOf'){
               const back=method==='lastIndexOf';
               const from=numberAt(1,back?length-1:0);
               let i=back?(from<0?length+from:Math.min(from,length-1)):
                 (from<0?Math.max(length+from,0):from);
               const sought=args[0]?.value??U;
               let found=-1;
               for(;back?i>=0:i<length;back?i--:i++){
                 const candidate=slots[i];
                 const same=candidate[0]==='num'&&sought[0]==='num'?
                   decode(candidate)===decode(sought):ownedSameValue(candidate,sought);
                 if(same){found=i;break;}
               }
               out=['num',found];
             }else if(method==='slice'){
               const start=clamp(numberAt(0,0)),end=clamp(numberAt(1,length,{undefinedDefault:true}));
               out=makeArray(slots.slice(start,Math.max(start,end)));
             }else if(method==='concat'){
               const all=slots.slice();
               for(const arg of args){
                 const tag=arg.value,member=tag[0]==='ref'?s.heap[tag[1]]:null;
                 if(member?.kind==='proxy')
                   throw new TypeError('Proxy concat needs an owned internal method');
                 if(member?.kind==='array'){
                   const n=decode(member.properties.length.value);
                   if(!Number.isSafeInteger(n)||n>10000||
                      Object.keys(member.accessors??{}).length)
                     throw new TypeError('Unmodeled array concat source');
                   for(let i=0;i<n;i++){
                     const slot=member.properties[String(i)];
                     if(!slot)throw new TypeError('Sparse concat outside profile');
                     all.push(slot.value);
                   }
                 }else all.push(tag);
                 if(all.length>10000)throw new RangeError('Array concat limit');
               }
               out=makeArray(all);
             }else if(method==='join'){
               const sep=args.length===0||args[0].value[0]==='undefined'?',':(
                 ['null','bool','str','num','bigint'].includes(args[0].value[0])
                 ?String(decode(args[0].value)):(()=>{throw new TypeError('Unmodeled join separator');})());
               const text=slots.map(value=>{
                 if(['null','undefined'].includes(value[0]))return '';
                 if(!['str','bool','num','bigint'].includes(value[0]))
                   throw new TypeError('Unmodeled join element coercion');
                 return String(decode(value));
               }).join(sep);
               if(text.length>100000)throw new RangeError('Array join limit');
               out=['str',text];
             }else if(method==='reverse'||method==='toReversed'){
               const reversed=slots.slice().reverse();
               if(method==='toReversed')out=makeArray(reversed);
               else{
                 for(let i=0;i<Math.floor(length/2);i++){
                   putOwn(obj,String(i),reversed[i],eventId);
                   putOwn(obj,String(length-1-i),reversed[length-1-i],eventId);
                 }
                 out=receiver;
               }
             }else if(method==='fill'){
               const value=args[0]?.value??U,
                 start=clamp(numberAt(1,0)),end=clamp(numberAt(2,length,{undefinedDefault:true}));
               for(let i=start;i<end;i++)putOwn(obj,String(i),value,eventId);
               out=receiver;
             }else if(method==='copyWithin'){
               const target=clamp(numberAt(0,0)),start=clamp(numberAt(1,0)),
                 end=clamp(numberAt(2,length,{undefinedDefault:true}));
               const count=Math.min(Math.max(end-start,0),length-target);
               const copied=slots.slice();
               for(let i=0;i<count;i++)copied[target+i]=slots[start+i];
               for(let i=0;i<count;i++)
                 putOwn(obj,String(target+i),copied[target+i],eventId);
               out=receiver;
             }else if(method==='with'){
               const position=numberAt(0,0);
               const at=position<0?length+position:position;
               if(at<0||at>=length)
                 guestFault('RangeError','Array.with index out of bounds');
               const copy=slots.slice();
               copy[at]=args[1]?.value??U;
               out=makeArray(copy);
             }else if(method==='splice'){
               const start=clamp(numberAt(0,0));
               const count=args.length===0?0:args.length===1?length-start:
                 Math.max(0,Math.min(numberAt(1,0),length-start));
               out=makeArray(slots.slice(start,start+count));
               rewrite([...slots.slice(0,start),...args.slice(2).map(a=>a.value),
                 ...slots.slice(start+count)]);
             }else if(method==='unshift'){
               rewrite([...args.map(a=>a.value),...slots]);
               out=['num',length+args.length];
             }else if(method==='shift'){
               out=slots[0]??U;
               rewrite(slots.slice(1));
             }
             return {...operands(fn,...args),...result(out)};
           }
           if(callable[0]==='builtinfn' && callable[1]==='Array.prototype.includes'){
            const obj=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(!obj||obj.kind!=='array')
              guestFault('TypeError','Array.includes requires an array receiver');
            const length=decode(obj.properties.length.value);
            if(!Number.isSafeInteger(length)||length<0||length>10000)
              throw new RangeError('Array.includes exceeds bounded dense limit');
            const from=args[1]?.value??['num',0];
            if(!['undefined','null','bool','str','num'].includes(from[0]))
              throw new TypeError('Array.includes fromIndex requires owned scalar coercion');
            const raw=Number(decode(from));
            const integer=Number.isNaN(raw)?0:Math.trunc(raw);
            const begin=integer>=0?Math.min(integer,length):
              Math.max(length+integer,0);
            // No accessors, inherited slots or Proxy get continuations are
            // silently bypassed by a supposed pure array method.
            for(let i=0;i<length;i++){
              if(!Object.hasOwn(obj.properties,String(i)) ||
                 Object.hasOwn(obj.accessors??{},String(i)))
                throw new TypeError('Array.includes requires dense own data slots');
            }
            let matched=false;
            for(let i=begin;i<length;i++){
              if(ownedSameValue(obj.properties[String(i)].value,
                  args[0]?.value??U,true)){matched=true;break;}
            }
            return {...operands(fn,...args),...result(['bool',matched])};
          }
          if(callable[0]==='builtinfn' &&
             ['Array.prototype.push','Array.prototype.pop'].includes(callable[1])){
            const obj=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(!obj||obj.kind!=='array')guestFault('TypeError','Array method requires an array receiver');
            const length=decode(obj.properties.length.value);
            if(!Number.isSafeInteger(length)||length>10000 ||
              length+args.length>10000)
              throw new RangeError('Array operation exceeds bounded dense limit');
            let out;
            if(callable[1]==='Array.prototype.push'){
              args.forEach((a,i)=>putOwn(obj,String(length+i),a.value,eventId));
              out=['num',length+args.length];
            }else{
              if(length===0)out=U;
              else{
                const last=String(length-1);
                if(!Object.hasOwn(obj.properties,last))
                  throw new TypeError('Sparse array pop is outside the bounded profile');
                out=obj.properties[last].value;
                putOwn(obj,'length',['num',length-1],eventId);
              }
            }
            return {...operands(fn,...args),...result(out)};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Promise.prototype.')){
             if(receiver[0]!=='promise'||!s.promises[receiver[1]])
               guestFault('TypeError','Promise method called on an incompatible receiver');
             const method=callable[1].slice('Promise.prototype.'.length);
             if(method==='catch'){
               const then=ordinaryGet(ownedObjectHeap(s),receiver,'then');
               if(!then||!ownedSameValue(then.method.value,['builtinfn','Promise.prototype.then']))
                 throw new TypeError('Promise catch then override requires its owned call continuation');
             }
             const lookup=this.lookupPromiseConstructor(s,receiver,{kind:'reaction',frameId:f.id,receiver,
               method,args:args.map(arg=>arg.value)},eventId);
             return {...operands(fn,...args),reads:[lookup.read],
               ...(lookup.child?{causes:[{kind:'invocation',frameId:lookup.child}]}:
                 {result:f.stack.at(-1)?.value,causes:[{kind:'promise',promiseId:receiver[1]}]})};
           }
           if(callable[0]==='builtinfn' && ['Object.create','Object.setPrototypeOf','Object.getPrototypeOf','Object.defineProperty'].includes(callable[1])){
            const primitiveProto=v=>{
              if(v?.[0]==='null')return null;
              if(v?.[0]==='intrinsic' && ['Object.prototype','Array.prototype','Function.prototype','Promise.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(v[1])){
                if(v[1]==='Promise.prototype')ensurePromisePrototype(s);
                return v[1];
              }
              if(v?.[0]==='promise'&&s.promises[v[1]])return v[1];
              if(v?.[0]==='ref' && ['object','array','function','generator','module-namespace'].includes(s.heap[v[1]]?.kind))return v[1];
              if(isPrimitiveValue(v))guestFault('TypeError','Prototype must be null or an object');
              throw new TypeError('Prototype value requires owned ordinary storage');
            };
            const v=args[0]?.value??U,obj=ownedObjectStorage(s,v);
            if(callable[1]==='Object.defineProperty'){
              if(isPrimitiveValue(v))
                guestFault('TypeError','Object.defineProperty target must be an object');
              // Promises, functions and other object identities are valid JS
              // targets. Unmodeled storage must stop owned execution, not
              // manufacture a guest TypeError that can satisfy a negative test.
              if(!obj||!['object','array','promise','module-namespace'].includes(obj.kind))
                throw new TypeError('Object.defineProperty requires owned ordinary storage');
              const key=args[1]?.value??U,descValue=args[2]?.value??U;
              const name=valueKey(key),descriptor=ownedObjectStorage(s,descValue);
              if(isPrimitiveValue(descValue))
                guestFault('TypeError','Property descriptor must be an object');
              if(!descriptor||!['object','array','promise'].includes(descriptor.kind))
                throw new TypeError('Object.defineProperty descriptor requires owned ordinary storage');
              // ToPropertyDescriptor executes descriptor getters in source
              // order. Until that continuation is owned, this is a profile
              // refusal, never a substitute guest TypeError that a catch can
              // hide when the native getter happens to throw the same class.
              const d={},descriptorHeap=ownedObjectHeap(s);
              for(const field of ['enumerable','configurable','value','writable','get','set']){
                if(!ownedHasProperty(descriptorHeap,descValue,field))continue;
                const selected=ordinaryGet(descriptorHeap,descValue,field);
                if(!selected)throw new TypeError('Accessor descriptor fields are outside the bounded profile');
                d[field]=selected.method;
                // ToPropertyDescriptor validates get before it even reads set.
                // An invalid earlier field remains a guest error when a later
                // field would require an unmodeled accessor continuation.
                if((field==='get'||field==='set')&&selected.method.value[0]!=='undefined'&&
                  primitiveUnary('typeof',selected.method.value,s.heap)[1]!=='function')
                  guestFault('TypeError','Accessor must be a function or undefined');
              }
              if(obj.kind==='module-namespace'){
                const outcome=this.moduleNamespaceDefine(s,f,obj,name,{...descriptor,properties:d},false,eventId);
                if(outcome.child)
                  return {...operands(fn,...args),causes:[{kind:'invocation',frameId:outcome.child}]};
                return {...operands(fn,...args),...result(outcome.value)};
              }
              const previous=Object.hasOwn(obj.accessors??{},name)?obj.accessors[name]:null;
              if(obj.extensible===false&&!Object.hasOwn(obj.properties,name)&&!previous)
                guestFault('TypeError','Cannot define property on non-extensible object');
              const accessorDescriptor=Object.hasOwn(d,'get')||Object.hasOwn(d,'set'),
                dataDescriptor=Object.hasOwn(d,'value')||Object.hasOwn(d,'writable');
              if(accessorDescriptor&&dataDescriptor)guestFault('TypeError','Invalid mixed data/accessor descriptor');
              if(!accessorDescriptor&&(!previous||dataDescriptor)){
                // ArraySetLength and indexed descriptor deletion need their
                // own ordered continuation. Ordinary data definitions retain
                // exactly the supplied fields and preserve omitted metadata.
                if(obj.kind==='array'&&(name==='length'||arrayIndex(name)))
                  throw new TypeError('Array data descriptors require their explicit length profile');
                const present=Object.hasOwn(obj.properties,name),attributes=present?
                  {writable:true,enumerable:true,configurable:true,...obj.dataAttributes?.[name]}:null,
                  value=d.value??(present?obj.properties[name]:token(U)),
                  writable=Object.hasOwn(d,'writable')?truthy(d.writable.value):attributes?.writable??false,
                  enumerable=Object.hasOwn(d,'enumerable')?truthy(d.enumerable.value):previous?.enumerable??attributes?.enumerable??false,
                  configurable=Object.hasOwn(d,'configurable')?truthy(d.configurable.value):previous?.configurable??attributes?.configurable??false;
                const current=previous??attributes;
                if(current?.configurable===false&&(configurable||enumerable!==current.enumerable||previous||
                  attributes.writable===false&&(writable||!ownedSameValue(value.value,obj.properties[name].value))))
                  guestFault('TypeError','Cannot redefine a non-configurable property');
                putOwn(obj,name,value.value,eventId,{literal:true});
                if(previous)delete obj.accessors[name];
                obj.dataAttributes??={};
                Object.defineProperty(obj.dataAttributes,name,{value:{writable,enumerable,configurable},
                  enumerable:true,configurable:true,writable:true});
                return {...operands(fn,...args),...result(v)};
              }
              if(obj.dataAttributes?.[name]?.configurable===false&&accessorDescriptor)
                guestFault('TypeError','Cannot redefine frozen data property');
              // ValidateAndApplyPropertyDescriptor preserves absent fields
              // when changing an existing property. New accessors alone get
              // the false/undefined defaults; replacing ordinary own data
              // retains that property's modeled enumerable/configurable flags.
              const getter=d.get??previous?.get??token(U),
                setter=d.set??previous?.set??token(U);
              for(const method of [getter,setter])
                if(method.value[0]!=='undefined'&&primitiveUnary('typeof',method.value,s.heap)[1]!=='function')
                  guestFault('TypeError','Accessor must be a function or undefined');
              // Indexed accessors need ArraySetLength's non-configurable
              // deletion and ordered array-method continuations. Refuse the
              // combination until those invariants are modeled together.
              if(obj.kind==='array'&&arrayIndex(name))
                throw new TypeError('Array index accessor descriptors are outside the bounded profile');
              if(obj.kind==='array'&&name==='length')
                guestFault('TypeError','Cannot redefine non-configurable array length');
              const existingData=Object.hasOwn(obj.properties,name),
                enumerable=Object.hasOwn(d,'enumerable')?truthy(d.enumerable.value):
                  previous?.enumerable??obj.dataAttributes?.[name]?.enumerable??existingData,
                configurable=Object.hasOwn(d,'configurable')?truthy(d.configurable.value):
                  previous?.configurable??obj.dataAttributes?.[name]?.configurable??existingData;
              if(previous&&!previous.configurable&&
                 (configurable||enumerable!==previous.enumerable||
                  !ownedSameValue(getter.value,previous.get.value)||
                  !ownedSameValue(setter.value,previous.set.value)))
                guestFault('TypeError','Cannot redefine a non-configurable property');
              // Valid native accessors can still require storage or call
              // continuations this profile does not own. Check the real
              // descriptor invariants first, then refuse before mutation.
              if(name==='__proto__')
                throw new TypeError('Accessor definition requires owned prototype-named storage');
              if([getter,setter].some(method=>method.value[0]!=='undefined'&&!this.callableGuest(s,method.value)))
                throw new TypeError('Accessor definition requires owned callable storage');
              if(!previous&&!existingData)(obj.propertyOrder??=ownPropertyKeys(obj)).push(name);
              obj.accessors??={};
              obj.accessors[name]={get:getter,set:setter,enumerable,configurable};
              delete obj.properties[name];
              if(obj.dataAttributes)delete obj.dataAttributes[name];
              obj.propertyVersions[name]=(Object.hasOwn(obj.propertyVersions,name)?obj.propertyVersions[name]:0)+1;
              obj.shapeVersion++;
              return {...operands(fn,...args),...result(v)};
            }
            if(callable[1]==='Object.create'){
              // Never silently ignore the optional Properties argument.
              // General data descriptors (including their default flags)
              // are not part of the owned object model yet.
              if(args.length>1&&args[1].value[0]!=='undefined')
                throw new TypeError('Object.create property descriptors are outside the bounded profile');
              const proto=primitiveProto(v),id=this.next(s,'obj');
              s.heap[id]={id,kind:'object',prototype:proto,properties:{},propertyVersions:{},
                shapeVersion:0,version:0};
              return {...operands(fn,...args),...result(['ref',id])};
            }
            if(callable[1]==='Object.getPrototypeOf'&&v[0]==='intrinsic'&&GENERATOR_INTRINSIC_PROTOTYPES.includes(v[1]))
              return {...operands(fn,...args),...result(['intrinsic',generatorIntrinsicParent(v[1])])};
            if(callable[1]==='Object.getPrototypeOf'&&v[0]==='intrinsic'&&['Object.prototype','Array.prototype','Function.prototype'].includes(v[1]))
              return {...operands(fn,...args),...result(v[1]==='Object.prototype'?['null']:['intrinsic','Object.prototype'])};
            if(['undefined','null'].includes(v[0]))
              guestFault('TypeError','Prototype operation target must not be null or undefined');
            if(callable[1]==='Object.getPrototypeOf'){
              if(!obj||!['object','array','function','generator','promise','module-namespace'].includes(obj.kind))
                throw new TypeError('Object.getPrototypeOf requires owned ordinary storage');
              const proto=objectPrototype(obj);
              const out=proto===null?['null']:
                ['Object.prototype','Array.prototype','Function.prototype','Promise.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(proto)?['intrinsic',proto]:ownedObjectValue(s,proto);
              return {...operands(fn,...args),...result(out)};
            }
            const proto=primitiveProto(args[1]?.value??U);
            // SetPrototypeOf validates the prototype before returning a
            // non-null primitive unchanged; no boxed storage is involved.
            if(isPrimitiveValue(v))return {...operands(fn,...args),...result(v)};
            if(!obj||!['object','array','function','generator','promise','module-namespace'].includes(obj.kind))
              throw new TypeError('Object.setPrototypeOf requires owned ordinary storage');
            const visited=new Set([obj.id]);
            let current=proto;
            while(current!==null && !['Object.prototype','Array.prototype','Function.prototype',...GENERATOR_INTRINSIC_PROTOTYPES].includes(current)){
              if(visited.has(current))guestFault('TypeError','Cyclic prototype value');
              visited.add(current);
              const next=ownedObjectHeap(s)[current];
              if(!next||!['object','array','function','generator','promise','module-namespace'].includes(next.kind))
                throw new TypeError('Broken prototype identity');
              current=objectPrototype(next);
            }
            if(objectPrototype(obj)!==proto){
              if(obj.extensible===false)guestFault('TypeError','Cannot set prototype of non-extensible object');
              obj.prototype=proto;obj.shapeVersion++;
            }
            return {...operands(fn,...args),...result(v)};
          }
          if(callable[0]==='builtinfn' && ['Object.valueOf','Object.toString','Array.toString'].includes(callable[1])){
            const v=ordinaryBuiltin(s.heap,receiver,callable[1]);
            if(v===null)throw new TypeError('Unowned builtin receiver or array coercion');
            return {...operands(fn,...args),...result(v)};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Promise.withResolvers'){
             const promiseId=this.newPromise(s),id=this.next(s,'obj');
             const values={promise:['promise',promiseId],
               resolve:['builtinfn','Promise.executor.resolve:'+promiseId],
               reject:['builtinfn','Promise.executor.reject:'+promiseId]};
             s.heap[id]={id,kind:'object',properties:Object.fromEntries(
               Object.entries(values).map(([k,v])=>[k,token(v,eventId)])),
               propertyVersions:{promise:1,resolve:1,reject:1},shapeVersion:3,version:0};
             return {...operands(fn,...args),...result(['ref',id])};
           }
           if(callable[0]==='builtinfn' && ['Promise.resolve','Promise.reject'].includes(callable[1])){
            const v=args[0]?.value??U,origin=args[0]?.origin??null;
            if(callable[1]==='Promise.resolve' && v[0]==='promise'){
              const lookup=this.lookupPromiseConstructor(s,v,{kind:'resolve',frameId:f.id,value:v},origin);
              return {...operands(fn,...args),reads:[lookup.read],
                ...(lookup.child?{causes:[{kind:'invocation',frameId:lookup.child}]}:{result:f.stack.at(-1)?.value})};
            }
            const p=this.newPromise(s);
             if(callable[1]==='Promise.resolve')this.resolvePromise(s,p,v,origin);
             else this.rejectPromise(s,p,v,origin);
            return {...operands(fn,...args),...result(['promise',p])};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Atomics.')){
  const method=callable[1].slice(8);
  const view=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
  if(view?.kind==='typed-array')throw new BinaryProfileError('Non-shared Atomics require separate protocol qualification');
  if(view?.kind!=='shared-int32-view')
    guestFault('TypeError','Atomics requires owned integer shared view');
  const index=args[1]?.value[0]==='num'?decode(args[1].value):NaN;
  if(!Number.isInteger(index)||index<0||index>=effectiveSharedLength(s.heap[view.bufferId],view))
    guestFault('RangeError','Invalid atomic index');
  const count=method==='compareExchange'?4:method==='wait'?(args.length===3?3:4):
    method==='notify'?(args.length===2?2:3):method==='load'?2:3;
  if(args.length!==count)guestFault('TypeError','Atomic arity unsupported');
  const out=atomicSharedElement(s.heap[view.bufferId],view,method,index,args.slice(2).map(x=>x.value));
  return {...operands(fn,...args),...result(out)};
}
if(callable[0]==='builtinfn' && ['Promise.all','Promise.race','Promise.allSettled','Promise.any'].includes(callable[1])){
            const input=args[0]?.value,arr=input?.[0]==='ref'?s.heap[input[1]]:null;
            if(args.length!==1||arr?.kind!=='array'||Object.keys(arr.accessors??{}).length)
              guestFault('TypeError','Promise combinator requires an owned dense array');
            const iterator=ordinaryGet(s.heap,input,symbolPropertyKey('well-known:iterator'));
            if(!iterator||!equal(iterator.method.value,['builtinfn','Array.prototype.values']))
              throw new TypeError('Promise combinator custom iterator requires its owned continuation');
            const kind=callable[1].slice('Promise.'.length),resultId=this.newPromise(s);
            // The sentinel accounts for iterator exhaustion, while each
            // visited element owns one further settlement. Array iteration
            // reads length and the next value after each synchronous lookup.
            if(['all','allSettled','any'].includes(kind))
              s.promises[resultId].combinator={kind,remaining:1,values:[]};
            f.pendingPromiseCombinator={kind,resultId,arrayId:arr.id,index:0};
            this.advancePromiseCombinator(s,f,eventId);
            return {...operands(fn,...args),...result(['promise',resultId])};
          }
          if(callable[0]==='hostfn'){
            const operation=callable[1];
            const kind=hostOperation(operation).kind;
            // Materialize from this transaction's committed candidate graph,
            // before any native adapter sees the request or a promise is allocated.
            const request=prepareHostRequest(s.heap,operation,args.map(x=>x.value));
            const id=this.next(s,'effect'),promiseId=kind==='promise'?this.newPromise(s):null;
            s.effects[id]={id,operation,kind,args:args.map(x=>x.value),argOrigins:args.map(x=>x.origin),
              request,frameId:f.id,promiseId,
              ...(hostOperation(operation).callbackLifetime==='subscription'?
                {subscription:{state:'pending',token:null,closedBy:null}}:{}),
              dispatch:'prepared',external:'pending',immediate:kind==='promise'?'completed':'awaiting',outcomeIds:[],inputIds:[],version:0};
            if(kind==='promise')this.stackPush(f,['promise',promiseId],eventId);
            else {f.status='blocked';f.blockedOn=id;}
            return {...operands(fn,...args),result:kind==='promise'?['promise',promiseId]:null,causes:[{kind:'effect',effectId:id}]};
          }
          guestFault('TypeError','Not a callable guest function');
        }
        case 'AWAIT':{
          const a=pop(),v=a.value;if(!f.asyncPromiseId)throw new SyntaxError('await outside async function');
          if(v[0]==='promise'){
            const lookup=this.lookupPromiseConstructor(s,v,{kind:'await',frameId:f.id,value:v},a.origin);
            return {...operands(a),reads:[lookup.read],causes:[
              ...(lookup.promiseId?[{kind:'promise',promiseId:lookup.promiseId}]:[]),
              ...(lookup.child?[{kind:'invocation',frameId:lookup.child}]:[])]};
          }
          const promiseId=v[0]==='promise'?v[1]:this.newPromise(s);
          const waiting=v[0]!=='promise'?this.resolvePromise(s,promiseId,v,a.origin):null;
          if(waiting)s.frames[waiting].promiseThenLookup.resume={kind:'await',frameId:f.id,promiseId};
          else this.awaitPromise(s,f,promiseId);
          return {...operands(a),causes:[{kind:'promise',promiseId},
            ...(waiting?[{kind:'invocation',frameId:waiting}]:[])]};
        }
        case 'GENERATOR_START':{
          const output=this.suspendGenerator(s,f,U,eventId,true);return {result:output};
        }
        case 'DELEGATE_YIELD':{
          const value=pop();f.delegateYield=true;
          const output=this.suspendGenerator(s,f,value.value,eventId,false,true);
          return {...operands(value),result:output};
        }
        case 'YIELD':{
          const value=pop(),output=this.suspendGenerator(s,f,value.value,eventId);
          return {...operands(value),result:output};
        }
        case 'RETURN':{const v=pop();this.routeCompletion(s,f,{type:'return',value:v},eventId);return {...operands(v),result:v.value};}
        case 'THROW':{const v=pop(),completion={type:'throw',value:v};this.routeCompletion(s,f,completion,eventId);return {...operands(v),completion};}
        default:throw new Error(`Unknown opcode ${op}`);
      }} catch(error) {
        if(!(error instanceof GuestFault))throw error;
        const completion={type:'throw',errorType:error.name,message:error.message,origin:eventId};
        // Parameter faults retain their independently checked pre-state marker.
        // Every actual GuestFault commits one owned exception identity at the
        // faulting operation; callers, catches and finally use that same value.
        if(error.parameterTdz)completion.parameterTdz=copy(error.parameterTdz);
        completion.value=this.caughtError(s,completion,eventId);
        this.routeCompletion(s,f,completion,eventId);
        return {completion};
      }
    },{siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId,invocationId:frame.id});
  }
  prepared() {return Object.values(this.state.effects).find(e=>e.dispatch==='prepared');}
  dispatchPrepared(effectId) {
    const e=this.state.effects[effectId];if(!e||e.dispatch!=='prepared')throw new Error('Not prepared');
    this.commit('effect.dispatch',s=>{s.effects[effectId].dispatch='dispatched';return {causes:[{kind:'effect',effectId}]};});
    const adapter=this.adapters[e.operation];
    if(!adapter)return;
    let outcome;
    try {
      // The adapter receives only a frozen, fully materialized JSON tree;
      // guest reference handles are retained solely in the private journal.
      const args=freezeJson(JSON.parse(e.request.payload));
      const {schema,operation,signature,codec,payload,byteLength}=e.request;
      // Archive-only graph-version identities must not escape to the adapter.
      const request=Object.freeze({schema,operation,signature,codec,payload,byteLength});
      outcome=adapter({effectId,operation:e.operation,args,request});
    }
    catch(error){outcome={kind:'throw',value:encode(String(error?.message??error))};}
    if(outcome && typeof outcome.then==='function')throw new TypeError('Adapters must publish asynchronous results via recordInputArrival, not native promises');
    if(outcome?.kind==='normal'||outcome?.kind==='throw'){
      const input=this.recordInputArrival({effectId,kind:e.kind==='promise'?'completion':'immediate',value:outcome.value,abrupt:outcome.kind==='throw'});
      this.deliverInput(input.inputId);
    } else if(outcome && outcome.kind!=='pending')throw new TypeError('Invalid adapter outcome');
  }
  /**
   * An external callback is a delivered environment event. It queues the
   * original owned closure, never executing guest source in the native realm.
   * Notification slots carry primitive values. A callback-graph operation
   * carries one snapshotted receiver/argument graph and a return identity.
   */
  recordExternalCallback({effectId,callbackId,args=[],returnId=null,inputGraph=null}={}){
    if(!Array.isArray(args)||args.length>32)throw new TypeError('Invalid external callback argument list');
    const values=returnId===null?args.map(value=>guestValue(value)?copy(value):encode(value)):
      copy(inputGraph?.roots?.slice(1));
    const job={kind:'external-callback',effectId,functionId:callbackId,args:values,
      ...(returnId===null?{}:{returnId,inputGraph:copy(inputGraph)})};
    validateExternalCallbackJob(this.state,job,{arrival:true});
    this.commit('external.callback.enqueue',s=>{
      s.control.a0.queue.push(job);
      return {operands:values,causes:[{kind:'effect',effectId}]};
    });
  }
  recordInputArrival({effectId,kind,value,graph=null,abrupt=false,inputId=null}={}) {
    const e=this.state.effects[effectId];if(!e||e.dispatch!=='dispatched')throw new Error('Input requires a dispatched effect');
    if(kind!==(e.kind==='promise'?'completion':'immediate'))throw new Error('Wrong input kind for host call');
    if(e.external!=='pending')throw new Error('Effect already completed');
    if(e.inputIds.length)throw new Error('Effect already has an input arrival');
    if(typeof abrupt!=='boolean')throw new TypeError('Input abrupt must be boolean');
    if(inputId!==null && (typeof inputId!=='string'||!inputId||['__proto__','constructor','prototype'].includes(inputId)))
      throw new TypeError('Transport input ID must be a nonempty, non-reserved string');
    const spec=hostOperation(e.operation);
    if(graph===null&&Array.isArray(value)&&!guestValue(value))
      throw new TypeError('Unsupported canonical external payload');
    if(graph===null&&value!==null&&typeof value==='object'&&!guestValue(value)){
      if(spec.resultCodec!=='owned-graph/1')throw new TypeError('Operation requires a scalar external result');
      graph=encodeNativeGraph([value]);
    }
    if(graph!==null){
      if(spec.resultCodec!=='owned-graph/1')throw new TypeError('Operation has no declared result graph codec');
      validateOwnedGraph(graph);
      if(graph.roots.length!==1)throw new TypeError('External result graph needs exactly one root');
      graph=copy(graph);
    }else if(Array.isArray(value)&&!guestValue(value))throw new TypeError('Unsupported canonical external payload');
    const encoded=graph?copy(graph.roots[0]):guestValue(value)?copy(value):encode(value);
    let allocated;
    this.commit('external.input.arrive',s=>{
      if(inputId===null) {
        do { allocated=this.next(s,'input'); } while(Object.hasOwn(s.inputs,allocated));
      } else allocated=inputId;
      if(Object.hasOwn(s.inputs,allocated))throw new Error('Duplicate input ID');
      s.inputs[allocated]={id:allocated,effectId,kind,abrupt,value:encoded,
        ...(graph?{graph}:{}),status:'arrived',version:0};
      s.effects[effectId].inputIds.push(allocated);
      return {causes:[{kind:'effect',effectId}]};
    });
    return {inputId:allocated};
  }
  deliverInput(inputId) {
    const input=this.state.inputs[inputId];if(!input||input.status!=='arrived')throw new Error('Input not available for delivery');
    const e=this.state.effects[input.effectId];
    return this.commit('external.input.deliver',(s,eventId)=>{
      const i=s.inputs[inputId],fx=s.effects[i.effectId];i.status='delivered';fx.external=i.abrupt?'rejected':'completed';
      // Outside identities remain private arrival data until this delivery.
      // Allocate all nodes first, then link them, so aliases and cycles enter
      // the owned heap atomically without borrowing native object identities.
      if(i.graph){
        const identities=new Map(i.graph.objects.map(node=>[node.id,this.next(s,'obj')]));
        const value=tag=>tag[0]==='ref'?['ref',identities.get(tag[1])]:copy(tag);
        i.graphIdentities=[...identities].map(([source,target])=>({source,target}));
        for(const node of i.graph.objects){
          const id=identities.get(node.id),properties={},propertyVersions={};
          for(const member of node.properties){
            properties[stringPropertyKey(member.key)]=token(value(member.value),eventId);
            propertyVersions[stringPropertyKey(member.key)]=0;
          }
          s.heap[id]={id,kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
            properties,propertyVersions,shapeVersion:0,version:0};
        }
        i.value=value(i.graph.roots[0]);
      }
      if(fx.subscription){
        if(!i.abrupt&&(i.value[0]!=='str'||Object.values(s.effects).some(other=>other.id!==fx.id&&
            other.operation===fx.operation&&other.subscription?.token&&equal(other.subscription.token,i.value))))
          throw new TypeError('Subscription registration requires a unique native string token');
        fx.subscription={state:i.abrupt?'closed':'active',token:i.abrupt?null:copy(i.value),
          closedBy:i.abrupt?fx.id:null};
      }
      const registration=SUBSCRIPTION_CLOSERS[fx.operation];
      if(registration&&!i.abrupt){
        const targets=Object.values(s.effects).filter(other=>other.operation===registration&&
          other.subscription?.token&&equal(other.subscription.token,fx.args[0]));
        if(targets.length!==1)throw new TypeError('Subscription close token has no unique owned registration');
        const target=targets[0];
        if(target.subscription.state==='active'){
          target.subscription={...target.subscription,state:'closed',closedBy:fx.id};
          s.control.a0.queue=s.control.a0.queue.filter(job=>job.kind!=='external-callback'||job.effectId!==target.id);
        }
      }
      let completion=null;
      if(fx.kind==='promise'){
        if(i.abrupt)this.rejectPromise(s,fx.promiseId,i.value,eventId);
        else this.resolvePromise(s,fx.promiseId,i.value,eventId);
      }else{
        const f=s.frames[fx.frameId];
        if(f.blockedOn!==fx.id||f.status!=='blocked')throw new Error('Synchronous completion has no matching blocked frame');
        fx.immediate='completed';f.blockedOn=null;f.status='running';
        if(i.abrupt) {completion={type:'throw',value:token(i.value,eventId)};this.routeCompletion(s,f,completion,eventId);}
        else this.stackPush(f,i.value,eventId);
      }
      return {result:i.value,causes:[{kind:'input',inputId},{kind:'effect',effectId:i.effectId}],...(completion?{completion}:{})};
    });
  }
  enterQueuedJob() {
    const item=this.state.control.a0.queue[0];
    if(!item)return;
    this.commit('job.enter',(s,eventId)=>{
      const job=s.control.a0.queue.shift();
      if(job.kind==='promise-adopt'){
        const adopter=s.promises[job.promiseId],target=s.promises[job.targetId];
        if(adopter?.status!=='pending'||!target||adopter.adopting!==target.id||adopter===target)
          throw new Error('Invalid queued Promise adoption');
        const continuation={kind:'adopt',promiseId:adopter.id,targetId:target.id};let lookup;
        try{lookup=this.lookupPromiseConstructor(s,['promise',target.id],continuation,eventId);}
        catch(error){
          if(!(error instanceof GuestFault))throw error;
          this.rejectPromiseConstructor(s,continuation,{type:'throw',errorType:error.name,message:error.message},eventId);
          return {causes:[{kind:'promise',promiseId:adopter.id}],result:['promise',adopter.id]};
        }
        return {causes:[{kind:'promise',promiseId:adopter.id}],result:['promise',adopter.id],reads:[lookup.read]};
      }
      if(job.kind==='thenable'){
         const p=s.promises[job.promiseId],fn=s.heap[job.thenId];
         if(p?.status!=='pending'||p.thenableSerial!==job.serial||
           fn?.kind!=='function'||!(s.heap[job.thenableId]??s.promises[job.thenableId]))
           throw new Error('Invalid queued thenable');
         const resolve=['builtinfn','Promise.thenable.resolve:'+p.id+':'+job.serial];
         const reject=['builtinfn','Promise.thenable.reject:'+p.id+':'+job.serial];
         const inner=fn.async?this.newPromise(s):null;
         const id=this.newFrame(s,fn.codeId,fn.closureEnvId,null,inner,
           [token(resolve,eventId),token(reject,eventId)],this.functionThis(fn,job.receiver??['ref',job.thenableId]),fn.id);
         s.frames[id].thenableJob={promiseId:p.id,serial:job.serial};
         s.control.a0.activeFrameId=id;
         return {causes:[{kind:'promise',promiseId:p.id},{kind:'invocation',frameId:id}],
           result:['promise',p.id]};
       }
       if(job.kind==='external-callback'){
        const {fn,returns}=validateExternalCallbackJob(s,job);
        let args=job.args,receiver=U,graphIdentities;
        if(returns){
          const identities=new Map(job.inputGraph.objects.map(node=>[node.id,this.next(s,'obj')]));
          const value=tag=>tag[0]==='ref'?['ref',identities.get(tag[1])]:copy(tag);
          graphIdentities=[...identities].map(([source,target])=>({source,target}));
          for(const node of job.inputGraph.objects){
            const id=identities.get(node.id),properties={},propertyVersions={};
            for(const member of node.properties){
              properties[stringPropertyKey(member.key)]=token(value(member.value),eventId);
              propertyVersions[stringPropertyKey(member.key)]=0;
            }
            s.heap[id]={id,kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
              properties,propertyVersions,shapeVersion:0,version:0};
          }
          receiver=value(job.inputGraph.roots[0]);args=job.args.map(value);
        }
        const inner=fn.async?this.newPromise(s):null;
        const id=this.newFrame(s,fn.codeId,fn.closureEnvId,null,inner,
          args.map(v=>token(v,eventId)),this.functionThis(fn,receiver),fn.id);
        s.frames[id].reactionJob=true;
        if(returns)s.frames[id].externalCallbackReturn={id:job.returnId,effectId:job.effectId,
          functionId:job.functionId,graphIdentities};
        s.control.a0.activeFrameId=id;
        return {causes:[{kind:'effect',effectId:job.effectId},
          {kind:'invocation',frameId:id}],result:U};
      }
      if(job.kind==='microtask'){
         const callback=s.heap[job.functionId];
        if(callback?.kind!=='function')
          throw new Error('Queued microtask lacks owned function identity');
        const inner=callback.async?this.newPromise(s):null;
        const id=this.newFrame(s,callback.codeId,callback.closureEnvId,null,inner,[],
          this.functionThis(callback),callback.id);
        s.frames[id].reactionJob=true;
        s.control.a0.activeFrameId=id;
        return {causes:[{kind:'invocation',frameId:id}],result:U};
      }
      const p=s.promises[job.promiseId];
      if(job.kind==='adoption'){
        const adopter=s.promises[job.resultId];
        if(!p||!['fulfilled','rejected'].includes(p.status)||adopter?.status!=='pending'||adopter.adopting!==p.id)
          throw new Error('Invalid Promise adoption reaction');
        adopter.adopting=null;
        if(p.status==='rejected')this.rejectPromise(s,adopter.id,p.value.value,p.value.origin);
        else this.resolvePromise(s,adopter.id,p.value.value,p.value.origin);
        return {causes:[{kind:'promise',promiseId:p.id}],result:p.value.value};
      }
      if(job.kind==='combinator'){
        if(!p||!['fulfilled','rejected'].includes(p.status))
          throw new Error('Combinator job on unsettled promise');
        const target=s.promises[job.resultId];
        if(!target)throw new Error('Unknown combinator result');
        if(target.status!=='pending'||target.resolverCalled)
          return {causes:[{kind:'promise',promiseId:job.promiseId}],result:p.value.value};
        if(job.mode==='race'||(job.mode==='all'&&p.status==='rejected')||
           (job.mode==='any'&&p.status==='fulfilled')){
          target.resolverCalled=true;
          if(p.status==='rejected')this.rejectPromise(s,job.resultId,p.value.value,p.value.origin);
          else this.resolvePromise(s,job.resultId,p.value.value,p.value.origin);
        }else{
          const comb=target.combinator;
          if(comb?.kind!==job.mode||comb.values[job.index]!==null)
            throw new Error('Invalid combinator observation');
          if(job.mode==='allSettled'){
            const id=this.next(s,'obj');
            const entry=s.heap[id]={id,kind:'object',properties:{},
              propertyVersions:{},shapeVersion:0,version:0};
            putOwn(entry,'status',['str',p.status],eventId);
            putOwn(entry,p.status==='fulfilled'?'value':'reason',p.value.value,eventId);
            comb.values[job.index]=token(['ref',id],eventId);
          }else comb.values[job.index]=copy(p.value);
          comb.remaining--;
          if(comb.remaining===0)this.finishPromiseCombinator(s,job.resultId,eventId);
        }
        return {causes:[{kind:'promise',promiseId:job.promiseId}],result:p.value.value};
      }
      if(job.kind==='reaction'||job.kind==='finally-pass') {
        if(!p||!['fulfilled','rejected'].includes(p.status))
          throw new Error('Reaction job on unsettled promise');
        const original=p.value;
        if(job.kind==='finally-pass') {
          if(p.status==='rejected')this.rejectPromise(s,job.resultId,original.value,original.origin);
          else if(job.originalStatus==='rejected')
            this.rejectPromise(s,job.resultId,job.original.value,job.original.origin);
          else this.resolvePromise(s,job.resultId,job.original.value,job.original.origin);
          return {causes:[{kind:'promise',promiseId:job.promiseId}],result:original.value};
        }
        const reaction=job.reaction,isFinally=reaction.kind==='finally';
        const callback=isFinally?reaction.onFinally:
          p.status==='fulfilled'?reaction.onFulfilled:reaction.onRejected;
        if(!this.callableGuest(s,callback)){
          if(p.status==='rejected')this.rejectPromise(s,reaction.resultId,original.value,original.origin);
          else this.resolvePromise(s,reaction.resultId,original.value,original.origin);
          return {causes:[{kind:'promise',promiseId:job.promiseId}],result:original.value};
        }
        const fn=s.heap[callback[1]];
        const args=isFinally?[]:[original];
        const inner=fn.async?this.newPromise(s):null;
        const id=this.newFrame(s,fn.codeId,fn.closureEnvId,null,inner,args,this.functionThis(fn),fn.id);
        const child=s.frames[id];
        child.reactionJob=true;
        if(isFinally)child.finallyReaction={resultId:reaction.resultId,
          originalStatus:p.status,original:copy(original)};
        else child.reactionPromiseId=reaction.resultId;
        s.control.a0.activeFrameId=id;
        return {causes:[{kind:'promise',promiseId:job.promiseId},
          {kind:'invocation',frameId:id}],result:['promise',reaction.resultId]};
      }
      const f=s.frames[job.frameId];
      if(job.kind!=='await'||f.status!=='suspended'||!['fulfilled','rejected'].includes(p.status))throw new Error('Invalid promise resume');
      f.status='running';f.awaiting=null;f.callerFrameId=null;
      s.control.a0.activeFrameId=f.id;
      if(p.status==='rejected'){
        const completion={type:'throw',value:token(p.value.value,p.value.origin)};
        this.routeCompletion(s,f,completion,eventId);
        return {result:p.value.value,origins:[p.value.origin],
          causes:[{kind:'promise',promiseId:job.promiseId}],completion};
      }
      this.stackPush(f,p.value.value,eventId);
      s.control.a0.activeFrameId=f.id;return {result:p.value.value,causes:[{kind:'promise',promiseId:job.promiseId}]};
    });
  }
  enterTimerTask() {
    const c=this.state.control.a0;
    if(c.activeFrameId || c.queue.length || !c.timers.length)
      throw new Error('Virtual timer turn cannot preempt an active guest job');
    if(c.timerTurns>=128)throw new RangeError('Virtual timer turn budget exceeded');
    this.commit('host.task.enter',(s,eventId)=>{
      const clock=s.control.a0;
      clock.timers.sort((a,b)=>a.at-b.at||a.order-b.order);
      const task=clock.timers.shift();
      clock.now=Math.max(clock.now,task.at);
      clock.timerTurns++;
      if(task.kind==='interval'){
        task.at=clock.now+task.delay;
        task.order=clock.nextTimerId+clock.timerTurns*1024;
        clock.timers.push(task);
      }
      const fn=s.heap[task.functionId];
      if(fn?.kind!=='function')throw new Error('Virtual timer callback identity missing');
      const inner=fn.async?this.newPromise(s):null;
      const id=this.newFrame(s,fn.codeId,fn.closureEnvId,null,inner,[],
        this.functionThis(fn),fn.id);
      s.frames[id].reactionJob=true;
      clock.activeFrameId=id;
      return {causes:[{kind:'invocation',frameId:id}],result:['num',clock.now]};
    });
  }
  seal(kind) {
    if(this.events.length===this.chunkStart && this.chunks.length && kind==='waiting')return;
    const last=this.events.length, before=this.chunkBefore, after=`q${last}`;
    const pending=Object.values(this.state.effects).filter(e=>e.external==='pending').map(e=>e.id);
    const waitingOn=Object.values(this.state.frames).filter(f=>f.status==='blocked'||f.status==='suspended').map(f=>f.blockedOn??f.awaiting);
    this.checkpoints[after]=copy(this.state);
    this.chunks.push({chunkId:`a0:c${this.chunks.length+1}`,agentId:'a0',policy:'accumulate-until-wait/1',before,after,
      firstEvent:this.chunkStart+1,lastEvent:last,eventIds:this.events.slice(this.chunkStart).map(e=>e.eventId),
      effects:[...new Set(this.events.slice(this.chunkStart).flatMap(e=>e.causes.filter(x=>x.kind==='effect').map(x=>x.effectId)))],
      inputs:[...new Set(this.events.slice(this.chunkStart).flatMap(e=>e.causes.filter(x=>x.kind==='input').map(x=>x.inputId)))],
      exit:{kind,pendingEffects:pending,waitingOn:waitingOn.filter(Boolean)}});
    this.chunkStart=last;this.chunkBefore=after;
  }
  // Native hosts can stop between owned jobs to preserve microtask ordering.
  // Yielding
  // leaves the next job and the open archive chunk intact; it is not a wait,
  // completion, or an implicit checkpoint. The ordinary driver still drains
  // the queue. Callers resuming a yielded turn retain their remaining budget.
  drive({yieldBeforeJob=false,stepLimit=this.maxSteps}={}) {
    if(typeof yieldBeforeJob!=='boolean')throw new TypeError('Job yielding policy must be boolean');
    if(!Number.isSafeInteger(stepLimit)||stepLimit<1||stepLimit>this.maxSteps)
      throw new RangeError('Driver step limit must be positive and within its configured budget');
    if(!this.started)throw new Error('Start first');
    let steps=0;
    while(steps++<stepLimit) {
      const terminal=this.state.control.a0.status;
      if(terminal==='failed'||terminal==='unsupported') {
        const kind=terminal==='failed'?'runtime.failure':'unsupported';this.seal(kind);
        return {kind,failure:copy(this.state.control.a0.failure??null),waitingOn:[],pendingEffects:this.chunks.at(-1).exit.pendingEffects};
      }
      const pending=this.prepared();
      if(pending){this.dispatchPrepared(pending.id);continue;}
      const c=this.state.control.a0;
      const active=c.activeFrameId&&this.state.frames[c.activeFrameId];
      if(active?.status==='running') {this.step();continue;}
      if(active?.status==='blocked'){this.seal('waiting');return {kind:'waiting',waitingOn:active.blockedOn,pendingEffects:this.chunks.at(-1).exit.pendingEffects};}
      if(c.queue.length){
        if(yieldBeforeJob)return {kind:'yield',steps:steps-1};
        this.enterQueuedJob();continue;
      }
      if(c.scriptSequence&&c.scriptSequence.nextIndex<c.scriptSequence.sourceIds.length){this.enterNextScript();continue;}
      if(c.timers.length){this.enterTimerTask();continue;}
      const pendingPromises=Object.values(this.state.promises).some(p=>p.status==='pending');
      const pendingEffects=Object.values(this.state.effects).some(e=>e.external==='pending');
      const subscriptions=Object.values(this.state.effects).some(e=>e.subscription?.state==='active');
      const kind=pendingPromises||pendingEffects||subscriptions?'waiting':'terminated';
      this.seal(kind);return {kind,waitingOn:this.chunks.at(-1)?.exit.waitingOn??[],pendingEffects:this.chunks.at(-1)?.exit.pendingEffects??[]};
    }
    throw new Error(`Driver safety limit (${stepLimit} steps); no chunk has been misreported as complete`);
  }
  checkpoint() {return {stateRoot:`q${this.events.length}`,state:copy(this.state)};}
  inspectState() {return copy(this.state);}
  inspectOpenChunk() {return {before:this.chunkBefore,eventIds:this.events.slice(this.chunkStart).map(e=>e.eventId),open:true};}
  exportRun() {
    const bundle={manifest:{schema:'semantic-tracing-run/2',profile:this.entrySpec?.kind==='scripts'||this.sources[0]?.parser===OWNED_SCRIPT_PARSER?'owned-script/1':this.entrySpec?'training-js/1':'bounded-js-subset/2',completeSemanticTrace:false,
      completeEcma262:false,completeHostIntegration:false,coverage:'docs/STATUS.md',chunkPolicy:'accumulate-until-wait/1',
      eventVersion:2,operationVersion:2,mutationSchema:'owned-spec-commands/2',
      ownedSymbols:{revision:1,propertyKeys:'owned-property-key/1',hostTransport:'unsupported'},
      ownedArithmetic:{revision:2,referenceEngineRevision:ENGINE_REVISION,operators:['+','-','*','/','%','**'],domain:'primitives-and-bounded-ordinary-data-objects'},
      guestExecution:'owned-bytecode-and-spec-phase-machine',replay:'bounded-deterministic-reexecution/2'},
      sources:this.sources,sites:this.sites,programs:this.programs,entrySpec:this.entrySpec??null,initialState:this.initialState,finalState:this.state,
      events:this.events,chunks:this.chunks,checkpoints:this.checkpoints,effects:this.state.effects,inputs:this.state.inputs};
    requireDataOnly(bundle);
    return copy(bundle);
  }
}
export function createRuntime(options){return new Runtime(options);}
