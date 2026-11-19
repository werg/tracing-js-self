// Explicitly versioned source-completion observations for the v8 protocol.
// Existing source-completions/1 and its scalar-only reference remain unchanged.
import {encode,decode} from '../values.js';
import {symbolPropertyKey,stringPropertyKey} from '../property-keys.js';
import {completionObservationPlan,compareCompletionObservations} from '../training/completion-reference.js';
export const PROTOCOL_COMPLETION_OBSERVATION_SCHEMA='source-protocol-completions/1';
const site=node=>node.start+':'+node.end;
export function createProtocolCompletionCapture({limit=32768,initialValues=[]}={}){
  if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError('Invalid observation limit');
  const observations=[],objects=new WeakMap(),symbols=new Map();let next=0;
  const seed=value=>{
    if(value===null||!['object','function'].includes(typeof value)||objects.has(value))return;
    objects.set(value,++next);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))throw new TypeError('Accessor in source observation input');
      seed(descriptors[key].value);
    }
  };
  for(const input of initialValues)seed(input);
  function tagged(value){
    const type=typeof value;
    if(type==='symbol'){
      if(!symbols.has(value))symbols.set(value,++next);
      return ['identity','symbol',symbols.get(value)];
    }
    if(value!==null&&['object','function'].includes(type)){
      if(!objects.has(value))objects.set(value,++next);
      return ['identity',type,objects.get(value)];
    }
    return encode(value);
  }
  const capture=(site,kind,value)=>{
    if(observations.length>=limit)throw new RangeError('Source protocol completion observation cap');
    observations.push({site,kind,...(!['finally','break','continue'].includes(kind)?{value:tagged(value)}:{})});
    return value;
  };
  return {observations,capture,tagged};
}

