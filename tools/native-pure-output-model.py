#!/usr/bin/env python3
"""Source/input-only pure-output adapter for the actual pinned native runtime.

Reads one semantic-pure-output-request/1 JSON document on stdin. Writes one
semantic-pure-model-response/1 document containing ORIGINAL model bytes and
native emitted token IDs. No JavaScript execution, teacher trace, expected
outcome, correction, controlled selection or inference retry occurs here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import resource
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--consumer-root', type=Path, required=True)
    parser.add_argument('--served', type=Path, required=True)
    parser.add_argument('--max-tokens', type=int, default=128)
    args = parser.parse_args()
    if not 1 <= args.max_tokens <= 1024:
        parser.error('Token budget must be 1..1024')
    consumer = args.consumer_root.resolve()
    policy = json.loads((Path(__file__).resolve().parent.parent / 'contracts/native-admission-policy-v6.json').read_text())
    revision = subprocess.check_output(['git', '-C', str(consumer), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != policy['consumerRevision'] or subprocess.check_output(
            ['git', '-C', str(consumer), 'status', '--porcelain', '--untracked-files=no'], text=True).strip():
        raise ValueError('Native pure-output adapter requires the clean pinned consumer')
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Pure model request exceeds byte bound')
    request = json.loads(raw)
    required = {'schema', 'caseId', 'source', 'entry', 'inputGraph', 'randomSeed', 'decoderSeed',
                'completionPolicy', 'outputContract'}
    if (set(request) != required or request['schema'] != 'semantic-pure-output-request/1' or
            request['decoderSeed'] not in (17, 29, 43) or request['outputContract'] != 'pure-observable-outcome/1'):
        raise ValueError('Only the public source/input pure-output protocol is accepted')
    sys.path.insert(0, str(consumer / 'src'))
    import torch
    from megatoken.contracts import MAIN_TRACK
    from megatoken.generation.structure import ActionSpec
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.runtime import seed_everything
    from megatoken.served import ServedBundle

    torch.set_num_threads(1)
    started = time.monotonic()
    bundle = ServedBundle(args.served.resolve(), device='cpu')
    if (bundle.manifest['codec_fingerprint'] != policy['tokenizerIdentity'] or
            bundle.manifest['tokenizer_sha256'] != policy['tokenizerSha256']):
        raise ValueError('Served tokenizer differs from the pinned native release policy')
    seed_everything(request['decoderSeed'], True)
    runtime = MultiTrackRuntime(MultiTrackGenerator.of(bundle.model), chunking=bundle.chunking)
    model_input = {key: request[key] for key in ['source', 'entry', 'inputGraph', 'randomSeed', 'completionPolicy', 'outputContract']}
    model_input_bytes = json.dumps(model_input, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    fragments, chunks, failure = [], [], None
    terminal, valid = False, True
    generation_started, generation_pending, emissions_complete = False, False, True
    instruction = (
        'Execute the supplied effect-free JavaScript source on the exact initial inputGraph. '
        'Emit ONLY one JSON object with exactly keys kind and graph. kind is return or throw. '
        'graph has exactly roots and objects; roots are the mutated positional arguments in original order '
        'followed by the returned or thrown value. Use canonical values: ["undefined"], ["null"], '
        '["bool",boolean], ["str",string], ["num",number] (or "-0", "NaN", "+Infinity", "-Infinity"), '
        '["bigint",decimal_string], or ["ref",id]. Every reachable object has id, kind (object or array), '
        'and properties as an ordered array of {"key":string,"value":tagged_value}; null-prototype '
        'objects also have "prototype":null. Arrays include a length property and only present indices. '
        'Preserve aliases, cycles, null prototypes, sparse holes, mutation, and return versus throw. '
        'A bounded declared Error throw observes its name and message as a data object. '
        'Do not emit reasoning, execution traces, markdown, tool calls, or any additional keys.'
    ).encode()
    try:
        with torch.inference_mode():
            session = runtime.open(metadata={'task': 'pure-output-transfer/1', 'modality': 'text'},
                                   effort=1, collections=(), memory_writes=False)
            before = set(session.context_archive.events)
            runtime.observe_text(session, MAIN_TRACK, model_input_bytes, role='user', effort=1)
            source_events = set(session.context_archive.events) - before
            visible = set(runtime.context_status(session, track=MAIN_TRACK)['visible_events'])
            if not source_events or not source_events <= visible:
                raise ValueError('Exact public source and inputs do not fit the actual model context')
            remaining = args.max_tokens
            for _ in range(64):
                generation_started, generation_pending = True, True
                generated = runtime.generate(session, tracks=(MAIN_TRACK,),
                    specs=(ActionSpec(text_kind='utf8', min_tokens=1,
                        max_tokens=min(remaining, bundle.model.config.max_capacity), require_terminal=None),),
                    controls=(instruction,), effort=1)
                generation_pending = False
                tape = generated.tape
                emitted = getattr(tape, 'emitted_ids', ())
                for index, event in enumerate(tape.event_ids):
                    payload = tape.payloads[index]
                    ids = list(emitted[index]) if len(emitted) == len(tape.event_ids) else None
                    fragments.append({'selectedEventId': event,
                        'payloadHex': payload.hex() if isinstance(payload, bytes) else None,
                        'emittedTokenIds': ids, 'valid': bool(tape.valid[index]),
                        'terminal': bool(tape.terminal[index]), 'modality': tape.modalities[index]})
                    if isinstance(payload, bytes):
                        chunks.append(payload)
                    if ids is None:
                        raise ValueError('Native decoder omitted original emitted-token identities')
                    remaining -= len(ids)
                valid = (len(tape.payloads) == 1 and bool(tape.valid[0]) and tape.modalities[0] == 'text' and
                         isinstance(tape.payloads[0], bytes) and tape.tracks[0] == MAIN_TRACK)
                terminal = bool(tape.terminal[0]) if len(tape.terminal) == 1 else False
                if not valid:
                    failure = {'category': 'invalid-model-text-action', 'message': 'Native model emitted an invalid text action'}
                    break
                if remaining < 0:
                    raise ValueError('Native decoder exceeded the declared token budget')
                if terminal:
                    break
                if remaining == 0:
                    failure = {'category': 'model-token-budget', 'message': 'Original output did not terminate within the declared token cap'}
                    break
            else:
                failure = {'category': 'model-fragment-budget', 'message': 'Original output exceeded 64 fragments'}
    except Exception as error:
        emissions_complete = not generation_pending and all(row['emittedTokenIds'] is not None for row in fragments)
        failure = {'category': type(error).__name__, 'message': str(error)}
    finally:
        runtime.close()
    response = {'schema': 'semantic-pure-model-response/1', 'caseId': request['caseId'],
        'origin': 'actual-native-model', 'checkpointIdentity': bundle.manifest['model_sha256'],
        'tokenizerIdentity': bundle.manifest['codec_fingerprint'],
        'tokenizerSha256': bundle.manifest['tokenizer_sha256'], 'consumerRevision': revision,
        'servedManifestSha256': hashlib.sha256((args.served / 'manifest.json').read_bytes()).hexdigest(),
        'requestSha256': hashlib.sha256(raw).hexdigest(), 'decoderSeed': request['decoderSeed'],
        'modelInputSha256': hashlib.sha256(model_input_bytes).hexdigest(),
        'modelInputFields': list(model_input), 'routingMetadataInModelContext': False,
        'payloadHex': b''.join(chunks).hex(), 'emissions': fragments,
        'generation': {'terminal': terminal, 'valid': valid, 'maxTokens': args.max_tokens,
            'started': generation_started, 'emissionsComplete': emissions_complete},
        'failure': failure,
        'costs': {'generatedTokens': sum(len(row['emittedTokenIds']) for row in fragments if row['emittedTokenIds'] is not None),
            'computeSeconds': time.monotonic() - started,
            'peakMemoryBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)},
        'javascriptExecutedAtInference': False, 'teacherTraceProvided': False}
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
