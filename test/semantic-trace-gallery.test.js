import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditWitnessBytes,buildSemanticTraceGallery,compareSemanticGalleryToV5,
  SEMANTIC_GALLERY_FIXTURES,renderSemanticTraceGallery,inspectSemanticEpisode} from '../src/training/semantic-trace-gallery.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';

const archivedV5=JSON.parse(readFileSync(new URL('../docs/evidence/semantic-target-gallery-v1/control/gallery.json',import.meta.url),'utf8'));

test('gallery byte accounting preserves exact escaped and Unicode v6 target bytes',()=>{
  const line="text = \"雪\\\"key\\\": 1\"";
  const audit=auditWitnessBytes(line);
  assert.equal(audit.total,Buffer.byteLength(line,'utf8'));
  assert.deepEqual(audit,{kind:'bind',total:Buffer.byteLength(line,'utf8')});
  assert.throws(()=>auditWitnessBytes('bind {"name":"x","value":["num",1]}'),/semantic-trace\/6/);
});

test('gallery covers verified production v6 targets and exact byte/token scopes',async()=>{
  const gallery=await buildSemanticTraceGallery();
  for(const category of ['expressions','branches','object-construction','aliases','helper-calls',
    'loops','throws','finally','async-observations','callbacks','retained-state'])
    assert(gallery.categories.includes(category),category);
  assert.equal(gallery.cases.length,SEMANTIC_GALLERY_FIXTURES.length);
  assert.equal(gallery.schema,'semantic-target-gallery/2');
  assert.equal(gallery.representation,'semantic-trace/6');
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
    assert(targets.every(record=>record.bytes.total===Buffer.byteLength(record.raw,'utf8')));
    assert(targets.every(record=>!/^\w+\s+\{/.test(record.raw)),'v6 target must not use a JSON record wrapper');
  }
  const asyncCase=gallery.cases.find(row=>row.id==='counter-0');
  const resultIndex=asyncCase.records.findIndex(row=>row.kind==='result');
  assert(resultIndex>=0);
  assert(asyncCase.records.slice(resultIndex+1).some(row=>row.kind==='compute'));
  assert.match(renderSemanticTraceGallery(gallery),/Exact generated targets/);
  const pureHelper=gallery.cases.find(row=>row.id==='pure-helper');
  const denseLoop=gallery.cases.find(row=>row.id==='dense-loop');
  for(const row of [pureHelper,denseLoop]){
    const generated=row.records.filter(record=>record.targetMask==='generated');
    assert.equal(generated.length,2);
    assert.match(generated[0].raw,/^evaluate run\(/);
    assert.equal(generated[1].raw,'end return');
  }
});

test('archived v5 comparison uses only stored raw line bytes without v6 decoding',async()=>{
  const current=await buildSemanticTraceGallery();
  const comparison=compareSemanticGalleryToV5(current,archivedV5);
  assert.equal(comparison.decodeArchivedV5Records,false);
  assert.equal(comparison.baselineRepresentation,'semantic-trace/5');
  assert.equal(comparison.currentRepresentation,'semantic-trace/6');
  for(const row of comparison.cases){
    const old=archivedV5.cases.find(item=>item.id===row.id);
    assert.equal(row.v5.generatedRecords,old.metrics.generatedRecords);
    assert.equal(row.v5.generatedBytes,old.metrics.generatedBytes);
    assert.equal(row.v6.generatedBytes,current.cases.find(item=>item.id===row.id).metrics.generatedBytes);
  }
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
