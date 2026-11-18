"""Observe real native decoder calls; never change a choice, label, or state.

The optional self-emission scoring replay compares the teacher's computation
at the renderer's *actual* length and terminal choices. It does not turn that
emission into a correct semantic answer or an optimizer target.
"""
from contextlib import ExitStack, contextmanager
from dataclasses import asdict
import hashlib


def categorical(logits, allowed, *, name, selected=None):
    import torch
    ids = tuple(int(value) for value in allowed)
    if not ids:
        raise ValueError('Actual decoder has empty categorical support')
    values = logits.detach().float().reshape(-1)[list(ids)]
    if not bool(torch.isfinite(values).all()):
        raise ValueError('Actual decoder categorical has nonfinite supported logits')
    return {'name': name, 'support': list(ids), 'logits': values.cpu().tolist(),
            'probabilities': values.softmax(-1).cpu().tolist(), 'selected': selected}


def lexical(vocabulary, states, valid, *, ids, operation):
    import torch
    from native_conditional_probe import tensor_record
    with torch.no_grad():
        projected = vocabulary.projection(states).detach().float()
        support = valid.nonzero().reshape(-1)
        weights = vocabulary.embedding.weight.detach().float().index_select(0, support)
        # One position at a time keeps the diagnostic bounded at the real
        # production vocabulary size. Every permitted token is measured.
        checksum = hashlib.sha256()
        rows = []
        for index, hidden in enumerate(projected):
            probabilities = (hidden[None] @ weights.T).softmax(-1)[0]
            checksum.update(probabilities.cpu().contiguous().numpy().tobytes())
            values, local = probabilities.topk(min(5, probabilities.numel()))
            target = None if ids is None else int(ids[index])
            location = None if target is None else (support == target).nonzero().reshape(-1)
            rows.append({'position': index, 'tokenId': target,
                'probability': None if location is None or not location.numel()
                    else float(probabilities[int(location[0])]),
                'topIds': support[local].cpu().tolist(), 'topProbabilities': values.cpu().tolist()})
        return {'operation': operation, 'positions': states.shape[0],
            'alphabetSize': support.numel(),
            'alphabetSha256': hashlib.sha256(valid.detach().cpu().numpy().tobytes()).hexdigest(),
            'projectedStates': tensor_record(projected, allow_empty=True),
            'fullConditionalProbabilitiesSha256': checksum.hexdigest(), 'tokens': rows}


@contextmanager
def observe_decoder(model):
    """Return a list populated only by calls the real model actually makes."""
    from unittest.mock import patch
    from megatoken.generation.decoder import DeterministicDecoder, _Program
    from megatoken.generation.distributions import TiedVocabulary
    capture = {'categoricals': [], 'lexical': []}
    original_support = DeterministicDecoder._support_loss
    original_choose = _Program.choose
    original_loss, original_argmax = TiedVocabulary.loss, TiedVocabulary.argmax

    def support(decoder, header, codes, targets, supports, *, name):
        if decoder is model.decoder:
            logits = decoder.logits(header, codes)
            for index, allowed in enumerate(supports):
                capture['categoricals'].append(categorical(logits[index], allowed,
                    name=name, selected=int(targets[index])))
        return original_support(decoder, header, codes, targets, supports, name=name)

    def choose(program, name, logits, allowed, **kwargs):
        allowed = tuple(allowed)
        selected = original_choose(program, name, logits, allowed, **kwargs)
        capture['categoricals'].append(categorical(logits, allowed,
            name='length' if name == 'length/text' else name, selected=selected))
        return selected

    def loss(vocabulary, states, ids, valid):
        result = original_loss(vocabulary, states, ids, valid)
        if vocabulary is model.decoder.vocabulary:
            capture['lexical'].append(lexical(vocabulary, states, valid,
                ids=ids.detach().cpu().tolist(), operation='teacher-loss'))
        return result

    def argmax(vocabulary, states, valid):
        result = original_argmax(vocabulary, states, valid)
        if vocabulary is model.decoder.vocabulary:
            capture['lexical'].append(lexical(vocabulary, states, valid,
                ids=result.detach().cpu().tolist(), operation='renderer-argmax'))
        return result

    with ExitStack() as stack:
        stack.enter_context(patch.object(DeterministicDecoder, '_support_loss', support))
        stack.enter_context(patch.object(_Program, 'choose', choose))
        stack.enter_context(patch.object(TiedVocabulary, 'loss', loss))
        stack.enter_context(patch.object(TiedVocabulary, 'argmax', argmax))
        yield capture


