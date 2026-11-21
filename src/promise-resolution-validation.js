// Structural authority for synchronous Promise resolution continuations. This
// module inspects owned data only; it never imports or invokes the evaluator.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
    object=state.heap[parent];if(!object)fail('Unknown Promise lookup prototype');
  }
  fail('Unknown Promise lookup object');
}
function selectedLookup(state,resolution,fail){
  let object=state.heap[resolution?.[1]],seen=new Set();
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
  }else fail('Unknown Promise lookup resume kind');
}
export function validatePromiseResolutionState(state,fail){
  for(const frame of Object.values(state.frames)){
    const lookup=frame.promiseThenLookup;if(!lookup)continue;
    const fields=Object.keys(lookup).sort(),expected=['promiseId','resolution','origin','resume','delivered',
      ...(lookup.proxyTarget?['proxyTarget']:[])].sort();
    if(!equal(fields,expected)||typeof lookup.delivered!=='boolean'||
       lookup.resolution?.[0]!=='ref'||!state.heap[lookup.resolution[1]]||
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
  for(const patch of event.stateChanges){
    if(patch.table!=='frames')continue;
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
