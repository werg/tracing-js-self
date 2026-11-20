// Independent read-only checks for retained ToPrimitive work. No evaluator,
// execution helper, ordinaryGet, or conversion mutation kernel is imported.
import {encode,decode} from './values.js';
import {symbolPropertyKey} from './property-keys.js';

const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['operation','input','siteId','index','method','phase','waitingFrameId','result'];
const primitive=value=>['undefined','null','bool','str','num','bigint','symbol'].includes(value?.[0]);
export const conversionWaiting=pending=>['waiting','getter-waiting'].includes(pending?.phase);
export const conversionReturned=pending=>['returned','getter-returned'].includes(pending?.phase);

export function validatePrimitiveConversionRecord(pending,goal,frame,state,programs,sites,fail){
  if(!pending||Object.keys(pending).length!==fields.length||fields.some(key=>!Object.hasOwn(pending,key))||
    pending.operation!==goal||!sites.has(pending.siteId)||![-1,0,1].includes(pending.index)||
    !conversionWaiting(pending)&&!conversionReturned(pending)||pending.input?.[0]!=='ref'||
    !['object','array'].includes(state.heap[pending.input[1]]?.kind)||pending.method?.[0]!=='ref')
    fail('Invalid '+goal+' conversion continuation fields');
  const method=state.heap[pending.method[1]],child=state.frames[pending.waitingFrameId];
  const lexical=method?.lexicalThisFrameId&&state.frames[method.lexicalThisFrameId];
  const receiver=method?.arrow?(lexical?lexical.thisValue:method.lexicalThis):pending.input;
  if(method?.kind!=='function'||method.async||programs[method.codeId]?.generator||
    !child||child.callerFrameId!==frame.id||child.codeId!==method.codeId||child.asyncPromiseId!==null||
    !eq(child.thisValue,receiver)||(method.lexicalThisFrameId??null)!==(child.thisBindingFrameId??null))
    fail(goal+' conversion callback identity or receiver mismatch');
  if(conversionWaiting(pending)?(pending.result!==null||['completed','thrown','unsupported'].includes(child.status)):
    (child.status!=='completed'||!Array.isArray(pending.result)||!eq(child.completion?.value?.value,pending.result)))
    fail(goal+' conversion callback completion phase mismatch');
}

function lookup(heap,input,key,fail){
  const original=heap[input[1]],seen=new Set();let current=original;
  let slot,accessor=false;
  for(;;){
    if(!current||!['object','array'].includes(current.kind)||seen.has(current.id))
      fail('Conversion lookup traverses an unowned prototype');
    seen.add(current.id);
    if(Object.hasOwn(current.accessors??{},key)){
      slot=current.accessors[key].get;accessor=true;break;
    }
    if(Object.hasOwn(current.properties,key)){slot=current.properties[key];break;}
    const proto=Object.hasOwn(current,'prototype')?current.prototype:current.kind==='array'?'Array.prototype':'Object.prototype';
    if(proto===null){slot={value:['undefined'],origin:null};break;}
    if(['Object.prototype','Array.prototype'].includes(proto)){
      slot={value:key==='valueOf'?['builtinfn','Object.valueOf']:key==='toString'?
        ['builtinfn',proto==='Array.prototype'?'Array.toString':'Object.toString']:
        proto==='Array.prototype'&&key==='join'?['builtinfn','Array.prototype.join']:['undefined'],origin:null};
      break;
    }
    current=heap[proto];
  }
  if(!Array.isArray(slot?.value))fail('Conversion lookup has no owned property value');
  return {value:slot.value,accessor,observation:{kind:'property',objectId:original.id,key,
    version:Object.hasOwn(original.propertyVersions??{},key)?original.propertyVersions[key]:0,shapeVersion:original.shapeVersion??0,
    present:Object.hasOwn(original.properties,key),value:slot.value,supplyingEvent:slot.origin??null}};
}
function builtin(heap,input,name,fail){
  const object=heap[input[1]];
  if(name==='Object.valueOf')return input;
  if(name==='Object.toString'){
    const tag=lookup(heap,input,symbolPropertyKey('well-known:toStringTag'),fail);
    if(tag.accessor)fail('Conversion intrinsic stringification needs an owned accessor profile');
    return ['str','[object '+(tag.value[0]==='str'?tag.value[1]:object.kind==='array'?'Array':'Object')+']'];
  }
  if(name!=='Array.toString'||object.kind!=='array')
    fail('Conversion intrinsic is outside its owned data profile');
  const join=lookup(heap,input,'join',fail);
  if(join.accessor||!eq(join.value,['builtinfn','Array.prototype.join']))
    fail('Conversion intrinsic array has an overridden join');
  const count=decode(object.properties.length.value),parts=[];
  if(!Number.isSafeInteger(count)||count<0||count>10000)fail('Conversion intrinsic array exceeds its data budget');
  for(let i=0;i<count;i++){
    const value=object.properties[i]?.value;
    if(!primitive(value)||value[0]==='symbol')fail('Conversion intrinsic array has an unowned element');
    parts.push(['null','undefined'].includes(value[0])?'':String(decode(value)));
  }
  return ['str',parts.join(',')];
}

