#!/usr/bin/env python3
"""Read-only first-target diagnosis for the exact original348 checkpoint.

Native imports are intentionally lazy. The CLI/archive binding is added after
the bounded observation/scoring primitives have controlled fixture evidence.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
import hashlib
import json
import math
from pathlib import Path
from unittest.mock import patch

CASE = "se-support-capped-budget-pure"
SEED = 17
CONDITIONS = (("historical-serving-effort1", 1), ("checkpoint-training-effort6", 6))


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def snapshot(value):
    """Typed complete structure, with exact tensor bytes hashed rather than logged."""
    import numpy as np
    import torch
    if isinstance(value, torch.Tensor):
        tensor = value.detach().cpu().contiguous()
        return {"type": "tensor", "dtype": str(tensor.dtype), "shape": list(tensor.shape),
                "sha256": hashlib.sha256(tensor.reshape(-1).view(torch.uint8).numpy().tobytes()).hexdigest()}
    if isinstance(value, torch.Generator):
        return {"type": "generator", "device": str(value.device), "state": snapshot(value.get_state())}
    if isinstance(value, np.ndarray):
        return {"type": "ndarray", "dtype": str(value.dtype), "shape": list(value.shape),
                "sha256": hashlib.sha256(value.tobytes()).hexdigest()}
    if is_dataclass(value):
        return {"type": type(value).__module__ + "." + type(value).__qualname__,
                "fields": {field.name: snapshot(getattr(value, field.name)) for field in fields(value)}}
    if isinstance(value, Mapping):
        require(all(isinstance(key, str) for key in value), "snapshot mapping keys must be strings")
        return {key: snapshot(item) for key, item in sorted(value.items())}
    if isinstance(value, tuple):
        return {"type": "tuple", "items": [snapshot(item) for item in value]}
    if isinstance(value, list):
        return [snapshot(item) for item in value]
    if isinstance(value, bytes):
        return {"type": "bytes", "length": len(value), "sha256": hashlib.sha256(value).hexdigest(),
                "hex": value.hex() if len(value) <= 256 else None}
    if value is None or type(value) in (str, int, bool):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    raise TypeError("unsupported snapshot owner: " + type(value).__name__)


def differences(left, right, path="", *, limit=256):
    """Return bounded exact differences without tolerances or discarded fields."""
    found = []
    def compare(a, b, where):
        if len(found) >= limit:
            return
        if type(a) is not type(b):
            found.append({"path": where, "left": a, "right": b})
        elif isinstance(a, dict):
            for key in sorted(a.keys() | b.keys()):
                if key not in a or key not in b:
                    found.append({"path": where + "/" + key, "missing": "left" if key not in a else "right"})
                else:
                    compare(a[key], b[key], where + "/" + key)
        elif isinstance(a, list):
            if len(a) != len(b):
                found.append({"path": where, "leftLength": len(a), "rightLength": len(b)})
            for index, (x, y) in enumerate(zip(a, b)):
                compare(x, y, where + "/" + str(index))
        elif a != b:
            found.append({"path": where, "left": a, "right": b})
    compare(left, right, path)
    return {"exactEqual": not found and digest(left) == digest(right), "differences": found[:limit],
            "differenceListMayBeTruncated": len(found) >= limit,
            "leftDigest": digest(left), "rightDigest": digest(right)}


def model_identity(model):
    return {"weights": digest(snapshot(model.state_dict())),
            "transducerBank": digest(snapshot(model.transducer.bank.state_snapshot()))}


@contextmanager
def readonly_native():
    """Refuse gradients, optimizer updates, and all actual free-generation calls."""
    import torch
    from megatoken.training.optimizer import MasterAdamW
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.semantic_checkpoint_v8 import capture_random_state, restore_random_state
    old = capture_random_state()
    calls = {"backward": 0, "optimizerStep": 0, "freeGeneration": 0}
    def forbidden(name):
        def refuse(*args, **kwargs):
            calls[name] += 1
            raise RuntimeError("Read-only diagnostic forbids " + name)
        return refuse
    try:
        with torch.no_grad(), patch.object(torch.Tensor, "backward", forbidden("backward")), \
                patch.object(torch.autograd, "backward", forbidden("backward")), \
                patch.object(MasterAdamW, "step", forbidden("optimizerStep")), \
                patch.object(torch.optim.AdamW, "step", forbidden("optimizerStep")), \
                patch.object(MultiTrackRuntime, "generate", forbidden("freeGeneration")):
            yield calls
        require(not any(calls.values()), "a forbidden runtime operation was attempted")
    finally:
        restore_random_state(old)
        require(capture_random_state() == old, "process RNG was not restored")


class _BoundaryCaptured(Exception):
    pass


def capture_training_boundary(model, episode, config, scratch):
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.semantic_checkpoint_v8 import capture_random_state
    from scripts.fit_semantic_v8 import capture_boundaries
    captured = []
    def stop(multi, state, **kwargs):
        require(not captured, "more than one training target reached")
        captured.append((copy.deepcopy(state.detach()), dict(kwargs), capture_random_state()))
        raise _BoundaryCaptured("stopped before the first supervised target")
    with patch.object(MultiTrackGenerator, "supervised_meridian", stop):
        try:
            capture_boundaries(model, episode, config, scratch, max_boundaries=1)
        except _BoundaryCaptured:
            pass
        else:
            raise ValueError("training boundary interception did not stop execution")
    require(len(captured) == 1, "exactly one training boundary required")
    return captured[0]


def capture_serving_boundary(model, artifact, chunking, *, effort, max_tokens, model_hash, lineage_hash):
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.semantic_model_v8 import NativeSemanticInferenceV8, NativeSelectionV8Error
    from megatoken.semantic_checkpoint_v8 import capture_random_state
    from scripts.fit_semantic_v8 import initial_public
    runtime = MultiTrackRuntime(MultiTrackGenerator.of(model), chunking=chunking)
    adapter = NativeSemanticInferenceV8(runtime, model_identity=model_hash, training_identity=lineage_hash,
                                        effort=effort, max_tokens=max_tokens, max_fragments=8)
    captured, openings = [], []
    actual_open = runtime.open
    def observed_open(*args, **kwargs):
        openings.append(snapshot(kwargs))
        return actual_open(*args, **kwargs)
    def stop(session, **kwargs):
        require(not captured, "more than one serving target reached")
        captured.append((copy.deepcopy(session.state.detach()), dict(kwargs), capture_random_state()))
        raise _BoundaryCaptured("stopped before any free model generation")
    runtime.open = observed_open
    runtime.generate = stop
    try:
        adapter.initialize(seed=SEED, checkpointIdentity=model_hash, tokenizerIdentity=model.codec.fingerprint,
                           trainingIdentity=lineage_hash)
        public = initial_public(artifact)
        try:
            adapter.select(session=public["timeline"][0]["fields"]["session"], public=public,
                           contexts=[], context=artifact["contexts"][0])
        except NativeSelectionV8Error as error:
            require(len(captured) == 1 and isinstance(error.__cause__, _BoundaryCaptured),
                    "serving refused before the requested capture boundary: " + str(error))
        else:
            raise ValueError("serving capture unexpectedly returned a candidate")
        require(len(openings) == 1 and len(captured) == 1, "one serving opening and boundary required")
        require(all(work.pending is None for work in adapter.sessions.values()), "captured target became pending")
        return (*captured[0], openings[0])
    finally:
        for session in list(adapter.sessions):
            adapter.cancel(session=session, reason="read-only-first-target-diagnostic")
        runtime.close()


def target_binding(episode, artifact, codec, plan):
    """Compare retained physical rows to independently source-qualified target bytes."""
    from megatoken.contracts import ROLE_TO_ID
    require(len(plan.payloads) == len(plan.ids) == len(plan.free_masks) == len(plan.roles) == 1,
            "one physical text target required")
    selected = next(record for record in episode.records if record.policy_mask)
    logical = [record for record in episode.records if record.logical_id == selected.logical_id]
    require(all(record.policy_mask for record in logical) and
            [record.part_index for record in logical] == list(range(len(logical))) and
            all(record.part_count == len(logical) for record in logical), "original physical target order changed")
    target = next(row["fields"]["line"] for row in artifact["public"]["timeline"] if row["mode"] == "generated")
    require(b"".join(record.payload for record in logical) == target.encode(), "physical target differs from source")
    require(plan.payloads[0] == selected.payload and tuple(plan.ids[0]) == tuple(selected.cached_ids) and
            codec.decode(plan.ids[0]) == selected.payload, "physical lexical target binding differs")
    require(selected.role == "assistant" and plan.roles[0] == ROLE_TO_ID["assistant"], "original target role changed")
    expected_mask = tuple(selected.emitted_free_mask) if selected.emitted_free_mask is not None else \
                    tuple(True for _ in selected.cached_ids)
    require(tuple(plan.free_masks[0]) == expected_mask, "target loss mask differs from original physical row")
    require(plan.terminals[0] is (selected.part_index + 1 == selected.part_count), "target terminal label changed")
    return {"logicalId": selected.logical_id, "physicalRecordId": selected.record_id,
            "physicalParts": len(logical), "selectedPart": selected.part_index,
            "targetSha256": hashlib.sha256(target.encode()).hexdigest(), "targetBytes": len(target.encode()),
            "selectedPayloadSha256": hashlib.sha256(selected.payload).hexdigest(),
            "originalTokenIds": list(selected.cached_ids), "freeMask": list(expected_mask),
            "role": selected.role, "terminal": plan.terminals[0], "plan": snapshot(plan)}


def first_lexical_metrics(vocabulary, states, labels, valid, losses, codec):
    """Measure the exact first loss input; use the production CE for probability."""
    import torch
    require(states.ndim == 2 and len(states) == len(labels) == len(losses) > 0,
            "unexpected lexical loss population")
    target = int(labels[0])
    require(valid.dtype is torch.bool and bool(valid[target]), "target outside lexical support")
    projected = vocabulary.projection(states[:1]).float()
    logits = (projected @ vocabulary.embedding.weight.float().T)[0]
    require(torch.isfinite(logits[valid]).all().item(), "nonfinite lexical logits")
    ids = torch.arange(len(logits), device=logits.device)
    target_logit = logits[target]
    rank = 1 + int((valid & ((logits > target_logit) | ((logits == target_logit) & (ids < target)))).sum())
    argmax = int(vocabulary.argmax(states[:1], valid)[0])
    ce = float(losses[0])
    direct_ce = float(torch.logsumexp(logits[valid], dim=0) - target_logit)
    require(math.isfinite(ce) and abs(ce - direct_ce) <= 2e-5,
            "rank logits do not agree with production tiled cross-entropy")
    return {"selectedLexicalPositions": len(labels), "firstTargetTokenId": target,
            "firstTargetTokenHex": codec.decode([target]).hex(), "firstTargetRank": rank,
            "firstTargetCrossEntropy": ce, "firstTargetProbability": math.exp(-ce),
            "argmaxTokenId": argmax, "argmaxTokenHex": codec.decode([argmax]).hex(),
            "validVocabularyRows": int(valid.sum()),
            "labelIdsSha256": digest(labels.tolist()), "alphabet": snapshot(valid),
            "states": snapshot(states), "rankTieRule": "lower token ID wins equal logits",
            "probabilityConditioning": "teacher-forced target mode, length, and terminal; first lexical position"}


def score_first_target(model, state, training_request, serving_request, *, seed=SEED):
    """Run only the existing grouped teacher objective; never decode a free record."""
    import torch
    from megatoken.model.multitrack import MultiTrackGenerator, _GroupedTeacherReadout
    require(len(training_request["plans"]) == 1, "one scored physical target required")
    plan = training_request["plans"][0]
    require(snapshot(tuple(plan.mode_specs)) == snapshot(tuple(serving_request["specs"])),
            "training and serving public output support differs")
    before = snapshot(state)
    original_readout = _GroupedTeacherReadout.losses_for_selected
    original_loss = model.decoder.vocabulary.loss
    observed = []
    active = []
    def lexical(states, labels, valid):
        losses = original_loss(states, labels, valid)
        require(len(active) == 1 and "lexical" not in active[0], "unexpected lexical scoring branch")
        active[0]["lexical"] = first_lexical_metrics(model.decoder.vocabulary, states, labels, valid, losses, model.codec)
        return losses
    def readout(owner, raw, plans, *args, **kwargs):
        require(len(observed) < 2 and plans == training_request["plans"], "unexpected teacher objective branch")
        row = {"kind": "prior" if not observed else "reconstruction", "facets": snapshot(raw)}
        active.append(row)
        try:
            losses = original_readout(owner, raw, plans, *args, **kwargs)
        finally:
            active.pop()
        row["objectives"] = {name: {"sum": float(value), "positions": count}
                             for name, (value, count) in losses.items()}
        observed.append(row)
        return losses
    request = dict(training_request)
    request.update(tracks=serving_request["tracks"], event_ids=serving_request["event_ids"],
                   control_payloads=serving_request["controls"], effort=serving_request["effort"],
                   generator=torch.Generator(device="cpu").manual_seed(seed), position_audit=None)
    with patch.object(_GroupedTeacherReadout, "losses_for_selected", readout), \
            patch.object(model.decoder.vocabulary, "loss", lexical):
        result = MultiTrackGenerator.of(model).supervised_meridian(state, **request)
    require(len(observed) == 2 and all("lexical" in row for row in observed), "both teacher objectives required")
    require(snapshot(state) == before, "teacher scoring mutated its input continuation")
    require(all(math.isfinite(value["sum"]) for row in observed for value in row["objectives"].values()),
            "nonfinite teacher objective")
    del result  # Its diagnostic next state is never committed to a live session.
    return {"objectives": observed, "noiseSeed": seed,
            "noiseQualification": "common deterministic diagnostic prior/reconstruction draws; not a replay of historical emitted draws",
            "freeGeneratedRecords": 0, "committedRecords": 0, "scoredPhysicalTargets": 1}
