import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTest262Catalog,conformanceDigest} from '../src/conformance/test262-catalog.js';
import {gitBlobSha} from '../src/test262-baseline.js';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {extractEcma262HtmlInventory,test262SpecificationReference,buildTest262EditionAudit}
  from '../src/conformance/test262-edition.js';

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
  const profile={name:'edition-audit-test',edition:'ECMAScript 2026',specification:null,
    parser:{name:'not-executed'},hostProfile:{name:'not-executed'},resourcePolicy:{maxSteps:1,maxSourceBytes:1024}};
  return {sources,catalog:buildTest262Catalog({snapshot,sources,profile,classifications}),...readPinnedEcma262Specification()};
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

test('changed original bytes and rehashed missing variants cannot manufacture a smaller denominator',()=>{
  const input=fixture();
  assert.throws(()=>buildTest262EditionAudit({...input,sources:{...input.sources,'test/core.js':input.sources['test/core.js']+' '}}),/exact catalog test bytes/);
  const {digest,...body}=structuredClone(input.catalog);body.variants=body.variants.slice(1);
  assert.throws(()=>buildTest262EditionAudit({...input,catalog:{...body,digest:conformanceDigest(body)}}),/every declared variant mode/);
  const duplicate=structuredClone(input.catalog);duplicate.variants.push(structuredClone(duplicate.variants[0]));
  const {digest:ignored,...duplicateBody}=duplicate;
  assert.throws(()=>buildTest262EditionAudit({...input,catalog:{...duplicateBody,digest:conformanceDigest(duplicateBody)}}),/Duplicate or missing Test262 variants/);
  const changed=Buffer.from(input.bytes);changed[0]^=1;
  assert.throws(()=>buildTest262EditionAudit({...input,bytes:changed}),/specification bytes differ/);
});
