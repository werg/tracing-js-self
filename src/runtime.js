import { encode, decode, U, token, truthy, primitiveBinary, primitiveUnary } from './values.js';
import { parse, compile } from './frontend.js';

const copy = value => structuredClone(value);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const tableNames = ['counters','envs','heap','promises','frames','effects','inputs','control'];
const opNames = {
  CONST:'literal.materialize', GET:'binding.read', SET:'binding.write', INIT:'binding.initialize', DECLARE:'binding.declare',
  DEF_FN:'function.define', BINARY:'primitive.binary', UNARY:'primitive.unary', POP:'stack.pop', DUP:'stack.duplicate',
  CALL:'call.enter', RETURN:'call.return', THROW:'completion.throw', AWAIT:'async.await', NEW_OBJECT:'object.allocate', NEW_ARRAY:'array.allocate',
  GET_PROP:'property.read', GET_METHOD:'property.read', PUT_PROP:'property.write', ENTER_SCOPE:'environment.enter',
  LEAVE_SCOPE:'environment.leave', JUMP:'control.jump', JUMP_IF_FALSE:'control.branch', LOGICAL_JUMP:'control.branch'
};
const guestValue = (x) => Array.isArray(x) && (
  (x.length === 1 && ['undefined', 'null'].includes(x[0])) ||
  (x.length === 2 && (
    (x[0] === 'bool' && typeof x[1] === 'boolean') ||
    (x[0] === 'str' && typeof x[1] === 'string') ||
    (x[0] === 'bigint' && typeof x[1] === 'string' && /^-?(0|[1-9]\d*)$/.test(x[1])) ||
    (x[0] === 'num' && (typeof x[1] === 'number' || ['-0','NaN','+Infinity','-Infinity'].includes(x[1])))
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
  if (!['str','num','bool'].includes(tagged[0])) throw new TypeError('Only primitive string/number/boolean keys are currently supported');
  return String(decode(tagged));
}
function diff(oldState, nextState) {
  const patches=[];
  for(const table of tableNames) {
    for(const id of new Set([...Object.keys(oldState[table]),...Object.keys(nextState[table])])) {
      const before=oldState[table][id]??null, after=nextState[table][id]??null;
      if(!equal(before,after)) {
        if(after && typeof after==='object')after.version=(before?.version??0)+1;
        patches.push({kind:`${table}.replace`,table,id,before:copy(before),after:copy(after)});
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
    this.state={counters:{ids:{version:0,env:0,obj:0,promise:0,frame:0,effect:0,input:0}},envs:{},heap:{},promises:{},frames:{},effects:{},inputs:{},control:{a0:{version:0,activeFrameId:null,queue:[],status:'new'}}};
    this.chunkStart=0;this.chunkBefore='q0';this.result=U;
  }
  registerSource({text,url='<inline>',goal='script'}={}) {
    if(goal!=='script')throw new SyntaxError('Only script goal is implemented');
    if(typeof text!=='string')throw new TypeError('Source text required');
    const sourceId=`src${this.sources.length+1}`;
    const compiled=compile(parse(text));
    const rename={};
    for(const id of Object.keys(compiled.programs))rename[id]=`${sourceId}:${id}`;
    for(const [id,program] of Object.entries(compiled.programs))this.programs[rename[id]]={...program,id:rename[id],instructions:program.instructions.map(inst=>inst.op==='DEF_FN'?{...inst,arg:{...inst.arg,codeId:rename[inst.arg.codeId]},siteId:`${sourceId}:${inst.siteId}`}:{...inst,siteId:`${sourceId}:${inst.siteId}`})};
    this.sites.push(...compiled.sites.map(site=>({...site,siteId:`${sourceId}:${site.siteId}`,codeId:rename[site.codeId],sourceId})));
    const record={sourceId,text,url,goal,entry:rename[compiled.entry],parser:'bounded-pratt/1'};
    this.sources.push(record);return record;
  }
  next(draft,kind) {const ids=draft.counters.ids;return `${kind[0]}${++ids[kind]}`;}
  newEnv(draft,parent=null) {const id=this.next(draft,'env');draft.envs[id]={id,parent,bindings:{},version:0};return id;}
  newPromise(draft,status='pending',value=null) {const id=this.next(draft,'promise');draft.promises[id]={id,status,value,waiters:[],version:0};return id;}
  newFrame(draft,codeId,parentEnv,callerFrameId=null,asyncPromiseId=null,args=[]) {
    const id=this.next(draft,'frame'),envId=this.newEnv(draft,parentEnv);
    const params=this.programs[codeId].params;
    params.forEach((name,i)=>draft.envs[envId].bindings[name]={kind:'parameter',initialized:true,token:args[i]??token(U)});
    draft.frames[id]={id,codeId,pc:0,stack:[],envId,callerFrameId,asyncPromiseId,status:'running',blockedOn:null,awaiting:null,version:0};
    return id;
  }
  start(source) {
    if(this.started)throw new Error('Run already started');
    if(typeof source==='string')source=this.registerSource({text:source});
    if(!this.sources.some(s=>s.sourceId===source.sourceId))throw new Error('Unknown source');
    const s=this.state,global=this.newEnv(s);
    s.envs[global].bindings.host={kind:'const',initialized:true,token:token(['host','demo'])};
    s.envs[global].bindings.Promise={kind:'const',initialized:true,token:token(['intrinsic','Promise'])};
    s.control.a0.globalEnvId=global;
    s.control.a0.activeFrameId=this.newFrame(s,source.entry,global);
    s.control.a0.status='running';this.started=true;
    this.initialState=copy(this.state);this.checkpoints.q0=copy(this.state);
    return this;
  }
  commit(operation, callback, {siteId=null,sourceId=null,codeId=null,operands=[]}={}) {
    const before=this.state, draft=copy(before),eventId=`a0:e${this.events.length+1}`;
    const detail=callback(draft,eventId)??{};
    const patches=diff(before,draft);
    this.state=draft;
    const event={eventId,agentId:'a0',sequence:this.events.length+1,operation,catalogRef:`${operation}/1`,siteId,sourceId,codeId,
      operands:detail.operands??operands,operandOrigins:detail.origins??[],result:detail.result??null,
      readObservations:detail.reads??[],causes:detail.causes??[],stateChanges:patches,
      before:`q${this.events.length}`,after:`q${this.events.length+1}`};
    this.events.push(event);return event;
  }
  stackPush(frame,value,origin){frame.stack.push(token(value,origin));}
  completeFrame(draft,frame,value,origin) {
    frame.status='completed';
    if(frame.asyncPromiseId){this.resolvePromise(draft,frame.asyncPromiseId,value,origin);value=['promise',frame.asyncPromiseId];}
    if(frame.callerFrameId){const caller=draft.frames[frame.callerFrameId];this.stackPush(caller,value,origin);draft.control.a0.activeFrameId=caller.id;}
    else {draft.control.a0.activeFrameId=null;if(!frame.asyncPromiseId)this.result=value;}
  }
  resolvePromise(draft,id,value,origin) {
    const p=draft.promises[id];if(!p||p.status!=='pending')throw new Error('Promise already settled or missing');
    p.status='fulfilled';p.value=token(value,origin);
    for(const frameId of p.waiters)draft.control.a0.queue.push({frameId,promiseId:id});
    p.waiters=[];
  }
  suspendAsync(draft,frame) {
    frame.status='suspended';
    if(frame.callerFrameId) {
      this.stackPush(draft.frames[frame.callerFrameId],['promise',frame.asyncPromiseId],null);
      draft.control.a0.activeFrameId=frame.callerFrameId;frame.callerFrameId=null;
    } else draft.control.a0.activeFrameId=null;
  }
  step() {
    if(!this.started)throw new Error('Call start first');
    const c=this.state.control.a0,frame=c.activeFrameId&&this.state.frames[c.activeFrameId];
    if(!frame||frame.status!=='running')return null;
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
        case 'DECLARE':{const e=s.envs[f.envId];if(Object.hasOwn(e.bindings,arg.name))throw new SyntaxError(`Duplicate declaration ${arg.name}`);e.bindings[arg.name]={kind:arg.kind,initialized:false,token:null};return {};}
        case 'INIT':{const v=pop(),b=lookup(s,f.envId,arg);if(b.cell.initialized)throw new Error('Already initialized');b.cell.initialized=true;b.cell.token=v;return {...operands(v),result:v.value};}
        case 'GET':{const b=lookup(s,f.envId,arg);if(!b.cell.initialized)throw new ReferenceError(`Cannot access '${arg}' before initialization`);this.stackPush(f,b.cell.token.value,eventId);return {result:b.cell.token.value,reads:[{kind:'binding',envId:b.env.id,name:arg,version:b.env.version}],origins:[b.cell.token.origin]};}
        case 'SET':{const v=pop(),b=lookup(s,f.envId,arg);if(!b.cell.initialized)throw new ReferenceError(`${arg} is not initialized`);if(b.cell.kind==='const')throw new TypeError(`Assignment to constant ${arg}`);b.cell.token=v;this.stackPush(f,v.value,eventId);return {...operands(v),result:v.value};}
        case 'DEF_FN':{const e=s.envs[f.envId],id=this.next(s,'obj');s.heap[id]={id,kind:'function',codeId:arg.codeId,closureEnvId:f.envId,async:arg.async,version:0};e.bindings[arg.name]={kind:'function',initialized:true,token:token(['ref',id],eventId)};return {result:['ref',id]};}
        case 'ENTER_SCOPE':f.envId=this.newEnv(s,f.envId);return {};
        case 'LEAVE_SCOPE':f.envId=s.envs[f.envId].parent;return {};
        case 'BINARY':{const b=pop(),a=pop();return {...operands(a,b),...result(primitiveBinary(arg,a.value,b.value))};}
        case 'UNARY':{const a=pop();return {...operands(a),...result(primitiveUnary(arg,a.value))};}
        case 'POP':{const a=pop();return operands(a);}
        case 'DUP':{const a=pop();st.push(a);st.push(copy(a));return operands(a);}
        case 'JUMP':f.pc=arg;return {};
        case 'JUMP_IF_FALSE':{const a=pop();if(!truthy(a.value))f.pc=arg;return {...operands(a),result:['bool',!truthy(a.value)]};}
        case 'LOGICAL_JUMP':{const a=st.at(-1),v=a.value;const pass=arg.operator==='&&'?!truthy(v):arg.operator==='||'?truthy(v):v[0]!=='null'&&v[0]!=='undefined';if(pass)f.pc=arg.to;return {...operands(a),result:['bool',pass]};}
        case 'NEW_OBJECT':case 'NEW_ARRAY':{const id=this.next(s,'obj');s.heap[id]={id,kind:op==='NEW_ARRAY'?'array':'object',properties:{},version:0};if(op==='NEW_ARRAY')s.heap[id].properties.length=token(['num',0],eventId);return result(['ref',id]);}
        case 'GET_PROP':case 'GET_METHOD':{
          const key=pop(),base=pop(),property=valueKey(key.value);let v;
          if(base.value[0]==='host')v=['hostfn',`${base.value[1]}.${property}`];
          else if(base.value[0]==='intrinsic' && base.value[1]==='Promise' && property==='resolve')v=['builtinfn','Promise.resolve'];
          else if(base.value[0]==='ref')v=s.heap[base.value[1]]?.properties[property]?.value??U;
          else throw new TypeError('Unsupported property receiver (no host fallback)');
          const output=op==='GET_METHOD'?['method',v,base.value]:v;
          return {...operands(base,key),...result(output),reads:base.value[0]==='ref'?[{kind:'property',objectId:base.value[1],key:property,version:s.heap[base.value[1]].version}]:[]};
        }
        case 'PUT_PROP':{
          const v=pop(),key=pop(),base=pop(),property=valueKey(key.value);
          if(base.value[0]!=='ref'||!s.heap[base.value[1]]||s.heap[base.value[1]].kind==='function')throw new TypeError('Not a writable guest object');
          if(property==='__proto__')throw new TypeError('Prototype mutation is not implemented by the bounded profile');
          const obj=s.heap[base.value[1]];Object.defineProperty(obj.properties,property,{value:token(v.value,v.origin),writable:true,enumerable:true,configurable:true});
          if(obj.kind==='array'&&/^\d+$/.test(property)){const length=decode(obj.properties.length.value);if(+property>=length)obj.properties.length=token(['num',+property+1],eventId);}
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
            const kind=operation==='demo.readAsync'?'promise':['demo.store','demo.readNumber'].includes(operation)?'synchronous':null;
            if(!kind)throw new TypeError(`Unregistered host operation ${operation}`);
            const id=this.next(s,'effect'),promiseId=kind==='promise'?this.newPromise(s):null;
            s.effects[id]={id,operation,kind,args:args.map(x=>x.value),argOrigins:args.map(x=>x.origin),frameId:f.id,promiseId,
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
        case 'RETURN':{const v=pop();this.completeFrame(s,f,v.value,v.origin);return {...operands(v),result:v.value};}
        case 'THROW':{const v=pop();throw new Error(`Guest throw (catch is not implemented): ${JSON.stringify(v.value)}`);}
        default:throw new Error(`Unknown opcode ${op}`);
      }
    },{siteId:inst.siteId,sourceId:frame.codeId.split(':')[0],codeId:frame.codeId});
  }
  prepared() {return Object.values(this.state.effects).find(e=>e.dispatch==='prepared');}
  dispatchPrepared(effectId) {
    const e=this.state.effects[effectId];if(!e||e.dispatch!=='prepared')throw new Error('Not prepared');
    this.commit('effect.dispatch',s=>{s.effects[effectId].dispatch='dispatched';return {causes:[{kind:'effect',effectId}]};});
    const adapter=this.adapters[e.operation];
    if(!adapter)return;
    let outcome;
    try {outcome=adapter({effectId,operation:e.operation,args:copy(e.args)});}
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
    if(Array.isArray(value) && !guestValue(value))throw new TypeError('Unsupported canonical external payload');
    const encoded=guestValue(value)?copy(value):encode(value);
    let allocated;
    this.commit('external.input.arrive',s=>{
      allocated=inputId??this.next(s,'input');if(s.inputs[allocated])throw new Error('Duplicate input ID');
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
      if(fx.kind==='promise'){
        if(i.abrupt)throw new Error('Rejected external promises not yet supported by this profile');
        this.resolvePromise(s,fx.promiseId,i.value,eventId);
      }else{
        const f=s.frames[fx.frameId];
        if(f.blockedOn!==fx.id||f.status!=='blocked')throw new Error('Synchronous completion has no matching blocked frame');
        fx.immediate='completed';f.blockedOn=null;f.status='running';
        if(i.abrupt) {s.control.a0.status='failed';f.status='thrown';s.control.a0.activeFrameId=null;}
        else this.stackPush(f,i.value,eventId);
      }
      return {result:i.value,causes:[{kind:'input',inputId},{kind:'effect',effectId:i.effectId}]};
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
      const pending=this.prepared();
      if(pending){this.dispatchPrepared(pending.id);continue;}
      const c=this.state.control.a0;
      const active=c.activeFrameId&&this.state.frames[c.activeFrameId];
      if(active?.status==='running') {this.step();continue;}
      if(active?.status==='blocked'){this.seal('waiting');return {kind:'waiting',waitingOn:active.blockedOn,pendingEffects:this.chunks.at(-1).exit.pendingEffects};}
      if(c.queue.length){this.enterQueuedJob();continue;}
      const pendingPromises=Object.values(this.state.promises).some(p=>p.status==='pending');
      const pendingEffects=Object.values(this.state.effects).some(e=>e.external==='pending');
      const kind=c.status==='failed'?'runtime.failure':pendingPromises||pendingEffects?'waiting':'terminated';
      this.seal(kind);return {kind,waitingOn:this.chunks.at(-1)?.exit.waitingOn??[],pendingEffects:this.chunks.at(-1)?.exit.pendingEffects??[]};
    }
    throw new Error(`Driver safety limit (${this.maxSteps} steps); no chunk has been misreported as complete`);
  }
  checkpoint() {return {stateRoot:`q${this.events.length}`,state:copy(this.state)};}
  inspectState() {return copy(this.state);}
  inspectOpenChunk() {return {before:this.chunkBefore,eventIds:this.events.slice(this.chunkStart).map(e=>e.eventId),open:true};}
  exportRun() {
    return copy({manifest:{schema:'semantic-tracing-run/1',profile:'bounded-js-subset/1',completeSemanticTrace:false,
      completeEcma262:false,completeHostIntegration:false,coverage:'docs/STATUS.md',chunkPolicy:'accumulate-until-wait/1',
      eventVersion:1,operationVersion:1,guestExecution:'owned-bytecode-machine',replay:'state-reconstruction-only'},
      sources:this.sources,sites:this.sites,programs:this.programs,initialState:this.initialState,finalState:this.state,
      events:this.events,chunks:this.chunks,checkpoints:this.checkpoints,effects:this.state.effects,inputs:this.state.inputs});
  }
}
export function createRuntime(options){return new Runtime(options);}
