import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {buildTest262Catalog,conformanceDigest,bindTest262CatalogProfile,createTest262Campaign,recordTest262Stages} from '../src/conformance/test262-catalog.js';
import {createTest262CampaignReport} from '../src/conformance/test262-campaign.js';
import {gitBlobSha} from '../src/test262-baseline.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {assertNewScopeOutput,buildTest262ScopeAnnotations,classifyImportDeferParseFailure,
  extractImportDeferGrammarEvidence,writeNewScopeReport} from '../src/conformance/test262-scope-annotations.js';

const {bytes}=readPinnedEcma262Specification();
const grammar=extractImportDeferGrammarEvidence(bytes);
const row=(reason,line='')=>({id:'0'.repeat(64),path:'test/example.js',stage:'parseStatic',status:'failed',
  errorType:'SyntaxError',phase:'parse',reason,features:['import-defer'],line});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function retainedFixture(){
  const suiteRevision='a'.repeat(40),specification={uri:'https://262.ecma-international.org/17.0/index.html',
      sha256:'5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a',bytes:8348904},
    baseProfile={name:'frozen-test262-acquisition',edition:'ECMAScript 2026',specification:null,
      hostProfile:{name:'test',reference:{node:'v24',v8:'13.6'}},
      parser:{name:'test',version:'1',implementationDigest:'1'.repeat(64)},
      resourcePolicy:{maxSourceBytes:1000,maxSteps:1000}};
  const make=(body,negative='')=>Buffer.from('/*---\nflags: [module]\nfeatures: [import-defer]\n'+negative+'---*/\n'+body),
    sources={'test/static.js':make('import defer * as ns from "./dep_FIXTURE.js";\n'),
      'test/default.js':make('import defer from "./dep_FIXTURE.js";\nassert.sameValue(defer,1);\n'),
      'test/tag-only.js':make('export {};\n'),
      'test/negative-dynamic.js':make('import.defer() = 1;\n','negative:\n  phase: parse\n  type: SyntaxError\n'),
      'test/dep_FIXTURE.js':Buffer.from('export default 1;\n')},
    snapshot={repository:'tc39/test262',revision:suiteRevision,
      files:Object.fromEntries(Object.entries(sources).map(([path,source])=>[path,gitBlobSha(source)]))},
    base=buildTest262Catalog({snapshot,sources,profile:baseProfile,moduleDependencies:{
      'test/static.js':{paths:[],unresolved:['controlled incomplete static closure']},
      'test/default.js':['test/dep_FIXTURE.js'],
      'test/tag-only.js':[],'test/negative-dynamic.js':[],'test/dep_FIXTURE.js':[]}}),
    source=sources['test/static.js'].toString('utf8'),variant=base.variants.find(row=>row.path==='test/static.js'),
    sourceDigest=variant.sourceDigest;
  const runProfile={...baseProfile,name:'owned-test262-original/1',specification,
    parser:{name:'acorn',version:'8.15.0',implementationDigest:'2'.repeat(64)},
    hostProfile:{name:'single-agent-owned-test262/1',reference:{node:'v24.22.3',v8:'13.6.233.17-node.63'}}};
  const derived=bindTest262CatalogProfile(base,runProfile),runVariant=derived.variants.find(row=>row.path==='test/static.js'),
    runPolicy={stages:['parse'],jobs:1,workerTimeoutMs:10000,heapMb:384,
      selection:{paths:null,cases:null,limit:null,all:true}},
    implementation={producerRevision:'b'.repeat(40),codeDigest:'3'.repeat(64),runnerDigest:'4'.repeat(64),runPolicy,node:'v24.22.3',v8:'13.6.233.17-node.63',files:[]};
  let campaign=createTest262Campaign({catalog:derived,implementation,selectedIds:derived.variants.map(row=>row.id)});
  const reason='Unexpected parser SyntaxError: Unexpected token (5:13)',results=[
    {caseId:runVariant.id,stage:'parseStatic',status:'failed',reason,
      evidence:{sourceDigest,mode:'module',parser:runProfile.parser,parseOnly:true,phase:'parse',errorType:'SyntaxError'}}
  ];
  for(const path of ['test/default.js','test/tag-only.js']){
    const item=derived.variants.find(row=>row.path===path);
    results.push({caseId:item.id,stage:'parseStatic',status:'passed',reason:'Original source parsed in its declared goal',
      evidence:{sourceDigest:item.sourceDigest,mode:'module',parser:runProfile.parser,parseOnly:false,phase:'parse',errorType:null}});
  }
  const negative=derived.variants.find(row=>row.path==='test/negative-dynamic.js');
  results.push({caseId:negative.id,stage:'parseStatic',status:'passed',reason:'Expected parser SyntaxError observed',
    evidence:{sourceDigest:negative.sourceDigest,mode:'module',parser:runProfile.parser,parseOnly:true,
      phase:'parse',errorType:'SyntaxError'}});
  campaign=recordTest262Stages(campaign,results);
  const report=createTest262CampaignReport({baseCatalog:base,catalog:derived,campaign,runPolicy}),
    triage={schema:'test262-module-campaign-triage/1',catalogDigest:derived.digest,
      failedCases:{parseStatic:[{id:runVariant.id,path:variant.path,stage:'parseStatic',status:'failed',
        errorType:'SyntaxError',phase:'parse',reason}]} };
  return {base,catalog:base,campaign:report,triage,sources,source,variant,runVariant,runPolicy,implementation,specification};
}

