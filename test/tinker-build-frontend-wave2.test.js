import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {
  buildAllCandidates,
  exportAndVerifyTaskTwice,
  runZeroLeakageAudit,
  DEFAULT_BENCHMARK_JSONL,
  DEFAULT_BENCHMARK_MANIFEST,
  MAX_TURN_TOKENS,
  MAX_CONTEXT_TOKENS,
  MAX_ASSISTANT_TURNS,
  MIN_MF_CODEBASE_TOKENS,
  MAX_MF_CODEBASE_TOKENS,
} from '../tools/tinker-build-frontend-wave2.mjs';
import {auditCausalPrefixPair} from '../src/training/tinker-supervision.js';

test('Wave 2 frontend builder produces >=200 tasks across >=55 families with >=30 causal pairs and >=30% TS multi-file', async () => {
  const candidates = await buildAllCandidates();
  assert.ok(candidates.length >= 200, `Expected >=200 candidates, got ${candidates.length}`);

  const ids = new Set(candidates.map(t => t.id));
  assert.equal(ids.size, candidates.length, 'All candidate IDs must be unique');

  const families = new Set(candidates.map(t => t.family));
  assert.ok(families.size >= 55, `Expected >=55 families, got ${families.size}`);

  const single = candidates.filter(t => !t.files);
  const mf = candidates.filter(t => Boolean(t.files));
  const mfTs = mf.filter(t => t.language === 'ts');

  assert.ok(single.length >= 115, `Expected >=115 single-file tasks, got ${single.length}`);
  assert.ok(new Set(single.map(t => t.family)).size >= 35, 'Expected >=35 single-file families');
  assert.ok(mf.length >= 80, `Expected >=80 multi-file tasks, got ${mf.length}`);
  assert.ok(new Set(mf.map(t => t.family)).size >= 20, 'Expected >=20 multi-file families');
  assert.ok(mfTs.length / mf.length >= 0.3, `Expected >=30% TS multi-file tasks, got ${mfTs.length}/${mf.length}`);

  for (const t of mf) {
    const fileCount = Object.keys(t.files).length;
    assert.ok(fileCount >= 25 && fileCount <= 160, `${t.id} fileCount ${fileCount} outside [25, 160]`);
  }

  const pairs = new Map();
  for (const t of candidates) {
    const pid = t.metadata?.pair_id;
    if (pid) {
      if (!pairs.has(pid)) pairs.set(pid, []);
      pairs.get(pid).push(t.id);
    }
  }
  const completePairs = [...pairs.values()].filter(g => g.length >= 2);
  assert.ok(completePairs.length >= 30, `Expected >=30 causal pair groups, got ${completePairs.length}`);
});

test('Wave 2 exportAndVerifyTaskTwice emits deterministic pre-exported rows and passing causal pairs', async () => {
  const candidates = await buildAllCandidates();
  const sfPairA = candidates.find(t => t.id === 'fe-w2-expense-claim-approved');
  const sfPairB = candidates.find(t => t.id === 'fe-w2-expense-claim-policy-422');
  const mfTsPairA = candidates.find(t => t.id === 'lc65k-fe-w2-clinical-trials-pair-commit');
  const mfTsPairB = candidates.find(t => t.id === 'lc65k-fe-w2-clinical-trials-pair-rollback');
  assert.ok(sfPairA && sfPairB && mfTsPairA && mfTsPairB);

  const [vSfA, vSfB, vMfA, vMfB] = await Promise.all([
    exportAndVerifyTaskTwice(sfPairA),
    exportAndVerifyTaskTwice(sfPairB),
    exportAndVerifyTaskTwice(mfTsPairA),
    exportAndVerifyTaskTwice(mfTsPairB),
  ]);

  for (const {row} of [vSfA, vSfB, vMfA, vMfB]) {
    assert.equal(row.schema, 'readable-js-execution/1');
    assert.ok(Array.isArray(row.messages) && row.messages.length > 0);
    assert.equal(typeof row.sourceHash, 'string');
    assert.ok(row.sourceHash.length > 0);
    assert.equal(typeof row.task, 'object');
    assert.equal(row.metadata.deterministic2xVerified, true);
    assert.ok(row.metadata.maxAssistantTurnTokens <= MAX_TURN_TOKENS);
    assert.ok(row.metadata.approxTokens <= MAX_CONTEXT_TOKENS);
    assert.ok(row.metadata.assistantTurns <= MAX_ASSISTANT_TURNS);
  }

  // Multi-file codebase token range
  assert.ok(
    vMfA.row.metadata.codebaseApproxTokens >= MIN_MF_CODEBASE_TOKENS &&
    vMfA.row.metadata.codebaseApproxTokens <= MAX_MF_CODEBASE_TOKENS,
    `Unexpected codebase tokens: ${vMfA.row.metadata.codebaseApproxTokens}`,
  );

  // Verify counterfactual causal prefix future-blindness & real divergence
  const sfAudit = auditCausalPrefixPair(vSfA.exported, vSfB.exported);
  assert.equal(sfAudit.passed, true);
  assert.equal(sfAudit.testedDivergence, true);

  const mfAudit = auditCausalPrefixPair(vMfA.exported, vMfB.exported);
  assert.equal(mfAudit.passed, true);
  assert.equal(mfAudit.testedDivergence, true);
});

test('Zero-leakage audit detects overlaps and passes cleanly on Wave 2 rows', () => {
  if (!existsSync(DEFAULT_BENCHMARK_JSONL)) return;
  const clean = [
    {id: 'fe-w2-synthetic-clean', family: 'frontend-w2:synthetic', sourceHash: '0'.repeat(64), split_component: '1'.repeat(64)},
  ];
  const passRes = runZeroLeakageAudit(clean, {
    benchmarkJsonlPath: DEFAULT_BENCHMARK_JSONL,
    manifestPath: DEFAULT_BENCHMARK_MANIFEST,
  });
  assert.equal(passRes.passed, true);
  assert.deepEqual(passRes.overlapCounts, {id: 0, family: 0, sourceHash: 0, split_component: 0});

  const leaky = [
    {id: 'frontend-auth-valid-token', family: 'frontend:auth-session-refresh', sourceHash: '0'.repeat(64), split_component: '1'.repeat(64)},
  ];
  const failRes = runZeroLeakageAudit(leaky, {
    benchmarkJsonlPath: DEFAULT_BENCHMARK_JSONL,
    manifestPath: DEFAULT_BENCHMARK_MANIFEST,
  });
  assert.equal(failRes.passed, false);
  assert.ok(failRes.overlapCounts.id >= 1);
  assert.ok(failRes.overlapCounts.family >= 1);
});
