"""Explicit reward controls and deterministic curriculum policies.

These functions do not call a model or inspect private teacher state. Length
pressure is applied after correctness normalization and is never normalized
away by a final joint standardization.
"""

from __future__ import annotations

import math
import random
import statistics
from typing import Any


def task_metadata(row: dict) -> dict:
    metadata = {**row.get("task", {}).get("metadata", {}), **row.get("metadata", {})}
    features = metadata.get("features", [])
    if (not isinstance(features, list) or len(features) > 128
            or any(not isinstance(item, str) or not item or len(item) > 256 for item in features)):
        raise ValueError("metadata.features must contain at most 128 nonempty feature strings")
    tier = metadata.get("tier", 1)
    if isinstance(tier, bool) or not isinstance(tier, int) or not 1 <= tier <= 100:
        raise ValueError("metadata.tier must be an integer in [1, 100]")
    return {**metadata, "features": sorted(set(features)), "tier": tier}


def centered(values: list[float], *, standardize: bool = False) -> list[float]:
    if not values or any(not math.isfinite(value) for value in values):
        raise ValueError("advantages require a nonempty finite group")
    mean = statistics.fmean(values)
    result = [value - mean for value in values]
    if standardize:
        deviation = math.sqrt(statistics.fmean(value * value for value in result))
        return [value / deviation for value in result] if deviation > 1e-12 else [0.0] * len(values)
    return result


def compression_coefficient(config: dict, step: int, *, gate_open: bool = True) -> float:
    if config.get("rl_objective", "compression") == "correctness" or not gate_open:
        return 0.0
    warmup = config.get("compression_warmup_steps", 0)
    ramp = config.get("compression_ramp_steps", 0)
    progress = max(0, step - warmup + 1)
    factor = min(1.0, progress / ramp) if ramp else float(progress > 0)
    return config["length_penalty"] * factor


def execution_advantages(records: list[dict], config: dict, coefficient: float | None = None) -> dict:
    """Separate correctness and success-conditional length credit.

    Length uses a fixed token scale, clipped to [0,1], and is centered only
    among successes. Failure gets no length credit. Both components have zero
    group mean. A single successful sample has no within-success length signal.
    In ``decoupled`` mode only correctness is standardized; in ``centered``
    mode both components retain fixed raw scale. Changing coefficient changes
    the length contribution linearly in every group, including all-success.
    """
    if not records:
        raise ValueError("execution advantages require at least one rollout")
    coefficient = config["length_penalty"] if coefficient is None else coefficient
    if not math.isfinite(coefficient) or not 0 <= coefficient < 1:
        raise ValueError("compression coefficient must be finite in [0, 1)")
    scale = config["length_scale_tokens"]
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("length_scale_tokens must be finite and positive")
    correct = [float(bool(record["grade"]["success"])) for record in records]
    tokens = [record["generated_tokens"] for record in records]
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in tokens):
        raise ValueError("generated token counts must be nonnegative integers")
    correctness = centered(correct, standardize=config.get("advantage_mode", "decoupled") == "decoupled")
    successful = [index for index, value in enumerate(correct) if value]
    length = [0.0] * len(records)
    if successful:
        costs = [min(tokens[index] / scale, 1.0) for index in successful]
        mean_cost = statistics.fmean(costs)
        for index, cost in zip(successful, costs):
            length[index] = mean_cost - cost
    advantages = [accuracy + coefficient * saving for accuracy, saving in zip(correctness, length)]
    successes = len(successful)
    kind = "all_failure" if successes == 0 else "all_success" if successes == len(records) else "mixed_success"
    return {"advantages": advantages, "correctness_advantages": correctness,
            "length_advantages": length, "length_contributions": [coefficient * value for value in length],
            "compression_coefficient": coefficient, "group_kind": kind,
            "zero_advantage_group": not any(abs(value) > 1e-12 for value in advantages),
            "length_signal": any(abs(value) > 1e-12 for value in length),
            "correctness_signal": any(abs(value) > 1e-12 for value in correctness)}


