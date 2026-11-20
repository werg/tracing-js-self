import test from 'node:test';
import assert from 'node:assert/strict';
import {hashAlgorithmData} from '../src/semantic/program.js';
import {rootedInputGraphIdentity} from '../src/semantic/retained-serving-costs.js';
import {compareRetainedServingCosts} from '../src/semantic/serving-cost-comparison.js';

const source='"use strict";function run(x){return x;}',producerRevision='a'.repeat(40),
  tokenizerEvidence={identity:{fingerprint:'b'.repeat(64),tokenizerSha256:'c'.repeat(64),codecVersion:'codec/1',vocabSize:1000},
    qualification:{codecSourceSha256:'d'.repeat(64)}},
  graph={schema:'owned-graph/1',roots:[['num',3]],objects:[]};
const cost=(generated=20,prompt=80,detailed=0)=>({status:'passed',predictions:1,
  bytes:{generated:generated*3,detailed:detailed*3,cumulativeContext:prompt*3,peakContext:prompt*3},
  tokens:{generated,detailed,observedAndContext:prompt,terminal:1,total:generated+prompt+1,peakContext:prompt}});
const beforeRow=(id,options={})=>({id,population:'real',sourceDisposition:'locally_verified',servingArtifact:{},
  sourceDigest:hashAlgorithmData(source),sourceIdentity:{sourceDigest:hashAlgorithmData(source),entry:'run',
    initialInputGraphDigest:hashAlgorithmData(graph),rootedInputGraph:rootedInputGraphIdentity(graph)},cost:cost(50,150,10),...options});
const baseline=rows=>({schema:'semantic-retained-population-token-costs/1',tokenizerEvidence:structuredClone(tokenizerEvidence),rows,
  unavailableBaselines:[{population:'families',declared:624,tokenMeasured:0},{population:'modules',declared:2,tokenMeasured:0}]});
function current(id,rows){
  return {id,report:{schema:'semantic-v8-population-costs/1',producerRevision,tokenizerEvidence:structuredClone(tokenizerEvidence),
    rows:rows.map(row=>({source:'passed',cost:cost(),...row}))},
  population:{producerRevision,tasks:rows.map(row=>({kind:'source',fixture:{id:row.id,source,entry:'run',argsGraph:structuredClone(graph)}}))}};
}

test('paired costs retain each frozen denominator and compare only exact measured source/input matches',()=>{
  const before=baseline([beforeRow('paired'),beforeRow('refused',{sourceDisposition:'frontend-refused',servingArtifact:null,cost:null})]),
    all=current('all',[{id:'paired'},{id:'refused'},{id:'new-family'}]),gallery=current('gallery',[{id:'gallery-only'}]),
    result=compareRetainedServingCosts(before,[all,gallery]);
  assert.equal(result.summary.paired,1);assert.equal(result.summary.declaredRows,4);
  assert.deepEqual(result.summary.dispositions,{paired:1,'baseline-unmeasured':1,'baseline-not-retained':2});
  assert.equal(result.summary.before.flatTotalTokens,201);assert.equal(result.summary.after.flatTotalTokens,101);
  assert.equal(result.summary.afterOverBefore.generatedTokens,0.4);
  assert.equal(result.summary.detailedTokenShare.before,0.2);assert.equal(result.summary.detailedTokenShare.after,0);
  assert.equal(result.denominators.baselineRetainedDeclared,2);assert.equal(result.denominators.baselineTokenMeasured,1);
  assert.deepEqual(result.denominators.currentPopulations.map(row=>[row.id,row.declared]),[['all',3],['gallery',1]]);
  assert.equal(result.denominators.baselineUnavailable[0].declared,624);
  assert.equal(result.defaultPromotion,'not-qualified');assert.equal(result.model.status,'unmeasured');
});

test('changed source entry or initial values cannot silently enter a paired token comparison',()=>{
  for(const mutate of [fixture=>{fixture.source+=' ';},fixture=>{fixture.entry='different';},
    fixture=>{fixture.argsGraph.roots[0]=['num',4];}]){
    const group=current('all',[{id:'paired'}]);mutate(group.population.tasks[0].fixture);
    const result=compareRetainedServingCosts(baseline([beforeRow('paired')]),[group]);
    assert.equal(result.summary.paired,0);assert.equal(result.rows[0].status,'source-entry-or-input-differs');
    assert.equal(result.summary.afterOverBefore.flatTotalTokens,null);
  }
});

test('rooted graph matching permits object ID renaming while preserving aliases and unreachable counts',()=>{
  const oldGraph={roots:[['ref','o7'],['ref','o7']],objects:[{id:'o7',kind:'object',properties:[{key:'n',value:['num',3]}]},
    {id:'rest',kind:'array',properties:[{key:'length',value:['num',0]}]}]},
    old=beforeRow('paired'),group=current('all',[{id:'paired'}]);
  old.sourceIdentity.rootedInputGraph=rootedInputGraphIdentity(oldGraph);
  group.population.tasks[0].fixture.argsGraph={schema:'owned-graph/1',roots:[['ref','o0'],['ref','o0']],
    objects:[{id:'o0',kind:'object',properties:[{key:'n',value:['num',3]}]}]};
  const result=compareRetainedServingCosts(baseline([old]),[group]);assert.equal(result.summary.paired,1);
  assert.equal(result.rows[0].identity.baselineRootedInput.unreachableObjects,1);
  assert.equal(result.rows[0].identity.currentRootedInput.unreachableObjects,0);
  group.population.tasks[0].fixture.argsGraph.roots[1]=['num',3];
  assert.equal(compareRetainedServingCosts(baseline([old]),[group]).summary.paired,0);
});

test('missing ambiguous and unmeasured current cases stay explicit and codec changes reject',()=>{
  const before=baseline([beforeRow('missing'),beforeRow('ambiguous'),beforeRow('limited')]),
    first=current('all',[{id:'ambiguous'},{id:'limited',cost:{status:'resource_limited'}}]),
    second=current('gallery',[{id:'ambiguous'}]),result=compareRetainedServingCosts(before,[first,second]);
  assert.equal(result.summary.paired,0);
  assert.deepEqual(result.rows.slice(0,3).map(row=>row.status),['current-case-missing','current-case-ambiguous','current-unmeasured']);
  second.report.tokenizerEvidence.identity.fingerprint='e'.repeat(64);
  assert.throws(()=>compareRetainedServingCosts(before,[first,second]),/tokenizer identity differs/);
  const changed=current('all',[{id:'limited'}]);changed.report.rows[0].cost.tokens.total++;
  assert.throws(()=>compareRetainedServingCosts(baseline([beforeRow('limited')]),[changed]),/segment totals differ/);
});
