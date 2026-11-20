import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {gitBlobSha} from '../src/test262-baseline.js';
import {buildTest262Catalog,parseTest262Header,test262VariantModes,createTest262Campaign,
  recordTest262Stage,recordTest262Stages,bindTest262CatalogProfile,summarizeTest262Campaign,validateTest262Campaign,validateTest262Catalog,
  conformanceDigest,CONFORMANCE_STAGES} from '../src/conformance/test262-catalog.js';

const fixture=(body='',metadata='')=>`/*---\ndescription: synthetic runner control\n${metadata}---*/\n${body}`;
const profile={name:'synthetic-runner-controls',edition:'ECMAScript 2026',specification:null,
  parser:{name:'bounded-pratt',version:'2'},hostProfile:{name:'single-agent-test'},
  resourcePolicy:{maxSteps:20000,maxSourceBytes:1048576}};
const implementation={producerRevision:'a'.repeat(40),codeDigest:'b'.repeat(64),runnerDigest:'c'.repeat(64)};
const make=(sources,more={})=>buildTest262Catalog({sources,profile,
  snapshot:{repository:'tc39/test262',revision:'d'.repeat(40),files:Object.fromEntries(
    Object.entries(sources).map(([path,source])=>[path,gitBlobSha(source)]))},...more});

test('metadata interprets both list spellings and preserves negative phase/type',()=>{
  const metadata=parseTest262Header(fixture('throw 7;',
    'flags:\n  - onlyStrict\n  - async\nfeatures: [Promise, "BigInt"]\nincludes:\n  - propertyHelper.js\nnegative:\n  phase: runtime\n  type: TypeError\n'));
  assert.deepEqual(metadata,{flags:['onlyStrict','async'],features:['Promise','BigInt'],
    includes:['propertyHelper.js'],negative:{phase:'runtime',type:'TypeError'}});
  assert.deepEqual(test262VariantModes(metadata),['strict']);
  assert.deepEqual(test262VariantModes(parseTest262Header(fixture())),['sloppy','strict']);
  assert.deepEqual(test262VariantModes(parseTest262Header(fixture('','flags: [raw]\n'))),['raw']);
  assert.deepEqual(test262VariantModes(parseTest262Header(fixture('','flags: [module]\n'))),['module']);
  assert.deepEqual(test262VariantModes(parseTest262Header(fixture('','flags: [module, raw]\n'))),['module']);
  assert.deepEqual(parseTest262Header(fixture('','includes: [sm/helper.js]\n')).includes,['sm/helper.js']);
  assert.equal(parseTest262Header(fixture('',' description: indented\n').replace(/\n/g,'\r')).flags.length,0);
});

test('ambiguous metadata cannot silently change mode or error expectations',()=>{
  for(const metadata of [
    'flags: [onlyStrict, noStrict]\n','flags: [module, noStrict]\n',
    'flags: [async, async]\n','flags: [unknown]\n','flags: []\nflags: []\n',
    'flags: [noStrict]\n  - async\n','flags: [raw]\nincludes: [assert.js]\n',
    'includes: [../unsafe.js]\n','negative:\n  phase: runtime\n',
    'negative:\n  phase: runtime\n  type: TypeError\n  type: SyntaxError\n',
    'negative:\n  phase: resolution\n  type: SyntaxError\n'
  ])assert.throws(()=>parseTest262Header(fixture('',metadata)),TypeError,metadata);
  assert.throws(()=>parseTest262Header(fixture()+fixture()),/exactly one/);
});