test('pinned grammar evidence hashes exact import and identifier productions',()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(grammar).filter(([,value])=>value.id).map(([name,value])=>
    [name,{id:value.id,sha256:value.sha256,bytes:value.bytes}])),{
    ImportDeclaration:{id:'prod-ImportDeclaration',sha256:'fad54aff3713cc675476b177849a85619023e43e78dbdc8ebbaf0905951c6eae',bytes:952},
    ImportClause:{id:'prod-ImportClause',sha256:'b40ecb42636c6a8635ea5ea97a43dc539dd90b5fb255c749091f3ffd7b1caa5b',bytes:1140},
    ImportedDefaultBinding:{id:'prod-ImportedDefaultBinding',sha256:'b9270a73d40b1aea3f1ccf6d60c9e85c21558f55652df6b547130c58a9ba5574',bytes:355},
    ImportedBinding:{id:'prod-ImportedBinding',sha256:'937efafed1f91762b2901299d9954deacdd27ed3c6ecc90a8a2e7c4ae712315b',bytes:398},
    BindingIdentifier:{id:'prod-BindingIdentifier',sha256:'6479226d61448558f30c46b903442220584535dff9851ea980403bbb74853df2',bytes:609},
    Identifier:{id:'prod-Identifier',sha256:'85a2b8ad3a750b129d3101820baa402b14e0d557b736de48bbc39e46630f89db',bytes:413},
    ReservedWord:{id:'prod-ReservedWord',sha256:'1f9783d7296326d5111ce7d5962360192d4d832ef6062ce386846718f07cd3e9',bytes:1038},
    ImportMeta:{id:'prod-ImportMeta',sha256:'a911dead533a77a79f419711b46496a58a20456529dae744a8043761e386bd03',bytes:297},
    ImportCall:{id:'prod-ImportCall',sha256:'e5035f9df2c3f6ee22871ea0a78e8dd036f1457c69e9b4ec8403d720aeccc848',bytes:1321}
  });
  assert.deepEqual(grammar.annualDefaultImportBindingRoute,{productions:['ImportDeclaration','ImportClause',
    'ImportedDefaultBinding','ImportedBinding','BindingIdentifier','Identifier','ReservedWord'],deferIsReservedWord:false});
  const changed=Buffer.from(bytes);const at=changed.indexOf(Buffer.from('<emu-production name="ImportMeta" id="prod-ImportMeta">'));
  changed[at+33]^=1;
  assert.throws(()=>extractImportDeferGrammarEvidence(changed),/production bytes differ/);
});

