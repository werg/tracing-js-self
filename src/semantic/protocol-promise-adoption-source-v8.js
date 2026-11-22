// Source-only job identities are declared at the event that actually queues or
// subscribes them. No future settlement chooses a present registration.
import {isDeepStrictEqual as eq} from 'node:util';
import {PROMISE_ADOPTION_COMPONENT_V8 as id,sourcePromiseAdoptionEventV8,sourceHasSyntaxV8} from './source-projection-base-v8.js';

// An unsupported intrinsic can leave a valid owned guest-throw event with no
// operands. The validated CALL's before-stack still binds the actual callable
// and evaluated arguments. Do not certify that implementation limit as a guest
// TypeError or primitive result: Promise object storage requires a separate
// source profile. These positions cover the intrinsics that currently complete
// without modeling that storage. Other object reflection/mutation intrinsics
// already refuse during execution. Object.is is identity-only, and isFrozen is
// correct for an intact, extensible Promise; neither needs object storage here.
// Argument positions matter: a Promise can be the new prototype or descriptor
// of an ordinary object, not just the operation's first operand.
const promiseObjectArguments=new Map([
  ['Object.defineProperty',[0,2]],['Object.create',[0,1]],
  ['Object.setPrototypeOf',[0,1]],['Object.getPrototypeOf',[0]],
  ['Object.preventExtensions',[0]],['Object.isExtensible',[0]]
]);
export function assertPromiseSourceObjectProfileV8(bundle){
  for(const event of bundle.events){
    if(event.operation!=='call.enter')continue;
    const frame=event.stateChanges.find(change=>change.table==='frames'&&change.id===event.invocationId)?.before,
      instruction=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
    if(instruction?.op!=='CALL')continue;
    const count=typeof instruction.arg==='number'?instruction.arg:instruction.arg?.count;
    if(!Number.isSafeInteger(count)||count<1||frame.stack.length<count+1)continue;
    const inputs=frame.stack.slice(-count-1),raw=inputs[0]?.value,
      callee=raw?.[0]==='method'?raw[1]:raw;
    if(callee?.[0]!=='builtinfn'||!promiseObjectArguments.has(callee[1]))continue;
    const args=[];
    for(let index=0;index<count;index++){
      const value=inputs[index+1]?.value;
      if(instruction.arg?.spread?.includes(index)){
        if(value?.[0]!=='spread'||!Array.isArray(value[1]))
          throw new TypeError('Protocol source projection: invalid evaluated mutation arguments');
        args.push(...value[1]);
      }else args.push(value);
    }
    if(callee[1]==='Object.defineProperty'&&args[0]?.[0]==='promise'){
      const error=new TypeError('Protocol source projection: Promise own-property mutation requires its declared source profile');
      error.category='unsupported.promise-source-mutation';throw error;
    }
    if(promiseObjectArguments.get(callee[1]).some(index=>args[index]?.[0]==='promise')){
      const error=new TypeError('Protocol source projection: Promise object operation '+callee[1]+' requires its declared source profile');
      error.category='unsupported.promise-source-object-operation';throw error;
    }
  }
}

function data(ctx){const result=ctx.componentState(id);
  if(!result)ctx.refuse('Promise adoption lacks its source component');return result;}