test('a frozen catalog includes all test modes but not standalone fixtures',()=>{
  const catalog=make({
    'test/plain.js':fixture('assert.sameValue(1,1);'),
    'test/strict.js':fixture('','flags: [onlyStrict]\n'),
    'test/raw.js':fixture('','flags: [raw]\n'),
    'test/await.js':fixture('','flags: [async, noStrict]\n'),
    'test/dependency_FIXTURE.js':'export const value=1;',
    'harness/sta.js':'function Test262Error(){}',
    'harness/assert.js':'function assert(){}'
  });
  assert.equal(catalog.summary.discoveredFiles,7);
  assert.equal(catalog.summary.testFiles,4);
  assert.equal(catalog.summary.fixtureFiles,1);
  assert.equal(catalog.summary.knownVariants,5);
  assert.deepEqual(catalog.summary.missingHarnessFiles,['harness/doneprintHandle.js']);
  assert.equal(catalog.summary.specificationPinned,false);
  assert.equal(catalog.claims.ownedConformance,false);
  assert.equal(catalog.variants.find(row=>row.mode==='raw').harness.length,0);
  assert(catalog.variants.every(row=>row.classification.membership==='unclassified'));
  assert.equal(validateTest262Catalog(catalog),true);
  assert(Object.isFrozen(catalog.variants[0].metadata));
});

test('invalid metadata remains in the file population with an unresolved variant',()=>{
  const catalog=make({'test/bad.js':fixture('','flags: [noStrict, onlyStrict]\n')});
  assert.equal(catalog.summary.testFiles,1);
  assert.equal(catalog.summary.knownVariants,0);
  assert.equal(catalog.summary.unresolvedMetadataFiles,1);
  assert.equal(catalog.summary.variantPopulationComplete,false);
  assert.equal(catalog.variants[0].mode,'unclassified');
  assert.match(catalog.variants[0].metadataError,/Conflicting/);
});

test('source, harness, profile and graph changes invalidate variant identities',()=>{
  const sources={'test/main.js':fixture('import "./dep_FIXTURE.js";','flags: [module]\n'),
    'test/dep_FIXTURE.js':'export const value=1;','harness/sta.js':'var helper=1;',
    'harness/assert.js':'function assert(){}'};
  const deps={'test/main.js':['test/dep_FIXTURE.js'],'test/dep_FIXTURE.js':[]};
  const catalog=make(sources,{moduleDependencies:deps});
  assert.equal(catalog.variants[0].dependencies.status,'complete');
  assert.equal(catalog.variants[0].dependencies.files.length,2);
  for(const changed of [
    make({...sources,'test/dep_FIXTURE.js':'export const value=2;'},{moduleDependencies:deps}),
    make({...sources,'harness/assert.js':'function assert(){throw 1;}'},{moduleDependencies:deps}),
    make(sources,{moduleDependencies:deps,profile:{...profile,resourcePolicy:{...profile.resourcePolicy,maxSteps:999}}})
  ])assert.notEqual(catalog.variants[0].id,changed.variants[0].id);
  const unresolved=make(sources);
  assert.equal(unresolved.variants[0].dependencies.status,'unresolved');
  assert.deepEqual(unresolved.variants[0].dependencies.unresolved,['test/main.js']);
  assert.throws(()=>make(sources,{moduleDependencies:{'test/main.js':['test/missing.js']}}),/Unpinned module dependency/);
});

test('pins and scope classifications fail closed without fabricating a full suite',()=>{
  const source=fixture();
  assert.throws(()=>buildTest262Catalog({profile,sources:{'test/a.js':source},
    snapshot:{repository:'tc39/test262',revision:'a'.repeat(40),files:{'test/a.js':'0'.repeat(40)}}}),/blob mismatch/);
  assert.throws(()=>buildTest262Catalog({profile,sources:{},
    snapshot:{repository:'tc39/test262',revision:'a'.repeat(40),files:{'test/a.js':gitBlobSha(source)}}}),/Missing pinned/);
  assert.throws(()=>make({'test/../escape.js':source}),/Invalid pinned/);
  assert.throws(()=>make({'test/a.js':source},{classifications:{'test/a.js':{membership:'outside_profile',requiredForThisRelease:false}}}),/classification/);
  const catalog=make({'test/a.js':source});
  const changed=structuredClone(catalog);changed.variants[0].mode='raw';
  assert.throws(()=>validateTest262Catalog(changed),/digest mismatch/);
});

