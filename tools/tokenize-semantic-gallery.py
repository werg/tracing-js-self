#!/usr/bin/env python3
"""Count exact gallery target tokens with the pinned native raw-byte codec."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--tokenizer-json', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.consumer_root.resolve() / 'src'))

    from megatoken.generation.codec import (
        ByteCodec, CODEC_VERSION, LING_REPOSITORY, LING_REVISION, LING_TOKENIZER_SHA256,
    )

    codec = ByteCodec.from_tokenizer_json(
        args.tokenizer_json.resolve(), expected_sha256=LING_TOKENIZER_SHA256,
    )
    request = json.load(sys.stdin)

    def count_cases(cases):
        counted = []
        for case in cases:
            counts = []
            for target in case['targets']:
                if not isinstance(target, str):
                    raise TypeError('Gallery target must be exact UTF-8 text')
                raw = target.encode('utf-8')
                ids = codec.encode(raw)
                if codec.decode(ids) != raw:
                    raise ValueError('Pinned codec changed the exact target bytes')
                counts.append(len(ids))
            counted.append({'id': case['id'], 'tokenCounts': counts,
                            'generatedTokens': sum(counts)})
        return counted

    response = {
        'identity': {
            'name': LING_REPOSITORY,
            'revision': LING_REVISION,
            'tokenizerSha256': LING_TOKENIZER_SHA256,
            'codecVersion': CODEC_VERSION,
            'fingerprint': codec.fingerprint,
            'vocabSize': codec.vocab_size,
        },
        'current': count_cases(request['current']),
        'v5': count_cases(request['v5']),
    }
    json.dump(response, sys.stdout, ensure_ascii=False, allow_nan=False,
              separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
