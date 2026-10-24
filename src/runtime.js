import { encode, decode, U, token, truthy, primitiveBinary, primitiveUnary } from './values.js';
import { parse, compile } from './frontend.js';
import { importGraph } from './training/graph.js';
import { parseTraining, TRAINING_PARSER } from './training/profile.js';
import { createArithmetic, advanceArithmetic, isOwnedArithmetic, ordinaryGet, ordinaryBuiltin, objectPrototype } from './spec-operations.js';
import { operationMutation } from './spec-mutations.js';
import {hostOperation,prepareHostRequest} from './host/operations.js';
import { specStep, ENGINE_REVISION } from './spec-schema.js';
import {supportsPinnedRegExp,testPinnedRegExp,scanPinnedReplacement} from './owned-pinned-regexp.js';

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
  CONST:'literal.materialize', GET:'binding.read',
  DEFAULT_GUARD:'binding.default.guard', SET:'binding.write', UPDATE_BINDING:'binding.update', UPDATE_PROP:'property.update', INIT:'binding.initialize', DECLARE:'binding.declare',
  DEF_FN:'function.define', BINARY:'primitive.binary', UNARY:'primitive.unary', POP:'stack.pop', DUP:'stack.duplicate', DUP2:'stack.duplicate',
  CALL:'call.enter', CONSTRUCT:'object.construct', NEW_PINNED_REGEXP:'regexp.allocate', UNSUPPORTED_EXPRESSION:'execution.unsupported', RETURN:'call.return', THROW:'completion.throw', AWAIT:'async.await', TYPEOF_BINDING:'primitive.unary', MAKE_FUNCTION:'function.define', NEW_OBJECT:'object.allocate', NEW_ARRAY:'array.allocate', NEW_PROXY:'proxy.allocate',
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
  newPromise(draft,status='pending',value=null) {const id=this.next(draft,'promise');draft.promises[id]={id,status,value,observers:[],adopters:[],adopting:null,resolverCalled:false,thenableSerial:0,thenableLocked:false,version:0};return id;}
  newFrame(draft,codeId,parentEnv,callerFrameId=null,asyncPromiseId=null,args=[],thisValue=U) {
    const id=this.next(draft,'frame'),envId=this.newEnv(draft,parentEnv);
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
      draft.envs[envId].bindings[name]={kind:'parameter',initialized:true,token:binding,version:0};
    });
    for(const name of this.programs[codeId].varNames??[])
      if(!Object.hasOwn(draft.envs[envId].bindings,name))
        draft.envs[envId].bindings[name]={kind:'var',initialized:true,
          token:token(U),version:0};
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
    for(const name of ['queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval'])
      s.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['builtinfn',name]),version:0};
    for(const name of ['Object','Array','Number','Math','SharedArrayBuffer','Int32Array','Atomics'])
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
  startEntry({text,source=null,functionName,args=[],allowAsync=false,allowHost=false}={}) {
    if(this.started)throw new Error('Run already started');
    if(!source)source=this.registerSource({text,trainingProfile:true});
    if(source.parser!==TRAINING_PARSER)throw new SyntaxError('Entry requires the Acorn training profile');
    const ast=parseTraining(source.text);
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
    const state=this.state, global=this.newEnv(state);
    state.envs[global].bindings.undefined={kind:'const',initialized:true,token:token(U),version:0};
    state.envs[global].bindings.NaN={kind:'const',initialized:true,token:token(['num','NaN']),version:0};
    state.envs[global].bindings.Infinity={kind:'const',initialized:true,token:token(['num','+Infinity']),version:0};
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
    for(const name of ['Object','Array','Number','Math','Promise','Set','Error','TypeError','SharedArrayBuffer','Int32Array','Atomics'])
      state.envs[global].bindings[name]={kind:'const',initialized:true,
        token:token(['intrinsic',name]),version:0};
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
        closureEnvId:global,async:false,version:0};
      state.envs[global].bindings[def.arg.name]={kind:'function',initialized:true,token:token(['ref',id]),version:0};
    }
    const imported=importGraph(state,args,kind=>this.next(state,kind));
    const rootPromise=selected.arg.async?this.newPromise(state):null;
     const root=this.newFrame(state,selected.arg.codeId,global,null,rootPromise,imported.map(v=>token(v)));
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
    if(frame.callerFrameId){
      const caller=draft.frames[frame.callerFrameId];
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
        pending.index++;
        pending.waitingFrameId=null;
        if(pending.index<pending.length){
          draft.control.a0.activeFrameId=caller.id;
          return;
        }
        value=pending.method==='reduce'?pending.accumulator:['ref',pending.outputId];
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
      params,fn.arrow?fn.lexicalThis:U);
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
        p.pair.map(v=>token(v)),fn.arrow?fn.lexicalThis:U);
      p.waitingFrameId=child;
      draft.control.a0.activeFrameId=child;
      return true;
    }
    for(;p.index<p.length;p.index++){
      const index=String(p.index),slot=array.properties[index];
      if(!slot||Object.hasOwn(array.accessors??{},index))
        throw new TypeError('Array callback needs owned data slots');
      const value=slot.value;
      const fn=draft.heap[p.callbackId];
      const params=p.method==='reduce'?
        [token(p.accumulator),token(value),token(['num',p.index]),token(['ref',p.arrayId])]:
        [token(value),token(['num',p.index]),token(['ref',p.arrayId])];
      const child=this.newFrame(draft,fn.codeId,fn.closureEnvId,caller.id,null,params,
        fn.arrow?fn.lexicalThis:U);
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
    if(value[0]==='ref'){
      const object=draft.heap[value[1]];
      if(object&&['object','array'].includes(object.kind)){
        const observed=ordinaryGet(draft.heap,value,'then');
        if(!observed)throw new TypeError('Exotic thenable getter is unowned');
        const then=observed.method.value;
        if(this.callableGuest(draft,then)){
          if(draft.heap[then[1]].async)throw new TypeError('Async then method is unowned');
          if(p.thenableSerial>=128||draft.control.a0.queue.length>=256)
            throw new RangeError('Bounded thenable jobs exceeded');
          const serial=++p.thenableSerial;p.thenableLocked=false;
          draft.control.a0.queue.push({kind:'thenable',promiseId:id,
            thenableId:value[1],thenId:then[1],serial});
          return;
        }
        if(['hostfn','builtinfn'].includes(then[0]))
          throw new TypeError('Native thenable callable unowned');
      }
    }
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
      if(frame.thenableJob){
        const p=draft.promises[frame.thenableJob.promiseId];
        if(p.status==='pending'&&!p.thenableLocked){
          p.thenableLocked=true;
          const reason=this.caughtError(draft,completion,eventId);
          this.rejectPromise(draft,p.id,reason.value,reason.origin);
        }
        draft.control.a0.activeFrameId=null;
      }else if(frame.asyncPromiseId){
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
        if(caller.pendingPromiseExecutor?.waitingFrameId===frame.id){
           const pending=caller.pendingPromiseExecutor;delete caller.pendingPromiseExecutor;
           const p=draft.promises[pending.promiseId];
           if(p.status==='pending'&&!p.resolverCalled){
             const reason=this.caughtError(draft,completion,eventId);
             this.rejectPromise(draft,p.id,reason.value,reason.origin);
           }
           this.stackPush(caller,['promise',p.id],eventId);
           draft.control.a0.activeFrameId=caller.id;return;
         }
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
        if(!this.advanceArrayCallback(s,parent,eventId))
          throw new Error('Missing next owned array callback');
        return {causes:[{kind:'invocation',frameId:parent.pendingArrayMethod.waitingFrameId}]};
      },{siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId,invocationId:frame.id});
    }
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
        case 'DEFAULT_GUARD':{
          const b=lookup(s,f.envId,arg.name);
          if(!b.cell.initialized)
            guestFault('ReferenceError','Default parameter is not initialized');
          const needsDefault=b.cell.token.value[0]==='undefined';
          if(!needsDefault)f.pc=arg.skipPc;
          return {result:['bool',needsDefault],
            reads:[{kind:'binding',envId:b.env.id,name:arg.name,
              version:b.cell.version??0,value:b.cell.token.value,
              supplyingEvent:b.cell.token.origin??null}]};
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
            closureEnvId:f.envId,async:arg.async===true,arrow:arg.arrow===true,
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
          if(fn.value[0]==='intrinsic'&&fn.value[1]==='Promise'){
             if(args.length!==1||!this.callableGuest(s,args[0]?.value))
               guestFault('TypeError','Promise executor must be callable');
             const executor=s.heap[args[0].value[1]];
             if(executor.async)throw new TypeError('Async Promise executor outside bounded profile');
             const p=this.newPromise(s),resolve=['builtinfn','Promise.executor.resolve:'+p],
               reject=['builtinfn','Promise.executor.reject:'+p];
             const id=this.newFrame(s,executor.codeId,executor.closureEnvId,f.id,null,
               [token(resolve,eventId),token(reject,eventId)],
               executor.arrow?executor.lexicalThis:U);
             s.frames[id].promiseExecutorTarget=p;
             f.pendingPromiseExecutor={waitingFrameId:id,promiseId:p};
             s.control.a0.activeFrameId=id;
             return {...operands(fn,...args),causes:[{kind:'invocation',frameId:id}],
               result:['promise',p]};
           }
           if(fn.value[0]==='intrinsic'&&fn.value[1]==='SharedArrayBuffer'){
            const length=args[0]?.value[0]==='num'?decode(args[0].value):NaN;
            if(args.length!==1||!Number.isSafeInteger(length)||length<0||length>256)
              guestFault('RangeError','Bounded shared buffer length expected');
            const id=this.next(s,'obj');
            s.heap[id]={id,kind:'shared-int32-buffer',byteLength:length,
              cells:Array(Math.floor(length/4)).fill(0),version:0};
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(fn.value[0]==='intrinsic'&&fn.value[1]==='Int32Array'){
            const buffer=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
            if(args.length!==1||buffer?.kind!=='shared-int32-buffer')
              guestFault('TypeError','Int32Array needs owned shared buffer');
            const id=this.next(s,'obj');
            s.heap[id]={id,kind:'shared-int32-view',bufferId:buffer.id,
              length:buffer.cells.length,version:0};
            return {...operands(fn,...args),...result(['ref',id])};
          }
          if(fn.value[0]!=='intrinsic'||fn.value[1]!=='Set'){
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
          if(base.value[0]==='intrinsic'&&base.value[1]==='Math'&&property==='random' &&
             !Number.isInteger(s.control.a0.randomSeed)){
            const completion={type:'unsupported',feature:'Math.random requires an explicit deterministic fixture seed'};
            this.failFrame(s,f,completion);
            return {...operands(base,key),completion};
          }
          if(base.value[0]==='host')v=['hostfn',`${base.value[1]}.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Date' &&
                  property==='now')v=['hostfn','platform.dateNow'];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Atomics' &&
             ['load','store','add','sub','and','or','xor','exchange','compareExchange','wait','notify'].includes(property))
            v=['builtinfn','Atomics.'+property];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Promise' && ['resolve','reject','all','race'].includes(property))v=['builtinfn',`Promise.${property}`];
          else if(base.value[0]==='intrinsic' &&
             ((base.value[1]==='Math' &&
               ['abs','ceil','floor','trunc','round','max','min','pow','sign','sqrt','hypot','random'].includes(property)) ||
              (base.value[1]==='Number' &&
               ['isFinite','isNaN','isInteger','isSafeInteger'].includes(property)) ||
              (base.value[1]==='Array' && ['isArray','from'].includes(property))))
            v=['builtinfn',base.value[1]+'.'+property];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' &&
             ['create','setPrototypeOf','getPrototypeOf','defineProperty','hasOwn','keys','values','entries','assign','is'].includes(property))
            v=['builtinfn',`Object.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Object' && property==='prototype')
            v=['intrinsic','Object.prototype'];
          else if(base.value[0]==='promise'){
             if(!s.promises[base.value[1]])throw new ReferenceError('Unknown guest promise');
             if(!['then','catch','finally'].includes(property))
               throw new TypeError('Unmodeled Promise prototype property: '+property);
             v=['builtinfn','Promise.prototype.'+property];
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
             if(property==='length')v=['num',text.length];
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
             if(obj.kind==='shared-int32-buffer'){
               if(property!=='byteLength')guestFault('TypeError','Unmodeled shared buffer property');
               return {...operands(base,key),...result(['num',obj.byteLength])};
             }
             if(obj.kind==='shared-int32-view'){
               if(property==='length')return {...operands(base,key),...result(['num',obj.length])};
               if(property==='byteLength')return {...operands(base,key),...result(['num',obj.length*4])};
               if(!arrayIndex(property)||Number(property)>=obj.length)
                 guestFault('TypeError','Unmodeled shared Int32 view property');
               return {...operands(base,key),...result(['num',s.heap[obj.bufferId].cells[Number(property)]])};
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
          if(object.kind==='regexp'){
            if(property!=='lastIndex'||v.value[0]!=='num' ||
               !Number.isSafeInteger(decode(v.value)) ||
               decode(v.value)<0 || decode(v.value)>10001)
              throw new TypeError('Only bounded RegExp.lastIndex writes are owned');
            putOwn(object,'lastIndex',v.value,eventId);
            return {...operands(base,key,v),...result(v.value)};
          }
          if(['shared-int32-buffer','shared-int32-view'].includes(object.kind))
            guestFault('TypeError','Direct shared-memory writes are not owned; use Atomics');
          if(object.kind==='set')
            throw new TypeError('Owned intrinsic internal slots are not guest-writable properties');
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
          const args=[];
          for(let i=0;i<raw.length;i++){
            if(!arg?.spread?.includes(i)){args.push(raw[i]);continue;}
            const value=raw[i].value,obj=value[0]==='ref'?s.heap[value[1]]:null;
            if(obj?.kind!=='array'||Object.keys(obj.accessors??{}).length)
              throw new TypeError('Only ordinary array spread is owned');
            const len=decode(obj.properties.length.value);
            if(!Number.isSafeInteger(len)||len<0||len>10000)
              throw new RangeError('Owned spread length budget exceeded');
            for(let j=0;j<len;j++)args.push(obj.properties[String(j)]??token(U));
          }
          if(args.length>10000)throw new RangeError('Owned call argument budget exceeded');
          const fn=pop();let callable=fn.value;
          const receiver=callable[0]==='method'?callable[2]:U;
          if(callable[0]==='method')callable=callable[1];
          if(callable[0]==='intrinsic'&&callable[1]==='Promise')
             guestFault('TypeError','Promise must be constructed with new');
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
           if(callable[0]==='builtinfn' &&
               /^Promise[.]thenable[.](resolve|reject):p[0-9]+:[0-9]+$/.test(callable[1])){
             const [,mode,pid,serial]=callable[1].match(
               /^Promise[.]thenable[.](resolve|reject):(p[0-9]+):([0-9]+)$/);
             const p=s.promises[pid];
             if(!p)throw new Error('Unknown thenable resolving function');
             if(p.status==='pending'&&p.thenableSerial===Number(serial)&&!p.thenableLocked){
               p.thenableLocked=true;
               const v=args[0]?.value??U,origin=args[0]?.origin??eventId;
               if(mode==='resolve')this.resolvePromise(s,pid,v,origin);
               else this.rejectPromise(s,pid,v,origin);
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
          if(callable[0]==='builtinfn' && callable[1].startsWith('Set.prototype.')){
            const set=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(set?.kind!=='set')guestFault('TypeError','Set method on incompatible receiver');
            const value=args[0]?.value??U;
            const size=decode(set.properties['[[Size]]'].value);
            const present=Array.from({length:size},(_,i)=>set.properties[String(i)].value)
              .some(v=>ownedSameValue(v,value,true));
            if(callable[1]==='Set.prototype.has')
              return {...operands(fn,...args),...result(['bool',present])};
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
          if(callable[0]==='ref' && s.heap[callable[1]]?.kind==='function'){
            const target=s.heap[callable[1]],promiseId=target.async?this.newPromise(s):null;
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,args,
              target.arrow?target.lexicalThis:receiver);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),result:['ref',callable[1]],causes:[{kind:'invocation',frameId:id}]};
          }
          if(callable[0]==='builtinfn' &&
             ['filter','map','reduce','sort'].some(m=>callable[1]==='Array.prototype.'+m)){
            const array=receiver[0]==='ref'?s.heap[receiver[1]]:null;
            if(!array||array.kind!=='array'||Object.keys(array.accessors??{}).length)
              throw new TypeError('Array callback needs owned array data');
            const length=decode(array.properties.length.value);
            if(!Number.isSafeInteger(length)||length<0||length>10000)
              throw new RangeError('Array callback iteration limit');
            const callback=args[0]?.value??U;
            if(!this.callableGuest(s,callback)||s.heap[callback[1]].async)
              guestFault('TypeError','Array callback must be a synchronous guest function');
            const method=callable[1].slice('Array.prototype.'.length);
            if(method!=='reduce'&&args.length>1)
              throw new TypeError('Unsupported callback thisArg');
            if(method==='sort'&&length>64)
              throw new RangeError('Sort comparator budget exceeded');
            if(method==='reduce' && args.length>2)
              throw new TypeError('Unsupported reduce options');
            const outputId=['reduce','sort'].includes(method)?null:this.next(s,'obj');
            if(outputId){s.heap[outputId]={id:outputId,kind:'array',properties:{
              length:token(['num',method==='map'?length:0],eventId)},
              propertyVersions:{length:0},shapeVersion:0,version:0};}
            let start=0,accumulator=U;
            if(method==='reduce'){
              if(args.length>1)accumulator=args[1].value;
              else {
                if(length===0)guestFault('TypeError','Reduce of empty array with no initial value');
                const first=array.properties['0'];
                if(!first)throw new TypeError('Sparse reduction first slot unmodeled');
                accumulator=first.value;start=1;
              }
            }
            f.pendingArrayMethod={method,arrayId:array.id,callbackId:callback[1],
              outputId,length,index:start,accumulator,waitingFrameId:null,
              siteId:inst.siteId,currentValue:U};
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
            return {...operands(fn,...args),...result(method==='reduce'?accumulator:['ref',outputId])};
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
            if(decode(regex.properties.lastIndex.value)!==0)
              throw new TypeError('Owned replacement requires initial RegExp.lastIndex = 0');
            const matches=scanPinnedReplacement(pattern,flags,receiver[1]);
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
              for(const [key,record] of Object.entries(item.properties)){
                if(item.kind==='array'&&key==='length')continue;
                if(key==='__proto__')
                  throw new TypeError('Object.assign prototype setter not modeled');
                copies.push([key,record.value]);
              }
            }
            for(const [key,value] of copies)putOwn(target,key,value,eventId);
            return {...operands(fn,...args),...result(ref)};
          }
          if(callable[0]==='builtinfn' && ['Object.hasOwn','Object.keys','Object.values','Object.entries'].includes(callable[1])){
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
            keys.forEach((key,i)=>{
              let member=callable[1]==='Object.keys'?['str',key]:obj.properties[key].value;
              if(callable[1]==='Object.entries'){
                const pairId=this.next(s,'obj');
                const pair=s.heap[pairId]={id:pairId,kind:'array',
                  properties:{length:token(['num',0],eventId)},
                  propertyVersions:{length:0},shapeVersion:0,version:0};
                putOwn(pair,'0',['str',key],eventId);
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
             const slots=[];
             for(let i=0;i<length;i++){
               const slot=obj.properties[String(i)];
               if(!slot||!Array.isArray(slot.value))
                 throw new TypeError('Sparse array operation not modeled');
               slots.push(slot.value);
             }
             const method=callable[1].slice('Array.prototype.'.length);
             const numberAt=(i,missing)=>{
               if(i>=args.length)return missing;
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
               const start=clamp(numberAt(0,0)),end=clamp(numberAt(1,length));
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
                 for(let i=0;i<length;i++)
                   putOwn(obj,String(i),reversed[i],eventId);
                 out=receiver;
               }
             }else if(method==='fill'){
               const value=args[0]?.value??U,
                 start=clamp(numberAt(1,0)),end=clamp(numberAt(2,length));
               for(let i=start;i<end;i++)putOwn(obj,String(i),value,eventId);
               out=receiver;
             }else if(method==='copyWithin'){
               const target=clamp(numberAt(0,0)),start=clamp(numberAt(1,0)),
                 end=clamp(numberAt(2,length));
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
            const p=this.newPromise(s);
            if(callable[1]==='Promise.resolve')this.resolvePromise(s,p,v,origin);
            else this.rejectPromise(s,p,v,origin);
            return {...operands(fn,...args),...result(['promise',p])};
          }
          if(callable[0]==='builtinfn' && callable[1].startsWith('Atomics.')){
            const method=callable[1].slice(8),view=args[0]?.value[0]==='ref'?s.heap[args[0].value[1]]:null;
            const index=args[1]?.value[0]==='num'?decode(args[1].value):NaN;
            if(view?.kind!=='shared-int32-view'||!Number.isInteger(index)||
               index<0||index>=view.length)guestFault('RangeError','Atomic index or view unsupported');
            const buffer=s.heap[view.bufferId],old=buffer.cells[index];
            const count=method==='compareExchange'||method==='wait'?4:
              method==='load'?2:method==='notify'?(args.length===2?2:3):3;
            if(args.length!==count||args.slice(2).some(a=>a.value[0]!=='num'||
               !Number.isSafeInteger(decode(a.value))))
              guestFault('TypeError','Unowned atomic argument or arity');
            const n=(decode(args[2]?.value??['num',0]))|0;
            let value=old;
            switch(method){
              case 'load':break;
              case 'store':buffer.cells[index]=n;value=n;break;
              case 'add':buffer.cells[index]=(old+n)|0;break;
              case 'sub':buffer.cells[index]=(old-n)|0;break;
              case 'and':buffer.cells[index]=old&n;break;
              case 'or':buffer.cells[index]=old|n;break;
              case 'xor':buffer.cells[index]=old^n;break;
              case 'exchange':buffer.cells[index]=n;break;
              case 'compareExchange':
                if(old===n)buffer.cells[index]=decode(args[3].value)|0;
                break;
              case 'notify':
                if(args.length===3&&decode(args[2].value)<0)
                  guestFault('TypeError','Negative notification count');
                value=0;break;
              case 'wait':
                if(decode(args[3].value)!==0)
                  guestFault('TypeError','Only zero-timeout single-agent wait supported');
                return {...operands(fn,...args),
                  ...result(['str',old===n?'timed-out':'not-equal'])};
              default:throw new Error('Unsupported bounded atomic method');
            }
            return {...operands(fn,...args),...result(['num',value])};
          }
          if(callable[0]==='builtinfn' && ['Promise.all','Promise.race'].includes(callable[1])){
            const input=args[0]?.value,arr=input?.[0]==='ref'?s.heap[input[1]]:null;
            if(args.length!==1||arr?.kind!=='array'||Object.keys(arr.accessors??{}).length)
              guestFault('TypeError','Promise combinator requires an owned dense array');
            const length=decode(arr.properties.length.value);
            if(!Number.isInteger(length)||length<0||length>64)
              throw new RangeError('Promise combinator iterable limit exceeded');
            const values=[];
            for(let i=0;i<length;i++){
              const entry=arr.properties[String(i)];
              if(!entry)guestFault('TypeError','Sparse Promise combinator iterable unsupported');
              values.push(entry);
            }
            const kind=callable[1]==='Promise.all'?'all':'race';
            const resultId=this.newPromise(s);
            if(kind==='all')s.promises[resultId].combinator={kind,remaining:length,values:Array(length).fill(null)};
            if(kind==='all'&&length===0){
              const id=this.next(s,'obj');
              s.heap[id]={id,kind:'array',properties:{length:token(['num',0],eventId)},
                propertyVersions:{length:0},shapeVersion:0,version:0};
              this.resolvePromise(s,resultId,['ref',id],eventId);
            }
            for(let i=0;i<length;i++){
              const v=values[i],inputId=v.value[0]==='promise'?v.value[1]:
                this.newPromise(s);
              if(v.value[0]!=='promise')this.resolvePromise(s,inputId,v.value,v.origin);
              this.observePromise(s,inputId,{kind:'combinator',resultId,index:i,mode:kind});
            }
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
              dispatch:'prepared',external:'pending',immediate:kind==='promise'?'completed':'awaiting',outcomeIds:[],inputIds:[],version:0};
            if(kind==='promise')this.stackPush(f,['promise',promiseId],eventId);
            else {f.status='blocked';f.blockedOn=id;}
            return {...operands(fn,...args),result:kind==='promise'?['promise',promiseId]:null,causes:[{kind:'effect',effectId:id}]};
          }
          guestFault('TypeError','Not a callable guest function');
        }
        case 'AWAIT':{
          const a=pop(),v=a.value;if(!f.asyncPromiseId)throw new SyntaxError('await outside async function');
          const promiseId=v[0]==='promise'?v[1]:this.newPromise(s);
          if(v[0]!=='promise')this.resolvePromise(s,promiseId,v,a.origin);
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
      const job=s.control.a0.queue.shift();
      if(job.kind==='thenable'){
        const p=s.promises[job.promiseId],callback=s.heap[job.thenId];
        if(p?.status!=='pending'||p.thenableSerial!==job.serial||
          callback?.kind!=='function'||callback.async||!s.heap[job.thenableId])
          throw new Error('Invalid queued thenable job');
        const resolve=['builtinfn','Promise.thenable.resolve:'+p.id+':'+job.serial];
        const reject=['builtinfn','Promise.thenable.reject:'+p.id+':'+job.serial];
        const id=this.newFrame(s,callback.codeId,callback.closureEnvId,null,null,
          [token(resolve,eventId),token(reject,eventId)],['ref',job.thenableId]);
        s.frames[id].thenableJob={promiseId:p.id,serial:job.serial};
        s.control.a0.activeFrameId=id;
        return {causes:[{kind:'promise',promiseId:p.id},
          {kind:'invocation',frameId:id}],result:['promise',p.id]};
      }
      if(job.kind==='microtask'){
        const callback=s.heap[job.functionId];
        if(callback?.kind!=='function')
          throw new Error('Queued microtask lacks owned function identity');
        const inner=callback.async?this.newPromise(s):null;
        const id=this.newFrame(s,callback.codeId,callback.closureEnvId,null,inner,[],
          callback.arrow?callback.lexicalThis:U);
        s.frames[id].reactionJob=true;
        s.control.a0.activeFrameId=id;
        return {causes:[{kind:'invocation',frameId:id}],result:U};
      }
      const p=s.promises[job.promiseId];
      if(job.kind==='combinator'){
        if(!p||!['fulfilled','rejected'].includes(p.status))
          throw new Error('Combinator job on unsettled promise');
        const target=s.promises[job.resultId];
        if(!target)throw new Error('Unknown combinator target');
        if(target.status!=='pending')
          return {causes:[{kind:'promise',promiseId:job.promiseId}],result:p.value.value};
        if(p.status==='rejected')this.rejectPromise(s,job.resultId,p.value.value,p.value.origin);
        else if(job.mode==='race')this.resolvePromise(s,job.resultId,p.value.value,p.value.origin);
        else {
          const comb=target.combinator;
          if(comb?.kind!=='all'||comb.values[job.index]!==null)
            throw new Error('Invalid Promise.all observation');
          comb.values[job.index]=copy(p.value);
          comb.remaining--;
          if(comb.remaining===0){
            const values=comb.values,id=this.next(s,'obj');
            const array=s.heap[id]={id,kind:'array',properties:{
              length:token(['num',values.length],eventId)},
              propertyVersions:{length:0},shapeVersion:0,version:0};
            for(let i=0;i<values.length;i++)putOwn(array,String(i),values[i].value,eventId);
            this.resolvePromise(s,job.resultId,['ref',id],eventId);
          }
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
        fn.arrow?fn.lexicalThis:U);
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
      if(c.timers.length){this.enterTimerTask();continue;}
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
