// V8 protocol transitions share the selected controller's heap, cells and call
// stack. Staging is transactional; no interpreter or source oracle runs here.
import {isDeepStrictEqual} from 'node:util';
import {WELL_KNOWN_SYMBOLS} from '../property-keys.js';
import {evaluateWitnessExpression} from '../training/witness-check.js';
import {analyzeSemanticProgram} from '../training/semantic-program.js';
import {validateProtocolSymbols} from './protocol-values.js';
import {assertAlgorithmFields,assertAlgorithmDataArray,isAlgorithmDataRecord} from './ir.js';
import {validateProtocolRecordV8,validateProtocolValueV8,validateProtocolKeyV8,
  validateProtocolDescriptorV8} from './protocol-codec-v8.js';
import {PROTOCOL_MACHINE_ADAPTERS_V8} from './protocol-machine-extensions-v8.js';

export const PROTOCOL_STATE_V8_SCHEMA='semantic-protocol-state/1';
const baseStateFields=['schema','symbols','pendingCalls','callFrames','sequence'];
const extensionStateFields=PROTOCOL_MACHINE_ADAPTERS_V8.filter(adapter=>adapter.stateField!==undefined).map(adapter=>adapter.stateField);
if(extensionStateFields.some(field=>typeof field!=='string'||!field||baseStateFields.includes(field))||
  new Set(extensionStateFields).size!==extensionStateFields.length)throw new TypeError('Distinct protocol extension state fields required');
export const PROTOCOL_STATE_V8_FIELDS=Object.freeze([...baseStateFields,...extensionStateFields]);
export const PROTOCOL_V8_LIMITS=Object.freeze({symbols:4096,properties:4096,calls:64,steps:32768});
const copy=structuredClone,eq=isDeepStrictEqual;
const fail=message=>{const error=new TypeError('Protocol v8: '+message);error.category='unsupported.protocol-v8';throw error;};
const require=(condition,message)=>{if(!condition)fail(message);};
const index=key=>typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<4294967295;
const symbolic=key=>Array.isArray(key)&&key[0]==='symbol';
const keyEqual=(a,b)=>typeof a==='string'&&typeof b==='string'?a===b:symbolic(a)&&symbolic(b)&&a[1]===b[1];
const publicKey=key=>typeof key==='string'?['str',key]:copy(key);
const internalKey=key=>key[0]==='str'?key[1]:copy(key);
const scalarDescription=row=>row.kind==='well-known'?['str','Symbol.'+row.name]:copy(row.description);

export function createProtocolStateV8(){return {schema:PROTOCOL_STATE_V8_SCHEMA,
  symbols:WELL_KNOWN_SYMBOLS.map(name=>({id:'well-known:'+name,kind:'well-known',name})),pendingCalls:[],callFrames:[],sequence:0,
  ...Object.fromEntries(extensionStateFields.map(field=>[field,null]))};}
function state(controller){return controller.protocol??=createProtocolStateV8();}
export function protocolReservedIdentitiesV8(controller){
  return new Set([...controller.heap.keys(),...state(controller).symbols.map(row=>row.id),
    ...PROTOCOL_MACHINE_ADAPTERS_V8.flatMap(adapter=>adapter.reservedIdentities?.(controller)??[])]);
}
function symbol(controller,id){const result=state(controller).symbols.find(row=>row.id===id);
  require(result,'undeclared Symbol identity '+id);return result;}
function known(controller,value,self=null){
  validateProtocolValueV8(value);
  if(value[0]==='symbol')symbol(controller,value[1]);
  if(value[0]==='ref')require(value[1]===self||controller.heap.has(value[1]),'unallocated reference '+value[1]);
  return value;
}
function knownKey(controller,key){validateProtocolKeyV8(key);if(key[0]==='symbol')symbol(controller,key[1]);return key;}
function heapNode(controller,id){const node=controller.heap.get(id);
  require(node&&['object','array','closure'].includes(node.kind),'ordinary object or owned closure required');
  require(node.properties instanceof Map,'ordinary property map required');return node;}
function mapKey(map,key){
  if(!map)return undefined;
  for(const stored of map.keys())if(keyEqual(stored,key))return stored;
  return undefined;
}
function storedKey(node,key){
  const wanted=internalKey(key);
  return mapKey(node.properties,wanted)??mapKey(node.descriptors,wanted)??wanted;
}
function defaultMetadata(node,key){return node.kind==='array'&&key==='length'?
  {kind:'data',writable:true,enumerable:false,configurable:false}:
  {kind:'data',writable:true,enumerable:true,configurable:true};}
