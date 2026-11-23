// Promise resolution has two observable FIFO turns: the intrinsic then call
// registers a forwarding reaction, which subsequently settles the result. Both
// use the controller's existing jobs, dependency sequence and ready queue.
import {assertAlgorithmFields} from './ir.js';
import {assertPlainPromiseResolutionWithApiV8} from './promise-resolution-shape-v8.js';
import {isDeepStrictEqual as eq} from 'node:util';
import {promiseIntrinsicIdV8} from './protocol-promise-object-v8.js';

export const PROMISE_ADOPTION_PROFILE_V8='promise-adoption/1';
export const PROMISE_ADOPTION_STATE_V8='semantic-promise-adoption-state/1';
export const PROMISE_ADOPTION_RECORD_FIELDS=Object.freeze(Object.fromEntries(Object.entries({
  'promise.adopt.enqueue':['kind','promise','target','job'],
  'promise.adopt.enter':['kind','promise','target','job','forwarding'],
  'promise.adopt.forward':['kind','promise','target','job','status','value'],
  'promise.adopt.self':['kind','promise','error'],
  'promise.reaction.complete':['kind','job','owner','promise','target']
}).map(([kind,fields])=>[kind,Object.freeze(fields)])));
const copy=structuredClone,bound=4096;
const fail=message=>{const error=new TypeError('Promise adoption: '+message);error.category='unsupported.promise-adoption';throw error;};
const id=value=>{if(typeof value!=='string'||!value||value.length>256)fail('bounded identity required');};
const entries=controller=>[...controller.heap].filter(([,node])=>node.adoption!==undefined);
function promise(controller,identity,api){const node=controller.heap.get(identity);
  api.require(node?.kind==='promise'&&node.external===null,'owned internal Promise required');return node;}

