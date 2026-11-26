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


def _record_code_load_calls(record: dict) -> int:
    grade = record.get("grade") if isinstance(record.get("grade"), dict) else {}
    raw = grade.get("codeLoadCalls")
    if raw is None:
        raw = grade.get("code_load_calls")
    if raw is None:
        raw = record.get("codeLoadCalls")
    if raw is None:
        raw = record.get("code_load_calls", 0)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ValueError("code_load_calls must be a nonnegative integer")
    return raw


def execution_advantages(records: list[dict], config: dict, coefficient: float | None = None) -> dict:
    """Separate correctness and success-conditional length credit.

    Length uses a fixed token scale, clipped to [0,1], and is centered only
    among successes. Failure gets no length credit. Both components have zero
    group mean. A single successful sample has no within-success length signal.
    In ``decoupled`` mode only correctness is standardized; in ``centered``
    mode both components retain fixed raw scale. Changing coefficient changes
    the length contribution linearly in every group, including all-success.
    When ``code_load_latency_tokens > 0``, effective length cost includes
    ``code_load_latency_tokens * code_load_calls`` so RL jointly optimizes
    tokens and code.load tool-call round-trip latency.
    """
    if not records:
        raise ValueError("execution advantages require at least one rollout")
    coefficient = config["length_penalty"] if coefficient is None else coefficient
    if not math.isfinite(coefficient) or not 0 <= coefficient < 1:
        raise ValueError("compression coefficient must be finite in [0, 1)")
    scale = config["length_scale_tokens"]
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("length_scale_tokens must be finite and positive")
    raw_latency = config.get("code_load_latency_tokens", 0.0)
    if isinstance(raw_latency, bool) or not isinstance(raw_latency, (int, float)) or not math.isfinite(raw_latency) or raw_latency < 0:
        raise ValueError("code_load_latency_tokens must be finite and nonnegative")
    latency_tokens = float(raw_latency)
    correct = [float(bool(record["grade"]["success"])) for record in records]
    tokens = [record["generated_tokens"] for record in records]
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in tokens):
        raise ValueError("generated token counts must be nonnegative integers")
    code_loads = [_record_code_load_calls(record) for record in records]
    compress_only_accurate = bool(config.get("compress_only_accurate_groups", False))
    correctness = centered(correct, standardize=config.get("advantage_mode", "decoupled") == "decoupled")
    successful = [index for index, value in enumerate(correct) if value]
    length = [0.0] * len(records)
    if successful and (not compress_only_accurate or len(successful) == len(records)):
        costs = [min((tokens[index] + latency_tokens * code_loads[index]) / scale, 1.0) for index in successful]
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
    best thought and >= -1.0 nats, optionally gated by `compression_ll_threshold`
    and `compress_only_accurate_groups`), shorter thoughts receive a standardized
    length saving bonus scaled by `coefficient`, preventing compression from ever
    rewarding wrong shortcuts. Target action tokens y receive a posterior-weighted
    EM anchor advantage proportional to softmax(ll_i) (optionally overridden for
    external tool-call turns via `tool_turn_anchor_weight`).
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
    raw_tool_anchor = config.get("tool_turn_anchor_weight")
    if raw_tool_anchor is not None:
        if isinstance(raw_tool_anchor, bool) or not isinstance(raw_tool_anchor, (int, float)):
            raise ValueError("tool_turn_anchor_weight must be null or finite and nonnegative")
        tool_anchor_weight = float(raw_tool_anchor)
        if not math.isfinite(tool_anchor_weight) or tool_anchor_weight < 0:
            raise ValueError("tool_turn_anchor_weight must be null or finite and nonnegative")
    else:
        tool_anchor_weight = anchor_weight
    compress_only_accurate = bool(config.get("compress_only_accurate_groups", False))
    compression_ll_threshold = config.get("compression_ll_threshold", config.get("compression_min_group_ll"))
    if compression_ll_threshold is not None:
        if isinstance(compression_ll_threshold, bool) or not isinstance(compression_ll_threshold, (int, float)):
            raise ValueError("compression_ll_threshold must be null or finite")
        compression_ll_threshold = float(compression_ll_threshold)
        if not math.isfinite(compression_ll_threshold):
            raise ValueError("compression_ll_threshold must be null or finite")
    std_floor = float(config.get("likelihood_std_floor", 0.5))
    if not math.isfinite(std_floor) or std_floor < 0:
        raise ValueError("likelihood_std_floor must be finite and nonnegative")
    length_std_floor = float(config.get("confident_length_std_floor", 64.0))
    if not math.isfinite(length_std_floor) or length_std_floor <= 0:
        raise ValueError("confident_length_std_floor must be finite and positive")
    opsd_norm_mode = config.get("opsd_norm_mode", "trajectory")
    if opsd_norm_mode not in {"trajectory", "sqrt", "none"}:
        raise ValueError("opsd_norm_mode must be trajectory, sqrt, or none")
    opsd_coef = float(config.get("opsd_coef", 0.0))
    if not math.isfinite(opsd_coef) or opsd_coef < 0:
        raise ValueError("opsd_coef must be finite and nonnegative")
    opsd_clip = float(config.get("opsd_clip", 5.0))
    if not math.isfinite(opsd_clip) or opsd_clip <= 0:
        raise ValueError("opsd_clip must be finite and positive")
    opsd_ll_threshold = config.get("opsd_ll_threshold", -0.5)
    if opsd_ll_threshold is not None:
        if isinstance(opsd_ll_threshold, bool) or not isinstance(opsd_ll_threshold, (int, float)):
            raise ValueError("opsd_ll_threshold must be null or finite")
        opsd_ll_threshold = float(opsd_ll_threshold)
        if not math.isfinite(opsd_ll_threshold):
            raise ValueError("opsd_ll_threshold must be null or finite")

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

    mean_valid_ll = statistics.fmean(valid_lls) if valid_lls else None
    mean_group_ll = statistics.fmean(ll_values)
    allow_compression = bool(valid_indices)
    if compress_only_accurate and len(valid_indices) != len(records):
        allow_compression = False
    if compression_ll_threshold is not None and (
        mean_valid_ll is None
        or mean_valid_ll < compression_ll_threshold
        or mean_group_ll < compression_ll_threshold
    ):
        allow_compression = False

    length = [0.0] * len(records)
    if allow_compression:
        best_ll = max(valid_lls)
        min_rollout_ll = max(-1.0, compression_ll_threshold) if compression_ll_threshold is not None else -1.0
        confident = [
            idx for idx, ll in zip(valid_indices, valid_lls)
            if ll >= best_ll - 0.5 and ll >= min_rollout_ll
        ]
        if len(confident) >= 2:
            toks = [float(records[idx]["generated_tokens"]) for idx in confident]
            mean_tok = statistics.fmean(toks)
            tok_dev = math.sqrt(statistics.fmean((t - mean_tok) ** 2 for t in toks))
            tok_denom = max(tok_dev, length_std_floor)
            for idx, tok in zip(confident, toks):
                length[idx] = max(-2.0, min(2.0, (mean_tok - tok) / tok_denom))
    advantages = [acc + coefficient * saving for acc, saving in zip(ll_adv, length)]

    target_advantages = [0.0] * len(records)
    if valid_indices and (anchor_weight > 0 or tool_anchor_weight > 0):
        max_ll = max(valid_lls)
        exps = [math.exp(max(ll - max_ll, -50.0)) for ll in valid_lls]
        total_exp = sum(exps) or 1.0
        for index, exp_val in zip(valid_indices, exps):
            rec = records[index]
            sample0 = (rec.get("samples") or [None])[0]
            is_tool_call = bool(
                rec.get("is_tool_call")
                if "is_tool_call" in rec
                else (sample0.get("is_tool_call") if isinstance(sample0, dict) else False)
            )
            eff_weight = tool_anchor_weight if is_tool_call else anchor_weight
            if eff_weight > 0:
                target_advantages[index] = eff_weight * (exp_val / total_exp) * len(valid_indices)

    token_advantages: list[list[float] | None] = [None] * len(records)
    opsd_token_deltas: list[list[float] | None] = [None] * len(records)
    opsd_scored_rollouts = 0
    opsd_active_rollouts = 0
    opsd_log_ratio_sum = 0.0
    opsd_log_ratio_tokens = 0
    valid_set = set(valid_indices)
    if opsd_coef > 0:
        for index, record in enumerate(records):
            sample0 = (record.get("samples") or [None])[0]
            s_lps = sample0.get("logprobs") if isinstance(sample0, dict) else None
            if s_lps is None:
                s_lps = record.get("logprobs")
            t_lps = sample0.get("teacher_logprobs") if isinstance(sample0, dict) else None
            if t_lps is None:
                t_lps = record.get("teacher_logprobs")
            if not (isinstance(s_lps, list) and isinstance(t_lps, list) and s_lps and len(t_lps) == len(s_lps)):
                continue
            opsd_scored_rollouts += 1
            is_terminated = index in valid_set
            gate_pass = (opsd_ll_threshold is None) or (not is_terminated) or (ll_values[index] < opsd_ll_threshold)
            if not gate_pass:
                continue
            base_adv = advantages[index]
            tok_deltas: list[float] = []
            tok_adv: list[float] = []
            for s_lp, t_lp in zip(s_lps, t_lps):
                diff = float(t_lp) - float(s_lp)
                clipped = max(-opsd_clip, min(opsd_clip, diff))
                delta = opsd_coef * clipped
                tok_deltas.append(delta)
                tok_adv.append(base_adv + delta)
                opsd_log_ratio_sum += diff
                opsd_log_ratio_tokens += 1
            opsd_token_deltas[index] = tok_deltas
            token_advantages[index] = tok_adv
            opsd_active_rollouts += 1

    has_token_signal = any(
        ta is not None and any(abs(v) > 1e-12 for v in ta)
        for ta in token_advantages
    ) or any(
        od is not None and any(abs(v) > 1e-12 for v in od)
        for od in opsd_token_deltas
    )
    has_signal = (
        any(abs(value) > 1e-12 for value in advantages)
        or any(abs(value) > 1e-12 for value in target_advantages)
        or has_token_signal
    )
    kind = "all_failure" if not valid_indices else ("all_success" if len(valid_indices) == len(records) else "mixed_success")
    return {
        "advantages": advantages,
        "target_advantages": target_advantages,
        "token_advantages": token_advantages,
        "opsd_token_deltas": opsd_token_deltas,
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
        "opsd_active_rollouts": opsd_active_rollouts,
        "opsd_scored_rollouts": opsd_scored_rollouts,
        "opsd_mean_log_ratio": (opsd_log_ratio_sum / opsd_log_ratio_tokens) if opsd_log_ratio_tokens > 0 else None,
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


DIFFICULTY_SAMPLING_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "effectful_boost": 2.0,
    "unit_test_boost": 1.6,
    "tier5_boost": 1.5,
    "long_boost": 1.4,
    "hard_weight": 3.5,
    "easy_weight": 0.3,
    "hard_ll_threshold": -0.5,
    "easy_ll_threshold": -0.05,
    "easy_token_threshold": 900,
    "tool_turn_boost": 1.8,
}