function ownDescriptor(node,key){
  const wanted=internalKey(key),property=mapKey(node.properties,wanted),
    descriptor=mapKey(node.descriptors,wanted),metadata=node.descriptors?.get(descriptor);
  if(metadata?.kind==='accessor')return copy(metadata);
  if(property===undefined)return null;
  return {...copy(metadata??defaultMetadata(node,property)),value:copy(node.properties.get(property))};
}
function order(node){
  const values=[...(node.keyOrder??[]),...node.properties.keys(),...(node.descriptors?.keys()??[])],result=[];
  for(const key of values)if(!result.some(other=>keyEqual(other,key))&&ownDescriptor(node,publicKey(key)))result.push(key);
  return [...result.filter(key=>index(key)).sort((a,b)=>Number(a)-Number(b)),
    ...result.filter(key=>typeof key==='string'&&!index(key)),...result.filter(symbolic)];
}
function installDescriptor(node,key,descriptor){
  const stored=storedKey(node,key),present=ownDescriptor(node,key)!==null;
  node.keyOrder??=order(node);node.descriptors??=new Map();node.extensible??=true;
  if(!present)node.keyOrder.push(stored);
  const priorProperty=mapKey(node.properties,stored),priorDescriptor=mapKey(node.descriptors,stored);
  if(priorProperty!==undefined)node.properties.delete(priorProperty);
  if(priorDescriptor!==undefined)node.descriptors.delete(priorDescriptor);
  if(descriptor.kind==='data'){
    const {value,...metadata}=descriptor;node.properties.set(stored,copy(value));node.descriptors.set(stored,copy(metadata));
  }else node.descriptors.set(stored,copy(descriptor));
}
function removeProperty(node,key){const stored=internalKey(key),property=mapKey(node.properties,stored),descriptor=mapKey(node.descriptors,stored);
  if(property!==undefined)node.properties.delete(property);
  if(descriptor!==undefined)node.descriptors.delete(descriptor);
  if(node.keyOrder)node.keyOrder=node.keyOrder.filter(item=>!keyEqual(item,stored));}
function compatibleDefinition(node,key,descriptor){
  const current=ownDescriptor(node,key);
  if(!current)return node.extensible!==false;
  if(current.configurable)return true;
  if(descriptor.configurable||descriptor.enumerable!==current.enumerable||descriptor.kind!==current.kind)return false;
  if(current.kind==='accessor')return eq(current.get,descriptor.get)&&eq(current.set,descriptor.set);
  return current.writable||!descriptor.writable&&eq(current.value,descriptor.value);
}
const objectIntrinsicNames=['constructor','__proto__','toString','toLocaleString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable',
  '__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__'];
function missingIntrinsic(node,key){
  if(key[0]==='symbol')return ['well-known:iterator','well-known:unscopables'].includes(key[1])&&node.kind==='array'||
    key[1]==='well-known:hasInstance'&&node.kind==='closure';
  const arrayNames=['at','concat','copyWithin','entries','every','fill','filter','find','findIndex','findLast','findLastIndex',
    'flat','flatMap','forEach','includes','indexOf','join','keys','lastIndexOf','map','pop','push','reduce','reduceRight',
    'reverse','shift','slice','some','sort','splice','toReversed','toSorted','toSpliced','unshift','values','with'];
  return objectIntrinsicNames.includes(key[1])||node.kind==='array'&&arrayNames.includes(key[1])||
    node.kind==='closure'&&['call','apply','bind','length','name','prototype','arguments','caller'].includes(key[1]);
}
function resolveProperty(controller,object,key,{forSet=false}={}){
  const visited=new Set();let current=object;
  for(;;){
    require(!visited.has(current),'cyclic prototype chain');visited.add(current);
    const node=heapNode(controller,current),descriptor=ownDescriptor(node,key);
    if(descriptor)return {owner:current,node,descriptor};
    const prototype=node.prototype===undefined?'ordinary':node.prototype;
    if(prototype===null)return {owner:null,node:null,descriptor:null};
    if(prototype==='ordinary'){
      // OrdinarySet needs only writability here. Do not invent the inherited
      // function's value or expose it through Get. __proto__ remains an
      // accessor requiring its separately modeled invocation.
      if(forSet&&key[0]==='str'&&key[1]!=='__proto__'&&objectIntrinsicNames.includes(key[1]))
        return {owner:null,node:null,descriptor:{kind:'data',writable:true}};
      require(!missingIntrinsic(node,key),'inherited intrinsic property requires its callable protocol');
      return {owner:null,node:null,descriptor:null};
    }
    known(controller,prototype);require(prototype[0]==='ref','prototype identity');current=prototype[1];
  }
}
function fresh(controller,id){require(!protocolReservedIdentitiesV8(controller).has(id),'duplicate allocation identity '+id);}
function setLocal(controller,name,value){known(controller,value);controller.locals.set(controller.captureAliases?.get(name)??name,copy(value));}
function locals(controller){const result=new Map(controller.locals);
  for(const [name,cell]of controller.captureAliases??[])result.set(name,controller.locals.get(cell));return result;}