function ownedPromise(ctx,event,identity){
  const node=event.stateChanges.find(change=>change.table==='promises'&&change.id===identity)?.after??ctx.state.promises[identity];
  if(!node||['properties','prototype','descriptors','accessors','proxy'].some(key=>Object.hasOwn(node,key)))
    ctx.refuse('owned Promise adoption requires unchanged intrinsic then lookup');
  if(node.thenableLocked||node.thenableSerial||node.thenableSeen?.length)
    ctx.refuse('thenable resolving state requires its separate protocol');
  return node;
}
export function prepareSourcePromiseAdoptionV8(ctx,event,owner,promise,target){
  if(target===null||target===undefined)return;
  ownedPromise(ctx,event,target);
  if(promise!==target)return;
  const changed=event.stateChanges.find(change=>change.table==='promises'&&change.id===promise),
    error=changed?.after?.value?.value;
  if(changed?.before?.status!=='pending'||changed.after.status!=='rejected'||error?.[0]!=='ref')
    return; // A previously consumed resolving pair remains a no-op.
  const allocation=event.stateChanges.find(change=>change.table==='heap'&&change.before===null&&change.id===error[1]);
  if(allocation?.after?.declaredError!=='TypeError'||
    !eq(allocation.after.properties.name?.value,['str','TypeError'])||
    !eq(allocation.after.properties.message?.value,['str','Chaining cycle detected for promise']))
    ctx.refuse('self resolution lacks its current source TypeError allocation');
  if(ctx.controller(owner).heap.has(ctx.identity(error[1])))ctx.refuse('source self error identity was already allocated');
}
export function publishSourcePromiseAdoptionV8(ctx,event,owner,promise,target=null){
  const change=event.stateChanges.find(change=>change.table==='promises'&&change.id===promise),
    existing=ctx.controller(owner).heap.get(promise)?.adoption;
  if(!change)return false;
  if(change.after?.adopting&&change.before?.adopting!==change.after.adopting){
    target??=change.after.adopting;
    if(target!==change.after.adopting)ctx.refuse('adoption enqueue differs from its original resolving operand');
    if(existing&&existing.phase!=='intent')return false;
    ownedPromise(ctx,event,promise);ownedPromise(ctx,event,target);
    const control=event.stateChanges.find(change=>change.table==='control'),
      before=control?.before?.queue??[],after=control?.after?.queue??[],
      jobs=after.filter(job=>job.kind==='promise-adopt'&&job.promiseId===promise&&job.targetId===target);
    if(jobs.length!==1||before.some(job=>job.kind==='promise-adopt'&&job.promiseId===promise))
      ctx.refuse('adoption enqueue lacks its exact current source job');
    const state=data(ctx);
    if(state.adoptions.some(row=>row.promise===promise))ctx.refuse('source Promise resolution was already registered');
    const job='adopt'+(++state.next);
    ctx.emitProtocol(owner,{kind:'promise.adopt.enqueue',promise,target,job},event,'source-promise-adopt-enqueue/1');
    state.adoptions.push({promise,target,owner,job,forwarding:null,error:null});return true;
  }
  if(target===promise&&change.before?.status==='pending'&&change.after?.status==='rejected'){
    if(existing&&existing.phase!=='intent')return false;
    const error=change.after.value?.value;
    if(error?.[0]!=='ref')ctx.refuse('self resolution lacks its source rejection value');
    const state=data(ctx);
    if(state.adoptions.some(row=>row.promise===promise))ctx.refuse('duplicate self resolution');
    ctx.emitProtocol(owner,{kind:'promise.adopt.self',promise,error:ctx.identity(error[1])},event,'source-promise-adopt-self/1');
    ctx.claimDataIdentity(error[1]);
    state.adoptions.push({promise,target,owner,job:null,forwarding:null,error:ctx.identity(error[1])});return true;
  }
  return false;
}
export function createPromiseAdoptionTeacherV8(){return {id,
  initialize:()=>({next:0,adoptions:[]}),
  claims:{event:sourcePromiseAdoptionEventV8},
  prepare:{event:(_view,{event})=>({kind:'promise-adoption-event',event:event.eventId})},
  event(ctx,event){
    const queued=ctx.state.control.a0.queue?.[0],state=data(ctx),
      promise=queued?.kind==='promise-adopt'?queued.promiseId:queued?.resultId,
      target=queued?.kind==='promise-adopt'?queued.targetId:queued?.promiseId,
      registration=state.adoptions.find(row=>row.promise===promise);
    if(event.operation!=='job.enter'||!['promise-adopt','adoption'].includes(queued?.kind)||
      !registration||registration.target!==target||registration.error!==null)
      ctx.refuse('adoption job lacks its exact earlier source registration');
    const {owner}=registration;
    if(queued.kind==='promise-adopt'){
      if(registration.forwarding!==null)ctx.refuse('duplicate forwarding registration');
      const old=ctx.state.promises[target],changed=event.stateChanges.find(change=>change.table==='promises'&&change.id===target),
        control=event.stateChanges.find(change=>change.table==='control'),matches=job=>job.kind==='adoption'&&job.resultId===promise,
        ready=(control?.after?.queue??[]).filter(job=>job.promiseId===target&&matches(job)),
        waiting=(changed?.after?.observers??old.observers).filter(matches);
      if((old.observers??[]).some(matches)||(control?.before?.queue??[]).some(job=>job.promiseId===target&&matches(job))||
        ready.length+waiting.length!==1||old.status==='pending'&&waiting.length!==1||old.status!=='pending'&&ready.length!==1)
        ctx.refuse('intrinsic then step lacks its current forwarding subscription');
      const forwarding='forward'+(++state.next);
      ctx.emitProtocol(owner,{kind:'promise.adopt.enter',promise,target,job:registration.job,forwarding},event,'source-promise-adopt-enter/1');
      registration.forwarding=forwarding;return true;
    }
    if(!registration.forwarding)ctx.refuse('forwarding job predates its source subscription');
    const settled=ctx.state.promises[target],changed=event.stateChanges.find(change=>change.table==='promises'&&change.id===promise)?.after;
    if(!['fulfilled','rejected'].includes(settled?.status)||changed?.status!==settled.status||
      !eq(changed.value?.value,settled.value?.value)||changed.adopting!==null)
      ctx.refuse('forwarding step lacks its exact target settlement');
    ctx.emitProtocol(owner,{kind:'promise.adopt.forward',promise,target,job:registration.forwarding,
      status:settled.status,value:ctx.tag(settled.value.value)},event,'source-promise-adopt-forward/1');return true;
  },
  checkEvent(ctx,event){
    const state=data(ctx);
    for(const row of state.adoptions){
      const selected=ctx.controller(row.owner).heap.get(row.promise),owned=ctx.state.promises[row.promise],adoption=selected?.adoption;
      if(!owned||!adoption||adoption.owner!==row.owner||adoption.target!==row.target||adoption.job!==row.job||
        adoption.forwarding!==row.forwarding||adoption.error!==row.error||selected.state!==owned.status||
        !eq(selected.result,owned.value===null?null:ctx.tag(owned.value.value))||
        owned.status==='pending'&&owned.adopting!==row.target)
        ctx.refuse('public adoption differs from its current owned Promise state');
    }
    if(event.stateChanges.some(change=>change.table==='control')){
      const actual=[...ctx.harness.invocations.values()].flatMap(({controller})=>controller.ready
        .filter(identity=>['adopt','adoption'].includes(controller.jobs.get(identity)?.reaction))
        .map(identity=>({identity,sequence:controller.jobs.get(identity).readySequence})))
        .sort((a,b)=>a.sequence-b.sequence).map(row=>row.identity),
        expected=ctx.state.control.a0.queue.filter(job=>['promise-adopt','adoption'].includes(job.kind)).map(job=>{
          const row=state.adoptions.find(row=>row.promise===(job.kind==='promise-adopt'?job.promiseId:job.resultId));
          if(!row)ctx.refuse('owned adoption FIFO job lacks source registration');
          return job.kind==='promise-adopt'?row.job:row.forwarding;
        });
      if(!eq(actual,expected))ctx.refuse('public adoption readiness differs from the owned FIFO queue');
    }
    return true;
  }
};}
export function createPromiseAdoptionSourceAdapterV8(input={}){
  if(!sourceHasSyntaxV8(input,node=>/Function/.test(node.type)&&node.async===true||
    node.type==='Identifier'&&node.name==='Promise'||node.type==='MemberExpression'&&
    ['then','catch','finally'].includes(node.computed?node.property.value:node.property.name)))return null;
  return {id,sourceComponent:createPromiseAdoptionTeacherV8(),sourceProfile:'promise-adoption-source/1'};
}
