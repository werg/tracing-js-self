// Transitional semantic-execution/4 harness ingress for controlled selected output.
// Semantic work is still validated by the v3 selected-state machine. The public
// envelope makes source, invocation, dispatch and external observation distinct;
// it does NOT assert that the complete semantic-trace/4 migration has happened.
import {createHash} from 'node:crypto';
import {decodeWitness,encodeWitness} from './format.js';
import {SemanticController} from './controller.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {describeGraph} from './graph.js';
import {renderWitness} from './render.js';

export const HARNESS_ENVELOPE_VERSION='semantic-execution/4';
export const HARNESS_SELECTED_TRACE_VERSION='semantic-trace/3';
const ID=/^[a-z][a-z0-9:_-]*$/;
const clone=x=>structuredClone(x);
function demand(value,message){if(!value)throw new TypeError(message);}
function id(value,name){demand(typeof value==='string'&&ID.test(value), 'Invalid '+name);}
function tag(value){
  if(value===undefined)return ['undefined'];
  if(value===null)return ['null'];
  if(typeof value==='string')return ['str',value];
  if(typeof value==='boolean')return ['bool',value];
  if(typeof value==='bigint')return ['bigint',String(value)];
  if(typeof value==='number'){
    if(Object.is(value,-0))return ['num','-0'];
    if(Number.isNaN(value))return ['num','NaN'];
    if(value===Infinity)return ['num','+Infinity'];
    if(value===-Infinity)return ['num','-Infinity'];
    return ['num',value];
  }
  throw new TypeError('Unregistered external result codec (primitive only)');
}
function fail(message){throw new Error(message);}

/**
 * The embedding owns adapters. The model can only commit semantic witness
 * records; it cannot publish observed results, bypass a source callsite or
 * run arbitrary generated JS in the host. Adapters receive evaluated values
 * from the selected controller, not new model-authored arguments.
 */
