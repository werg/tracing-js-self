"""Exact target and conditioning diagnostics for the existing v5 learning path.

The functions below never train a model or infer missing measurements. Native
encoding uses the caller's actual encode_record/codec; model probes must retain
full conditional vectors from both execution paths at one immutable checkpoint.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
import math
import re


SCHEMA = 'semantic-learning-diagnostics/1'
_SHA256 = re.compile(r'^[0-9a-f]{64}$')
_NAMES = {'name', 'bind', 'binding', 'cell'}
_REFERENCES = {'object', 'invocation', 'child', 'owner', 'effect', 'promise',
               'target', 'continuation', 'closure', 'rejectionClosure', 'returnPromise', 'job', 'id'}
_KINDS = {'compute', 'choose', 'allocate', 'read', 'write', 'bind', 'call',
          'transfer', 'return', 'throw', 'request', 'job', 'promise', 'await',
          'resume', 'end', 'value-open', 'value-part', 'value-close'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else
                          json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def target_byte_categories(payload):
    """Label actual UTF-8 bytes, preserving cross-category tokenizer pieces.

    This is an accounting parser, not a replacement for decodeWitness. Complete
    logical payloads that are not witness records are explicitly transport bytes.
    """
    text = payload.decode('utf-8')
    split = text.find(' ')
    if split < 1 or text[:split] not in _KINDS:
        return ['transport'] * len(payload)
    kind = text[:split]
    try:
        fields = json.loads(text[split + 1:])
    except (ValueError, TypeError):
        return ['fragment-or-transport'] * len(payload)
    if not isinstance(fields, dict):
        return ['fragment-or-transport'] * len(payload)
    labels = ['json-structure'] * len(text)
    labels[:split] = ['record-kind'] * split
    labels[split] = 'separator'
    decoder = json.JSONDecoder()
    cursor = split + 1

    def mark(start, end, category):
        labels[start:end] = [category] * (end - start)

    def value(field=None, tag=None):
        nonlocal cursor
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        start = cursor
        if text[cursor] == '{':
            cursor += 1
            while text[cursor] != '}':
                while text[cursor].isspace(): cursor += 1
                start_key = cursor
                key, cursor = decoder.raw_decode(text, cursor)
                mark(start_key, cursor, 'json-key')
                while text[cursor].isspace(): cursor += 1
                require(text[cursor] == ':', 'Target accounting expected a JSON colon')
                cursor += 1
                value(key)
                while text[cursor].isspace(): cursor += 1
                if text[cursor] == ',': cursor += 1
                else: break
            require(text[cursor] == '}', 'Target accounting expected object close')
            cursor += 1
        elif text[cursor] == '[':
            array, _ = decoder.raw_decode(text, cursor)
            tag_name = array[0] if array and isinstance(array[0], str) else None
            cursor += 1
            for index in range(len(array)):
                value(field, tag_name if index == 1 else None)
                while text[cursor].isspace(): cursor += 1
                if index + 1 < len(array):
                    require(text[cursor] == ',', 'Target accounting expected array separator')
                    cursor += 1
            require(text[cursor] == ']', 'Target accounting expected array close')
            cursor += 1
        else:
            _, cursor = decoder.raw_decode(text, cursor)
            category = 'literal-value'
            if kind == 'end': category = 'terminal-structure'
            elif field in _NAMES: category = 'reference-id' if kind == 'allocate' else 'source-name'
            elif tag == 'ref' or field in _REFERENCES: category = 'reference-id'
            elif field in {'op', 'operator', 'operation', 'action', 'path'}: category = 'semantic-operation'
            mark(start, cursor, category)
    value()
    return [label for char, label in zip(text, labels, strict=True) for _ in char.encode('utf-8')]


def exact_record_audit(encoded, codec, *, byte_categories=None):
    """Reproduce the physical likelihood IDs and masks without retokenizing."""
    record = encoded.record
    payload, ids, masks = record.payload, list(encoded.token_ids), list(encoded.free_mask)
    require(encoded.codec_fingerprint == codec.fingerprint, 'Encoded target tokenizer identity differs')
    require(len(ids) == len(masks) and all(type(mask) is bool for mask in masks),
            'Lexical masks must have one Boolean per actual likelihood position')
    require(codec.decode(ids) == payload, 'Actual token IDs do not reconstruct target bytes')
    require(not any(masks) if not record.policy_mask else bool(ids) and all(masks),
            'Observed content must be masked; generated native text must be fully supervised')
    labels = byte_categories if byte_categories is not None else target_byte_categories(payload)
    require(len(labels) == len(payload), 'Category accounting does not span the exact payload')
    offset, tokens = 0, []
    for position, (token, mask) in enumerate(zip(ids, masks, strict=True)):
        piece = codec.decode([token])
        require(isinstance(piece, bytes) and len(piece) > 0 and payload[offset:offset+len(piece)] == piece,
                'Tokenizer piece is not an exact nonempty slice of the payload')
        counts = dict(Counter(labels[offset:offset+len(piece)]))
        tokens.append({'position': position, 'id': token, 'startByte': offset,
                       'endByte': offset + len(piece), 'hex': piece.hex(),
                       'text': piece.decode('utf-8', errors='backslashreplace'),
                       'category': next(iter(counts)) if len(counts) == 1 else 'mixed',
                       'categoryBytes': counts, 'lexicalLossMask': mask})
        offset += len(piece)
    require(offset == len(payload), 'Tokenizer pieces do not cover the payload')
    return {'recordId': record.record_id, 'logicalId': record.logical_id,
            'partIndex': record.part_index, 'partCount': record.part_count,
            'role': record.role, 'mode': 'generated' if record.policy_mask else 'observed',
            'payloadHex': payload.hex(), 'payloadText': payload.decode('utf-8'),
            'payloadSha256': digest(payload), 'tokenizerIdentity': codec.fingerprint,
            'tokens': tokens, 'observedMask': [not bool(record.policy_mask)] * len(ids),
            'generatedMask': [bool(record.policy_mask)] * len(ids), 'lexicalMask': masks,
            'structuralMask': None, 'terminalMask': None,
            'nonlexicalMaskStatus': 'unmeasured: native action-head probes required',
            'transcriptTokens': encoded.transcript_tokens, 'likelihoodPositions': len(ids),
            'scoredPositions': sum(masks)}


def native_target_audit(prepared, codec, *, maximum_episodes=1, maximum_bytes=16_777_216):
    """Audit the shortest prepared episode using the existing native codec.

    Prior public records are retained as causal input inventory. Actual recurrent
    visibility is intentionally not replaced with a concatenated lexical prompt;
    measure-native-context-costs.py remains authoritative for those costs.
    """
    from megatoken.data.schema import encode_record
    from megatoken.data.storage import PreparedCorpus
    require(type(maximum_episodes) is int and maximum_episodes > 0, 'Positive target audit episode cap required')
    with PreparedCorpus([str(prepared)]) as corpus:
        choices = sorted((sum(len(encode_record(r, codec).token_ids) for r in e.records if r.policy_mask),
                          e.episode_id) for e in corpus.iter_episodes())[:maximum_episodes]
        selected = {identity for _, identity in choices}
        result, total_bytes = [], 0
        for episode in corpus.iter_episodes():
            if episode.episode_id not in selected: continue
            groups = defaultdict(list)
            for record in episode.records: groups[record.logical_id or record.record_id].append(record)
            categories = {}
            for records in groups.values():
                ordered = sorted(records, key=lambda row: row.part_index)
                require([r.part_index for r in ordered] == list(range(ordered[0].part_count)) and
                        all(r.part_count == len(ordered) for r in ordered), 'Incomplete logical target fragments')
                payload = b''.join(r.payload for r in ordered)
                labels, offset = target_byte_categories(payload), 0
                for record in ordered:
                    categories[record.record_id] = labels[offset:offset+len(record.payload)]
                    offset += len(record.payload)
            rows = []
            for record in episode.records:
                total_bytes += len(record.payload)
                require(total_bytes <= maximum_bytes, 'Exact target audit exceeded declared public byte budget')
                rows.append(exact_record_audit(encode_record(record, codec), codec,
                                              byte_categories=categories[record.record_id]))
            result.append({'episodeId': episode.episode_id,
                           'sourceId': episode.lineage.source_id,
                           'familyId': episode.lineage.family_id,
                           'split': episode.lineage.frozen_split,
                           'records': rows})
        return {'schema': SCHEMA, 'status': 'measured-targets', 'corpusIdentity': corpus.identity,
                'tokenizerIdentity': codec.fingerprint, 'selection': 'shortest-generated-token-episodes',
                'maximumEpisodes': maximum_episodes, 'maximumPublicBytes': maximum_bytes,
                'episodes': result, 'publicBytes': total_bytes,
                'conditioningStatus': 'public-record-inventory; recurrent visibility needs native context meter',
                'trainingServingParity': {'status': 'unmeasured'},
                'perHeadObjectiveGradients': {'status': 'unmeasured'}}


def conditional_statistics(points, *, top_k=(1, 5, 10)):
    """Score retained full conditional vectors, not rounded top-k dumps."""
    require(points, 'Conditional audit needs at least one measured position')
    require(top_k and all(type(k) is int and k > 0 for k in top_k), 'Positive top-k limits required')
    groups = defaultdict(list)
    for point in points:
        logits, target = point['logits'], point['target']
        require(isinstance(logits, list) and logits and all(type(x) in (int, float) and math.isfinite(x) for x in logits),
                'Conditional vectors must be complete finite numeric logits')
        require(type(target) is int and 0 <= target < len(logits), 'Target outside conditional vocabulary')
        require(type(point.get('scored')) is bool, 'Every conditional position needs its actual loss mask')
        if not point['scored']: continue
        maximum = max(logits)
        loss = math.log(sum(math.exp(x - maximum) for x in logits)) + maximum - logits[target]
        rank = 1 + sum(value > logits[target] or value == logits[target] and index < target
                       for index, value in enumerate(logits))
        for key in [('head', point['head']), ('category', point['category'])]:
            groups[key].append((loss, rank))
    result = {'byHead': {}, 'byCategory': {}, 'topK': list(top_k),
              'tieBreak': 'ascending-token-id', 'unscoredPositions': sum(not p['scored'] for p in points)}
    for (group, key), values in sorted(groups.items()):
        result['byHead' if group == 'head' else 'byCategory'][key] = {
            'positions': len(values), 'meanCrossEntropy': sum(loss for loss, _ in values) / len(values),
            'topKAccuracy': {str(k): sum(rank <= k for _, rank in values) / len(values) for k in top_k}}
    return result


def compare_conditioning_probes(training, serving, *, atol=1e-6, rtol=1e-5):
    """Fail closed on identity/mask/prefix differences before numerical parity."""
    if training is None or serving is None:
        return {'status': 'unmeasured', 'reason': 'Both original training and serving probes are required'}
    require(all(type(x) in (int, float) and math.isfinite(x) and x >= 0 for x in (atol, rtol)),
            'Parity tolerances must be declared finite nonnegative values')
    for probe, path in ((training, 'training'), (serving, 'serving')):
        require(probe.get('schema') == 'semantic-conditioning-probe/1' and probe.get('path') == path,
                'Wrong conditional probe schema or execution path')
        require(probe.get('dropoutDisabled') is True, 'Conditioning parity requires dropout disabled')
        identity = probe.get('identity', {})
        for name in ('checkpointSha256', 'tokenizerIdentity', 'publicPrefixSha256', 'targetSha256'):
            require(isinstance(identity.get(name), str) and bool(_SHA256.fullmatch(identity[name])),
                    'Conditional probe needs immutable ' + name)
        require(probe.get('points'), 'Conditional probe is empty')
        conditional_statistics(probe['points'])
        require(isinstance(probe.get('inputTokenIds'), list) and
                all(type(x) is int and x >= 0 for x in probe['inputTokenIds']), 'Exact input token IDs required')
        point_keys = [(p['head'], p['position']) for p in probe['points']]
        require(len(point_keys) == len(set(point_keys)), 'Duplicate conditional position')
    require(training['identity'] == serving['identity'], 'Training/serving checkpoint, tokenizer, prefix or target mismatch')
    require(training['inputTokenIds'] == serving['inputTokenIds'], 'Training/serving tokenization or conditioning mismatch')
    require(len(training['points']) == len(serving['points']), 'Training/serving conditional position count differs')
    first, maximum = None, 0.0
    for left, right in zip(training['points'], serving['points'], strict=True):
        require({k: v for k, v in left.items() if k != 'logits'} ==
                {k: v for k, v in right.items() if k != 'logits'}, 'Conditional target, mask or position alignment differs')
        require(len(left['logits']) == len(right['logits']), 'Conditional vocabulary dimensions differ')
        for index, (a, b) in enumerate(zip(left['logits'], right['logits'], strict=True)):
            difference = abs(a - b)
            maximum = max(maximum, difference)
            if difference > atol + rtol * abs(a) and first is None:
                first = {'head': left['head'], 'position': left['position'], 'tokenId': index,
                         'trainingLogit': a, 'servingLogit': b, 'absoluteDifference': difference}
    return {'status': 'passed' if first is None else 'failed', 'identity': training['identity'],
            'absoluteTolerance': atol, 'relativeTolerance': rtol, 'maxAbsoluteDifference': maximum,
            'firstDivergence': first, 'training': conditional_statistics(training['points']),
            'serving': conditional_statistics(serving['points']),
            'scope': 'Only the retained checkpoint, public prefix, heads and positions'}


def objective_gradient_norms(model, losses, owners):
    """Measure each scalar objective without changing .grad or optimizer state.

    Called by a native probe hook while its real graph is alive. Names explicitly
    bind native parameter ownership; ownership is never guessed from substrings.
    """
    import torch
    parameters = dict(model.named_parameters())
    names = [name for owned in owners.values() for name in owned]
    require(names and len(names) == len(set(names)) and all(name in parameters for name in names),
            'Objective gradient owners must be unique actual parameter names')
    require(losses, 'At least one actual scalar objective required')
    result = {}
    for objective, loss in losses.items():
        require(loss.ndim == 0 and bool(torch.isfinite(loss)), 'Objective loss must be a finite scalar')
        grads = torch.autograd.grad(loss, [parameters[name] for name in names],
                                    allow_unused=True, retain_graph=True)
        by_name = dict(zip(names, grads, strict=True))
        result[objective] = {}
        for owner, owned in owners.items():
            values = [by_name[name] for name in owned if by_name[name] is not None]
            require(all(bool(torch.isfinite(value).all()) for value in values), 'Nonfinite objective gradient')
            result[objective][owner] = {'parameters': len(owned), 'connectedParameters': len(values),
                'gradientNorm': math.sqrt(sum(float(value.detach().double().square().sum()) for value in values))}
    return {'status': 'measured', 'objectives': result, 'parameterOwners': owners,
            'scope': 'Separate objective derivatives before clipping; no optimizer step'}


def first_action_diagnosis(summary):
    """Locate the first observed failure without repairing original emissions."""
    profile = summary.get('servingProfile') or {}
    selects = [row for row in profile.get('records', []) if row.get('operation') == 'select']
    first = selects[0] if selects else None
    failure = (first or {}).get('failure') or summary.get('failure') or {}
    evidence = failure.get('evidence') or {}
    original = []
    seen = {}
    for fragment in evidence.get('fragments', []):
        identity = fragment.get('selectedEventId')
        raw = {'selectedEventId': identity, 'payloadHex': fragment.get('payloadHex'),
               'emittedTokenIds': fragment.get('emittedTokenIds')}
        require(isinstance(raw['payloadHex'], str), 'Original model fragment bytes required')
        bytes.fromhex(raw['payloadHex'])
        require(isinstance(raw['emittedTokenIds'], list) and
                all(type(t) is int and t >= 0 for t in raw['emittedTokenIds']), 'Original model token IDs required')
        require(identity not in seen or seen[identity] == raw, 'Conflicting original model fragment evidence')
        if identity not in seen: original.append(raw)
        seen[identity] = raw
    message = str(failure.get('message', ''))
    if first and first.get('ok') is False and any(value is False for value in evidence.get('valid', [])):
        layer = 'native-action-rendering'
    elif 'missing record separator' in message:
        layer = 'record-separator'
    elif 'JSON syntax' in message or 'noncanonical bytes' in message:
        layer = 'record-syntax'
    elif summary.get('firstSemanticInconsistency') is not None:
        layer = 'semantic-validation'
    elif summary.get('wholeTaskSuccess') is True:
        layer = 'complete-execution'
    else:
        layer = 'unlocalized'
    return {'caseId': summary.get('id'), 'origin': summary.get('origin'),
            'checkpointIdentity': summary.get('checkpointIdentity'), 'firstFailureLayer': layer,
            'firstNativeSelectSucceeded': first.get('ok') if first is not None else None,
            'firstRecordSyntaxValid': False if layer in {'record-separator', 'record-syntax'} else None,
            'firstRecordSemanticsValid': False if layer == 'semantic-validation' else None,
            'wholeTaskSuccess': summary.get('wholeTaskSuccess'),
            'originalFragments': original, 'failureMessage': message,
            'semanticInconsistency': summary.get('firstSemanticInconsistency'),
            'originalEmittedTokens': sum(len(row['emittedTokenIds']) for row in original) if original else None,
            'evidenceScope': 'Retained original first select; missing later layers remain unmeasured'}
