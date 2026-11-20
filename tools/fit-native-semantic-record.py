#!/usr/bin/env python3
"""Bounded native decoder fit against one actually admitted semantic record.

The script captures the original trainer boundary, uses the actual grouped
supervision method and MasterAdamW owner, and repeatedly tests the actual
SelectedSemanticInference service. Only decoder parameters are updated. It
saves a full checkpoint with truthful optimizer state and requires the reloaded
served bundle to emit the exact complete target as a strict v6 record.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_digest(value) -> str:
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False,
                     separators=(",", ":"), allow_nan=False).encode("utf-8")
    return sha(raw)


def tensor_record(value):
    import torch

    tensor = value.detach().cpu().float().contiguous()
    raw = tensor.numpy().tobytes()
    return {"shape": list(tensor.shape), "float32Sha256": sha(raw),
            "values": tensor.reshape(-1).tolist()}


def tensor_identity(state_dict) -> str:
    import torch

    digest = hashlib.sha256()
    for name, value in sorted(state_dict.items()):
        tensor = value.detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(tensor.dtype).encode("ascii"))
        digest.update(json.dumps(list(tensor.shape), separators=(",", ":")).encode("ascii"))
        digest.update(tensor.reshape(-1).view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    temp.replace(path)


def packet_for(tracer_root: Path, episode_path: Path) -> dict:
    return json.loads(subprocess.check_output(
        ["node", str(tracer_root / "tools/build-native-probe-input.mjs"), str(episode_path)],
        cwd=tracer_root, text=True, timeout=120))


def validate_admission(packet: dict, episode: dict, tracer_revision: str,
                       consumer_revision: str) -> None:
    sidecar = episode.get("sidecar", {})
    require(sidecar.get("admission") == "admitted" and sidecar.get("split") == "train",
            "Fit requires an admitted training episode")
    require(sidecar.get("producerRevision") == tracer_revision,
            "Candidate producer revision does not match the checked tracer")
    policy = sidecar.get("nativePolicy", {})
    require(policy.get("consumerRevision") == consumer_revision,
            "Candidate consumer revision does not match the checked consumer")
    receipt = packet.get("sourceAdmission", {})
    checks = ("identityValidated", "journalValidated", "replayValidated",
              "sourceValidated", "effectsValidated")
    require(all(receipt.get(name) is True for name in checks),
            "Source admission did not validate every identity, journal, replay, source and effect proof")
    require(receipt.get("identityDigest") == sidecar.get("identityDigest"),
            "Source admission identity differs from the episode receipt")


def prepared_identity(episode) -> str:
    value = episode.to_dict()
    value = {key: item for key, item in value.items() if key not in {"lineage", "supervision"}}
    return json_digest(value)


def plan_payloads(plan) -> tuple[bytes, ...]:
    if hasattr(plan, "payloads"):
        return tuple(plan.payloads)
    if hasattr(plan, "payload"):
        return (plan.payload,)
    return ()


class TrainerBoundaryReached(BaseException):
    """Stops the real first training pass after reaching the chosen target."""


def capture_training_boundary(model, trained, episode, assets, codec, config,
                              target: bytes, seed: int):
    """Replay the deliberately frozen prefix in the actual service's grad mode."""
    import torch
    from unittest.mock import patch
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.training.engine import prepare_batches, window_config
    from megatoken.training.losses import LossLedger
    from megatoken.training.meridians import forward_meridian_batch
    from megatoken.training.stream import EpisodeWindow, _WindowPlan
    from megatoken.training.transducer import TransducerTrainer

    plan = _WindowPlan(episode, codec, window_config(config))
    require(len(plan) > 0, "Admitted episode has no native scored training window")
    item = EpisodeWindow(episode, plan[0], assets)
    (batch,) = prepare_batches(model, [item], config)
    targets = [record for step in batch.steps for record in step.records
               if record.record.policy_mask]
    require(targets and targets[0].record.payload == target,
            "First prepared target is not the exact complete public target record")
    require(not any(record.record.policy_mask for step in batch.prefix for record in step.records),
            "A generated decision appears before the target boundary")

    captured = {}
    original = MultiTrackGenerator.supervised_meridian

    def stop_at_first_target(multi, state, **kwargs):
        if any(target in plan_payloads(plan) for plan in kwargs["plans"]):
            require("state" not in captured, "Target boundary was visited more than once")
            captured["state"] = state.detach()
            captured["kwargs"] = dict(kwargs)
            captured["trainingTracks"] = list(kwargs["tracks"])
            captured["trainingEventIds"] = list(kwargs["event_ids"])
            raise TrainerBoundaryReached
        return original(multi, state, **kwargs)

    transducer = TransducerTrainer(
        model.transducer,
        bank_trainable=config.trainable == "all",
        teacher_weight=config.hindsight_distill_weight,
        navigation_weight=config.navigation_weight,
        navigation_examples=config.navigation_examples,
        navigation_negatives=config.navigation_negatives,
    )
    ledger = LossLedger(dict(batch.counts), dict(batch.counts), config.loss_weights)
    model.eval()
    # This decoder-only experiment detaches and reuses the prefix; it never
    # differentiates through that replay. Match the no-grad serving computation
    # here as well: CPU attention selects different arithmetic kernels when its
    # inputs require gradients. The selected decoder loss below still builds
    # its real gradient graph and runs the unchanged optimizer.
    with torch.no_grad(), patch.object(MultiTrackGenerator, "supervised_meridian", stop_at_first_target):
        try:
            forward_meridian_batch(
                model, batch, ledger, config, torch.device("cpu"),
                trained.payload["global_step"], differentiate=False, transducer=transducer)
        except TrainerBoundaryReached:
            pass
        else:
            raise ValueError("Production trainer did not reach the exact first target boundary")
    require("state" in captured, "Actual trainer boundary state was not captured")
    captured["batch"] = batch
    captured["targetRecordId"] = targets[0].record.record_id
    captured["targetTokenIds"] = list(targets[0].token_ids)
    captured["targetFreeMask"] = list(targets[0].free_mask)
    captured["window"] = {"start": item.window.start, "end": item.window.end}
    captured["seed"] = seed
    captured["prefixReplayGradientEnabled"] = False
    return captured


