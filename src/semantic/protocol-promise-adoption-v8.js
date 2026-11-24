import {allocateIntrinsicErrorV8} from './protocol-intrinsic-error-v8.js';
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
  'promise.adopt.get':['kind','promise','target','job','child'],
  'promise.adopt.finish':['kind','promise','target','job','child','completion','forwarding'],
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
function defaultConstructor(controller,value,api){
  return value?.[0]==='undefined'||api.eq(value,['ref',promiseIntrinsicIdV8('Promise')]);
}
function constructorDescriptor(controller,identity,api){
  if(!controller.protocol?.promiseObjects?.initialized){
    const node=promise(controller,identity,api),own=api.ownDescriptor(node,['str','constructor']);
    api.require(!own||own.kind==='data'&&own.value[0]==='undefined',
      'observable adoption constructor requires initialized intrinsic identities');return null;
  }
  return api.resolveProperty(controller,identity,['str','constructor']).descriptor;
}
function assertDefaultConstructor(controller,identity,api){
  const descriptor=constructorDescriptor(controller,identity,api),value=descriptor?.kind==='data'?descriptor.value:['undefined'];
  api.require(!descriptor||descriptor.kind==='data'||descriptor.get[0]==='undefined',
    'adoption constructor getter requires its owned job continuation');
  api.require(defaultConstructor(controller,value,api),
    'custom adoption constructor/species requires its own continuation');
}

