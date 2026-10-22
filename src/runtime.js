import { encode, decode, U, token, truthy, primitiveBinary, primitiveUnary } from './values.js';
import { parse, compile } from './frontend.js';
import { importGraph } from './training/graph.js';
import { parseTraining, TRAINING_PARSER } from './training/profile.js';
import { createArithmetic, advanceArithmetic, isOwnedArithmetic } from './spec-operations.js';
import { operationMutation } from './spec-mutations.js';
import {hostOperation,prepareHostRequest} from './host/operations.js';
import { specStep, ENGINE_REVISION } from './spec-schema.js';

const copy = value => structuredClone(value);
const freezeJson = value => {
  if(value && typeof value==='object'){
    for(const member of Object.values(value))freezeJson(member);
    Object.freeze(value);
  }
  return value;
};
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const tableNames = ['counters','envs','heap','promises','frames','effects','inputs','control','operations'];
const opNames = {
  CONST:'literal.materialize', GET:'binding.read', SET:'binding.write', INIT:'binding.initialize', DECLARE:'binding.declare',
  DEF_FN:'function.define', BINARY:'primitive.binary', UNARY:'primitive.unary', POP:'stack.pop', DUP:'stack.duplicate',
  CALL:'call.enter', RETURN:'call.return', THROW:'completion.throw', AWAIT:'async.await', NEW_OBJECT:'object.allocate', NEW_ARRAY:'array.allocate',
  GET_PROP:'property.read', GET_METHOD:'property.read', PUT_PROP:'property.write', ENTER_SCOPE:'environment.enter',
  LEAVE_SCOPE:'environment.leave', JUMP:'control.jump', JUMP_IF_FALSE:'control.branch', LOGICAL_JUMP:'control.branch',
  TRY_ENTER:'completion.handler.enter', TRY_NORMAL:'completion.handler.normal',
  BIND_CATCH:'completion.catch.bind', END_FINALLY:'completion.finally.end',
  LOOP_ENTER:'control.loop.enter', LOOP_EXIT:'control.loop.exit', LOOP_JUMP:'completion.loop.jump'
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
  throw new ReferenceError(`${name} is not defined`);
}
function valueKey(tagged) {
  if (!['str','num','bool','null','undefined','bigint'].includes(tagged[0]))
    throw new TypeError('Property keys requiring guest coercion are unsupported');
  return String(decode(tagged));
}
function arrayIndex(key) {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}
function putOwn(obj,key,value,eventId) {
  if (key === '__proto__') throw new TypeError('Prototype mutation is not implemented by the bounded profile');
  if (obj.kind === 'array' && key === 'length') {
    if (value[0] !== 'num') throw new TypeError('Array length coercion is outside the profile');
    const length = decode(value);
    if (!Number.isInteger(length) || length < 0 || length > 4294967295)
      throw new RangeError('Invalid array length');
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
  obj.propertyVersions[key] = (obj.propertyVersions[key] ?? 0) + 1;
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
    for(const [id,program] of Object.entries(compiled.programs))this.programs[rename[id]]={...program,id:rename[id],instructions:program.instructions.map(inst=>inst.op==='DEF_FN'?{...inst,arg:{...inst.arg,codeId:rename[inst.arg.codeId]},siteId:`${sourceId}:${inst.siteId}`}:{...inst,siteId:`${sourceId}:${inst.siteId}`})};
    this.sites.push(...compiled.sites.map(site=>({...site,siteId:`${sourceId}:${site.siteId}`,codeId:rename[site.codeId],sourceId})));
    const record={sourceId,text,url,goal,entry:rename[compiled.entry],parser:trainingProfile?TRAINING_PARSER:'bounded-pratt/2'};
    this.sources.push(record);return record;
  }
  next(draft,kind) {const ids=draft.counters.ids;return `${kind==='operation'?'op':kind[0]}${++ids[kind]}`;}
  newEnv(draft,parent=null) {const id=this.next(draft,'env');draft.envs[id]={id,parent,bindings:{},version:0};return id;}
  newPromise(draft,status='pending',value=null) {const id=this.next(draft,'promise');draft.promises[id]={id,status,value,waiters:[],adopters:[],adopting:null,version:0};return id;}
  newFrame(draft,codeId,parentEnv,callerFrameId=null,asyncPromiseId=null,args=[]) {
    const id=this.next(draft,'frame'),envId=this.newEnv(draft,parentEnv);
    const params=this.programs[codeId].params;
    params.forEach((name,i)=>draft.envs[envId].bindings[name]={kind:'parameter',initialized:true,token:args[i]??token(U),version:0});
    draft.frames[id]={id,codeId,pc:0,stack:[],envId,callerFrameId,asyncPromiseId,status:'running',blockedOn:null,awaiting:null,operationId:null,handlers:[],loops:[],version:0};
    return id;
  }
  start(source) {
    if(this.started)throw new Error('Run already started');
    if(typeof source==='string')source=this.registerSource({text:source});
    if(!this.sources.some(s=>s.sourceId===source.sourceId))throw new Error('Unknown source');
    const s=this.state,global=this.newEnv(s);
    s.envs[global].bindings.host={kind:'const',initialized:true,token:token(['host','demo'])};
    s.envs[global].bindings.Promise={kind:'const',initialized:true,token:token(['intrinsic','Promise'])};
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
    if(frame.callerFrameId){const caller=draft.frames[frame.callerFrameId];this.stackPush(caller,value,origin);draft.control.a0.activeFrameId=caller.id;}
    else {draft.control.a0.activeFrameId=null;draft.control.a0.completion={kind:'return',value};
      draft.control.a0.status='completed';if(!frame.asyncPromiseId)this.result=value;}
  }
  resolvePromise(draft,id,value,origin) {
    const p=draft.promises[id];if(!p||p.status!=='pending'||p.adopting)
      throw new Error('Promise already settled or adopting another promise');
    if(value[0]==='promise'){
      const target=draft.promises[value[1]];
      if(!target||target===p)throw new TypeError('Invalid or self-resolving guest promise');
      // Track cycles before registering an adoption dependency.
      for(let current=target;current?.adopting;current=draft.promises[current.adopting])
        if(current===p || current.adopting===id)
          throw new TypeError('Promise adoption cycle');
      if(target.status==='pending'){
        p.adopting=target.id;
        target.adopters??=[];
        target.adopters.push(id);
        return;
      }
      if(target.status!=='fulfilled')throw new TypeError('Promise rejection not enabled');
      value=target.value.value;
      origin=target.value.origin;
    }
    p.status='fulfilled';p.value=token(value,origin);
    for(const frameId of p.waiters)draft.control.a0.queue.push({frameId,promiseId:id});
    p.waiters=[];
    const waiting=p.adopters??[];
    p.adopters=[];
    for(const adoptedId of waiting){
      const adopted=draft.promises[adoptedId];
      if(adopted.adopting!==id)throw new Error('Broken promise adoption link');
      adopted.adopting=null;
      this.resolvePromise(draft,adoptedId,value,origin);
    }
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
      // Synchronous child activations do not terminate the run before the
      // caller has had a chance to handle their abrupt completion.
      if(frame.callerFrameId && !frame.asyncPromiseId){
        frame.status='thrown';frame.completion=copy(completion);
        const caller=draft.frames[frame.callerFrameId];
        draft.control.a0.activeFrameId=caller.id;
        this.routeCompletion(draft,caller,completion,eventId);
      }else this.failFrame(draft,frame,completion);
    }else throw new Error('Unknown guest completion');
  }
  stepArithmetic(frame) {
    const operation=this.state.operations[frame.operationId];
    if(!operation||operation.frameId!==frame.id)throw new Error('Unowned spec continuation');
    const metadata=specStep(operation);
    return this.commit(metadata.operation,(s,eventId)=>{
      const current=s.operations[operation.id],f=s.frames[frame.id];
      const detail=advanceArithmetic(current,eventId);
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
      switch(op){
        case 'CONST':return result(arg.value);
        case 'DECLARE':{const e=s.envs[f.envId];if(Object.hasOwn(e.bindings,arg.name))throw new SyntaxError(`Duplicate declaration ${arg.name}`);e.bindings[arg.name]={kind:arg.kind,initialized:false,token:null,version:0};return {};}
        case 'INIT':{const v=pop(),b=lookup(s,f.envId,arg);if(b.cell.initialized)throw new Error('Already initialized');b.cell.initialized=true;b.cell.token=v;b.cell.version++;return {...operands(v),result:v.value};}
        case 'GET':{const b=lookup(s,f.envId,arg);if(!b.cell.initialized)throw new ReferenceError(`Cannot access '${arg}' before initialization`);this.stackPush(f,b.cell.token.value,eventId);return {result:b.cell.token.value,reads:[{kind:'binding',envId:b.env.id,name:arg,version:b.cell.version??0,
            value:b.cell.token.value,supplyingEvent:b.cell.token.origin??null}],origins:[b.cell.token.origin]};}
        case 'SET':{const v=pop(),b=lookup(s,f.envId,arg);if(!b.cell.initialized)throw new ReferenceError(`${arg} is not initialized`);if(b.cell.kind==='const')throw new TypeError(`Assignment to constant ${arg}`);b.cell.token=v;b.cell.version=(b.cell.version??0)+1;this.stackPush(f,v.value,eventId);return {...operands(v),result:v.value};}
        case 'DEF_FN':{const e=s.envs[f.envId],id=this.next(s,'obj');s.heap[id]={id,kind:'function',codeId:arg.codeId,closureEnvId:f.envId,async:arg.async,version:0};e.bindings[arg.name]={kind:'function',initialized:true,token:token(['ref',id],eventId),version:0};return {result:['ref',id]};}
        case 'ENTER_SCOPE':f.envId=this.newEnv(s,f.envId);return {};
        case 'LEAVE_SCOPE':f.envId=s.envs[f.envId].parent;return {};
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
        case 'BINARY':{
          const b=pop(),a=pop();
          if(!isOwnedArithmetic(arg))return {...operands(a,b),...result(primitiveBinary(arg,a.value,b.value))};
          const id=this.next(s,'operation');
          s.operations[id]=createArithmetic({id,frameId:f.id,operator:arg,left:a,right:b,
            siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId});
          f.operationId=id;
          return {...operands(a,b),causes:[{kind:'spec-operation',operationId:id}]};
        }
        case 'UNARY':{const a=pop();return {...operands(a),...result(primitiveUnary(arg,a.value,s.heap))};}
        case 'POP':{const a=pop();return operands(a);}
        case 'DUP':{const a=pop();st.push(a);st.push(copy(a));return operands(a);}
        case 'JUMP':f.pc=arg;return {};
        case 'JUMP_IF_FALSE':{const a=pop();if(!truthy(a.value))f.pc=arg;return {...operands(a),result:['bool',!truthy(a.value)]};}
        case 'LOGICAL_JUMP':{const a=st.at(-1),v=a.value;const pass=arg.operator==='&&'?!truthy(v):arg.operator==='||'?truthy(v):v[0]!=='null'&&v[0]!=='undefined';if(pass)f.pc=arg.to;return {...operands(a),result:['bool',pass]};}
        case 'NEW_OBJECT':case 'NEW_ARRAY':{const id=this.next(s,'obj');s.heap[id]={id,kind:op==='NEW_ARRAY'?'array':'object',properties:{},propertyVersions:{},shapeVersion:0,version:0};if(op==='NEW_ARRAY'){s.heap[id].properties.length=token(['num',0],eventId);s.heap[id].propertyVersions.length=0;}return result(['ref',id]);}
        case 'GET_PROP':case 'GET_METHOD':{
          const key=pop(),base=pop(),property=valueKey(key.value);let v;
          if(base.value[0]==='host')v=['hostfn',`${base.value[1]}.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Promise' && property==='resolve')v=['builtinfn','Promise.resolve'];
          else if(base.value[0]==='ref'){
             const obj=s.heap[base.value[1]];
             if(!obj)throw new ReferenceError('Unknown guest identity');
             if(!Object.hasOwn(obj.properties,property) &&
                (property in (obj.kind==='array'?Array.prototype:Object.prototype)))
               throw new TypeError('Inherited property lookup is outside the profile');
             v=Object.hasOwn(obj.properties,property)?obj.properties[property].value:U;
           }
          else throw new TypeError('Unsupported property receiver (no host fallback)');
          const output=op==='GET_METHOD'?['method',v,base.value]:v;
          const obj=base.value[0]==='ref'?s.heap[base.value[1]]:null;
           return {...operands(base,key),...result(output),reads:obj?[{kind:'property',
             objectId:obj.id,key:property,version:obj.propertyVersions?.[property]??0,
             shapeVersion:obj.shapeVersion??0,present:Object.hasOwn(obj.properties,property),
             value:v,supplyingEvent:obj.properties[property]?.origin??null}]:[]};
        }
        case 'PUT_PROP':{
          const v=pop(),key=pop(),base=pop(),property=valueKey(key.value);
          if(base.value[0]!=='ref'||!s.heap[base.value[1]]||s.heap[base.value[1]].kind==='function')throw new TypeError('Not a writable guest object');
          const obj=s.heap[base.value[1]];
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
          if(callable[0]==='method')callable=callable[1];
          if(callable[0]==='ref' && s.heap[callable[1]]?.kind==='function'){
            const target=s.heap[callable[1]],promiseId=target.async?this.newPromise(s):null;
            const id=this.newFrame(s,target.codeId,target.closureEnvId,f.id,promiseId,args);
            s.control.a0.activeFrameId=id;
            return {...operands(fn,...args),result:['ref',callable[1]],causes:[{kind:'invocation',frameId:id}]};
          }
          if(callable[0]==='builtinfn' && callable[1]==='Promise.resolve'){
            const v=args[0]?.value??U;
            if(v[0]==='promise')return {...operands(fn,...args),...result(v)};
            const p=this.newPromise(s,'fulfilled',token(v,args[0]?.origin));return {...operands(fn,...args),...result(['promise',p])};
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
          throw new TypeError('Not a callable guest function');
        }
        case 'AWAIT':{
          const a=pop(),v=a.value;if(!f.asyncPromiseId)throw new SyntaxError('await outside async function');
          const promiseId=v[0]==='promise'?v[1]:this.newPromise(s,'fulfilled',a);
          const p=s.promises[promiseId];f.awaiting=promiseId;p.waiters.push(f.id);
          if(p.status==='fulfilled'){s.control.a0.queue.push({frameId:f.id,promiseId});p.waiters.pop();}
          this.suspendAsync(s,f);return {...operands(a),causes:[{kind:'promise',promiseId}]};
        }
        case 'RETURN':{const v=pop();this.routeCompletion(s,f,{type:'return',value:v},eventId);return {...operands(v),result:v.value};}
        case 'THROW':{const v=pop(),completion={type:'throw',value:v};this.routeCompletion(s,f,completion,eventId);return {...operands(v),completion};}
        default:throw new Error(`Unknown opcode ${op}`);
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
        if(i.abrupt)throw new Error('Rejected external promises not yet supported by this profile');
        this.resolvePromise(s,fx.promiseId,i.value,eventId);
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
      const job=s.control.a0.queue.shift(),f=s.frames[job.frameId],p=s.promises[job.promiseId];
      if(f.status!=='suspended'||p.status!=='fulfilled')throw new Error('Invalid promise resume');
      f.status='running';f.awaiting=null;f.callerFrameId=null;this.stackPush(f,p.value.value,eventId);
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
    return copy({manifest:{schema:'semantic-tracing-run/2',profile:this.entrySpec?'training-js/1':'bounded-js-subset/2',completeSemanticTrace:false,
      completeEcma262:false,completeHostIntegration:false,coverage:'docs/STATUS.md',chunkPolicy:'accumulate-until-wait/1',
      eventVersion:2,operationVersion:1,mutationSchema:'owned-spec-commands/1',
      ownedArithmetic:{revision:1,referenceEngineRevision:ENGINE_REVISION,operators:['+','-','*','/','%','**'],domain:'primitive-only'},
      guestExecution:'owned-bytecode-and-spec-phase-machine',replay:'bounded-deterministic-reexecution/2'},
      sources:this.sources,sites:this.sites,programs:this.programs,entrySpec:this.entrySpec??null,initialState:this.initialState,finalState:this.state,
      events:this.events,chunks:this.chunks,checkpoints:this.checkpoints,effects:this.state.effects,inputs:this.state.inputs});
  }
}
export function createRuntime(options){return new Runtime(options);}
