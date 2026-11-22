import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireTest262GitSnapshot,discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {buildTest262Catalog,bindTest262CatalogProfile,createTest262Campaign,recordTest262Stages} from '../src/conformance/test262-catalog.js';
import {ownedTest262Profile} from '../src/conformance/test262-runner.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {readTest262Json,writeTest262Json,createTest262CampaignReport,validateOriginalTest262Report,fingerprintTest262Implementation,
  runOriginalTest262Worker} from '../src/conformance/test262-campaign.js';

function syntheticSuite(){
  const directory=mkdtempSync(join(process.cwd(),'test262-campaign-'));
  const suiteRoot=join(directory,'suite');mkdirSync(suiteRoot);
  const git=args=>execFileSync('git',['-C',suiteRoot,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','--quiet']);
  const fixture=(body,metadata='')=>`/*---\ndescription: campaign qualification control\n${metadata}---*/\n${body}`;
  const files={
    ...Object.fromEntries(['assert.js','sta.js','doneprintHandle.js'].map(name=>['harness/'+name,
      readFileSync(new URL('../fixtures/test262-harness/'+name,import.meta.url),'utf8')])),
    'test/good.js':fixture('assert.sameValue(1,1);'),
    'test/fail.js':fixture('assert.sameValue(1,2);'),
    'test/async.js':fixture('Promise.resolve(1);','flags: [async]\n'),
    'test/raw.js':fixture('var raw=1;','flags: [raw]\n'),
    'test/module.js':fixture('import {value} from "./value_FIXTURE.js";assert.sameValue(value,42);','flags: [module]\n'),
    'test/value_FIXTURE.js':'export const value=42;',
    'test/negative.js':fixture('let = ;','flags: [noStrict]\nnegative:\n  phase: parse\n  type: SyntaxError\n')
  };
  for(const [path,bytes] of Object.entries(files)){
    mkdirSync(dirname(join(suiteRoot,path)),{recursive:true});writeFileSync(join(suiteRoot,path),bytes);
  }
  git(['add','.']);git(['-c','user.name=Campaign Control','-c','user.email=campaign@example.invalid','commit','--quiet','-m','Synthetic pinned suite']);
  const revision=git(['rev-parse','HEAD']);
  const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot,revision});
  const catalog=buildTest262Catalog({snapshot,sources,profile:ownedTest262Profile(),
    moduleDependencies:discoverTest262ModuleDependencies(sources)});
  const catalogPath=join(directory,'catalog.json');writeFileSync(catalogPath,JSON.stringify(catalog));
  return {directory,suiteRoot,sources,catalog,catalogPath};
}

