// One independently checked public ToPrimitive continuation for explicit Number
// conversion and property keys. Guest getters/methods run only through owned
// call records; scalar leaves never invoke guest code in the host.
import {encode,decode} from '../values.js';
import {assertAlgorithmFields,assertAlgorithmDataArray} from './ir.js';
import {lookupConversionPropertyV8 as lookup,assertSupportedConversionMethodV8} from './protocol-conversion-lookup-v8.js';
import {allocateIntrinsicErrorV8} from './protocol-intrinsic-error-v8.js';

export const PRIMITIVE_CONVERSION_PROFILE_V8='primitive-conversion/1';
export const PRIMITIVE_CONVERSION_STATE_V8_SCHEMA='semantic-primitive-conversion-state/1';
export const PRIMITIVE_CONVERSION_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'conversion.begin':['kind','id','goal','value'],
  'conversion.lookup':['kind','id','key','descriptor','value','builtin'],
  'conversion.getter.call':['kind','id','child'],
  'conversion.getter.return':['kind','id','value'],
  'conversion.call':['kind','id','child'],
  'conversion.return':['kind','id','value'],
  'conversion.builtin':['kind','id','result'],
  'conversion.throw':['kind','id','value'],
  'conversion.fault':['kind','id','error'],
  'conversion.finish':['kind','id','result']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
export const PRIMITIVE_CONVERSION_OPERATION_FIELDS=Object.freeze([
  'id','parent','goal','input','index','phase','lookupKind','method','builtin','child','candidate','result','fault'
]);
export const PRIMITIVE_CONVERSION_PHASES_V8=Object.freeze([
  'lookup','getter-call','getter-waiting','call','waiting','builtin','finish','fault','complete','abrupt'
]);
export const PRIMITIVE_CONVERSION_FAULTS_V8=Object.freeze({
  'symbol-to-number':'Cannot convert a Symbol value to a number',
  'exotic-not-callable':'Symbol.toPrimitive is not callable',
  'exotic-nonprimitive':'Symbol.toPrimitive must return a primitive',
  'ordinary-exhausted':'Cannot convert object to primitive value'
});
export const PRIMITIVE_CONVERSION_BUILTINS_V8=Object.freeze(['Object.valueOf','Object.toString','Array.toString']);
const goals=['Number','PropertyKey'],descriptors=['missing','data','accessor','builtin'];
const primitive=value=>['undefined','null','bool','str','num','bigint','symbol'].includes(value?.[0]);
const id=value=>{if(typeof value!=='string'||!value||value.length>256)throw new TypeError('Primitive conversion identity');};
const hint=row=>row.goal==='Number'?'number':'string';
const keyFor=row=>row.index===-1?['symbol','well-known:toPrimitive']:
  ['str',(row.goal==='Number'?['valueOf','toString']:['toString','valueOf'])[row.index]];
const callable=(controller,value)=>value?.[0]==='ref'&&controller.heap.get(value[1])?.kind==='closure';
const terminal=row=>['complete','abrupt'].includes(row.phase);
function scalarBound(value,api){if(['str','bigint'].includes(value?.[0]))api.require(value[1].length<=10000,'primitive scalar conversion bound');}
function state(controller,api){return api.state(controller).primitiveConversions??={schema:PRIMITIVE_CONVERSION_STATE_V8_SCHEMA,operations:[]};}
function operation(controller,id,api){const row=controller.protocol?.primitiveConversions?.operations.find(row=>row.id===id);
  api.require(row,'unknown primitive conversion');return row;}

