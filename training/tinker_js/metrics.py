"""Execution metrics and paired uncertainty; failures retain their full cost."""

from __future__ import annotations

from collections import Counter, defaultdict
import math
import random
import statistics


def quantile(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * probability
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def failure_category(record: dict) -> str:
    if record.get("infrastructure_error") or record.get("grade") is None:
        return "infrastructure"
    grade = record["grade"]
    if grade.get("success"):
        return "success"
    reason = str(grade.get("reason", "unknown")).lower()
    detail = str(grade.get("failureCategory", grade.get("category", ""))).lower()
    if detail:
        return detail
    if any(value in reason for value in ("parse", "malformed", "invalid_action", "invalid action")):
        return "malformed_action"
    if any(value in reason for value in ("truncat", "token_budget")):
        return "truncation"
    if any(value in reason for value in ("incomplete", "turn_budget", "pending")):
        return "incomplete_execution"
    if "argument" in reason:
        return "incorrect_external_arguments"
    if "mutation" in reason or "alias" in reason or "graph" in reason:
        return "mutation_or_alias_mismatch"
    if any(value in reason for value in ("request", "operation", "external", "effect", "call")):
        return "incorrect_external_request_or_effect"
    if any(value in reason for value in ("outcome", "result", "return", "throw", "completion")):
        return "incorrect_completion"
    return "other_execution_failure"


def _basic(records: list[dict]) -> dict:
    successes = [record for record in records if record["grade"]["success"]]
    lengths = [record["generated_tokens"] for record in records]
    total = sum(lengths)
    failure_tokens = sum(record["generated_tokens"] for record in records if not record["grade"]["success"])
    return {"executions": len(records), "successes": len(successes),
            "complete_execution_accuracy": len(successes) / len(records) if records else None,
            "mean_generated_tokens": statistics.fmean(lengths) if lengths else None,
            "median_generated_tokens": statistics.median(lengths) if lengths else None,
            "p95_generated_tokens": quantile(lengths, .95),
            "mean_successful_tokens": statistics.fmean(record["generated_tokens"] for record in successes) if successes else None,
            "incomplete": sum(not record.get("complete", False) for record in records),
            "all_generated_tokens": total, "failed_execution_tokens": failure_tokens,
            "tokens_per_verified_success": total / len(successes) if successes else None,
            "mean_reward": statistics.fmean(record["grade"].get("reward", 0) for record in records) if records else None,
            "failure_categories": dict(sorted(Counter(failure_category(record) for record in records
                                             if not record["grade"]["success"]).items()))}


def summarize_records(records: list[dict]) -> dict:
    if any(record.get("grade") is None for record in records):
        raise ValueError("infrastructure attempts must be reported separately from graded model executions")
    result = _basic(records)
    groups: dict[str, dict[str, list[dict]]] = {
        "by_family": defaultdict(list), "by_feature": defaultdict(list), "by_tier": defaultdict(list)}
    categories: Counter = Counter()
    turns = []
    for record in records:
        groups["by_family"][record.get("family") or record.get("task_id") or "unknown"].append(record)
        groups["by_tier"][str(record.get("tier", 1))].append(record)
        for feature in record.get("features", []):
            groups["by_feature"][feature].append(record)
        samples = record.get("samples", [])
        classified = 0
        for sample in samples:
            count = len(sample.get("token_ids", []))
            turns.append(count)
            accounting = sample.get("token_accounting")
            if accounting is not None:
                if (not isinstance(accounting, dict)
                        or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in accounting.values())
                        or sum(accounting.values()) != count):
                    raise ValueError("sample token_accounting must partition all generated token IDs exactly")
                categories.update(accounting)
                classified += count
        if classified > record["generated_tokens"]:
            raise ValueError("classified token counts exceed the recorded execution total")
        categories["unclassified"] += record["generated_tokens"] - classified
    for name, buckets in groups.items():
        result[name] = {key: _basic(value) for key, value in sorted(buckets.items())}
    result.update(token_categories=dict(sorted(categories.items())),
                  token_category_scope="Exact adapter-provided token spans only; unavailable decomposition remains unclassified",
                  mean_tokens_per_turn=statistics.fmean(turns) if turns else None,
                  p95_tokens_per_turn=quantile(turns, .95),
                  independent_components=len({record.get("split_component") or record.get("family") or record.get("task_id")
                                              for record in records}))
    if any("advantage" in record for record in records):
        result["mean_absolute_advantage"] = statistics.fmean(abs(record.get("advantage", 0)) for record in records)
        result["mean_absolute_correctness_advantage"] = statistics.fmean(abs(record.get("correctness_advantage", 0)) for record in records)
        result["mean_absolute_length_contribution"] = statistics.fmean(abs(record.get("length_contribution", 0)) for record in records)
    return result