export class SelectedExecutionHarness {
  constructor({sessionId='session1',services={},maxGenerated=4096}={}){
    id(sessionId,'session ID');
    demand(services&&typeof services==='object'&&!Array.isArray(services),
      'Registered services must be a plain record');
    demand(Object.getPrototypeOf(services)===Object.prototype||
      Object.getPrototypeOf(services)===null,'Service registry must be a plain record');
    this.sessionId=sessionId;this.services=Object.create(null);
    for(const operation of Reflect.ownKeys(services)){
      const descriptor=Object.getOwnPropertyDescriptor(services,operation);
      demand(typeof operation==='string'&&descriptor&&
        Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='function',
        'Services require own function data properties');
      this.services[operation]=descriptor.value;
    }
    this.maxGenerated=maxGenerated;
    this.programs=new Map();this.invocations=new Map();
    this.intents=new Map();this.inflight=new Map();this.timeline=[];
    this.ownerSequences=new Map();this.globalSequence=0;
  }
  record(mode,kind,track,details){
    const ownerSequence=(this.ownerSequences.get(track)??0)+1;
    this.ownerSequences.set(track,ownerSequence);
    const item=Object.freeze({schema:HARNESS_ENVELOPE_VERSION,session:this.sessionId,
      sequence:++this.globalSequence,ownerSequence,track,mode,kind,...clone(details)});
    this.timeline.push(item);return item;
  }
  publishProgram({programId,source,entry,capabilities=[]}){
    id(programId,'program ID');
    demand(!this.programs.has(programId),'Program IDs are immutable and cannot be republished');
    demand(typeof source==='string'&&source.length&&typeof entry==='string',
      'Exact JS source and entry are required');
    demand(Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string')&&
      new Set(capabilities).size===capabilities.length,'Invalid capability grant');
    const sites=analyzeSemanticProgram(source).sites;
    const digest=createHash('sha256').update(source,'utf8').digest('hex');
    const code=encodeWitness('code',{entry,source,sites});
    this.programs.set(programId,{source,entry,code,digest,capabilities:[...capabilities]});
    return this.record('observed','program','host',
      {programId,digest,entry,source,sites,capabilities});
  }
  admitInvocation({programId,invocationId,trackId,realmId,triggerId,args=[],
      completionPolicy='immediate-root'}){
    for(const [value,name] of [[programId,'program ID'],[invocationId,'invocation ID'],
      [trackId,'track ID'],[realmId,'realm ID'],[triggerId,'trigger ID']])id(value,name);
    demand(!this.invocations.has(invocationId),'Invocation already admitted');
    const program=this.programs.get(programId);
    demand(program,'Program must be observed before an invocation');
    demand(Array.isArray(args),'Invocation arguments must be a graph');
    demand(completionPolicy==='immediate-root'||completionPolicy==='owned-quiescence',
      'Invalid completion policy');
    // A fresh selected state domain is an explicit policy, not an implicit
    // mutation of a previous invocation or native module initialization.
    const graph=describeGraph(args);
    const input=encodeWitness('input',{graph});
    const controller=new SemanticController([program.code,input],{
      capabilities:program.capabilities,maxGenerated:this.maxGenerated,
      completionPolicy,observationAuthority:'broker'});
    this.invocations.set(invocationId,{programId,trackId,realmId,triggerId,
      controller,input,status:'running',completionPolicy});
    return this.record('observed','invocation',trackId,
      {programId,invocationId,realmId,triggerId,completionPolicy,
        inputGraph:graph,entry:program.entry,sourceDigest:program.digest});
  }
  selected(invocationId,line){
    id(invocationId,'invocation ID');
    const activation=this.invocations.get(invocationId);
    demand(activation&&activation.status==='running','Invocation is not runnable');
    const {kind,fields}=decodeWitness(line);
    demand(kind!=='observe'&&kind!=='code'&&kind!=='input',
      'Host observations are not selected model actions');
    const answer=activation.controller.commit(line,{track:'t0',mode:'generated'});
    if(kind==='request'){
      const key=invocationId+'/'+fields.effect;
      // Controller validation happens BEFORE the dispatch intent becomes
      // committed; invalid or partial witness bytes have no external effects.
      demand(!this.intents.has(key),'Duplicate intent key');
      const effect=activation.controller.effects.get(fields.effect);
      this.intents.set(key,{status:'committed',operation:effect.operation,
        args:clone(effect.arguments),payload:effect.payload,invocationId,
        effectId:fields.effect,attempts:0});
    }
    if(kind==='end')activation.status='completed';
    this.record('generated','semantic',activation.trackId,
      {invocationId,traceFormat:HARNESS_SELECTED_TRACE_VERSION,line});
    return answer;
  }
  /**
   * Dispatch exactly one previously validated logical request. A retry gets
   * the same in-process promise; a restored uncertain dispatch never repeats
   * external writes without an explicit reconciliation receipt.
   */
  dispatch(invocationId,effectId){
    const key=invocationId+'/'+effectId, intent=this.intents.get(key);
    demand(intent,'No committed selected request for dispatch');
    if(this.inflight.has(key))return this.inflight.get(key);
    demand(intent.status==='committed',
      'Cannot redispatch settled or uncertain external intent');
    const adapter=this.services[intent.operation];
    demand(typeof adapter==='function','No granted native adapter for '+intent.operation);
    intent.status='dispatched';intent.attempts++;
    this.record('observed','dispatch',this.invocations.get(invocationId).trackId,
      {invocationId,effectId,key,attempt:intent.attempts});
    const run=Promise.resolve().then(()=>adapter(clone(intent.args),
      Object.freeze({sessionId:this.sessionId,invocationId,effectId,
        idempotencyKey:key,operation:intent.operation})))
      .then(value=>this.deliverResult(invocationId,effectId,
        {status:'fulfilled',value}))
      .catch(error=>this.deliverResult(invocationId,effectId,
        {status:'rejected',value:error instanceof Error?error.message:String(error)}));
    this.inflight.set(key,run);
    return run;
  }
  /** Only host code supplies an observed result. There is no reference/teacher repair. */
  deliverResult(invocationId,effectId,{status,value}){
    const key=invocationId+'/'+effectId,intent=this.intents.get(key);
    demand(intent&&['dispatched','uncertain'].includes(intent.status),
      'Unknown, duplicate or uncommitted result');
    demand(status==='fulfilled'||status==='rejected','Invalid result status');
    const activation=this.invocations.get(invocationId);
    const result=tag(value);
    const line=encodeWitness('observe',{effect:effectId,status,result});
    activation.controller.commit(line,{mode:'observed',track:'t0'});
    intent.status='settled';
    return this.record('observed','result',activation.trackId,
      {invocationId,effectId,status,result,line});
  }
  inspect(invocationId){
    const activation=this.invocations.get(invocationId);
    demand(activation,'Unknown invocation');
    const program=this.programs.get(activation.programId);
    const visible=['code '+program.entry+' @'+program.digest.slice(0,12),
      'invoke '+invocationId+' on '+activation.trackId+' caused by '+activation.triggerId];
    for(const item of this.timeline){
      if(item.invocationId===invocationId&&item.line)
        visible.push((item.mode==='observed'?'observed: ':'generated: ')+
          renderWitness(item.line));
    }
    return visible;
  }
  /** No service code executes during state restoration or trace inspection. */
  checkpoint(){
    return clone({schema:'semantic-checkpoint/4',sessionId:this.sessionId,
      programs:[...this.programs],invocations:[...this.invocations].map(([key,v])=>[
        key,{...v,controller:v.controller.segmentPacket()}]),
      intents:[...this.intents],timeline:this.timeline,
      ownerSequences:[...this.ownerSequences],globalSequence:this.globalSequence,
      maxGenerated:this.maxGenerated});
  }
  static restore(packet,{services={}}={}){
    demand(packet?.schema==='semantic-checkpoint/4','Wrong checkpoint version');
    const harness=new SelectedExecutionHarness({
      sessionId:packet.sessionId,services,maxGenerated:packet.maxGenerated});
    harness.programs=new Map(clone(packet.programs));
    harness.invocations=new Map(packet.invocations.map(([id,v])=>[id,{
      ...v,controller:SemanticController.fromPacket(v.controller)}]));
    harness.intents=new Map(clone(packet.intents).map(([id,intent])=>[
      id,{...intent,status:intent.status==='dispatched'?'uncertain':intent.status}]));
    harness.timeline=clone(packet.timeline);
    harness.ownerSequences=new Map(packet.ownerSequences);
    harness.globalSequence=packet.globalSequence;
    return harness;
  }
}
