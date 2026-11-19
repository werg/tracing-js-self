// Super references preserve three independent identities: home, base and this.
import {objectPrototype} from './spec-operations.js';
import {decode} from './values.js';
import {symbolPropertyKey,stringPropertyKey} from './property-keys.js';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function binding(state,envId,name){
  while(envId){const env=state.envs[envId];if(Object.hasOwn(env.bindings,name))return env.bindings[name].token;envId=env.parent;}
  return null;
}
const prototypeValue=parent=>parent===null?['null']:
  ['Object.prototype','Array.prototype','Function.prototype'].includes(parent)?['intrinsic',parent]:['ref',parent];
export function validateSuperEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const after=(table,id)=>event.stateChanges.find(p=>p.table===table&&p.id===id)?.after??state[table][id];
  if(instruction?.op==='CLASS_CREATE'&&instruction.arg.named||instruction?.op==='SET_HOME_OBJECT'&&instruction.arg.methodName){
    const isClass=instruction.op==='CLASS_CREATE',fnToken=frame.stack.at(isClass?(instruction.arg.derived?-3:-2):-1),fn=after('heap',fnToken.value[1]);
    const naming=instruction.arg.methodName;
    let name=isClass?frame.stack.at(-1).value:naming.privateName?['str',naming.privateName]:binding(state,frame.envId,naming.binding).value;
    if(name[0]==='symbol'){
      const description=name[1].startsWith('well-known:')?['str','Symbol.'+name[1].slice(11)]:state.heap[name[1]]?.description;
      name=description?.[0]==='str'?'['+description[1]+']':'';
    }else name=String(decode(name));
    if(naming?.prefix)name=naming.prefix+' '+name;
    const program=programs[fn.codeId],defaults=program.instructions.filter(i=>i.op==='DEFAULT_GUARD').map(i=>program.params.indexOf(i.arg.name)).filter(i=>i>=0);
    const length=Math.min(program.params.length,program.restIndex>=0?program.restIndex:Infinity,...defaults);
    for(const [key,value] of [['name',['str',name]],['length',['num',length]]])if(!eq(fn.properties?.[key]?.value,value)||
      !eq(fn.dataAttributes?.[key],{writable:false,enumerable:false,configurable:true}))fail('Class function name/length descriptor disagrees with its definition');
  }
  for(const patch of event.stateChanges)if(patch.table==='envs'&&patch.before?.bindings?.['[[home object]]']&&
    !eq(patch.before.bindings['[[home object]]'],patch.after?.bindings?.['[[home object]]']))fail('Method lexical home binding changed');
  for(const patch of event.stateChanges)if(patch.table==='heap'&&(patch.before?.homeObject||patch.after?.homeObject)){
    if(patch.before?.homeObject){
      if(!eq(patch.before.homeObject,patch.after?.homeObject)||patch.before.closureEnvId!==patch.after.closureEnvId)fail('Method home object identity changed');
      continue;
    }
    if(!['CLASS_CREATE','SET_HOME_OBJECT'].includes(instruction?.op)||patch.after.kind!=='function'||patch.after.arrow)
      fail('Method home object created outside definition');
    const expected=instruction.op==='CLASS_CREATE'?patch.after.properties.prototype.value:
      instruction.arg.name?binding(state,frame.envId,instruction.arg.name)?.value:frame.stack.at(-instruction.arg.offset-1)?.value;
    const environment=after('envs',patch.after.closureEnvId),cell=environment?.bindings['[[home object]]'];
    if(!eq(patch.after.homeObject,expected)||!cell||cell.kind!=='const'||!cell.initialized||!eq(cell.token.value,expected)||
       environment.parent!==patch.before.closureEnvId)fail('Method home object lost its lexical environment');
  }
  if(instruction?.op==='SUPER_REFERENCE'){
    const home=binding(state,frame.envId,'[[home object]]'),receiver=frame.stack.at(-2)?.value,key=frame.stack.at(-1)?.value;
    if(!home||!eq(event.result,['superreference',prototypeValue(objectPrototype(state.heap[home.value[1]])),receiver,key]))
      fail('Super reference lost its captured base, receiver or key');
  }
  if(instruction?.op==='SUPER_CONSTRUCTOR'){
    const owner=frame.thisBindingFrameId?state.frames[frame.thisBindingFrameId]:frame,parent=state.heap[owner.constructorId]?.prototype;
    if(owner.constructKind!=='derived'||!eq(event.result,parent==='Function.prototype'?['undefined']:['ref',parent]))
      fail('Super constructor was not selected from the live constructor context');
  }
  if(!['SUPER_GET','SUPER_GET_METHOD','SUPER_SET'].includes(instruction?.op))return;
  if(event.operation!==(instruction.op==='SUPER_SET'?'property.write':'property.read'))return;
  const write=instruction.op==='SUPER_SET',reference=frame.stack.at(write?-2:-1)?.value;
  if(reference?.[0]!=='superreference')fail('Super operation has no retained reference');
  const [,base,receiver,key]=reference;
  if(!eq(event.operands?.slice(0,2),[receiver,key])&&event.completion?.type!=='throw')fail('Super operation changed its evaluated receiver or key');
  if(event.completion?.type==='throw')return;
  const property=key[0]==='symbol'?symbolPropertyKey(key[1]):stringPropertyKey(String(decode(key)));
  let object=base[0]==='ref'?state.heap[base[1]]:null,slot,accessor;
  const seen=new Set();
  while(object){
    if(seen.has(object.id))fail('Cyclic super lookup');seen.add(object.id);
    if(Object.hasOwn(object.properties??{},property)){slot=object.properties[property];break;}
    if(Object.hasOwn(object.accessors??{},property)){accessor=object.accessors[property];break;}
    object=state.heap[objectPrototype(object)];
  }
  const invoked=event.causes.find(c=>c.kind==='invocation')?.frameId;
  if(invoked){
    const method=accessor?.[write?'set':'get']?.value,fn=state.heap[method?.[1]],callee=after('frames',invoked);
    if(!fn||callee?.codeId!==fn.codeId||callee.callerFrameId!==frame.id||
       !eq(callee.thisValue,fn.arrow?(fn.lexicalThisFrameId?state.frames[fn.lexicalThisFrameId].thisValue:fn.lexicalThis):receiver))
      fail('Super accessor invocation lost its actual receiver');
  }else if(write){
    const value=frame.stack.at(-1).value;
    if(!eq(event.result,value)||!eq(after('heap',receiver[1])?.properties?.[property]?.value,value))
      fail('Super assignment did not store its RHS in the receiver');
  }else if(base[0]==='ref'&&(slot||accessor)){
    const value=slot?.value??['undefined'],expected=instruction.op==='SUPER_GET_METHOD'?['method',value,receiver]:value;
    if(!eq(event.result,expected))fail('Super data read or method receiver disagrees with its captured base');
  }
}
