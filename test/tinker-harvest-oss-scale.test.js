import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  OSS_REPO_CATALOG,
  auditHarvestedDataset,
  buildMultiFilePackagesV2,
  discoverCallableExports,
  extractRuntimeSpecifiers,
  generateAst1LineMutations,
  harvestSingleRepo,
  isRepoForbidden,
} from '../tools/tinker-harvest-oss-multifile-js-scale.mjs';

test('extractRuntimeSpecifiers ignores TS import type / export type and keeps runtime specifiers', () => {
  const tsCode = `
    import type { ExternalType } from 'some-external-lib';
    import { type OnlyType, helper } from './helper.js';
    export type { Foo } from 'another-external';
    export * from './barrel.js';
    export const x = helper(1);
  `;
  const specs = extractRuntimeSpecifiers(tsCode, 'src/index.ts');
  assert.deepEqual(specs.sort(), ['./barrel.js', './helper.js']);
});

test('OSS_REPO_CATALOG has >= 100 diverse repos and >= 50% TypeScript', () => {
  assert.ok(OSS_REPO_CATALOG.length >= 100, `expected >= 100 repos, got ${OSS_REPO_CATALOG.length}`);
  const tsCount = OSS_REPO_CATALOG.filter(r => r.lang === 'ts').length;
  assert.ok(tsCount / OSS_REPO_CATALOG.length >= 0.5, `expected >= 50% TS, got ${tsCount}/${OSS_REPO_CATALOG.length}`);
  const slugs = new Set(OSS_REPO_CATALOG.map(r => r.slug));
  assert.equal(slugs.size, OSS_REPO_CATALOG.length, 'duplicate slugs in OSS_REPO_CATALOG');
});

test('isRepoForbidden blocks matching repo names and allows unrelated repos', () => {
  const forbidden = {
    repos: new Set(['jgm__djot.js', 'darkreader__darkreader']),
    repoNamesNormalized: new Set(['djot.js', 'djot', 'darkreader', 'acorn']),
  };
  assert.equal(isRepoForbidden({slug: 'jgm__djot-js', github: 'jgm/djot.js'}, forbidden), true);
  assert.equal(isRepoForbidden({slug: 'acornjs__acorn', github: 'acornjs/acorn'}, forbidden), true);
  assert.equal(isRepoForbidden({slug: 'eemeli__yaml', github: 'eemeli/yaml'}, forbidden), false);
});

test('generateAst1LineMutations produces syntax-valid 1-line TS mutations', () => {
  const tsSource = `
    export function score(items: number[], threshold: number): number {
      let total = 0;
      for (let i = 0; i < items.length; i++) {
        if (items[i] >= threshold) {
          total = total + items[i] + 1;
        }
      }
      return total;
    }
  `;
  const muts = generateAst1LineMutations(tsSource, 'src/score.ts');
  assert.ok(muts.length >= 3, `expected >= 3 mutations, got ${muts.length}`);
  for (const m of muts) {
    assert.notEqual(m.beforeLine, m.afterLine);
    const origLines = tsSource.split('\n');
    const mutLines = m.mutated.split('\n');
    assert.equal(origLines.length, mutLines.length);
    let diffCount = 0;
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i] !== mutLines[i]) diffCount++;
    }
    assert.equal(diffCount, 1, 'mutation must change exactly 1 line');
  }
});

