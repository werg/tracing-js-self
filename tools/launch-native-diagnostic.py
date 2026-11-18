#!/usr/bin/env python3
"""Record the actual model-process identity, then exec the immutable native server."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--launch-id', required=True)
    parser.add_argument('script', type=Path)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if re.fullmatch('[0-9a-f]{32}', args.launch_id) is None:
        parser.error('A fresh launcher identity is required')
    script = args.script.resolve(strict=True)
    command = [sys.executable, str(script), *args.arguments]
    receipt = {'schema': 'semantic-native-process-launch/1', 'launchId': args.launch_id,
        'pid': os.getpid(), 'parentPid': os.getppid(), 'startedWallNs': time.time_ns(),
        'startedMonotonicNs': time.monotonic_ns(), 'python': sys.executable,
        'script': str(script), 'scriptSha256': hashlib.sha256(script.read_bytes()).hexdigest(),
        'commandSha256': hashlib.sha256(json.dumps(command, separators=(',', ':')).encode()).hexdigest(),
        'scope': 'Process identity immediately before exec; model loading is attested separately by serving profile.'}
    with args.receipt.open('x') as handle:
        json.dump(receipt, handle, indent=2, allow_nan=False)
        handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
    os.execv(sys.executable, command)


if __name__ == '__main__': main()
