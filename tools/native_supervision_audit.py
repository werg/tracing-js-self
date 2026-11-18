"""Capture one native meridian's exact token supervision and loss gradients.

This is a diagnostic around the companion trainer's real forward path. It does
not synthesize target masks, take an optimizer step, or repair decoder output.
The caller must supply the restored model, selected native batch, actual codec,
and the same effective loss weights used for the one-window training pass.
"""
from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from typing import Callable

from learning_diagnostics import exact_record_audit, require


SCHEMA = "native-token-supervision-audit/1"
_OBJECTIVES = ("lexical", "reconstruction", "structure", "terminal")


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _tensor_digest(value) -> str:
    import torch

    if not isinstance(value, torch.Tensor):
        raise ValueError("Context fingerprints require native tensors")
    tensor = value.detach().contiguous().cpu()
    raw = tensor.reshape(-1).view(torch.uint8).numpy().tobytes()
    header = json.dumps(
        {"shape": list(tensor.shape), "dtype": str(tensor.dtype)},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return _digest(header + b"\0" + raw)


def _objective_gradient_metrics(model, loss, owners):
    """Retain exact per-owner gradients as digests plus readable norms.

    The gradient tensors are streamed into hashes and discarded. This lets the
    future-observation canary compare their actual values without writing a
    model-sized gradient artifact.
    """
    import torch

    parameters = dict(model.named_parameters())
    names = [name for owned in owners.values() for name in owned]
    require(names and len(names) == len(set(names)) and all(name in parameters for name in names),
            "Objective gradient owners must be unique actual parameter names")
    grads = torch.autograd.grad(loss, [parameters[name] for name in names],
                                allow_unused=True, retain_graph=True)
    by_name = dict(zip(names, grads, strict=True))
    result = {}
    for owner, owned in owners.items():
        connected = 0
        squared_norm = 0.0
        fingerprint = hashlib.sha256()
        for name in owned:
            gradient = by_name[name]
            fingerprint.update(name.encode("utf-8") + b"\0")
            if gradient is None:
                fingerprint.update(b"unused\0")
                continue
            require(bool(torch.isfinite(gradient).all()), "Nonfinite objective gradient")
            connected += 1
            detached = gradient.detach().contiguous().cpu()
            squared_norm += float(detached.double().square().sum())
            header = json.dumps(
                {"shape": list(detached.shape), "dtype": str(detached.dtype)},
                sort_keys=True, separators=(",", ":"),
            ).encode()
            raw = detached.reshape(-1).view(torch.uint8).numpy().tobytes()
            fingerprint.update(header + b"\0" + raw + b"\0")
        result[owner] = {
            "parameters": len(owned),
            "connectedParameters": connected,
            "gradientNorm": squared_norm ** 0.5,
            "gradientSha256": fingerprint.hexdigest(),
        }
    return result


def _state_fingerprint(state) -> str:
    """Bind the complete pre-target recurrent context used by the decoder."""
    pieces = {
        "raw": _tensor_digest(state.raw),
        "historyKeys": _tensor_digest(state.history.keys),
        "historyValues": _tensor_digest(state.history.values),
        "historyMask": None if state.history.mask is None else _tensor_digest(state.history.mask),
        "final": None if state.final is None else _tensor_digest(state.final),
        "adapters": None if state.adapters is None else _tensor_digest(state.adapters.logits),
        "historyEventIds": list(state.history_event_ids),
        "historyEventTracks": list(state.history_event_tracks),
        "historyPositions": list(state.history_positions),
        "historySizes": list(state.meridian_sizes),
        "meridiansSeen": state.meridians_seen.detach().cpu().tolist(),
        "eventsSeen": state.events_seen.detach().cpu().tolist(),
        "contextSeen": state.context_seen,
        "contextPolicy": state.context_policy.to_json(),
        "trackDescriptions": list(state.track_descriptions),
        "trackRegistry": list(state.track_registry),
        "frontierEventIds": list(state.frontier_event_ids),
        "contextDropped": list(state.context_dropped),
        "policyHistory": list(state.policy_history or ()),
    }
    return _digest(json.dumps(pieces, sort_keys=True, separators=(",", ":")).encode())


def _module_parameter_names(model, modules=(), parameters=(), *, core_parameters=()):
    all_named = dict(model.named_parameters())
    names = []
    for module in modules:
        names.extend(name for name, parameter in all_named.items()
                     if any(parameter is candidate for candidate in module.parameters()))
    module_parameters = tuple(parameters) + tuple(core_parameters)
    names.extend(name for name, parameter in all_named.items()
                 if any(parameter is candidate for candidate in module_parameters))
    # Remove repeats within one owner's explicitly enumerated submodules.
    return list(dict.fromkeys(names))


def native_parameter_owners(model):
    """Return explicit parameter owners from the actual native module objects.

    Ownership comes from native module references and documented core owner
    iterators. Names are resolved by object identity; no substring rules are
    used to guess which weights belong to a head.
    """
    from megatoken.model.multitrack import MultiTrackGenerator

    multi = MultiTrackGenerator.of(model)
    generator, core = multi.generator, multi.generator.core
    decoder = generator.decoder
    structural_modules = (
        decoder.header_start,
        decoder.header_cell,
        decoder.mode_codes,
        decoder.schema_codes,
        decoder.layout_codes,
        decoder.length_codes,
        decoder.identifier_slots,
        decoder.binding_query,
        decoder.public_projection,
    )
    owners = {
        "lexicalVocabulary": _module_parameter_names(model, (decoder.vocabulary,)),
        "lexicalRealizer": _module_parameter_names(
            model, (decoder.realizer,), core_parameters=core.realizer_parameters()
        ),
        "structureHeads": _module_parameter_names(model, structural_modules,
                                                    parameters=(decoder.free_binding,)),
        "terminalHead": _module_parameter_names(model, (decoder.terminal_codes,)),
        "inputEncoder": _module_parameter_names(model, core_parameters=core.encoder_parameters()),
        "contextCore": _module_parameter_names(model, core_parameters=core.central_parameters()),
        "contextPredictor": _module_parameter_names(model, core_parameters=core.predictor_parameters()),
        "controlEncoder": _module_parameter_names(model, core_parameters=core.control_parameters()),
        "sharedExperts": _module_parameter_names(model, core_parameters=core.shared_parameters()),
    }
    flattened = [name for values in owners.values() for name in values]
    require(all(owners.values()), "A native gradient owner resolved to no model parameters")
    require(len(flattened) == len(set(flattened)), "Native gradient owners overlap")
    return owners


def _record_map(batch):
    episode = batch.windows[0].episode
    records = tuple(episode.records)
    offsets = {record.record_id: index for index, record in enumerate(records)}
    require(len(offsets) == len(records), "Episode record IDs must be unique")
    return episode, records, offsets


def _expected_context_ids(batch, first_target_offset):
    episode, records, _ = _record_map(batch)
    allowed = {record.record_id for record in records[:first_target_offset]}
    native = batch.native_history
    for cursor in range(first_target_offset):
        for tape in native.events_for_record(cursor, include_record=True):
            allowed.update(tape.event_ids)
    return allowed


def _plan_record(plan, encoded, *, index, codec):
    """Cross-check one real trainer plan against its physical target record."""
    record = encoded.record
    row = {
        "recordId": record.record_id,
        "logicalId": record.logical_id or record.record_id,
        "partIndex": record.part_index,
        "partCount": record.part_count,
        "partBoundary": record.part_index + 1 == record.part_count,
        "role": record.role,
        "mode": "generated" if record.policy_mask else "observed",
    }
    if not encoded.token_ids:
        require(not record.policy_mask and not encoded.free_mask,
                "Media inputs cannot carry text-token supervision")
        row.update({"modality": record.media_type, "tokenTargets": [],
                    "structuralTargets": None, "terminalTarget": None,
                    "lexicalLossMask": [], "scoredPositions": 0})
        return row

    audit = exact_record_audit(encoded, codec)
    row.update({"tokenTargets": [{"position": token["position"],
                                    "targetTokenId": token["id"],
                                    "pieceHex": token["hex"],
                                    "pieceText": token["text"],
                                    "lexicalLossMask": token["lexicalLossMask"]}
                                   for token in audit["tokens"]],
                "lexicalLossMask": list(encoded.free_mask),
                "scoredPositions": sum(encoded.free_mask),
                "payloadSha256": audit["payloadSha256"],
                "tokenizerIdentity": audit["tokenizerIdentity"]})

    if hasattr(plan, "ids") and hasattr(plan, "free_masks"):
        require(len(plan.ids) == 1 and len(plan.free_masks) == 1,
                "One native text plan must identify one physical record")
        require(tuple(plan.ids[0]) == tuple(encoded.token_ids) and
                tuple(plan.free_masks[0]) == tuple(encoded.free_mask) and
                bytes(plan.payloads[0]) == record.payload,
                "Native lexical target IDs, masks or bytes differ from the physical record")
        require(plan.terminals[0] is (record.part_index + 1 == record.part_count),
                "Native terminal target differs from the physical record boundary")
        row["structuralTargets"] = {
            "outputLengthTokens": len(plan.ids[0]),
            "textModeTarget": 0 if plan.mode_specs[0] is not None else None,
            "publicModeSupport": None if plan.mode_specs[0] is None else "native-plan",
            "lexicalPositions": sum(plan.free_masks[0]),
            "denominators": dict(plan.denominators),
        }
        row["terminalTarget"] = bool(plan.terminals[0])
    elif hasattr(plan, "field_ids") and hasattr(plan, "schema_index"):
        require(bytes(plan.payload) == record.payload,
                "Native structured action bytes differ from the physical record")
        require(plan.terminal is (record.part_index + 1 == record.part_count),
                "Native terminal target differs from the physical record boundary")
        require(plan.scored_positions > 0 or not record.policy_mask,
                "Generated structured action has no lexical target positions")
        schema = plan.spec.schemas[plan.schema_index]
        field_targets = []
        lexical_count = 0
        for field in schema.fields:
            ids = tuple(plan.field_ids[field.name])
            if field.fixed_json is not None or field.bound_to:
                mask = (False,) * len(ids)
            else:
                copy_index = int(plan.bindings.get(field.name, 0))
                if copy_index:
                    from megatoken.generation.targets import source_ids

                    copied = source_ids(codec, plan.spec.copy_sources[copy_index - 1])
                    placement = int(plan.placements.get(field.name, 0))
                    require(ids[placement:placement + len(copied)] == copied,
                            "Native copied field IDs differ from their declared source")
                    mask = tuple(not placement <= position < placement + len(copied)
                                 for position in range(len(ids)))
                else:
                    mask = (True,) * len(ids)
            lexical_count += sum(mask)
            field_targets.append({
                "field": field.name,
                "tokenTargets": [{"position": position, "targetTokenId": token,
                                  "pieceHex": codec.decode([token]).hex(),
                                  "lexicalLossMask": mask[position]}
                                 for position, token in enumerate(ids)],
            })
        require(lexical_count == plan.scored_positions == plan.denominators["lexical"],
                "Structured action field masks differ from the actual lexical denominator")
        wire_targets = row.pop("tokenTargets")
        row["serializedRecordTokenInventory"] = wire_targets
        row["tokenTargets"] = [token for field in field_targets
                               for token in field["tokenTargets"]]
        row["lexicalLossMask"] = [token["lexicalLossMask"] for token in row["tokenTargets"]]
        row["structuralTargets"] = {
            "mode": "structured",
            "schemaIndex": int(plan.schema_index),
            "layout": int(plan.layout),
            "bindings": dict(plan.bindings),
            "placements": dict(plan.placements),
            "fieldTargets": field_targets,
            "lexicalPositions": int(plan.scored_positions),
            "denominators": dict(plan.denominators),
            "serializedWireLexicalMaskStatus": "not-applicable: fixed syntax is serialized after field decoding",
        }
        row["terminalTarget"] = bool(plan.terminal)
    else:
        raise ValueError("Unknown native text supervision plan")
    return row


def _audit_episode_tokens(batch, codec):
    from megatoken.data.schema import encode_record

    episode, records, offsets = _record_map(batch)
    audited = []
    for offset, record in enumerate(records):
        encoded = encode_record(record, codec)
        if not encoded.token_ids:
            require(not record.policy_mask,
                    "An empty-token/media record cannot be a lexical text target")
            audited.append({"recordId": record.record_id, "offset": offset,
                            "mode": "observed", "tokenTargets": [],
                            "lexicalLossMask": [], "scoredPositions": 0,
                            "payloadSha256": _digest(record.payload)})
            continue
        audit = exact_record_audit(encoded, codec)
        require((not record.policy_mask and not any(encoded.free_mask)) or
                (record.policy_mask and all(encoded.free_mask)),
                "Episode contains a generated record with unintended or missing lexical supervision")
        audited.append({"recordId": record.record_id, "offset": offset,
                        "mode": "generated" if record.policy_mask else "observed",
                        "logicalId": record.logical_id or record.record_id,
                        "partIndex": record.part_index, "partCount": record.part_count,
                        "partBoundary": record.part_index + 1 == record.part_count,
                        "payloadSha256": audit["payloadSha256"],
                        "tokenizerIdentity": audit["tokenizerIdentity"],
                        "tokenTargets": [{"position": token["position"],
                                          "targetTokenId": token["id"],
                                          "pieceHex": token["hex"],
                                          "pieceText": token["text"],
                                          "lexicalLossMask": token["lexicalLossMask"]}
                                         for token in audit["tokens"]],
                        "lexicalLossMask": list(encoded.free_mask),
                        "scoredPositions": sum(encoded.free_mask)})
    return audited


def _decoder_specs(plans):
    from megatoken.generation.structure import ActionSpec

    output = []
    for plan in plans:
        if hasattr(plan, "spec") and hasattr(plan, "schema_index"):
            output.append(plan.spec)
        elif hasattr(plan, "spec") and hasattr(plan, "mode") and not hasattr(plan, "ids"):
            output.append(plan.spec)
        elif hasattr(plan, "mode_specs"):
            public = plan.mode_specs[0]
            output.append(public or ActionSpec(max_tokens=min(512, plan.capacities[0])))
        else:
            raise ValueError("Cannot recover the public output spec from the native plan")
    return tuple(output)


def _actual_decoder_emission(multi, state, *, tracks, event_ids, plans, controls,
                             effort, codec, seed, record_validator=None):
    import torch

    generator = torch.Generator(device=state.device).manual_seed(seed)
    captured_distribution = {}
    original_modality_logits = multi.tracks.modality_logits
    original_prior = multi._prior

    def capture_modality_logits(*args, **kwargs):
        logits = original_modality_logits(*args, **kwargs)
        captured_distribution["modalityLogitsSha256"] = _tensor_digest(logits)
        captured_distribution["modalityLogitsShape"] = list(logits.shape)
        return logits

    def capture_prior(*args, **kwargs):
        distribution = original_prior(*args, **kwargs)
        captured_distribution["gaussianMeanSha256"] = _tensor_digest(distribution.mean)
        captured_distribution["gaussianMeanShape"] = list(distribution.mean.shape)
        captured_distribution["gaussianLogScaleSha256"] = _tensor_digest(distribution.log_scale)
        captured_distribution["gaussianLogScaleShape"] = list(distribution.log_scale.shape)
        return distribution

    multi.tracks.modality_logits = capture_modality_logits
    multi._prior = capture_prior
    try:
        produced = multi.generate_group(
            state,
            tracks=tracks,
            event_ids=event_ids,
            specs=_decoder_specs(plans),
            controls=controls,
            effort=effort,
            generator=generator,
        )
    finally:
        multi.tracks.modality_logits = original_modality_logits
        multi._prior = original_prior
    require(all(key in captured_distribution for key in (
        "modalityLogitsSha256", "gaussianMeanSha256", "gaussianLogScaleSha256")),
        "Actual decoder prior distributions were not captured")
    distribution_identity = {
        "modalityLogitsSha256": captured_distribution["modalityLogitsSha256"],
        "modalityLogitsShape": captured_distribution["modalityLogitsShape"],
        "gaussianMeanSha256": captured_distribution["gaussianMeanSha256"],
        "gaussianMeanShape": captured_distribution["gaussianMeanShape"],
        "gaussianLogScaleSha256": captured_distribution["gaussianLogScaleSha256"],
        "gaussianLogScaleShape": captured_distribution["gaussianLogScaleShape"],
    }
    distribution_identity["jointSha256"] = _digest(json.dumps(
        distribution_identity, sort_keys=True, separators=(",", ":")
    ).encode())
    tape = produced.tape
    require(tape.render_status == "rendered", "Native decoder did not complete rendering")
    events = []
    for index, (payload, emitted, valid, terminal) in enumerate(
            zip(tape.payloads, tape.emitted_ids, tape.valid, tape.terminal, strict=True)):
        decoded = codec.decode(emitted)
        require(decoded == payload, "Actual decoder-emitted IDs do not reconstruct its bytes")
        validator_result = None
        if record_validator is not None:
            validator_result = record_validator(payload)
            json.dumps(validator_result, sort_keys=True, allow_nan=False)
        semantic_valid = (isinstance(validator_result, dict) and
                          validator_result.get("status") == "valid")
        events.append({
            "eventId": tape.event_ids[index],
            "payloadHex": payload.hex(),
            "payloadSha256": _digest(payload),
            "emittedTokenIds": list(emitted),
            "emittedTokenCount": len(emitted),
            "decoderValid": bool(valid),
            "terminal": bool(terminal),
            "completeNativeTextAction": bool(valid and emitted and decoded == payload),
            "completeNativeRecord": bool(valid and terminal and emitted and decoded == payload),
            "semanticParserValid": semantic_valid if record_validator is not None else None,
            "sourceRecordValidation": validator_result,
        })
    return {"renderStatus": tape.render_status, "events": events,
            "conditionalDistribution": distribution_identity,
            "selectedGroupLogProbability": float(produced.log_prob.detach().float().cpu().sum()),
            "behaviorLogProbability": float(tape.behavior_log_prob),
            "completeValidGroup": bool(events) and all(row["completeNativeTextAction"] for row in events)}


def _one_native_capture(model, batch, *, codec, config, device, model_version,
                        transducer, decoder_seed, record_validator, window_scale,
                        owner_map):
    import torch
    from megatoken.model.multitrack import MultiTrackGenerator
    from megatoken.model.config import RESERVED_TRACKS
    from megatoken.training.losses import LossLedger
    from megatoken.training.meridians import forward_meridian_batch

    multi = MultiTrackGenerator.of(model)
    episode, physical_records, record_offsets = _record_map(batch)
    captured = []
    original = MultiTrackGenerator.supervised_meridian
    weights = dict(config.loss_weights)
    # This is the companion training engine's effective weight override.
    weights["router_balance"] = 0.0
    counts = dict(batch.counts)

    def audited(self, state, **kwargs):
        plans = tuple(kwargs["plans"])
        tracks = tuple(kwargs["tracks"])
        event_ids = tuple(kwargs.get("event_ids") or ())
        if not event_ids:
            event_ids = tuple(f"selected:{int(state.meridians_seen[0])}:{name}" for name in tracks)
        controls = tuple(kwargs.get("control_payloads") or (b"",) * len(tracks))
        offsets = [record_offsets[event_id] for event_id in event_ids if event_id in record_offsets]
        require(len(offsets) == len(event_ids),
                "Every generated native target must bind to a physical episode record")
        first_offset = min(offsets)
        visible = set(state.history_event_ids) | set(state.frontier_event_ids)
        visible.update(event for event, _reason in state.context_dropped)
        for entry in state.policy_history or ():
            visible.update(json.loads(entry).get("events", ()))
        allowed = _expected_context_ids(batch, first_offset)
        internal = visible - allowed
        require(internal <= set(RESERVED_TRACKS),
                "Pre-target recurrent state contains an unknown/current/future event ID: " +
                repr(sorted(internal - set(RESERVED_TRACKS))))
        require(not visible.intersection(record.record_id for record in physical_records[first_offset:]),
                "Pre-target recurrent state contains the target or a future physical record")
        context = {
            "eventIds": list(state.history_event_ids),
            "frontierEventIds": list(state.frontier_event_ids),
            "contextDroppedEventIds": [event for event, _reason in state.context_dropped],
            "earlierPhysicalEventIds": sorted(visible & allowed),
            "reservedNativeControlEventIds": sorted(internal),
            "eventTracks": list(state.history_event_tracks),
            "eventPositions": list(state.history_positions),
            "stateSha256": _state_fingerprint(state),
            "visibleEventsAreStrictlyEarlier": True,
            "historyEventCount": len(state.history_event_ids),
            "kvShape": {"keys": list(state.history.keys.shape),
                        "values": list(state.history.values.shape)},
            "currentRecordIdsAbsent": True,
        }
        target_rows = []
        offsets_for_target = []
        for event_index, (event_id, plan) in enumerate(zip(event_ids, plans, strict=True)):
            record = physical_records[record_offsets[event_id]]
            step_encoded = next(
                entry for step in (*batch.prefix, *batch.steps)
                for entry in step.records if entry.record.record_id == event_id
            )
            require(step_encoded.record == record,
                    "Prepared target record differs from the immutable episode row")
            target_rows.append(_plan_record(plan, step_encoded, index=event_index, codec=codec))
            offsets_for_target.append(record_offsets[event_id])

        emission = _actual_decoder_emission(
            self, state, tracks=tracks, event_ids=event_ids, plans=plans,
            controls=controls, effort=int(kwargs.get("effort", 6)), codec=codec,
            seed=decoder_seed, record_validator=record_validator,
        )
        result = original(self, state, **kwargs)
        objective_rows = {}
        gradients = {}
        expected_owners = {
            "lexical": ("lexicalVocabulary", "lexicalRealizer", "contextPredictor"),
            "reconstruction": ("inputEncoder",),
            "structure": ("structureHeads",),
            "terminal": ("terminalHead",),
        }
        for objective in _OBJECTIVES:
            numerator, denominator = result.losses[objective]
            require(numerator.ndim == 0 and bool(torch.isfinite(numerator)),
                    "Native objective must be a finite scalar loss sum")
            factor = weights.get(objective, 0.0) / counts[objective] if counts.get(objective, 0) else 0.0
            objective_rows[objective] = {
                "lossSum": float(numerator.detach().float().cpu()),
                "scoredCount": int(denominator),
                "ledgerWeight": float(weights.get(objective, 0.0)),
                "globalDenominator": int(counts.get(objective, 0)),
                "ledgerScale": float(factor),
            }
            if denominator:
                measured = _objective_gradient_metrics(model, numerator, owner_map)
                for owner in expected_owners[objective]:
                    owner_result = measured[owner]
                    require(owner_result["connectedParameters"] > 0 and
                            owner_result["gradientNorm"] > 0.0,
                            f"{objective} objective has no nonzero gradient to {owner}")
                gradients[objective] = {
                    owner: {"parameters": measured[owner]["parameters"],
                            "connectedParameters": measured[owner]["connectedParameters"],
                            "rawGradientNorm": measured[owner]["gradientNorm"],
                            "ledgerGradientNorm": measured[owner]["gradientNorm"] * abs(factor),
                            "gradientSha256": measured[owner]["gradientSha256"]}
                    for owner in owner_map
                }
            else:
                require(denominator == 0 and float(numerator.detach().float().cpu()) == 0.0,
                        "An empty native objective must have zero count and loss")
                gradients[objective] = {owner: {"parameters": len(names),
                                                 "connectedParameters": 0,
                                                 "rawGradientNorm": 0.0,
                                                 "ledgerGradientNorm": 0.0,
                                                 "gradientSha256": None}
                                       for owner, names in owner_map.items()}
        captured.append({
            "eventIds": list(event_ids),
            "recordOffsets": offsets_for_target,
            "context": context,
            "targets": target_rows,
            "objectives": objective_rows,
            "gradients": gradients,
            "decoderEmission": emission,
            "gradientChecks": {name: True for name in expected_owners},
        })
        return result

    ledger = LossLedger(counts, counts, weights)
    try:
        MultiTrackGenerator.supervised_meridian = audited
        metrics = forward_meridian_batch(
            model,
            batch,
            ledger,
            config,
            device,
            model_version,
            differentiate=False,
            transducer=transducer,
            window_scale=window_scale,
        )
        ledger.finish()
    finally:
        MultiTrackGenerator.supervised_meridian = original
    require(captured, "Native episode contained no generated target meridian")
    return {
        "decisions": captured,
        "metrics": {name: float(value.detach().cpu()) if hasattr(value, "detach") else value
                    for name, value in metrics.items()},
        "effectiveLossLedger": {"weights": weights, "globalDenominators": counts,
                                "windowScale": window_scale,
                                "optimizerSteps": 0},
    }


def future_observation_canary_batch(batch, codec):
    """Change one later observed payload while preserving the target plan/masks."""
    from megatoken.data.schema import encode_record
    from megatoken.training.stream import EpisodeWindow

    episode, records, record_offsets = _record_map(batch)
    generated_offsets = [record_offsets[entry.record.record_id]
                         for step in batch.steps if step.generated for entry in step.records]
    require(generated_offsets, "Future-observation canary needs a generated target")
    earliest = min(generated_offsets)
    candidates = [(record_offsets[entry.record.record_id], step_index, entry_index, entry)
                  for step_index, step in enumerate(batch.steps)
                  for entry_index, entry in enumerate(step.records)
                  if record_offsets[entry.record.record_id] > earliest and
                  not entry.record.policy_mask and entry.record.media_type == "text/plain; charset=utf-8"]
    require(candidates, "No later observed text record is available for a numerical canary")
    # Prefer a genuine environmental/tool result: changing a dispatch receipt
    # tests chronology, while changing the later observed result directly tests
    # that the answer cannot leak into decisions made before the response.
    result_candidates = [candidate for candidate in candidates if candidate[3].record.result_of]
    if result_candidates:
        candidates = result_candidates
    offset, step_index, entry_index, original_entry = candidates[0]
    payload = original_entry.record.payload
    changed = bytearray(payload)
    position = next((index for index, byte in enumerate(changed)
                     if 48 <= byte <= 57 or 65 <= byte <= 90 or 97 <= byte <= 122), None)
    if position is None:
        require(changed, "Cannot perturb an empty future observation")
        position = 0
    old = changed[position]
    changed[position] = old + 1 if old < 255 else old - 1
    new_payload = bytes(changed)
    # Keep UTF-8 valid when the original row was valid text.
    try:
        payload.decode("utf-8")
        new_payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Future-observation canary could not preserve UTF-8") from error
    mutated_record = replace(
        original_entry.record,
        payload=new_payload,
        free_spans=None,
        emitted_ids=None,
        cached_ids=None,
        emitted_free_mask=None,
        codec_fingerprint=None,
    )
    mutated_encoded = encode_record(mutated_record, codec)
    require(not any(mutated_encoded.free_mask), "Canary observation acquired lexical supervision")

    steps = list(batch.steps)
    target_step = steps[step_index]
    step_records = list(target_step.records)
    step_records[entry_index] = mutated_encoded
    steps[step_index] = replace(target_step, records=tuple(step_records))

    episode_records = list(episode.records)
    episode_records[offset] = mutated_record
    mutated_episode = replace(episode, records=tuple(episode_records))
    window_item = batch.windows[0]
    window = window_item.window
    encoded_offset = offset - window.start
    if 0 <= encoded_offset < len(window.records):
        records_in_window = list(window.records)
        records_in_window[encoded_offset] = mutated_encoded
        mutated_window = replace(window, episode=mutated_episode,
                                  records=tuple(records_in_window))
    elif 0 <= offset < window.start:
        prefix = list(window.prefix)
        prefix[offset] = mutated_encoded
        mutated_window = replace(window, episode=mutated_episode,
                                  prefix=tuple(prefix))
    else:
        mutated_window = replace(window, episode=mutated_episode)
    mutated_window_item = EpisodeWindow(mutated_episode, mutated_window,
                                        window_item.assets, window_item.episode_end)
    mutated_batch = replace(batch, windows=[mutated_window_item], steps=tuple(steps))
    return mutated_batch, {
        "recordId": original_entry.record.record_id,
        "recordOffset": offset,
        "payloadBeforeSha256": _digest(payload),
        "payloadAfterSha256": _digest(new_payload),
        "changedByteOffset": position,
        "tokenCountBefore": len(original_entry.token_ids),
        "tokenCountAfter": len(mutated_encoded.token_ids),
        "observedMaskRemainsEmpty": not any(mutated_encoded.free_mask),
        "changedBytesOnlyInFutureObservation": True,
    }


def _compare_canary(original, changed, mutation, *, atol=1e-6, rtol=1e-5):
    def close(left, right):
        return abs(left - right) <= atol + rtol * abs(left)

    by_events = {tuple(row["eventIds"]): row for row in changed["decisions"]}
    comparisons = []
    for row in original["decisions"]:
        if max(row["recordOffsets"]) >= mutation["recordOffset"]:
            continue
        peer = by_events.get(tuple(row["eventIds"]))
        require(peer is not None, "Future-canary rerun lost an earlier target decision")
        context_equal = row["context"]["stateSha256"] == peer["context"]["stateSha256"]
        targets_equal = row["targets"] == peer["targets"]
        loss_checks, gradient_norm_checks, gradient_value_checks = {}, {}, {}
        for objective, values in row["objectives"].items():
            changed_values = peer["objectives"][objective]
            loss_checks[objective] = (
                close(values["lossSum"], changed_values["lossSum"])
                and values["scoredCount"] == changed_values["scoredCount"]
                and values["ledgerWeight"] == changed_values["ledgerWeight"]
                and values["globalDenominator"] == changed_values["globalDenominator"]
                and values["ledgerScale"] == changed_values["ledgerScale"]
            )
        for objective, values in row["gradients"].items():
            gradient_norm_checks[objective] = {}
            gradient_value_checks[objective] = {}
            for owner, measure in values.items():
                gradient_norm_checks[objective][owner] = close(
                    measure["rawGradientNorm"],
                    peer["gradients"][objective][owner]["rawGradientNorm"],
                ) and close(
                    measure["ledgerGradientNorm"],
                    peer["gradients"][objective][owner]["ledgerGradientNorm"],
                )
                gradient_value_checks[objective][owner] = (
                    measure["gradientSha256"] ==
                    peer["gradients"][objective][owner]["gradientSha256"]
                )
        output_equal = row["decoderEmission"]["events"] == peer["decoderEmission"]["events"]
        distributions_equal = (row["decoderEmission"]["conditionalDistribution"] ==
                               peer["decoderEmission"]["conditionalDistribution"])
        selected_log_probability_equal = close(
            row["decoderEmission"]["selectedGroupLogProbability"],
            peer["decoderEmission"]["selectedGroupLogProbability"],
        ) and close(row["decoderEmission"]["behaviorLogProbability"],
                    peer["decoderEmission"]["behaviorLogProbability"])
        comparisons.append({"eventIds": row["eventIds"], "contextStateEqual": context_equal,
                            "targetIdsMasksAndBoundariesEqual": targets_equal,
                            "conditionalDistributionsEqual": distributions_equal,
                            "selectedLogProbabilitiesEqual": selected_log_probability_equal,
                            "objectiveLossesEqual": loss_checks,
                            "objectiveGradientNormsEqual": gradient_norm_checks,
                            "objectiveGradientValuesEqual": gradient_value_checks,
                            "actualDecoderOutputEqual": output_equal})
    require(comparisons, "Future-canary did not precede any generated decision")
    passed = all(row["contextStateEqual"] and row["targetIdsMasksAndBoundariesEqual"] and
                 row["conditionalDistributionsEqual"] and row["selectedLogProbabilitiesEqual"] and
                 row["actualDecoderOutputEqual"] and
                 all(row["objectiveLossesEqual"].values()) and
                 all(all(values.values()) for values in row["objectiveGradientNormsEqual"].values()) and
                 all(all(values.values()) for values in row["objectiveGradientValuesEqual"].values())
                 for row in comparisons)
    return {"status": "passed" if passed else "failed", "mutation": mutation,
            "absoluteTolerance": atol, "relativeTolerance": rtol,
            "comparisons": comparisons,
            "scope": "Earlier selected meridian states, full modality/Gaussian prior fingerprints, target log probabilities, text losses, exact gradient fingerprints, and actual decoder output"}


def capture_native_supervision_audit(
    model,
    batch,
    *,
    codec,
    config,
    device,
    model_version,
    transducer,
    checkpoint_sha256: str | None = None,
    decoder_seed: int = 17,
    window_scale: float = 1.0,
    record_validator: Callable[[bytes], object] | None = None,
    include_future_canary: bool = True,
    require_complete_decoder_output: bool = False,
):
    """Run a no-step native forward and retain exact target/context/gradient evidence.

    The batch must be one selected native episode window. An optional canary
    changes a later observed record and reruns the same forward at the same RNG
    state; earlier target inputs, losses, gradients, and decoder output must be
    unchanged. The effective trainer loss ledger is reconstructed from the
    supplied config and native batch denominators, including the trainer's
    router-balance override.
    """
    import copy
    import torch

    require(len(batch.windows) == 1, "Native token audit requires one selected episode window")
    require(len(batch.steps) > 0 and type(decoder_seed) is int and decoder_seed >= 0,
            "A generated episode window and nonnegative native decoder seed are required")
    if checkpoint_sha256 is not None:
        require(isinstance(checkpoint_sha256, str) and len(checkpoint_sha256) == 64 and
                all(char in "0123456789abcdef" for char in checkpoint_sha256),
                "Checkpoint identity must be a lowercase SHA-256")
    owners = native_parameter_owners(model)
    episode_rows = _audit_episode_tokens(batch, codec)
    require(not transducer.records and not transducer.candidates,
            "Native audit must start at a complete trainer window boundary")

    def trainer_snapshot():
        return copy.deepcopy(transducer.state_dict())

    def restore_trainer(snapshot):
        transducer.records.clear()
        transducer.candidates.clear()
        transducer._writes = 0
        transducer.load_state_dict(copy.deepcopy(snapshot))

    def run(current):
        return _one_native_capture(
            model, current, codec=codec, config=config, device=device,
            model_version=model_version, transducer=transducer,
            decoder_seed=decoder_seed, record_validator=record_validator,
            window_scale=window_scale, owner_map=owners,
        )

    original_rng = torch.get_rng_state()
    original_cuda = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None
    transducer_state = trainer_snapshot()
    prior_gradients = {
        name: None if parameter.grad is None else parameter.grad.detach().clone()
        for name, parameter in model.named_parameters()
    }
    try:
        baseline = run(batch)
        restore_trainer(transducer_state)
        canary = {"status": "unmeasured", "reason": "Disabled by caller"}
        if include_future_canary:
            try:
                changed_batch, mutation = future_observation_canary_batch(batch, codec)
            except ValueError as error:
                if "No later observed text record" not in str(error):
                    raise
                canary = {"status": "unmeasured", "reason": str(error)}
            else:
                torch.set_rng_state(original_rng)
                if original_cuda is not None:
                    torch.cuda.set_rng_state_all(original_cuda)
                mutated = run(changed_batch)
                canary = _compare_canary(baseline, mutated, mutation)
                restore_trainer(transducer_state)
        decoder_groups_complete = all(
            decision["decoderEmission"]["completeValidGroup"]
            for decision in baseline["decisions"]
        )
        require(not require_complete_decoder_output or decoder_groups_complete,
                "Actual native decoder did not emit a complete valid output group")
    finally:
        restore_trainer(transducer_state)
        torch.set_rng_state(original_rng)
        if original_cuda is not None:
            torch.cuda.set_rng_state_all(original_cuda)
    for name, parameter in model.named_parameters():
        before = prior_gradients[name]
        require((before is None and parameter.grad is None) or
                (before is not None and parameter.grad is not None and
                 torch.equal(before, parameter.grad.detach())),
                "Native audit changed a parameter .grad slot")

    decisions = baseline["decisions"]
    status = "passed"
    if canary["status"] == "failed":
        status = "failed"
    elif canary["status"] == "unmeasured":
        status = "incomplete"
    decoder_emission_status = (
        "complete-valid" if decisions and all(
            decision["decoderEmission"]["completeValidGroup"] for decision in decisions
        ) else "invalid-or-incomplete"
    )
    emitted_rows = [event for decision in decisions
                    for event in decision["decoderEmission"]["events"]]
    native_complete_count = sum(bool(row["completeNativeRecord"]) for row in emitted_rows)
    parser_measurements = [row["semanticParserValid"] for row in emitted_rows
                           if row["semanticParserValid"] is not None]
    semantic_parser_status = (
        "unmeasured" if not parser_measurements else
        "measured-all-valid" if all(parser_measurements) else
        "measured-with-invalid-emissions"
    )
    return {
        "schema": SCHEMA,
        "status": status,
        "decoderEmissionStatus": decoder_emission_status,
        "completeNativeRecordCount": native_complete_count,
        "completeNativeRecordStatus": (
            "complete" if emitted_rows and native_complete_count == len(emitted_rows)
            else "incomplete-or-invalid"
        ),
        "semanticParserStatus": semantic_parser_status,
        "semanticParserValidEmissionCount": sum(parser_measurements),
        "semanticParserMeasuredEmissionCount": len(parser_measurements),
        "semanticOutcome": "not-evaluated",
        "checkpointSha256": checkpoint_sha256,
        "episodeId": batch.windows[0].episode.episode_id,
        "episodeLineage": {"sourceId": batch.windows[0].episode.lineage.source_id,
                           "familyId": batch.windows[0].episode.lineage.family_id,
                           "split": batch.windows[0].episode.lineage.frozen_split},
        "tokenizerIdentity": codec.fingerprint,
        "decoderSeed": decoder_seed,
        "episodeRecords": episode_rows,
        "decisionCount": len(decisions),
        "decisions": decisions,
        "futureObservationCanary": canary,
        "allGeneratedTokensScored": all(
            row["mode"] != "generated" or all(row["lexicalLossMask"])
            for row in episode_rows if row["tokenTargets"]
        ),
        "allObservedTokensUnscored": all(
            row["mode"] != "observed" or not any(row["lexicalLossMask"])
            for row in episode_rows if row["tokenTargets"]
        ),
        "gradientOwners": owners,
        "effectiveLossLedger": baseline["effectiveLossLedger"],
        "nativeForwardMetrics": baseline["metrics"],
        "optimizerSteps": 0,
        "scope": "One actual native episode window and restored checkpoint; no optimizer update",
        "recordValidation": "production-semantic-trace-v6-parser-per-actual-decoder-emission" if record_validator else
                            "unmeasured: native tape validity and exact token-to-byte roundtrip only",
    }
