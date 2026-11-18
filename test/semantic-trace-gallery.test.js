import test from 'node:test';
import assert from 'node:assert/strict';
import {auditWitnessBytes,buildSemanticTraceGallery,SEMANTIC_GALLERY_FIXTURES,
  renderSemanticTraceGallery,inspectSemanticEpisode} from '../src/training/semantic-trace-gallery.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

test('gallery byte accounting preserves actual escaped and Unicode target bytes',()=>{
  const line='bind {"name":"text","value":["str","雪\\\"key\\\": 1"]}';
  const audit=auditWitnessBytes(line);
  assert.equal(audit.total,Buffer.byteLength(line,'utf8'));
  assert.equal(audit.total,audit.recordKindBytes+audit.punctuationBytes+audit.keyBytes+audit.valueBytes);
  assert.equal(audit.fields.length,2);
  assert.throws(()=>auditWitnessBytes('bind { "name":"x","value":["num",1]}'),/canonical/);
});

test('gallery covers required semantic categories using verified actual records',async()=>{
  const gallery=await buildSemanticTraceGallery();
  for(const category of ['expressions','branches','object-construction','aliases','helper-calls',
    'loops','throws','finally','async-observations','callbacks','retained-state'])
    assert(gallery.categories.includes(category),category);
  assert.equal(gallery.cases.length,SEMANTIC_GALLERY_FIXTURES.length);
  assert.equal(gallery.totals.generatedTokens,null);
  for(const row of gallery.cases){
    assert.equal(row.qualification.status,'locally_verified');
    assert.equal(row.tokenization.status,'unavailable');
    assert.equal(row.metrics.generatedTokens,null);
    const targets=row.records.filter(record=>record.targetMask==='generated');
    assert.equal(targets.length,row.metrics.generatedRecords);
    assert.equal(targets.reduce((n,record)=>n+Buffer.byteLength(record.raw,'utf8'),0),row.metrics.generatedBytes);
    assert(targets.every(record=>record.readable&&record.claim&&record.privateCertificateRule));
    assert(targets.every(record=>record.publicPrefixDigest.length===64));
  }
  const asyncCase=gallery.cases.find(row=>row.id==='counter-0');
  const resultIndex=asyncCase.records.findIndex(row=>row.kind==='result');
  assert(resultIndex>=0);
  assert(asyncCase.records.slice(resultIndex+1).some(row=>row.kind==='compute'));
  assert.match(renderSemanticTraceGallery(gallery),/Exact generated targets/);
});

test('tokenization is opt-in, byte-roundtripped, and has separate cost scope',async()=>{
  const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='pure-helper');
  const result=await verifyEffectfulTrainingCase(fixture);
  assert.equal(result.status,'locally_verified',result.reason);
  // This test adapter is explicitly synthetic; no production/native count is inferred.
  const tokenizer={identity:{name:'test-utf8',revision:'test-only'},
    encode:line=>[...Buffer.from(line)],decode:ids=>Buffer.from(ids).toString('utf8')};
  const inspected=await inspectSemanticEpisode(result.exported,{tokenizer});
  assert.equal(inspected.metrics.generatedTokens,inspected.metrics.generatedBytes);
  assert.equal(inspected.metrics.transportFragments,null);
  assert.match(inspected.tokenization.scope,/excludes native transport/);
  await assert.rejects(inspectSemanticEpisode(result.exported,{tokenizer:{...tokenizer,identity:{name:'unpinned'}}}),/pinned identity/);
  await assert.rejects(inspectSemanticEpisode(result.exported,{tokenizer:{...tokenizer,decode:()=>''}}),/changes actual target bytes/);
});