test('campaign CLI retains the frozen full denominator while executing an explicit selected cohort',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'result.json.gz');
    execFileSync(process.execPath,['tools/run-test262-campaign.mjs','--catalog',suite.catalogPath,
      '--suite-root',suite.suiteRoot,'--paths','test/good.js','--out',out],{encoding:'utf8',timeout:30000});
    const report=readTest262Json(out);
    assert.equal(report.summary.catalogVariants,9);assert.equal(report.summary.selected,2);
    assert.equal(report.summary.stages.parseStatic.passed,2);
    assert.equal(report.summary.stages.ownedExecution.passed,2);
    assert.equal(report.summary.stages.independentReference.passed,2);
    assert.equal(report.summary.stages.nativeReplay.passed,0);
    assert.equal(report.summary.stages.parseStatic.not_selected,7);
    assert.deepEqual(report.profile.specification,readPinnedEcma262Specification().specification);
    assert(report.campaign.rows.filter(row=>!row.selected).every(row=>Object.values(row.stages).every(stage=>stage.status==='not_selected')));
    assert.equal(validateOriginalTest262Report(report,{baseCatalog:suite.catalog,
      implementation:report.campaign.implementation}).valid,true);
    const forged=structuredClone(report);forged.summary.stages.nativeReplay.passed=8;
    assert.throws(()=>validateOriginalTest262Report(forged,{baseCatalog:suite.catalog,
      implementation:report.campaign.implementation}),/summary or admission claims/);
    const stale=structuredClone(report.campaign.implementation);stale.runnerDigest='0'.repeat(64);
    assert.throws(()=>validateOriginalTest262Report(report,{baseCatalog:suite.catalog,implementation:stale}),/Incompatible/);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('campaign CLI sends the complete frozen module dependency closure to its reference worker',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'module-result.json');
    execFileSync(process.execPath,['tools/run-test262-campaign.mjs','--catalog',suite.catalogPath,
      '--suite-root',suite.suiteRoot,'--paths','test/module.js','--stages','parse,reference','--out',out],
    {encoding:'utf8',timeout:30000});
    const report=readTest262Json(out);
    assert.equal(report.summary.catalogVariants,9);
    assert.equal(report.summary.selected,1);
    assert.equal(report.summary.stages.independentReference.passed,1);
    assert.equal(report.summary.stages.independentReference.environment_unavailable,0);
    assert.equal(report.campaign.rows.find(row=>row.path==='test/module.js').stages.ownedExecution.status,'not_run');
    assert.equal(report.claims.fullEditionConformance,false);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('disposable worker deadlines and source drift stay failures in their own authority',async()=>{
  const suite=syntheticSuite();
  try{
    const implementation=fingerprintTest262Implementation();
    const profile=ownedTest262Profile(),catalog=bindTest262CatalogProfile(suite.catalog,profile);
    const variant=catalog.variants.find(row=>row.path==='test/good.js');
    const options={variant,profile,suiteRevision:catalog.suiteRevision,
      sources:Object.fromEntries(Object.entries(suite.sources).map(([path,bytes])=>[path,bytes.toString('utf8')]))};
    const timed=await runOriginalTest262Worker({authority:'owned',options,implementation,wallTimeoutMs:10});
    assert.equal(timed.status,'resource_limited');assert.equal(timed.phase,'worker');
    const stale=structuredClone(implementation);stale.files[0].sha256='0'.repeat(64);
    const drift=await runOriginalTest262Worker({authority:'reference',options,implementation:stale});
    assert.equal(drift.status,'infrastructure_error');assert.match(drift.reason,/implementation file identity/);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('resuming a completed campaign preserves all original successes and failures without rerunning',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'result.json.gz');
    const args=['tools/run-test262-campaign.mjs','--catalog',suite.catalogPath,
      '--suite-root',suite.suiteRoot,'--paths','test/good.js,test/fail.js','--out',out];
    execFileSync(process.execPath,args,{timeout:30000});
    const before=readTest262Json(out);
    execFileSync(process.execPath,[...args,'--resume',out],{timeout:30000});
    const after=readTest262Json(out);
    assert.deepEqual(after,before);
    assert.equal(after.summary.stages.ownedExecution.failed,2);
    assert.equal(after.summary.stages.independentReference.failed,2);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('an interrupted campaign resumes only missing stages and explicit retries retain old failures',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'result.json.gz');
    const args=['tools/run-test262-campaign.mjs','--catalog',suite.catalogPath,
      '--suite-root',suite.suiteRoot,'--paths','test/good.js,test/fail.js','--jobs','1','--out',out];
    execFileSync(process.execPath,args,{timeout:30000});
    const complete=readTest262Json(out);
    const {catalog}=validateOriginalTest262Report(complete,{baseCatalog:suite.catalog,
      implementation:complete.campaign.implementation});
    let interrupted=createTest262Campaign({catalog,implementation:complete.campaign.implementation,
      selectedIds:complete.campaign.selectedIds});
    const attempts=complete.campaign.rows.flatMap(row=>row.attempts.filter(attempt=>
      !(row.path==='test/good.js'&&attempt.stage==='independentReference')).map(attempt=>({
        caseId:row.id,stage:attempt.stage,status:attempt.status,reason:attempt.reason,evidence:attempt.evidence})));
    interrupted=recordTest262Stages(interrupted,attempts);
    writeTest262Json(out,createTest262CampaignReport({baseCatalog:suite.catalog,catalog,campaign:interrupted,
      runPolicy:complete.runPolicy}));
    execFileSync(process.execPath,[...args,'--resume',out],{timeout:30000});
    const resumed=readTest262Json(out);
    assert.deepEqual(resumed,complete);
    execFileSync(process.execPath,[...args,'--resume',out,'--retry','failed'],{timeout:30000});
    const retried=readTest262Json(out);
    const good=report=>report.campaign.rows.filter(row=>row.path==='test/good.js');
    assert.deepEqual(good(retried),good(complete));
    for(const row of retried.campaign.rows.filter(row=>row.path==='test/fail.js')){
      assert.equal(row.attempts.length,5);
      assert.deepEqual(row.attempts.slice(0,3),complete.campaign.rows.find(prior=>prior.id===row.id).attempts);
      assert.equal(row.stages.ownedExecution.status,'failed');
      assert.equal(row.stages.independentReference.status,'failed');
    }
    assert.equal(validateOriginalTest262Report(retried,{baseCatalog:suite.catalog,
      implementation:retried.campaign.implementation}).valid,true);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('partial selection typos and incompatible retries fail before overwriting retained evidence',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'result.json');
    writeFileSync(out,'retained');
    const args=['tools/run-test262-campaign.mjs','--catalog',suite.catalogPath,
      '--suite-root',suite.suiteRoot,'--out',out];
    assert.throws(()=>execFileSync(process.execPath,[...args,'--paths','test/good.js,test/typo.js'],
      {stdio:'pipe',timeout:30000}),/path with no frozen variants/);
    assert.throws(()=>execFileSync(process.execPath,[...args,'--paths','test/good.js','--retry','failed'],
      {stdio:'pipe',timeout:30000}),/requires --resume/);
    assert.equal(readFileSync(out,'utf8'),'retained');
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});