def likelihood_advantages(records: list[dict], config: dict, coefficient: float | None = None) -> dict:
    """Group-relative thinking advantages from target tool-call / completion log-likelihood.

    For each sampled thinking block z_i conditioned on prefix x, reward is the
    exact log-likelihood log P(y | x, z_i) of the known target action y (clamped
    at -200 nats), standardized with a minimum std floor (`likelihood_std_floor`,
    default 0.5 nats) so already-confident groups do not amplify 0.005-nat noise.
    Within the high-confidence subset (terminated thoughts within 0.5 nats of the
    best thought and >= -1.0 nats), shorter thoughts receive a standardized length
    saving bonus scaled by `coefficient`, preventing compression from ever
    rewarding wrong shortcuts. Target action tokens y receive a posterior-weighted
    EM anchor advantage proportional to softmax(ll_i).
    """
    if not records:
        raise ValueError("likelihood advantages require at least one rollout")
    coefficient = config["length_penalty"] if coefficient is None else coefficient
    if not math.isfinite(coefficient) or not 0 <= coefficient < 1:
        raise ValueError("compression coefficient must be finite in [0, 1)")
    scale = config["length_scale_tokens"]
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("length_scale_tokens must be finite and positive")
    anchor_weight = float(config.get("target_anchor_weight", 0.25))
    if not math.isfinite(anchor_weight) or anchor_weight < 0:
        raise ValueError("target_anchor_weight must be finite and nonnegative")
    std_floor = float(config.get("likelihood_std_floor", 0.5))
    if not math.isfinite(std_floor) or std_floor < 0:
        raise ValueError("likelihood_std_floor must be finite and nonnegative")

    ll_floor = -200.0
    valid_indices = [
        index for index, record in enumerate(records)
        if record.get("terminated") and isinstance(record.get("target_logprob_sum"), (int, float))
        and math.isfinite(record["target_logprob_sum"])
    ]
    valid_lls = [max(float(records[index]["target_logprob_sum"]), ll_floor) for index in valid_indices]
    trunc_ll = (min(valid_lls) - 5.0) if valid_lls else ll_floor
    ll_values = [
        max(float(record["target_logprob_sum"]), ll_floor)
        if index in valid_indices else trunc_ll
        for index, record in enumerate(records)
    ]
    raw_centered = centered(ll_values, standardize=False)
    if config.get("advantage_mode", "decoupled") == "decoupled":
        dev = math.sqrt(statistics.fmean(v * v for v in raw_centered))
        denom = max(dev, std_floor)
        ll_adv = [max(-2.5, min(2.5, v / denom)) for v in raw_centered] if denom > 1e-12 else [0.0] * len(records)
    else:
        ll_adv = raw_centered

    length = [0.0] * len(records)
    if valid_indices:
        best_ll = max(valid_lls)
        confident = [
            idx for idx, ll in zip(valid_indices, valid_lls)
            if ll >= best_ll - 0.5 and ll >= -1.0
        ]
        if len(confident) >= 2:
            toks = [float(records[idx]["generated_tokens"]) for idx in confident]
            mean_tok = statistics.fmean(toks)
            tok_dev = math.sqrt(statistics.fmean((t - mean_tok) ** 2 for t in toks))
            tok_denom = max(tok_dev, 64.0)
            for idx, tok in zip(confident, toks):
                length[idx] = max(-2.0, min(2.0, (mean_tok - tok) / tok_denom))
    advantages = [acc + coefficient * saving for acc, saving in zip(ll_adv, length)]

    target_advantages = [0.0] * len(records)
    if valid_indices and anchor_weight > 0:
        max_ll = max(valid_lls)
        exps = [math.exp(max(ll - max_ll, -50.0)) for ll in valid_lls]
        total_exp = sum(exps) or 1.0
        for index, exp_val in zip(valid_indices, exps):
            target_advantages[index] = anchor_weight * (exp_val / total_exp) * len(valid_indices)

    has_signal = (
        any(abs(value) > 1e-12 for value in advantages)
        or any(abs(value) > 1e-12 for value in target_advantages)
    )
    kind = "all_failure" if not valid_indices else ("all_success" if len(valid_indices) == len(records) else "mixed_success")
    return {
        "advantages": advantages,
        "target_advantages": target_advantages,
        "correctness_advantages": ll_adv,
        "length_advantages": length,
        "length_contributions": [coefficient * value for value in length],
        "compression_coefficient": coefficient,
        "group_kind": kind,
        "zero_advantage_group": not has_signal,
        "length_signal": any(abs(value) > 1e-12 for value in length),
        "correctness_signal": any(abs(value) > 1e-12 for value in ll_adv),
        "mean_target_ll": statistics.fmean(valid_lls) if valid_lls else None,
        "best_target_ll": max(valid_lls) if valid_lls else None,
    }


def sft_epoch_rows(rows: list[dict], config: dict, epoch: int) -> list[dict]:
    rng = random.Random(config["seed"] + epoch)
    curriculum = config.get("curriculum", {})
    if not curriculum.get("enabled", False):
        ordered = list(rows)
        rng.shuffle(ordered)
        return ordered
    buckets: dict[int, list[dict]] = {}
    for row in rows:
        buckets.setdefault(task_metadata(row)["tier"], []).append(row)
    ordered, earlier = [], []
    retention = curriculum.get("retention_fraction", .25)
    for tier in sorted(buckets):
        current = list(buckets[tier])
        rng.shuffle(current)
        count = round(len(current) * retention / (1 - retention)) if earlier else 0
        replay = [earlier[rng.randrange(len(earlier))] for _ in range(count)]
        mixed = current + replay
        rng.shuffle(mixed)
        ordered.extend(mixed)
        earlier.extend(current)
    return ordered


