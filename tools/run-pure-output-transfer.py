#!/usr/bin/env python3
"""Measure a separate code/input -> observable outcome endpoint via a model command.

The child sees only a strict semantic-pure-output-request/1. Private independent
expectations stay in this process and a separate graph-scoring subprocess.
Original response/output bytes and emitted token IDs remain evidence on failure.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import time
import traceback
from learning_evaluation import mean, paired_component_interval

SPEC = importlib.util.spec_from_file_location('optimization_smoke', Path(__file__).with_name('run-optimization-smoke.py'))
IO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IO)
GRAPH_TOOL = Path(__file__).with_name('pure-output-transfer.mjs')


def strict_json(raw):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('Duplicate JSON property: ' + key)
            value[key] = item
        return value
    def constant(value):
        raise ValueError('Non-JSON numeric constant: ' + value)
    return json.loads(raw, object_pairs_hook=object_pairs, parse_constant=constant)


def original_tokens(response, codec, request_sha, *, checkpoint, policy, maximum, case):
    fields = ['source', 'entry', 'inputGraph', 'randomSeed', 'completionPolicy', 'outputContract']
    model_input = {key: case['envelope'][key] for key in fields}
    model_input_sha = hashlib.sha256(json.dumps(model_input, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    if (response.get('schema') != 'semantic-pure-model-response/1' or
            response.get('caseId') != case['id'] or response.get('requestSha256') != request_sha or
            response.get('checkpointIdentity') != checkpoint or response.get('decoderSeed') != case['envelope']['decoderSeed'] or
            response.get('tokenizerIdentity') != codec.fingerprint or
            response.get('tokenizerSha256') != policy['tokenizerSha256'] or
            response.get('origin') not in ('actual-model', 'actual-native-model') or
            response.get('javascriptExecutedAtInference') is not False or response.get('teacherTraceProvided') is not False or
            response.get('generation', {}).get('maxTokens') != maximum or
            response.get('modelInputSha256') != model_input_sha or response.get('modelInputFields') != fields or
            response.get('routingMetadataInModelContext') is not False):
        raise ValueError('Model response changed source/input, seed, identity, budget or inference authority')
    if response['origin'] == 'actual-native-model' and response.get('consumerRevision') != policy['consumerRevision']:
        raise ValueError('Actual native consumer differs from the frozen policy')
    emissions = response.get('emissions')
    if not isinstance(emissions, list) or len(emissions) > 64:
        raise ValueError('Original emission evidence must be bounded')
    seen, fragments, tokens = set(), [], 0
    for emission in emissions:
        event, ids, payload = emission['selectedEventId'], emission['emittedTokenIds'], emission['payloadHex']
        if (not isinstance(event, str) or not event or event in seen or not isinstance(ids, list) or
                any(type(token) is not int or token < 0 for token in ids) or not isinstance(payload, str)):
            raise ValueError('Malformed or repeated original emission evidence')
        seen.add(event)
        if tokens + len(ids) > maximum:
            raise ValueError('Original decoder token budget exceeded')
        raw = bytes.fromhex(payload)
        if len(raw) > 65536 or codec.decode(ids) != raw:
            raise ValueError('Original native token IDs do not decode to original output bytes')
        tokens += len(ids)
        fragments.append(raw)
    raw = b''.join(fragments)
    if raw.hex() != response.get('payloadHex') or len(raw) > 65536 or tokens > maximum:
        raise ValueError('Original output bytes or token budget differ from emission receipts')
    return raw, tokens


def measure_case(case, destination, args, codec, policy, env):
    destination.mkdir(parents=True)
    request = json.dumps(case['envelope'], ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    subprocess.run(['node', str(GRAPH_TOOL), 'validate-request'], input=request,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
    (destination / 'request.json').write_bytes(request)
    IO.write_json(destination / 'private-expected.json', case['expected'])
    summary = {'id': case['id'], 'family': case['family'], 'sourceCluster': case['sourceCluster'],
               'checkpointIdentity': args.checkpoint_identity, 'wholeTaskSuccess': False,
               'validOutput': False, 'generatedTokens': None, 'retainedGeneratedTokensLowerBound': 0, 'artifacts': str(destination)}
    started = time.monotonic()
    def output_limit():
        resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024, 2 * 1024 * 1024))
    with (destination / 'model-response.bin').open('wb') as output, (destination / 'model-stderr.log').open('wb') as errors:
        process = subprocess.Popen([args.model_command, *args.model_args], stdin=subprocess.PIPE,
            stdout=output, stderr=errors, env=env, start_new_session=True, preexec_fn=output_limit)
        try:
            process.communicate(request, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            summary.update(pipelineFailure='model-timeout', returnCode=process.returncode)
        else:
            if process.returncode:
                summary.update(pipelineFailure='model-process-exit', returnCode=process.returncode)
    summary['wallSeconds'] = time.monotonic() - started
    if 'pipelineFailure' not in summary:
        try:
            original = (destination / 'model-response.bin').read_bytes()
            response = strict_json(original)
            # Retain bytes even if subsequent identity, UTF-8 or graph validation fails.
            if isinstance(response.get('payloadHex'), str):
                (destination / 'generated.bin').write_bytes(bytes.fromhex(response['payloadHex']))
            raw, tokens = original_tokens(response, codec, hashlib.sha256(request).hexdigest(),
                checkpoint=args.checkpoint_identity, policy=policy, maximum=args.max_tokens, case=case)
            complete = (response['generation'].get('emissionsComplete') is True or
                response.get('failure') is None and response['generation'].get('valid') is True and
                response['generation'].get('terminal') is True)
            summary.update(generatedTokens=tokens if complete else None, retainedGeneratedTokensLowerBound=tokens,
                originalPayloadSha256=hashlib.sha256(raw).hexdigest(),
                nativeFailure=response.get('failure'), generation=response['generation'],
                emissionIdentity=hashlib.sha256(json.dumps(response['emissions'], sort_keys=True).encode()).hexdigest(),
                modelIdentityAuthority=response['origin'])
            try:
                actual = strict_json(raw.decode('utf-8', errors='strict'))
            except (ValueError, UnicodeError) as error:
                summary.update(firstDivergence={'path': 'outcome', 'reason': 'invalid-original-model-json', 'message': str(error)})
            else:
                judged = subprocess.run(['node', str(GRAPH_TOOL), 'score'], input=json.dumps({
                    'expected': case['expected'], 'actual': actual,
                    'inputRootCount': len(case['envelope']['inputGraph']['roots'])}, allow_nan=False).encode(),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
                score = json.loads(judged.stdout)
                summary.update(validOutput=score['valid'], firstDivergence=score['firstDivergence'],
                    graphComparison=score,
                    wholeTaskSuccess=bool(score['correct'] and response.get('failure') is None and
                        response['generation'].get('valid') is True and response['generation'].get('terminal') is True))
        except (ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
            summary.update(pipelineFailure='invalid-model-evidence', evidenceError=str(error))
    summary['artifactsSha256'] = {path.name: IO.sha256(path) for path in sorted(destination.iterdir()) if path.is_file()}
    IO.write_json(destination / 'summary.json', summary)
    return summary


def metrics(rows):
    if not rows:
        raise ValueError('Empty pure-output measurements')
    groups = defaultdict(list)
    for row in rows:
        groups[row['sourceCluster']].append(int(row['wholeTaskSuccess']))
    successes = sum(row['wholeTaskSuccess'] for row in rows)
    complete_tokens = all(type(row['generatedTokens']) is int for row in rows)
    token_sum = sum(row.get('retainedGeneratedTokensLowerBound', row['generatedTokens'] or 0) for row in rows)
    wall = sum(row['wallSeconds'] for row in rows)
    return {'episodes': len(rows), 'independentComponents': len(groups), 'successes': successes,
        'familyWeightedWholeTaskSuccess': mean(mean(values) for values in groups.values()),
        'episodeWeightedWholeTaskSuccess': successes / len(rows),
        'components': {key: mean(values) for key, values in sorted(groups.items())},
        'validOutputRate': mean(row['validOutput'] for row in rows), 'wallSeconds': wall,
        'wallSecondsPerCorrectTask': wall / successes if successes else None,
        'generatedTokens': token_sum if complete_tokens else None,
        'retainedGeneratedTokensLowerBound': token_sum,
        'generatedTokensPerCorrectTask': token_sum / successes if successes and complete_tokens else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    run = sub.add_parser('run')
    run.add_argument('--cohort', type=Path, required=True)
    run.add_argument('--model-command', required=True)
    run.add_argument('--model-args', default='[]')
    run.add_argument('--checkpoint-identity', required=True)
    run.add_argument('--origin', choices=['fixed-weights', 'trained'], required=True)
    run.add_argument('--consumer-root', type=Path, required=True)
    run.add_argument('--tokenizer-json', type=Path, required=True)
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--max-tokens', type=int, default=128)
    run.add_argument('--timeout', type=int, default=120)
    compare = sub.add_parser('compare')
    compare.add_argument('--base', type=Path, required=True)
    compare.add_argument('--trained', type=Path, required=True)
    compare.add_argument('--output', type=Path, required=True)
    compare.add_argument('--bootstrap-seed', type=int, default=101)
    compare.add_argument('--bootstrap-replicates', type=int, default=2000)
    args = parser.parse_args()
    if args.operation == 'compare':
        base, trained = [strict_json(path.read_bytes()) for path in [args.base, args.trained]]
        if (base.get('status') != 'completed' or trained.get('status') != 'completed' or
                base.get('origin') != 'fixed-weights' or trained.get('origin') != 'trained' or
                base.get('schema') != 'semantic-pure-output-run/1' or trained.get('schema') != base['schema'] or
                any(base.get(key) != trained.get(key) for key in ['cohortSha256', 'decoderSeed', 'nativePolicy', 'budget']) or
                [row['id'] for row in base['cases']] != [row['id'] for row in trained['cases']]):
            raise ValueError('Pure-output arms must have identical frozen cohort, decoder seed, budget and native policy')
        if not 100 <= args.bootstrap_replicates <= 100000:
            parser.error('Bootstrap replicate count must be 100..100000')
        a, b = metrics(base['cases']), metrics(trained['cases'])
        if a['components'].keys() != b['components'].keys():
            raise ValueError('Pure-output component membership changed')
        deltas = {key: b['components'][key] - value for key, value in a['components'].items()}
        report = {'schema': 'semantic-pure-output-comparison/1', 'endpoint': 'pure-output-transfer',
            'cohortSha256': base['cohortSha256'], 'base': a, 'trained': b,
            'baseCheckpointIdentity': base['checkpointIdentity'], 'trainedCheckpointIdentity': trained['checkpointIdentity'],
            'meanImprovement': mean(deltas.values()), 'uncertainty': paired_component_interval(deltas,
                seed=args.bootstrap_seed, replicates=args.bootstrap_replicates),
            'baseReportSha256': IO.sha256(args.base), 'trainedReportSha256': IO.sha256(args.trained),
            'generalizationClaim': False, 'scope': 'Exploratory separate endpoint; no production trace or confirmatory claim.'}
        if args.output.exists():
            raise ValueError('Comparison output already exists')
        IO.write_json(args.output, report)
        print(json.dumps({'comparison': str(args.output), 'meanImprovement': report['meanImprovement']}))
        return 0
    if not re.fullmatch(r'[a-f0-9]{64}', args.checkpoint_identity) or not 1 <= args.max_tokens <= 1024 or not 1 <= args.timeout <= 300:
        parser.error('Actual SHA-256 checkpoint identity and bounded token/time caps required')
    args.model_args = strict_json(args.model_args)
    if not isinstance(args.model_args, list) or any(not isinstance(item, str) for item in args.model_args):
        parser.error('Model args must be a JSON array of strings')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema': 'semantic-pure-output-run/1', 'status': 'running', 'origin': args.origin,
        'checkpointIdentity': args.checkpoint_identity, 'cohortSha256': IO.sha256(args.cohort),
        'modelCommand': args.model_command, 'modelArgs': args.model_args,
        'runnerSha256': IO.sha256(__file__), 'graphScorerSha256': IO.sha256(GRAPH_TOOL),
        'modelArgumentFileHashes': {arg: IO.sha256(arg) for arg in args.model_args if Path(arg).is_file()},
        'budget': {'maxTokens': args.max_tokens, 'secondsPerCase': args.timeout},
        'endpoint': 'source-and-input-to-observable-outcome', 'cases': [], 'generalizationClaim': False}
    IO.write_json(root / 'report.json', report)
    try:
        cohort = strict_json(args.cohort.read_bytes())
        if cohort.get('schema') != 'semantic-pure-output-cohort/1' or not cohort['cases']:
            raise ValueError('Nonempty frozen pure-output cohort required')
        if len({case['id'] for case in cohort['cases']}) != len(cohort['cases']):
            raise ValueError('Duplicate pure-output cohort identity')
        consumer = args.consumer_root.resolve()
        IO.require_clean_checkout(consumer)
        if IO.git_head(consumer) != cohort['nativePolicy']['consumerRevision']:
            raise ValueError('Actual tokenizer verifier checkout differs from frozen consumer')
        sys.path.insert(0, str(consumer / 'src'))
        from megatoken.generation.codec import ByteCodec
        codec = ByteCodec.from_tokenizer_json(args.tokenizer_json.resolve(), expected_sha256=cohort['nativePolicy']['tokenizerSha256'])
        if codec.fingerprint != cohort['nativePolicy']['tokenizerIdentity']:
            raise ValueError('Actual tokenizer identity differs from frozen cohort')
        report.update(decoderSeed=cohort['decoderSeed'], nativePolicy=cohort['nativePolicy'],
                      independentExpectationSource='previously-frozen-source/reference/replay/native-qualified-episode')
        env = {key: os.environ[key] for key in ['PATH'] if key in os.environ}
        env.update(TZ='UTC', LANG='C.UTF-8', LC_ALL='C.UTF-8', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', PYTHONNOUSERSITE='1')
        for index, case in enumerate(cohort['cases']):
            report['cases'].append(measure_case(case, root / f'{index:04d}', args, codec, cohort['nativePolicy'], env))
            IO.write_json(root / 'report.json', report)
        report.update(status='completed', metrics=metrics(report['cases']))
        IO.write_json(root / 'report.json', report)
        print(json.dumps({'report': str(root / 'report.json'), 'metrics': report['metrics']}))
        return 0
    except BaseException as error:
        report.update(status='failed', error={'type': type(error).__name__, 'message': str(error)}, traceback=traceback.format_exc())
        IO.write_json(root / 'report.json', report)
        raise


if __name__ == '__main__':
    raise SystemExit(main())