/** Compute the next permissible boundary from archived data, independently. */
export function primitiveConversionDecision(pending,state,fail){
  const hint=pending.operation==='PropertyKey'?'string':'number',reads=[];
  let index=pending.index,selected=null;
  const finish=value=>{
    if(pending.operation==='Number'&&value[0]==='symbol')
      return {fault:'Cannot convert a Symbol value to a number',reads};
    if(['str','bigint'].includes(value[0])&&value[1].length>10000)fail('Conversion scalar exceeds its data budget');
    return {value:pending.operation==='Number'?encode(Number(decode(value))):
      value[0]==='symbol'?value:['str',String(decode(value))],reads};
  };
  const accept=value=>primitive(value)?finish(value):index===-1?
    {fault:'Symbol.toPrimitive must return a primitive',reads}:index===1?
    {fault:'Cannot convert object to primitive value',reads}:null;
  if(pending.phase==='getter-returned')selected=pending.result;
  else if(pending.phase==='returned'){
    const final=accept(pending.result);if(final)return final;index=1;
  }else if(pending.phase!=='select')fail('Conversion decision has no returned callback');
  for(;;){
    let method=selected;selected=null;
    if(method===null){
      const key=index===-1?symbolPropertyKey('well-known:toPrimitive'):
        (hint==='string'?['toString','valueOf']:['valueOf','toString'])[index],
        found=lookup(state.heap,pending.input,key,fail);
      reads.push(found.observation);
      if(found.accessor&&found.value[0]!=='undefined')
        return {method:found.value,index,phase:'getter-waiting',args:[],reads};
      method=found.accessor?['undefined']:found.value;
    }
    if(index===-1&&['null','undefined'].includes(method[0])){index=0;continue;}
    if(method[0]==='ref'&&state.heap[method[1]]?.kind==='function')
      return {method,index,phase:'waiting',args:index===-1?[['str',hint]]:[],reads};
    if(method[0]==='builtinfn'&&['Object.valueOf','Object.toString','Array.toString'].includes(method[1])){
      const final=accept(builtin(state.heap,pending.input,method[1],fail));
      if(final)return final;index=1;continue;
    }
    if(['builtinfn','intrinsic','hostfn'].includes(method[0])||method[0]==='ref'&&state.heap[method[1]]?.kind==='proxy')
      fail('Conversion callback is outside its owned invocation profile');
    if(index===-1)return {fault:'Symbol.toPrimitive is not callable',reads};
    if(index===1)return {fault:'Cannot convert object to primitive value',reads};
    index=1;
  }
}

