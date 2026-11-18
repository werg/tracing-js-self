#!/usr/bin/env python3
"""Compare complete actual native episodes, allowing only lineage.task_id aliases."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalized_episode(value):
    # JSON cloning preserves every native field and leaves the input untouched.
    result = json.loads(json.dumps(value, allow_nan=False))
    result['lineage'].pop('task_id', None)
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def require_equivalent(left, right):
    if canonical(normalized_episode(left)) != canonical(normalized_episode(right)):
        raise ValueError('Native alias differs in episode fields beyond lineage.task_id')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    args = parser.parse_args()
    index = json.loads(args.inputs.read_text())
    consumer = args.consumer_root.resolve()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=consumer, text=True).strip()
    subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=consumer, check=True)
    policy = index['nativePolicy']
    if revision != policy['consumerRevision'] or checksum(args.tokenizer_json) != policy['tokenizerSha256']:
        raise ValueError('Alias verification must use the original native consumer and tokenizer')
    sys.path.insert(0, str(consumer / 'src'))
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.generation.codec import ByteCodec
    codec = ByteCodec.from_tokenizer_json(args.tokenizer_json, expected_sha256=policy['tokenizerSha256'])
    if codec.fingerprint != policy['tokenizerIdentity']:
        raise ValueError('Alias verification tokenizer identity differs')
    groups = []
    for group in index['groups']:
        baseline, members = None, []
        for item in group['members']:
            path = args.inputs.parent / item['file']
            if checksum(path) != item['exportSha256']:
                raise ValueError('Identity-checked alias export changed before native adaptation')
            document = json.loads(path.read_text())
            # The exact producer verifier already checked the original admission
            # binding. This pass compares native adaptation; it issues no new
            # source/native admission or optimization claim.
            episode, receipt = adapt_selected_harness_v6(document, codec=codec,
                max_positions=1024, max_history=1024, admission_verifier=lambda _: True)
            actual = episode.to_dict()
            if baseline is None:
                baseline = actual
            else:
                require_equivalent(baseline, actual)
            members.append({**{key: value for key, value in item.items() if key != 'file'},
                'nativeEpisodeId': episode.episode_id, 'nativeTaskId': episode.lineage.task_id,
                'normalizedNativeEpisodeSha256': hashlib.sha256(canonical(normalized_episode(actual)).encode()).hexdigest(),
                'nativeRecords': receipt.records})
            del document, episode, actual
        groups.append({**{key: value for key, value in group.items() if key != 'members'},
                       'members': members, 'allNativeFieldsExceptTaskIdEqual': True})
    print(json.dumps({'consumerRevision': revision, 'tokenizerSha256': policy['tokenizerSha256'],
        'tokenizerIdentity': codec.fingerprint, 'maxPositions': 1024, 'maxHistory': 1024,
        'comparedGroups': len(groups), 'comparedAliases': sum(len(group['members']) - 1 for group in groups),
        'groups': groups}))


if __name__ == '__main__':
    main()