function scalarResult(row,api){
  api.require(primitive(row.candidate),'conversion scalar candidate');scalarBound(row.candidate,api);
  if(row.goal==='PropertyKey')return row.candidate[0]==='symbol'?api.copy(row.candidate):['str',String(decode(row.candidate))];
  api.require(row.candidate[0]!=='symbol','Symbol Number conversion requires its derived fault');
  return encode(Number(decode(row.candidate)));
}
function nextLookup(row,index){Object.assign(row,{index,phase:'lookup',lookupKind:null,method:null,builtin:null,child:null,candidate:null,fault:null});}
function fault(row,cause,candidate,api){Object.assign(row,{phase:'fault',child:null,candidate:api.copy(candidate),fault:cause});}
function acceptCandidate(row,value,api){
  row.child=null;
  if(primitive(value)){
    scalarBound(value,api);row.candidate=api.copy(value);
    if(row.goal==='Number'&&value[0]==='symbol')fault(row,'symbol-to-number',value,api);
    else row.phase='finish';
  }else if(row.index===-1)fault(row,'exotic-nonprimitive',value,api);
  else if(row.index===0)nextLookup(row,1);
  else fault(row,'ordinary-exhausted',value,api);
}
function selectMethod(controller,row,value,api){
  assertSupportedConversionMethodV8(controller,value,api);
  row.method=api.copy(value);row.builtin=null;row.child=null;
  if(row.index===-1&&['undefined','null'].includes(value[0]))nextLookup(row,0);
  else if(callable(controller,value))row.phase='call';
  else if(row.index===-1)fault(row,'exotic-not-callable',value,api);
  else if(row.index===0)nextLookup(row,1);
  else fault(row,'ordinary-exhausted',value,api);
}
function builtinResult(controller,row,api){
  if(row.builtin==='Object.valueOf')return api.copy(row.input);
  if(row.builtin==='Object.toString'){
    const found=lookup(controller,row.input,['symbol','well-known:toStringTag'],api),node=api.heapNode(controller,row.input[1]);
    api.require(found.descriptor!=='accessor','toStringTag getter requires its own continuation');
    return ['str','[object '+(found.value[0]==='str'?found.value[1]:node.kind==='array'?'Array':'Object')+']'];
  }
  api.require(row.builtin==='Array.toString','unknown primitive conversion builtin');
  const node=api.heapNode(controller,row.input[1]);api.require(node.kind==='array','Array.toString requires an ordinary array');
  api.require(lookup(controller,row.input,['str','join'],api).builtin==='Array.prototype.join',
    'Array.toString join override requires its own continuation');
  const length=api.ownDescriptor(node,['str','length']);
  api.require(length?.kind==='data'&&length.value[0]==='num'&&Number.isSafeInteger(length.value[1])&&
    length.value[1]>=0&&length.value[1]<=10000,'Array.toString length bound');
  const values=[];
  for(let i=0;i<length.value[1];i++){
    const descriptor=api.ownDescriptor(node,['str',String(i)]),value=descriptor?.value;
    api.require(descriptor?.kind==='data'&&primitive(value)&&value[0]!=='symbol','Array.toString requires dense own scalar elements');
    scalarBound(value,api);values.push(['null','undefined'].includes(value[0])?'':String(decode(value)));
  }
  const result=['str',values.join(',')];scalarBound(result,api);return result;
}
function assertDerivedFault(controller,row,api){
  const {require,eq}=api;
  assertSupportedConversionMethodV8(controller,row.method,api);
  require(Object.hasOwn(PRIMITIVE_CONVERSION_FAULTS_V8,row.fault),'unknown primitive conversion fault');
  if(row.fault==='symbol-to-number')require(row.goal==='Number'&&row.candidate?.[0]==='symbol'&&
    (primitive(row.input)||callable(controller,row.method)),'false Symbol Number fault');
  else if(row.fault==='exotic-not-callable')require(row.index===-1&&row.builtin===null&&row.method!==null&&
    !['undefined','null'].includes(row.method[0])&&!callable(controller,row.method)&&eq(row.candidate,row.method),'false noncallable exotic fault');
  else if(row.fault==='exotic-nonprimitive')require(row.index===-1&&row.builtin===null&&callable(controller,row.method)&&
    row.candidate!==null&&!primitive(row.candidate),'false exotic nonprimitive fault');
  else require(row.index===1&&row.candidate!==null&&
    (row.builtin!==null?row.builtin==='Object.valueOf'&&eq(row.candidate,row.input):
      callable(controller,row.method)?!primitive(row.candidate):eq(row.candidate,row.method)),
    'false ordinary exhaustion fault');
}