export function validatePrimitiveConversionAdvance(before,after,parentId,state,event,programs,fail){
  const goal=before.operation,expected=primitiveConversionDecision(before,state,fail);
  if(expected.method){
    if(!after||!eq(after.input,before.input)||after.operation!==goal||after.siteId!==before.siteId||
      after.index!==expected.index||after.phase!==expected.phase||!eq(after.method,expected.method)||
      after.result!==null||after.waitingFrameId===before.waitingFrameId)
      fail(goal+' conversion selected the wrong method or fallback');
    const childPatch=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===after.waitingFrameId),
      child=childPatch?.after,program=programs[child?.codeId],method=state.heap[expected.method[1]],
      environment=event.stateChanges.find(patch=>patch.table==='envs'&&patch.id===child?.envId)?.after,
      control=event.stateChanges.find(patch=>patch.table==='control'&&patch.id==='a0')?.after;
    if(childPatch?.before!==null||!program||!environment||child.callerFrameId!==parentId||
      child.codeId!==method?.codeId||environment.parent!==method.closureEnvId||
      control?.activeFrameId!==child.id||child.status!=='running'||child.pc!==0||child.stack.length||
      !event.causes.some(cause=>cause.kind==='invocation'&&cause.frameId===child.id))
      fail(goal+' callback did not enter its fresh invocation');
    for(const [index,name] of program.params.entries()){
      const binding=environment.bindings[name],value=expected.args[index]??['undefined'];
      if(binding?.kind!=='parameter'||binding.initialized===!!program.parameterExpressions)
        fail(goal+' callback parameter initialization mismatch');
      if(index===(program.restIndex??-1)){
        const tag=binding.token?.value,array=tag?.[0]==='ref'&&event.stateChanges.find(patch=>patch.table==='heap'&&patch.id===tag[1])?.after,
          extras=expected.args.slice(index);
        if(array?.kind!=='array'||!eq(array.properties.length?.value,['num',extras.length])||
          extras.some((value,i)=>!eq(array.properties[String(i)]?.value,value)))
          fail(goal+' callback rest arguments mismatch');
      }else if(!eq(binding.token?.value,value))fail(goal+' callback arguments or conversion hint mismatch');
    }
    if(event.result!==null||event.completion)fail(goal+' conversion completed before its callback');
  }else if(expected.fault){
    if(after||event.completion?.type!=='throw'||event.completion.errorType!=='TypeError'||
      event.completion.message!==expected.fault)
      fail(goal+' conversion must produce its guest TypeError');
  }else if(after||!eq(event.result,expected.value)||event.completion)
    fail(goal+' conversion result is inconsistent with its primitive');
  // Guest faults are caught by the enclosing operation, preserving the old
  // Number event shape. Successful transitions retain each actual lookup.
  if(!expected.fault&&!eq(event.readObservations,expected.reads))
    fail(goal+' conversion lookup observations mismatch');
  return expected;
}

export function validatePrimitiveConversionReturn(before,after,state,event,fail,programs=null){
  const goal=before.operation,child=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===before.waitingFrameId)?.after;
  if(after){
    const phase=before.phase==='getter-waiting'?'getter-returned':'returned';
    if(after.phase!==phase||!eq({...after,phase:before.phase,result:null},before)||
      child?.status!=='completed'||!eq(child.completion?.value?.value,after.result))
      fail(goal+' callback did not retain its actual return value');
    if(programs){
      const previous=state.frames[before.waitingFrameId],instruction=programs[previous?.codeId]?.instructions[previous?.pc],
        expected=instruction?.op==='RETURN'?previous.stack.at(-1):instruction?.op==='END_FINALLY'&&
          previous.handlers.at(-1)?.pending?.type==='return'?previous.handlers.at(-1).pending.value:null;
      if(event.invocationId!==before.waitingFrameId||!expected||!eq(child.completion.value,expected))
        fail(goal+' callback return does not match its source return or retained cleanup');
    }
  }else if(child?.status!=='thrown')fail(goal+' callback continuation disappeared before completion');
}
