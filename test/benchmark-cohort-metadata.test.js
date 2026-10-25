import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBenchmarkCohortMetadata} from '../src/training/benchmark-cohort-metadata.js';

const manifest={recipe:{name:'benchmark-v1',algorithms:[
  {name:'gcd',family:'semantic-benchmark-v1:gcd',ancestor:'source-algorithm-v1:gcd',split:'test',normalizedAstDigest:'a'.repeat(64)},
  {name:'array-sum',family:'semantic-benchmark-v1:array-sum',ancestor:'source-algorithm-v1:array-sum',split:'test',normalizedAstDigest:'b'.repeat(64)}]},
  cases:[{family:'semantic-benchmark-v1:gcd',role:'common-support'},
    {family:'semantic-benchmark-v1:gcd',role:'effectful'},
    {family:'semantic-benchmark-v1:array-sum',role:'common-support'}]};
const declaration={name:'effectful-tracks-events',cases:[
  {id:'case-1',family:'semantic-benchmark-v1:gcd'}]};

test('benchmark sidecar binds selected known families and role lineage without changing declaration',()=>{
  const metadata=buildBenchmarkCohortMetadata(manifest,declaration,['semantic-benchmark-v1:gcd']);
  assert.equal(metadata.schema,'semantic-benchmark-cohort-metadata/1');
  assert.equal(metadata.families.length,1);
  assert.deepEqual(metadata.families[0],{family:'semantic-benchmark-v1:gcd',algorithm:'gcd',
    sourceAncestor:'source-algorithm-v1:gcd',split:'test',roles:['common-support','effectful'],
    normalizedAstDigest:'a'.repeat(64)});
  assert.match(metadata.sourceManifestDigest,/^[0-9a-f]{64}$/);
  assert.match(metadata.declarationDigest,/^[0-9a-f]{64}$/);
});

test('benchmark sidecar refuses duplicate, unknown, or malformed ancestry',()=>{
  assert.throws(()=>buildBenchmarkCohortMetadata(manifest,declaration,
    ['semantic-benchmark-v1:gcd','semantic-benchmark-v1:gcd']),/unknown or repeated/);
  assert.throws(()=>buildBenchmarkCohortMetadata(manifest,declaration,['invented']),/unknown or repeated/);
  const broken=structuredClone(manifest);broken.recipe.algorithms[0].normalizedAstDigest='bad';
  assert.throws(()=>buildBenchmarkCohortMetadata(broken,declaration,['semantic-benchmark-v1:gcd']),/lineage/);
});
