import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildTest262Catalog,conformanceDigest,validateTest262Catalog} from '../src/conformance/test262-catalog.js';
import {gitBlobSha} from '../src/test262-baseline.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {extractEcma262HtmlInventory,test262SpecificationReference,buildTest262EditionAudit}
  from '../src/conformance/test262-edition.js';

// These controls deliberately rehash their changes so they reach the semantic
// membership checks after the catalog's independent identity validation.
function rehashCatalog(catalog){
  for(const row of catalog.variants){const {id,...identity}=row;
    row.id=conformanceDigest({suiteRevision:catalog.suiteRevision,profile:catalog.profile,...identity});}
  const {digest,...body}=catalog;catalog.digest=conformanceDigest(body);
  return catalog;
}

test('HTML inventory uses real tags, clause ancestry and explicit ambiguous anchors',()=>{
  const bytes=Buffer.from('<script>const fake=`<emu-clause id="fake">`;</script>'+
    '<!-- <emu-clause id="comment"> --><emu-clause id="root" normative-optional>'+
    '<h1>1 A &amp; B</h1><span id="alias"></span><span id="alias"></span><span id="shared"></span>'+
    '<emu-clause id="child"><h1>1.1 Child</h1><span id="shared"></span></emu-clause></emu-clause>');
  const inventory=extractEcma262HtmlInventory(bytes);
  assert.deepEqual(inventory.sections.map(row=>row.id),['root','child']);
  assert.equal(inventory.sections[0].title,'1 A & B');
  assert.equal(inventory.sections[0].normativeOptional,true);
  assert.equal(inventory.sections[1].parent,'root');
  assert.deepEqual(inventory.anchors.find(row=>row.id==='shared').sections,['child','root']);
  assert.equal(inventory.anchors.find(row=>row.id==='alias').occurrences,2);
  assert(!inventory.anchors.some(row=>['fake','comment'].includes(row.id)));
  assert.throws(()=>extractEcma262HtmlInventory(Buffer.from('<emu-clause id="a"></emu-clause><emu-clause id="a"></emu-clause>')),/Duplicate specification clause/);
});

test('descriptive references do not change routing identities or infer legacy anchors',()=>{
  const source='/*---\r\nesid: "sec-array.prototype.map" # literal reference\r\nes6id: 22.1.3.15\r\nflags: [raw]\r\n---*/';
  assert.deepEqual(test262SpecificationReference(source),{
    esid:{status:'scalar',value:'sec-array.prototype.map'},es6id:{status:'scalar',value:'22.1.3.15'}});
  assert.deepEqual(test262SpecificationReference(source.replaceAll('\r\n','\r')),
    test262SpecificationReference(source));
  assert.equal(test262SpecificationReference('/*---\nesid: []\nflags: [raw]\n---*/').esid.status,'unresolved');
  assert.throws(()=>test262SpecificationReference('/*---\nesid: one\nesid: two\nflags: [raw]\n---*/'),/Duplicate/);
});

function fixture(classifications={}){
  const make=reference=>'/*---\n'+reference+'\nflags: [raw]\nfeatures: [generators]\n---*/\n';
  const sources={'test/core.js':make('esid: sec-array.prototype.map'),
    'test/missing.js':make('esid: sec-a-deliberately-absent-feature'),
    'test/legacy.js':make('es6id: 22.1.3.15'),
    'test/intl402/linked.js':make('esid: sec-array.prototype.map')};
  const snapshot={repository:'tc39/test262',revision:'1'.repeat(40),
    files:Object.fromEntries(Object.entries(sources).map(([path,source])=>[path,gitBlobSha(source)]))};
  const pinned=readPinnedEcma262Specification();
  // The retained acquisition profile intentionally predates a specification
  // binding; the review evidence pins it separately and the edition audit
  // verifies it against the exact specification bytes.
  const profile={name:'edition-audit-test',edition:'ECMAScript 2026',specification:null,
    parser:{name:'not-executed'},hostProfile:{name:'not-executed'},resourcePolicy:{maxSteps:1,maxSourceBytes:1024}};
  for(const [path,classification] of Object.entries(classifications)){
    if(classification.membership==='unclassified')continue;
    const source=Buffer.from(sources[path]),membership=classification.membership;
    const normativeObligations=[{basis:'edition',uri:pinned.specification.uri,sha256:pinned.specification.sha256,
      clauseIds:['sec-array.prototype.map']}];
    if(membership==='extension')normativeObligations.push({basis:'addition',uri:'https://example.invalid/addition.html',
      sha256:'a'.repeat(64),clauseIds:['feature-example']});
    classification.evidence={schema:'test262-edition-membership-review/1',
      reviewer:{kind:'assistant',identity:'synthetic schema fixture'},method:'synthetic-fixture-only',
      rationale:'Synthetic validation fixture; not a real Test262 membership adjudication.',
      suiteRevision:snapshot.revision,sourceDigest:createHash('sha256').update(source).digest('hex'),
      profileDigest:conformanceDigest(profile),hostProfileDigest:conformanceDigest(profile.hostProfile),
      editionSpecification:{uri:pinned.specification.uri,sha256:pinned.specification.sha256},
      sourceInputs:[{path,sha256:createHash('sha256').update(source).digest('hex'),kind:'test'}],
      normativeObligations};
  }
  return {sources,catalog:buildTest262Catalog({snapshot,sources,profile,classifications}),...pinned};
}