function ownedPromiseStorage(controller,identity,api){
  const node=promise(controller,identity,api);
  api.require(node.properties instanceof Map&&node.callable===undefined&&node.proxy===undefined,
    'owned Promise adoption requires ordinary property storage');
  return node;
}
// Resolution captures the selected then before queuing its call. A Promise
// brand alone cannot authorize that selection, but later property mutations
// cannot replace it either. Only this initial stage reads the live descriptor.
export function assertIntrinsicPromiseThenV8(controller,identity,api){
  const node=ownedPromiseStorage(controller,identity,api);
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
  for(const field of fields)if(!['kind','status','value','completion'].includes(field)&&
    !(record.kind==='promise.adopt.finish'&&field==='forwarding'&&record.forwarding===null))id(record[field]);
  if(record.kind==='promise.adopt.finish'){
    assertAlgorithmFields(record.completion,['kind','value'],'adoption getter completion');
    if(!['return','throw'].includes(record.completion.kind))fail('adoption getter completion kind');
    if(validate)validate(record.completion.value);
    if((record.completion.kind==='throw')!==(record.forwarding===null))fail('adoption getter forwarding completion');
  }
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
function subscribe(controller,record,adoption,api){
  freshJob(controller,record.forwarding,api);adoption.phase='observing';adoption.forwarding=record.forwarding;
  controller.jobs.set(record.forwarding,{status:'waiting',owner:adoption.owner,promise:record.target,
    reaction:'adoption',closure:null,rejectionClosure:null,target:null,
    sequence:++controller.scheduler.registration,adoptionPromise:record.promise,adoptionTarget:record.target});
  controller.refreshReady();
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
    allocateIntrinsicErrorV8(controller,{identity:record.error,errorType:'TypeError',message:'Chaining cycle detected for promise'},api);
    adoption.phase='self';adoption.error=record.error;
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
  if(record.kind==='promise.adopt.finish'){
    const lookup=adoption.lookup;
    api.require(adoption.phase==='reading'&&adoption.job===record.job&&lookup?.child===record.child&&
      node.state==='pending'&&node.result===null&&node.adopted===null&&
      job?.status==='running'&&job.reaction==='adopt'&&job.owner===adoption.owner&&
      job.adoptionPromise===record.promise&&job.adoptionTarget===record.target&&
      controller.activeJob===record.job&&controller.stack.length===1&&controller.stack[0]===record.child&&
      !controller.protocol.pendingCalls.length&&!controller.protocol.callFrames.length&&
      ![...controller.continuations.values()].some(row=>row.activeJob===record.job&&row.state!=='resumed'),
      'adoption getter completion lacks its exact active job and returned scope');
    api.known(controller,record.completion.value);
    if(record.completion.kind==='return')api.require(defaultConstructor(controller,record.completion.value,api),
      'custom adoption constructor/species requires its own continuation');
    controller.stack.pop();controller.captureAliases=new Map(job.priorAliases);controller.receiver=copy(job.priorReceiver);
    controller.activeJob=null;job.status='completed';job.returned=copy(record.completion);
    if(record.completion.kind==='throw'){
      adoption.phase='rejected';controller.settlePromise(record.promise,'rejected',record.completion.value);
    }else subscribe(controller,record,adoption,api);
    return true;
  }
  turn(controller,record.job,job,api);
  api.require(node.state==='pending'&&node.result===null&&node.adopted===null&&
    job.adoptionPromise===record.promise&&job.adoptionTarget===record.target,
    'adoption scheduler linkage differs');
  if(['promise.adopt.enter','promise.adopt.get'].includes(record.kind)){
    api.require(adoption.phase==='queued'&&adoption.job===record.job&&job.reaction==='adopt',
      'assimilation job is not this Promise resolution');
    if(record.kind==='promise.adopt.get'){
      const descriptor=constructorDescriptor(controller,record.target,api),callee=descriptor?.kind==='accessor'?descriptor.get:null,
        closure=callee?.[0]==='ref'?controller.heap.get(callee[1]):null;
      api.require(callee?.[0]==='ref',
        'adoption getter requires its selected synchronous owned getter');
      api.require(closure?.kind==='closure'&&!closure.asyncFunction&&!closure.generatorFunction&&!closure.promiseResolver&&
        !closure.callable?.lexicalConstruction,
        'adoption getter cannot use an unauthenticated constructor capture');
      api.require(!controller.protocol.callFrames.length&&!controller.protocol.pendingCalls.length,
        'adoption getter cannot inherit another call continuation');
      // A job has no guest caller. Use the common checked activation machinery,
      // retaining its caller state on the job rather than an absent call frame.
      api.call(controller,{child:record.child,callee,receiver:['ref',record.target],arguments:[]});
      const scope=controller.protocol.callFrames.pop();
      job.priorAliases=scope.priorAliases;job.priorReceiver=scope.priorReceiver;job.closure=callee[1];
      controller.ready.shift();job.status='running';controller.activeJob=record.job;
      adoption.phase='reading';adoption.lookup={child:record.child,callee:copy(callee)};return true;
    }
    assertDefaultConstructor(controller,record.target,api);
    controller.ready.shift();job.status='completed';subscribe(controller,record,adoption,api);return true;
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
  const reading=owned.find(([,node])=>node.adoption.phase==='reading');
  if(reading&&controller.stack.at(-1)===reading[1].adoption.lookup.child&&['return','throw','await'].includes(record.kind))return false;
  if(record.kind==='promise'&&['resolve','reject','adopt'].includes(fields.action)&&controller.heap.get(fields.promise)?.adoption)return false;
  if(['promise.join','promise.executor.enter','async.call'].includes(record.kind)&&
    controller.heap.get(fields.result??fields.promise)?.adoption)return false;
  const selected=controller.jobs?.get(fields.job);
  if(record.kind==='job'&&['adopt','adoption'].includes(selected?.reaction))return false;
  if(record.kind==='promise.reaction.complete')return true;
  if(record.kind==='job'&&fields.action==='complete'&&selected?.status==='running')return true;
  const head=controller.ready?.[0],job=controller.jobs?.get(head);
  if(controller.stack.length===0&&!controller.activeJob&&['adopt','adoption'].includes(job?.reaction))
    return (job.reaction==='adopt'?['promise.adopt.enter','promise.adopt.get'].includes(record.kind):record.kind==='promise.adopt.forward')&&fields.job===head;
  return true;
}
export function allowsPromiseAdoptionWithoutStackV8(_controller,record){
  return Object.hasOwn(PROMISE_ADOPTION_RECORD_FIELDS,record.kind);
}
export function allowsPromiseAdoptionInternalSchedulerV8(controller,record){
  return Object.hasOwn(PROMISE_ADOPTION_RECORD_FIELDS,record?.kind)||entries(controller).length>0;
}
export function restorePromiseAdoptionStateV8(controller,api){
  const ownedJobs=new Set(),pending=[],reading=[];
  for(const job of controller.jobs?.values()??[])for(const identity of [job.closure,job.rejectionClosure])if(identity){
    const closure=controller.heap.get(identity),capture=closure?.callable?.lexicalConstruction;
    if(capture!==undefined&&capture!==null){
      api.require(closure?.kind==='closure'&&closure.functionKind==='arrow',
        'scheduled constructor capture requires its exact arrow');
      // Re-resolve the arrow's receiver from the retained constructor cell at
      // every checkpoint. This authenticates the constructor frame and rejects
      // forged or stale lexical receiver metadata without trusting the job row.
      api.callReceiver(controller,['ref',identity],closure.lexicalReceiver);
    }
  }
  for(const [identity,node]of entries(controller)){
    const adoption=node.adoption,lookup=adoption.lookup;
    assertAlgorithmFields(adoption,['schema','owner','target','phase','cause','job','forwarding','error',
      ...(lookup===undefined?[]:['lookup'])],'Promise adoption state');
    id(adoption.owner);id(adoption.target);cause(adoption.cause);
    api.require(adoption.schema===PROMISE_ADOPTION_STATE_V8&&node.kind==='promise'&&node.external===null&&
      node.adopted===null&&!node.join&&['intent','queued','reading','observing','completed','rejected','self'].includes(adoption.phase),
      'retained adoption state shape');
    // The checked resolution intent already selected intrinsic then. Restore
    // its target storage and lifecycle authority, not a new historical lookup.
    const target=ownedPromiseStorage(controller,adoption.target,api),settled=['completed','rejected','self'].includes(adoption.phase);
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
    if(lookup!==undefined){
      assertAlgorithmFields(lookup,['child','callee'],'adoption constructor lookup');id(lookup.child);api.known(controller,lookup.callee);
      const closure=lookup.callee?.[0]==='ref'?controller.heap.get(lookup.callee[1]):null,
        receiver=closure?.functionKind==='arrow'?closure.lexicalReceiver:['ref',adoption.target];
      api.require(['reading','observing','completed','rejected'].includes(adoption.phase)&&closure?.kind==='closure'&&
        !closure.asyncFunction&&!closure.generatorFunction&&!closure.promiseResolver&&
        !closure.callable?.lexicalConstruction,'retained adoption getter identity or unauthenticated constructor capture');
      if(adoption.owner===controller.rootInvocation){
        api.require(controller.frameFunctions.get(lookup.child)===closure.code&&
          api.eq(controller.locals.get(lookup.child+':this'),receiver),'retained adoption getter identity or receiver');
        if(adoption.phase==='reading'){
          reading.push(identity);api.require(controller.activeJob===adoption.job&&controller.stack[0]===lookup.child,
            'retained adoption getter lost its active job scope');
          if(controller.stack.at(-1)===lookup.child)api.require(api.eq(controller.receiver,receiver)&&
            api.eq([...controller.captureAliases],closure.captures.map(row=>[row.binding,row.cell])),
            'retained adoption getter receiver or captures differ');
        }else api.require(!controller.stack.includes(lookup.child),'finished adoption getter remains active');
      }
    }else api.require(!['reading','rejected'].includes(adoption.phase),'adoption getter phase lacks its selected lookup');
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
      if(first)assertAlgorithmFields(first,['status','owner','closure','reaction','adoptionPromise','adoptionTarget','readySequence',
        ...(lookup?['priorAliases','priorReceiver',...(adoption.phase==='reading'?[]:['returned'])]:[])],
        'retained assimilation job');
      api.require(!ownedJobs.has(adoption.job)&&first?.owner===adoption.owner&&first.reaction==='adopt'&&first.closure===(lookup?lookup.callee[1]:null)&&
        first.adoptionPromise===identity&&first.adoptionTarget===adoption.target&&
        first.status===(adoption.phase==='queued'?'queued':adoption.phase==='reading'?'running':'completed'),'retained assimilation job linkage');ownedJobs.add(adoption.job);
      if(lookup){
        api.known(controller,first.priorReceiver);
        api.require(Array.isArray(first.priorAliases)&&first.priorAliases.every(pair=>Array.isArray(pair)&&pair.length===2&&
          pair.every(value=>typeof value==='string')&&controller.locals.has(pair[1]))&&
          new Set(first.priorAliases.map(pair=>pair[0])).size===first.priorAliases.length,'adoption getter prior capture aliases');
        if(adoption.phase!=='reading'){
          assertAlgorithmFields(first.returned,['kind','value'],'retained adoption getter completion');api.known(controller,first.returned.value);
          api.require(adoption.phase==='rejected'?first.returned.kind==='throw'&&node.state==='rejected'&&api.eq(node.result,first.returned.value):
            first.returned.kind==='return'&&defaultConstructor(controller,first.returned.value,api),'retained adoption getter completion differs');
        }
      }
      if(['queued','reading','rejected'].includes(adoption.phase))api.require(adoption.forwarding===null,'unfinished or rejected assimilation contains forwarding identity');
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
  api.require(entries(controller).length<=bound&&pending.length<=1&&reading.length<=1,'retained adoption count or pending intent bound');
  for(const [identity,job]of controller.jobs)if(['adopt','adoption'].includes(job.reaction)){
    api.require(ownedJobs.has(identity)&&['waiting','queued','running','completed'].includes(job.status),'orphan adoption job');
    api.require((job.status==='queued')===controller.ready.includes(identity),'adoption ready queue differs from lifecycle');
    if(job.status!=='waiting')api.require(Number.isSafeInteger(job.readySequence)&&job.readySequence>0&&
      job.readySequence<=controller.scheduler.ready,'adoption ready ordinal');
    if(job.reaction==='adoption')api.require(Number.isSafeInteger(job.sequence)&&job.sequence>0&&
      job.sequence<=controller.scheduler.registration,'forwarding registration ordinal');
  }
  return {valid:true};
}
