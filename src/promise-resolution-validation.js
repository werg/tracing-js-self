// Structural authority for synchronous Promise resolution continuations. This
// module inspects owned data only; it never imports or invokes the evaluator.
import {symbolPropertyKey} from './property-keys.js';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const speciesKey=symbolPropertyKey('well-known:species');
const intrinsicPrototypes=new Set(['Object.prototype','Array.prototype','Function.prototype',
  'Generator.prototype','GeneratorFunction.prototype']);
const prototype=object=>Object.hasOwn(object,'prototype')?object.prototype:
  object.kind==='array'?'Array.prototype':object.kind==='function'?'Function.prototype':'Object.prototype';
function descriptor(state,object,key,fail){
  const visited=new Set();
  while(object){
    if(visited.has(object.id))fail('Cyclic Promise lookup prototype');
    visited.add(object.id);
    if(Object.hasOwn(object.properties??{},key))return {value:object.properties[key].value};
    if(Object.hasOwn(object.accessors??{},key))return {getter:object.accessors[key].get.value};
    const parent=prototype(object);
    if(parent===null||intrinsicPrototypes.has(parent))return {value:['undefined']};
    if(parent==='Promise.prototype'&&!state.heap[parent])return {value:key==='constructor'?['intrinsic','Promise']:
      ['then','catch','finally'].includes(key)?['builtinfn','Promise.prototype.'+key]:['undefined']};
    object=state.heap[parent]??state.promises[parent];if(!object)fail('Unknown Promise lookup prototype');
  }
  fail('Unknown Promise lookup object');
}
function selectedLookup(state,resolution,fail){
  let object=(resolution?.[0]==='promise'?state.promises:state.heap)[resolution?.[1]],seen=new Set();
  while(object?.kind==='proxy'){
    if(seen.has(object.id))fail('Cyclic Promise lookup Proxy');seen.add(object.id);
    const handler=state.heap[object.handlerId],trap=descriptor(state,handler,'get',fail);
    if(trap.getter)fail('Unmodeled Promise lookup handler getter');
    if(!['undefined','null'].includes(trap.value?.[0]))return {
      method:trap.value,receiver:['ref',handler.id],target:['ref',object.targetId]};
    object=state.heap[object.targetId];
  }
  return {method:descriptor(state,object,'then',fail).getter,receiver:resolution,target:null};
}
function validateConstructorSelection(state,event,lookup,receiver,fail){
  const continuation=lookup.continuation;
  if(continuation.phase!=='species'){
    if(lookup.property!=='constructor'||!equal(lookup.receiver,receiver))
      fail('Promise constructor lookup changed its source receiver');
    return;
  }
  if(lookup.property!==speciesKey)fail('Promise species lookup changed its selected property');
  let object=(receiver?.[0]==='promise'?state.promises:state.heap)[receiver?.[1]];
  // A finally callback can return a primitive, allocate its cleanup Promise,
  // and select an inherited species getter in this same event. Its fresh
  // ordinary state is fixed; the constructor still comes from the prior realm.
  if(!object&&continuation.kind==='finally'&&continuation.stage==='then'&&
     equal(receiver,['promise',continuation.cleanupId])){
    const allocated=event.stateChanges.find(change=>change.table==='promises'&&
      change.id===continuation.cleanupId&&change.before===null)?.after;
    if(allocated?.kind==='promise'&&allocated.prototype==='Promise.prototype'&&allocated.extensible===true&&
       allocated.shapeVersion===0&&!Object.keys(allocated.properties??{}).length&&!Object.keys(allocated.accessors??{}).length)
      object=allocated;
  }
  const constructor=descriptor(state,object,'constructor',fail);
  if(!Object.hasOwn(constructor,'value')||!equal(constructor.value,lookup.receiver))
    fail('Promise species lookup changed its original data constructor');
}
function validateResume(state,resume,fail,depth=0){
  if(!resume||depth>3||typeof resume!=='object'||Array.isArray(resume))fail('Invalid Promise lookup resume');
  const fields=Object.keys(resume).sort();
  const exact=names=>{if(!equal(fields,names.sort()))fail('Unknown Promise lookup resume fields');};
  const frame=()=>{if(typeof resume.frameId!=='string'||!state.frames[resume.frameId])fail('Unknown Promise lookup resume frame');};
  if(resume.kind==='active'){
    exact(['kind','frameId']);if(resume.frameId!==null)frame();
  }else if(resume.kind==='frame-return'){
    exact(['kind','frameId','value','origin','phase']);frame();
    if(![1,2].includes(resume.phase)||!Array.isArray(resume.value))fail('Invalid Promise return continuation');
  }else if(resume.kind==='finally-adopt'){
    exact(['kind','resultId','passed','origin','after']);
    if(!state.promises[resume.resultId]||!state.promises[resume.passed]||resume.resultId===resume.passed)
      fail('Invalid finally Promise continuation');
    validateResume(state,resume.after,fail,depth+1);
  }else if(resume.kind==='await'){
    exact(['kind','frameId','promiseId']);frame();
    if(!state.frames[resume.frameId].asyncPromiseId||!state.promises[resume.promiseId])fail('Invalid Promise await continuation');
  }else if(resume.kind==='combinator'){
    exact(['kind','frameId','origin']);frame();
  }else if(resume.kind==='finally-cleanup'){
    exact(['kind','continuation','origin']);
    const continuation=resume.continuation;
    if(continuation?.kind!=='finally'||continuation.stage!=='then'||!state.promises[continuation.cleanupId]||
       !state.promises[continuation.reaction?.resultId]||!state.frames[continuation.frameId])fail('Invalid finally cleanup continuation');
    validateResume(state,continuation.after,fail,depth+1);
  }else fail('Unknown Promise lookup resume kind');
}
function validateAwaitSelection(before,event,fail){
  if(event.operation!=='async.await')return;
  const frame=before.frames[event.invocationId],created=event.stateChanges.filter(change=>
    change.table==='frames'&&change.before===null),
    constructor=created.find(change=>change.after?.promiseConstructorLookup?.continuation.kind==='await'),
    then=created.find(change=>change.after?.promiseThenLookup?.resume.kind==='await');
  if(!frame?.asyncPromiseId||frame.status!=='running'||before.control.a0.activeFrameId!==frame.id||event.operands.length!==1)
    fail('Promise await lacks its active async caller');
  if(constructor){
    if(then||constructor.after.promiseConstructorLookup.continuation.frameId!==frame.id||
       !equal(event.causes,[{kind:'invocation',frameId:constructor.id}]))
      fail('Promise await constructor invocation evidence changed');
    return;
  }
  const lookup=then?.after.promiseThenLookup,
    suspended=event.stateChanges.find(change=>change.table==='frames'&&change.id===frame.id)?.after,
    promiseId=lookup?.resume.promiseId??suspended?.awaiting,input=event.operands[0];
  if(lookup&&(lookup.resume.frameId!==frame.id||lookup.promiseId!==promiseId||!equal(lookup.resolution,input)))
    fail('Promise await then lookup changed its wrapper or input');
  let same=false;
  if(input?.[0]==='promise'){
    const selected=descriptor(before,before.promises[input[1]],'constructor',fail);
    if(selected.getter&&selected.getter[0]!=='undefined')fail('Promise await skipped its constructor getter');
    same=equal(selected.value,['intrinsic','Promise']);
  }
  const allocated=event.stateChanges.find(change=>change.table==='promises'&&change.id===promiseId&&change.before===null);
  if(typeof promiseId!=='string'||(same?promiseId!==input[1]:allocated?.after?.kind!=='promise'))
    fail('Promise await lacks its selected Promise or fresh wrapper');
  if(!equal(event.causes,[{kind:'promise',promiseId},...(then?[{kind:'invocation',frameId:then.id}]:[])]))
    fail('Promise await dependency or getter invocation evidence changed');
}
export function isPromiseConstructorRejection(before,event){
  const completion=event.completion;
  if(completion?.type!=='throw')return false;
  let invocation=event.invocationId;
  if(invocation===null&&event.operation==='external.input.deliver'){
    const effect=before.effects[event.causes.find(cause=>cause.kind==='effect')?.effectId];
    if(effect?.kind!=='synchronous'||before.frames[effect.frameId]?.blockedOn!==effect.id)return false;
    invocation=effect.frameId;
  }
  if(!invocation||invocation!==before.control.a0.activeFrameId)return false;
  const seen=new Set();let continuation;
  while(invocation){
    if(seen.has(invocation))return false;seen.add(invocation);
    const original=before.frames[invocation],patch=event.stateChanges.find(change=>
      change.table==='frames'&&change.id===invocation);
    if(!original||!equal(patch?.before,original)||patch.after?.status!=='thrown'||
       original.asyncPromiseId||!equal(patch.after.completion,completion))return false;
    const lookup=original.promiseConstructorLookup;
    if(lookup&&!lookup.delivered){
      if(!patch.after.promiseConstructorLookup?.delivered)return false;
      if(['adopt','finally'].includes(lookup.continuation.kind)){continuation=lookup.continuation;break;}
      // These lookups retain their synchronous caller explicitly instead of
      // using callerFrameId. An inner getter can unwind into the outer getter.
      invocation=lookup.continuation.frameId;
    }else{
      if(original.promiseThenLookup&&!original.promiseThenLookup.delivered||original.thenableJob||
         original.finallyReaction||original.reactionPromiseId||original.externalCallbackReturn)return false;
      invocation=original.callerFrameId;
    }
  }
  const destination=continuation?.kind==='adopt'?continuation.promiseId:
    continuation?.kind==='finally'?continuation.reaction.resultId:null;
  if(!destination)return false;
  const rejected=event.stateChanges.find(change=>change.table==='promises'&&change.id===destination);
  if(rejected?.before?.status!=='pending'||rejected.after?.status!=='rejected')return false;
  if(completion.value)return equal(rejected.after.value,completion.value);
  const reason=rejected.after.value,allocation=event.stateChanges.find(change=>
    change.table==='heap'&&change.id===reason?.value?.[1]&&change.before===null)?.after;
  return typeof completion.errorType==='string'&&reason?.value?.[0]==='ref'&&reason.origin===event.eventId&&
    allocation?.declaredError===completion.errorType&&allocation.prototype===completion.errorType+'.prototype'&&
    !Object.hasOwn(allocation.properties??{},'name')&&equal(allocation.properties?.message,
      {value:['str',completion.message??''],origin:event.eventId});
}
export function validatePromiseResolutionState(state,fail){
  for(const frame of Object.values(state.frames)){
    const constructor=frame.promiseConstructorLookup;
    if(constructor){
      if(!equal(Object.keys(constructor).sort(),['receiver','property','origin','continuation','delivered'].sort())||
         typeof constructor.delivered!=='boolean'||typeof constructor.property!=='string'||
         !['ref','promise','intrinsic'].includes(constructor.receiver?.[0])||
         !(state.heap[constructor.receiver[1]]??state.promises[constructor.receiver[1]])||
         frame.callerFrameId!==null||!frame.reactionJob)
        fail('Malformed Promise constructor lookup state');
      const c=constructor.continuation;
      if(!c||!['resolve','await','reaction','adopt','finally'].includes(c.kind))fail('Unknown Promise constructor continuation');
      const expected=c.kind==='resolve'||c.kind==='await'?['kind','frameId','value']:
        c.kind==='reaction'?['kind','frameId','receiver','method','args']:
          c.kind==='finally'?['kind','stage','frameId','value','reaction','after',...(c.cleanupId!==undefined?['cleanupId']:[])]:['kind','promiseId','targetId'];
      if(c.phase!==undefined)expected.push('phase');if(c.finallySpecies!==undefined)expected.push('finallySpecies');
      if(!equal(Object.keys(c).sort(),expected.sort())||c.phase!==undefined&&!['constructor','species'].includes(c.phase)||
         c.finallySpecies!==undefined&&(c.kind!=='reaction'||c.method!=='finally'||c.finallySpecies!==true))
        fail('Unknown Promise constructor continuation fields');
      if(c.phase==='species'?(constructor.property!==speciesKey||['resolve','await'].includes(c.kind)||
          c.kind==='finally'&&c.stage!=='then'):constructor.property!=='constructor')
        fail('Promise constructor phase and selected property differ');
      if(c.kind==='adopt'){
        if(!state.promises[c.promiseId]||!state.promises[c.targetId]||c.promiseId===c.targetId)
          fail('Unknown Promise constructor adoption owner');
      }else if(!state.frames[c.frameId])fail('Unknown Promise constructor caller');
      if(['resolve','await'].includes(c.kind)&&(c.value?.[0]!=='promise'||!state.promises[c.value[1]]))
        fail('Unknown PromiseResolve constructor receiver');
      if(c.kind==='reaction'&&(c.receiver?.[0]!=='promise'||!state.promises[c.receiver[1]]||
         !['then','catch','finally'].includes(c.method)||!Array.isArray(c.args)))fail('Invalid Promise reaction constructor');
      if(c.kind==='finally'){
        if(!['resolve','then'].includes(c.stage)||!state.promises[c.reaction?.resultId]||
           c.stage==='then'&&!state.promises[c.cleanupId]||!Array.isArray(c.value))fail('Invalid finally constructor continuation');
        validateResume(state,c.after,fail);
      }
    }
    const lookup=frame.promiseThenLookup;if(!lookup)continue;
    const fields=Object.keys(lookup).sort(),expected=['promiseId','resolution','origin','resume','delivered',
      ...(lookup.proxyTarget?['proxyTarget']:[])].sort();
    if(!equal(fields,expected)||typeof lookup.delivered!=='boolean'||
       !['ref','promise'].includes(lookup.resolution?.[0])||!(state.heap[lookup.resolution[1]]??state.promises[lookup.resolution[1]])||
       !state.promises[lookup.promiseId]||frame.callerFrameId!==null||!frame.reactionJob)
      fail('Malformed Promise then lookup state');
    if(!lookup.delivered&&state.promises[lookup.promiseId].status!=='pending')
      fail('Unfinished Promise then lookup has a settled owner');
    if(lookup.proxyTarget&&(lookup.proxyTarget[0]!=='ref'||!state.heap[lookup.proxyTarget[1]]))
      fail('Unknown Promise then lookup Proxy target');
    validateResume(state,lookup.resume,fail);
  }
}
export function validatePromiseResolutionEvent(before,event,fail){
  validateAwaitSelection(before,event,fail);
  for(const patch of event.stateChanges){
    if(patch.table!=='frames')continue;
    const oldConstructor=patch.before?.promiseConstructorLookup,constructor=patch.after?.promiseConstructorLookup;
    if(oldConstructor){
      if(!constructor||!equal({...oldConstructor,delivered:constructor.delivered},constructor)||oldConstructor.delivered&&!constructor.delivered)
        fail('Promise constructor lookup identity or continuation changed');
      if(!oldConstructor.delivered&&constructor.delivered&&!['completed','thrown','suspended'].includes(patch.after.status))
        fail('Promise constructor lookup completed without a callback boundary');
      if(!oldConstructor.delivered&&constructor.delivered&&patch.after.status==='thrown'&&!patch.after.asyncPromiseId&&
         ['adopt','finally'].includes(oldConstructor.continuation.kind)&&!isPromiseConstructorRejection(before,event))
        fail('Promise constructor throw did not reject its current destination with the exact reason');
    }else if(constructor){
      if(patch.before!==null||constructor.delivered)fail('Promise constructor lookup must start in a new callback');
      const receiver=constructor.receiver,object=(receiver[0]==='promise'?before.promises:before.heap)[receiver[1]],
        getter=descriptor(before,object,constructor.property,fail).getter,fn=before.heap[getter?.[1]];
      if(getter?.[0]!=='ref'||fn?.kind!=='function'||patch.after.codeId!==fn.codeId)
        fail('Promise constructor callback differs from the independently selected getter');
      const expectedReceiver=fn.arrow?fn.lexicalThisFrameId?before.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis:receiver;
      if(!equal(patch.after.thisValue,expectedReceiver))fail('Promise constructor callback receiver changed');
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===patch.after.envId)?.after;
      if(environment?.parent!==fn.closureEnvId)fail('Promise constructor callback capture changed');
      const c=constructor.continuation,raw=event.operands[0],method=raw?.[0]==='method'?raw[1]:raw,
        prior=before.frames[event.invocationId]?.promiseConstructorLookup;
      if(prior&&!prior.delivered&&event.operation!=='call.enter'&&event.operation!=='async.await'){
        const previous=prior.continuation,{phase:ignoredPhase,finallySpecies:ignoredFinally,...base}=c,
          {phase:previousPhase,finallySpecies:previousFinally,...oldBase}=previous;
        const finallyNext=c.kind==='finally'&&previous.kind==='finally'&&previous.stage==='resolve'&&c.stage==='then'&&
          equal({...base,stage:'resolve',cleanupId:undefined},{...oldBase,cleanupId:undefined});
        if(!finallyNext&&(!equal(base,oldBase)||!(c.phase==='species'||c.kind==='reaction'&&c.method==='finally'&&c.finallySpecies)))
          fail('Promise constructor continuation lost its parent lookup');
      }else if(c.kind==='finally'){
        const owner=before.frames[c.frameId],thenLookup=before.frames[event.invocationId]?.promiseThenLookup;
        if(owner?.finallyReaction){
          if(!equal(owner.finallyReaction,c.reaction)||c.frameId!==event.invocationId)
            fail('Finally constructor lookup changed its reaction owner');
          const input=owner.asyncPromiseId?['promise',owner.asyncPromiseId]:event.operands.at(-1);
          if(!equal(c.value,input))
            fail('Finally constructor lookup changed its cleanup result');
          validateConstructorSelection(before,event,constructor,c.stage==='resolve'?c.value:['promise',c.cleanupId],fail);
        }else if(thenLookup?.resume?.kind==='finally-cleanup'){
          const expected=thenLookup.resume.continuation;
          if(!equal(c.phase==='species'?{...c,phase:expected.phase}:c,expected))
            fail('Finally constructor lookup changed its pending cleanup');
          validateConstructorSelection(before,event,constructor,['promise',c.cleanupId],fail);
        }else fail('Finally constructor lookup lacks its callback boundary');
      }else if(c.kind==='adopt'){
        const job=before.control.a0.queue[0];
        if(event.operation!=='job.enter'||job?.kind!=='promise-adopt'||job.promiseId!==c.promiseId||job.targetId!==c.targetId)
          fail('Promise constructor adoption changed its queued source');
        validateConstructorSelection(before,event,constructor,['promise',c.targetId],fail);
      }else{
        if(c.frameId!==event.invocationId)fail('Promise constructor lookup changed its source binding');
        if(c.kind==='await'){
          if(event.operation!=='async.await'||!equal(event.operands,[c.value]))fail('Promise await constructor changed its input');
          validateConstructorSelection(before,event,constructor,c.value,fail);
        }else if(c.kind==='resolve'){
          if(event.operation!=='call.enter'||!equal(method,['builtinfn','Promise.resolve'])||!equal(event.operands[1],c.value))
            fail('PromiseResolve constructor changed its input');
          validateConstructorSelection(before,event,constructor,c.value,fail);
        }else{
          if(event.operation!=='call.enter'||!equal(method,['builtinfn','Promise.prototype.'+c.method])||
            !equal(raw?.[2],c.receiver)||!equal(event.operands.slice(1),c.args))
            fail('Promise reaction constructor changed its receiver or arguments');
          validateConstructorSelection(before,event,constructor,c.receiver,fail);
        }
      }
    }
    const old=patch.before?.promiseThenLookup,lookup=patch.after?.promiseThenLookup;
    if(old){
      if(!lookup||!equal({...old,delivered:lookup.delivered},lookup)||old.delivered&&!lookup.delivered)
        fail('Promise then lookup identity or continuation changed');
      if(!old.delivered&&lookup.delivered&&
         !['completed','thrown','suspended','suspended-generator'].includes(patch.after.status))
        fail('Promise then lookup completed without a callback boundary');
    }else if(lookup){
      if(patch.before!==null||lookup.delivered)fail('Promise then lookup must start in a new callback');
      const selected=selectedLookup(before,lookup.resolution,fail),fn=before.heap[selected.method?.[1]];
      if(selected.method?.[0]!=='ref'||fn?.kind!=='function'||patch.after.codeId!==fn.codeId||
         !equal(lookup.proxyTarget??null,selected.target))
        fail('Promise then lookup callback differs from the independently selected getter or trap');
      const receiver=fn.arrow?fn.lexicalThisFrameId?before.frames[fn.lexicalThisFrameId]?.thisValue:fn.lexicalThis:selected.receiver;
      if(!equal(patch.after.thisValue,receiver))fail('Promise then lookup callback receiver changed');
      const environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===patch.after.envId)?.after;
      if(environment?.parent!==fn.closureEnvId)fail('Promise then lookup callback capture changed');
    }
  }
}
