import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyRegionTrainingCase,recheckRegionEvidence,buildRegionDataset,
  PROTOCOL_REGION_EVIDENCE_V8_SCHEMA} from '../src/semantic/index.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {auditProtocolSourceV8} from '../src/semantic/protocol-source-reference-v8.js';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/semantic-protocol-region-v8.json',import.meta.url))).cases;
const cache=new Map();
async function qualified(id){
  if(!cache.has(id))cache.set(id,verifyRegionTrainingCase(fixtures.find(row=>row.id===id).fixture));
  const result=await cache.get(id);assert(result.exported,result.reason);return structuredClone(result);
}
const tokenizer={identity:'e'.repeat(64),encode:text=>[...Buffer.from(text)],decode:ids=>Buffer.from(ids)};

test('the common source API routes qualified Symbol and memory protocols through their independent evidence',async()=>{
  for(const id of ['source-symbol-getter-arithmetic','typed-views-shared-backing']){
    const result=await qualified(id);
    assert.equal(result.exported.sidecar.schema,PROTOCOL_REGION_EVIDENCE_V8_SCHEMA);
    assert(result.regionCoverage.protocolRecords>0);
    assert.equal(result.regionAttempts[0].status,'projection_refused');
    assert.equal((await recheckRegionEvidence(result.exported)).sourceValidated,true);
    await assert.rejects(recheckRegionEvidence(result.exported,{requireNative:true}),/native admission/);
    const forged=structuredClone(result.exported);forged.contexts.at(-1).state.receiver=['num',99];
    await assert.rejects(recheckRegionEvidence(forged),/altered direct source evidence/);
  }
});

test('protocol source exports preserve original families and supervise only complete generated records',async()=>{
  const candidates=await Promise.all(['source-symbol-getter-arithmetic','typed-views-shared-backing'].map(qualified));
  const held=candidates[0].family;
  const result=await buildRegionDataset(candidates,{tokenizer,eosTokenId:256,maxContextTokens:1000000,
    allowLocal:true,seed:17,families:[held]});
  assert.equal(result.dispositions.length,2);assert(result.dispositions.every(row=>row.status==='exported'));
  assert.equal(result.dispositions[0].split,'test');
  assert.equal(result.dispositions[0].family,held);
  const examples=Object.values(result.examplesBySplit).flat();
  assert.equal(examples.length,candidates.reduce((sum,row)=>sum+row.exported.contexts.length,0));
  assert(examples.some(row=>row.target.startsWith('protocol ')));
  for(const row of examples){
    assert.deepEqual(row.labels.slice(0,row.boundaries.promptTokens),Array(row.boundaries.promptTokens).fill(-100));
    assert.deepEqual(row.labels.slice(row.boundaries.promptTokens),[...Buffer.from(row.target),256]);
    assert(!row.prompt.includes('sourceArtifact'));assert(!row.prompt.includes('metadataAudit'));
    assert.equal(row.metadata.nativeAdmission,false);
  }
});

test('source disagreement and owned resource refusals are never relabeled as alternate qualification',async()=>{
  const result=await qualified('typed-views-shared-backing'),source=result.exported.sidecar.sourceArtifact.sidecar;
  const outcome=structuredClone(source.outcome);outcome.graph.roots.at(-1)[1]='wrong-reference';
  await assert.rejects(auditProtocolSourceV8({bundle:source.archive,referenceInput:source.referenceInput,outcome}),
    error=>error.category==='reference_mismatch'&&/differs from owned execution/.test(error.message));
  const fixture={source:'"use strict";function run(){while(true){}return 1;}',entry:'run',args:[],
    family:'bounded-source',maxSteps:20};
  const original=await verifyEffectfulTrainingCase({...fixture,projectionOptions:{semanticRegions:false,localStateCompaction:false}}),
    routed=await verifyRegionTrainingCase(fixture);
  assert(!original.exported);assert.equal(routed.status,original.status);assert.equal(routed.category,original.category);
  assert.equal(routed.phase,original.phase);assert.equal(routed.regionAttempts,undefined);assert(!routed.exported);
});
