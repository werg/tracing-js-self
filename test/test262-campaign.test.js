import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireTest262GitSnapshot} from '../src/conformance/test262-acquisition.js';
import {buildTest262Catalog,bindTest262CatalogProfile} from '../src/conformance/test262-catalog.js';
import {ownedTest262Profile} from '../src/conformance/test262-runner.js';
import {readTest262Json,validateOriginalTest262Report,fingerprintTest262Implementation,
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
    'test/negative.js':fixture('let = ;','flags: [noStrict]\nnegative:\n  phase: parse\n  type: SyntaxError\n')
  };
  for(const [path,bytes] of Object.entries(files)){
    mkdirSync(dirname(join(suiteRoot,path)),{recursive:true});writeFileSync(join(suiteRoot,path),bytes);
  }
  git(['add','.']);git(['-c','user.name=Campaign Control','-c','user.email=campaign@example.invalid','commit','--quiet','-m','Synthetic pinned suite']);
  const revision=git(['rev-parse','HEAD']);
  const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot,revision});
  const catalog=buildTest262Catalog({snapshot,sources,profile:ownedTest262Profile()});
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
    assert.equal(report.summary.catalogVariants,8);assert.equal(report.summary.selected,2);
    assert.equal(report.summary.stages.parseStatic.passed,2);
    assert.equal(report.summary.stages.ownedExecution.passed,2);
    assert.equal(report.summary.stages.independentReference.passed,2);
    assert.equal(report.summary.stages.nativeReplay.passed,0);
    assert.equal(report.summary.stages.parseStatic.not_selected,6);
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
