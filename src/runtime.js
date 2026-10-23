import { encode, decode, U, token, truthy, primitiveBinary, primitiveUnary } from './values.js';
import { parse, compile } from './frontend.js';
import { importGraph } from './training/graph.js';
import { parseTraining, TRAINING_PARSER } from './training/profile.js';
import { createArithmetic, advanceArithmetic, isOwnedArithmetic, ordinaryGet, ordinaryBuiltin, objectPrototype } from './spec-operations.js';
import { operationMutation } from './spec-mutations.js';
import {hostOperation,prepareHostRequest} from './host/operations.js';
import { specStep, ENGINE_REVISION } from './spec-schema.js';

class GuestFault extends Error {constructor(name,message){super(message);this.name=name;}}
const guestFault=(name,message)=>{throw new GuestFault(name,message);};
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
  CONST:'literal.materialize', GET:'binding.read', SET:'binding.write', UPDATE_BINDING:'binding.update', UPDATE_PROP:'property.update', INIT:'binding.initialize', DECLARE:'binding.declare',
  DEF_FN:'function.define', BINARY:'primitive.binary', UNARY:'primitive.unary', POP:'stack.pop', DUP:'stack.duplicate', DUP2:'stack.duplicate',
  CALL:'call.enter', RETURN:'call.return', THROW:'completion.throw', AWAIT:'async.await', TYPEOF_BINDING:'primitive.unary', MAKE_FUNCTION:'function.define', NEW_OBJECT:'object.allocate', NEW_ARRAY:'array.allocate', NEW_PROXY:'proxy.allocate',
  GET_PROP:'property.read', GET_METHOD:'property.read', PUT_PROP:'property.write', TEMPLATE:'template.substitute', ENTER_SCOPE:'environment.enter',
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
  if (!['str','num','bool','null','undefined','bigint'].includes(tagged[0]))
    throw new TypeError('Property keys requiring guest coercion are unsupported');
  return String(decode(tagged));
}
function arrayIndex(key) {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}
// ES SameValue/SameValueZero over the owned value codec. Never use JS object
// equality for guest reference identities; they live in the serializable heap.
const comparableTags=new Set(['undefined','null','bool','str','num','bigint',
  'ref','promise','intrinsic','builtinfn','hostfn']);
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
  while(obj && ['object','array'].includes(obj.kind)){
    if(visited.has(obj.id))throw new Error('Cyclic owned prototype graph');
    visited.add(obj.id);
    if(Object.hasOwn(obj.properties,key))return null;
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
    if(trap.method.value[0]!=='undefined')
      return {kind:'trap',method:trap.method.value,observation:trap.observation,
        target:['ref',obj.targetId],handler:['ref',handler.id],receiver};
    obj=heap[obj.targetId];
  }
  if(!obj||!['object','array'].includes(obj.kind))
    throw new TypeError('Unmodeled proxy target internal method');
  return {kind:'ordinary',target:['ref',obj.id],receiver};
}
function putOwn(obj,key,value,eventId) {
  if (key === '__proto__') throw new TypeError('Prototype mutation is not implemented by the bounded profile');
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
  Object.defineProperty(obj.properties,key,{value:token(value,eventId),enumerable:true,configurable:true,writable:true});
  obj.propertyVersions[key] = (Object.hasOwn(obj.propertyVersions,key) ? obj.propertyVersions[key] : 0) + 1;
  if (!existed) obj.shapeVersion++;
  if (obj.kind === 'array' && arrayIndex(key) && Number(key) >= decode(obj.properties.length.value)) {
    obj.properties.length = token(['num',Number(key)+1],eventId);
    obj.propertyVersions.length = (obj.propertyVersions.length ?? 0) + 1;
  }
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
  constructor({adapters={},maxSteps=100000}={}) {
    this.adapters=adapters;
    this.maxSteps=maxSteps;
    this.sources=[];this.sites=[];this.programs={};this.events=[];this.chunks=[];
    this.checkpoints={};this.started=false;
    this.state={counters:{ids:{version:0,env:0,obj:0,promise:0,frame:0,effect:0,input:0,operation:0}},envs:{},heap:{},promises:{},frames:{},effects:{},inputs:{},operations:{},control:{a0:{version:0,activeFrameId:null,queue:[],status:'new'}}};
    this.chunkStart=0;this.chunkBefore='q0';this.result=U;
  }
  registerSource({text,url='<inline>',goal='script',trainingProfile=false}={}) {
    if(this.started)throw new Error('Source registry is frozen after start');
    if(goal!=='script')throw new SyntaxError('Only script goal is implemented');
    if(typeof text!=='string')throw new TypeError('Source text required');
    const sourceId=`src${this.sources.length+1}`;
    const compiled=compile(trainingProfile?parseTraining(text):parse(text));
    const rename={};
    for(const id of Object.keys(compiled.programs))rename[id]=`${sourceId}:${id}`;
    for(const [id,program] of Object.entries(compiled.programs))this.programs[rename[id]]={...program,id:rename[id],instructions:program.instructions.map(inst=>['DEF_FN','MAKE_FUNCTION'].includes(inst.op)?{...inst,arg:{...inst.arg,codeId:rename[inst.arg.codeId]},siteId:`${sourceId}:${inst.siteId}`}:{...inst,siteId:`${sourceId}:${inst.siteId}`})};
    this.sites.push(...compiled.sites.map(site=>({...site,siteId:`${sourceId}:${site.siteId}`,codeId:rename[site.codeId],sourceId})));
    const record={sourceId,text,url,goal,entry:rename[compiled.entry],parser:trainingProfile?TRAINING_PARSER:'bounded-pratt/2'};
    this.sources.push(record);return record;
  }
  next(draft,kind) {const ids=draft.counters.ids;return `${kind==='operation'?'op':kind[0]}${++ids[kind]}`;}
  newEnv(draft,parent=null) {const id=this.next(draft,'env');draft.envs[id]={id,parent,bindings:{},version:0};return id;}
  newPromise(draft,status='pending',value=null) {const id=this.next(draft,'promise');draft.promises[id]={id,status,value,observers:[],adopters:[],adopting:null,version:0};return id;}
  newFrame(draft,codeId,parentEnv,callerFrameId=null,asyncPromiseId=null,args=[],thisValue=U) {
    const id=this.next(draft,'frame'),envId=this.newEnv(draft,parentEnv);
    const params=this.programs[codeId].params;
    params.forEach((name,i)=>draft.envs[envId].bindings[name]={kind:'parameter',initialized:true,token:args[i]??token(U),version:0});
    draft.frames[id]={id,codeId,pc:0,stack:[],envId,callerFrameId,asyncPromiseId,status:'running',blockedOn:null,awaiting:null,operationId:null,pendingCoercionThrow:null,handlers:[],loops:[],thisValue,version:0};
    return id;
  }
  start(source) {
    if(this.started)throw new Error('Run already started');
    if(typeof source==='string')source=this.registerSource({text:source});
    if(!this.sources.some(s=>s.sourceId===source.sourceId))throw new Error('Unknown source');
    const s=this.state,global=this.newEnv(s);
    s.envs[global].bindings.host={kind:'const',initialized:true,token:token(['host','demo'])};
    s.envs[global].bindings.Promise={kind:'const',initialized:true,token:token(['intrinsic','Promise'])};
    for(const name of ['Object','Array','Number','Math'])
      s.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['intrinsic',name]),version:0};
    s.envs[global].bindings.undefined={kind:'const',initialized:true,token:token(U),version:0};
    s.control.a0.globalEnvId=global;
    s.control.a0.activeFrameId=this.newFrame(s,source.entry,global);
    s.control.a0.status='running';this.started=true;
    this.initialState=copy(this.state);this.checkpoints.q0=copy(this.state);
    return this;
  }
  /** Explicit invocation entry for training-js/1. The top level contains only
   * an exact strict directive and named ordinary function declarations. */
  startEntry({text,source=null,functionName,args=[]}={}) {
    if(this.started)throw new Error('Run already started');
    if(!source)source=this.registerSource({text,trainingProfile:true});
    if(source.parser!==TRAINING_PARSER)throw new SyntaxError('Entry requires the Acorn training profile');
    const ast=parseTraining(source.text);
    if(!ast.body.length || ast.body[0].type!=='Expression' ||
       ast.body[0].expr.type!=='Literal' ||
       ast.body[0].expr.value[0]!=='str' || ast.body[0].expr.value[1]!=='use strict' ||
       ast.body.slice(1).some(n=>n.type!=='Function' || n.async))
      throw new SyntaxError('training-js/1 requires a strict function bundle without top-level effects');
    const definitions=this.programs[source.entry].instructions.filter(x=>x.op==='DEF_FN');
    if(new Set(definitions.map(x=>x.arg.name)).size!==definitions.length)
      throw new SyntaxError('Duplicate function declaration');
    const selected=definitions.find(x=>x.arg.name===functionName);
    if(!selected)throw new ReferenceError('Unknown entry function');
    const state=this.state, global=this.newEnv(state);
    state.envs[global].bindings.undefined={kind:'const',initialized:true,token:token(U),version:0};
    for(const name of ['Object','Array','Number','Math'])
      state.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['intrinsic',name]),version:0};
    state.control.a0.globalEnvId=global;
    for(const def of definitions){
      const id=this.next(state,'obj');
      state.heap[id]={id,kind:'function',codeId:def.arg.codeId,
        closureEnvId:global,async:false,version:0};
      state.envs[global].bindings[def.arg.name]={kind:'function',initialized:true,token:token(['ref',id]),version:0};
    }
    const imported=importGraph(state,args,kind=>this.next(state,kind));
    const root=this.newFrame(state,selected.arg.codeId,global,null,null,imported.map(v=>token(v)));
    state.control.a0.activeFrameId=root;
    state.control.a0.status='running';
    this.entrySpec={kind:'function',sourceId:source.sourceId,functionName,arguments:imported};
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
  completeFrame(draft,frame,value,origin) {
    frame.status='completed';
    if(frame.asyncPromiseId){this.resolvePromise(draft,frame.asyncPromiseId,value,origin);value=['promise',frame.asyncPromiseId];}
    if(frame.reactionPromiseId)this.resolvePromise(draft,frame.reactionPromiseId,value,origin);
    if(frame.reactionJob){draft.control.a0.activeFrameId=null;return;}
    if(frame.callerFrameId){
      const caller=draft.frames[frame.callerFrameId],pending=caller.pendingProperty;
      if(pending?.waitingFrameId===frame.id){
        caller.pendingProperty=null;
        if(pending.kind==='get'&&pending.method)value=['method',value,pending.receiver];
        if(pending.kind==='set')value=pending.value;
      }
      this.stackPush(caller,value,origin);draft.control.a0.activeFrameId=caller.id;
    }
    else {draft.control.a0.activeFrameId=null;draft.control.a0.completion={kind:'return',value};
      draft.control.a0.status='completed';if(!frame.asyncPromiseId)this.result=value;}
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
    const adopters=p.adopters??[];p.adopters=[];
    for(const adoptedId of adopters) {
      const adopted=draft.promises[adoptedId];
      if(adopted.adopting!==id)throw new Error('Broken promise adoption link');
      adopted.adopting=null;
      this.settlePromise(draft,adoptedId,status,value,origin);
    }
  }
  rejectPromise(draft,id,reason,origin) {
    // Rejection reasons are opaque guest values, including promise identities.
    this.settlePromise(draft,id,'rejected',reason,origin);
  }
  resolvePromise(draft,id,value,origin) {
    const p=draft.promises[id];if(!p||p.status!=='pending'||p.adopting)
      throw new Error('Promise already settled or adopting another promise');
    if(value[0]==='promise'){
      const target=draft.promises[value[1]];
      if(!target)throw new Error('Unknown guest promise');
      let cycle=target===p;
      const seen=new Set();
      for(let current=target;!cycle&&current?.adopting;current=draft.promises[current.adopting]){
        if(seen.has(current.id)||current.adopting===id)cycle=true;
        seen.add(current.id);
      }
      if(cycle){
        const reason=this.caughtError(draft,{errorType:'TypeError',
          message:'Chaining cycle detected for promise'},origin);
        this.rejectPromise(draft,id,reason.value,reason.origin);
        return;
      }
      if(target.status==='pending'){
        p.adopting=target.id;target.adopters??=[];target.adopters.push(id);return;
      }
      this.settlePromise(draft,id,target.status,target.value.value,target.value.origin);
      return;
    }
    this.settlePromise(draft,id,'fulfilled',value,origin);
  }
  suspendAsync(draft,frame) {
    frame.status='suspended';
    if(frame.callerFrameId) {
      this.stackPush(draft.frames[frame.callerFrameId],['promise',frame.asyncPromiseId],null);
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
    draft.heap[id]={id,kind:'object',properties:{
      name:token(['str',completion.errorType],eventId),
      message:token(['str',completion.message??''],eventId)
    },propertyVersions:{name:1,message:1},shapeVersion:2,version:0};
    // Only own name/message data properties are modeled, not Error prototypes,
    // stacks, identity of native constructors, or instanceof.
    return token(['ref',id],eventId);
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
      if(frame.asyncPromiseId){
        // Async throws reject a guest promise, never the whole agent.
        const reason=this.caughtError(draft,completion,eventId);
        this.rejectPromise(draft,frame.asyncPromiseId,reason.value,reason.origin);
        if(frame.callerFrameId){
          const caller=draft.frames[frame.callerFrameId];
          this.stackPush(caller,['promise',frame.asyncPromiseId],eventId);
          draft.control.a0.activeFrameId=caller.id;
        }else draft.control.a0.activeFrameId=null;
      }else if(frame.reactionPromiseId){
        const reason=this.caughtError(draft,completion,eventId);
        this.rejectPromise(draft,frame.reactionPromiseId,reason.value,reason.origin);
        draft.control.a0.activeFrameId=null;
      }else if(frame.callerFrameId){
        const caller=draft.frames[frame.callerFrameId];
        if(caller.pendingProperty?.waitingFrameId===frame.id)caller.pendingProperty=null;
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
        invoke:(method,receiver)=>{
          const target=s.heap[method[1]];
          const promiseId=target.async?this.newPromise(s):null;
          const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,[],receiver);
          s.control.a0.activeFrameId=id;
          return id;
        },
        takeReturn:waitingId=>{
          if(s.frames[waitingId]?.status!=='completed'||!f.stack.length)
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
    const inst=this.programs[frame.codeId].instructions[frame.pc];
    if(!inst)throw new Error('Program counter out of range');
    const {op,arg}=inst;
    return this.commit(opNames[op],(s,eventId)=>{
      const f=s.frames[frame.id], st=f.stack;f.pc++;
      const pop=()=>{if(!st.length)throw new Error(`Stack underflow: ${op}`);return st.pop();};
      const result=(v)=>{this.stackPush(f,v,eventId);return {result:v};};
      const operands=(...t)=>({operands:t.map(x=>x.value),origins:t.map(x=>x.origin)});
      try { switch(op){
        case 'CONST':return result(arg.value);
        case 'THIS':
          if(f.thisValue[0]==='undefined')
            throw new TypeError('Global sloppy this is not modeled by the bounded object profile');
          return result(f.thisValue);
        case 'DECLARE':{const e=s.envs[f.envId];if(Object.hasOwn(e.bindings,arg.name))throw new SyntaxError(`Duplicate declaration ${arg.name}`);e.bindings[arg.name]={kind:arg.kind,initialized:false,token:null,version:0};return {};}
        case 'INIT':{const v=pop(),b=lookup(s,f.envId,arg);if(b.cell.initialized)throw new Error('Already initialized');b.cell.initialized=true;b.cell.token=v;b.cell.version++;return {...operands(v),result:v.value};}
        case 'GET':{const b=lookup(s,f.envId,arg);if(!b.cell.initialized)guestFault('ReferenceError',`Cannot access '${arg}' before initialization`);this.stackPush(f,b.cell.token.value,eventId);return {result:b.cell.token.value,reads:[{kind:'binding',envId:b.env.id,name:arg,version:b.cell.version??0,
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
            guestFault('ReferenceError',`Cannot access '${arg}' before initialization`);
          const value=found.cell.token;
          const type=primitiveUnary('typeof',value.value,s.heap);
          this.stackPush(f,type,eventId);
          return {operands:[value.value],origins:[value.origin],result:type,
            reads:[{kind:'binding',envId:found.env.id,name:arg,
              version:found.cell.version??0,value:value.value,
              supplyingEvent:value.origin??null}]};
        }
        case 'SET':{const v=pop(),b=lookup(s,f.envId,arg);if(!b.cell.initialized)guestFault('ReferenceError',`${arg} is not initialized`);if(b.cell.kind==='const')guestFault('TypeError',`Assignment to constant ${arg}`);b.cell.token=v;b.cell.version=(b.cell.version??0)+1;this.stackPush(f,v.value,eventId);return {...operands(v),result:v.value};}
        case 'UPDATE_BINDING':{
          const b=lookup(s,f.envId,arg.name);
          if(!b.cell.initialized)
            guestFault('ReferenceError',`Cannot access '${arg.name}' before initialization`);
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
          const key=pop(),base=pop(),property=valueKey(key.value);
          if(['undefined','null'].includes(base.value[0]))
            guestFault('TypeError','Cannot update properties of '+base.value[0]);
          if(base.value[0]!=='ref')throw new TypeError('Unowned update receiver');
          const obj=s.heap[base.value[1]];
          if(!obj||!['object','array'].includes(obj.kind))
            throw new TypeError('Proxy, function and exotic updates require owned internal methods');
          if(propertyAccessor(s.heap,base.value,property))
            throw new TypeError('Accessor updates need an owned getter/setter continuation');
          const found=ordinaryGet(s.heap,base.value,property);
          if(!found)throw new TypeError('Unowned update property read');
          const old=found.method;
          const {next,oldNumeric}=scalarUpdate(old.value,arg.operator);
          const returned=arg.prefix?next:oldNumeric;
          if(this.entrySpec && obj.kind==='array'){
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
        case 'MAKE_FUNCTION':{
          const id=this.next(s,'obj');
          s.heap[id]={id,kind:'function',codeId:arg.codeId,
            closureEnvId:f.envId,async:false,arrow:arg.arrow===true,
            lexicalThis:arg.arrow?f.thisValue:null,version:0};
          return result(['ref',id]);
        }
        case 'DEF_FN':{const e=s.envs[f.envId],id=this.next(s,'obj');s.heap[id]={id,kind:'function',codeId:arg.codeId,closureEnvId:f.envId,async:arg.async,version:0};e.bindings[arg.name]={kind:'function',initialized:true,token:token(['ref',id],eventId),version:0};return {result:['ref',id]};}
        case 'ENTER_SCOPE':f.envId=this.newEnv(s,f.envId);return {};
        case 'LEAVE_SCOPE':f.envId=s.envs[f.envId].parent;return {};
        case 'CLONE_LOOP_ENV':{
          const loop=f.loops.at(-1);
          if(!loop || loop.envId!==f.envId)
            throw new Error('Iteration clone outside its lexical loop');
          const original=s.envs[f.envId],binding=original.bindings[arg];
          if(!binding || binding.kind!=='let' || !binding.initialized)
            throw new Error('Iteration needs an initialized let binding');
          const envId=this.newEnv(s,original.parent);
          s.envs[envId].bindings[arg]=copy(binding);
          loop.envId=envId;
          f.envId=envId;
          return {reads:[{kind:'binding',envId:original.id,name:arg,
            version:binding.version??0,value:binding.token.value,
            supplyingEvent:binding.token.origin??null}]};
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
          const loop=f.loops.at(-1);
          if(!loop)throw new Error('No active loop for break/continue');
          this.routeCompletion(s,f,{type:'jump',kind:arg,
            targetPc:arg==='break'?loop.breakPc:loop.continuePc,
            envId:loop.envId,stackDepth:loop.stackDepth,
            handlerDepth:loop.handlerDepth,loopDepth:f.loops.length},eventId);
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
          if(!isOwnedArithmetic(arg))return {...operands(a,b),...result(primitiveBinary(arg,a.value,b.value))};
          const id=this.next(s,'operation');
          s.operations[id]=createArithmetic({id,frameId:f.id,operator:arg,left:a,right:b,
            siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId});
          f.operationId=id;
          return {...operands(a,b),causes:[{kind:'spec-operation',operationId:id}]};
        }
        case 'UNARY':{
          const a=pop();
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
        case 'LOGICAL_JUMP':{const a=st.at(-1),v=a.value;const pass=arg.operator==='&&'?!truthy(v):arg.operator==='||'?truthy(v):v[0]!=='null'&&v[0]!=='undefined';if(pass)f.pc=arg.to;return {...operands(a),result:['bool',pass]};}
        case 'NEW_PROXY':{
          const handler=pop(),target=pop();
          if(target.value[0]!=='ref'||!['object','array','proxy'].includes(s.heap[target.value[1]]?.kind)||
             handler.value[0]!=='ref'||!['object','array'].includes(s.heap[handler.value[1]]?.kind))
            guestFault('TypeError','Proxy requires an ordinary owned target and handler');
          const id=this.next(s,'obj');
          s.heap[id]={id,kind:'proxy',targetId:target.value[1],handlerId:handler.value[1],
            properties:{},propertyVersions:{},shapeVersion:0,version:0};
          return {...operands(target,handler),...result(['ref',id])};
        }
        case 'NEW_OBJECT':case 'NEW_ARRAY':{const id=this.next(s,'obj');s.heap[id]={id,kind:op==='NEW_ARRAY'?'array':'object',properties:{},propertyVersions:{},shapeVersion:0,version:0};if(op==='NEW_ARRAY'){s.heap[id].properties.length=token(['num',0],eventId);s.heap[id].propertyVersions.length=0;}return result(['ref',id]);}
        case 'GET_PROP':case 'GET_METHOD':{
          const key=pop(),base=pop(),property=valueKey(key.value);let v,read=null;
          if(base.value[0]==='host')v=['hostfn',`${base.value[1]}.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Promise' && ['resolve','reject'].includes(property))v=['builtinfn',`Promise.${property}`];
          else if(base.value[0]==='intrinsic' &&
             ((base.value[1]==='Math' &&
               ['abs','ceil','floor','trunc','round','max','min','pow','sign','sqrt','hypot'].includes(property)) ||
              (base.value[1]==='Number' &&
               ['isFinite','isNaN','isInteger','isSafeInteger'].includes(property)) ||
              (base.value[1]==='Array' && property==='isArray')))
            v=['builtinfn',base.value[1]+'.'+property];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' &&
             ['create','setPrototypeOf','getPrototypeOf','defineProperty','hasOwn','keys','is'].includes(property))
            v=['builtinfn',`Object.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' && property==='prototype')
            v=['intrinsic','Object.prototype'];
          else if(base.value[0]==='promise'){
             if(!s.promises[base.value[1]])throw new ReferenceError('Unknown guest promise');
             if(!['then','catch','finally'].includes(property))
               throw new TypeError('Unmodeled Promise prototype property: '+property);
             v=['builtinfn','Promise.prototype.'+property];
           }
           else if(base.value[0]==='ref'){
             const obj=s.heap[base.value[1]];
             if(!obj)throw new ReferenceError('Unknown guest identity');
             const route=obj.kind==='proxy'?proxyRoute(s.heap,base.value,'get'):
               {kind:'ordinary',target:base.value,receiver:base.value};
             if(route.kind==='trap'){
               const target=s.heap[route.target[1]];
               if(Object.hasOwn(target?.accessors??{},property)&&!target.accessors[property].configurable)
                 throw new TypeError('Proxy get invariant for non-configurable accessor not modeled');
               const trap=route.method;
               if(!this.callableGuest(s,trap)||s.heap[trap[1]].async)
                 throw new TypeError('Proxy get trap must be synchronous guest function');
               const fn=s.heap[trap[1]];
               const id=this.newFrame(s,fn.codeId,fn.closureEnvId,
                 f.id,null,[token(route.target),key,token(base.value)],route.handler);
               f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id};
               s.control.a0.activeFrameId=id;
               return {...operands(base,key),causes:[{kind:'invocation',frameId:id}],
                 reads:[route.observation]};
             }
             const accessor=propertyAccessor(s.heap,route.target,property);
             if(accessor){
               const getter=accessor.get.value;
               if(getter[0]==='undefined')v=U;
               else{
                 if(!this.callableGuest(s,getter)||s.heap[getter[1]].async)
                   throw new TypeError('Unsupported accessor getter continuation');
                 const target=s.heap[getter[1]];
                 const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,null,[],base.value);
                 f.pendingProperty={kind:'get',receiver:base.value,method:op==='GET_METHOD',waitingFrameId:id};
                 s.control.a0.activeFrameId=id;
                 return {...operands(base,key),causes:[{kind:'invocation',frameId:id}]};
               }
             }else{
               const found=ordinaryGet(s.heap,route.target,property);
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
        case 'PUT_PROP':{
          const v=pop(),key=pop(),base=pop(),property=valueKey(key.value);
          if(['null','undefined'].includes(base.value[0]))
             guestFault('TypeError',`Cannot set properties of ${base.value[0]}`);
           if(base.value[0]!=='ref'||!s.heap[base.value[1]]||s.heap[base.value[1]].kind==='function')throw new TypeError('Not a writable guest object');
          const object=s.heap[base.value[1]];
          const route=object.kind==='proxy'?proxyRoute(s.heap,base.value,'set'):
            {kind:'ordinary',target:base.value,receiver:base.value};
          if(route.kind==='trap'){
            const target=s.heap[route.target[1]];
            if(Object.hasOwn(target?.accessors??{},property)&&!target.accessors[property].configurable)
              throw new TypeError('Proxy set invariant for non-configurable accessor not modeled');
            if(!this.callableGuest(s,route.method)||s.heap[route.method[1]].async)
              throw new TypeError('Proxy set trap must be synchronous guest function');
            const fn=s.heap[route.method[1]];
            const id=this.newFrame(s,fn.codeId,fn.closureEnvId,
              f.id,null,[token(route.target),key,v,token(base.value)],route.handler);
            f.pendingProperty={kind:'set',value:v.value,waitingFrameId:id};
            s.control.a0.activeFrameId=id;
            return {...operands(base,key,v),causes:[{kind:'invocation',frameId:id}],
              reads:[route.observation]};
          }
          const obj=s.heap[route.target[1]];
          const accessor=propertyAccessor(s.heap,route.target,property);
          if(accessor){
            const setter=accessor.set.value;
            if(setter[0]==='undefined')return {...operands(base,key,v),...result(v.value)};
            if(!this.callableGuest(s,setter)||s.heap[setter[1]].async)
              throw new TypeError('Unsupported accessor setter continuation');
            const target=s.heap[setter[1]];
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,null,[v],base.value);
            f.pendingProperty={kind:'set',value:v.value,waitingFrameId:id};
            s.control.a0.activeFrameId=id;
            return {...operands(base,key,v),causes:[{kind:'invocation',frameId:id}]};
          }
          if(this.entrySpec && obj.kind==='array') {
            const oldLength=decode(obj.properties.length.value);
            if(arrayIndex(property) && Number(property)>oldLength)
              throw new TypeError('Sparse array writes are outside training-js/1');
            if(property==='length' && v.value[0]==='num' && decode(v.value)>oldLength)
              throw new TypeError('Array length expansion is outside training-js/1');
          }
          obj.propertyVersions ??= {};
          obj.shapeVersion ??= 0;
          putOwn(obj,property,v.value,eventId);
          return {...operands(base,key,v),...result(v.value)};
        }
        case 'CALL':{
          const args=[];for(let i=0;i<arg;i++)args.unshift(pop());
          const fn=pop();let callable=fn.value;
          const receiver=callable[0]==='method'?callable[2]:U;
          if(callable[0]==='method')callable=callable[1];
          if(callable[0]==='ref' && s.heap[callable[1]]?.kind==='function'){
            const target=s.heap[callable[1]],promiseId=target.async?this.newPromise(s):null;
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,args,
              target.arrow?target.lexicalThis:receiver);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),result:['ref',callable[1]],causes:[{kind:'invocation',frameId:id}]};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Math.')){
            const method=callable[1].slice('Math.'.length);
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
          if(callable[0]==='builtinfn' && ['Object.hasOwn','Object.keys'].includes(callable[1])){
            const base=args[0]?.value??U,obj=base[0]==='ref'?s.heap[base[1]]:null;
            if(!obj||!['object','array'].includes(obj.kind))
              throw new TypeError('Object builtin requires an owned ordinary reference');
            if(callable[1]==='Object.hasOwn'){
              const property=valueKey(args[1]?.value??U);
              return {...operands(fn,...args),...result(['bool',
                Object.hasOwn(obj.properties,property) ||
                Object.hasOwn(obj.accessors??{},property)])};
            }
            if(Object.keys(obj.accessors??{}).length)
              throw new TypeError('Ordered accessor enumeration is outside the bounded profile');
            const keys=Object.keys(obj.properties).filter(k=>obj.kind!=='array'||k!=='length');
            const id=this.next(s,'obj');
            const array=s.heap[id]={id,kind:'array',properties:{length:token(['num',0],eventId)},
              propertyVersions:{length:0},shapeVersion:0,version:0};
            keys.forEach((key,i)=>putOwn(array,String(i),['str',key],eventId));
            return {...operands(fn,...args),...result(['ref',id])};
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
             const promiseId=this.newPromise(s);
             const reaction={kind:method==='finally'?'finally':'then',resultId:promiseId,
               onFulfilled:method==='then'?(args[0]?.value??U):U,
               onRejected:method==='catch'?(args[0]?.value??U):
                 method==='then'?(args[1]?.value??U):U,
               onFinally:method==='finally'?(args[0]?.value??U):U};
             this.observePromise(s,receiver[1],{kind:'reaction',reaction});
             return {...operands(fn,...args),...result(['promise',promiseId]),
               causes:[{kind:'promise',promiseId:receiver[1]}]};
           }
           if(callable[0]==='builtinfn' && ['Object.create','Object.setPrototypeOf','Object.getPrototypeOf','Object.defineProperty'].includes(callable[1])){
            const primitiveProto=v=>{
              if(v?.[0]==='null')return null;
              if(v?.[0]==='intrinsic' && ['Object.prototype','Array.prototype'].includes(v[1]))return v[1];
              if(v?.[0]==='ref' && ['object','array'].includes(s.heap[v[1]]?.kind))return v[1];
              guestFault('TypeError','Prototype must be null or an owned ordinary object');
            };
            const v=args[0]?.value??U, obj=v[0]==='ref'?s.heap[v[1]]:null;
            if(callable[1]==='Object.defineProperty'){
              if(!obj||!['object','array'].includes(obj.kind))
                guestFault('TypeError','Object.defineProperty requires an owned ordinary object');
              const key=args[1]?.value??U,descValue=args[2]?.value??U;
              const name=valueKey(key),descriptor=descValue[0]==='ref'?s.heap[descValue[1]]:null;
              if(!descriptor||!['object','array'].includes(descriptor.kind)||
                 Object.keys(descriptor.accessors??{}).length)
                guestFault('TypeError','Accessor descriptor must be an owned data object');
              const d=descriptor.properties;
              if(!Object.hasOwn(d,'get')&&!Object.hasOwn(d,'set'))
                throw new TypeError('Only accessor descriptors are modeled');
              if(Object.hasOwn(d,'value')||Object.hasOwn(d,'writable'))
                guestFault('TypeError','Invalid mixed data/accessor descriptor');
              const getter=d.get??token(U),setter=d.set??token(U);
              for(const method of [getter,setter])
                if(method.value[0]!=='undefined'&&!this.callableGuest(s,method.value))
                  guestFault('TypeError','Accessor must be a guest function or undefined');
              if((Object.hasOwn(obj.accessors??{},name)&&!obj.accessors[name].configurable)||
                 name==='__proto__'||(obj.kind==='array'&&name==='length'))
                guestFault('TypeError','Cannot redefine a non-configurable or reserved property');
              obj.accessors??={};
              obj.accessors[name]={get:getter,set:setter,
                enumerable:Object.hasOwn(d,'enumerable')?truthy(d.enumerable.value):false,
                configurable:Object.hasOwn(d,'configurable')?truthy(d.configurable.value):false};
              delete obj.properties[name];
              obj.propertyVersions[name]=(Object.hasOwn(obj.propertyVersions,name)?obj.propertyVersions[name]:0)+1;
              obj.shapeVersion++;
              return {...operands(fn,...args),...result(v)};
            }
            if(callable[1]==='Object.create'){
              const proto=primitiveProto(v),id=this.next(s,'obj');
              s.heap[id]={id,kind:'object',prototype:proto,properties:{},propertyVersions:{},
                shapeVersion:0,version:0};
              return {...operands(fn,...args),...result(['ref',id])};
            }
            if(!obj||!['object','array'].includes(obj.kind))
              guestFault('TypeError','Prototype operation requires an owned ordinary object');
            if(callable[1]==='Object.getPrototypeOf'){
              const proto=objectPrototype(obj);
              const out=proto===null?['null']:
                proto==='Object.prototype'||proto==='Array.prototype'?['intrinsic',proto]:['ref',proto];
              return {...operands(fn,...args),...result(out)};
            }
            const proto=primitiveProto(args[1]?.value??U);
            const visited=new Set([obj.id]);
            let current=proto;
            while(current!==null && current!=='Object.prototype' && current!=='Array.prototype'){
              if(visited.has(current))guestFault('TypeError','Cyclic prototype value');
              visited.add(current);
              const next=s.heap[current];
              if(!next||!['object','array'].includes(next.kind))
                throw new TypeError('Broken prototype identity');
              current=objectPrototype(next);
            }
            if(objectPrototype(obj)!==proto){obj.prototype=proto;obj.shapeVersion++;}
            return {...operands(fn,...args),...result(v)};
          }
          if(callable[0]==='builtinfn' && ['Object.valueOf','Object.toString','Array.toString'].includes(callable[1])){
            const v=ordinaryBuiltin(s.heap,receiver,callable[1]);
            if(v===null)throw new TypeError('Unowned builtin receiver or array coercion');
            return {...operands(fn,...args),...result(v)};
          }
          if(callable[0]==='builtinfn' && ['Promise.resolve','Promise.reject'].includes(callable[1])){
            const v=args[0]?.value??U,origin=args[0]?.origin??null;
            if(callable[1]==='Promise.resolve' && v[0]==='promise')
              return {...operands(fn,...args),...result(v)};
            const p=this.newPromise(s,callable[1]==='Promise.resolve'?'fulfilled':'rejected',token(v,origin));
            return {...operands(fn,...args),...result(['promise',p])};
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
              dispatch:'prepared',external:'pending',immediate:kind==='promise'?'completed':'awaiting',outcomeIds:[],inputIds:[],version:0};
            if(kind==='promise')this.stackPush(f,['promise',promiseId],eventId);
            else {f.status='blocked';f.blockedOn=id;}
            return {...operands(fn,...args),result:kind==='promise'?['promise',promiseId]:null,causes:[{kind:'effect',effectId:id}]};
          }
          guestFault('TypeError','Not a callable guest function');
        }
        case 'AWAIT':{
          const a=pop(),v=a.value;if(!f.asyncPromiseId)throw new SyntaxError('await outside async function');
          const promiseId=v[0]==='promise'?v[1]:this.newPromise(s,'fulfilled',a);
          f.awaiting=promiseId;this.observePromise(s,promiseId,{kind:'await',frameId:f.id});
          this.suspendAsync(s,f);return {...operands(a),causes:[{kind:'promise',promiseId}]};
        }
        case 'RETURN':{const v=pop();this.routeCompletion(s,f,{type:'return',value:v},eventId);return {...operands(v),result:v.value};}
        case 'THROW':{const v=pop(),completion={type:'throw',value:v};this.routeCompletion(s,f,completion,eventId);return {...operands(v),completion};}
        default:throw new Error(`Unknown opcode ${op}`);
      }} catch(error) {
        if(!(error instanceof GuestFault))throw error;
        const completion={type:'throw',errorType:error.name,message:error.message,origin:eventId};
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
  recordInputArrival({effectId,kind,value,abrupt=false,inputId=null}={}) {
    const e=this.state.effects[effectId];if(!e||e.dispatch!=='dispatched')throw new Error('Input requires a dispatched effect');
    if(kind!==(e.kind==='promise'?'completion':'immediate'))throw new Error('Wrong input kind for host call');
    if(e.external!=='pending')throw new Error('Effect already completed');
    if(e.inputIds.length)throw new Error('Effect already has an input arrival');
    if(typeof abrupt!=='boolean')throw new TypeError('Input abrupt must be boolean');
    if(inputId!==null && (typeof inputId!=='string'||!inputId||['__proto__','constructor','prototype'].includes(inputId)))
      throw new TypeError('Transport input ID must be a nonempty, non-reserved string');
    if(Array.isArray(value) && !guestValue(value))throw new TypeError('Unsupported canonical external payload');
    const encoded=guestValue(value)?copy(value):encode(value);
    let allocated;
    this.commit('external.input.arrive',s=>{
      if(inputId===null) {
        do { allocated=this.next(s,'input'); } while(Object.hasOwn(s.inputs,allocated));
      } else allocated=inputId;
      if(Object.hasOwn(s.inputs,allocated))throw new Error('Duplicate input ID');
      s.inputs[allocated]={id:allocated,effectId,kind,abrupt,value:encoded,status:'arrived',version:0};
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
      const job=s.control.a0.queue.shift(),p=s.promises[job.promiseId];
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
        let targetPromiseId=reaction.resultId;
        if(isFinally){
          // Adopt returned guest promises before preserving original outcome.
          targetPromiseId=this.newPromise(s);
          this.observePromise(s,targetPromiseId,{kind:'finally-pass',
            resultId:reaction.resultId,originalStatus:p.status,original});
        }
        const fn=s.heap[callback[1]];
        const args=isFinally?[]:[original];
        const inner=fn.async?this.newPromise(s):null;
        const id=this.newFrame(s,fn.codeId,fn.closureEnvId,null,inner,args,U);
        const child=s.frames[id];
        child.reactionJob=true;
        if(inner)this.resolvePromise(s,targetPromiseId,['promise',inner],eventId);
        else child.reactionPromiseId=targetPromiseId;
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
  drive() {
    if(!this.started)throw new Error('Start first');
    let steps=0;
    while(steps++<this.maxSteps) {
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
      if(c.queue.length){this.enterQueuedJob();continue;}
      const pendingPromises=Object.values(this.state.promises).some(p=>p.status==='pending');
      const pendingEffects=Object.values(this.state.effects).some(e=>e.external==='pending');
      const kind=pendingPromises||pendingEffects?'waiting':'terminated';
      this.seal(kind);return {kind,waitingOn:this.chunks.at(-1)?.exit.waitingOn??[],pendingEffects:this.chunks.at(-1)?.exit.pendingEffects??[]};
    }
    throw new Error(`Driver safety limit (${this.maxSteps} steps); no chunk has been misreported as complete`);
  }
  checkpoint() {return {stateRoot:`q${this.events.length}`,state:copy(this.state)};}
  inspectState() {return copy(this.state);}
  inspectOpenChunk() {return {before:this.chunkBefore,eventIds:this.events.slice(this.chunkStart).map(e=>e.eventId),open:true};}
  exportRun() {
    const bundle={manifest:{schema:'semantic-tracing-run/2',profile:this.entrySpec?'training-js/1':'bounded-js-subset/2',completeSemanticTrace:false,
      completeEcma262:false,completeHostIntegration:false,coverage:'docs/STATUS.md',chunkPolicy:'accumulate-until-wait/1',
      eventVersion:2,operationVersion:2,mutationSchema:'owned-spec-commands/2',
      ownedArithmetic:{revision:2,referenceEngineRevision:ENGINE_REVISION,operators:['+','-','*','/','%','**'],domain:'primitives-and-bounded-ordinary-data-objects'},
      guestExecution:'owned-bytecode-and-spec-phase-machine',replay:'bounded-deterministic-reexecution/2'},
      sources:this.sources,sites:this.sites,programs:this.programs,entrySpec:this.entrySpec??null,initialState:this.initialState,finalState:this.state,
      events:this.events,chunks:this.chunks,checkpoints:this.checkpoints,effects:this.state.effects,inputs:this.state.inputs};
    requireDataOnly(bundle);
    return copy(bundle);
  }
}
export function createRuntime(options){return new Runtime(options);}
