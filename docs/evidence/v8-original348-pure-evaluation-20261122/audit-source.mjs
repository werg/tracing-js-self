#!/usr/bin/env node
// Offline independent replay. No selector or native process is constructed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [producerPath, evidencePath] = process.argv.slice(2);
assert(producerPath && evidencePath, 'producer and extracted evidence required');
const producer = resolve(producerPath), root = resolve(evidencePath);
const {prepareRegionExecutionCase, validateRegionExecutionStudy, scoreSelectedRegionExecution} =
  await import(pathToFileURL(join(producer, 'src/semantic/execution-study-v8.js')));
const {hashAlgorithmData} = await import(pathToFileURL(join(producer, 'src/semantic/program.js')));
const {decodeCausalLmV8Target} = await import(pathToFileURL(join(producer, 'src/semantic/causal-lm-v8.js')));
const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const profile = read('predeclared-profile.json'), aggregate = read('report.json');
const expected = {train: 12, validation: 3, test: 1};
const settings = {device: 'cpu', maxTokens: 128, maxFragments: 8, effort: 1};
const limits = {maxPredictions: 32, maxGenerated: 128, maxOutstanding: 16, maxStaleRetries: 0, timeoutMs: 300000};
assert.equal(profile.cases.length, 16);
assert.equal(new Set(profile.cases.map(row => row.id)).size, 16);
const out = [];
for (const [split, count] of Object.entries(expected)) {
  const study = read(`studies/${split}/study.json`), privateCases = read(`studies/${split}/private-cases.json`);
  validateRegionExecutionStudy(study);
  assert.equal(study.declared, count);
  assert.equal(study.cases.length, count);
  assert.equal(privateCases.length, count);
  assert.deepEqual(study.seeds, [17]);
  assert.deepEqual(study.settings, settings);
  assert.deepEqual(study.limits, limits);
  assert.equal(study.origin, 'model');
  assert.deepEqual(study.cases.map(row => row.id).sort(), profile.cases.filter(row => row.split === split).map(row => row.id).sort());
  for (const item of study.cases) {
    const source = read(`source-cases/${item.id}.json`);
    const prepared = prepareRegionExecutionCase({id: item.id, artifact: source});
    const privateCase = privateCases.find(row => row.id === item.id);
    assert.deepEqual(privateCase, prepared);
    const {expectedArtifact, ...publicCase} = prepared;
    assert.deepEqual(item, publicCase);
    assert.deepEqual(item.request.fixture, {calls: [], settlementOrder: null});
    assert.equal(item.request.initialPublic.timeline.length, 2);
    assert(item.request.initialPublic.timeline.every(row => row.mode === 'observed'));
    assert(!('expectedArtifact' in item));
    const report = read(`case-results/${item.id}/report.json`);
    assert.deepEqual(read(`case-results/${item.id}/study.json`), study);
    assert.equal(report.studyDigest, study.digest);
    assert.equal(report.declared, count);
    assert.equal(report.rows.length, count);
    assert.deepEqual(report.rows.map(row => [row.caseId, row.seed]).sort(), study.cases.map(row => [row.id, 17]).sort());
    assert(report.rows.every(row => row.caseId === item.id || row.status === 'untested' && row.result === null));
    for (const key of ['checkpointIdentity', 'tokenizerIdentity', 'trainingIdentity']) {
      assert.equal(report[key], study[key]);
      assert.equal(study[key], aggregate.identities[key]);
    }
    assert.deepEqual(report.settings, settings);
    assert.equal(report.origin, 'model');
    assert.equal(report.qualification.optimizerSteps, 0);
    const row = report.rows.find(row => row.caseId === item.id);
    assert.equal(row.failure ?? null, null, 'private scorer failed');
    assert(row.result, 'missing attempted result');
    const result = row.result;
    const {digest, ...body} = result;
    assert.equal(digest, hashAlgorithmData(body), 'original result digest differs');
    const rescored = await scoreSelectedRegionExecution(result, expectedArtifact);
    assert.deepEqual(rescored, result, 'independent private source replay differs');
    assert.equal(result.sourceEvidence.sourceValidated, true);
    assert.equal(result.sourceEvidence.expectedArtifactDigest, hashAlgorithmData(source));
    assert.equal(result.seed, 17);
    assert.equal(result.origin, 'model');
    assert.equal(result.optimizerSteps, 0);
    assert.deepEqual(result.generationSettings, settings);
    for (const key of ['checkpointIdentity', 'tokenizerIdentity', 'trainingIdentity']) {
      assert.equal(result[key], study[key]);
      assert.equal(result.inferenceIdentity[key], study[key]);
    }
    assert.equal(result.inferenceIdentity.seed, 17);
    assert.deepEqual(result.inferenceIdentity.generationSettings, settings);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.costs.accepted, 0);
    assert.equal(result.costs.rejected, 1);
    assert.equal(result.costs.hostDispatches, 0);
    assert.equal(result.sourceValidated, false);
    assert.equal(result.completedExecution, false);
    assert.equal(result.publicCompleted, false);
    assert.equal(result.publicAccepted, false);
    assert.deepEqual({...result.public, timeline: result.public.timeline.slice(0, 2)}, prepared.request.initialPublic);
    const cleanupRows = result.public.timeline.slice(2);
    assert(cleanupRows.length <= 1 && cleanupRows.every(entry => entry.mode === 'observed' && entry.kind === 'cancel' &&
      entry.fields.reason === result.failure.message), 'failure appended generated work or unrelated host events');
    assert.deepEqual(result.contexts, []);
    const attempt = result.attempts[0], selection = attempt.selection ?? attempt.evidence?.selection;
    assert(selection && selection.modelSelected === true && selection.origin === 'actual-model-selected');
    for (const key of ['checkpointIdentity', 'tokenizerIdentity', 'trainingIdentity']) assert.equal(selection[key], study[key]);
    assert.equal(selection.prefixDigest, attempt.prefixDigest);
    assert.equal(selection.contextDigest, hashAlgorithmData(attempt.context));
    assert.equal(selection.session, prepared.request.initialPublic.timeline[0].fields.session);
    assert.equal(selection.invocationId, attempt.invocationId);
    const fragmentShape = selection.fragments.every(fragment => Array.isArray(fragment.tokenIds) && fragment.tokenIds.length > 0 &&
      fragment.tokenIds.every(id => Number.isSafeInteger(id) && id >= 0) && typeof fragment.payloadHex === 'string' && /^(?:[0-9a-f]{2})*$/.test(fragment.payloadHex));
    const payloadComplete = fragmentShape && selection.fragments.map(fragment => fragment.payloadHex).join('') === selection.payloadHex;
    const validated = attempt.provenanceValidated === true;
    assert.equal(validated, payloadComplete, 'observed producer binding differs from retained fragments');
    assert.equal(result.failure.evidence.provenanceValidated, validated);
    assert.equal(result.costs.unknownGenerationCostAttempts, validated ? 0 : 1);
    let decoder = 'no-complete-record';
    if (attempt.record !== null) {
      assert.equal(Buffer.from(attempt.record).toString('hex'), selection.payloadHex);
      try { decodeCausalLmV8Target(attempt.record); decoder = 'accepted'; }
      catch (error) { decoder = String(error.message); }
      assert.notEqual(decoder, 'accepted', 'a canonical record was incorrectly called malformed');
    }
    const aggregateRow = aggregate.rows.find(row => row.caseId === item.id);
    assert.equal(aggregateRow.actualModelMeasured, validated);
    assert.equal(aggregateRow.completedExecution, false);
    assert.equal(row.sourceValidated, false);
    assert.equal(row.completedExecution, false);
    out.push({caseId: item.id, split, resultDigest: digest, sourceRecheck: true,
      sourceExpectedArtifactDigest: item.expectedArtifactDigest, sourceScoringComplete: true,
      requestDigest: item.requestDigest, studyDigest: study.digest, modelAttempt: true,
      selectionProvenanceValidated: validated, allFragmentPayloadsInAggregate: payloadComplete,
      fragmentShapeValid: fragmentShape, completeProgram: false,
      completeRecord: typeof attempt.record === 'string', canonicalRecord: false, observedCancellationRows: cleanupRows.length,
      decoderOutcome: decoder, originalError: result.failure.message,
      costs: result.costs, nativeMetricsBefore: result.nativeMetricsBefore, nativeMetricsAfter: result.nativeMetricsAfter,
      privateExpectedAnswersInSelectorInput: false});
  }
}
assert.equal(out.length, 16);
process.stdout.write(JSON.stringify({schema: 'semantic-v8-original348-source-audit/1',
  auditStatus: 'passed', originalMeasurementStatus: aggregate.status, sourceScoringComplete: 16,
  selectionProvenanceValidated: out.filter(row => row.selectionProvenanceValidated).length,
  completePrograms: 0, declared: 16, optimizerUpdatesPerformed: 0,
  modelCallsPerformed: 0, rows: out}, null, 2) + '\n');