def actual_service(model, codec, chunking, prefix: dict, *, seed: int, max_tokens: int):
    import torch
    from unittest.mock import patch
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.multitrack_runtime import MultiTrackRuntime
    from megatoken.semantic_model_adapter import SelectedSemanticInference, SemanticSelectionError
    from native_conditional_probe import recurrent_state_record

    require(model.codec.fingerprint == codec.fingerprint,
            "Service model and loaded checkpoint use different tokenizers")
    model.eval()
    runtime = MultiTrackRuntime(MultiTrackGenerator.of(model), chunking=chunking)
    adapter = SelectedSemanticInference(runtime, effort=1, max_tokens=max_tokens)
    original_sample = MultiTrackGenerator._sample_policy
    original_prior = MultiTrackGenerator._prior
    samples, priors = [], []

    def sample(distribution, names, generator):
        draw_seed = seed + len(samples)
        local = torch.Generator(device=distribution.mean.device).manual_seed(draw_seed)
        value = original_sample(distribution, names, local)
        samples.append({"sample": tensor_record(value), "eventIds": list(names),
                        "seed": draw_seed})
        return value

    def prior(multi, mean, state, tracks, control=None):
        distribution = original_prior(multi, mean, state, tracks, control)
        priors.append({
            "conditional": {
                "mean": tensor_record(distribution.mean),
                "logScale": tensor_record(distribution.log_scale),
            },
            "recurrentState": recurrent_state_record(state, mean),
            "tracks": list(tracks),
            "trackRegistry": list(state.track_registry),
            "historyEventIds": list(state.history_event_ids),
            "historyEventTracks": list(state.history_event_tracks),
            "frontierEventIds": list(state.frontier_event_ids),
            "frontierTracks": list(state.frontier_tracks),
        })
        return distribution

    capture = {"selection": None, "record": None, "error": None, "evidence": None}
    try:
        identity = adapter._identity()
        adapter.initialize(seed=seed, checkpointIdentity=identity)
        with patch.object(MultiTrackGenerator, "_prior", prior), \
             patch.object(MultiTrackGenerator, "_sample_policy", staticmethod(sample)):
            try:
                capture["selection"] = adapter.select(prefix)
                capture["record"] = capture["selection"]["record"]
            except SemanticSelectionError as error:
                capture["error"] = f"{type(error).__name__}: {error}"
                capture["evidence"] = error.evidence
        capture.update(samples=samples, priors=priors, runtimeModelIdentity=identity)
        capture["coupledSampling"] = {
            "seedAtFirstNativeSampleBoundary": seed,
            "subsequentDrawSeeds": "seed + draw_index",
            "sampleIsUnmodifiedNativeDraw": True,
            "globalRngSequenceEqualityClaimed": False,
        }
        return capture
    finally:
        runtime.close()