def _pair_measurements(pairs: list[dict]) -> dict:
    if not pairs:
        return {"accuracy_change": None, "mean_token_change": None, "token_saving_fraction": None,
                "tokens_per_verified_success_saving": None}
    baseline_tokens = sum(pair["baseline_tokens"] for pair in pairs)
    tokens = sum(pair["tokens"] for pair in pairs)
    before_successes = sum(pair["baseline_success"] for pair in pairs)
    after_successes = sum(pair["success"] for pair in pairs)
    before_cost = baseline_tokens / before_successes if before_successes else None
    after_cost = tokens / after_successes if after_successes else None
    return {"accuracy_change": statistics.fmean(int(pair["success"]) - int(pair["baseline_success"]) for pair in pairs),
            "mean_token_change": statistics.fmean(pair["tokens"] - pair["baseline_tokens"] for pair in pairs),
            "token_saving_fraction": 1 - tokens / baseline_tokens if baseline_tokens else None,
            "tokens_per_verified_success_saving": 1 - after_cost / before_cost
            if before_cost is not None and before_cost > 0 and after_cost is not None else None}


def paired_statistics(before: list[dict], after: list[dict], config: dict) -> dict:
    baseline = {(row["task_id"], row.get("repeat", 0)): row for row in before}
    candidates = {(row["task_id"], row.get("repeat", 0)): row for row in after}
    if len(baseline) != len(before) or len(candidates) != len(after):
        raise ValueError("paired evaluation contains duplicate task/repeat identities")
    if set(baseline) != set(candidates):
        raise ValueError("paired evaluation requires exactly the same task/repeat population")
    pairs = []
    for key in sorted(baseline):
        first, second = baseline[key], candidates[key]
        if any(first.get(field) != second.get(field) for field in
               ("source_hash", "task_hash", "seed", "split_component")):
            raise ValueError("paired evaluation requires identical sources, tasks, families, selection, and sampling seeds")
        pairs.append({"task_id": key[0], "repeat": key[1],
                      "component": first.get("split_component") or first.get("family") or key[0],
                      "baseline_success": bool(first["grade"]["success"]), "success": bool(second["grade"]["success"]),
                      "baseline_tokens": first["generated_tokens"], "tokens": second["generated_tokens"]})
    both = [pair for pair in pairs if pair["baseline_success"] and pair["success"]]
    result = {"matched_executions": len(pairs), "both_correct": len(both), **_pair_measurements(pairs),
              "mean_token_change_when_both_correct": statistics.fmean(pair["tokens"] - pair["baseline_tokens"] for pair in both) if both else None,
              "executions": pairs}
    families: dict[str, list[dict]] = defaultdict(list)
    for pair in pairs:
        families[pair["component"]].append(pair)
    names = sorted(families)
    rng = random.Random(config.get("seed", 17))
    estimates: dict[str, list[float]] = defaultdict(list)
    repetitions = config.get("bootstrap_samples", 1000)
    if names:
        for _ in range(repetitions):
            sample = [pair for name in rng.choices(names, k=len(names)) for pair in families[name]]
            for metric, value in _pair_measurements(sample).items():
                if value is not None and math.isfinite(value):
                    estimates[metric].append(value)
    alpha = (1 - config.get("confidence_level", .95)) / 2
    intervals = {metric: {"low": quantile(values, alpha), "high": quantile(values, 1 - alpha),
                           "valid_resamples": len(values)} for metric, values in estimates.items()}
    sufficient = len(names) >= config.get("minimum_evaluation_families", 30)
    accuracy_interval = intervals.get("accuracy_change", {})
    saving_interval = intervals.get("tokens_per_verified_success_saving", {})
    noninferior = (accuracy_interval.get("low") is not None
                  and accuracy_interval["low"] >= -config.get("accuracy_tolerance", .02))
    saves = (saving_interval.get("low") is not None
             and saving_interval["low"] >= config.get("min_token_saving", .1)
             and saving_interval.get("valid_resamples", 0) == repetitions)
    # A zero-width bootstrap with no observed discordance cannot establish an
    # arbitrarily small accuracy margin. Retain the empirical interval and mark
    # the inference limitation instead of inventing precision.
    degenerate_accuracy = len({value for value in estimates.get("accuracy_change", [])}) <= 1
    result["uncertainty"] = {"method": "paired percentile bootstrap of whole source-family components",
        "confidence_level": 1 - 2 * alpha, "seed": config.get("seed", 17), "resamples": repetitions,
        "independent_components": len(names), "intervals": intervals,
        "degenerate_accuracy_distribution": degenerate_accuracy,
        "note": "Intervals describe observed family variation; small populations and absent discordance limit generalization claims."}
    point_ok = (result["accuracy_change"] is not None and result["accuracy_change"] >= -config.get("accuracy_tolerance", .02)
                and result["tokens_per_verified_success_saving"] is not None
                and result["tokens_per_verified_success_saving"] >= config.get("min_token_saving", .1))
    result["acceptance"] = {"accuracy_tolerance": config.get("accuracy_tolerance", .02),
        "minimum_token_saving": config.get("min_token_saving", .1),
        "minimum_independent_components": config.get("minimum_evaluation_families", 30),
        "point_estimate_meets_criteria": point_ok,
        "family_bootstrap_supports_criteria": sufficient and noninferior and saves and not degenerate_accuracy,
        "status": "supported" if sufficient and noninferior and saves and not degenerate_accuracy
                  else "inconclusive" if point_ok else "criteria_not_met"}
    return result