test('harvestSingleRepo harvests TS barrel exports, Mode A real-test args, Mode C 1-line mutation pairs, and passes audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-scale-v2-test-'));
  try {
    mkdirSync(join(root, 'src'), {recursive: true});
    mkdirSync(join(root, 'test'), {recursive: true});

    writeFileSync(join(root, 'src', 'index.ts'), `
      export * from './pipeline.js';
      export type { ScoreReport } from './types.js';
    `);
    writeFileSync(join(root, 'src', 'types.ts'), `
      export interface ScoreReport {
        total: number;
        passed: number;
        tier: string;
      }
    `);
    writeFileSync(join(root, 'src', 'pipeline.ts'), `
      import type { ScoreReport } from './types.js';
      import { computeWeighted } from './math.js';
      import { classifyTier } from './tier.js';

      export function evaluateScores(values: number[], cutoff: number): ScoreReport {
        const { total, passed } = computeWeighted(values, cutoff);
        const tier = classifyTier(total);
        return { total, passed, tier };
      }
    `);
    writeFileSync(join(root, 'src', 'math.ts'), `
      export function computeWeighted(values: number[], cutoff: number): { total: number; passed: number } {
        let total = 0;
        let passed = 0;
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (v >= cutoff) {
            total += v * 2 + 1;
            passed += 1;
          }
        }
        return { total, passed };
      }
    `);
    writeFileSync(join(root, 'src', 'tier.ts'), `
      export function classifyTier(score: number): string {
        if (score >= 40) return 'gold';
        if (score >= 20) return 'silver';
        return 'bronze';
      }
    `);
    // Distractor files
    writeFileSync(join(root, 'src', 'distractorA.ts'), `export function unusedAlpha(x: number): number { return x * 3; }\n`);
    writeFileSync(join(root, 'src', 'distractorB.ts'), `export function unusedBeta(s: string): string { return s.toUpperCase(); }\n`);

    // Real unit test file
    writeFileSync(join(root, 'test', 'pipeline.test.ts'), `
      import { evaluateScores } from '../src/index.js';
      test('scores', () => {
        expect(evaluateScores([10, 15, 3, 20], 10)).toEqual({ total: 93, passed: 3, tier: 'gold' });
      });
    `);

    const packages = buildMultiFilePackagesV2(root, {minFiles: 5, maxFiles: 20});
    assert.ok(packages.length >= 1, 'should build at least one multi-file TS package');
    const entryPkg = packages.find(p => p.entryFile === 'src/index.ts');
    assert.ok(entryPkg, 'should find src/index.ts barrel entry');

    const {exports: discovered} = discoverCallableExports(entryPkg.files, entryPkg.entryFile);
    assert.ok(discovered.includes('evaluateScores'), 'should discover barrel re-exported function');

    const emptyForbidden = {
      ids: new Set(), families: new Set(), sourceHashes: new Set(),
      splitComponents: new Set(), repos: new Set(), repoNamesNormalized: new Set(),
    };
    const emptyStage10 = {ids: new Set(), sourceHashes: new Set()};

    const rows = await harvestSingleRepo({
      repoEntry: {slug: 'testorg__score-ts', github: 'testorg/score-ts', domain: 'utility', lang: 'ts', license: 'MIT'},
      repoDir: root,
      forbidden: emptyForbidden,
      stage10: emptyStage10,
      usedIds: new Set(),
      usedHashes: new Set(),
      maxPerRepo: 4,
      maxPerFn: 2,
      minFiles: 5,
      maxFiles: 20,
      maxPairsPerRepo: 1,
      enableMutations: true,
    });

    assert.ok(rows.length >= 2, `expected >= 2 rows (base + mutated pair), got ${rows.length}`);
    const paired = rows.filter(r => Boolean(r.pair_id));
    assert.equal(paired.length, 2, 'should emit a complete 2-row counterfactual mutation pair');
    assert.equal(paired[0].pair_id, paired[1].pair_id);
    assert.equal(paired[0].split_component, paired[1].split_component);
    assert.notEqual(paired[0].sourceHash, paired[1].sourceHash);
    assert.equal(paired[0].metadata.harvestMode, 'real-test');
    assert.equal(paired[1].metadata.harvestMode, 'oss-mutation-pair');

    const audit = auditHarvestedDataset(rows, {forbidden: emptyForbidden, stage10: emptyStage10});
    assert.equal(audit.checks.zero_leakage_realexecbench.passed, true);
    assert.equal(audit.checks.stage10_dedup.passed, true);
    assert.equal(audit.checks.preexported_schema.passed, true);
    assert.equal(audit.checks.determinism_2x.passed, true);
    assert.equal(audit.checks.token_bounds.passed, true);
    assert.equal(audit.totals.mutation_pairs_complete, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