test('all variants survive reference reconciliation without becoming edition or execution passes',()=>{
  const input=fixture(),report=buildTest262EditionAudit(input);
  assert.equal(report.summary.auditedVariants,4);
  assert.deepEqual(report.summary.referenceDispositions,{resolved_anchor:2,missing_metadata:1,anchor_absent:1});
  assert.deepEqual(report.summary.editionMembership,{unclassified:4});
  assert.deepEqual(report.summary.releaseRequirement,{required:0,notRequired:4});
  assert.equal(report.summary.unresolvedEditionMembership,4);
  assert.deepEqual(report.summary.sourceFilesByEditionMembership,{unclassified:4});
  assert.deepEqual(report.summary.variantModes,{raw:4});
  assert.deepEqual(report.summary.expectedOutcomes,{normal:4,negativePhases:{}});
  assert.deepEqual(report.rows.map(row=>row.id),input.catalog.variants.map(row=>row.id));
  assert(report.rows.every(row=>row.classification.membership==='unclassified'));
  assert.equal(report.rows.find(row=>row.path.startsWith('test/intl402')).scopeReview,'separate-ecma402-pin-required');
  assert.equal(report.features[0].variants,4);
  assert.deepEqual(report.claims,{editionMembershipCertified:false,applicabilityCertified:false,conformance:false});
  assert(report.summary.sectionsWithoutDirectTestReference>0);
});

test('edition audit validates the declared default harness closure for script tests',()=>{
  const path='test/core-script.js',sources={
    [path]:'/*---\nesid: sec-array.prototype.map\n---*/\nassert.sameValue(1, 1);\n',
    'harness/assert.js':'function assert() {}\n','harness/sta.js':'function Test262Error() {}\n',
  },snapshot={repository:'tc39/test262',revision:'2'.repeat(40),
    files:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,gitBlobSha(value)]))},
    pinned=readPinnedEcma262Specification(),profile={name:'script-audit-test',edition:'ECMAScript 2026',
      specification:null,parser:{name:'not-executed'},hostProfile:{name:'not-executed'},
      resourcePolicy:{maxSteps:1,maxSourceBytes:1024}},
    catalog=buildTest262Catalog({snapshot,sources,profile}),
    report=buildTest262EditionAudit({catalog,sources,specification:pinned.specification,bytes:pinned.bytes});
  assert.deepEqual(report.rows.map(row=>row.classification.membership),['unclassified','unclassified']);
  assert.deepEqual(catalog.variants[0].harness,[
    {path:'harness/assert.js',sha256:createHash('sha256').update(sources['harness/assert.js']).digest('hex')},
    {path:'harness/sta.js',sha256:createHash('sha256').update(sources['harness/sta.js']).digest('hex')},
  ]);
});

test('edition and release classification denominators remain explicit by review scope',()=>{
  const input=fixture({
    'test/core.js':{membership:'edition',requiredForThisRelease:true},
    'test/missing.js':{membership:'extension',requiredForThisRelease:false},
    'test/legacy.js':{membership:'outside_profile',requiredForThisRelease:false,reason:'ECMA-402 profile'},
    'test/intl402/linked.js':{membership:'unclassified',requiredForThisRelease:true},
  });
  const report=buildTest262EditionAudit(input);
  assert.deepEqual(report.summary.editionMembership,{edition:1,extension:1,outside_profile:1,unclassified:1});
  assert.deepEqual(report.summary.releaseRequirement,{required:2,notRequired:2});
  assert.equal(report.summary.unresolvedEditionMembership,1);
  assert.deepEqual(report.summary.scopeReviewByEditionMembership,{
    'core-or-extension-review':{edition:1,extension:1,outside_profile:1},
    'separate-ecma402-pin-required':{unclassified:1},
  });
  assert.equal(report.rows.length,input.catalog.variants.length);
  assert.deepEqual(report.claims,{editionMembershipCertified:false,applicabilityCertified:false,conformance:false});
});

