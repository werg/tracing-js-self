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