def difficulty_weight(row: dict, config: dict, state: dict) -> float:
    ds = {**DIFFICULTY_SAMPLING_DEFAULTS, **(config.get("difficulty_sampling") or {})}
    meta = task_metadata(row)
    features = set(meta.get("features", []))
    ext_calls = meta.get("externalCalls", 0)
    weight = 1.0
    if isinstance(ext_calls, (int, float)) and not isinstance(ext_calls, bool) and ext_calls > 0:
        weight *= float(ds["effectful_boost"])
    if "unit-test-input" in features:
        weight *= float(ds["unit_test_boost"])
    if meta["tier"] >= 5:
        weight *= float(ds["tier5_boost"])
    if "longer-execution" in features:
        weight *= float(ds["long_boost"])
    stats_table = state.setdefault("task_difficulty", {})
    stats = stats_table.get(row["id"])
    if isinstance(stats, dict) and stats.get("visits", 0) > 0:
        last_term_rate = stats.get("last_term_rate")
        last_best_ll = stats.get("last_best_ll")
        last_mean_tok = stats.get("last_mean_tok")
        if ((last_term_rate is not None and last_term_rate < 1.0)
                or last_best_ll is None
                or last_best_ll < float(ds["hard_ll_threshold"])):
            weight *= float(ds["hard_weight"])
        elif (last_best_ll >= float(ds["easy_ll_threshold"])
              and last_mean_tok is not None
              and last_mean_tok <= float(ds["easy_token_threshold"])):
            weight *= float(ds["easy_weight"])
    return max(weight, 1e-12)


