import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {acquireTest262GitSnapshot,discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {buildTest262Catalog,bindTest262CatalogProfile,createTest262Campaign,recordTest262Stages} from '../src/conformance/test262-catalog.js';
import {ownedTest262Profile} from '../src/conformance/test262-runner.js';
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
    assert.equal(report.profile.specification,null);
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
      {stdio:'pipe',timeout:30000}),/path with no catalog variants/);
    assert.throws(()=>execFileSync(process.execPath,[...args,'--paths','test/good.js','--retry','failed'],
      {stdio:'pipe',timeout:30000}),/requires --resume/);
    assert.equal(readFileSync(out,'utf8'),'retained');
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('default campaigns acquire the current complete checkout and preserve earlier observations after growth',()=>{
  const suite=syntheticSuite();
  try{
    const out=join(suite.directory,'current.json.gz');
    const args=['tools/run-test262-campaign.mjs','--suite-root',suite.suiteRoot,'--stages','parse','--out',out];
    execFileSync(process.execPath,args,{timeout:30000});
    const before=readTest262Json(out),retained=readFileSync(out);
    assert.equal(before.summary.catalogVariants,9);assert.equal(before.summary.selected,9);
    assert.equal(before.profile.specification,null);
    assert.equal(before.runPolicy.selection.all,true);
    assert.equal(validateOriginalTest262Report(before).valid,true);
    execFileSync(process.execPath,['tools/run-test262-campaign.mjs','--check',out],{timeout:30000});
    writeFileSync(join(suite.suiteRoot,'test/new.js'),'/*---\ndescription: newly acquired source\n---*/\nvar added=1;');
    execFileSync('git',['-C',suite.suiteRoot,'add','test/new.js']);
    execFileSync('git',['-C',suite.suiteRoot,'-c','user.name=Campaign Control','-c','user.email=campaign@example.invalid',
      'commit','--quiet','-m','Grow the input inventory']);
    assert.throws(()=>execFileSync(process.execPath,[...args,'--resume',out],{stdio:'pipe',timeout:30000}),/HEAD differs/);
    assert.deepEqual(readFileSync(out),retained);
    const next=join(suite.directory,'grown.json.gz');
    execFileSync(process.execPath,[...args.slice(0,-1),next],{timeout:30000});
    const after=readTest262Json(next);
    assert.equal(after.summary.catalogVariants,11);assert.equal(after.summary.selected,11);
    assert.notEqual(after.baseCatalog.suiteRevision,before.baseCatalog.suiteRevision);
    assert.deepEqual(readFileSync(out),retained);
    assert.equal(validateOriginalTest262Report(before).valid,true);
    const forged=structuredClone(after);forged.baseCatalog=before.baseCatalog;
    assert.throws(()=>validateOriginalTest262Report(forged),/frozen inventory/);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('worker cancellation distinguishes unknown execution from an unstarted dispatch',async()=>{
  const suite=syntheticSuite();
  try{
    const implementation=fingerprintTest262Implementation();
    const profile=ownedTest262Profile(),catalog=bindTest262CatalogProfile(suite.catalog,profile);
    const variant=catalog.variants.find(row=>row.path==='test/good.js');
    const options={variant,profile,suiteRevision:catalog.suiteRevision,
      sources:Object.fromEntries(Object.entries(suite.sources).map(([path,bytes])=>[path,bytes.toString('utf8')]))};
    const controller=new AbortController();controller.abort();
    const cancelled=await runOriginalTest262Worker({authority:'reference',options,implementation,signal:controller.signal});
    assert.equal(cancelled.status,'interrupted');assert.equal(cancelled.executionPerformed,false);
    assert.equal(cancelled.worker.started,false);
    const active=new AbortController();
    const pending=runOriginalTest262Worker({authority:'owned',options,implementation,signal:active.signal});
    const timer=setTimeout(()=>active.abort(),25);
    const interrupted=await pending;clearTimeout(timer);
    assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.executionPerformed,null);
    assert.equal(interrupted.worker.started,true);
    assert.equal(interrupted.worker.command[0],process.execPath);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});

test('SIGTERM checkpoints interrupted workers and unrun cases, and resume retries only unfinished work',async()=>{
  const suite=syntheticSuite();
  try{
    writeFileSync(join(suite.suiteRoot,'test/000-infinite.js'),'/*---\nflags: [noStrict]\n---*/\nwhile(true){}');
    execFileSync('git',['-C',suite.suiteRoot,'add','test/000-infinite.js']);
    execFileSync('git',['-C',suite.suiteRoot,'-c','user.name=Campaign Control','-c','user.email=campaign@example.invalid',
      'commit','--quiet','-m','Add interruption control']);
    const out=join(suite.directory,'interrupt.json');
    const args=['tools/run-test262-campaign.mjs','--suite-root',suite.suiteRoot,'--out',out,
      '--paths','test/000-infinite.js,test/good.js','--stages','parse,reference','--jobs','1','--reference-timeout-ms','1000'];
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',sent=false,timer;
    child.stderr.on('data',data=>{stderr+=data;});
    child.stdout.on('data',data=>{
      stdout+=data;
      if(!sent&&stdout.includes('"phase":"parse"')){sent=true;timer=setTimeout(()=>child.kill('SIGTERM'),100);}
    });
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    clearTimeout(timer);
    assert.equal(code,143,stderr);assert.equal(sent,true);
    const interrupted=readTest262Json(out);
    assert.equal(interrupted.summary.stages.independentReference.interrupted,1);
    assert.equal(interrupted.summary.stages.independentReference.not_run,2);
    const row=interrupted.campaign.rows.find(row=>row.path==='test/000-infinite.js');
    assert.equal(row.attempts.at(-1).evidence.executionPerformed,null);
    execFileSync(process.execPath,[...args,'--resume',out],{timeout:30000});
    const resumed=readTest262Json(out);
    assert.equal(resumed.summary.stages.independentReference.interrupted,0);
    assert.equal(resumed.summary.stages.independentReference.resource_limited,1);
    assert.equal(resumed.summary.stages.independentReference.passed,2);
    assert.deepEqual(resumed.campaign.rows.find(next=>next.id===row.id).attempts.slice(0,2),row.attempts);
    assert.equal(validateOriginalTest262Report(resumed).valid,true);
  }finally{rmSync(suite.directory,{recursive:true,force:true});}
});
