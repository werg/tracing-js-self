#!/usr/bin/env python3
"""Retrospectively authenticate existing diagnostic artifacts without inference.

Original cohorts, reports, model weights, requests and emitted bytes are only
read. This separate receipt does not claim its checks ran before the experiment.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('diagnostic_holdout',
                                             Path(__file__).with_name('run-exploratory-holdout.py'))
holdout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(holdout)
smoke = holdout.smoke


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def audit_rollouts(report, cases, bundles, checked_bundles, root):
    by_id = {case['id']: case for case in cases}
    if len(by_id) != len(cases):
        raise ValueError('Diagnostic case identities are duplicated')
    seen, rows = set(), []
    for row in report['rollouts']:
        origin, case_id = row['origin'], row['id']
        if origin not in bundles or case_id not in by_id or (origin, case_id) in seen:
            raise ValueError('Diagnostic rollout membership/origin is unexpected or duplicated')
        seen.add((origin, case_id))
        case, directory = by_id[case_id], Path(row['artifacts']).resolve()
        if not directory.is_relative_to(root.resolve()):
            raise ValueError('Diagnostic rollout artifact path escapes its original run')
        actual = json.loads((directory / 'result.json').read_text())
        profile = json.loads((directory / 'serving-profile.json').read_text())
        for name, expected in [('request.json', case['envelope']), ('private-expected.json', case['expected'])]:
            if canonical(json.loads((directory / name).read_text())) != canonical(expected):
                raise ValueError('Original diagnostic request or private expectation differs from the frozen case')
        if profile.get('identity', {}).get('manifestSha256') != checked_bundles[origin]['manifestSha256']:
            raise ValueError('Original serving profile refers to a different actual served manifest')
        success = smoke.score_rollout(actual, case, origin, bundles[origin], profile)
        if type(row.get('wholeTaskSuccess')) is not bool or row['wholeTaskSuccess'] != success:
            raise ValueError('Original diagnostic success label differs from strict rescoring')
        if (canonical(row.get('hardGates')) != canonical(actual['hardGates']) or
                canonical(row.get('cleanup')) != canonical(actual['outcome']['cleanup']) or
                canonical(row.get('failure')) != canonical(actual['failure'])):
            raise ValueError('Original summary differs from raw gates, cleanup, or failure evidence')
        wall = row.get('wallSeconds')
        if type(wall) not in (int, float) or not math.isfinite(wall) or wall < 0:
            raise ValueError('Original diagnostic elapsed time is invalid')
        fragments = [fragment for decision in actual.get('selections', [])
                     for fragment in decision.get('selection', {}).get('fragments', [])]
        fragments += ((actual.get('failure') or {}).get('evidence') or {}).get('fragments', [])
        unique = {canonical(fragment): fragment for fragment in fragments}
        emitted = sum(len(fragment['emittedTokenIds']) for fragment in unique.values())
        if 'originalEmittedTokens' in row and row['originalEmittedTokens'] != emitted:
            raise ValueError('Original token count differs from retained native token fragments')
        rows.append({**row, 'family': case['family'], 'wholeTaskSuccess': success,
                     'originalEmittedTokens': emitted,
                     'artifactSha256': {name: smoke.sha256(directory / name) for name in
                                       ['request.json', 'private-expected.json', 'result.json', 'serving-profile.json', 'stderr.log']}})
    expected = {(origin, case['id']) for origin in bundles for case in cases}
    if seen != expected:
        raise ValueError('Original diagnostic did not retain every paired rollout')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['training-run', 'cohort', 'heldout-run', 'consumer-root', 'tracer-root', 'tokenizer-json', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    cohort_path = args.cohort.resolve()
    training_path, heldout_path = args.training_run.resolve() / 'report.json', args.heldout_run.resolve() / 'report.json'
    originals = {str(path): smoke.sha256(path) for path in [cohort_path, training_path, heldout_path]}
    cohort, training, measured = [json.loads(path.read_text()) for path in [cohort_path, training_path, heldout_path]]
    if (cohort.get('schema') not in {'exploratory-heldout-diagnostic-cohort/1', 'exploratory-heldout-diagnostic-cohort/2'} or
            measured.get('status') != 'completed' or measured.get('cohortSha256') != originals[str(cohort_path)] or
            cohort['trainingReport']['sha256'] != originals[str(training_path)]):
        raise ValueError('Original diagnostic cohort or training/report binding differs')
    consumer, tracer = args.consumer_root.resolve(), args.tracer_root.resolve()
    smoke.require_clean_checkout(consumer); smoke.require_clean_checkout(tracer)
    if (smoke.git_head(consumer) != cohort['consumerRevision'] or smoke.git_head(tracer) != cohort['producerRevision'] or
            smoke.sha256(args.tokenizer_json) != cohort['tokenizerSha256']):
        raise ValueError('Audit must use the actual original consumer, producer and tokenizer')
    env = {**os.environ, 'PYTHONPATH': str(consumer / 'src'), 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
    rebuilt_path = root / 'retrospectively-rebuilt-cohort.json'
    command = ['node', str(Path(__file__).with_name('build-exploratory-holdout.mjs')),
               '--training-run', str(args.training_run.resolve()), '--tracer-root', str(tracer),
               '--consumer-root', str(consumer), '--tokenizer-json', str(args.tokenizer_json.resolve()),
               '--python', sys.executable, '--registry', cohort['registry']['path'], '--output', str(rebuilt_path),
               '--maximum', str(len(cohort['cases'])), '--seed', str(cohort['seed'])]
    for source in cohort['sourceCorpora']:
        command.extend(['--corpus', source['path']])
    smoke.run_logged(command, root / 'inventory-cohort-audit.log', env=env, timeout=240)
    rebuilt = json.loads(rebuilt_path.read_text())
    excluded = {'schema', 'createdAt', 'builderSha256', 'trainingInventory'}
    if canonical({key: value for key, value in cohort.items() if key not in excluded}) != canonical(
            {key: value for key, value in rebuilt.items() if key not in excluded}):
        raise ValueError('Authenticated actual-training exclusion changes the original frozen diagnostic cohort')
    sys.path.insert(0, str(consumer / 'src'))
    import torch
    torch.set_num_threads(1)
    bundles = {'fixed-weights': training['baseBundle'], 'trained': training['trainedBundle']}
    checked = {
        'fixed-weights': holdout.verify_bundle(bundles['fixed-weights'], training['initialCheckpoint'],
            training['initialTrainingState']['baseCheckpointSha256'], cohort['tokenizerSha256'], cohort['tokenizerIdentity']),
        'trained': holdout.verify_bundle(bundles['trained'], training['checkpointVerification']['checkpoint'],
            training['checkpointVerification']['stateSha256'], cohort['tokenizerSha256'], cohort['tokenizerIdentity'])}
    if checked['fixed-weights']['modelSha256'] == checked['trained']['modelSha256']:
        raise ValueError('Diagnostic trained model is identical to its base')
    rows = audit_rollouts(measured, cohort['cases'], bundles, checked, args.heldout_run)
    summary = holdout.summarize(rows)
    if canonical(summary) != canonical(measured['summary']):
        raise ValueError('Strict rescoring changes the original descriptive held-out summary')
    held_in_cases = json.loads((args.training_run / 'private-cases.json').read_text())['cases']
    held_in_ids = {row['id'] for row in training['rollouts']}
    held_in_cases = [case for case in held_in_cases if case['id'] in held_in_ids]
    held_in_rows = audit_rollouts(training, held_in_cases, bundles, checked, args.training_run)
    from megatoken.data.semantic_corpus import verify_admission
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer_json, expected_sha256=cohort['tokenizerSha256'])
    admissions = []
    for index, case in enumerate(cohort['cases']):
        path = args.heldout_run / 'admission' / f'{index:04d}.json'
        receipt = json.loads(path.read_text())
        document = json.loads(Path(case['inputPath']).read_text())
        if (receipt['id'] != case['id'] or receipt['sourceCluster'] != case['sourceCluster'] or
                receipt['inputSha256'] != case['inputSha256']):
            raise ValueError('Original native/source admission receipt is attached to a different case')
        verify_admission(document, receipt['source'], receipt['native'], producer_revision=cohort['producerRevision'],
                         consumer_revision=cohort['consumerRevision'], codec=codec)
        admissions.append({'id': case['id'], 'receiptSha256': smoke.sha256(path), 'originalReceiptBindingValid': True})
        del document
    for path, before in originals.items():
        if smoke.sha256(path) != before:
            raise ValueError('An original diagnostic artifact changed during read-only auditing')
    receipt = {'schema': 'exploratory-diagnostic-retrospective-audit/1', 'createdAt': datetime.now(timezone.utc).isoformat(),
        'retrospective': True, 'originalOutputsModified': False, 'newInferenceCalls': 0, 'newOptimizerUpdates': 0,
        'purpose': 'diagnostic', 'productionQualification': False, 'generalizationClaim': False,
        'auditRevision': smoke.git_head(Path(__file__).resolve().parent.parent),
        'auditCodeSha256': {name: smoke.sha256(Path(__file__).with_name(name)) for name in
            ['audit-exploratory-evidence.py', 'run-exploratory-holdout.py', 'run-optimization-smoke.py',
             'diagnostic_training_inventory.py', 'build-exploratory-holdout.mjs']},
        'originalArtifacts': originals, 'originalCohortSchema': cohort['schema'],
        'retrospectivelyRebuiltCohortSha256': smoke.sha256(rebuilt_path),
        'actualTrainingInventory': rebuilt['trainingInventory'], 'frozenMembershipUnchanged': True,
        'bundles': checked, 'originalAdmissionReceipts': admissions,
        'heldIn': {'pairedCases': len(held_in_cases), 'rollouts': held_in_rows, 'summary': holdout.summarize(held_in_rows)},
        'heldOut': {'pairedCases': len(cohort['cases']), 'rollouts': rows, 'summary': summary},
        'limitations': ['This verification ran after inference; it is not a pre-run qualification receipt.',
            'The original one-seed tiny P1 diagnostic remains outside production SE/SC comparison requirements.',
            'Zero complete executions provide no evidence of learned behavioral generalization.']}
    smoke.write_json(root / 'audit.json', receipt)
    print(json.dumps({'audit': str(root / 'audit.json'), 'frozenMembershipUnchanged': True,
                      'preparedExamples': rebuilt['trainingInventory']['preparedExamples'],
                      'heldOut': summary}))


if __name__ == '__main__':
    main()
