// Independent checks for the narrow original-Test262 host observations.
import {symbolPropertyKey,stringPropertyKey} from './property-keys.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clone=value=>structuredClone(value);
const errorKinds=new Set(['Error','EvalError','RangeError','ReferenceError','SyntaxError','TypeError','URIError']);
const objectKeys=['constructor','__defineGetter__','__defineSetter__','hasOwnProperty','__lookupGetter__',
  '__lookupSetter__','isPrototypeOf','propertyIsEnumerable','toString','valueOf','__proto__','toLocaleString'];
const prototypeKeys={
  'Object.prototype':new Set(objectKeys),
  'Array.prototype':new Set([...objectKeys,'length','constructor','at','concat','copyWithin','fill','find','findIndex',
    'findLast','findLastIndex','lastIndexOf','pop','push','reverse','shift','unshift','slice','sort','splice','includes',
    'indexOf','join','keys','entries','values','forEach','filter','flat','flatMap','map','every','some','reduce',
    'reduceRight','toReversed','toSorted','toSpliced','with',symbolPropertyKey('well-known:iterator'),
    symbolPropertyKey('well-known:unscopables')]),
  'Function.prototype':new Set([...objectKeys,'length','name','arguments','caller','constructor','apply','bind','call',
    symbolPropertyKey('well-known:hasInstance')]),
  'Promise.prototype':new Set([...objectKeys,'then','catch','finally',symbolPropertyKey('well-known:toStringTag')])
};
function keyOf(value,fail){
  if(value?.[0]==='str')return stringPropertyKey(value[1]);
  if(value?.[0]==='bigint')return value[1];
  if(value?.[0]==='symbol')return symbolPropertyKey(value[1]);
  if(value?.[0]==='num')return value[1]==='-0'?'0':value[1]==='+Infinity'?'Infinity':String(value[1]);
  if(value?.[0]==='undefined'||value?.[0]==='null')return value[0];
  if(value?.[0]==='bool')return String(value[1]);
  fail('Unmodeled key coercion in ordinary in-operator receipt');
}
function hasProperty(state,receiver,key,fail){
  let object=receiver?.[0]==='promise'?state.promises[receiver[1]]:
    ['ref','intrinsic'].includes(receiver?.[0])?state.heap[receiver[1]]:null,seen=new Set();
  if(!object)fail('Ordinary in-operator has no owned receiver');
  for(;;){
    if(seen.has(object.id)||!['object','array','function','promise'].includes(object.kind))fail('Unmodeled in-operator prototype');
    seen.add(object.id);
    if(Object.hasOwn(object.properties??{},key)||Object.hasOwn(object.accessors??{},key))return true;
    if(object.kind==='function'&&(['name','length'].includes(key)||key==='prototype'&&!object.arrow&&!object.async&&!object.nonConstructible))return true;
    if(object.declaredError&&key==='constructor')return true;
    const parent=Object.hasOwn(object,'prototype')?object.prototype:
      object.kind==='array'?'Array.prototype':object.kind==='function'?'Function.prototype':
        object.kind==='promise'?'Promise.prototype':'Object.prototype';
    if(parent===null)return false;
    if(parent==='Promise.prototype'&&state.heap[parent]){object=state.heap[parent];continue;}
    if(Object.hasOwn(prototypeKeys,parent))return prototypeKeys[parent].has(key);
    object=state.heap[parent]??state.promises[parent];if(!object)fail('Unknown in-operator prototype');
  }
}
function expectStackResult(event,frame,result,fail){
  const after=event.stateChanges.find(patch=>patch.table==='frames'&&patch.id===frame.id)?.after;
  if(!same(event.result,result)||!same(after?.stack.at(-1),{value:result,origin:event.eventId}))
    fail('Owned script observation result changed');
}
export function validateScriptHostEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const control=state.control.a0,controlPatch=event.stateChanges.find(patch=>patch.table==='control'&&patch.id==='a0');
  const callable=event.operands[0]?.[0]==='method'?event.operands[0][1]:event.operands[0];
  if(event.operation==='call.enter'&&same(callable,['builtinfn','print'])){
    if(instruction?.op!=='CALL'||instruction.arg!==1||!Array.isArray(control.test262Output)||
       control.test262Output.length>=10000||event.operands.length!==2||event.operands[1]?.[0]!=='str'||
       !same(event.operands,frame.stack.slice(-2).map(item=>item.value))||event.completion!==undefined)
      fail('Invalid owned Test262 print invocation');
    const nextFrame=clone(frame);nextFrame.pc++;nextFrame.stack.splice(-2,2,{value:['undefined'],origin:event.eventId});
    nextFrame.version++;
    const nextControl=clone(control);nextControl.test262Output.push({value:event.operands[1],origin:event.eventId});
    nextControl.version++;
    if(!same(event.result,['undefined'])||!same(event.stateChanges,[
      {kind:'frames.replace',table:'frames',id:frame.id,before:frame,after:nextFrame},
      {kind:'control.replace',table:'control',id:'a0',before:control,after:nextControl}]))
      fail('Owned Test262 print output or frame transition changed');
  }else if(controlPatch&&!same(controlPatch.after?.test262Output,control.test262Output))
    fail('Test262 print journal changed outside its original host call');
  if(event.completion||!frame||['property.key.convert','property.key.resume'].includes(event.operation))return;
  if(instruction?.op==='BINARY'&&instruction.arg==='in'){
    const operands=frame.stack.slice(-2).map(item=>item.value);
    if(!same(event.operands,operands))fail('Ordinary in-operator operands changed');
    const right=operands[1]?.[0]==='ref'?state.heap[operands[1][1]]:null;
    if(right?.kind==='proxy')return;
    expectStackResult(event,frame,['bool',hasProperty(state,operands[1],keyOf(operands[0],fail),fail)],fail);
  }
  if(['GET_PROP','GET_METHOD'].includes(instruction?.op)){
    const [base,key]=frame.stack.slice(-2).map(item=>item.value);
    const object=base?.[0]==='ref'?state.heap[base[1]]:null;
    if(object?.declaredError&&same(key,['str','constructor'])){
      if(!errorKinds.has(object.declaredError)||!same(event.operands,[base,key]))fail('Unknown owned error constructor');
      const value=['intrinsic',object.declaredError];
      expectStackResult(event,frame,instruction.op==='GET_METHOD'?['method',value,base]:value,fail);
    }
  }
}
