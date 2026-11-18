import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {createSemanticSummaryContext,verifySemanticSummary,
  buildSemanticSummaryExperiment} from '../src/training/semantic-summary-experiment.js';

const helper='"use strict";function increment(value){return value+1;}';
const loop='"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}';
const context=(source,entry,args,profile)=>createSemanticSummaryContext({source,entry,inputGraph:encodeNativeGraph(args),profile});
const returned=value=>({schema:'experimental-semantic-summary/1',completion:{kind:'return',value:['num',value]},inputUnchanged:true});
const summed=(value,iterations,checkpoints=[])=>({...returned(value),iterations,
  stateDelta:{binding:'total',before:['num',0],after:['num',value]},checkpoints});

test('bounded pure helper prediction is checked by independent V8 and never filled in',async()=>{
  const input=context(helper,'increment',[4],'pure-helper/1');
  const good=await verifySemanticSummary({context:input,summary:returned(5)});
  assert.equal(good.status,'verified',good.reason);
  assert.equal(good.nativeAdmission,false);
  const bad=await verifySemanticSummary({context:input,summary:returned(17)});
  assert.equal(bad.status,'rejected');
  assert(!Object.hasOwn(bad,'references'));assert(!Object.hasOwn(bad,'correctedSummary'));
  const forged=structuredClone(input);forged.inputGraph.roots[0]=['num',8];
  assert.equal((await verifySemanticSummary({context:forged,summary:returned(9)})).status,'rejected');
});

test('loop supports independently checked coarse and detailed explanations',async()=>{
  const input=context(loop,'sum',[[2,3,4]],'dense-array-sum/1');
  const coarse=await verifySemanticSummary({context:input,summary:summed(9,3)});
  assert.equal(coarse.status,'verified',coarse.reason);
  const detailed=await verifySemanticSummary({context:input,summary:summed(9,3,[
    {iteration:0,total:['num',0]},{iteration:1,total:['num',2]},
    {iteration:2,total:['num',5]},{iteration:3,total:['num',9]}])});
  assert.equal(detailed.status,'verified',detailed.reason);
  assert.equal(detailed.claimsChecked.intermediateCheckpoints,4);
  const wrongIntermediate=await verifySemanticSummary({context:input,
    summary:summed(9,3,[{iteration:1,total:['num',99]},{iteration:3,total:['num',9]}])});
  assert.equal(wrongIntermediate.status,'rejected');
  assert.match(wrongIntermediate.reason,/intermediate accumulator claim/);
  const wrongIterations=await verifySemanticSummary({context:input,summary:summed(9,2)});
  assert.equal(wrongIterations.status,'rejected');
});

test('summary profiles refuse observable operations and non-dense data before execution',()=>{
  for(const source of [
    '"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){host.store("x",i);total+=xs[i];}return total;}',
    '"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];xs[i]=0;}return total;}',
    '"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){if(i===1)break;total+=xs[i];}return total;}',
    '"use strict";function sum(xs){try{return 1;}finally{host.store("x",1);}}'
  ])assert.throws(()=>context(source,'sum',[[1,2]],'dense-array-sum/1'));
  assert.throws(()=>context(loop,'sum',[[,2]],'dense-array-sum/1'),/holes/);
  assert.throws(()=>context(loop,'sum',[[1,undefined]],'dense-array-sum/1'),/non-number/);
  assert.throws(()=>context(loop,'sum',[Array(129).fill(1)],'dense-array-sum/1'),/excessive/);
  assert.throws(()=>context('"use strict";function f(x){return x.value;}','f',[{value:1}],'pure-helper/1'));
  let calls=0;const array=[1];Object.defineProperty(array,'0',{get(){calls++;return 1;}});
  assert.throws(()=>context(loop,'sum',[array],'dense-array-sum/1'));
  assert.equal(calls,0,'input inspection must not invoke an accessor');
});

