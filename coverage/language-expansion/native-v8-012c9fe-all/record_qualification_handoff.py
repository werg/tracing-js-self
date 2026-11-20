#!/usr/bin/env python3
"""Preserve a coordinator-observed stop without rewriting the command receipt."""
import argparse
import json
from pathlib import Path

from run_current_qualification import identity, require, sha, stamp


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-run', type=Path, required=True)
parser.add_argument('--stream-run', type=Path, required=True)
args = parser.parse_args()
source_path = args.source_run / 'run.json'
source = json.loads(source_path.read_bytes())
pins = source['pinsBefore']
after = {name: identity(Path(row['path'])) for name, row in pins.items()}
require(after == pins, 'Clean frozen identities after termination')
require([row['name'] for row in source['commands']] == ['native-all', 'costs-all', 'retain-inputs-all'], 'Exact observed stage sequence')
for row in source['commands'][:2]:
    require(row['status'] == 'passed' and row['exitCode'] == 0 and row['pinsAfter'] == pins, 'Completed measured stages')
    for name in ['stdout', 'stderr']:
        log = args.source_run / row[name]['path']
        require(sha(log) == row[name]['sha256'] and log.stat().st_size == row[name]['bytes'], 'Original log bytes')
require(source['commands'][2]['status'] == 'running', 'Original last saved retention disposition')
qualification = json.loads((args.source_run / 'native-all/report.json').read_bytes())
require(qualification['declared'] == qualification['sourceQualified'] == qualification['nativeAdmitted'] == 665, 'All native gates completed')
ordinary_path = args.source_run / 'costs-all/report.json'
stream_path = args.stream_run / 'costs/report.json'
ordinary = json.loads(ordinary_path.read_bytes())
stream = json.loads(stream_path.read_bytes())
require(ordinary.keys() == stream.keys(), 'Same normal cost schema')
for key in ordinary:
    if key != 'rows':
        require(ordinary[key] == stream[key], 'Same cost metadata and summaries: ' + key)
require(len(ordinary['rows']) == len(stream['rows']) == 665, 'Complete compared rows')
for left, right in zip(ordinary['rows'], stream['rows']):
    require({k:v for k,v in left.items() if k != 'durationMs'} == {k:v for k,v in right.items() if k != 'durationMs'}, 'Cost row equality except measurement duration')
for name, digest in ordinary['artifacts'].items():
    left, right = ordinary_path.parent / name, stream_path.parent / name
    require(sha(left) == sha(right) == digest and left.read_bytes() == right.read_bytes(), 'Byte-identical cost artifact: ' + name)
comparison = {'schema': 'semantic-v8-stream-cli-equivalence/1', 'passed': True,
    'producerRevision': pins['producer']['revision'], 'consumerRevision': pins['consumer']['revision'],
    'qualifiedCases': 665, 'everyPhysicalArtifactByteIdentical': True, 'allSummariesExactlyEqual': True,
    'rowsEqualExceptMeasuredDuration': True, 'ordinaryCliRunReceipt': str(source_path),
    'ordinaryCliRunReceiptSha256': sha(source_path), 'ordinaryReportSha256': sha(ordinary_path),
    'streamReportSha256': sha(stream_path), 'sourceAdmissionsPerformed': 0, 'nativeAdmissionsPerformed': 0,
    'scope': 'Read-only equality check of two completed exact-token measurements. Every artifact byte and all report fields except measured row duration agree across the ordinary CLI and independent streaming meter.'}
comparison_path = args.source_run / 'full-cost-equivalence.json'
comparison_path.write_text(json.dumps(comparison, indent=2) + '\n')
handoff = {'schema': 'semantic-v8-qualification-stage-handoff/1', 'status': 'coordinator-handoff',
    'recordedAt': stamp(), 'originalSession': 89874, 'observedExitCode': 130,
    'termination': 'Coordinator sent Ctrl-C after native-all and ordinary costs-all completed. The process-group stop did not execute the Python finally block; its unchanged run.json retains the last running retain-inputs-all entry.',
    'reason': 'Adopt independently completed reference and split-bound dataset gates, retain the complete streaming cost cross-check, and avoid repeating their downstream executions.',
    'sourceRunSha256': sha(source_path), 'originalLastSavedStatus': source['status'],
    'pinsBefore': pins, 'pinsAfter': after, 'identityUnchanged': after == pins,
    'qualificationReportSha256': sha(args.source_run / 'native-all/report.json'),
    'ordinaryCostReportSha256': sha(ordinary_path), 'streamCostReportSha256': sha(stream_path),
    'costEquivalence': comparison_path.name, 'costEquivalenceSha256': sha(comparison_path),
    'completedStages': ['native-all', 'costs-all'], 'interruptedStage': 'retain-inputs-all',
    'interruptedStageIsQualificationFailure': False,
    'retentionLogs': [{'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)}
        for path in sorted(args.source_run.glob('retain-inputs-all.*.log'))],
    'scope': 'Coordinator observation and post-stop identity check only. It does not relabel the original overall run or its interrupted retention command as passed. Subsequent assembly must repeat exact-input retention and independently verify all completed gate receipts.'}
(args.source_run / 'parallel-stage-handoff.json').write_text(json.dumps(handoff, indent=2) + '\n')
print(json.dumps({'nativeAdmitted': 665, 'ordinaryCosts': 665, 'streamCosts': 665, 'allCostArtifactsByteIdentical': True, 'identityUnchanged': True}))