def compare_decoder_execution(teacher, renderer, *, atol=1e-6, rtol=1e-5):
    """Compare actual decisions at identical conditioning, not target choices."""
    import math
    first = None
    checked = 0
    left = {row['name']: row for row in teacher['categoricals']}
    right = {row['name']: row for row in renderer['categoricals']}
    for name in ('length', 'terminal'):
        a, b = left.get(name), right.get(name)
        if a is None or b is None:
            return {'status': 'unmeasured', 'reason': 'Both actual decoder heads are required'}
        if a['support'] != b['support']:
            first = first or {'head': name, 'reason': 'support'}
            continue
        for index, (x, y) in enumerate(zip(a['probabilities'], b['probabilities'], strict=True)):
            if not math.isfinite(x) or not math.isfinite(y):
                raise ValueError('Nonfinite native decoder probability')
            checked += 1
            if abs(x-y) > atol + rtol * abs(x):
                first = first or {'head': name, 'index': index,
                                  'training': x, 'serving': y, 'reason': 'probability'}
    if len(teacher['lexical']) != len(renderer['lexical']) or not teacher['lexical']:
        first = first or {'head': 'lexical', 'reason': 'missing-or-different-call-count'}
    else:
        for a, b in zip(teacher['lexical'], renderer['lexical'], strict=True):
            checked += a['positions'] * a['alphabetSize']
            for key in ('positions', 'alphabetSha256', 'fullConditionalProbabilitiesSha256'):
                if a[key] != b[key]:
                    first = first or {'head': 'lexical', 'reason': key}
    return {'status': 'passed' if first is None else 'failed',
            'comparedProbabilities': checked, 'firstDivergence': first,
            'scope': 'Actual length, terminal, and every permitted lexical-token probability at the same structural conditioning',
            'lexicalComparison': 'exact float32 probability checksums over the full permitted alphabet'}


def compare_output_support(training, serving):
    """Compare the supports actually used by both native decoder executions."""
    teacher, renderer = training.get('decoderExecution'), serving.get('decoderExecution')
    if not teacher or not renderer:
        return {'status': 'unmeasured', 'reason': 'Both actual native decoders must execute'}
    left = {row['name']: row for row in teacher['categoricals']}
    right = {row['name']: row for row in renderer['categoricals']}
    heads = {}
    for name in ('length', 'terminal'):
        if name not in left or name not in right:
            return {'status': 'unmeasured', 'reason': 'Missing actual ' + name + ' support'}
        a, b = left[name]['support'], right[name]['support']
        heads[name] = {'training': a, 'serving': b, 'equal': a == b}
    a = {row['alphabetSha256'] for row in teacher['lexical']}
    b = {row['alphabetSha256'] for row in renderer['lexical']}
    if not a or not b:
        return {'status': 'unmeasured', 'reason': 'Missing actual lexical support'}
    alphabets = a == b
    equal = alphabets and all(row['equal'] for row in heads.values())
    return {'status': 'passed' if equal else 'failed', 'heads': heads,
            'lexicalAlphabetSupportMatches': alphabets,
            'trainingAlphabetSha256': sorted(a), 'servingAlphabetSha256': sorted(b),
            'scope': 'Supports passed to actual native loss and renderer calls; no source-hash inference'}


def emission_scoring_replay(model, context, spec, action, renderer):
    """Use actual emitted IDs as diagnostic labels, with no optimization."""
    if not action.valid:
        return {'status': 'unmeasured', 'reason': 'Original native renderer rejected its own emission',
                'nativeError': action.error}
    if spec.schemas:
        return {'status': 'unmeasured', 'reason': 'This probe is restricted to raw semantic text'}
    plan = model.prepare_target([action.emitted_ids], terminal=[action.terminal], mode_specs=[spec])
    with observe_decoder(model) as teacher:
        losses = model.decoder.teacher_raw(model.core, context, plan)
    comparison = compare_decoder_execution(teacher, renderer)
    return {'status': comparison['status'], 'comparison': comparison, 'teacher': teacher,
            'actualEmissionUsedWithoutRepair': True, 'optimizerSteps': 0,
            'losses': {name: {'sum': float(value.detach()), 'count': count}
                       for name, (value, count) in losses.items()},
            'publicSpec': asdict(spec), 'semanticSuccessClaim': False}