export function ownedProtocolCompletionObservations(bundle,source){
  const plan=completionObservationPlan(source),siteById=new Map(bundle.sites.map(x=>[x.siteId,x]));
  const identities=new Map(),pending=new Map(),observations=[];let next=0;
  const state={heap:{...bundle.initialState.heap},envs:{...bundle.initialState.envs},frames:{...bundle.initialState.frames}};
  const seed=tag=>{
    if(!Array.isArray(tag)||tag[0]!=='ref'||identities.has(JSON.stringify(tag)))return;
    identities.set(JSON.stringify(tag),++next);
    const object=state.heap[tag[1]];
    if(!object||Object.keys(object.accessors??{}).length)throw new TypeError('Unobservable source input identity');
    for(const key of Object.keys(object.properties??{}).sort())seed(object.properties[key].value);
  };
  for(const argument of bundle.entrySpec?.arguments??[])seed(argument);
  const storedCell=(environment,name)=>{
    const seen=new Set();
    for(let id=environment;id!==null&&id!==undefined;id=state.envs[id]?.parent){
      if(seen.has(id))break;seen.add(id);
      const cell=state.envs[id]?.bindings?.[name];
      if(cell){
        if(!cell.initialized||!Array.isArray(cell.token?.value))return ['missing-storage'];
        return cell.token.value;
      }
    }
    throw new TypeError('Source binding has no committed cell');
  };
  const value=tag=>{
    if(!Array.isArray(tag))throw new TypeError('Missing owned source completion value');
    if(['undefined','null','bool','str','num','bigint','missing-storage'].includes(tag[0]))return tag;
    const key=JSON.stringify(tag);
    if(!identities.has(key))identities.set(key,++next);
    const kind=tag[0]==='symbol'?'symbol':tag[0]==='ref'?bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object':
      tag[0]==='builtinfn'||tag[0]==='intrinsic'&&tag[1]!=='Math'&&tag[1]!=='Atomics'?'function':'object';
    return ['identity',kind,identities.get(key)];
  };
  const emit=(key,kind,tag)=>observations.push({site:key,kind,
    ...(!['finally','break','continue'].includes(kind)?{value:value(tag)}:{})});
  for(const event of bundle.events){
    const previousFrame=state.frames[event.invocationId];
    for(const change of event.stateChanges){
      if(!state[change.table])continue;
      if(change.after===null)delete state[change.table][change.id];
      else state[change.table][change.id]=change.after;
    }
    const location=siteById.get(event.siteId),key=location?site(location):null;
    const patch=event.stateChanges.find(p=>p.table==='frames'&&p.id===event.invocationId);
    const instructions=bundle.programs[event.codeId]?.instructions;
    const instruction=instructions?.find(x=>x.siteId===event.siteId);
    const abrupt=event.completion?.type==='throw';
    if(!abrupt&&['binding.initialize','binding.write'].includes(event.operation)&&plan.sites.has('initialize:'+key)){
      const declaration=plan.sites.get('initialize:'+key);
      if(instruction?.arg!==declaration.id.name)
        throw new TypeError('Source initialization site names a different committed binding');
      emit(key,'initialize',storedCell(previousFrame?.envId,instruction?.arg));
    }
    if(!abrupt&&event.operation==='binding.read'&&plan.sites.has('assign:'+key)){
      const assignment=plan.sites.get('assign:'+key);
      if(['ArrayPattern','ObjectPattern'].includes(assignment.left?.type)&&
         instruction?.op==='GET'&&instruction.arg?.startsWith('[[pattern '))
        emit(key,'assign',event.result);
    }
    if(!abrupt&&['binding.write','property.write'].includes(event.operation)&&plan.sites.has('assign:'+key)){
      if(event.causes.some(c=>c.kind==='invocation'))
        pending.set(event.invocationId,{site:key,kind:'assign',depth:patch.after.stack.length,pc:patch.after.pc});
      else{
        // Check the committed cell value as well as expression completion. A
        // faulty teacher that stores a different value cannot hide behind a
        // correct assignment-expression result.
        let stored=event.result;
        if(event.operation==='binding.write')stored=storedCell(previousFrame?.envId,instruction?.arg);
        else{
          const [base,property]=event.operands??[];
          if(base?.[0]!=='ref'||!['str','num','bool','null','undefined','bigint','symbol'].includes(property?.[0]))
            throw new TypeError('Source assignment storage is outside the independently observed property profile');
          const object=state.heap[base[1]];
          if(!object||object.kind==='proxy')throw new TypeError('Source assignment storage requires an ordinary receiver');
          const key=property[0]==='symbol'?symbolPropertyKey(property[1]):stringPropertyKey(String(decode(property)));
          // A successful ordinary assignment must leave its stored value in
          // the receiver. Looking only at changed patches misses dropped writes.
          stored=object.properties?.[key]?.value??['missing-storage'];
        }
        emit(key,'assign',stored);
      }
    }
    if(!abrupt&&event.operation==='call.enter'&&plan.sites.has('call:'+key)&&!pending.has(event.invocationId)){
      if(!event.causes.some(c=>c.kind==='invocation')&&Array.isArray(event.result))emit(key,'call',event.result);
      else if(patch?.after)pending.set(event.invocationId,{site:key,kind:'call',depth:patch.after.stack.length,pc:patch.after.pc});
    }
    if(event.operation==='stack.pop'&&plan.sites.has('statement:'+key))emit(key,'statement',event.operands[0]);
    if(event.operation==='call.return'&&plan.sites.has('return:'+key))emit(key,'return',event.result);
    if(event.operation==='completion.throw'&&plan.sites.has('throw:'+key))emit(key,'throw',event.completion.value.value);
    if(event.operation==='completion.catch.bind'&&plan.sites.has('catch:'+key)){
      const node=plan.sites.get('catch:'+key);
      emit(key,'catch',node.param?.type==='Identifier'?storedCell(state.frames[event.invocationId]?.envId,node.param.name):['undefined']);
    }
    const jumpKind=typeof instruction?.arg==='string'?instruction.arg:instruction?.arg?.kind;
    if(event.operation==='completion.loop.jump'&&plan.sites.has(jumpKind+':'+key))emit(key,jumpKind);
    for(const change of event.stateChanges.filter(p=>p.table==='frames'&&p.before&&p.after)){
      const waiting=pending.get(change.id);
      if(waiting&&change.before.pc===waiting.pc){
        if(change.after.pc===waiting.pc&&change.after.stack.length>waiting.depth&&change.before.stack.length<=waiting.depth){
          emit(waiting.site,waiting.kind,change.after.stack[waiting.depth].value);pending.delete(change.id);
        }else if(change.after.pc!==waiting.pc||['thrown','unsupported'].includes(change.after.status))pending.delete(change.id);
      }
      for(const handler of change.after.handlers??[]){
        if(handler.phase!=='finally'||(change.before.handlers??[]).some(h=>h.finallyPc===handler.finallyPc&&h.afterPc===handler.afterPc&&h.phase==='finally'))continue;
        const end=bundle.programs[change.after.codeId]?.instructions[handler.afterPc-1];
        const finalizer=end?end.start+':'+end.end:null;
        if(plan.finalizers.has(finalizer))emit(finalizer,'finally');
      }
    }
  }
  if(pending.size)throw new TypeError('Incomplete owned source call/assignment observation');
  return observations;
}

export function compareProtocolCompletionObservations(expected,observed){
  return {...compareCompletionObservations(expected,observed),schema:PROTOCOL_COMPLETION_OBSERVATION_SCHEMA,
    referenceValues:'scalars-and-input-rooted-reference-or-symbol-identity'};
}