// The source-owned Promise representation has the unmodified intrinsic then.
// A public Promise brand alone cannot authorize bypassing an own then, getter,
// proxy or a different prototype. Those need their own lookup/call protocol.
export function assertIntrinsicPromiseThenV8(controller,identity,api){
  const node=promise(controller,identity,api);
  api.require(node.properties instanceof Map&&node.callable===undefined&&node.proxy===undefined,
    'owned Promise adoption requires ordinary property storage');
  if(controller.protocol?.promiseObjects?.initialized){
    const descriptor=api.resolveProperty(controller,identity,['str','then']).descriptor,
      method=controller.heap.get(promiseIntrinsicIdV8('Promise.prototype.then'));
    api.require(descriptor?.kind==='data'&&api.eq(descriptor.value,['ref',promiseIntrinsicIdV8('Promise.prototype.then')])&&
      method?.kind==='intrinsic'&&method.intrinsicName==='Promise.prototype.then'&&method.callableKind==='function',
      'owned Promise adoption requires its resolved intrinsic then');
  }else api.require(!node.properties.has('then')&&!node.descriptors?.has('then')&&
    [undefined,'ordinary'].includes(node.prototype),'owned Promise adoption requires its unchanged intrinsic then lookup');
  return node;
}
function cause(value){
  const fields={resolver:['kind','resolver'],async:['kind','invocation'],reaction:['kind','job'],source:['kind']}[value?.kind];
  if(!fields)fail('resolution cause');assertAlgorithmFields(value,fields,'Promise resolution cause');
  for(const field of fields)if(field!=='kind')id(value[field]);
}
function freshResult(controller,identity,api){
  const node=promise(controller,identity,api);
  api.require(node.state==='pending'&&node.result===null&&node.adopted===null&&!node.join&&node.adoption===undefined,
    'resolution requires an unclaimed pending Promise');
  api.require(entries(controller).length<bound,'Promise adoption bound');return node;
}
function unprotected(controller,identity,node,api){
  api.require(!node.asyncCall&&!controller.protocol?.promiseExecutors?.capabilities.some(row=>row.promise===identity)&&
    ![...controller.jobs.values()].some(job=>job.target===identity),
    'protected result requires its original resolving function or completion');
}
export function stagePromiseAdoptionV8(controller,identity,target,resolutionCause,api){
  cause(resolutionCause);const node=freshResult(controller,identity,api);
  assertIntrinsicPromiseThenV8(controller,target,api);
  api.require(!entries(controller).some(([,row])=>row.adoption.owner===controller.rootInvocation&&row.adoption.phase==='intent'),
    'another resolution intent must be consumed first');
  node.adoption={schema:PROMISE_ADOPTION_STATE_V8,owner:controller.rootInvocation,target,phase:'intent',
    cause:copy(resolutionCause),job:null,forwarding:null,error:null};return node.adoption;
}
export function hasPromiseAdoptionResolutionV8(controller,identity,target,resolutionCause,owner=controller.rootInvocation){
  const adoption=controller.heap.get(identity)?.adoption;
  return adoption?.schema===PROMISE_ADOPTION_STATE_V8&&adoption.owner===owner&&adoption.target===target&&
    eq(adoption.cause,resolutionCause);
}
export function validatePromiseAdoptionRecordV8(record,{value:validate}={}){
  const fields=PROMISE_ADOPTION_RECORD_FIELDS[record?.kind];if(!fields)return false;
  assertAlgorithmFields(record,fields,'Promise adoption record');
  for(const field of fields)if(!['kind','status','value'].includes(field))id(record[field]);
  if(record.kind==='promise.adopt.forward'){
    if(!['fulfilled','rejected'].includes(record.status))fail('forwarding settlement');
    if(validate)validate(record.value);
  }return true;
}
function current(controller,record,api){
  const node=promise(controller,record.promise,api),adoption=node.adoption;
  api.require(adoption?.schema===PROMISE_ADOPTION_STATE_V8&&adoption.owner===controller.rootInvocation&&
    adoption.target===record.target,'adoption target or owning invocation differs');return {node,adoption};
}
function freshJob(controller,identity,api){
  api.fresh(controller,identity);
  api.require(!controller.jobs.has(identity)&&!controller.continuations.has(identity),'fresh adoption job identity required');
}
function turn(controller,identity,job,api){
  api.require(controller.stack.length===0&&!controller.activeJob&&
    ![...controller.jobs.values()].some(row=>row.status==='running')&&
    controller.ready[0]===identity&&job?.status==='queued'&&job.owner===controller.rootInvocation,
    'adoption step violates FIFO or active turn ownership');
}
export function applyPromiseAdoptionRecordV8(controller,record,api){
  if(!validatePromiseAdoptionRecordV8(record,{value:value=>api.known(controller,value)}))return false;
  if(record.kind==='promise.reaction.complete'){
    const job=controller.jobs.get(record.job),returned=job?.returned;
    api.require(job?.status==='running'&&job.owner===record.owner&&record.owner===controller.rootInvocation&&
      job.promise&&['then','catch'].includes(job.reaction)&&job.target===record.promise&&
      returned?.kind==='return'&&api.eq(returned.value,['ref',record.target]),
      'reaction adoption lacks its exact returned Promise and derived result');
    api.require(!controller.stack.length&&controller.activeJob===record.job&&
      ![...controller.continuations.values()].some(row=>row.activeJob===record.job&&row.state!=='resumed'),
      'reaction completion lacks its finished callback scope');
    stagePromiseAdoptionV8(controller,record.promise,record.target,{kind:'reaction',job:record.job},api);
    job.status='completed';controller.captureAliases=new Map(job.priorAliases);
    if(Object.hasOwn(job,'priorReceiver'))controller.receiver=copy(job.priorReceiver);
    controller.activeJob=null;return true;
  }
  if(record.kind==='promise.adopt.self'){
    const node=promise(controller,record.promise,api);
    if(node.adoption===undefined){unprotected(controller,record.promise,node,api);
      stagePromiseAdoptionV8(controller,record.promise,record.promise,{kind:'source'},api);}
    const adoption=node.adoption;
    api.require(adoption.owner===controller.rootInvocation&&adoption.phase==='intent'&&adoption.target===record.promise,
      'self resolution requires the exact original resolution intent');
    freshJob(controller,record.error,api);
    controller.heap.set(record.error,{kind:'object',code:null,captures:[],prototype:'ordinary',properties:new Map([
      ['name',['str','TypeError']],['message',['str','Chaining cycle detected for promise']]
    ])});adoption.phase='self';adoption.error=record.error;
    controller.settlePromise(record.promise,'rejected',['ref',record.error]);return true;
  }
  if(record.kind==='promise.adopt.enqueue'){
    const node=promise(controller,record.promise,api);
    if(node.adoption===undefined){unprotected(controller,record.promise,node,api);
      stagePromiseAdoptionV8(controller,record.promise,record.target,{kind:'source'},api);}
    const {adoption}=current(controller,record,api);
    api.require(adoption.phase==='intent'&&record.promise!==record.target,'enqueue requires a distinct pending adoption target');
    freshJob(controller,record.job,api);adoption.job=record.job;adoption.phase='queued';
    controller.jobs.set(record.job,{status:'queued',owner:adoption.owner,closure:null,
      reaction:'adopt',adoptionPromise:record.promise,adoptionTarget:record.target,
      readySequence:++controller.scheduler.ready});
    controller.ready.push(record.job);return true;
  }
  const {node,adoption}=current(controller,record,api),job=controller.jobs.get(record.job);
  turn(controller,record.job,job,api);
  api.require(node.state==='pending'&&node.result===null&&node.adopted===null&&
    job.adoptionPromise===record.promise&&job.adoptionTarget===record.target,
    'adoption scheduler linkage differs');
  if(record.kind==='promise.adopt.enter'){
    api.require(adoption.phase==='queued'&&adoption.job===record.job&&job.reaction==='adopt',
      'assimilation job is not this Promise resolution');
    freshJob(controller,record.forwarding,api);
    controller.ready.shift();job.status='completed';adoption.phase='observing';adoption.forwarding=record.forwarding;
    controller.jobs.set(record.forwarding,{status:'waiting',owner:adoption.owner,promise:record.target,
      reaction:'adoption',closure:null,rejectionClosure:null,target:null,
      sequence:++controller.scheduler.registration,adoptionPromise:record.promise,adoptionTarget:record.target});
    controller.refreshReady();return true;
  }
  api.require(adoption.phase==='observing'&&adoption.forwarding===record.job&&job.reaction==='adoption'&&
    job.promise===record.target,'forwarding job is not this registered dependency');
  const target=promise(controller,record.target,api);
  api.require(target.state===record.status&&api.eq(target.result,record.value),
    'forwarding contradicts the settled target');
  if(record.status==='fulfilled')assertPlainPromiseResolutionWithApiV8(controller,record.value,api);
  controller.ready.shift();job.status='completed';adoption.phase='completed';
  controller.settlePromise(record.promise,record.status,record.value);return true;
}
export function assertPromiseAdoptionNextV8(controller,record){
  const fields=record.fields??record,owned=entries(controller).filter(([,node])=>node.adoption.owner===controller.rootInvocation),
    intent=owned.find(([,node])=>node.adoption.phase==='intent');
  if(intent)return (record.kind==='promise.adopt.enqueue'&&fields.target===intent[1].adoption.target||
    record.kind==='promise.adopt.self'&&intent[0]===intent[1].adoption.target)&&fields.promise===intent[0];
  if(record.kind==='promise'&&['resolve','reject','adopt'].includes(fields.action)&&controller.heap.get(fields.promise)?.adoption)return false;
  if(['promise.join','promise.executor.enter','async.call'].includes(record.kind)&&
    controller.heap.get(fields.result??fields.promise)?.adoption)return false;
  const selected=controller.jobs?.get(fields.job);
  if(record.kind==='job'&&['adopt','adoption'].includes(selected?.reaction))return false;
  if(record.kind==='promise.reaction.complete')return true;
  if(record.kind==='job'&&fields.action==='complete'&&selected?.status==='running')return true;
  const head=controller.ready?.[0],job=controller.jobs?.get(head);
  if(controller.stack.length===0&&!controller.activeJob&&['adopt','adoption'].includes(job?.reaction))
    return record.kind===(job.reaction==='adopt'?'promise.adopt.enter':'promise.adopt.forward')&&fields.job===head;
  return true;
}
export function allowsPromiseAdoptionWithoutStackV8(_controller,record){
  return Object.hasOwn(PROMISE_ADOPTION_RECORD_FIELDS,record.kind);
}
export function allowsPromiseAdoptionInternalSchedulerV8(controller,record){
  return Object.hasOwn(PROMISE_ADOPTION_RECORD_FIELDS,record?.kind)||entries(controller).length>0;
}
export function restorePromiseAdoptionStateV8(controller,api){
  const ownedJobs=new Set(),pending=[];
  for(const [identity,node]of entries(controller)){
    const adoption=node.adoption;
    assertAlgorithmFields(adoption,['schema','owner','target','phase','cause','job','forwarding','error'],'Promise adoption state');
    id(adoption.owner);id(adoption.target);cause(adoption.cause);
    api.require(adoption.schema===PROMISE_ADOPTION_STATE_V8&&node.kind==='promise'&&node.external===null&&
      node.adopted===null&&!node.join&&['intent','queued','observing','completed','self'].includes(adoption.phase),
      'retained adoption state shape');
    const target=assertIntrinsicPromiseThenV8(controller,adoption.target,api),settled=['completed','self'].includes(adoption.phase);
    api.require(settled?node.state!=='pending':node.state==='pending'&&node.result===null,'adoption phase contradicts result settlement');
    if(adoption.phase==='self'){
      id(adoption.error);api.require(adoption.target===identity&&adoption.job===null&&adoption.forwarding===null&&
        node.state==='rejected'&&api.eq(node.result,['ref',adoption.error])&&
        controller.heap.get(adoption.error)?.kind==='object','self rejection state');
    }else{
      api.require(adoption.error===null,'non-self adoption has an error identity');
      if(adoption.phase!=='intent')api.require(identity!==adoption.target,'self resolution cannot enqueue jobs');
      if(adoption.phase==='completed')api.require(target.state===node.state&&api.eq(target.result,node.result),'forwarded result differs from target');
    }
    if(adoption.owner!==controller.rootInvocation)continue;
    const origin=adoption.cause;
    if(origin.kind==='resolver'){
      const cap=controller.protocol?.promiseExecutors?.capabilities.find(row=>row.promise===identity);
      api.require(cap?.resolve===origin.resolver&&cap.called&&cap.resolution?.mode==='resolve'&&
        api.eq(cap.resolution.value,['ref',adoption.target]),'retained resolver adoption lost its first-call cause');
    }else if(origin.kind==='async'){
      api.require(node.asyncCall?.owner===adoption.owner&&node.asyncCall.invocation===origin.invocation&&
        node.asyncCall.phase==='completed'&&node.asyncCall.completion?.kind==='return'&&
        api.eq(node.asyncCall.completion.value,['ref',adoption.target]),'retained async adoption lost its exact completion');
    }else if(origin.kind==='reaction'){
      const original=controller.jobs.get(origin.job);
      api.require(original?.owner===adoption.owner&&original.status==='completed'&&original.target===identity&&
        ['then','catch'].includes(original.reaction)&&original.returned?.kind==='return'&&
        api.eq(original.returned.value,['ref',adoption.target]),'retained reaction adoption lost its exact completion');
    }else unprotected(controller,identity,node,api);
    if(adoption.phase==='intent'){pending.push(identity);api.require(adoption.job===null&&adoption.forwarding===null,'intent contains future job identities');}
    else if(adoption.phase!=='self'){
      id(adoption.job);const first=controller.jobs.get(adoption.job);
      if(first)assertAlgorithmFields(first,['status','owner','closure','reaction','adoptionPromise','adoptionTarget','readySequence'],
        'retained assimilation job');
      api.require(!ownedJobs.has(adoption.job)&&first?.owner===adoption.owner&&first.reaction==='adopt'&&first.closure===null&&
        first.adoptionPromise===identity&&first.adoptionTarget===adoption.target&&
        first.status===(adoption.phase==='queued'?'queued':'completed'),'retained assimilation job linkage');ownedJobs.add(adoption.job);
      if(adoption.phase==='queued')api.require(adoption.forwarding===null,'queued assimilation contains future forwarding identity');
      else{
        id(adoption.forwarding);const forwarding=controller.jobs.get(adoption.forwarding);
        if(forwarding)assertAlgorithmFields(forwarding,['status','owner','promise','reaction','closure','rejectionClosure','target',
          'sequence','adoptionPromise','adoptionTarget',...(forwarding.status==='waiting'?[]:['readySequence'])],
          'retained forwarding job');
        api.require(!ownedJobs.has(adoption.forwarding)&&forwarding?.owner===adoption.owner&&forwarding.reaction==='adoption'&&
          forwarding.promise===adoption.target&&forwarding.adoptionPromise===identity&&forwarding.adoptionTarget===adoption.target&&
          forwarding.closure===null&&forwarding.rejectionClosure===null&&forwarding.target===null&&
          forwarding.status===(adoption.phase==='completed'?'completed':target.state==='pending'?'waiting':'queued'),
          'retained forwarding job linkage');ownedJobs.add(adoption.forwarding);
      }
    }
  }
  api.require(entries(controller).length<=bound&&pending.length<=1,'retained adoption count or pending intent bound');
  for(const [identity,job]of controller.jobs)if(['adopt','adoption'].includes(job.reaction)){
    api.require(ownedJobs.has(identity)&&['waiting','queued','completed'].includes(job.status),'orphan adoption job');
    api.require((job.status==='queued')===controller.ready.includes(identity),'adoption ready queue differs from lifecycle');
    if(job.status!=='waiting')api.require(Number.isSafeInteger(job.readySequence)&&job.readySequence>0&&
      job.readySequence<=controller.scheduler.ready,'adoption ready ordinal');
    if(job.reaction==='adoption')api.require(Number.isSafeInteger(job.sequence)&&job.sequence>0&&
      job.sequence<=controller.scheduler.registration,'forwarding registration ordinal');
  }
  return {valid:true};
}
