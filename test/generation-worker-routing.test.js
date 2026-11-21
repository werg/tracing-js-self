import test from 'node:test';
import assert from 'node:assert/strict';
import {access,cp,mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {LEGACY_V8_CLIENT_FILES} from '../src/corpus/installed-v8-qualification.mjs';
import {regionQualificationPopulation,moduleQualificationFixtures} from '../fixtures/semantic-regions/qualification.js';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const producerRevision='a'.repeat(40);
const simple={id:'worker-route',family:'worker-route',source:'"use strict";function run(x){return x+1;}',
  entry:'run',args:[1],fixture:{calls:[]}};

test('ordinary generation workers execute V8 source authority and modules with legacy clients physically absent',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'generation-worker-routing-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runtime=join(directory,'runtime'),outputDirectory=join(directory,'output');
  await mkdir(runtime);
  // Copy the real worker and its runtime. Physical removal also constrains its
  // child reference processes, whose scrubbed environments omit Node loaders.
  for(const name of ['src','tools','contracts','catalog','package.json','npm-shrinkwrap.json'])
    await cp(join(root,name),join(runtime,name),{recursive:true});
  await mkdir(join(runtime,'node_modules'));
  for(const name of ['acorn','typescript'])
    await symlink(dirname(require.resolve(name+'/package.json')),join(runtime,'node_modules',name),'dir');
  const {runGenerationProcess}=await import(pathToFileURL(join(runtime,'src/corpus/generation-process.mjs')));
  const run=(fixture,{kind='source',traceVersion=8}={})=>runGenerationProcess(
    {kind,traceVersion,producerRevision,fixture},
    {outputDirectory,timeoutMs:60000,maxOutputBytes:16*1024*1024});

  await t.test('retained V6/V7 source routes and V6 session route keep their requested wire',async()=>{
    for(const traceVersion of [6,7]){
      const {result}=await run(simple,{traceVersion});
      assert.equal(result.status,'locally_verified',result.reason);
      assert.equal(result.exported.public.schema,'semantic-execution/'+traceVersion);
      assert.equal(result.exported.sidecar.referenceStatus,'agreed');
    }
    const {result}=await run({id:'session',family:'worker-route-session',cases:[simple,
      {...simple,id:'second',args:[3]}]},{kind:'session',traceVersion:6});
    assert.equal(result.status,'locally_verified',result.reason);
    assert.equal(result.exported.public.schema,'semantic-execution/6');
    assert.equal(result.exported.sidecar.collection.components.length,2);
  });

  for(const name of LEGACY_V8_CLIENT_FILES){
    await rm(join(runtime,name));
    await assert.rejects(access(join(runtime,name)),error=>error.code==='ENOENT');
  }
  t.diagnostic('Removed '+LEGACY_V8_CLIENT_FILES.length+' legacy clients from the worker and reference-process runtime.');

  const utility=regionQualificationPopulation({population:'all',allInputs:true}).scripts.find(
    row=>row.id==='real-utilities-2f6c1482ea2016ced3fa31f1');
  assert(utility,'The pinned original utility remains in the original population');
  assert.notEqual(utility.source,utility.originalReferenceSource);
  await t.test('pinned transformed utility retains independent original-source authority',async()=>{
    const {result,peakRssBytes}=await run(utility);
    assert.equal(result.status,'detailed-fallback',result.reason);
    assert.equal(result.exported.public.schema,'semantic-execution/8');
    assert.equal(result.exported.sidecar.referenceStatus,'agreed');
    const check=result.exported.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.originalSourceCheck;
    assert.equal(check.status,'agreed');
    assert.equal(check.originalReferenceDigest,check.transformedReferenceDigest);
    assert.equal(result.exported.sidecar.nativeAdmission,null);
    assert(peakRssBytes>0);
  });
  await t.test('changed transformation still refuses before owned projection',async()=>{
    const {result}=await run({...utility,source:'"use strict";function '+utility.entry+'(){return "wrong";}'});
    assert.equal(result.status,'original_source_mismatch',result.reason);
    assert(!result.exported);
    assert.notDeepEqual(result.failure.original,result.failure.transformed);
  });
  await t.test('canonical expected value stays an independent gate when source observations agree',async()=>{
    const source='"use strict";function run(){return 7;}',fixture={...simple,args:[],source,
      originalReferenceSource:source,provenance:{inputOrigin:'upstream-canonical',canonicalExpected:9}};
    const {result}=await run(fixture);
    assert.equal(result.status,'canonical_mismatch',result.reason);assert(!result.exported);
    assert.deepEqual(result.failure.canonicalCheck,
      {status:'disagreed',mode:'exact-return-value',expectedKind:'return',observedKind:'return'});
    const good=await run({...fixture,provenance:{...fixture.provenance,canonicalExpected:7}});
    assert.equal(good.result.status,'locally_verified',good.result.reason);
    assert.equal(good.result.exported.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.originalSourceCheck.canonicalExpectation.status,'agreed');
  });
  await t.test('original ESM graph reaches independent module source verification',async()=>{
    const fixture=moduleQualificationFixtures().find(row=>row.id==='module-scoped-var-isolation');
    const {result}=await run(fixture,{kind:'module'});
    assert.equal(result.status,'locally_verified',result.reason);
    assert.equal(result.exported.public.schema,'semantic-execution/8');
    assert.equal(result.exported.sidecar.referenceStatus,'agreed');
    assert.equal(result.exported.sidecar.nativeAdmission,null);
    assert.equal(result.moduleReference,'passed');
    assert.equal(result.moduleCorrespondence,'passed');
    assert.deepEqual(result.exported.sidecar.sourceArtifact.sidecar.sourceProvenance.upstream.moduleEvidence.request.modules,
      fixture.modules);
  });
  await t.test('unsupported versioned sessions refuse without falling back to a removed V6 client',async()=>{
    for(const traceVersion of [7,8]){
      const {result}=await run({id:'session',family:'worker-route-session',cases:[simple,simple]},
        {kind:'session',traceVersion});
      assert.equal(result.status,'collection_failed');assert(!result.exported);
      assert.equal(result.reason,'Generation sessions require trace version 6');
    }
  });
});
