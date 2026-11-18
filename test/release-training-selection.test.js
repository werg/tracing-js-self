import test from 'node:test';
import assert from 'node:assert/strict';
import {selectReleaseTraining} from '../tools/select-release-training.mjs';

const row=(id,sourceCluster,generatedTokens,split='train')=>({id,family:sourceCluster,sourceCluster,
  status:'admitted',generatedTokens,split,splitPolicy:'source-components/1',registryDigest:'a'.repeat(64)});
test('release caps use native tokens on whole frozen training components and retain every held-out ID',()=>{
  const rows=[row('a1','shared-source',60),{...row('a2','shared-source',50),family:'renamed-descendant'},
    row('b1','independent',60),row('validation','shared-source',10000,'validation'),row('test','novel',20000,'test')];
  const result=selectReleaseTraining(rows,{maxFamilyTokens:100,maxFamilyShare:.5});
  assert.deepEqual(result.selectedTrainIds,['a1','b1']);
  assert.deepEqual(result.excludedTrain,[{id:'a2',reason:'family-token-budget'}]);
  assert.deepEqual(result.heldOutIds,['validation','test']);
  assert.deepEqual(result.preparedCandidateIds,['a1','b1','validation','test']);
  assert.equal(result.generatedTokens.selectedTrain,120);assert.equal(result.generatedTokens.heldOut,30000);
  assert.ok(result.components.every(component=>component.selectedTokenShare===.5));
  assert.equal(rows.length,5);assert.equal(rows[1].status,'admitted');
});
test('release defaults preserve the entire native-admitted membership and order',()=>{
  const rows=[row('z','one',100),row('v','one',1000,'validation'),row('a','one',100)];
  const result=selectReleaseTraining(rows);
  assert.equal(result.policy.enabled,false);assert.deepEqual(result.preparedCandidateIds,['z','v','a']);
  assert.deepEqual(result.excludedTrain,[]);assert.equal(result.generatedTokens.selectedTrain,200);
});
test('family shares use the final training denominator without silently relaxing an impossible cap',()=>{
  const result=selectReleaseTraining([row('a','one',10),row('b','one',10),row('held','other',10000,'test')],
    {maxFamilyShare:.2});
  assert.equal(result.status,'empty-training-selection');assert.deepEqual(result.selectedTrainIds,[]);
  assert.deepEqual(result.preparedCandidateIds,['held']);assert.equal(result.generatedTokens.selectedTrain,0);
  assert.equal(result.excludedTrain.length,2);
});
test('caps reject unmeasured counts, duplicate IDs and unauthenticated or inconsistent registries',()=>{
  assert.throws(()=>selectReleaseTraining([row('a','x',0)]),/actual native/);
  assert.throws(()=>selectReleaseTraining([row('a','x',2),row('a','y',2)]),/unique/);
  assert.throws(()=>selectReleaseTraining([{...row('a','x',2),splitPolicy:'family-hash/1'}],{maxFamilyTokens:10}),/authenticated/);
  assert.throws(()=>selectReleaseTraining([row('a','x',2),{...row('b','y',2),registryDigest:'b'.repeat(64)}],
    {maxFamilyTokens:10}),/one global/);
  for(const options of [{maxFamilyTokens:0},{maxFamilyShare:0},{maxFamilyShare:1.1}])
    assert.throws(()=>selectReleaseTraining([row('a','x',2)],options),/Invalid/);
});
