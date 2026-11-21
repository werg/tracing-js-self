import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';

const packet=JSON.parse(gunzipSync(Buffer.from(await readFile(new URL('./fixtures/semantic-source-recovery-v8.json.gz.b64',import.meta.url),'utf8'),'base64')));

test('recovery fixture retains the original source and explicit checkpoint option',()=>{
  assert.equal(packet.schema,'semantic-source-recovery-fixtures/1');
  assert.match(packet.producer.revision,/^[0-9a-f]{40}$/);
  assert.equal(packet.qualification.native,'untested');
  assert.equal(packet.cases.length,1);
  const {fixture,artifact,recheck}=packet.cases[0];
  const original=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='counter-0');
  for(const key of ['source','entry','args','fixture'])assert.deepEqual(fixture[key],original[key]);
  assert.deepEqual(fixture.projectionOptions,{checkpointAtFirstAwait:true});
  assert.equal(fixture.producerRevision,packet.producer.revision);
  assert.equal(recheck.sourceValidated,true);
  const rows=artifact.public.timeline;
  const eviction=rows.findIndex(row=>row.kind==='source-evict');
  const read=rows.findIndex((row,index)=>index>eviction&&row.kind==='source-read');
  assert.ok(eviction>0&&read>eviction);
  for(const key of ['session','track','programId','digest'])assert.equal(rows[eviction].fields[key],rows[read].fields[key]);
  assert.equal(rows[read].fields.source,fixture.source);
  assert.equal(rows.filter(row=>row.kind==='dispatch').length,2);
});

test('recovery original-source and shared public replay recheck freshly',async()=>{
  // Historical receipts intentionally bind their old implementation/runtime.
  // Recollect the same source/input at the code under test; never rebind a receipt.
  const result=await verifyRegionTrainingCase({...packet.cases[0].fixture,producerRevision:'fresh-test-collection'});
  assert.equal(result.status,'locally_verified');
  assert.deepEqual(result.exported.public,packet.cases[0].artifact.public);
  assert.deepEqual(result.exported.contexts,packet.cases[0].artifact.contexts);
  const checked=await recheckRegionEvidence(result.exported);
  assert.equal(checked.valid,true);
  assert.equal(checked.sourceValidated,true);
  assert.equal(checked.replayValidated,true);
});

test('source reread cannot substitute different source bytes',async()=>{
  const result=await verifyRegionTrainingCase({...packet.cases[0].fixture,producerRevision:'fresh-test-collection'});
  const altered=structuredClone(result.exported);
  altered.public.timeline.find(row=>row.kind==='source-read').fields.source+='\n/* changed */';
  await assert.rejects(()=>recheckRegionEvidence(altered));
});