function truthy(value){if(['ref','symbol'].includes(value[0]))return true;
  return evaluateWitnessExpression({op:'unary',operator:'!',arg:{op:'literal',value}}).value[1]===false;}
function evaluate(controller,expr){
  if(expr.op==='literal')return copy(known(controller,expr.value));
  if(expr.op==='local'){const scope=locals(controller);require(scope.has(expr.name),'unknown protocol local '+expr.name);return copy(known(controller,scope.get(expr.name)));}
  const left=evaluate(controller,expr.op==='unary'?expr.arg:expr.left),right=expr.op==='binary'?evaluate(controller,expr.right):null;
  if(expr.op==='unary'&&['symbol','ref'].includes(left[0])){
    if(expr.operator==='!')return ['bool',false];if(expr.operator==='void')return ['undefined'];
    if(expr.operator==='typeof')return ['str',left[0]==='symbol'?'symbol':controller.heap.get(left[1])?.kind==='closure'?'function':'object'];
    fail('numeric conversion of a behavioral value requires an abrupt/coercion boundary');
  }
  if(expr.op==='binary'&&(left[0]==='symbol'||right[0]==='symbol')){
    require(['===','!==','==','!='].includes(expr.operator),'Symbol conversion requires an abrupt boundary');
    if(['==','!='].includes(expr.operator))require(![left[0],right[0]].includes('ref'),'object/Symbol equality requires ToPrimitive');
    const same=left[0]==='symbol'&&right[0]==='symbol'&&left[1]===right[1];
    return ['bool',['===','=='].includes(expr.operator)?same:!same];
  }
  return evaluateWitnessExpression(expr.op==='unary'?{op:'unary',operator:expr.operator,arg:{op:'literal',value:left}}:
    {op:'binary',operator:expr.operator,left:{op:'literal',value:left},right:{op:'literal',value:right}}).value;
}
function callable(controller,value){known(controller,value);require(value[0]==='ref','owned callable reference required');
  const node=heapNode(controller,value[1]);require(node.kind==='closure'&&typeof node.code==='string','owned closure required');
  if(controller.strictRequests&&controller.source?.source){
    const functions=analyzeSemanticProgram(controller.source.source).functions;
    require(functions.some(fn=>fn.name===node.code||'function:'+fn.start===node.code)||
      PROTOCOL_MACHINE_ADAPTERS_V8.some(adapter=>adapter.hasSourceCallable?.(controller.source.source,node.code)===true),
      'callee is absent from immutable source');
  }
  return node;
}
function call(controller,record,options={}){
  for(const adapter of PROTOCOL_MACHINE_ADAPTERS_V8)if(adapter.assertCall)
    require(adapter.assertCall(controller,record.callee,options,PROTOCOL_MACHINE_API_V8)===true,'extension callable guard: '+adapter.id);
  const node=callable(controller,record.callee);known(controller,record.receiver);record.arguments.forEach(value=>known(controller,value));
  require(!controller.frameFunctions.has(record.child),'duplicate invocation');
  const protocol=state(controller);require(protocol.callFrames.length<PROTOCOL_V8_LIMITS.calls,'call stack bound');
  protocol.callFrames.push({child:record.child,parent:controller.stack.at(-1),
    priorReceiver:copy(controller.receiver??['undefined']),priorAliases:[...(controller.captureAliases??new Map())],
    arguments:copy(record.arguments)});
  controller.receiver=copy(node.functionKind==='arrow'?node.lexicalReceiver:record.receiver);
  controller.captureAliases=new Map(node.captures.map(row=>[row.binding,row.cell]));
  controller.locals.set(record.child+':this',copy(controller.receiver));
  record.arguments.forEach((value,index)=>controller.locals.set(record.child+':argument:'+index,copy(value)));
  controller.frameFunctions.set(record.child,node.code);controller.stack.push(record.child);
}
function allocate(controller,record){
  fresh(controller,record.name);const node={kind:record.objectKind,code:record.code,
    captures:record.captures.map(row=>({...row,cell:controller.captureAliases?.get(row.cell)??row.cell})),
    ...(record.objectKind==='closure'?{functionKind:record.functionKind,lexicalReceiver:copy(record.lexicalReceiver)}:{}),
    prototype:'ordinary',properties:new Map()};
  if(node.kind==='array')node.properties.set('length',['num',record.length]);
  for(const property of record.properties){
    knownKey(controller,property.key);known(controller,property.value,record.name);
    const key=storedKey(node,property.key);require(!node.properties.has(key),'duplicate allocation property');
    require(!(node.kind==='array'&&key==='length'),'length is declared separately');
    if(node.kind==='array'&&index(key))require(Number(key)<record.length,'array index exceeds initial length');
    node.properties.set(key,copy(property.value));
  }
  for(const capture of node.captures)require(controller.locals.has(controller.captureAliases?.get(capture.cell)??capture.cell),'capture cell is unavailable');
  if(node.kind==='closure'){require(!record.properties.length,'closure properties require explicit descriptors');
    if(node.functionKind==='arrow')known(controller,node.lexicalReceiver);}
  controller.heap.set(record.name,node);
}
function directSet(controller,record){
  known(controller,record.receiver);known(controller,record.value);
  require(record.receiver[0]==='ref','primitive receiver writes require an abrupt boundary');
  const receiver=heapNode(controller,record.receiver[1]),resolved=resolveProperty(controller,record.object,record.key,{forSet:true});
  require(resolved.descriptor?.kind!=='accessor'||resolved.descriptor.set[0]==='undefined','setter requires a checked call boundary');
  if(resolved.descriptor?.kind==='accessor'||resolved.descriptor?.writable===false)return false;
  const current=ownDescriptor(receiver,record.key);
  if(current&&(current.kind!=='data'||!current.writable)||!current&&receiver.extensible===false)return false;
  const storage=internalKey(record.key);
  if(receiver.kind==='array'&&storage==='length'){
    require(record.value[0]==='num'&&Number.isSafeInteger(record.value[1])&&record.value[1]>=0&&record.value[1]<=4096,
      'array length conversion requires a separate bounded operation');
    const length=record.value[1],old=receiver.properties.get('length')[1];
    if(length<old){
      const removed=order(receiver).filter(key=>index(key)&&Number(key)>=length);
      require(removed.every(key=>ownDescriptor(receiver,publicKey(key)).configurable),'partial ArraySetLength failure requires its protocol');
      for(const key of removed)removeProperty(receiver,publicKey(key));
    }
  }
  if(receiver.kind==='array'&&index(storage)&&Number(storage)>=receiver.properties.get('length')[1]){
    if(!ownDescriptor(receiver,['str','length']).writable)return false;
    receiver.properties.set('length',['num',Number(storage)+1]);
  }
  installDescriptor(receiver,record.key,{...(current??{kind:'data',writable:true,enumerable:true,configurable:true}),value:record.value});
  return true;
}
function apply(controller,record){
  const protocol=state(controller),pending=protocol.pendingCalls.at(-1);
  for(const adapter of PROTOCOL_MACHINE_ADAPTERS_V8)if(adapter.assertNext)
    require(adapter.assertNext(controller,record,PROTOCOL_MACHINE_API_V8)===true,'extension continuation guard: '+adapter.id);
  if(pending&&!controller.stack.includes(pending.child))require(record.kind==='property.finish','property call completion must be consumed first');
  require(controller.completion===null||controller.completion===undefined,'record after terminal completion');
  require(controller.stack.length||record.kind==='end','protocol work requires an active invocation');
  const adapter=PROTOCOL_MACHINE_ADAPTERS_V8.find(adapter=>Object.hasOwn(adapter.recordFields,record.kind));
  if(adapter){require(adapter.applyRecord(controller,record,PROTOCOL_MACHINE_API_V8)===true,'extension did not apply its declared record');return;}
  if(record.kind==='symbol.create'||record.kind==='symbol.for'){
    if(record.kind==='symbol.for'){
      const existing=protocol.symbols.find(row=>row.kind==='registry'&&row.key===record.key);
      if(existing){require(record.id===existing.id,'registry identity changed');return;}
    }
    require(protocol.symbols.length<PROTOCOL_V8_LIMITS.symbols,'Symbol count bound');
    fresh(controller,record.id);require(/^o[1-9][0-9]*$/.test(record.id),'owned Symbol identity must be oN');
    protocol.symbols.push(record.kind==='symbol.create'?{id:record.id,kind:'unique',description:copy(record.description)}:
      {id:record.id,kind:'registry',description:['str',record.key],key:record.key});
  }else if(record.kind==='symbol.read'){
    const row=symbol(controller,record.symbol[1]);let expected;
    if(record.operation==='description')expected=scalarDescription(row);
    else if(record.operation==='keyFor')expected=row.kind==='registry'?['str',row.key]:['undefined'];
    else{const d=scalarDescription(row);expected=['str','Symbol('+(d[0]==='str'?d[1]:'')+')'];}
    require(eq(record.result,expected),'false Symbol property/conversion claim');if(record.bind!==null)setLocal(controller,record.bind,record.result);
  }else if(record.kind==='allocate')allocate(controller,record);
  else if(record.kind==='bind')setLocal(controller,record.name,record.value);
  else if(record.kind==='compute'||record.kind==='choose'){
    const expected=evaluate(controller,record.expr),claimed=record.kind==='compute'?record.result:record.decision;
    require(eq(expected,claimed),'false protocol computation');
    if(record.kind==='compute'&&record.bind!==null)setLocal(controller,record.bind,record.result);
    if(record.kind==='choose')require(['then','use-left'].includes(record.path)===truthy(record.decision),'false protocol choice');
  }else if(record.kind==='call')call(controller,record);
  else if(record.kind==='return'||record.kind==='throw'){
    require(controller.stack.at(-1)===record.invocation,'completion has wrong active invocation');known(controller,record.value);
    require(!controller.activeJob,'job completion needs its declared scheduler profile');
    if(controller.stack.length>1){
      const frame=protocol.callFrames.at(-1);
      require(frame?.child===record.invocation&&frame.parent===controller.stack.at(-2),'call scope completion mismatch');
      controller.stack.pop();protocol.callFrames.pop();
      controller.receiver=copy(frame.priorReceiver);controller.captureAliases=new Map(frame.priorAliases);
      controller.lastReturn={kind:record.kind,value:copy(record.value)};
    }
    else{controller.stack.pop();controller.pending={kind:record.kind,value:copy(record.value)};}
  }else if(record.kind==='end'){
    require(!controller.stack.length&&!protocol.pendingCalls.length&&!protocol.callFrames.length&&controller.pending?.kind===record.completion,'terminal completion or obligations differ');
    require(!(controller.ready?.length)&&!(controller.effects?.size)&&!(controller.jobs?.size),'effect/job completion requires its scheduler profile');
    controller.completion=copy(controller.pending);
  }else if(record.kind==='property.finish'){
    require(pending&&pending.id===record.id&&controller.stack.at(-1)===pending.parent&&!controller.stack.includes(pending.child),
      'property completion lacks its exact returned call');
    const returned=controller.lastReturn;require(returned&&['return','throw'].includes(returned.kind),'property body has no completion');
    const expected={kind:returned.kind==='throw'?'throw':'normal',
      value:copy(returned.kind==='throw'||pending.operation==='get'?returned.value:pending.value)};
    require(eq(record.completion,expected),'false property completion');protocol.pendingCalls.pop();
  }else{
    const node=heapNode(controller,record.object);
    if(Object.hasOwn(record,'key'))knownKey(controller,record.key);
    if(record.kind==='property.define'){
      validateProtocolDescriptorV8(record.descriptor);
      if(record.descriptor.kind==='data')known(controller,record.descriptor.value);
      else for(const value of [record.descriptor.get,record.descriptor.set])if(value[0]!=='undefined')callable(controller,value);
      require(!(node.kind==='array'&&record.key[0]==='str'&&(record.key[1]==='length'||index(record.key[1]))),
        'array index/length descriptor changes require ArraySetLength protocol');
      const success=compatibleDefinition(node,record.key,record.descriptor);require(record.success===success,'false descriptor compatibility claim');
      if(success)installDescriptor(node,record.key,record.descriptor);
    }else if(record.kind==='property.get'){
      known(controller,record.receiver);const {descriptor}=resolveProperty(controller,record.object,record.key);
      require(!descriptor||descriptor.kind==='data'||descriptor.get[0]==='undefined','getter requires a checked call boundary');
      const expected=descriptor?.kind==='data'?descriptor.value:['undefined'];require(eq(expected,record.result),'false property read');known(controller,record.result);
    }else if(record.kind==='property.set'){
      const success=directSet(controller,record);require(record.success===success,'false property write result');
    }else if(record.kind==='property.delete'){
      const descriptor=ownDescriptor(node,record.key),success=!descriptor||descriptor.configurable;
      require(record.success===success,'false property deletion result');if(success)removeProperty(node,record.key);
    }else if(record.kind==='property.keys'){
      let keys=order(node).map(publicKey);
      if(record.mode==='strings'||record.mode==='enumerable-strings')keys=keys.filter(key=>key[0]==='str');
      if(record.mode==='symbols')keys=keys.filter(key=>key[0]==='symbol');
      if(record.mode==='enumerable-strings')keys=keys.filter(key=>ownDescriptor(node,key).enumerable);
      require(eq(keys,record.keys),'false own-key order or filtering');
      allocate(controller,{name:record.name,objectKind:'array',length:keys.length,code:null,captures:[],
        properties:keys.map((value,index)=>({key:['str',String(index)],value}))});
    }else if(record.kind==='property.prototype'){
      let success=true;const before=node.prototype===undefined?'ordinary':node.prototype;
      if(!eq(before,record.prototype)&&node.extensible===false)success=false;
      if(Array.isArray(record.prototype)){
        known(controller,record.prototype);let id=record.prototype[1],visited=new Set();
        for(;;){if(id===record.object){success=false;break;}require(!visited.has(id),'existing prototype cycle');visited.add(id);
          const next=heapNode(controller,id).prototype;if(!Array.isArray(next))break;id=next[1];}
      }
      require(record.success===success,'false prototype transition result');if(success)node.prototype=copy(record.prototype);
    }else if(record.kind==='property.preventExtensions')node.extensible=false;
    else if(record.kind==='property.get.call'||record.kind==='property.set.call'){
      const operation=record.kind==='property.get.call'?'get':'set',resolved=resolveProperty(controller,record.object,record.key),
        callee=resolved.descriptor?.kind==='accessor'?resolved.descriptor[operation]:null;
      require(callee&&callee[0]==='ref','property has no callable '+operation);known(controller,record.receiver);
      require(protocol.pendingCalls.length<PROTOCOL_V8_LIMITS.calls&&!protocol.pendingCalls.some(row=>row.id===record.id),'property call bound or duplicate identity');
      const parent=controller.stack.at(-1);call(controller,{child:record.child,callee,receiver:record.receiver,
        arguments:operation==='get'?[]:[record.value]});
      protocol.pendingCalls.push({id:record.id,operation,child:record.child,parent,object:record.object,
        key:copy(record.key),receiver:copy(record.receiver),callee:copy(callee),value:operation==='get'?null:copy(record.value)});
    }else fail('unsupported protocol transition');
  }
}

