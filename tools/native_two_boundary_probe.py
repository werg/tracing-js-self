#!/usr/bin/env python3
"""Compare two real native boundaries after committing an actual v6 selection.

The first record must come from the reloaded service and equal the admitted
training prefix. No teacher record is inserted into serving. Sampling is coupled
only by seeding the real Gaussian sampler at each boundary; its distribution
and samples are never replaced. This diagnostic takes no optimizer steps.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gc
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from native_conditional_probe import (
    capture_prior, compare_priors, compare_recurrent_states, digest,
    require_checkpoint_hash, tensor_record,
)
from native_decoder_capture import compare_output_support, observe_decoder

_SPEC = importlib.util.spec_from_file_location(
    "paired_conditional_cli", Path(__file__).with_name("probe-native-conditionals.py")
)
PAIR = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(PAIR)
SMOKE = PAIR.SMOKE


def require(condition, message):
    if not condition:
        raise ValueError(message)


@contextmanager
def coupled_samples(seed):
    """Keep the native draw; remove irrelevant differences in earlier RNG use."""
    import torch
    from megatoken.model.multitrack import MultiTrackGenerator

    original = MultiTrackGenerator._sample_policy
    samples = []

    def sample(distribution, names, generator):
        local = torch.Generator(device=distribution.mean.device).manual_seed(seed + len(samples))
        value = original(distribution, names, local)
        samples.append({
            "eventIds": list(names), "seed": seed + len(samples),
            "nativeUnmodifiedSample": tensor_record(value),
        })
        return value

    with patch.object(MultiTrackGenerator, "_sample_policy", staticmethod(sample)):
        yield samples


def compare_track_context(training, serving):
    """Compare actual addresses and causal attachment, retaining distinct IDs."""
    left, right = training["boundary"], serving["boundary"]
    fields = (
        "tracks", "trackRegistry", "trackDescriptions", "eventsSeen", "meridiansSeen", "modelVersion",
        "historyTracks", "historyPositions", "contextDropped", "frontierTracks",
        "frontierModalities", "meridianSizes", "contextSeen", "contextPolicy",
    )
    comparisons = {name: left[name] == right[name] for name in fields}
    # Native data and runtime allocate different opaque event IDs. Neither
    # string is rewritten in the captures. Attachments and chronological
    # positions must still match exactly, with one ID per event on each side.
    id_shapes = {
        "trainingHistoryAttachment": len(left["historyEventIds"]) == len(left["historyTracks"]) == len(left["historyPositions"]),
        "servingHistoryAttachment": len(right["historyEventIds"]) == len(right["historyTracks"]) == len(right["historyPositions"]),
        "trainingFrontierAttachment": len(left["frontierEventIds"]) == len(left["frontierTracks"]) == len(left["frontierModalities"]),
        "servingFrontierAttachment": len(right["frontierEventIds"]) == len(right["frontierTracks"]) == len(right["frontierModalities"]),
    }
    from megatoken.model.config import RESERVED_TRACKS

    def valid_history(boundary):
        identities, tracks = boundary["historyEventIds"], boundary["historyTracks"]
        if len(identities) != len(tracks):
            return False
        physical = []
        for event_id, track in zip(identities, tracks, strict=True):
            if track in RESERVED_TRACKS:
                if event_id != track:
                    return False
            else:
                if not event_id or event_id in RESERVED_TRACKS:
                    return False
                physical.append(event_id)
        # Transducer controls intentionally recur with their reserved track ID.
        # Ordinary physical records still need distinct retained identities.
        return len(set(physical)) == len(physical)

    id_shapes["trainingHistoryIdentityValidity"] = valid_history(left)
    id_shapes["servingHistoryIdentityValidity"] = valid_history(right)
    correspondences = {}
    for name in ("historyEventIds", "frontierEventIds"):
        a, b = left[name], right[name]
        id_shapes[name] = len(a) == len(b)
        if name == "frontierEventIds":
            id_shapes[name] &= (all(a) and all(b) and
                                len(set(a)) == len(a) and len(set(b)) == len(b))
        correspondences[name] = [
            {"position": i, "training": x, "serving": y}
            for i, (x, y) in enumerate(zip(a, b))
        ]
    return {
        "status": "passed" if all(comparisons.values()) and all(id_shapes.values()) else "failed",
        "fields": comparisons, "eventIdentityShapeChecks": id_shapes,
        "opaqueEventIdCorrespondence": correspondences,
        "trackAddressesRemapped": False, "eventIdsRewritten": False,
        "modelVersions": {"training": left["modelVersion"], "serving": right["modelVersion"]},
        "scope": "Exact native track addresses, descriptions, causal order and event attachment",
    }


def compare_decision_controls(training, serving):
    """Compare the same policy call, retaining unequal observation-hook scopes."""
    import math

    left = training.get("trainingCall", {}).get("controlHex")
    right = serving.get("servingCall", {}).get("controlHex")
    byte_match = isinstance(left, list) and isinstance(right, list) and left == right
    a, b = training["boundary"]["encodedControl"], serving["boundary"]["encodedControl"]
    tensor = {"status": "failed", "maximumAbsoluteDifference": None}
    if a is None or b is None:
        tensor.update(status="passed" if a is None and b is None else "failed",
                      bothAbsent=a is None and b is None)
    elif a["shape"] == b["shape"] and len(a["values"]) == len(b["values"]):
        pairs = list(zip(a["values"], b["values"], strict=True))
        finite = all(math.isfinite(x) and math.isfinite(y) for x, y in pairs)
        maximum = max((abs(x - y) for x, y in pairs), default=0.0)
        passed = finite and all(abs(x - y) <= 1e-6 + 1e-5 * abs(x) for x, y in pairs)
        tensor.update(status="passed" if passed else "failed",
                      maximumAbsoluteDifference=maximum, comparedCoordinates=len(pairs),
                      absoluteTolerance=1e-6, relativeTolerance=1e-5)
    return {
        "status": "passed" if byte_match and tensor["status"] == "passed" else "failed",
        "publicControlBytesEqual": byte_match, "encodedControl": tensor,
        "fullEncoderHookListsComparable": False,
        "encoderHookScopes": {
            "training": "Selected supervised_meridian call only; earlier prefix replay already completed",
            "serving": "Selected adapter call, including any prefix replay before this policy draw",
        },
        "observedEncoderCallCounts": {
            "training": len(training["encoderCalls"]), "serving": len(serving["encoderCalls"]),
        },
        "scope": "Same current public policy controls and their actual encoded tensors; recurrent-state parity separately checks the accumulated context",
    }


def compare_singleton_text_choices(training, serving):
    """Observe actual legal modality and mode supports for this text-only request."""
    modalities = {}
    modes = {}
    for name, capture in (("training", training), ("serving", serving)):
        calls = capture.get("modalityCalls", [])
        rows = [row for call in calls for row in call["rows"]]
        modalities[name] = {
            "calls": len(calls), "rows": rows,
            "textOnly": len(calls) == 1 and len(rows) == 1 and
                rows[0]["support"] == [0] and rows[0]["probabilities"] == [1.0],
        }
        supports = capture["decoderExecution"].get("publicModeSupports", [])
        modes[name] = {
            "actualPublicSupports": supports,
            "textOnly": bool(supports) and all(support == [0] for support in supports),
        }
    rendered_modes = [row for row in serving["decoderExecution"]["categoricals"]
                      if row["name"] == "mode"]
    renderer_text_only = (len(rendered_modes) == 1 and rendered_modes[0]["support"] == [0]
                          and rendered_modes[0]["probabilities"] == [1.0]
                          and rendered_modes[0]["selected"] == 0)
    passed = (all(row["textOnly"] for row in modalities.values()) and
              all(row["textOnly"] for row in modes.values()) and renderer_text_only)
    return {
        "status": "passed" if passed else "failed",
        "modality": modalities, "mode": modes,
        "actualRendererTextChoice": renderer_text_only,
        "conditionalProbability": 1.0 if passed else None,
        "scope": "Actual native masks and public support calls must make modality and output mode singleton text choices; no equality claim for unsupported raw logits",
    }


def compare_actual_samples(training, serving, boundary):
    """Verify the native draws themselves, not only their Gaussian parameters."""
    import math

    sides = {}
    for name, capture in (("training", training), ("serving", serving)):
        draws = capture.get("coupledSamples", [])
        if len(draws) != boundary:
            return {"status": "failed", "reason": name + " native draw count differs"}
        draw = draws[boundary - 1]
        original = capture.get("actualSampledFacets")
        wrapped = draw["nativeUnmodifiedSample"]
        if original is None or original != wrapped:
            return {"status": "failed", "reason": name + " captured draw differs from actual native sample"}
        sides[name] = {"seed": draw["seed"], "eventIds": draw["eventIds"], "tensor": original}
    a, b = sides["training"]["tensor"], sides["serving"]["tensor"]
    shapes = a["shape"] == b["shape"] and len(a["values"]) == len(b["values"]) == math.prod(a["shape"])
    same_seed = sides["training"]["seed"] == sides["serving"]["seed"]
    differences = [abs(x - y) for x, y in zip(a["values"], b["values"])] if shapes else []
    finite = shapes and all(math.isfinite(x) for x in a["values"] + b["values"])
    maximum = max(differences, default=0.0) if shapes else None
    passed = finite and same_seed and maximum <= 1e-6
    return {
        "status": "passed" if passed else "failed",
        "sameNativeDrawSeed": same_seed, "seed": sides["training"]["seed"],
        "shapesEqual": shapes, "comparedCoordinates": len(differences),
        "maximumAbsoluteDifference": maximum, "absoluteTolerance": 1e-6,
        "bitwiseEqual": shapes and a["float32Sha256"] == b["float32Sha256"],
        "trainingSha256": a["float32Sha256"], "servingSha256": b["float32Sha256"],
        "trainingEventIds": sides["training"]["eventIds"],
        "servingEventIds": sides["serving"]["eventIds"],
        "scope": "Original native samples at the same boundary and seeded draw, with no tensor replacement",
    }


def numeric_decoder_comparison(model, teacher, renderer, emitted_ids):
    """Measure full probabilities from actual captured native projected states.

    A hash mismatch alone cannot distinguish float32 roundoff from a different
    conditional. Compare every permitted token, and bound both the largest
    coordinate error and total variation. No model state or output is repaired.
    """
    import math
    import torch

    teacher_ids = [token["tokenId"] for call in teacher["lexical"] for token in call["tokens"]]
    renderer_ids = [token["tokenId"] for call in renderer["lexical"] for token in call["tokens"]]
    require(teacher_ids == renderer_ids == list(emitted_ids),
            "Same-emission scoring changed original emitted token IDs")
    teacher_log_prob, serving_log_prob = 0.0, 0.0
    max_error, max_tv, compared = 0.0, 0.0, 0
    differences = []
    left = {r["name"]: r for r in teacher["categoricals"]}
    right = {r["name"]: r for r in renderer["categoricals"]}
    for name in ("length", "terminal"):
        a, b = left.get(name), right.get(name)
        require(a is not None and b is not None, "Missing actual structural decoder head")
        require(a["support"] == b["support"], "Actual structural support differs")
        require(a["selected"] == b["selected"] and a["selected"] in a["support"],
                "Same-emission scoring changed original structural choice")
        selected = a["support"].index(a["selected"])
        teacher_log_prob += math.log(max(a["probabilities"][selected], 1e-300))
        serving_log_prob += math.log(max(b["probabilities"][selected], 1e-300))
        x = torch.tensor(a["probabilities"], dtype=torch.float64)
        y = torch.tensor(b["probabilities"], dtype=torch.float64)
        delta = (x - y).abs()
        error, tv = float(delta.max()), float(delta.sum() / 2)
        max_error, max_tv = max(max_error, error), max(max_tv, tv)
        compared += len(x)
        differences.append({"head": name, "maximumAbsoluteDifference": error, "totalVariation": tv})
    require(len(teacher["lexical"]) == len(renderer["lexical"]) > 0,
            "Actual lexical decoder call counts differ")
    allowed = model.decoder.valid_utf8
    alphabet_sha = hashlib.sha256(allowed.detach().cpu().numpy().tobytes()).hexdigest()
    support = allowed.nonzero().reshape(-1)
    weights = model.decoder.vocabulary.embedding.weight.detach().float().index_select(0, support)
    exact_lexical = True
    with torch.no_grad():
        for call, (a, b) in enumerate(zip(teacher["lexical"], renderer["lexical"], strict=True)):
            require(a["alphabetSha256"] == b["alphabetSha256"] == alphabet_sha,
                    "Captured alphabet differs from the actual loaded decoder")
            require(a["positions"] == b["positions"], "Same-emission scoring changed token count")
            exact_lexical &= a["fullConditionalProbabilitiesSha256"] == b["fullConditionalProbabilitiesSha256"]
            x = torch.tensor(a["projectedStates"]["values"], dtype=torch.float32).reshape(
                a["projectedStates"]["shape"])
            y = torch.tensor(b["projectedStates"]["values"], dtype=torch.float32).reshape(
                b["projectedStates"]["shape"])
            require(x.shape == y.shape, "Actual lexical state shapes differ")
            for position, (u, v) in enumerate(zip(x, y, strict=True)):
                p = (u[None] @ weights.T).softmax(-1)[0]
                q = (v[None] @ weights.T).softmax(-1)[0]
                require(bool(torch.isfinite(p).all() and torch.isfinite(q).all()),
                        "Nonfinite full lexical conditional")
                token_id = a["tokens"][position]["tokenId"]
                token_offset = (support == token_id).nonzero().reshape(-1)
                require(token_offset.numel() == 1, "Original emitted token is outside the actual alphabet")
                teacher_log_prob += math.log(max(float(p[int(token_offset[0])]), 1e-300))
                serving_log_prob += math.log(max(float(q[int(token_offset[0])]), 1e-300))
                delta = (p.double() - q.double()).abs()
                error, tv = float(delta.max()), float(delta.sum() / 2)
                max_error, max_tv = max(max_error, error), max(max_tv, tv)
                compared += p.numel()
                differences.append({"head": "lexical", "call": call, "position": position,
                                    "maximumAbsoluteDifference": error, "totalVariation": tv})
    # Probabilities live on [0, 1]. Use the native dtype's spacing at unit scale,
    # not a decimal threshold slightly below float32 epsilon. Independent total
    # variation and selected log-probability bounds still constrain aggregate drift.
    probability_atol = torch.finfo(torch.float32).eps
    return {
        "status": "passed" if (max_error <= probability_atol and max_tv <= 1e-5
                                 and abs(teacher_log_prob - serving_log_prob) <= 1e-4) else "failed",
        "comparedProbabilities": compared, "maximumAbsoluteDifference": max_error,
        "maximumTotalVariation": max_tv, "absoluteProbabilityTolerance": probability_atol,
        "probabilityToleranceBasis": "torch.finfo(torch.float32).eps at unit probability scale",
        "totalVariationTolerance": 1e-5, "exactLexicalProbabilityHashesMatch": exact_lexical,
        "sameOriginalEmittedIds": True,
        "teacherSelectedLogProbability": teacher_log_prob,
        "servingSelectedLogProbability": serving_log_prob,
        "selectedLogProbabilityDifference": abs(teacher_log_prob - serving_log_prob),
        "selectedLogProbabilityTolerance": 1e-4, "measurements": differences,
        "scope": "Actual training readout versus actual serving decoder, scoring the same original emitted IDs",
    }


def _training_at(checkpoint, prepared, packet, *, identity, boundary, seed, emitted):
    import torch
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.data.storage import PreparedCorpus
    from megatoken.generation.structure import ActionSpec
    from megatoken.loading import load_trained
    from megatoken.model.multitrack import MultiTrackGenerator, _GroupedTeacherReadout
    from megatoken.runtime import seed_everything
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import prepare_batches, window_config
    from megatoken.training.losses import LossLedger
    from megatoken.training.meridians import forward_meridian_batch
    from megatoken.training.stream import EpisodeWindow, _WindowPlan
    from megatoken.training.transducer import TransducerTrainer

    trained = load_trained(checkpoint, device="cpu")
    require_checkpoint_hash(trained.metadata["state_sha256"], identity["checkpointStateSha256"],
                            origin="Two-boundary training reload")
    model, codec = trained.model, trained.codec
    model.eval()
    before = SMOKE.state_identity(model.state_dict())
    config = TrainConfig.from_dict(trained.payload["train_config"], expand_data=False)
    expected, _ = adapt_selected_harness_v6(
        packet["exported"], codec=codec, max_positions=model.config.max_capacity,
        max_history=model.config.max_history_chunks, allow_local=False,
        admission_verifier=lambda document:
            document["sidecar"]["identityDigest"] == packet["sourceAdmission"]["identityDigest"],
    )
    with PreparedCorpus([str(prepared)], split="train") as corpus:
        matched = [corpus.fetch(i) for i in range(len(corpus))
                   if corpus.fetch(i)[0].episode_id == expected.episode_id]
        require(len(matched) == 1, "Exactly one prepared source-certified episode is required")
        episode, assets = matched[0]
        require(PAIR.prepared_identity(episode) == PAIR.prepared_identity(expected),
                "Prepared episode changed after source certification")
        windows = _WindowPlan(episode, codec, window_config(config))
        require(len(windows) > 0, "No native trainer window")
        item = EpisodeWindow(episode, windows[0], assets)
        batches = prepare_batches(model, [item], config)
        require(len(batches) == 1, "One exact native training batch is required")
        batch = batches[0]
        require(not any(entry.record.policy_mask for step in batch.prefix for entry in step.records),
                "A generated prefix precedes the bounded comparison")
        transducer = TransducerTrainer(
            model.transducer, bank_trainable=config.trainable == "all",
            teacher_weight=config.hindsight_distill_weight,
            navigation_weight=config.navigation_weight,
            navigation_examples=config.navigation_examples,
            navigation_negatives=config.navigation_negatives,
        )
        ledger = LossLedger(dict(batch.counts), dict(batch.counts), config.loss_weights)
        original_train = MultiTrackGenerator.supervised_meridian
        original_readout = _GroupedTeacherReadout.losses_for_selected
        calls, active, result, readout_call = 0, False, None, None

        class Captured(BaseException):
            pass

        def readout(self, raw, plans, control=None, mixture=None, track_ids=None):
            nonlocal readout_call
            if active and self.core is model.core and readout_call is None:
                readout_call = (self, raw, control, mixture, track_ids)
            return original_readout(self, raw, plans, control, mixture, track_ids)

        def train(self, state, **kwargs):
            nonlocal calls, active, result
            calls += 1
            if calls != boundary:
                return original_train(self, state, **kwargs)
            active = True
            try:
                # Restore the genuine entry point while installing the existing
                # capture, so the probe records its original training arguments.
                with patch.object(MultiTrackGenerator, "supervised_meridian", original_train):
                    result = capture_prior(
                        lambda: self.supervised_meridian(state, **kwargs), model,
                        path="training", identity=identity, execute_decoder=True,
                    )
            finally:
                active = False
            raise Captured()

        seed_everything(seed, True)
        with torch.no_grad(), coupled_samples(seed) as samples:
            with patch.object(MultiTrackGenerator, "supervised_meridian", train), \
                 patch.object(_GroupedTeacherReadout, "losses_for_selected", readout):
                try:
                    forward_meridian_batch(
                        model, batch, ledger, config, torch.device("cpu"),
                        trained.payload["global_step"], differentiate=False, transducer=transducer,
                    )
                except Captured:
                    pass
        require(result is not None and readout_call is not None and calls == boundary,
                "The actual trainer did not reach the requested boundary")
        require(len(samples) == boundary, "Unexpected extra native policy draws")
        action = emitted["decoderExecution"]["originalEmission"]
        require(action["valid"] and action["tokenIds"], "Original serving emission is not scoreable")
        spec = ActionSpec(**emitted["servingCall"]["specs"][0])
        plan = model.prepare_target([action["tokenIds"]], terminal=[action["terminal"]],
                                    mode_specs=[spec])
        owner, raw, control, mixture, track_ids = readout_call
        with torch.no_grad(), observe_decoder(model) as replay:
            terms = original_readout(owner, raw, (plan,), control, mixture, track_ids)
        replay_comparison = numeric_decoder_comparison(model, replay, emitted["decoderExecution"], action["tokenIds"])
        result.update(
            boundaryIndex=boundary, coupledSamples=samples,
            preparedEpisodeId=episode.episode_id, preparedCorpusIdentity=corpus.identity,
            actualModelTensorIdentity=SMOKE.state_identity(model.served_state_dict()),
            servedStateDictCompared=True,
            sameEmissionTrainingReadout={
                "originalEmissionUsedWithoutRepair": True, "optimizerSteps": 0,
                "capture": replay, "comparison": replay_comparison,
                "losses": {name: {"sum": float(total.detach()), "count": count}
                           for name, (total, count) in terms.items()},
            },
        )
    require(SMOKE.state_identity(model.state_dict()) == before,
            "Read-only two-boundary training capture changed model weights")
    result["modelStateUnchanged"] = True
    return result


def _advance_prefix(packet, selection):
    public = packet["exported"]["public"]
    message = {
        "publicHeader": {name: value for name, value in public.items() if name != "timeline"},
        "prefix": packet["prefix"], "selection": selection,
    }
    completed = subprocess.run(
        ["node", str(Path(__file__).with_name("advance-native-probe-prefix.mjs"))],
        input=json.dumps(message), text=True, capture_output=True, check=True, timeout=30,
    )
    result = json.loads(completed.stdout)
    require(result["semanticValidation"] == "passed" and not result["teacherSubstitution"],
            "Actual model output did not pass the public semantic controller")
    return result


def _serving_pair(bundle_path, packet, *, identity, seed, max_tokens):
    import torch
    from megatoken.served import ServedBundle
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.semantic_model_adapter import SelectedSemanticInference

    served = ServedBundle(bundle_path, device="cpu")
    require_checkpoint_hash(served.manifest["checkpoint_sha256"], identity["checkpointStateSha256"],
                            origin="Two-boundary served reload")
    model = served.model
    model.eval()
    before = SMOKE.state_identity(model.state_dict())

    def opened():
        runtime = MultiTrackRuntime(MultiTrackGenerator.of(model), chunking=served.chunking)
        adapter = SelectedSemanticInference(
            runtime, effort=1, max_tokens=max_tokens, model_identity=served.manifest["model_sha256"])
        adapter.initialize(seed=seed, checkpointIdentity=served.manifest["model_sha256"])
        return runtime, adapter

    runtime, adapter = opened()
    try:
        with torch.no_grad(), coupled_samples(seed) as samples:
            first = capture_prior(lambda: adapter.select(packet["prefix"]), model,
                                  path="serving", identity=identity, execute_decoder=True)
        first["coupledSamples"] = samples
        require(len(samples) == 1, "First capture made more than one native draw")
    finally:
        runtime.close()
    runtime, adapter = opened()
    try:
        with torch.no_grad(), coupled_samples(seed) as samples:
            actual = adapter.select(packet["prefix"])
            require(actual["selection"]["origin"] == "actual-model-selected"
                    and actual["selection"]["modelSelected"] is True,
                    "A controlled or substituted selection cannot establish recurrence parity")
            require(actual["record"] == packet["firstTarget"]["record"],
                    "Actual first service output differs from the admitted training prefix")
            require(actual["record"].encode().hex() ==
                    first["decoderExecution"]["originalEmission"]["payloadHex"],
                    "Repeated native first selection changed under the same coupled draw")
            committed = _advance_prefix(packet, actual)
            second_identity = dict(identity, publicPrefixSha256=digest(committed["prefix"]))
            second = capture_prior(lambda: adapter.select(committed["prefix"]), model,
                                   path="serving", identity=second_identity, execute_decoder=True)
        require(len(samples) == 2, "Two complete prefix boundaries must use exactly two native draws")
        second["coupledSamples"] = samples
        second["actualPreviousSelection"] = actual
        second["publicCommitment"] = committed
    finally:
        runtime.close()
    require(SMOKE.state_identity(model.state_dict()) == before,
            "Read-only serving comparison changed model weights")
    for index, result in enumerate((first, second), 1):
        result.update(boundaryIndex=index, actualServedTensorIdentity=SMOKE.state_identity(model.served_state_dict()),
                      modelStateUnchanged=True, runtimeClosed=True)
    return (first, second), actual, committed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consumer-root", required=True, type=Path)
    parser.add_argument("--episode", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--served-bundle", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--max-tokens", type=int, default=128)
    args = parser.parse_args()
    require(1 <= args.max_tokens <= 1024, "Invalid serving capacity")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    tracer = Path(__file__).resolve().parents[1]
    consumer = args.consumer_root.resolve()
    sys.path.insert(0, str(consumer / "src"))
    import torch
    torch.set_num_threads(1)
    SMOKE.require_clean_checkout(tracer)
    SMOKE.require_clean_checkout(consumer)
    packet = json.loads(subprocess.check_output(
        ["node", str(tracer / "tools/build-native-probe-input.mjs"), str(args.episode.resolve())],
        text=True, timeout=120,
    ))
    candidate = json.loads(args.episode.read_text())
    require(candidate["sidecar"]["admission"] == "admitted"
            and candidate["sidecar"]["split"] == "train"
            and candidate["sidecar"]["producerRevision"] == SMOKE.git_head(tracer)
            and candidate["sidecar"]["nativePolicy"]["consumerRevision"] == SMOKE.git_head(consumer),
            "Current paired native-admitted training input is required")
    from megatoken.training.checkpoint import load_checkpoint, resolve_checkpoint
    checkpoint = resolve_checkpoint(args.checkpoint).resolve(strict=True)
    payload, metadata = load_checkpoint(checkpoint)
    del payload
    manifest = json.loads((args.served_bundle / "manifest.json").read_text())
    require_checkpoint_hash(manifest["checkpoint_sha256"], metadata["state_sha256"],
                            origin="Served artifact attachment")
    identity = {
        "checkpointStateSha256": metadata["state_sha256"],
        "servedModelSha256": manifest["model_sha256"],
        "tokenizerIdentity": manifest["codec_fingerprint"],
        "publicPrefixSha256": digest(packet["prefix"]),
        "firstTargetSha256": hashlib.sha256(packet["firstTarget"]["record"].encode()).hexdigest(),
    }
    serving, actual, commitment = _serving_pair(
        args.served_bundle, packet, identity=identity, seed=args.seed, max_tokens=args.max_tokens)
    comparisons = []
    for index, emitted in enumerate(serving, 1):
        SMOKE.write_json(output / f"serving-boundary-{index}.json", emitted)
        training = _training_at(
            checkpoint, args.prepared, packet, identity=emitted["identity"],
            boundary=index, seed=args.seed, emitted=emitted)
        SMOKE.write_json(output / f"training-boundary-{index}.json", training)
        prior = compare_priors(training, emitted)
        prior["scope"] = f"Actual native Gaussian at generated boundary {index}"
        recurrence = compare_recurrent_states(training, emitted)
        tracks = compare_track_context(training, emitted)
        controls = compare_decision_controls(training, emitted)
        singletons = compare_singleton_text_choices(training, emitted)
        samples = compare_actual_samples(training, emitted, index)
        support = compare_output_support(training, emitted)
        decoder = training["sameEmissionTrainingReadout"]["comparison"]
        tensor_identity = training["actualModelTensorIdentity"] == emitted["actualServedTensorIdentity"]
        passed = all(row["status"] == "passed" for row in (prior, recurrence, tracks, controls, singletons, samples, support, decoder))
        passed &= tensor_identity
        prior["encoderCallAuditComparable"] = False
        prior["encoderCallAuditInterpretation"] = controls["encoderHookScopes"]
        comparisons.append({
            "boundary": index, "status": "passed" if passed else "failed",
            "gaussian": prior, "recurrentState": recurrence, "tracks": tracks,
            "decisionControls": controls, "singletonTextChoices": singletons,
            "actualSampledFacets": samples, "outputSupport": support, "sameEmissionDecoderConditionals": decoder,
            "loadedModelTensorsExactlyEqual": tensor_identity,
        })
        del training
        gc.collect()
    report = {
        "schema": "semantic-native-two-boundary-parity/1",
        "status": "passed" if all(row["status"] == "passed" for row in comparisons) else "failed",
        "producerRevision": SMOKE.git_head(tracer), "consumerRevision": SMOKE.git_head(consumer),
        "identity": identity, "episodeSha256": packet["episodeSha256"],
        "sourceAdmission": packet["sourceAdmission"], "comparisons": comparisons,
        "actualFirstRecord": actual["record"], "actualFirstSelection": actual["selection"],
        "firstRecordPassedPublicController": commitment["semanticValidation"] == "passed",
        "actualReturnedSemanticSelections": 1, "optimizerSteps": 0,
        "sampling": "Real native Gaussian draws coupled by seed + boundary index; no replacement tensors",
        "teacherSubstitutionInServing": False,
        "scope": "Two generated boundaries on one admitted async prefix, one exact saved checkpoint, CPU float32, dropout disabled",
        "wholeEpisodeOrGeneralizationClaim": False,
    }
    SMOKE.write_json(output / "report.json", report)
    print(json.dumps(report, ensure_ascii=False))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