export function validatePrimitiveConversionRecordV8(record,{value}){
  const fields=PRIMITIVE_CONVERSION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'primitive conversion record');id(record.id);
  if(record.kind==='conversion.begin'){
    if(!goals.includes(record.goal))throw new TypeError('Primitive conversion goal');value(record.value);
  }else if(['conversion.call','conversion.getter.call'].includes(record.kind))id(record.child);
  else if(record.kind==='conversion.fault'){id(record.error);value(['ref',record.error]);}
  else if(record.kind==='conversion.lookup'){
    value(record.key);if(!['str','symbol'].includes(record.key[0]))throw new TypeError('Primitive conversion property key');
    value(record.value);if(!descriptors.includes(record.descriptor))throw new TypeError('Primitive conversion descriptor');
    if(record.builtin!==null&&!PRIMITIVE_CONVERSION_BUILTINS_V8.includes(record.builtin))throw new TypeError('Primitive conversion builtin');
  }else value(['conversion.builtin','conversion.finish'].includes(record.kind)?record.result:record.value);
  return true;
}
export function assertPrimitiveConversionNextV8(controller,record,api){
  const pending=controller.protocol?.primitiveConversions?.operations.findLast(row=>!terminal(row));if(!pending)return true;
  if(['lookup','getter-call','call','builtin','finish','fault'].includes(pending.phase)&&record.kind==='transfer'&&record.fields?.kind==='cleanup'&&
    api.eq(record.fields.value,['undefined'])&&record.fields.handler?.schema==='semantic-handler-scopes/1')return true;
  if(['waiting','getter-waiting'].includes(pending.phase)&&controller.stack.includes(pending.child))return true;
  api.require(controller.stack.at(-1)===pending.parent,'primitive conversion continuation owner');
  const expected={lookup:'conversion.lookup','getter-call':'conversion.getter.call',call:'conversion.call',builtin:'conversion.builtin',
    finish:'conversion.finish',fault:'conversion.fault',waiting:controller.lastReturn?.kind==='throw'?'conversion.throw':'conversion.return',
    'getter-waiting':controller.lastReturn?.kind==='throw'?'conversion.throw':'conversion.getter.return'}[pending.phase];
  api.require(record.kind===expected&&record.id===pending.id,'pending primitive conversion requires '+expected);return true;
}
export function applyPrimitiveConversionRecordV8(controller,record,api){
  if(!PRIMITIVE_CONVERSION_RECORD_FIELDS[record.kind])return false;
  const {require,copy,eq,known}=api;
  if(record.kind==='conversion.begin'){
    known(controller,record.value);const conversions=controller.protocol?.primitiveConversions;
    require((conversions?.operations.length??0)<4096&&!conversions?.operations.some(row=>row.id===record.id),'primitive conversion identity/bound');
    require(controller.stack.length,'primitive conversion requires an active invocation');
    const scalar=primitive(record.value);
    if(scalar)scalarBound(record.value,api);
    else require(record.value[0]==='ref'&&['object','array'].includes(api.heapNode(controller,record.value[1]).kind),
      'primitive conversion requires ordinary object state');
    const row={id:record.id,parent:controller.stack.at(-1),goal:record.goal,input:copy(record.value),index:-1,phase:'lookup',
      lookupKind:null,method:null,builtin:null,child:null,candidate:null,result:null,fault:null};
    if(scalar)acceptCandidate(row,record.value,api);state(controller,api).operations.push(row);return true;
  }
  const row=operation(controller,record.id,api);require(controller.stack.at(-1)===row.parent,'primitive conversion record is outside its caller');
  if(record.kind==='conversion.lookup'){
    require(row.phase==='lookup'&&eq(record.key,keyFor(row)),'primitive conversion method order');
    api.knownKey(controller,record.key);known(controller,record.value);
    const found=lookup(controller,row.input,record.key,api);
    require(eq(found,{descriptor:record.descriptor,value:record.value,builtin:record.builtin}),'false primitive conversion lookup');
    Object.assign(row,{lookupKind:found.descriptor,method:copy(found.value),builtin:found.builtin});
    if(found.descriptor==='accessor'&&found.value[0]!=='undefined'){
      require(callable(controller,found.value),'conversion getter requires an owned closure');row.phase='getter-call';
    }else if(found.builtin!==null)row.phase='builtin';
    else selectMethod(controller,row,found.value,api);
  }else if(['conversion.call','conversion.getter.call'].includes(record.kind)){
    const getter=record.kind==='conversion.getter.call';require(row.phase===(getter?'getter-call':'call'),'conversion call requires its captured callable');
    api.call(controller,{child:record.child,callee:row.method,receiver:row.input,arguments:!getter&&row.index===-1?[['str',hint(row)]]:[]});
    row.child=record.child;row.phase=getter?'getter-waiting':'waiting';
  }else if(record.kind==='conversion.builtin'){
    require(row.phase==='builtin','conversion builtin requires its captured intrinsic');const expected=builtinResult(controller,row,api);
    require(eq(record.result,expected),'false primitive conversion builtin result');acceptCandidate(row,expected,api);
  }else if(['conversion.return','conversion.getter.return'].includes(record.kind)){
    const getter=record.kind==='conversion.getter.return';
    require(row.phase===(getter?'getter-waiting':'waiting')&&!controller.stack.includes(row.child)&&
      controller.lastReturn?.kind==='return'&&eq(controller.lastReturn.value,record.value),'conversion callback completion differs');
    known(controller,record.value);if(getter)selectMethod(controller,row,record.value,api);else acceptCandidate(row,record.value,api);
  }else if(record.kind==='conversion.throw'){
    require(['waiting','getter-waiting'].includes(row.phase)&&!controller.stack.includes(row.child)&&controller.lastReturn?.kind==='throw'&&
      eq(controller.lastReturn.value,record.value),'conversion callback abrupt completion differs');
    known(controller,record.value);row.candidate=null;row.result=copy(record.value);row.phase='abrupt';
  }else if(record.kind==='conversion.fault'){
    require(row.phase==='fault','conversion fault requires a derived cause');assertDerivedFault(controller,row,api);
    row.result=allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',
      message:PRIMITIVE_CONVERSION_FAULTS_V8[row.fault]},api);
    row.phase='abrupt';controller.lastReturn={kind:'throw',value:copy(row.result)};
  }else{
    require(row.phase==='finish','conversion finish requires a primitive candidate');const expected=scalarResult(row,api);known(controller,record.result);
    require(eq(record.result,expected),'false primitive scalar conversion');row.result=copy(expected);row.phase='complete';
    controller.lastReturn={kind:'return',value:copy(expected)};
  }
  return true;
}