test('static import defer requires the exact failed-token location and grammar evidence',()=>{
  const source='/* header */\nimport defer * as ns from "./dep.js";\n';
  const result=classifyImportDeferParseFailure(row('Unexpected parser SyntaxError: Unexpected token (2:13)'),source,grammar);
  assert.deepEqual(result,{status:'outside-pinned-grammar',rule:'static-import-defer',
    location:{line:2,column:13},evidence:['ImportDeclaration']});
  assert.equal(classifyImportDeferParseFailure(row('Unexpected parser SyntaxError: Unexpected token (2:13)'),source,
    {ImportDeclaration:null}).status,'unclassified');
});

test('import.defer is separately checked against ImportMeta and ImportCall productions',()=>{
  const source='import.defer("./dep.js").then(() => {});\n';
  const result=classifyImportDeferParseFailure(row("Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)"),source,grammar);
  assert.deepEqual(result,{status:'outside-pinned-grammar',rule:'import-defer-meta-member',
    location:{line:1,column:7},evidence:['ImportMeta','ImportCall']});
  assert.equal(classifyImportDeferParseFailure(row("Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)"),source,
    {ImportMeta:grammar.ImportMeta,ImportCall:null}).status,'unclassified');
});

test('comments, strings, unrelated errors and dynamic import options remain unclassified',()=>{
  const staticError='Unexpected parser SyntaxError: Unexpected token (1:13)';
  const metaError="Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)";
  for(const [reason,source] of [
    [staticError,'// import defer * as ns from "./dep.js";\n'],
    [staticError,'const s = "import defer * as ns from ./dep.js";\n'],
    ['Unexpected parser SyntaxError: Unexpected token (1:14)','import defer * as ns from "./dep.js";\n'],
    ['Unexpected parser SyntaxError: Unexpected token (1:0)','const x = ;\n'],
    [metaError,'const s = "import.defer(\"x\")";\n'],
    [metaError,'import("./dep.js", { with: { type: "json" }, defer: true });\n']
  ]) assert.equal(classifyImportDeferParseFailure(row(reason),source,grammar).status,'unclassified');
  assert.equal(classifyImportDeferParseFailure({...row(staticError),features:['other-feature']},
    'import defer * as ns from "./dep.js";\n',grammar).status,'unclassified');
});