def max_tensor_difference(left: dict, right: dict) -> dict:
    if left["shape"] != right["shape"]:
        return {"status": "failed", "reason": "shape",
                "leftShape": left["shape"], "rightShape": right["shape"]}
    if (len(left["values"]) != len(right["values"]) or
            not all(math.isfinite(x) for x in left["values"] + right["values"])):
        return {"status": "failed", "reason": "nonfinite-or-inconsistent-values"}
    diffs = [abs(a - b) for a, b in zip(left["values"], right["values"], strict=True)]
    return {"status": "passed" if max(diffs, default=0.0) == 0.0 else "different",
            "coordinates": len(diffs), "maximumAbsoluteDifference": max(diffs, default=0.0)}


def optimizer_step_loss(model, state, train_kwargs, optimizer, config, seed: int,
                        *, before_update=None):
    import torch
    from unittest.mock import patch
    from megatoken.model.multitrack import MultiTrackGenerator
    from native_conditional_probe import recurrent_state_record

    original_sample = MultiTrackGenerator._sample_policy
    original_prior = MultiTrackGenerator._prior
    captured = {"sampleCalls": [], "priorCalls": []}

    def sample(distribution, names, generator):
        local = torch.Generator(device=distribution.mean.device).manual_seed(seed)
        value = original_sample(distribution, names, local)
        captured["sampleCalls"].append({
            "sample": tensor_record(value), "eventIds": list(names),
            "distributionMean": tensor_record(distribution.mean),
            "distributionLogScale": tensor_record(distribution.log_scale),
            "sourceDtype": str(distribution.mean.dtype),
            "device": str(distribution.mean.device), "seed": seed,
            "gradEnabled": torch.is_grad_enabled(),
        })
        captured["sample"] = captured["sampleCalls"][0]
        return value

    def prior(multi, mean, state, tracks, control=None):
        distribution = original_prior(multi, mean, state, tracks, control)
        item = {
            "conditional": {"mean": tensor_record(distribution.mean),
                            "logScale": tensor_record(distribution.log_scale)},
            "recurrentState": recurrent_state_record(state, mean),
            "tracks": list(tracks),
            "trackRegistry": list(state.track_registry),
            "historyEventIds": list(state.history_event_ids),
            "historyEventTracks": list(state.history_event_tracks),
            "frontierEventIds": list(state.frontier_event_ids),
            "frontierTracks": list(state.frontier_tracks),
        }
        captured["priorCalls"].append(item)
        captured["prior"] = captured["priorCalls"][0]
        return distribution

    kwargs = dict(train_kwargs)
    kwargs["generator"] = None
    optimizer.zero_grad()
    model.core.routing_aux_loss(clear=True)
    with patch.object(MultiTrackGenerator, "_prior", prior), \
         patch.object(MultiTrackGenerator, "_sample_policy", staticmethod(sample)):
        result = MultiTrackGenerator.of(model).supervised_meridian(state.detach(), **kwargs)
    names = ("structure", "binding", "placement", "terminal", "lexical")
    terms, components = [], {}
    for name in names:
        numerator, count = result.losses[name]
        components[name] = {"sum": float(numerator.detach()), "count": int(count)}
        if count and config.loss_weights[name]:
            terms.append(numerator * (config.loss_weights[name] / count))
    require(terms and "sample" in captured and "prior" in captured,
            "Actual grouped supervision returned no sampled decoder training loss")
    loss = sum(terms)
    value = float(loss.detach())
    require(math.isfinite(value), "Native supervised objective became nonfinite")
    if before_update is not None:
        before_update(captured)
    loss.backward()
    update = optimizer.step(1.0)
    model.core.routing_aux_loss(clear=True)
    return value, components, captured, update


def strict_record(record: str):
    from megatoken.data.witness_v6 import parse_record

    return parse_record(record)


