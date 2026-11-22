import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSourceRegistry,frozenSplitIdentity,verifyFrozenSplitIdentity,
  verifySourceRegistry,immutableSourceRegistry,balanceFamilyTokens,canonicalHash} from '../src/corpus/source-registry.mjs';

const row=(id,source,extra={})=>({id,family:id,source,...extra});
test('freezes ancestry, renamed/literal variants and upstream revisions before expansion',()=>{
  const registry=buildSourceRegistry([
    row('base','function add(x){return x+1;}'),
    row('renamed','function next(y){return y+99;}'),
    row('wrapped','async function wrapper(x){return x+1;}',{ancestorIds:['base']}),
    row('prior','function sum(xs){let n=0;for(let i=0;i<xs.length;i++)n+=xs[i];return n;}',
      {project:'library',upstreamPath:'src/sum.js',upstreamRevision:'v1'}),
    row('later','function sum(xs){let n=0;for(let i=0;i<xs.length;i++)n+=2*xs[i];return n;}',
      {project:'library',upstreamPath:'src/sum.js',upstreamRevision:'v2'})]);
  assert.equal(registry.components.length,2);
  assert.equal(frozenSplitIdentity(registry,'base').componentId,frozenSplitIdentity(registry,'renamed').componentId);
  assert.equal(frozenSplitIdentity(registry,'prior').componentId,frozenSplitIdentity(registry,'later').componentId);
  assert.equal(verifySourceRegistry(registry).valid,true);
  assert.equal(canonicalHash(registry),canonicalHash(buildSourceRegistry([...registry.sources].reverse())));
});
test('holds out whole connected project/composition components and detects split/source tampering',()=>{
  const registry=buildSourceRegistry([
    row('library','function first(a){return a[0];}',{project:'unseen'}),
    row('descendant','async function same(a){return a[0];}',{ancestorIds:['library']}),
    row('composed','function mix(x,y){return x*y+x;}',{composition:'multiply-add'})
  ],{holdoutProjects:['unseen'],holdoutCompositions:['multiply-add']});
  for(const family of ['library','descendant','composed']){
    const identity=frozenSplitIdentity(registry,family);assert.equal(identity.split,'test');
    assert.equal(verifyFrozenSplitIdentity(identity,{family}).valid,true);
    const changed=structuredClone(identity);changed.split='train';
    assert.throws(()=>verifyFrozenSplitIdentity(changed,{family}),/changed/);
  }
  const altered=structuredClone(registry);altered.sources[0].source+=' ';
  assert.throws(()=>verifySourceRegistry(altered),/changed/);
  const spoof=structuredClone(frozenSplitIdentity(registry,'library'));spoof.registryDigest='0'.repeat(64);
  assert.throws(()=>verifyFrozenSplitIdentity(spoof,{family:'library'}),/changed/);
  assert.throws(()=>buildSourceRegistry(registry.sources,{holdoutProjects:['missing']}),/Unknown/);
});
test('enforces family token share using actual native counts with explicit refusals',()=>{
  const rows=[{id:'long',sourceCluster:'a',generatedTokens:100,status:'admitted'},
    ...Array.from({length:4},(_,i)=>({id:'short-'+i,sourceCluster:'b'+i,generatedTokens:10,status:'admitted'}))];
  const result=balanceFamilyTokens(rows,{maxFamilyTokens:100,maxFamilyShare:.4});
  assert.deepEqual(result.refused,[{id:'long',reason:'family-token-share'}]);
  assert.equal(result.generatedTokens,40);assert.equal(result.independentComponents,4);
  assert.throws(()=>balanceFamilyTokens([{...rows[0],status:'locally_verified'}],{maxFamilyTokens:100}),/native-admitted/);
});


test('only verified deeply immutable registry snapshots can reuse authenticated identity',()=>{
  const original=buildSourceRegistry([row('a','function f(x){return x+1;}'),
    row('b','function first(a){return a[0];}')]);
  const immutable=immutableSourceRegistry(original);
  assert.notEqual(immutable,original);assert.equal(immutableSourceRegistry(immutable),immutable);
  assert.equal(verifySourceRegistry(immutable).digest,canonicalHash(original));
  for(const family of ['a','b'])assert.deepEqual(frozenSplitIdentity(immutable,family),frozenSplitIdentity(original,family));
  assert.throws(()=>{immutable.sources[0].source='changed';},TypeError);
  assert.throws(()=>{immutable.components[0].members.push('forged');},TypeError);
  original.sources[0].source='changed';
  assert.throws(()=>verifySourceRegistry(original),/changed/);
  // Neither a shallow frozen object nor a forged content digest gets the fast path.
  const forged=structuredClone(immutable);forged.components[0].split='forged';Object.freeze(forged);
  assert.throws(()=>verifySourceRegistry(forged),/changed/);
  assert.equal(verifySourceRegistry(immutable).valid,true);
});

test('registry retains exact clone audit budgets and rejects forged accounting',()=>{
  const sources=[row('a','function f(x){return x+1;}'),row('b','function f(x){return x*x;}')];
  const registry=buildSourceRegistry(sources,{cloneBudget:{maxComparisons:100,maxIndexEntries:100}});
  assert.equal(registry.cloneBudget.maxComparisons,100);
  assert.equal(registry.diagnostics.cloneAudit.complete,true);
  assert.equal(verifySourceRegistry(registry).valid,true);
  const forged=structuredClone(registry);forged.diagnostics.cloneAudit.costs.comparisons++;
  assert.throws(()=>verifySourceRegistry(forged),/changed/);
  assert.throws(()=>buildSourceRegistry(sources,{cloneBudget:{maxIndexEntries:0}}),
    error=>error.code==='SOURCE_CLONE_RESOURCE_EXHAUSTED'&&error.complete===false);
});

test('source registry can grow beyond the former inventory ceiling',()=>{
  const registry=buildSourceRegistry(Array.from({length:10001},(_,i)=>
    row('source-'+i,'function f(x){return x+1;}')));
  assert.equal(registry.sources.length,10001);
  assert.equal(registry.components.length,1);
  assert.equal(verifySourceRegistry(registry).valid,true);
});
