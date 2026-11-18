import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {trustedRealSourceCases} from '../src/corpus/trusted-source-candidates.mjs';
import {runGenerationProcess} from '../src/corpus/generation-process.mjs';
function directory(t){const path=mkdtempSync(join(tmpdir(),'real-source-bridge-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
test('rebuilds original/transform/source/license identity for each pinned real-source stream',()=>{
  const rows=trustedRealSourceCases({perFamily:1});
  assert.deepEqual(Object.fromEntries(['utilities','exercism','production'].map(stream=>
    [stream,rows.filter(row=>row.provenance.sourceStream===stream).length])),{utilities:78,exercism:20,production:7});
  assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
  assert.ok(rows.every(row=>row.trustTier==='trusted-owned-source'&&row.license&&row.provenance.notice));
  assert.ok(rows.every(row=>row.provenance.transformedSource===row.source&&row.originalReferenceSource));
  assert.ok(rows.every(row=>row.provenance.upstream.revision&&row.ancestorIds.length));
  for(const row of rows.filter(row=>row.provenance.sourceStream==='exercism')){
    const notice=row.provenance.canonicalNotice;
    assert.equal(notice.repository,row.provenance.canonical.repository);
    assert.equal(notice.revision,row.provenance.canonical.revision);
    assert.equal(notice.text,readFileSync(notice.path,'utf8'));
    assert.match(notice.sha256,/^[a-f0-9]{64}$/);
  }
});
test('refuses changed pinned utility bytes before executing any source',t=>{
  const root=directory(t),lock=JSON.parse(readFileSync('corpus/utility-source-lock.json','utf8'));
  mkdirSync(join(root,'corpus'),{recursive:true});
  writeFileSync(join(root,'corpus/utility-source-lock.json'),JSON.stringify(lock));
  const first=Object.keys(lock.files)[0],file=join(root,'corpus/upstream',first);
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'changed');
  assert.throws(()=>trustedRealSourceCases({root,streams:['utilities'],perFamily:1}),/Pinned utility source bytes changed/);
});
test('fresh source gate validates an original utility and rejects changed transformation behavior',async t=>{
  const fixture=trustedRealSourceCases({streams:['utilities'],perFamily:1})[0],outputDirectory=directory(t);
  const task={kind:'source',fixture,producerRevision:'a'.repeat(40)};
  const good=await runGenerationProcess(task,{outputDirectory,timeoutMs:30000});
  assert.equal(good.result.status,'locally_verified',good.result.reason);
  assert.equal(good.result.exported.sidecar.sourceProvenance.upstream.originalSourceCheck.status,'agreed');
  assert.notEqual(good.result.status,'admitted');
  const bad=await runGenerationProcess({...task,fixture:{...fixture,
    source:'"use strict";function '+fixture.entry+'(){return "wrong";}'}},{outputDirectory,timeoutMs:30000});
  assert.equal(bad.result.status,'original_source_mismatch');
  assert.ok(bad.result.failure.original&&bad.result.failure.transformed);
});
test('retains independently specified Exercism expected outcome as a separate gate',async t=>{
  const fixture=trustedRealSourceCases({streams:['exercism'],perFamily:1}).find(row=>row.family.endsWith(':leap'));
  const changed={...fixture,provenance:{...fixture.provenance,canonicalExpected:!fixture.provenance.canonicalExpected}};
  const run=await runGenerationProcess({kind:'source',fixture:changed,producerRevision:'a'.repeat(40)},
    {outputDirectory:directory(t),timeoutMs:30000});
  assert.equal(run.result.status,'canonical_mismatch',run.result.reason);
});

test('fresh original/transformed/owned gates agree on real numeric and optional-argument bindings',async t=>{
  const fixtures=trustedRealSourceCases({streams:['exercism'],perFamily:2}),outputDirectory=directory(t);
  for(const family of ['darts','grains','two-fer']){
    const fixture=fixtures.find(row=>row.family==='exercism/javascript:'+family);
    const run=await runGenerationProcess({kind:'source',fixture,producerRevision:'a'.repeat(40)},
      {outputDirectory,timeoutMs:30000});
    assert.equal(run.result.status,'locally_verified',family+': '+run.result.reason);
    const provenance=run.result.exported.sidecar.sourceProvenance.upstream;
    assert.equal(provenance.originalSourceCheck.status,'agreed');
    if(family==='two-fer'){
      assert.deepEqual(fixture.args,[]);assert.deepEqual(provenance.canonicalInput,{name:null});
    }
    if(family==='grains')assert.equal(provenance.canonicalExpectedBinding.decimal,'1');
  }
});

test('canonical error expectations require a throw and retain exact source error evidence',async t=>{
  const fixtures=trustedRealSourceCases({streams:['exercism'],perFamily:100}),outputDirectory=directory(t);
  const returnFixture=fixtures.find(row=>row.family==='exercism/javascript:leap');
  const changed={...returnFixture,provenance:{...returnFixture.provenance,canonicalExpected:{error:'error required'}}};
  const wrong=await runGenerationProcess({kind:'source',fixture:changed,producerRevision:'a'.repeat(40)},
    {outputDirectory,timeoutMs:30000});
  assert.equal(wrong.result.status,'canonical_mismatch');
  const fixture=fixtures.find(row=>row.family==='exercism/javascript:grains'&&row.provenance.canonicalExpected?.error);
  assert(fixture);
  const correct=await runGenerationProcess({kind:'source',fixture,producerRevision:'a'.repeat(40)},
    {outputDirectory,timeoutMs:30000});
  assert.equal(correct.result.status,'locally_verified',correct.result.reason);
  const check=correct.result.exported.sidecar.sourceProvenance.upstream.originalSourceCheck.canonicalExpectation;
  assert.equal(check.outcomeKind,'throw');assert.equal(check.canonicalErrorMessageCompared,false);
  assert.equal(correct.result.exported.sidecar.referenceStatus,'agreed');
});