test('selection retains all catalog rows and cannot inherit passed later stages',()=>{
  const catalog=make({'test/a.js':fixture(),'test/b.js':fixture()});
  const campaign=createTest262Campaign({catalog,implementation,selectedIds:[catalog.variants[1].id]});
  assert.equal(campaign.rows.length,4);
  assert.equal(campaign.rows.filter(row=>row.selected).length,1);
  assert(campaign.rows.filter(row=>!row.selected).every(row=>
    Object.values(row.stages).every(stage=>stage.status==='not_selected')));
  assert.throws(()=>recordTest262Stage(campaign,{caseId:catalog.variants[1].id,
    stage:'nativeReplay',status:'passed',evidence:{}}),/blocked/);
  assert.throws(()=>recordTest262Stage(campaign,{caseId:catalog.variants[0].id,
    stage:'parseStatic',status:'passed',evidence:{}}),/unselected/);
  assert.throws(()=>createTest262Campaign({catalog,implementation,selectedIds:['unknown']}),/catalog IDs/);
});

test('attempt history keeps failures and invalidates downstream receipts on retry',()=>{
  const catalog=make({'test/a.js':fixture('','flags: [noStrict]\n')});
  const caseId=catalog.variants[0].id;
  let campaign=createTest262Campaign({catalog,implementation});
  campaign=recordTest262Stage(campaign,{caseId,stage:'parseStatic',status:'passed',evidence:{parser:'owned'}});
  campaign=recordTest262Stage(campaign,{caseId,stage:'ownedExecution',status:'failed',reason:'wrong value',evidence:{actual:2,expected:1}});
  assert.equal(campaign.rows[0].stages.sourceCorrespondence.status,'blocked_by_prior_stage');
  campaign=recordTest262Stage(campaign,{caseId,stage:'ownedExecution',status:'passed',evidence:{actual:1}});
  campaign=recordTest262Stage(campaign,{caseId,stage:'independentReference',status:'passed',evidence:{actual:1}});
  campaign=recordTest262Stage(campaign,{caseId,stage:'sourceCorrespondence',status:'passed',evidence:{matches:true}});
  assert.equal(campaign.rows[0].stages.publicReplay.status,'not_run');
  campaign=recordTest262Stage(campaign,{caseId,stage:'ownedExecution',status:'resource_limited',reason:'budget',evidence:{steps:20000}});
  assert.equal(campaign.rows[0].attempts[1].status,'failed');
  assert.equal(campaign.rows[0].attempts.length,6);
  assert.equal(campaign.rows[0].stages.sourceCorrespondence.status,'blocked_by_prior_stage');
  assert.equal(validateTest262Campaign(campaign,{catalog,implementation}),true);
  const summary=summarizeTest262Campaign(campaign);
  for(const stage of CONFORMANCE_STAGES)
    assert.equal(Object.values(summary.stages[stage]).reduce((sum,count)=>sum+count,0),summary.catalogVariants);
});

test('resume binds catalog, selection, implementation, runner and evidence bytes',()=>{
  const catalog=make({'test/a.js':fixture()});
  const campaign=recordTest262Stage(createTest262Campaign({catalog,implementation}),{
    caseId:catalog.variants[0].id,stage:'parseStatic',status:'passed',evidence:{ok:true}});
  assert.equal(validateTest262Campaign(campaign,{catalog,implementation}),true);
  assert.throws(()=>validateTest262Campaign(campaign,{catalog,implementation:{...implementation,runnerDigest:'d'.repeat(64)}}),/Incompatible/);
  const changed=structuredClone(campaign);changed.rows.pop();
  assert.throws(()=>validateTest262Campaign(changed,{catalog,implementation}),/Incompatible/);
  const altered=structuredClone(campaign);altered.rows[0].attempts[0].evidence.ok=false;
  assert.throws(()=>validateTest262Campaign(altered,{catalog,implementation}),/evidence digest/);
  const forged=structuredClone(campaign);forged.rows[0].stages.nativeReplay={status:'passed'};
  assert.throws(()=>validateTest262Campaign(forged,{catalog,implementation}),/attempt history/);
  const reordered=structuredClone(campaign);reordered.rows[0].attempts[0].sequence=2;
  assert.throws(()=>validateTest262Campaign(reordered,{catalog,implementation}),/attempt sequence/);
  assert.throws(()=>recordTest262Stage(forged,{caseId:catalog.variants[0].id,stage:'ownedExecution',
    status:'passed',evidence:{ok:true}}),/attempt history/);
  assert.notEqual(campaign.identityDigest,createTest262Campaign({catalog,implementation,selectedIds:[]}).identityDigest);
});

