// Explicit Number(value) conversion on the shared heap and call scope. Guest
// methods are entered by records; only scalar Number conversion is a host leaf.
import {encode,decode} from '../values.js';
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';

export const NUMBER_STATE_V8_SCHEMA='semantic-number-conversion-state/1';
export const NUMBER_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'number.begin':['kind','id','value'],
  'number.select':['kind','id','key','method','builtin'],
  'number.call':['kind','id','child'],
  'number.builtin':['kind','id','result'],
  'number.return':['kind','id','value'],
  'number.finish':['kind','id','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const NUMBER_OPERATION_FIELDS=Object.freeze(['id','parent','input','index','method','builtin','child','phase','primitive','result']);
const primitive=value=>['undefined','null','bool','str','num','bigint','symbol'].includes(value?.[0]);
const numeric=value=>['undefined','null','bool','str','num','bigint'].includes(value?.[0]);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Number conversion identity');};
function state(controller,api){return api.state(controller).numberConversions??={schema:NUMBER_STATE_V8_SCHEMA,operations:[]};}
function operation(controller,id,api){const row=controller.protocol?.numberConversions?.operations.find(row=>row.id===id);api.require(row,'unknown Number conversion');return row;}
function scalarBound(value,api){
  if(['str','bigint'].includes(value?.[0]))api.require(value[1].length<=10000,'Number scalar conversion bound');
}
const keyFor=index=>index===-1?['symbol','well-known:toPrimitive']:['str',index===0?'valueOf':'toString'];
function lookup(controller,input,key,api){
  let current=input[1];const seen=new Set();
  for(;;){
    api.require(!seen.has(current),'cyclic Number conversion prototype');seen.add(current);
    const node=api.heapNode(controller,current),descriptor=api.ownDescriptor(node,key);
    if(descriptor){api.require(descriptor.kind==='data','conversion method accessor needs its getter continuation');return {method:descriptor.value,builtin:null};}
    const prototype=node.prototype??'ordinary';
    if(node.prototype===null)return {method:['undefined'],builtin:null};
    if(prototype==='ordinary'){
      if(key[0]==='str'&&key[1]==='valueOf')return {method:['undefined'],builtin:'Object.valueOf'};
      if(key[0]==='str'&&key[1]==='toString'){
        api.require(node.kind!=='array','array stringification needs its array protocol');return {method:['undefined'],builtin:'Object.toString'};
      }
      return {method:['undefined'],builtin:null};
    }
    api.known(controller,prototype);api.require(prototype[0]==='ref','conversion prototype identity');current=prototype[1];
  }
}
function acceptPrimitive(row,value,api){
  if(primitive(value)){scalarBound(value,api);row.primitive=api.copy(value);row.phase='convert';return;}
  api.require(row.index!==-1,'Symbol.toPrimitive object result requires a guest abrupt-conversion record');
  api.require(row.index===0,'OrdinaryToPrimitive exhaustion requires a guest abrupt-conversion record');
  row.index=1;row.method=null;row.builtin=null;row.child=null;row.phase='select';
}
export function validateNumberRecordV8(record,{value}){
  const fields=NUMBER_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'Number conversion record');id(record.id);
  if(record.kind==='number.call')id(record.child);
  else if(record.kind==='number.select'){
    value(record.key);if(!['str','symbol'].includes(record.key[0]))throw new TypeError('Number conversion property key');value(record.method);
    if(![null,'Object.valueOf','Object.toString'].includes(record.builtin))throw new TypeError('Number conversion builtin identity');
  }else value(record.kind==='number.begin'||record.kind==='number.return'?record.value:record.result);
  return true;
}
export function assertNumberNextV8(controller,record,api){
  const pending=controller.protocol?.numberConversions?.operations.findLast(row=>row.phase!=='complete');
  if(!pending)return true;
  if(pending.phase==='waiting'&&controller.stack.includes(pending.child))return true;
  api.require(controller.stack.at(-1)===pending.parent,'Number conversion continuation owner');
  const expected={select:'number.select',call:'number.call',builtin:'number.builtin',waiting:'number.return',convert:'number.finish'}[pending.phase];
  api.require(record.kind===expected&&record.id===pending.id,'pending Number conversion requires '+expected);return true;
}
export function applyNumberRecordV8(controller,record,api){
  if(!NUMBER_RECORD_FIELDS[record.kind])return false;
  const {require,copy,eq,known}=api;
  if(record.kind==='number.begin'){
    known(controller,record.value);
    const conversions=controller.protocol?.numberConversions;
    require((conversions?.operations.length??0)<4096&&!conversions?.operations.some(row=>row.id===record.id),'Number operation identity/bound');
    require(controller.stack.length,'Number conversion requires an active invocation');
    const scalar=primitive(record.value);
    if(scalar)scalarBound(record.value,api);
    else require(record.value[0]==='ref'&&['object','array'].includes(api.heapNode(controller,record.value[1]).kind),'Number conversion requires ordinary object state');
    state(controller,api).operations.push({id:record.id,parent:controller.stack.at(-1),input:copy(record.value),index:-1,method:null,builtin:null,child:null,
      phase:scalar?'convert':'select',primitive:scalar?copy(record.value):null,result:null});return true;
  }
  const row=operation(controller,record.id,api);
  require(controller.stack.at(-1)===row.parent,'Number conversion record is outside its caller');
  if(record.kind==='number.select'){
    require(row.phase==='select'&&eq(record.key,keyFor(row.index)),'Number conversion method order');
    api.knownKey(controller,record.key);known(controller,record.method);
    const found=lookup(controller,row.input,record.key,api);
    require(eq(found,{method:record.method,builtin:record.builtin}),'false Number conversion method selection');
    let index=row.index,method=copy(record.method),phase;
    if(record.builtin!==null)phase='builtin';
    else if(row.index===-1&&['undefined','null'].includes(record.method[0])){
      index=0;method=null;phase='select';
    }else if(record.method[0]==='ref'&&controller.heap.get(record.method[1]).kind==='closure')phase='call';
    else{
      require(row.index!==-1,'noncallable Symbol.toPrimitive requires a guest abrupt-conversion record');
      require(row.index===0,'OrdinaryToPrimitive exhaustion requires a guest abrupt-conversion record');
      index=1;method=null;phase='select';
    }
    Object.assign(row,{index,method,builtin:record.builtin,phase});
  }else if(record.kind==='number.call'){
    require(row.phase==='call','Number callback requires a captured callable');
    api.call(controller,{child:record.child,callee:row.method,receiver:row.input,
      arguments:row.index===-1?[['str','number']]:[]});row.child=record.child;row.phase='waiting';
  }else if(record.kind==='number.builtin'){
    require(row.phase==='builtin','Number builtin requires a captured intrinsic');
    let expected=row.input;
    if(row.builtin==='Object.toString'){
      const tag=lookup(controller,row.input,['symbol','well-known:toStringTag'],api).method,
        object=api.heapNode(controller,row.input[1]);
      expected=['str','[object '+(tag[0]==='str'?tag[1]:object.kind==='array'?'Array':'Object')+']'];
    }
    require(eq(record.result,expected),'false intrinsic conversion result');acceptPrimitive(row,expected,api);
  }else if(record.kind==='number.return'){
    require(row.phase==='waiting'&&!controller.stack.includes(row.child)&&controller.lastReturn?.kind==='return'&&
      eq(controller.lastReturn.value,record.value),'Number callback completion differs');
    known(controller,record.value);acceptPrimitive(row,record.value,api);
  }else{
    require(row.phase==='convert'&&numeric(row.primitive),'Number conversion abrupt result requires its own protocol');
    scalarBound(row.primitive,api);
    const expected=encode(Number(decode(row.primitive)));known(controller,record.result);
    require(eq(record.result,expected),'false Number scalar conversion');row.result=copy(expected);row.phase='complete';
    controller.lastReturn={kind:'return',value:copy(expected)};
  }
  return true;
}
export function restoreNumberStateV8(controller,snapshot,api){
  if(snapshot===null)return {valid:true,operations:0};
  assertAlgorithmFields(snapshot,['schema','operations'],'Number conversion state');
  api.require(snapshot.schema===NUMBER_STATE_V8_SCHEMA,'Number conversion state schema');
  assertAlgorithmDataArray(snapshot.operations,'Number conversion operations');api.require(snapshot.operations.length<=4096,'Number operation bound');
  const seen=new Set();
  for(const row of snapshot.operations){
    assertAlgorithmFields(row,NUMBER_OPERATION_FIELDS,'Number conversion continuation');id(row.id);id(row.parent);
    api.require(!seen.has(row.id),'duplicate Number operation');seen.add(row.id);
    api.require(controller.frameFunctions.has(row.parent)&&[-1,0,1].includes(row.index)&&
      ['select','call','builtin','waiting','convert','complete'].includes(row.phase),'Number continuation phase/owner');
    if(row.phase!=='complete')api.require(controller.stack.includes(row.parent),'unfinished Number conversion requires a live parent');
    api.known(controller,row.input);
    for(const value of [row.method,row.primitive,row.result])if(value!==null)api.known(controller,value);
    if(['str','bigint'].includes(row.primitive?.[0]))api.require(row.primitive[1].length<=10000,'Number retained scalar bound');
    api.require([null,'Object.valueOf','Object.toString'].includes(row.builtin),'Number continuation builtin');
    if(row.child!==null){id(row.child);api.require(controller.frameFunctions.has(row.child),'Number callback identity');}
    if(primitive(row.input))api.require(row.index===-1&&row.method===null&&row.builtin===null&&row.child===null&&
      api.eq(row.primitive,row.input)&&['convert','complete'].includes(row.phase),'primitive Number entry state');
    if(row.phase==='select')api.require(row.method===null&&row.builtin===null&&row.child===null,'Number pending selection state');
    if(['call','builtin'].includes(row.phase))api.require(row.child===null,'unentered Number callback identity');
    if(['select','call','builtin','waiting'].includes(row.phase))api.require(row.input[0]==='ref'&&row.primitive===null&&row.result===null,'object conversion phase values');
    if(['call','waiting'].includes(row.phase))api.require(row.method?.[0]==='ref'&&api.heapNode(controller,row.method[1]).kind==='closure'&&row.builtin===null,'captured Number callback');
    if(row.phase==='waiting'){
      api.require(row.child!==null&&controller.frameFunctions.get(row.child)===api.heapNode(controller,row.method[1]).code,'Number callback source identity');
      if(controller.stack.includes(row.child))api.require(controller.stack.indexOf(row.child)===controller.stack.indexOf(row.parent)+1,'Number callback stack');
    }
    if(row.phase==='builtin')api.require(row.builtin!==null&&row.method?.[0]==='undefined','Number intrinsic state');
    if(['convert','complete'].includes(row.phase))api.require(primitive(row.primitive),'Number primitive is absent');
    if(row.phase==='complete')api.require(numeric(row.primitive)&&api.eq(row.result,encode(Number(decode(row.primitive)))),'Number completed scalar is false');
    else api.require(row.result===null,'unfinished Number conversion has a result');
  }
  return {valid:true,operations:seen.size};
}