def curriculum_pick(rows: list[dict], config: dict, state: dict, rng: random.Random) -> tuple[dict, dict]:
    curriculum = config.get("curriculum", {})
    if not curriculum.get("enabled", False):
        row = rows[rng.randrange(len(rows))]
        return row, {"enabled": False, "active_tier": task_metadata(row)["tier"], "rehearsal": False}
    tiers = sorted({task_metadata(row)["tier"] for row in rows})
    progress = state.setdefault("curriculum", {"active_tier": min(tiers), "tier_groups": 0, "history": []})
    tier = progress["active_tier"]
    current = [row for row in rows if task_metadata(row)["tier"] == tier]
    if not current:
        raise ValueError("saved curriculum tier is absent from the frozen training set")
    earlier = [row for row in rows if task_metadata(row)["tier"] < tier]
    rehearsal = bool(earlier) and rng.random() < curriculum.get("retention_fraction", .25)
    pool = earlier if rehearsal else current
    return pool[rng.randrange(len(pool))], {"enabled": True, "active_tier": tier, "rehearsal": rehearsal}


def update_curriculum(rows: list[dict], config: dict, state: dict, selection: dict, records: list[dict]) -> dict:
    if not selection["enabled"]:
        return selection
    curriculum = config["curriculum"]
    progress = state["curriculum"]
    if not selection["rehearsal"]:
        progress["tier_groups"] += 1
        progress["history"].append(sum(bool(record["grade"]["success"]) for record in records) / len(records))
        progress["history"] = progress["history"][-curriculum.get("window_groups", 20):]
    rate = statistics.fmean(progress["history"]) if progress["history"] else 0.0
    minimum = curriculum.get("minimum_groups", 4)
    ready = (progress["tier_groups"] >= curriculum.get("groups_per_tier", 20)
             and len(progress["history"]) >= minimum
             and rate >= curriculum.get("advance_success_rate", .25))
    later = sorted({task_metadata(row)["tier"] for row in rows if task_metadata(row)["tier"] > progress["active_tier"]})
    advanced = bool(ready and later)
    if advanced:
        previous = progress["active_tier"]
        progress.update(active_tier=later[0], tier_groups=0, history=[])
        state.setdefault("curriculum_transitions", []).append({"from": previous, "to": later[0], "success_rate": rate})
    return {**selection, "tier_success_rate": rate, "advanced": advanced,
            "next_active_tier": progress["active_tier"],
            "needs_supervision": not advanced and len(progress["history"]) >= minimum and rate == 0}


def choose_validation_checkpoint(candidates: list[dict], config: dict) -> dict | None:
    """Choose by predeclared accuracy constraint, then worthwhile cost saving.

    All candidates must be validation summaries. The accuracy anchor is the
    most accurate candidate, including the untrained baseline when supplied.
    A lower-accuracy candidate can win only inside the tolerance AND when its
    all-attempt token cost per verified success beats the anchor by the declared
    minimum saving. This is checkpoint selection, not a statistical claim.
    """
    usable = [candidate for candidate in candidates
              if candidate.get("split") == "validation"
              and candidate.get("summary", {}).get("complete_execution_accuracy") is not None]
    if not usable:
        return None
    def cost(candidate: dict) -> float:
        value = candidate["summary"].get("tokens_per_verified_success")
        return float(value) if value is not None else math.inf
    anchor = min(usable, key=lambda candidate: (-candidate["summary"]["complete_execution_accuracy"],
                 cost(candidate), candidate["stage"]))
    accuracy = anchor["summary"]["complete_execution_accuracy"]
    threshold = accuracy - config["accuracy_tolerance"]
    target_cost = cost(anchor) * (1 - config["min_token_saving"])
    eligible = [candidate for candidate in usable
                if candidate["summary"]["complete_execution_accuracy"] >= threshold
                and math.isfinite(cost(candidate)) and cost(candidate) <= target_cost]
    chosen = min(eligible, key=lambda candidate: (cost(candidate),
                 -candidate["summary"]["complete_execution_accuracy"], candidate["stage"])) if eligible else anchor
    return {**chosen, "selection": {"accuracy_anchor": accuracy, "minimum_accuracy": threshold,
             "anchor_stage": anchor["stage"], "anchor_tokens_per_success": None if not math.isfinite(cost(anchor)) else cost(anchor),
             "minimum_token_saving": config["min_token_saving"], "used_test": False}}