/** Commit exactly the supplied claim after all preconditions pass on a copy. */
export function applyProtocolRecordV8(controller,record){
  validateProtocolRecordV8(record);
  if(!controller.protocol)require(controller.stack.length===1,'first protocol transition cannot inherit an unmodeled nested call scope');
  const fields=['heap','locals','receiver','captureAliases','stack','frameFunctions','pending','lastReturn','completion','protocol'];
  const staged=Object.assign(Object.create(Object.getPrototypeOf(controller)),controller);
  for(const field of fields)staged[field]=copy(field==='protocol'?controller.protocol??createProtocolStateV8():controller[field]);
  require(staged.protocol.sequence<PROTOCOL_V8_LIMITS.steps,'protocol step bound');
  apply(staged,record);staged.protocol.sequence++;
  for(const field of fields)controller[field]=staged[field];
  return {status:'committed',kind:record.kind,sequence:controller.protocol.sequence,completion:copy(controller.completion??null)};
}
export function snapshotProtocolStateV8(controller){return copy(state(controller));}
export function restoreProtocolStateV8(controller,snapshot){
  assertAlgorithmFields(snapshot,PROTOCOL_STATE_V8_FIELDS,'protocol shared state');
  require(snapshot.schema===PROTOCOL_STATE_V8_SCHEMA&&Number.isSafeInteger(snapshot.sequence)&&snapshot.sequence>=0&&
    snapshot.sequence<=PROTOCOL_V8_LIMITS.steps,'protocol state schema or sequence');
  assertAlgorithmDataArray(snapshot.symbols,'protocol symbols');
  for(const row of snapshot.symbols){require(isAlgorithmDataRecord(row),'symbol declaration must be ordinary data');
    if(row.kind!=='well-known')validateProtocolValueV8(row.description);}
  validateProtocolSymbols({schema:'semantic-protocol-values/1',symbols:snapshot.symbols});
  require(snapshot.symbols.length<=PROTOCOL_V8_LIMITS.symbols&&WELL_KNOWN_SYMBOLS.every(name=>
    snapshot.symbols.some(row=>row.id==='well-known:'+name&&row.kind==='well-known')),'complete Symbol intrinsic table required');
  assertAlgorithmDataArray(snapshot.pendingCalls,'pending protocol calls');
  require(snapshot.pendingCalls.length<=PROTOCOL_V8_LIMITS.calls,'pending call bound');
  const temporary={...controller,protocol:copy(snapshot)},seen=new Set();
  for(const pending of snapshot.pendingCalls){
    assertAlgorithmFields(pending,['id','operation','child','parent','object','key','receiver','callee','value'],'pending property call');
    require(typeof pending.id==='string'&&!seen.has(pending.id)&&['get','set'].includes(pending.operation),'pending call identity');seen.add(pending.id);
    heapNode(temporary,pending.object);knownKey(temporary,pending.key);known(temporary,pending.receiver);callable(temporary,pending.callee);
    require(controller.frameFunctions.has(pending.child)&&controller.frameFunctions.has(pending.parent),'pending call frames');
    if(pending.operation==='get')require(pending.value===null,'getter has no assignment operand');else known(temporary,pending.value);
  }
  assertAlgorithmDataArray(snapshot.callFrames,'protocol call frames');
  require(snapshot.callFrames.length<=PROTOCOL_V8_LIMITS.calls,'call frame bound');
  for(let i=0;i<snapshot.callFrames.length;i++){
    const frame=snapshot.callFrames[i];
    assertAlgorithmFields(frame,['child','parent','priorReceiver','priorAliases','arguments'],'protocol call frame');
    require(typeof frame.child==='string'&&typeof frame.parent==='string'&&
      controller.stack.indexOf(frame.child)===controller.stack.indexOf(frame.parent)+1&&
      controller.stack.includes(frame.child)&&(!i||snapshot.callFrames[i-1].child===frame.parent),'call frame stack relationship');
    known(temporary,frame.priorReceiver);assertAlgorithmDataArray(frame.priorAliases,'prior capture aliases');
    const aliases=new Set();for(const pair of frame.priorAliases){assertAlgorithmDataArray(pair,'capture alias');
      require(pair.length===2&&pair.every(value=>typeof value==='string')&&!aliases.has(pair[0])&&controller.locals.has(pair[1]),'capture alias binding');aliases.add(pair[0]);}
    assertAlgorithmDataArray(frame.arguments,'call arguments');frame.arguments.forEach(value=>known(temporary,value));
  }
  for(const row of snapshot.symbols)require(!controller.heap.has(row.id),'Symbol/object identity collision');
  for(const [id,node]of controller.heap){
    if(!['object','array','closure'].includes(node.kind)){
      require(PROTOCOL_MACHINE_ADAPTERS_V8.some(adapter=>adapter.hasRichState?.(node)),'undeclared protocol heap kind');continue;
    }
    heapNode(temporary,id);const keys=[];
    for(const [key,value]of node.properties){knownKey(temporary,publicKey(key));known(temporary,value);
      require(!keys.some(other=>keyEqual(other,key)),'duplicate semantic property key');keys.push(key);}
    const described=[];
    if(node.descriptors!==undefined){require(node.descriptors instanceof Map,'descriptor map');
      for(const [key,metadata]of node.descriptors){knownKey(temporary,publicKey(key));
        require(!described.some(other=>keyEqual(other,key)),'duplicate semantic descriptor key');described.push(key);
        const descriptor=ownDescriptor(node,publicKey(key));require(descriptor,'data descriptor missing its value');
        validateProtocolDescriptorV8(descriptor);
        if(metadata.kind==='accessor'){
          require(mapKey(node.properties,key)===undefined,'accessor also stores a data value');
          for(const value of [descriptor.get,descriptor.set])if(value[0]!=='undefined')callable(temporary,value);
        }
      }
    }
    if(node.keyOrder!==undefined){assertAlgorithmDataArray(node.keyOrder,'property creation order');
      const ordered=[];for(const key of node.keyOrder){knownKey(temporary,publicKey(key));
        require(!ordered.some(other=>keyEqual(other,key))&&ownDescriptor(node,publicKey(key)),'invalid or duplicate property order');ordered.push(key);}
      require([...keys,...described].every(key=>ordered.some(other=>keyEqual(other,key))),'property creation order is incomplete');}
    if(node.extensible!==undefined)require(typeof node.extensible==='boolean','extensible flag');
    const prototype=node.prototype===undefined?'ordinary':node.prototype;if(prototype!==null&&prototype!=='ordinary'){
      known(temporary,prototype);require(prototype[0]==='ref','prototype reference');heapNode(temporary,prototype[1]);}
  }
  const extensionIdentities=new Set([...controller.heap.keys(),...snapshot.symbols.map(row=>row.id)]);
  for(const adapter of PROTOCOL_MACHINE_ADAPTERS_V8){
    const additional=adapter.stateField===undefined?null:snapshot[adapter.stateField];
    if(adapter.stateField!==undefined&&additional===null){
      require(![...controller.heap.values()].some(node=>adapter.hasRichState?.(node)),'extension heap state lacks its declared protocol state');
    }else{
      require(typeof adapter.restoreState==='function','extension requires complete restored-state validation');
      require(adapter.restoreState(temporary,additional,PROTOCOL_MACHINE_API_V8)?.valid===true,'extension state validation failed');
    }
    for(const id of adapter.reservedIdentities?.(temporary)??[]){
      require(typeof id==='string'&&id&&!extensionIdentities.has(id),'extension identity collision');extensionIdentities.add(id);
    }
  }
  controller.protocol=copy(snapshot);return {valid:true,symbols:snapshot.symbols.length,pendingCalls:snapshot.pendingCalls.length};
}
function rich(node){return [...(node.descriptors??[])].some(([key,metadata])=>metadata.kind!=='data'||!eq(metadata,defaultMetadata(node,key)))||node.extensible===false||
  ![undefined,null,'ordinary'].includes(node.prototype)||[...node.properties.keys()].some(symbolic)||
  PROTOCOL_MACHINE_ADAPTERS_V8.some(adapter=>adapter.hasRichState?.(node));}
