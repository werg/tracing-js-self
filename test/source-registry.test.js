import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSourceRegistry,frozenSplitIdentity,verifyFrozenSplitIdentity,
  verifySourceRegistry,balanceFamilyTokens,canonicalHash} from '../src/corpus/source-registry.mjs';

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