test('zero-iteration loop and claimed state delta have explicit checks',async()=>{
  const input=context(loop,'sum',[[]],'dense-array-sum/1');
  assert.equal((await verifySemanticSummary({context:input,summary:summed(0,0)})).status,'verified');
  const wrong=summed(0,0);wrong.stateDelta.before=['num',7];
  assert.equal((await verifySemanticSummary({context:input,summary:wrong})).status,'rejected');
  assert.equal((await verifySemanticSummary({context:input,summary:{...summed(0,0),futureObservation:9}})).status,'rejected');
});

test('experimental summary retains detailed private execution and shared split lineage',async()=>{
  const input=context(loop,'sum',[[2,3,4]],'dense-array-sum/1');
  const result=await buildSemanticSummaryExperiment({context:input,summary:summed(9,3),family:'summary-dense-sum'});
  assert.equal(result.status,'experimental_verified',result.reason);
  assert.equal(result.private.detailedEpisode.sidecar.sourceFamily,result.sourceLineage);
  assert.deepEqual(result.splitIdentity,result.private.detailedEpisode.sidecar.splitIdentity);
  assert.equal(result.private.certificate.references.operations.schema,'effectful-reference/4');
  assert(result.metrics.summaryBytes<result.metrics.detailedBytes);
  assert.equal(result.metrics.nativeTokens,null);
  assert.equal(result.learningStatus,'untested');
});

test('pure control summaries certify executed branches and skip unexecuted alternatives',async()=>{
  const source='"use strict";function select(x,flag,fallback){return x<0?(flag&&(-x)):(fallback??3);}';
  const input=context(source,'select',[-4,true,0],'pure-control-helper/1');
  const [conditional,and,coalesce]=input.decisionSites;
  const summary={...returned(4),decisions:[
    {site:conditional.site,selected:'consequent'},
    {site:and.site,selected:'right'}]};
  const good=await buildSemanticSummaryExperiment({context:input,summary,family:'summary-pure-control'});
  assert.equal(good.status,'experimental_verified',good.reason);
  assert.equal(good.private.certificate.claimsChecked.controlDecisions,2);
  assert(good.private.detailedEpisode.public.timeline.some(row=>row.kind==='semantic'));
  for(const decisions of [summary.decisions.slice(0,1),[...summary.decisions].reverse(),
    [...summary.decisions,{site:coalesce.site,selected:'left'}],
    [{site:conditional.site,selected:'alternate'},summary.decisions[1]]]){
    const refused=await verifySemanticSummary({context:input,summary:{...summary,decisions}});
    assert.equal(refused.status,'rejected');
    assert(!Object.hasOwn(refused,'correctedSummary'));
  }
  const zero=context(source,'select',[1,true,0],'pure-control-helper/1');
  assert.equal((await verifySemanticSummary({context:zero,summary:{...returned(0),decisions:[
    {site:conditional.site,selected:'alternate'},{site:coalesce.site,selected:'left'}]}})).status,'verified');
});

test('correct output cannot excuse a false branch claim',async()=>{
  const input=context('"use strict";function f(x){return x?4:4;}','f',[false],'pure-control-helper/1');
  const site=input.decisionSites[0].site;
  const good={...returned(4),decisions:[{site,selected:'alternate'}]};
  assert.equal((await verifySemanticSummary({context:input,summary:good})).status,'verified');
  const bad={...returned(4),decisions:[{site,selected:'consequent'}]};
  assert.equal((await verifySemanticSummary({context:input,summary:bad})).status,'rejected');
  assert.deepEqual(bad.decisions,[{site,selected:'consequent'}],'rejection preserves the original prediction');
});

test('pure control summaries refuse hidden effects, object coercion and unbounded expressions',()=>{
  for(const expression of ['x?host.readAsync("x"):0','x?x.value:0','x?(x=1):0','x?(()=>1)():0']){
    assert.throws(()=>context('"use strict";function f(x){return '+expression+';}','f',[true],'pure-control-helper/1'));
  }
  assert.throws(()=>context('"use strict";function f(x){return x?1:2;}','f',[{}],'pure-control-helper/1'),/scalar/);
  assert.throws(()=>context('"use strict";function f(x){return x+1;}','f',[1],'pure-control-helper/1'),/requires a conditional/);
  assert.throws(()=>context('"use strict";function f(x){return x?1:2;}','f',[true],'pure-helper/1'));
});