export function assertProtocolDetailCompatible(controller,record){
  for(const adapter of PROTOCOL_MACHINE_ADAPTERS_V8)if(adapter.assertNext)
    require(adapter.assertNext(controller,record,PROTOCOL_MACHINE_API_V8)===true,'extension detailed continuation guard: '+adapter.id);
  const pending=controller.protocol?.pendingCalls.at(-1);
  if(pending&&!controller.stack.includes(pending.child))fail('pending property completion requires protocol finish');
  function inspect(value){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)&&value[0]==='symbol')fail('Symbol values require protocol records');
    if(value.op==='read')require(!rich(heapNode(controller,value.object)),'detailed read bypasses descriptor/prototype protocol');
    for(const child of Object.values(value))inspect(child);
  }
  if(controller.protocol&&record.kind==='allocate')require(!protocolReservedIdentitiesV8(controller).has(record.fields.name),'detailed allocation collides with a reserved Symbol/object identity');
  if(controller.protocol&&(record.kind==='call'||['return','throw'].includes(record.kind)&&(controller.protocol.callFrames.length||controller.stack.length>1)))
    fail('active protocol calls require scoped call/completion records');
  inspect(record.fields);
  if(['read','write'].includes(record.kind))require(!rich(heapNode(controller,record.fields.object)),'detailed property transition bypasses rich state');
  if(record.kind==='end')require(!controller.protocol?.pendingCalls.length,'unfinished protocol call');
  return true;
}
/** Conservative whole-heap guard; no accessor, key or guest hook is executed. */
export function protocolOrdinaryHeapViewV8(controller,{roots=null}={}){
  const queue=roots===null?[...controller.heap.keys()]:[],visited=new Set();
  if(roots!==null){assertAlgorithmDataArray(roots,'compact root values');for(const value of roots){
    known(controller,value);require(value[0]!=='symbol','compact values do not include Symbols');if(value[0]==='ref')queue.push(value[1]);}}
  while(queue.length){const id=queue.shift();if(visited.has(id))continue;visited.add(id);
    const node=heapNode(controller,id);require(!rich(node),'compact eligibility requires an ordinary data heap view');
    for(const value of node.properties.values()){
      require(value[0]!=='symbol','compact data may not contain Symbols');if(value[0]==='ref')queue.push(value[1]);}
  }
  return controller.heap;
}

/** Descriptor-only inspection for source certification and state diagnostics. */
export function describeProtocolObjectV8(controller,id){
  const node=heapNode(controller,id);
  return {kind:node.kind,prototype:copy(node.prototype===undefined?'ordinary':node.prototype),extensible:node.extensible!==false,
    properties:order(node).map(key=>({key:publicKey(key),descriptor:ownDescriptor(node,publicKey(key))})),
    ...(node.kind==='closure'?{code:node.code,functionKind:node.functionKind??'ordinary',lexicalReceiver:node.lexicalReceiver??null}:{})};
}

/** Trusted component interface. Public records never carry options or adapters. */
export const PROTOCOL_MACHINE_API_V8=Object.freeze({require,fail,copy,eq,state,known,knownKey,heapNode,
  ownDescriptor,installDescriptor,order,fresh,call,allocate,setLocal,truthy});