export function restorePrimitiveConversionStateV8(controller,snapshot,api){
  if(snapshot===null)return {valid:true,operations:0};
  assertAlgorithmFields(snapshot,['schema','operations'],'primitive conversion state');
  api.require(snapshot.schema===PRIMITIVE_CONVERSION_STATE_V8_SCHEMA,'primitive conversion state schema');
  assertAlgorithmDataArray(snapshot.operations,'primitive conversion operations');api.require(snapshot.operations.length<=4096,'primitive conversion bound');
  const seen=new Set(),children=new Set();let activeDepth=-1;
  for(const row of snapshot.operations){
    assertAlgorithmFields(row,PRIMITIVE_CONVERSION_OPERATION_FIELDS,'primitive conversion continuation');id(row.id);id(row.parent);
    api.require(!seen.has(row.id),'duplicate primitive conversion');seen.add(row.id);
    api.require(controller.frameFunctions.has(row.parent)&&goals.includes(row.goal)&&[-1,0,1].includes(row.index)&&
      PRIMITIVE_CONVERSION_PHASES_V8.includes(row.phase),'primitive conversion phase/goal/owner');
    if(!terminal(row)){
      const depth=controller.stack.indexOf(row.parent);
      api.require(depth>activeDepth,'unfinished primitive conversion requires a distinct live nested parent');activeDepth=depth;
    }
    api.known(controller,row.input);scalarBound(row.input,api);
    for(const value of [row.method,row.candidate,row.result])if(value!==null){api.known(controller,value);scalarBound(value,api);}
    api.require(row.lookupKind===null||descriptors.includes(row.lookupKind),'primitive conversion lookup kind');
    api.require(row.builtin===null||PRIMITIVE_CONVERSION_BUILTINS_V8.includes(row.builtin),'primitive conversion builtin identity');
    api.require(row.fault===null||Object.hasOwn(PRIMITIVE_CONVERSION_FAULTS_V8,row.fault),'primitive conversion fault identity');
    if(row.child!==null){id(row.child);api.require(!children.has(row.child)&&controller.frameFunctions.has(row.child),'primitive conversion callback identity');children.add(row.child);}
    if(primitive(row.input))api.require(row.index===-1&&row.lookupKind===null&&row.method===null&&row.builtin===null&&row.child===null&&
      api.eq(row.candidate,row.input)&&(['finish','complete'].includes(row.phase)||['fault','abrupt'].includes(row.phase)&&row.fault==='symbol-to-number'),
      'primitive conversion entry state');
    else api.require(row.input[0]==='ref'&&['object','array'].includes(api.heapNode(controller,row.input[1]).kind)&&
      (row.phase==='lookup'||row.lookupKind!==null&&row.method!==null),'primitive conversion object input/selection');
    api.require((row.lookupKind==='builtin')===(row.builtin!==null),'primitive conversion builtin descriptor binding');
    if(row.builtin!==null)api.require(row.method?.[0]==='undefined'&&row.index!==-1&&
      (keyFor(row)[1]==='valueOf'?row.builtin==='Object.valueOf':['Object.toString','Array.toString'].includes(row.builtin)),
      'primitive conversion builtin method binding');
    if(row.phase==='lookup')api.require([row.lookupKind,row.method,row.builtin,row.child,row.candidate,row.result,row.fault].every(value=>value===null),
      'pending primitive conversion lookup state');
    if(['getter-call','getter-waiting','call','waiting','builtin'].includes(row.phase))
      api.require(row.input[0]==='ref'&&row.candidate===null&&row.result===null&&row.fault===null,'primitive conversion callable phase values');
    if(['getter-call','getter-waiting'].includes(row.phase))api.require(row.lookupKind==='accessor','getter conversion lookup kind');
    if(['getter-call','getter-waiting','call','waiting'].includes(row.phase))api.require(callable(controller,row.method)&&
      ['data','accessor'].includes(row.lookupKind)&&row.builtin===null,'captured primitive conversion callable');
    if(['getter-call','call','builtin'].includes(row.phase))api.require(row.child===null,'unentered conversion callback identity');
    if(row.phase==='builtin')api.require(row.lookupKind==='builtin'&&row.builtin!==null&&row.method?.[0]==='undefined'&&row.index!==-1&&
      (keyFor(row)[1]==='valueOf'?row.builtin==='Object.valueOf':['Object.toString','Array.toString'].includes(row.builtin)),
      'primitive conversion intrinsic state');
    if(['waiting','getter-waiting'].includes(row.phase)||row.phase==='abrupt'&&row.fault===null){
      api.require(row.child!==null&&callable(controller,row.method)&&row.builtin===null&&
        controller.frameFunctions.get(row.child)===api.heapNode(controller,row.method[1]).code,'conversion callback source identity');
      if(controller.stack.includes(row.child)){
        api.require(controller.stack.indexOf(row.child)===controller.stack.indexOf(row.parent)+1,'conversion callback stack');
        const frame=controller.protocol.callFrames.find(frame=>frame.child===row.child),getter=row.phase==='getter-waiting',node=api.heapNode(controller,row.method[1]);
        api.require(frame?.parent===row.parent&&api.eq(frame.arguments,!getter&&row.index===-1?[['str',hint(row)]]:[])&&
          api.eq(controller.locals.get(row.child+':this'),node.functionKind==='arrow'?node.lexicalReceiver:row.input),'conversion callback receiver or hint');
      }else if(row.phase!=='abrupt'){
        api.require(controller.stack.at(-1)===row.parent&&['return','throw'].includes(controller.lastReturn?.kind),
          'completed conversion child requires its immediately pending result');api.known(controller,controller.lastReturn.value);
      }
      if(row.phase==='abrupt')api.require(!controller.stack.includes(row.child)&&row.candidate===null&&row.result!==null,'abrupt conversion callback state');
    }
    if(['finish','complete'].includes(row.phase))api.require(row.child===null&&row.fault===null&&primitive(row.candidate)&&
      (row.goal!=='Number'||row.candidate[0]!=='symbol')&&
      (primitive(row.input)||callable(controller,row.method)||row.builtin!==null),'primitive conversion scalar state');
    if(row.phase==='complete')api.require(api.eq(row.result,scalarResult(row,api)),'false completed primitive conversion');
    if(row.phase==='fault'||row.phase==='abrupt'&&row.fault!==null){
      api.require(row.child===null,'derived conversion fault cannot retain a callback');assertDerivedFault(controller,row,api);
      if(row.phase==='abrupt'){
        const error=row.result?.[0]==='ref'?api.heapNode(controller,row.result[1]):null;
        api.require(error?.kind==='object'&&error.declaredError==='TypeError',
          'conversion fault error identity/brand');
      }
    }
    if(!terminal(row))api.require(row.result===null,'unfinished primitive conversion has a result');
    if(!['fault','abrupt'].includes(row.phase))api.require(row.fault===null,'conversion phase cannot have a fault');
    if(row.phase==='abrupt')api.require(row.result!==null,'abrupt conversion lacks its original value');
  }
  return {valid:true,operations:seen.size};
}
