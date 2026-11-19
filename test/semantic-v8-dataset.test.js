import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRegionFamilyRegistry,deriveRegionCoreIdentity,regionSplitIdentity,
  verifyRegionFamilyRegistry,verifyRegionSplitIdentity,validateRegionFamilyAssignments,
  REGION_FAMILY_REGISTRY_SCHEMA} from '../src/semantic/family-registry-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const affine='"use strict";function run(x){const y=x+1;return y*2;}';
const alias='"use strict";function run(value){let next=value+1;return next*2;}';
const detailA='"use strict";function run(o){o.x=1;return o;}';
const detailB='"use strict";function run(o){o.y=2;return o;}';
const row=(id,family,source,ancestors=[])=>({id,family,source,entry:'run',ancestors});
const resign=registry=>{const {digest,...body}=registry;registry.digest=hashAlgorithmData(body);return registry;};

test('v8 source, /2 core and declared ancestry edges are frozen together before holdout',()=>{
  assert.equal(deriveRegionCoreIdentity(affine,'run').coreDigest,deriveRegionCoreIdentity(alias,'run').coreDigest);
  const sources=[row('a','first',affine),row('b','second',alias,['ancestor']),
    row('c','third',alias),row('d','ancestor',detailA)];
  const registry=buildRegionFamilyRegistry(sources,{seed:71,families:['first']});
  assert.equal(registry.schema,REGION_FAMILY_REGISTRY_SCHEMA);
  assert.equal(registry.components.length,1);
  assert.deepEqual(registry.components[0].members,['ancestor','first','second','third']);
  assert.equal(registry.components[0].split,'test');
  assert.deepEqual(buildRegionFamilyRegistry([...sources].reverse(),{seed:71,families:['first']}),registry);
  assert.equal(verifyRegionFamilyRegistry(registry).valid,true);
  const assignments=sources.map(source=>({...source,split:'test',splitIdentity:regionSplitIdentity(registry,source)}));
  assert.equal(validateRegionFamilyAssignments(registry,assignments,{expectedSplit:'test'}).valid,true);
  for(const source of sources)assert.equal(verifyRegionSplitIdentity(regionSplitIdentity(registry,source),source).valid,true);
});

test('unrelated detailed and refused sources never share a synthetic null-core component',()=>{
  const sources=[row('a','write-x',detailA),row('b','write-y',detailB),
    row('c','malformed','"use strict";function run( {')];
  const registry=buildRegionFamilyRegistry(sources,{seed:13});
  assert.equal(registry.components.length,3);
  assert.deepEqual(registry.sources.map(source=>source.coreDigest),[null,null,null]);
  assert.deepEqual(registry.sources.map(source=>source.coreStatus),['detailed','detailed','source-refused']);
  assert.equal(registry.diagnostics.withoutNormalizedCore,3);
  assert.throws(()=>buildRegionFamilyRegistry([row('pure','affine',affine)].map(x=>({...x,coreDigest:null})),{seed:13}),/source-derived/);
});

test('rehashing cannot relabel a frozen member, change a component, substitute v7 or erase a holdout',()=>{
  const source=row('a','held-out',affine,['original']);
  const registry=buildRegionFamilyRegistry([source],{seed:7,families:['original']});
  const identity=regionSplitIdentity(registry,source);
  const altered=structuredClone(identity);altered.split='train';
  assert.throws(()=>verifyRegionSplitIdentity(altered,source),/split assignment/);
  assert.throws(()=>verifyRegionSplitIdentity(identity,{...source,family:'rename'}),/relabeled/);
  assert.throws(()=>verifyRegionSplitIdentity(identity,{...source,ancestors:[]}),/changed source/);
  const forged=structuredClone(registry);forged.components[0].split='train';
  assert.throws(()=>verifyRegionFamilyRegistry(resign(forged)),/membership|split/);
  const missing=structuredClone(registry);missing.components[0].holdout=null;
  assert.throws(()=>verifyRegionFamilyRegistry(resign(missing)),/holdout/);
  const legacy=structuredClone(registry);legacy.schema='semantic-family-registry/1';
  assert.throws(()=>verifyRegionFamilyRegistry(resign(legacy)),/unsupported/);
  assert.throws(()=>validateRegionFamilyAssignments(registry,[{...source,split:'train'}]),/forged/);
  assert.throws(()=>buildRegionFamilyRegistry([source],{seed:7,coreDigests:['0'.repeat(64)]}),/unknown/);
});
