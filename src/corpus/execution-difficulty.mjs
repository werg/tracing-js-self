// Difficulty is measured from the certified executed journal, not source tags
// or fixture names. Unavailable token/context measurements remain explicit null.
import {parse} from 'acorn';
import {normalizeJournal} from '../semantic/normalize.js';
import {canonicalHash} from './source-registry.mjs';

const truthy=value=>value?.[0]==='bool'?value[1]:value?.[0]==='ref'?true:
  ['undefined','null','absent'].includes(value?.[0])?false:value?.[0]==='str'?value[1].length>0:
  value?.[0]==='num'?![0,'-0','NaN'].includes(value[1]):value?.[0]==='bigint'?value[1]!=='0':null;
function aliasCount(graph){
  const references=new Map();
  function visit(value){
    if(Array.isArray(value)){
      if(value.length===2&&value[0]==='ref'&&typeof value[1]==='string')
        references.set(value[1],(references.get(value[1])??0)+1);
      else for(const item of value)visit(item);
    }else if(value&&typeof value==='object')for(const item of Object.values(value))visit(item);
  }
  visit(graph);
  return [...references.values()].reduce((total,count)=>total+Math.max(0,count-1),0);
}
function loopSites(bundle){
  const result=[];
  for(const source of bundle.sources){
    const ast=parse(source.text,{ecmaVersion:'latest'});
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){node.forEach(visit);return;}
      if(['ForStatement','WhileStatement','DoWhileStatement'].includes(node.type))
        result.push({sourceId:source.sourceId,start:node.start,end:node.end,kind:node.type,
          test:node.test?{start:node.test.start,end:node.test.end}:null});
      for(const [key,value] of Object.entries(node))if(!['start','end'].includes(key))visit(value);
    }
    visit(ast);
  }
  return result;
}
function archiveDifficulty(exported){
  const bundle=exported.sidecar.archive,normalized=normalizeJournal(bundle).events;
  const raw=new Map(bundle.events.map(event=>[event.eventId,event])),sites=new Map(bundle.sites.map(site=>[site.siteId,site]));
  const branches=normalized.filter(event=>event.op==='branch').map(event=>({
    sourceId:raw.get(event.journalEvent).sourceId,start:event.source?.start??null,
    end:event.source?.end??null,test:event.test,truthy:truthy(event.test),path:event.path}));
  const loops=loopSites(bundle).map(loop=>{
    const checks=branches.filter(event=>event.sourceId===loop.sourceId&&event.start===loop.test?.start&&event.end===loop.test?.end);
    const entries=bundle.events.filter(event=>event.operation==='control.loop.enter'&&event.sourceId===loop.sourceId&&
      sites.get(event.siteId)?.start===loop.start&&sites.get(event.siteId)?.end===loop.end).length;
    const passes=checks.filter(event=>event.truthy===true).length;
    return {...loop,conditionEvaluations:checks.length,conditionPasses:passes,entries,
      trips:loop.test?passes+(loop.kind==='DoWhileStatement'?entries:0):null};
  });
  let heapObjects=Object.keys(bundle.initialState.heap).length,peakHeapObjects=heapObjects;
  const frames=new Map(Object.entries(bundle.initialState.frames)),effects=new Map(Object.entries(bundle.initialState.effects));
  let peakPendingEffects=0,maxCallDepth=0,heapMutations=0,bindingMutations=0;
  const depth=id=>{let result=0;const seen=new Set();
    while(id&&frames.has(id)&&!seen.has(id)){seen.add(id);result++;id=frames.get(id).callerFrameId;}return result;};
  for(const event of bundle.events){
    if(['binding.write','binding.update'].includes(event.operation))bindingMutations++;
    if(event.stateChanges.some(change=>change.table==='heap'&&change.before&&change.after&&
      canonicalHash(change.before.properties??{})!==canonicalHash(change.after.properties??{})))heapMutations++;
    for(const change of event.stateChanges){
      if(change.table==='heap'){if(!change.before&&change.after)heapObjects++;if(change.before&&!change.after)heapObjects--;}
      if(change.table==='frames'){if(change.after)frames.set(change.id,change.after);else frames.delete(change.id);}
      if(change.table==='effects'){if(change.after)effects.set(change.id,change.after);else effects.delete(change.id);}
    }
    peakHeapObjects=Math.max(peakHeapObjects,heapObjects);
    peakPendingEffects=Math.max(peakPendingEffects,[...effects.values()].filter(effect=>effect.external==='pending').length);
    maxCallDepth=Math.max(maxCallDepth,depth(event.invocationId));
  }
  const asyncDepth=new Map();let asyncDependencyDepth=0;
  for(const event of normalized){
    const ancestors=[...(event.dependsOn??[]),event.control].filter(Boolean);
    const depth=Math.max(0,...ancestors.map(id=>asyncDepth.get(id)??0))+(event.op==='await'?1:0);
    asyncDepth.set(event.id,depth);asyncDependencyDepth=Math.max(asyncDependencyDepth,depth);
  }
  const throwSites=normalized.filter(event=>event.op==='throw').map(event=>({
    sourceId:raw.get(event.journalEvent).sourceId,start:event.source?.start??null,end:event.source?.end??null}));
  const outcome=exported.sidecar.reference.outcome;
  return {journalEvents:bundle.events.length,semanticEvents:normalized.length,
    branchEvaluations:branches.length,branchOutcomes:{truthy:branches.filter(row=>row.truthy===true).length,
      falsy:branches.filter(row=>row.truthy===false).length},branches,loops,
    loopTrips:loops.some(loop=>loop.trips===null)?null:loops.reduce((n,loop)=>n+loop.trips,0),
    loopBackedges:normalized.filter(event=>event.op==='loop').length,
    maxCallDepth,initialHeapObjects:Object.keys(bundle.initialState.heap).length,
    finalHeapObjects:Object.keys(bundle.finalState.heap).length,peakHeapObjects,
    initialAliasEdges:aliasCount(exported.sidecar.referenceInput.inputGraph),
    finalAliasEdges:aliasCount(outcome.graph),heapMutationEvents:heapMutations,bindingMutationEvents:bindingMutations,
    exceptionPath:{outcome:outcome.kind,throws:throwSites.length,sites:throwSites},
    awaits:normalized.filter(event=>event.op==='await').length,
    callbacks:normalized.filter(event=>event.op==='callback').length,
    asyncDependencyDepth,peakPendingEffects,
    pendingWorkAtCompletion:{effects:Object.values(bundle.finalState.effects).filter(effect=>effect.external==='pending').length,
      promises:Object.values(bundle.finalState.promises).filter(promise=>promise.status==='pending').length,
      liveFrames:Object.values(bundle.finalState.frames).filter(frame=>!['completed','failed'].includes(frame.status)).length},
    pathDigest:canonicalHash({sourceDigests:bundle.sources.map(source=>canonicalHash(source.text)),
      branches:branches.map(({sourceId,start,end,truthy,path})=>({sourceId,start,end,truthy,path})),throwSites}),
    executedOperations:[...new Set(bundle.events.map(event=>event.operation))].sort()};
}
export function measureExecutionDifficulty(exported){
  const components=exported.sidecar.collection?.components??[exported];
  const episodes=components.map(archiveDifficulty),timeline=exported.public.timeline;
  const total=key=>episodes.reduce((n,row)=>n+row[key],0),maximum=key=>Math.max(0,...episodes.map(row=>row[key]));
  return {schema:'semantic-execution-difficulty/1',activations:episodes.length,
    branchEvaluations:total('branchEvaluations'),loopTrips:episodes.some(row=>row.loopTrips===null)?null:total('loopTrips'),
    maxCallDepth:maximum('maxCallDepth'),peakHeapObjects:maximum('peakHeapObjects'),
    finalAliasEdges:total('finalAliasEdges'),mutationEvents:total('heapMutationEvents')+total('bindingMutationEvents'),
    exceptionOutcomes:episodes.filter(row=>row.exceptionPath.outcome==='throw').length,
    awaits:total('awaits'),asyncDependencyDepth:maximum('asyncDependencyDepth'),peakPendingEffects:maximum('peakPendingEffects'),
    publicSequenceBytes:Buffer.byteLength(JSON.stringify(exported.public)),
    maxModelContextRecordBytes:Math.max(0,...timeline.filter(row=>row.kind==='model-context').map(row=>Buffer.byteLength(JSON.stringify(row)))),
    learnerGeneratedTokens:exported.sidecar.nativeAdmission?.generatedTokens??null,
    learnerObservedTokens:exported.sidecar.nativeAdmission?.observedTokens??null,
    maxModelContextTokens:null,pathDigest:canonicalHash(episodes.map(row=>row.pathDigest)),
    episodes,definitions:{aliasEdges:'References to a reachable identity after its first occurrence, including cycles and repeated roots.',
      loopTrips:'Truthy loop test evaluations, plus the initial entry of each do/while loop; null for omitted for-loop tests.',
      asyncDependencyDepth:'Longest normalized causal path counted at await records; not wall-clock concurrency.',
      peakHeapObjects:'Owned heap entries including functions, measured across committed state changes.',
      mutationEvents:'Committed heap-property-changing or binding-write events; declarations are excluded.',
      maxModelContextTokens:'Unmeasured; native observed-token totals are not maximum context length.'}};
}