test('resolved anchors, tags and review paths cannot classify without source-bound normative evidence',()=>{
  const base=fixture(),rows=base.catalog.variants;
  assert(rows.every(row=>row.classification.membership==='unclassified'));
  for(const path of ['test/core.js','test/intl402/linked.js']){
    const source=base.sources[path],classification={membership:path.includes('intl402')?'outside_profile':'edition',
      requiredForThisRelease:false,...(path.includes('intl402')?{reason:'Separate standard/profile requires review.'}:{})};
    assert.throws(()=>buildTest262Catalog({snapshot:{repository:'tc39/test262',revision:'1'.repeat(40),
      files:Object.fromEntries(Object.entries(base.sources).map(([name,value])=>[name,gitBlobSha(value)]))},
      sources:base.sources,profile:base.catalog.profile,classifications:{[path]:classification}}),/review evidence|classification fields/);
    assert(source.includes('features: [generators]'));
  }
});

test('membership review binds suite, source closure, profile and normative clauses across every variant',()=>{
  const input=fixture({'test/core.js':{membership:'edition',requiredForThisRelease:true},
    'test/missing.js':{membership:'extension',requiredForThisRelease:false},
    'test/legacy.js':{membership:'outside_profile',requiredForThisRelease:false,reason:'Separate profile.'}});
  assert.equal(input.catalog.variants.length,4);
  assert(input.catalog.variants.filter(row=>row.classification.membership!=='unclassified')
    .every(row=>row.classification.evidence.sourceDigest===row.sourceDigest));
  assert.equal(validateTest262Catalog(input.catalog),true);
  const tampered=structuredClone(input.catalog),target=tampered.variants.find(row=>row.path==='test/core.js');
  target.classification.evidence.sourceDigest='f'.repeat(64);
  rehashCatalog(tampered);
  assert.throws(()=>validateTest262Catalog(tampered),/test source digest/);
  const wrongEdition=structuredClone(input.catalog),wrongEditionRow=wrongEdition.variants.find(row=>row.path==='test/core.js');
  wrongEditionRow.classification.evidence.editionSpecification.sha256='f'.repeat(64);
  wrongEditionRow.classification.evidence.normativeObligations[0].sha256='f'.repeat(64);
  rehashCatalog(wrongEdition);
  assert.equal(validateTest262Catalog(wrongEdition),true);
  assert.throws(()=>buildTest262EditionAudit({...input,catalog:wrongEdition}),/different pinned edition specification/);
  const wrongProfile=structuredClone(input.catalog),variant=wrongProfile.variants.find(row=>row.path==='test/core.js');
  variant.classification.evidence.hostProfileDigest='f'.repeat(64);
  rehashCatalog(wrongProfile);
  assert.throws(()=>validateTest262Catalog(wrongProfile),/host profile digest/);
  const wrongClosure=structuredClone(input.catalog),closureRow=wrongClosure.variants.find(row=>row.path==='test/core.js');
  closureRow.classification.evidence.sourceInputs.push({path:'test/omitted-helper.js',sha256:'b'.repeat(64),kind:'test'});
  rehashCatalog(wrongClosure);
  assert.throws(()=>validateTest262Catalog(wrongClosure),/source input closure/);
  const missingClause=fixture({'test/core.js':{membership:'edition',requiredForThisRelease:false}});
  const invalid=structuredClone(missingClause.catalog),evidence=invalid.variants[0].classification.evidence;
  evidence.normativeObligations[0].clauseIds=['not-a-clause'];
  rehashCatalog(invalid);
  assert.throws(()=>buildTest262EditionAudit({...missingClause,catalog:invalid}),/clause absent/);
  assert.equal(input.catalog.variants.find(row=>row.path==='test/core.js').classification.requiredForThisRelease,true);
  assert.deepEqual(buildTest262EditionAudit(input).claims,
    {editionMembershipCertified:false,applicabilityCertified:false,conformance:false});
});

