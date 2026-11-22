/** Coordinate concurrent dynamic imports for one reference-module realm.
 * Node reports a VM module as `evaluated` as soon as evaluation has started,
 * including while top-level await is still pending. The stored evaluation
 * promise is the completion authority in that interval. */
export function createModuleEvaluationCoordinator({linker,timeout,refuse}={}){
  if(typeof linker!=='function'||!Number.isSafeInteger(timeout)||timeout<1||typeof refuse!=='function')
    throw new TypeError('Module evaluation coordinator requires linker, timeout and refusal policy');
  const linkPromises=new Map(),evaluationPromises=new Map();
  const linkOnce=target=>{
    if(target.status==='errored')return Promise.reject(target.error);
    const active=linkPromises.get(target);
    if(active)return active.then(()=>target);
    if(['linked','evaluating','evaluated'].includes(target.status))return Promise.resolve(target);
    let pending;
    try{pending=target.link(linker);}
    catch(error){return Promise.reject(error);}
    linkPromises.set(target,pending);
    return pending.then(()=>target);
  };
  const evaluateOnce=async target=>{
    await linkOnce(target);
    const active=evaluationPromises.get(target);
    if(active){await active;return target;}
    if(target.status==='evaluated'){
      // A statically linked dependency can be evaluated as part of its entry
      // module without ever being a dynamic-import root in this coordinator.
      // Node marks it "evaluated" while its TLA completion promise is pending;
      // another Module.evaluate() call recovers that graph completion promise.
      const pending=target.evaluate({timeout});
      evaluationPromises.set(target,pending);
      await pending;return target;
    }
    if(target.status==='errored')throw target.error;
    if(target.status==='evaluating')
      throw refuse('A dependency is already evaluating outside this module request');
    const pending=target.evaluate({timeout});
    evaluationPromises.set(target,pending);
    await pending;return target;
  };
  const trackEvaluation=(target,promise)=>{
    if(!target||!promise||typeof promise.then!=='function'||evaluationPromises.has(target))
      throw new TypeError('Module evaluation is missing or already tracked');
    evaluationPromises.set(target,promise);return promise;
  };
  return {linkOnce,evaluateOnce,trackEvaluation,linkPromises,evaluationPromises};
}
