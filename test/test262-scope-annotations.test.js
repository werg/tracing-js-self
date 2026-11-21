import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {conformanceDigest,bindTest262CatalogProfile,createTest262Campaign,recordTest262Stage} from '../src/conformance/test262-catalog.js';
import {createTest262CampaignReport} from '../src/conformance/test262-campaign.js';
import {gitBlobSha} from '../src/test262-baseline.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {assertNewScopeOutput,buildTest262ScopeAnnotations,classifyImportDeferParseFailure,
  extractImportDeferGrammarEvidence} from '../src/conformance/test262-scope-annotations.js';

const {bytes}=readPinnedEcma262Specification();
const grammar=extractImportDeferGrammarEvidence(bytes);
const row=(reason,line='')=>({id:'0'.repeat(64),path:'test/example.js',stage:'parseStatic',status:'failed',
  errorType:'SyntaxError',phase:'parse',reason,features:['import-defer'],line});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function retainedFixture(){
  const source='/*---\nflags: [module]\nfeatures: [import-defer]\n---*/\nimport defer * as ns from "./dep.js";\n';
  const sourceBytes=Buffer.from(source),sourceDigest=digest(sourceBytes),
    suiteRevision='a'.repeat(40),specification={uri:'https://262.ecma-international.org/17.0/index.html',
      sha256:'5df49e088c2b5c7a3dfd4a330414b92897fb4535cb62fc5936cad101a6c2304a',bytes:8348904},
    baseProfile={name:'frozen-test262-acquisition',edition:'ECMAScript 2026',specification:null,
      hostProfile:{name:'test',reference:{node:'v24',v8:'13.6'}},
      parser:{name:'test',version:'1',implementationDigest:'1'.repeat(64)},
      resourcePolicy:{maxSourceBytes:1000,maxSteps:1000}};
  const variantBody={path:'test/example.js',sourceDigest,gitBlobSha:gitBlobSha(sourceBytes),mode:'module',
    metadata:{flags:['module'],includes:[],features:['import-defer']},classification:{membership:'unclassified',requiredForThisRelease:false}};
  const variant={id:conformanceDigest({suiteRevision,profile:baseProfile,...variantBody}),...variantBody};
  const base={schema:'test262-frozen-catalog/1',repository:'tc39/test262',suiteRevision,
    acquisition:{kind:'fixture'},profile:baseProfile,files:[{path:variant.path,gitBlobSha:variant.gitBlobSha}],
    variants:[variant],summary:{},claims:{fullSuiteAcquired:false}};
  base.digest=conformanceDigest(base);
  const runProfile={...baseProfile,name:'owned-test262-original/1',specification,
    parser:{name:'acorn',version:'8.15.0',implementationDigest:'2'.repeat(64)},
    hostProfile:{name:'single-agent-owned-test262/1',reference:{node:'v24.22.3',v8:'13.6.233.17-node.63'}}};
  const derived=bindTest262CatalogProfile(base,runProfile),runVariant=derived.variants[0],
    runPolicy={stages:['parse'],jobs:1,workerTimeoutMs:10000,heapMb:384,
      selection:{paths:null,cases:null,limit:null,all:true}},
    implementation={producerRevision:'b'.repeat(40),codeDigest:'3'.repeat(64),runnerDigest:'4'.repeat(64),runPolicy,node:'v24.22.3',v8:'13.6.233.17-node.63',files:[]};
  let campaign=createTest262Campaign({catalog:derived,implementation,selectedIds:[runVariant.id]});
  const reason='Unexpected parser SyntaxError: Unexpected token (5:13)';
  campaign=recordTest262Stage(campaign,{caseId:runVariant.id,stage:'parseStatic',status:'failed',reason,
    evidence:{sourceDigest,mode:'module',parser:runProfile.parser,parseOnly:true,phase:'parse',errorType:'SyntaxError'}});
  const report=createTest262CampaignReport({baseCatalog:base,catalog:derived,campaign,runPolicy}),
    triage={schema:'test262-module-campaign-triage/1',catalogDigest:derived.digest,
      failedCases:{parseStatic:[{id:runVariant.id,path:variant.path,stage:'parseStatic',status:'failed',
        errorType:'SyntaxError',phase:'parse',reason}]}},sources={[variant.path]:sourceBytes};
  return {base,catalog:base,campaign:report,triage,sources,source,variant,runVariant,runPolicy,implementation,specification};
}

test('pinned grammar evidence hashes the three exact import productions',()=>{
  assert.deepEqual(grammar,{
    ImportDeclaration:{id:'prod-ImportDeclaration',sha256:'fad54aff3713cc675476b177849a85619023e43e78dbdc8ebbaf0905951c6eae',bytes:952},
    ImportMeta:{id:'prod-ImportMeta',sha256:'a911dead533a77a79f419711b46496a58a20456529dae744a8043761e386bd03',bytes:297},
    ImportCall:{id:'prod-ImportCall',sha256:'e5035f9df2c3f6ee22871ea0a78e8dd036f1457c69e9b4ec8403d720aeccc848',bytes:1321}
  });
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

test('full annotation preserves all catalog and campaign rows while annotating only exact source evidence',()=>{
  const fixture=retainedFixture(),result=buildTest262ScopeAnnotations({...fixture,bytes,specification:fixture.specification});
  assert.equal(result.rows.length,fixture.base.variants.length);
  assert.equal(result.rows[0].variant.classification.membership,'unclassified');
  assert.equal(result.rows[0].campaign.stages.parseStatic.status,'failed');
  assert.equal(result.rows[0].scopeAnnotation.originalFailure.reason,fixture.triage.failedCases.parseStatic[0].reason);
  assert.equal(result.rows[0].scopeAnnotation.rule,'static-import-defer');
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