def fit(model, codec, chunking, prefix, target, state, train_kwargs, optimizer, config,
        *, seed: int, max_tokens: int, max_steps: int, progress_path: Path):
    history, best, first_valid = [], math.inf, None
    started = time.monotonic()
    stable_sample = None
    first_boundary_audit = None
    initial_service = actual_service(
        model, codec, chunking, prefix, seed=seed, max_tokens=max_tokens)
    require(initial_service["samples"] and initial_service["priors"],
            "Actual serving did not reach its first sampled policy boundary")
    baseline_service = initial_service["priors"][0]

    atomic_json(progress_path, {
        "schema": "semantic-native-decoder-fit-progress/1",
        "status": "running",
        "baseServiceRecord": initial_service["record"],
        "baseServiceError": initial_service["error"],
        "baseServiceSampleSha256": initial_service["samples"][0]["sample"]["float32Sha256"],
        "firstBoundaryAudit": first_boundary_audit,
    })
    def validate_boundary(captured):
        nonlocal stable_sample, first_boundary_audit
        sample_hash = captured["sample"]["sample"]["float32Sha256"]
        if stable_sample is None:
            from native_conditional_probe import compare_recurrent_states
            prior_diff = max_tensor_difference(
                captured["prior"]["conditional"]["mean"],
                baseline_service["conditional"]["mean"])
            scale_diff = max_tensor_difference(
                captured["prior"]["conditional"]["logScale"],
                baseline_service["conditional"]["logScale"])
            sample_diff = max_tensor_difference(
                captured["sample"]["sample"], initial_service["samples"][0]["sample"])
            state_diff = compare_recurrent_states(
                {"recurrentState": captured["prior"]["recurrentState"]},
                {"recurrentState": baseline_service["recurrentState"]})
            first_boundary_audit = {
                "priorMean": prior_diff, "priorLogScale": scale_diff,
                "sampleDifference": sample_diff, "recurrentState": state_diff,
                "sampleAbsoluteTolerance": 1e-6,
                "firstSampleBitwiseEqual": sample_hash == initial_service["samples"][0]["sample"]["float32Sha256"],
                "comparisonExecution": "Gradient-enabled decoder loss on a frozen prefix replayed without gradients versus no-grad actual service; finite float32 tolerances are retained with original hashes",
                "trainerTracks": captured["prior"]["tracks"],
                "trainerEventIds": captured["sample"]["eventIds"],
                "servingTracks": baseline_service["tracks"],
                "servingEventIds": initial_service["samples"][0]["eventIds"],
                "nativeTrackAddressesEqual": captured["prior"]["tracks"] == baseline_service["tracks"],
                "opaqueEventIdStringsEqual": captured["sample"]["eventIds"] == initial_service["samples"][0]["eventIds"],
                "trainerTrackRegistry": captured["prior"]["trackRegistry"],
                "servingTrackRegistry": baseline_service["trackRegistry"],
                "trackRegistryStringsEqual": captured["prior"]["trackRegistry"] == baseline_service["trackRegistry"],
                "sampleSha256": sample_hash, "unmodifiedNativeSample": True,
                "trainingSampleCalls": len(captured["sampleCalls"]),
                "trainingPriorCalls": len(captured["priorCalls"]),
                "servingSampleCalls": len(initial_service["samples"]),
                "servingPriorCalls": len(initial_service["priors"]),
                "additionalServingCalls": "Continuation fragments while the untrained decoder has not ended its first logical record; only the first draw is paired here",
                "optimizerStepsBeforeComparison": 0,
            }
            # Persist the original tensors and diagnostics before any assertion or
            # optimizer update, so a mismatch cannot hide its own cause.
            atomic_json(progress_path.with_name("boundary-comparison.json"), {
                "schema": "semantic-native-decoder-fit-boundary-comparison/1",
                "optimizerSteps": 0, "comparison": first_boundary_audit,
                "training": captured,
                "serving": {"samples": initial_service["samples"],
                            "priors": initial_service["priors"]},
            })
            require(len(captured["sampleCalls"]) == len(captured["priorCalls"]) == 1 and
                    len(initial_service["samples"]) == len(initial_service["priors"]) >= 1,
                    "First-boundary fit lacks one trainer draw or aligned serving continuation draws")
            require(prior_diff["status"] != "failed" and scale_diff["status"] != "failed",
                    "Trainer and serving prior geometry differs")
            require(prior_diff["maximumAbsoluteDifference"] <= 1e-6 and
                    scale_diff["maximumAbsoluteDifference"] <= 1e-6,
                    "Trainer and serving first-prefix prior conditionals diverged")
            require(state_diff["status"] == "passed",
                    "Actual trainer and serving recurrent states differ at the first boundary")
            require(first_boundary_audit["nativeTrackAddressesEqual"] and
                    first_boundary_audit["trackRegistryStringsEqual"],
                    "Actual native track addresses differ at the first boundary")
            require(sample_diff["status"] != "failed" and
                    sample_diff["maximumAbsoluteDifference"] <= 1e-6,
                    "Trainer and serving first-prefix draws differ beyond the declared float32 tolerance")
            stable_sample = sample_hash
        else:
            require(sample_hash == stable_sample,
                    "Frozen prior sample changed during decoder-only optimization")

    for step in range(1, max_steps + 1):
        loss, components, captured, update = optimizer_step_loss(
            model, state, train_kwargs, optimizer, config, seed,
            before_update=validate_boundary)
        sample_hash = captured["sample"]["sample"]["float32Sha256"]
        row = {
            "step": step,
            "nativeTeacherLoss": loss,
            "lossComponents": components,
            "nativeSampleSha256": sample_hash,
            "nativeSampleEventIds": captured["sample"]["eventIds"],
            "trainingTracks": captured["prior"]["tracks"],
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "gradientNorm": update["gradient_norm"],
        }
        if step == 1 or step % 8 == 0 or step == max_steps:
            service = actual_service(model, codec, chunking, prefix,
                                     seed=seed, max_tokens=max_tokens)
            emitted = service["record"]
            parsed = None
            if emitted is not None:
                try:
                    parsed = strict_record(emitted)
                except ValueError:
                    parsed = None
            row.update({
                "actualServingSamples": [item["sample"]["float32Sha256"]
                                         for item in service["samples"]],
                "actualServingEventIds": [item["eventIds"] for item in service["samples"]],
                "firstSampleDifference": None if not service["samples"] else max_tensor_difference(
                    captured["sample"]["sample"], service["samples"][0]["sample"]),
                "firstSampleBitwiseMatchesTrainer": bool(service["samples"] and
                    service["samples"][0]["sample"]["float32Sha256"] == sample_hash),
                "actualRecord": emitted,
                "actualRecordHex": None if emitted is None else emitted.encode("utf-8").hex(),
                "actualServiceError": service["error"],
                "actualServiceErrorEvidence": service["evidence"],
                "strictKind": None if parsed is None else parsed[0],
                "strictFields": None if parsed is None else parsed[1],
                "recordMatchesTarget": emitted is not None and
                    emitted.encode("utf-8") == target and parsed is not None and
                    len(service["samples"]) == 1,
                "singleCompleteNativeRecord": len(service["samples"]) == 1 and emitted is not None,
                "actualServingTracks": [item["tracks"] for item in service["priors"]],
            })
            if row["recordMatchesTarget"]:
                first_valid = step
        history.append(row)
        atomic_json(progress_path, {
            "schema": "semantic-native-decoder-fit-progress/1",
            "status": "passed" if first_valid is not None else "running",
            "optimizerStep": step,
            "firstStrictValidStep": first_valid,
            "bestNativeTeacherLoss": min(best, loss),
            "firstBoundaryAudit": first_boundary_audit,
            "history": history,
        })
        best = min(best, loss)
        if first_valid is not None:
            break
    return initial_service, history, best, first_valid, stable_sample, first_boundary_audit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--consumer-root", type=Path, required=True)
    parser.add_argument("--episode", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, choices=(17, 29, 43), default=17)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--max-steps", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=0.02)
    args = parser.parse_args()
    require(1 <= args.max_tokens <= 1024, "Serving request capacity must be 1..1024")
    require(1 <= args.max_steps <= 256, "Bounded fit supports only 1..256 optimizer updates")
    require(math.isfinite(args.learning_rate) and 0 < args.learning_rate <= 0.1,
            "Learning rate must be finite and no greater than 0.1")
    tracer_root = Path(__file__).resolve().parents[1]
    consumer_root = args.consumer_root.resolve(strict=True)
    episode_path = args.episode.resolve(strict=True)
    checkpoint_path = args.checkpoint.resolve(strict=True)
    prepared_path = args.prepared.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(consumer_root / "src"))
    sys.path.insert(0, str(tracer_root / "tools"))

    import torch
    from megatoken.data.storage import PreparedCorpus
    from megatoken.data.semantic_harness_v6 import adapt_selected_harness_v6
    from megatoken.data.chunking import ChunkingConfig
    from megatoken.generation.codec import ByteCodec
    from megatoken.loading import load_trained
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.runtime import seed_everything
    from megatoken.training.checkpoint import resolve_checkpoint, save_checkpoint, transducer_attachment
    from megatoken.training.config import TrainConfig
    from megatoken.training.optimizer import MasterAdamW
    from megatoken.served import ServedBundle, export_served

    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    seed_everything(args.seed, True)
    candidate = json.loads(episode_path.read_text())
    packet = packet_for(tracer_root, episode_path)
    tracer_revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tracer_root, text=True).strip()
    consumer_revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=consumer_root, text=True).strip()
    validate_admission(packet, candidate, tracer_revision, consumer_revision)
    atomic_json(output / "public-probe-input.json", packet)

    checkpoint_path = resolve_checkpoint(checkpoint_path).resolve(strict=True)
    trained = load_trained(checkpoint_path, device="cpu")
    original_transducer_path = checkpoint_path / trained.metadata["transducer_checkpoint"]["file"]
    original_transducer_sha = sha(original_transducer_path.read_bytes())
    require(original_transducer_sha == trained.metadata["transducer_checkpoint"]["sha256"],
            "Original transducer training attachment changed after checkpoint validation")
    # Preserve the complete native envelope (bank, optimizer, growth and any
    # other training state); a raw bank snapshot is not a checkpoint attachment.
    original_transducer_state = torch.load(
        original_transducer_path, map_location="cpu", weights_only=True)
    require(isinstance(original_transducer_state, dict) and "bank" in original_transducer_state,
            "Original checkpoint lacks its complete native transducer envelope")
    model, codec = trained.model, trained.codec
    require(codec.fingerprint == trained.payload["codec_fingerprint"],
            "Loaded checkpoint codec fingerprint differs")
    base_checkpoint_sha = trained.metadata["state_sha256"]
    config = TrainConfig.from_dict(trained.payload["train_config"], expand_data=False)
    chunking = ChunkingConfig.from_identity(trained.payload["chunking"], codec)
    chunking = chunking.with_hard_limit(model.config.max_capacity)

    expected, _ = adapt_selected_harness_v6(
        packet["exported"], codec=codec, max_positions=model.config.max_capacity,
        max_history=model.config.max_history_chunks, allow_local=False,
        admission_verifier=lambda document:
            document["sidecar"].get("identityDigest") ==
            packet["sourceAdmission"].get("identityDigest"))
    with PreparedCorpus([str(prepared_path)], split="train") as corpus:
        matches = []
        for index in range(len(corpus)):
            episode, assets = corpus.fetch(index)
            if episode.episode_id == expected.episode_id:
                matches.append((episode, assets))
        require(len(matches) == 1,
                "Prepared corpus does not contain exactly one source-certified episode")
        episode, assets = matches[0]
        require(prepared_identity(episode) == prepared_identity(expected),
                "Prepared episode differs from fresh source-certified adaptation")
        target = packet["firstTarget"]["record"].encode("utf-8")
        train = capture_training_boundary(
            model, trained, episode, assets, codec, config, target, args.seed)
        prepared_id = episode.episode_id
        prepared_corpus_identity = corpus.identity
    record = packet["firstTarget"]["record"]
    strict_kind, strict_fields = strict_record(record)
    require(record.encode("utf-8") == target and len(codec.encode(target)) <= args.max_tokens,
            "Target is not one complete serving-bounded native record")
    atomic_json(output / "trainer-boundary.json", {
        "schema": "semantic-native-decoder-fit-boundary/1",
        "trainingEventIds": train["trainingEventIds"],
        "trainingTracks": train["trainingTracks"],
        "targetRecordId": train["targetRecordId"],
        "targetTokenIds": train["targetTokenIds"],
        "targetFreeMask": train["targetFreeMask"],
        "window": train["window"],
        "targetRecord": record,
        "targetKind": strict_kind,
        "checkpointStateSha256": base_checkpoint_sha,
        "stateShape": list(train["state"].raw.shape),
        "prefixReplayGradientEnabled": train["prefixReplayGradientEnabled"],
    })

    original_payload = trained.payload
    original_optimizer = original_payload["optimizer"]
    optimizer = MasterAdamW(
        model,
        lr=args.learning_rate,
        weight_decay=0.0,
        inner_optimizer=config.inner_optimizer,
    )
    optimizer.load_state_dict(original_optimizer)
    decoder_owners = [name for name in optimizer.model_parameters if name.startswith("decoder.")]
    require(decoder_owners, "The checkpoint optimizer does not own decoder parameters")
    optimizer.freeze([name for name in optimizer.model_parameters if name not in decoder_owners])
    initial_model_state = {
        name: value.detach().cpu().clone()
        for name, value in model.state_dict().items()
    }
    initial_model_identity = tensor_identity(model.state_dict())
    initial_global_step = trained.payload["global_step"]

    initial_service, history, best_loss, first_valid, sample_sha, first_boundary_audit = fit(
        model, codec, chunking, packet["prefix"], target,
        train["state"], train["kwargs"], optimizer, config,
        seed=args.seed, max_tokens=args.max_tokens, max_steps=args.max_steps,
        progress_path=output / "fit-progress.json")
    if first_valid is None:
        optimizer.close()
        atomic_json(output / "fit-failure.json", {
            "schema": "semantic-native-decoder-fit/1",
            "status": "bounded-fit-not-yet-successful",
            "baseCheckpointStateSha256": base_checkpoint_sha,
            "optimizerSteps": args.max_steps,
            "fitHistory": history,
            "scope": "No complete strict target record was emitted by the actual semantic serving API",
        })
        return 2

    model_state = {
        name: tensor.detach().cpu().contiguous().clone()
        for name, tensor in model.state_dict().items()
    }
    original_payload["model"] = model_state
    original_payload["optimizer"] = optimizer.state_dict()
    require(original_payload["global_step"] == initial_global_step,
            "Diagnostic optimizer updates must not be reported as ordinary trainer global steps")
    final_model_identity = tensor_identity(model.state_dict())
    changed_owners = [
        name for name, value in model.state_dict().items()
        if not torch.equal(value.detach().cpu(), initial_model_state[name])
    ]
    require(all(name.startswith("decoder.") for name in changed_owners),
            "A non-decoder model owner changed during the bounded fit")

    checkpoint_metadata = {
        key: value for key, value in trained.metadata.items()
        if key not in {"format_version", "state_sha256", "pinned",
                       "checkpoint_name", "transducer_checkpoint"}
    }
    checkpoint_metadata["diagnosticFit"] = {
        "schema": "semantic-native-decoder-fit/1",
        "scope": "Bounded decoder-only optimization through the actual grouped trainer boundary; full checkpoint later emitted one complete strict record through actual serving. Not native-task qualification or a normal resumable training run.",
        "baseCheckpointStateSha256": base_checkpoint_sha,
        "baseModelTensorIdentity": initial_model_identity,
        "fittedModelTensorIdentity": final_model_identity,
        "targetRecordSha256": sha(target),
        "actualFirstPrefixSampleSha256": sample_sha,
        "optimizer": "MasterAdamW",
        "diagnosticOptimizerSteps": first_valid,
        "diagnosticLearningRate": args.learning_rate,
        "normalTrainerGlobalStepPreserved": True,
        "normalTrainingConfigPreserved": True,
        "optimizerResumeClaim": False,
        "changedModelOwners": changed_owners,
        "sourceAdmissionIdentityDigest": packet["sourceAdmission"]["identityDigest"],
        "originalTransducerAttachmentSha256": original_transducer_sha,
        "completeTransducerTrainingStatePreserved": True,
    }
    saved_checkpoint = save_checkpoint(
        output / "checkpoint", "decoder-fit-v6", original_payload, checkpoint_metadata,
        pinned=False, keep=1,
        attachments=transducer_attachment(lambda: original_transducer_state),
    )
    saved_metadata = json.loads((saved_checkpoint / "metadata.json").read_text())
    del model_state
    gc.collect()

    bundle_path = output / "served-exact"
    export_receipt = export_served(saved_checkpoint, bundle_path)
    served = ServedBundle(bundle_path, device="cpu")
    require(served.manifest["checkpoint_sha256"] == saved_metadata["state_sha256"] ==
            export_receipt["checkpoint_sha256"],
            "Served bundle does not reference the exact fitted full checkpoint")
    in_memory_served_identity = tensor_identity(model.served_state_dict())
    reloaded_served_identity = tensor_identity(served.model.served_state_dict())
    require(in_memory_served_identity == reloaded_served_identity,
            "Exported served model changed a served parameter owner")
    actual = actual_service(
        served.model, served.codec, served.chunking, packet["prefix"],
        seed=args.seed, max_tokens=args.max_tokens)
    served_record = actual["record"]
    kind, fields = strict_record(served_record) if served_record is not None else (None, None)
    require(served_record == record and kind == strict_kind,
            "Reloaded actual serving API did not emit the exact complete strict target record")
    require(len(actual["samples"]) == 1 and
            actual["samples"][0]["sample"]["float32Sha256"] ==
            initial_service["samples"][0]["sample"]["float32Sha256"],
            "Reloaded service changed its frozen first-prefix draw or required multiple fragments")

    report = {
        "schema": "semantic-native-decoder-fit/1",
        "status": "passed",
        "scope": "Decoder-only bounded optimization using the actual first semantic trainer boundary and MasterAdamW. The full fitted checkpoint was exported, reloaded, and generated the exact complete strict v6 record through SelectedSemanticInference. This is a bounded decoder diagnostic, not a whole-task or native-success claim.",
        "producerRevision": tracer_revision,
        "consumerRevision": consumer_revision,
        "episodeSha256": packet["episodeSha256"],
        "sourceIdentityDigest": packet["sourceAdmission"]["identityDigest"],
        "preparedEpisodeId": prepared_id,
        "preparedCorpusIdentity": prepared_corpus_identity,
        "baseCheckpointStateSha256": base_checkpoint_sha,
        "savedCheckpointStateSha256": saved_metadata["state_sha256"],
        "servedModelSha256": served.manifest["model_sha256"],
        "inMemoryServedStateIdentity": in_memory_served_identity,
        "reloadedServedStateIdentity": reloaded_served_identity,
        "servedStateReloadExact": in_memory_served_identity == reloaded_served_identity,
        "originalTransducerAttachmentSha256": original_transducer_sha,
        "savedTransducerAttachmentSha256": saved_metadata["transducer_checkpoint"]["sha256"],
        "completeTransducerTrainingStatePreserved": True,
        "servedCheckpointSha256": served.manifest["checkpoint_sha256"],
        "tokenizerIdentity": codec.fingerprint,
        "publicPrefixSha256": json_digest(packet["prefix"]),
        "firstTargetSha256": sha(target),
        "firstTargetRecord": record,
        "targetKind": strict_kind,
        "actualInitialServiceRecord": initial_service["record"],
        "actualInitialServiceError": initial_service["error"],
        "actualInitialServiceSampleSha256": initial_service["samples"][0]["sample"]["float32Sha256"],
        "trainerEventIds": train["trainingEventIds"],
        "trainerTracks": train["trainingTracks"],
        "actualServingEventIds": initial_service["samples"][0]["eventIds"],
        "actualServingTracks": initial_service["priors"][0]["tracks"],
        "actualServingTrackRegistry": initial_service["priors"][0]["trackRegistry"],
        "trackIdentityStringsEqual": train["trainingTracks"] == initial_service["priors"][0]["tracks"],
        "trainerServingFirstSampleBitwiseEqual": sample_sha == initial_service["samples"][0]["sample"]["float32Sha256"],
        "trainerServingFirstSampleWithinTolerance": first_boundary_audit["sampleDifference"]["maximumAbsoluteDifference"] <= 1e-6,
        "reloadedServingSampleExactlyUnchanged": actual["samples"][0]["sample"]["float32Sha256"] == initial_service["samples"][0]["sample"]["float32Sha256"],
        "firstBoundaryAudit": first_boundary_audit,
        "modelOwnersChanged": changed_owners,
        "optimizerType": "MasterAdamW",
        "optimizerOwnerCount": len(optimizer.model_parameters),
        "optimizerDecoderOwnerCount": len(decoder_owners),
        "normalTrainerGlobalStep": initial_global_step,
        "normalTrainingConfigPreserved": True,
        "diagnosticOptimizerResumeClaim": False,
        "optimizerSteps": first_valid,
        "maxOptimizerSteps": args.max_steps,
        "learningRate": args.learning_rate,
        "bestNativeTeacherLoss": best_loss,
        "fitHistory": history,
        "firstStrictValidTargetStep": first_valid,
        "reloadedServiceRecordEqualsTarget": served_record == record,
        "reloadedServiceStrictKind": kind,
        "reloadedServiceStrictFields": fields,
        "reloadedServiceSelection": actual["selection"],
        "reloadedServiceSampleSha256": actual["samples"][0]["sample"]["float32Sha256"],
        "optimizerStepsDuringServing": 0,
        "savedCheckpoint": str(saved_checkpoint),
        "servedBundle": str(bundle_path),
    }
    atomic_json(output / "report.json", report)
    atomic_json(output / "fit-progress.json", {
        "schema": "semantic-native-decoder-fit-progress/1",
        "status": "passed",
        "optimizerStep": first_valid,
        "firstStrictValidStep": first_valid,
        "bestNativeTeacherLoss": best_loss,
        "report": "report.json",
        "history": history,
    })
    optimizer.close()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