test('changed original bytes and rehashed missing variants cannot manufacture a smaller denominator',()=>{
  const input=fixture();
  assert.throws(()=>buildTest262EditionAudit({...input,sources:{...input.sources,'test/core.js':input.sources['test/core.js']+' '}}),/exact catalog test bytes/);
  const {digest,...body}=structuredClone(input.catalog);body.variants=body.variants.slice(1);
  assert.throws(()=>buildTest262EditionAudit({...input,catalog:{...body,digest:conformanceDigest(body)}}),
    /catalog omits or changes required source variants: test\/core\.js/);
  const duplicate=structuredClone(input.catalog);duplicate.variants.push(structuredClone(duplicate.variants[0]));
  const {digest:ignored,...duplicateBody}=duplicate;
  assert.throws(()=>buildTest262EditionAudit({...input,catalog:{...duplicateBody,digest:conformanceDigest(duplicateBody)}}),/Duplicate or missing Test262 variants/);
  const changed=Buffer.from(input.bytes);changed[0]^=1;
  assert.throws(()=>buildTest262EditionAudit({...input,bytes:changed}),/specification bytes differ/);
});

test('reviewed modules require every pinned fixture and a complete dependency closure',()=>{
  const path='test/module-review.js',dependency='test/value_FIXTURE.js',
    sources={
      [path]:'/*---\nesid: sec-modules\nflags: [module]\n---*/\n'+
        'import value from "./value_FIXTURE.js";\nassert.sameValue(value, 1);\n',
      [dependency]:'export default 1;\n',
      'harness/assert.js':'function assert() {}\n',
      'harness/sta.js':'function Test262Error() {}\n',
    },snapshot={repository:'tc39/test262',revision:'3'.repeat(40),
      files:Object.fromEntries(Object.entries(sources).map(([name,source])=>[name,gitBlobSha(source)]))},
    base=fixture(),profile=base.catalog.profile,
    sourceInputs=Object.entries(sources).map(([name,source])=>({path:name,
      sha256:createHash('sha256').update(source).digest('hex'),
      kind:name===path?'test':name===dependency?'module-dependency':'harness'}))
      .sort((a,b)=>a.path.localeCompare(b.path)),
    classification={membership:'edition',requiredForThisRelease:false,evidence:{
      schema:'test262-edition-membership-review/1',
      reviewer:{kind:'assistant',identity:'synthetic module review control'},
      method:'synthetic-fixture-only',rationale:'Tests byte and closure validation; no actual membership decision.',
      suiteRevision:snapshot.revision,sourceDigest:sourceInputs.find(row=>row.path===path).sha256,
      profileDigest:conformanceDigest(profile),hostProfileDigest:conformanceDigest(profile.hostProfile),
      editionSpecification:{uri:base.specification.uri,sha256:base.specification.sha256},sourceInputs,
      normativeObligations:[{basis:'edition',uri:base.specification.uri,sha256:base.specification.sha256,
        clauseIds:['sec-modules']}],
    }},input={snapshot,sources,profile,moduleDependencies:{[path]:[dependency],[dependency]:[]},
      classifications:{[path]:classification}},catalog=buildTest262Catalog(input);
  assert.equal(catalog.files.find(row=>row.path===dependency).kind,'fixture');
  assert.equal(validateTest262Catalog(catalog),true);
  const audit={catalog,sources,specification:base.specification,bytes:base.bytes};
  assert.deepEqual(buildTest262EditionAudit(audit).summary.editionMembership,{edition:1});
  assert.throws(()=>buildTest262EditionAudit({...audit,sources:{...sources,[dependency]:'export default 2;\n'}}),
    /exact reviewed source input bytes/);
  const unresolved={...input,moduleDependencies:{[path]:[dependency]}};
  assert.throws(()=>buildTest262Catalog(unresolved),/complete source dependency closure/);
  const unknown=buildTest262Catalog({...unresolved,classifications:{}});
  assert.equal(unknown.variants[0].classification.membership,'unclassified');
  assert.equal(unknown.variants[0].dependencies.status,'unresolved');
  const rehashed=structuredClone(catalog);
  rehashed.variants[0].dependencies.status='unresolved';
  rehashed.variants[0].dependencies.unresolved=[dependency];
  rehashCatalog(rehashed);
  assert.throws(()=>validateTest262Catalog(rehashed),/complete source dependency closure/);
});

test('an edition decision cannot simultaneously require an addition or external profile obligation',()=>{
  const input=fixture({'test/core.js':{membership:'edition',requiredForThisRelease:false}}),
    catalog=structuredClone(input.catalog);
  catalog.variants[0].classification.evidence.normativeObligations.push({basis:'addition',
    uri:'https://example.invalid/required-addition',sha256:'a'.repeat(64),clauseIds:['addition']});
  rehashCatalog(catalog);
  assert.throws(()=>validateTest262Catalog(catalog),/Edition membership cannot require addition/);
});