test('source review distinguishes extension syntax from the annual default-binding form without changing statuses',()=>{
  const fixture=retainedFixture(),result=buildTest262ScopeAnnotations({...fixture,bytes,specification:fixture.specification});
  assert.equal(result.rows.length,fixture.base.variants.length);
  const byPath=new Map(result.rows.map(row=>[row.variant.path,row]));
  const staticImport=byPath.get('test/static.js'),defaultBinding=byPath.get('test/default.js'),
    tagOnly=byPath.get('test/tag-only.js'),negative=byPath.get('test/negative-dynamic.js');
  assert.equal(staticImport.variant.classification.membership,'unclassified');
  assert.equal(staticImport.campaign.stages.parseStatic.status,'failed');
  assert.equal(staticImport.scopeAnnotation.originalFailure.reason,fixture.triage.failedCases.parseStatic[0].reason);
  assert.equal(staticImport.scopeAnnotation.rule,'static-import-defer');
  assert.equal(staticImport.sourceReview.status,'proposal-grammar-observed');
  assert.equal(staticImport.sourceReview.dependencyClosureComplete,false);
  assert.equal(staticImport.sourceReview.parseObservation.kind,'unexpected-parse-error');
  assert.equal(defaultBinding.campaign.stages.parseStatic.status,'passed');
  assert.deepEqual(defaultBinding.sourceReview.forms,['default-binding-named-defer']);
  assert.equal(defaultBinding.sourceReview.status,'annual-grammar-overlap-observed');
  assert.equal(defaultBinding.sourceReview.membership,'unclassified');
  assert.equal(defaultBinding.scopeAnnotation.status,'unclassified');
  assert.equal(defaultBinding.sourceReview.parseObservation.kind,'source-parsed');
  assert.equal(negative.campaign.stages.parseStatic.status,'passed');
  assert.equal(negative.sourceReview.parseObservation.kind,'expected-parse-negative-observed');
  assert.deepEqual(negative.sourceReview.forms,['dynamic-import-defer','import-defer-member']);
  assert.equal(tagOnly.campaign.stages.parseStatic.status,'passed');
  assert.equal(tagOnly.sourceReview.status,'tag-without-matching-source-grammar');
  assert.equal(tagOnly.sourceReview.parseObservation.kind,'source-parsed');
  assert.equal(result.summary.importDeferFeatureRows,4);
  assert.deepEqual(result.summary.importDeferSourceReview.parseStaticStatuses,{failed:1,passed:3});
  assert.deepEqual(result.summary.importDeferSourceReview.parseObservations,
    {'expected-parse-negative-observed':1,'source-parsed':2,'unexpected-parse-error':1});
  assert.deepEqual(result.summary.importDeferSourceReview.sourceEvidence,{
    'annual-grammar-overlap-observed':1,'proposal-grammar-observed':2,'tag-without-matching-source-grammar':1});
  assert.equal(result.claims.denominatorRowsRemoved,0);
});

test('full annotation refuses source hash drift, absent or duplicate campaign rows, and triage drift',()=>{
  const fixture=retainedFixture(),call=()=>buildTest262ScopeAnnotations({...fixture,bytes,specification:fixture.specification});
  assert.throws(()=>buildTest262ScopeAnnotations({...fixture,sources:{[fixture.variant.path]:Buffer.from(fixture.source+'// drift\n')},bytes,
    specification:fixture.specification}),/exact original Test262 bytes/);
  const missing=structuredClone(fixture);missing.campaign.campaign.rows=[];
  assert.throws(()=>buildTest262ScopeAnnotations({...missing,bytes,specification:fixture.specification}));
  const duplicated=structuredClone(fixture);duplicated.campaign.campaign.rows.push(duplicated.campaign.campaign.rows[0]);
  assert.throws(()=>buildTest262ScopeAnnotations({...duplicated,bytes,specification:fixture.specification}));
  const alteredTriage=structuredClone(fixture);alteredTriage.triage.failedCases.parseStatic[0].reason+=' altered';
  assert.throws(()=>buildTest262ScopeAnnotations({...alteredTriage,bytes,specification:fixture.specification}));
  assert.doesNotThrow(call);
});

test('full annotation refuses a campaign-declared specification mismatch and existing output path',()=>{
  const fixture=retainedFixture(),altered=structuredClone(fixture);
  altered.campaign.profile.specification.sha256='9'.repeat(64);
  assert.throws(()=>buildTest262ScopeAnnotations({...altered,bytes,specification:fixture.specification}),/Campaign-declared ECMA-262/);
  assert.equal(assertNewScopeOutput('/this/path/does/not/exist/scope-report.json'),true);
  assert.throws(()=>assertNewScopeOutput(new URL(import.meta.url).pathname),/must be new/);
});

test('scope report publication does not replace a destination created after preflight',()=>{
  const directory=mkdtempSync(join(process.cwd(),'scope-output-race-')),output=join(directory,'report.json'),
    original=Buffer.from('concurrent immutable report');
  try{
    assert.throws(()=>writeNewScopeReport(output,Buffer.from('new report'),{
      beforePublish:()=>writeFileSync(output,original)
    }),error=>error.code==='EEXIST');
    assert.deepEqual(readFileSync(output),original);
    assert.deepEqual(readdirSync(directory),['report.json']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