test('retained snapshot catalog can be generated without claiming missing harnesses passed',()=>{
  const directory=mkdtempSync(join(process.cwd(),'test262-catalog-'));
  try{
    const output=join(directory,'catalog.json');
    execFileSync(process.execPath,['tools/catalog-test262.mjs','--out',output],
      {cwd:new URL('..',import.meta.url),stdio:'pipe'});
    const result=JSON.parse(readFileSync(output,'utf8'));
    assert.equal(result.catalog.suiteRevision,'d53ebc8b1931d9f1541e43d59650776e4b766248');
    assert.equal(result.catalog.summary.testFiles,42);
    assert(result.catalog.summary.knownVariants>42);
    assert(result.catalog.summary.missingHarnessFiles.includes('harness/assert.js'));
    assert.equal(result.catalog.claims.ownedConformance,false);
    assert(result.campaign.rows.every(row=>Object.values(row.stages).every(stage=>stage.status==='not_run')));
    assert.equal(result.catalog.digest,conformanceDigest(Object.fromEntries(
      Object.entries(result.catalog).filter(([key])=>key!=='digest'))));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('binding an execution profile preserves the whole inventory and never copies qualifications',()=>{
  const catalog=make({'test/first.js':fixture(),'test/second.js':fixture('','flags: [raw]\n')});
  const bound=bindTest262CatalogProfile(catalog,{...profile,name:'new-owned-runner',parser:{name:'acorn',version:'8.15.0'}});
  assert.equal(validateTest262Catalog(bound),true);
  assert.deepEqual(bound.files,catalog.files);assert.deepEqual(bound.summary,catalog.summary);
  assert.deepEqual(bound.variants.map(row=>row.path),catalog.variants.map(row=>row.path));
  assert(bound.variants.every((row,index)=>row.id!==catalog.variants[index].id));
  const campaign=createTest262Campaign({catalog:bound,implementation});
  assert(campaign.rows.every(row=>Object.values(row.stages).every(stage=>stage.status==='not_run')));
  assert.equal(catalog.profile.name,'synthetic-runner-controls');
  assert.throws(()=>bindTest262CatalogProfile(catalog,{...profile,resourcePolicy:{maxSteps:0,maxSourceBytes:5}}),/Invalid derived/);
});

test('batch stage recording is atomic and preserves unselected rows and prior attempts',()=>{
  const catalog=make({'test/first.js':fixture(),'test/second.js':fixture()});
  const first=catalog.variants[0].id;
  const campaign=createTest262Campaign({catalog,implementation,selectedIds:[first]});
  const attempts=[{caseId:first,stage:'parseStatic',status:'passed',evidence:{parser:'checked'}},
    {caseId:first,stage:'ownedExecution',status:'failed',evidence:{assertion:'failed'}}];
  const next=recordTest262Stages(campaign,attempts);
  assert.equal(validateTest262Campaign(next,{catalog,implementation}),true);
  assert.equal(next.rows.length,catalog.variants.length);assert.equal(next.rows[0].attempts.length,2);
  assert.equal(campaign.rows[0].attempts.length,0);
  assert(next.rows.slice(1).every(row=>Object.values(row.stages).every(stage=>stage.status==='not_selected')));
  assert.throws(()=>recordTest262Stages(campaign,[...attempts,
    {caseId:catalog.variants[1].id,stage:'parseStatic',status:'passed',evidence:{}}]),/unselected/);
  assert.equal(campaign.rows[0].attempts.length,0);
});