def difficulty_pick(rows: list[dict], config: dict, state: dict, rng: random.Random) -> tuple[dict, dict]:
    if not rows:
        raise ValueError("difficulty_pick requires at least one training row")
    weights = [difficulty_weight(row, config, state) for row in rows]
    total = sum(weights)
    target = rng.random() * total
    acc = 0.0
    chosen_index = len(rows) - 1
    for index, weight in enumerate(weights):
        acc += weight
        if acc >= target:
            chosen_index = index
            break
    row = rows[chosen_index]
    return row, {
        "enabled": False,
        "active_tier": task_metadata(row)["tier"],
        "rehearsal": False,
        "difficulty_weighted": True,
        "weight": weights[chosen_index],
    }


def update_task_difficulty(config: dict, state: dict, task_id: str,
                           group_records: list[dict], sig: dict) -> dict | None:
    if not (config.get("difficulty_sampling") or {}).get("enabled", False):
        return None
    table = state.setdefault("task_difficulty", {})
    prev = table.get(task_id)
    visits = (int(prev.get("visits", 0)) if isinstance(prev, dict) else 0) + 1
    term_flags = [
        bool(record["terminated"]) if "terminated" in record else bool(record.get("grade", {}).get("success"))
        for record in group_records
    ]
    last_term_rate = sum(term_flags) / len(term_flags) if term_flags else 0.0
    last_best_ll = sig.get("best_target_ll")
    toks = [float(record.get("generated_tokens", 0)) for record in group_records]
    last_mean_tok = statistics.fmean(toks) if toks else 0.0
    entry = {
        "last_best_ll": last_best_ll,
        "last_mean_tok": last_mean_tok,
        "last_term_rate": last_term_rate,
        "visits": visits,
    }
    table[task_id] = entry
    return entry


def pick_turn_target(turns: list[dict], config: dict, rng: random.Random) -> dict:
    if not turns:
        raise ValueError("pick_turn_target requires at least one turn target")
    ds = config.get("difficulty_sampling") or {}
    enabled = bool(ds.get("enabled", False))
    boost = float(ds.get("tool_turn_boost", DIFFICULTY_SAMPLING_DEFAULTS["tool_turn_boost"])) if enabled else 1.0
    if not enabled or boost <= 1.0:
        return turns[rng.randrange(len(turns))]
    weights = [boost if turn.get("is_tool_call") else 1.0 for turn in turns]
    total = sum(weights)
    target = rng.random() * total
    acc = 0.0
    for turn, weight in zip(turns, weights):
        acc += weight
        if acc >= target:
            return turn
    return turns[-1]


def curriculum_pick(rows: list[dict], config: dict, state: dict, rng: random.Random) -> tuple[dict, dict]:
    curriculum = config.get("curriculum", {})
    if not curriculum.get("enabled", False):
        if (config.get("difficulty_sampling") or {}).get("enabled", False):
            return difficulty_pick(rows, config, state, rng)
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
