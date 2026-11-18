import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSourceRegistry,canonicalHash} from '../src/corpus/source-registry.mjs';
import {auditSourceSplitStress,sourceStressVariants} from '../src/corpus/source-split-stress.mjs';

function registry(){return buildSourceRegistry([
  {id:'short',family:'short',source:'function f(a){return a+1;}'},
  {id:'heldout',family:'heldout',source:'function max(xs){let n=xs[0];for(let i=1;i<xs.length;i++){if(xs[i]>n)n=xs[i];}return n;}',project:'external-benchmark'},
  {id:'composed',family:'composed',source:'function compose(a,b){return a*b+a;}',composition:'multiply-add'}
],{holdoutProjects:['external-benchmark'],holdoutCompositions:['multiply-add']});}

test('stress audit exposes short-wrapper heuristic misses while preserving known ancestry',()=>{
  const input=registry(),digest=canonicalHash(input);
  const report=auditSourceSplitStress(input,{maxSources:3,maxComponentShare:1,benchmarkFamilies:['heldout']});
  assert.equal(report.counts.checked,15);
  assert.equal(report.counts.explicitLineageFailures,0);
  assert(report.heuristicMisses.some(row=>row.sourceId==='short'&&row.kind==='function-wrapper'));
  assert(report.probes.filter(row=>['leading-comment','identifier-token-renaming','numeric-literal-variation'].includes(row.kind))
    .every(row=>row.heuristicGrouped));
  assert(report.holdouts.every(row=>row.split==='test'));
  assert.equal(report.benchmarkExclusions.rows[0].status,'excluded-from-training');
  assert(Object.values(report.hardGates).every(Boolean));
  assert.equal(report.status,'review_required');
  assert.equal(canonicalHash(input),digest);
});

test('bounded audit keeps omitted source denominators and undeclared benchmark coverage explicit',()=>{
  const report=auditSourceSplitStress(registry(),{maxSources:1,maxComponentShare:.2});
  assert.equal(report.counts.registrySources,3);assert.equal(report.counts.auditedSources,1);
  assert.equal(report.counts.unauditedSources,2);assert(report.giantComponents.length>0);
  assert.equal(report.benchmarkExclusions.status,'not-declared');
  assert.equal(report.originalRegistryModified,false);assert.equal(report.admitted,0);
});

test('benchmark declarations fail closed on missing or training relatives',()=>{
  const input=registry();
  const missing=auditSourceSplitStress(input,{maxSources:1,benchmarkFamilies:['absent']});
  assert.equal(missing.status,'failed');assert.equal(missing.hardGates.declaredBenchmarkExclusions,false);
  // Find a deterministic frozen seed with a training source. No split is edited.
  let training;
  for(let seed=0;seed<100&&!training;seed++){
    const candidate=buildSourceRegistry([{id:'benchmark',family:'benchmark',source:'function f(x){return x+1;}'}],{seed});
    if(candidate.components[0].split==='train')training=candidate;
  }
  assert(training);
  const leaked=auditSourceSplitStress(training,{benchmarkFamilies:['benchmark']});
  assert.equal(leaked.status,'failed');assert.equal(leaked.benchmarkExclusions.rows[0].status,'training-or-validation-leak');
});

test('token stress leaves string/regexp/template data intact and rejects corrupted frozen registries',()=>{
  const code='function f(n){return "n+1"+`n=${n}`+/n/.test("n")+n+1;}';
  const variants=sourceStressVariants(code);
  const renamed=variants.find(row=>row.kind==='identifier-token-renaming').source;
  assert(renamed.includes('"n+1"'));assert(renamed.includes('`n=${'));assert(renamed.includes('/n/'));
  const input=registry();input.components[0].split='edited';
  assert.throws(()=>auditSourceSplitStress(input),/Frozen source registry changed/);
  assert.throws(()=>auditSourceSplitStress(registry(),{maxSources:0}),/Invalid source stress audit/);
});
