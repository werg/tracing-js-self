import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import vm from 'node:vm';
import {ASYNC_ITERATION_FIXTURES_V8} from '../../fixtures/semantic-regions/async-iteration.js';
import {hashAlgorithmData} from '../../src/semantic/program.js';

export const SYNC_REJECTION_FIXTURE_ID='source-async-iterator-sync-rejection';
export const SYNC_REJECTION_REFERENCE_MISMATCH=/original or instrumented completion graph differs from owned execution/;

export async function observeSyncRejectionReference(){
  const fixture=ASYNC_ITERATION_FIXTURES_V8.find(row=>row.id===SYNC_REJECTION_FIXTURE_ID);
  assert.equal(fixture.expected,'c7');
  const outcome=await vm.runInNewContext(fixture.source+';run();',{}, {timeout:1000});
  // AsyncFromSyncIteratorContinuation closes a non-done rejected value when
  // next() passes closeOnRejection=true. Older engines omit that close.
  // https://tc39.es/ecma262/#sec-asyncfromsynciteratorcontinuation
  assert(['c7','7'].includes(outcome),'unexpected original sync-rejection outcome: '+outcome);
  return {fixture,referenceOutcome:outcome,sourceAgreement:outcome===fixture.expected};
}

export function assertSyncRejectionRefusal(result){
  assert.equal(result.id,SYNC_REJECTION_FIXTURE_ID);
  assert.equal(result.status,'failed');
  assert.equal(result.phase,'owned-and-independent-source');
  assert.equal(result.category,'reference_mismatch');
  assert.equal(result.regionDisposition,'source-unqualified');
  assert.match(result.reason,SYNC_REJECTION_REFERENCE_MISMATCH);
  assert.equal(Object.hasOwn(result,'exported'),false);
}

export function committedProtocolRegionCases(){
  const packet=JSON.parse(gunzipSync(Buffer.from(readFileSync(
    new URL('../fixtures/semantic-protocol-region-v8.json.gz.b64',import.meta.url),'utf8'),'base64')));
  assert.equal(packet.schema,'semantic-protocol-region-fixtures/1');
  return packet.cases;
}

export function authenticateCommittedSyncRejection(row,fixture){
  assert.equal(row.id,SYNC_REJECTION_FIXTURE_ID);
  assert.deepEqual(row.fixture,fixture);
  const side=row.artifact.sidecar,source=side.sourceArtifact.sidecar;
  assert.equal(source.referenceInput.source,fixture.source);
  assert.equal(source.referenceInput.entry,fixture.entry);
  assert.deepEqual(source.referenceInput.inputGraph,{schema:'owned-graph/1',roots:[],objects:[]});
  assert.equal(source.referenceInput.awaitReturnedPromise,true);
  assert.equal(side.sourceArtifactDigest,hashAlgorithmData(side.sourceArtifact));
  assert.equal(side.publicDigest,hashAlgorithmData(row.artifact.public));
  assert.equal(side.contextDigest,hashAlgorithmData(row.artifact.contexts));
  assert.equal(source.archiveDigest,hashAlgorithmData(source.archive));
  assert.deepEqual(source.outcome,{kind:'return',graph:{roots:[['str','c7']],objects:[]}});
  return row.artifact;
}
