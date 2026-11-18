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
test('canonical error expectations require thrown completion and declare message comparison scope',async t=>{
  const outputDirectory=directory(t),source='"use strict";function run(){throw new Error("Pinned JS message");}';
  const fixture={id:'canonical-error',family:'canonical-error',entry:'run',source,originalReferenceSource:source,
    args:[],fixture:{calls:[]},license:'MIT',trustTier:'trusted-owned-source',
    provenance:{inputOrigin:'upstream-canonical',canonicalExpected:{error:'Language-neutral error description'}}};
  const run=await runGenerationProcess({kind:'source',fixture,producerRevision:'a'.repeat(40)},
    {outputDirectory,timeoutMs:30000});
  assert.equal(run.result.status,'locally_verified',run.result.reason);
  assert.deepEqual(run.result.exported.sidecar.sourceProvenance.upstream.canonicalCheck,
    {status:'agreed',mode:'error-completion-only',expectedKind:'throw',observedKind:'throw'});
  const returning='"use strict";function run(){return 7;}';
  const wrong=await runGenerationProcess({kind:'source',fixture:{...fixture,source:returning,
    originalReferenceSource:returning},producerRevision:'a'.repeat(40)},{outputDirectory,timeoutMs:30000});
  assert.equal(wrong.result.status,'canonical_mismatch');
  assert.equal(wrong.result.failure.canonicalCheck.observedKind,'return');
});
