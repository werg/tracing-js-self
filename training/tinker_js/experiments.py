"""Staged validation experiments and live diagnostics for JS execution learning.

Planning is local. Runs use only the explicitly configured Tinker model. A final
test seal freezes all choices before any held-out evaluation and prevents later
validation tuning in the same study directory. Test outcomes never select jobs.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import statistics
from pathlib import Path
import subprocess
import sys
from typing import Any

from . import runner
from .adapter import TinkerAdapter, rl_token_arrays

STAGES = ("baseline", "learning-rate", "trace", "rl-learning-rate", "objective", "repeat", "final")
DEFAULT_EFFORTS = (0.0, 0.2, 0.7, 0.9)
DEFAULT_RATES = (1e-5, 3e-5, 1e-4)
DEFAULT_RL_RATES = (1e-6, 3e-6, 1e-5)
DEFAULT_SEEDS = (17, 29, 47)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _absolute(repo: Path, value: str | Path) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (repo / path).resolve()


def _number_list(values: list, name: str, *, integer=False, minimum=0, maximum=None) -> list:
    if not values or len(set(values)) != len(values):
        raise ValueError(f"{name} must be nonempty and contain no duplicates")
    for value in values:
        if (isinstance(value, bool) or not isinstance(value, (int,) if integer else (int, float))
                or not math.isfinite(value) or value < minimum
                or maximum is not None and value >= maximum):
            raise ValueError(f"Invalid {name} value")
    return values


def _signed(value: dict) -> dict:
    result = copy.deepcopy(value)
    result["hash"] = runner.digest(value)
    return result


def _label(number: float) -> str:
    return f"{number:g}".replace(".", "p").replace("+", "")


def read_plan(path: Path, repo: Path, *, check_code=True) -> dict:
    plan = json.loads(path.read_text())
    if plan.get("schema") != "tinker-js-study-v1":
        raise ValueError("Unknown study plan schema")
    if runner.digest({k: v for k, v in plan.items() if k != "hash"}) != plan.get("hash"):
        raise ValueError("Study plan checksum failed")
    if check_code and runner.implementation_identity(repo)["hash"] != plan["implementation_hash"]:
        raise ValueError("Implementation changed after planning; create a new study")
    for dataset in [plan["dataset"], *plan.get("diagnostic_datasets", [])]:
        if _sha(Path(dataset["path"])) != dataset["sha256"]:
            raise ValueError("A frozen study dataset changed")
    return plan


def create_plan(repo: Path, config: dict, destination: Path, *, efforts=None, rates=None,
                rl_rates=None, seeds=None, diagnostic_datasets: dict[str, str] | None = None) -> dict:
    """Freeze source inputs/splits once, independently of training RNG and sweeps."""
    destination.mkdir(parents=True, exist_ok=True)
    if (destination / "plan.json").exists():
        raise ValueError("A study plan already exists; reuse it or choose a new output directory")
    efforts = _number_list(list(DEFAULT_EFFORTS if efforts is None else efforts), "efforts", maximum=1)
    rates = _number_list(list(DEFAULT_RATES if rates is None else rates), "learning rates", minimum=1e-12)
    rl_rates = _number_list(list(DEFAULT_RL_RATES if rl_rates is None else rl_rates), "RL learning rates", minimum=1e-12)
    seeds = _number_list(list(DEFAULT_SEEDS if seeds is None else seeds), "seeds", integer=True, maximum=2**31)
    if config["length_penalty"] <= 0 or config["sft_epochs"] < 1 or config["rl_steps"] < 1:
        raise ValueError("A full study requires positive SFT epochs, RL steps and a positive compression penalty")
    implementation_hash = runner.implementation_identity(repo)["hash"]
    freeze_config = copy.deepcopy(config)
    freeze_config.update({"max_eval_tasks": None, "final_test": False})
    with runner.Bridge(repo, config["bridge_timeout_seconds"]) as bridge:
        rows, manifest = runner.export_dataset(repo, freeze_config, destination / "preparation", bridge)
    source_path = _absolute(repo, config["dataset"])
    if (manifest.get("implementation_hash") != implementation_hash
            or manifest.get("input_sha256") != _sha(source_path)):
        raise ValueError("Source or implementation changed during study preparation")
    original = {row["id"]: row for row in runner.read_jsonl(source_path)}
    frozen = []
    for row in rows:
        item = copy.deepcopy(row["task"])
        item.update({"id": row["id"], "family": row["family"], "split": row["split"]})
        item["metadata"] = {**item.get("metadata", {}), **row.get("metadata", {})}
        item["ancestors"] = sorted(set(item.get("ancestors", []) + row.get("ancestors", [])))
        # Retain supplied-agent/canonical scope and source bindings when present.
        for field in ("agentTrajectory", "canonicalArtifact", "sourceHashes"):
            if field in original[row["id"]]:
                item[field] = copy.deepcopy(original[row["id"]][field])
        frozen.append(item)
    frozen_path = destination / "frozen-input.jsonl"
    runner.write_jsonl(frozen_path, frozen)
    selection_config = copy.deepcopy(config)
    if isinstance(selection_config.get("evaluation_manifest"), str):
        selection_config["evaluation_manifest"] = str(_absolute(repo, selection_config["evaluation_manifest"]))
    selection = {"train": sorted(row["id"] for row in rows if row["split"] == "train")}
    selection_metadata = {}
    for split in ("validation", "test"):
        selected, selection_metadata[split] = runner.evaluation_selection(
            rows, selection_config, destination / "preparation", split)
        selection[split] = [row["id"] for row in selected]
    diagnostics = []
    for role, filename in sorted((diagnostic_datasets or {}).items()):
        if role not in {"familiar_inputs", "challenge"}:
            raise ValueError("Diagnostic role must be familiar_inputs or challenge")
        source = _absolute(repo, filename)
        diagnostic_rows = runner.read_jsonl(source)
        if not diagnostic_rows or any(row.get("split") != "test"
                                      or row.get("metadata", {}).get("diagnosticOnly") is not True
                                      or row.get("metadata", {}).get("evaluationRole") != role
                                      for row in diagnostic_rows):
            raise ValueError("Diagnostic datasets require split=test, matching roles and diagnosticOnly=true")
        diagnostic_config = {**freeze_config, "dataset": str(source), "evaluation_manifest": None,
                             "evaluation_only": True, "diagnostic_only": True,
                             "holdout_fraction": 0, "validation_fraction": 0}
        with runner.Bridge(repo, config["bridge_timeout_seconds"]) as bridge:
            exported_diagnostics, diagnostic_manifest = runner.export_dataset(
                repo, diagnostic_config, destination / f"preparation-{role}", bridge)
        if (diagnostic_manifest.get("implementation_hash") != implementation_hash
                or diagnostic_manifest.get("input_sha256") != _sha(source)):
            raise ValueError("Source or implementation changed during study preparation")
        frozen_diagnostics = []
        for row in exported_diagnostics:
            item = copy.deepcopy(row["task"])
            item.update(id=row["id"], family=row["family"], split="test")
            item["metadata"] = {**item.get("metadata", {}), **row.get("metadata", {})}
            if item["metadata"].get("diagnosticOnly") is not True:
                raise ValueError("Diagnostic scope was lost during source verification")
            frozen_diagnostics.append(item)
        target = destination / f"frozen-{role}.jsonl"
        runner.write_jsonl(target, frozen_diagnostics)
        diagnostics.append({"role": role, "path": str(target), "sha256": _sha(target),
                            "cases": len(frozen_diagnostics), "source_sha256": _sha(source),
                            "verified_dataset_hash": diagnostic_manifest.get("dataset_hash")})
    base = copy.deepcopy(config)
    base.update({"dataset": str(frozen_path), "max_eval_tasks": None, "evaluation_manifest": selection,
                 "final_test": False, "evaluation_seed": config.get("evaluation_seed", 17),
                 "split_seed": config.get("split_seed", 17), "initial_sft_checkpoint": None})
    if runner.implementation_identity(repo)["hash"] != implementation_hash:
        raise ValueError("Source or implementation changed during study preparation")
    plan = _signed({"schema": "tinker-js-study-v1", "repo": str(repo),
        "implementation_hash": implementation_hash,
        "dataset": {"path": str(frozen_path), "sha256": _sha(frozen_path),
                    "split_manifest": manifest["split_manifest"], "counts": manifest["counts"],
                    "evaluation_population": selection_metadata},
        "diagnostic_datasets": diagnostics, "base_config": base,
        "efforts": efforts, "learning_rates": rates, "rl_learning_rates": rl_rates, "training_seeds": seeds,
        "trace_formats": ["full", "compact", "actions-only"],
        "prompt_styles": ["standard", "concise"],
        "stages": list(STAGES),
        "require_learnability": True,
        "selection_rule": "validation accuracy within tolerance of best, then minimum tokens per verified success",
        "acceptance": {"accuracy_tolerance": config.get("accuracy_tolerance", 0.02),
                       "min_token_saving": config.get("min_token_saving", 0.2),
                       "minimum_evaluation_families": config.get("minimum_evaluation_families", 30)},
        "claims": {"model_compute_performed": False, "training_result": None,
                   "test_role": "sealed until all validation choices are frozen",
                   "diagnostic_role": "reported separately; never used for fitting or selection"}})
    runner.atomic_json(destination / "plan.json", plan)
    return plan


def choose_job(results: list[dict], tolerance: float) -> dict:
    """Select only validated real model records; never use diagnostics or test."""
    if not results:
        raise ValueError("Cannot select from an empty experiment stage")
    for result in results:
        if result.get("backend") != "tinker" or result.get("split") != "validation":
            raise ValueError("Only live validation results can select study settings")
        if not 0 <= result["summary"]["complete_execution_accuracy"] <= 1:
            raise ValueError("Invalid validation accuracy")
    best_accuracy = max(row["summary"]["complete_execution_accuracy"] for row in results)
    eligible = [row for row in results if row["summary"]["complete_execution_accuracy"] >= best_accuracy - tolerance]
    def cost(row):
        summary = row["summary"]
        value = summary.get("tokens_per_verified_success")
        if value is None and summary.get("successes", 0):
            value = summary["all_generated_tokens"] / summary["successes"]
        return (math.inf if value is None else value,
                -summary["complete_execution_accuracy"], row["id"])
    return copy.deepcopy(min(eligible, key=cost))


def _selection(root: Path, stage: str) -> dict:
    path = root / "selections" / f"{stage}.json"
    if not path.exists():
        raise ValueError(f"Complete the {stage} stage before its dependent experiment")
    value = json.loads(path.read_text())
    if runner.digest({k: v for k, v in value.items() if k != "hash"}) != value.get("hash"):
        raise ValueError("Validation selection checksum failed")
    plan = json.loads((root / "plan.json").read_text())
    if value.get("plan_hash") != plan["hash"]:
        raise ValueError("Validation selection belongs to a different study")
    return value["selected"]


def _sft_anchor(supervised: dict) -> dict:
    checkpoint = supervised.get("checkpoint", {})
    paths = {key: checkpoint.get(key) for key in ("training_path", "sampler_path")}
    if any(not isinstance(value, str) or not value.startswith("tinker://") for value in paths.values()):
        raise ValueError("The trace stage did not produce a trained SFT checkpoint")
    return paths


def stage_jobs(plan: dict, root: Path, stage: str) -> list[dict]:
    """Materialize a small adaptive matrix rather than a full Cartesian product."""
    base = copy.deepcopy(plan["base_config"])
    jobs = []
    def add(name, config, kind="sft", checkpoint=None):
        job = {"id": name, "stage": stage, "kind": kind, "config": copy.deepcopy(config)}
        job["config"]["output_dir"] = str(root / "jobs" / name)
        job["config"]["final_test"] = False
        if checkpoint is not None:
            job["checkpoint"] = checkpoint
        jobs.append(job)
    if stage == "baseline":
        for effort in plan["efforts"]:
            for style in plan["prompt_styles"]:
                add(f"base-e{_label(effort)}-{style}", {**base, "effort": effort, "prompt_style": style}, "evaluate")
        return jobs
    baseline = _selection(root, "baseline")
    base.update({key: baseline["config"][key] for key in ("effort", "prompt_style")})
    if stage == "learning-rate":
        for rate in plan["learning_rates"]:
            add(f"sft-lr{_label(rate)}", {**base, "sft_learning_rate": rate, "trace_format": "full", "rl_steps": 0})
        return jobs
    rate = _selection(root, "learning-rate")["config"]["sft_learning_rate"]
    base["sft_learning_rate"] = rate
    if stage == "trace":
        for trace in plan["trace_formats"]:
            add(f"sft-{trace}", {**base, "trace_format": trace, "rl_steps": 0})
        return jobs
    supervised = _selection(root, "trace")
    base.update({key: supervised["config"][key] for key in ("trace_format", "sft_learning_rate")})
    if stage == "rl-learning-rate":
        initial = _sft_anchor(supervised)
        for rate in plan["rl_learning_rates"]:
            add(f"rl-lr{_label(rate)}", {**base, "sft_epochs": 0, "initial_sft_checkpoint": initial,
                "rl_learning_rate": rate, "length_penalty": 0.0,
                "rl_objective": "correctness",
                "upstream_provenance": supervised["id"]}, "rl")
        return jobs
    base["rl_learning_rate"] = _selection(root, "rl-learning-rate")["config"]["rl_learning_rate"]
    if stage == "objective":
        initial = _sft_anchor(supervised)
        add("sft-control", {**base, "rl_steps": 0}, "reuse", supervised)
        for name, penalty in (("correctness-rl", 0.0), ("compression-rl", plan["base_config"]["length_penalty"])):
            add(name, {**base, "sft_epochs": 0, "initial_sft_checkpoint": initial,
                       "length_penalty": penalty, "rl_objective": "compression" if penalty else "correctness",
                       "upstream_provenance": supervised["id"]}, "rl")
        return jobs
    if stage == "repeat":
        winner = _selection(root, "objective")
        for seed in plan["training_seeds"]:
            config = {**winner["config"], "seed": seed, "initial_sft_checkpoint": None,
                      "sft_epochs": plan["base_config"]["sft_epochs"], "upstream_provenance": winner["id"]}
            add(f"repeat-seed{seed}", config, "run" if config["rl_steps"] else "sft")
        return jobs
    if stage != "final":
        raise ValueError("Unknown study stage")
    _selection(root, "repeat")  # Require repeat evidence before breaking the final seal.
    final_sources = [baseline, supervised]
    objective = json.loads((root / "selections/objective.json").read_text())
    final_sources += [row for row in objective["results"] if row["id"] != "sft-control"]
    repeats = json.loads((root / "selections/repeat.json").read_text())
    final_sources += repeats["results"]
    for source in final_sources:
        config = copy.deepcopy(source["config"])
        config["initial_sft_checkpoint"] = None
        add("test-" + source["id"], config, "test", source.get("checkpoint", {}).get("sampler_path"))
    # Explicit same-effort baseline if a future stage makes effort a training choice.
    repeat_config = _selection(root, "repeat")["config"]
    if any(repeat_config[key] != baseline["config"][key] for key in ("effort", "prompt_style")):
        add("test-base-matched", {**base, **{key: repeat_config[key] for key in ("effort", "prompt_style")}}, "test")
    for diagnostic in plan.get("diagnostic_datasets", []):
        winner = _selection(root, "repeat")
        config = {**winner["config"], "dataset": diagnostic["path"], "evaluation_manifest": None,
                  "holdout_fraction": 0, "validation_fraction": 0,
                  "evaluation_only": True, "diagnostic_only": True, "initial_sft_checkpoint": None}
        add("diagnostic-" + diagnostic["role"], config, "diagnostic", winner["checkpoint"]["sampler_path"])
    return jobs


def validate_result_evidence(result: dict, plan: dict) -> None:
    """Recompute saved summaries from complete, identity-bound real model records."""
    if result.get("backend") != "tinker" or result.get("plan_hash") != plan["hash"]:
        raise ValueError("Study evidence must come from the declared real Tinker plan")
    if result.get("kind") == "reuse":
        source = json.loads(Path(result["evidence_path"]).read_text())
        if runner.digest(source) != result.get("evidence_hash"):
            raise ValueError("Reused SFT evidence changed")
        validate_result_evidence(source, plan)
        if source["summary"] != result["summary"] or source["checkpoint"] != result["checkpoint"]:
            raise ValueError("Reused SFT summary/checkpoint differs from its source")
        return
    config = result["config"]
    output = Path(config["output_dir"])
    manifest = json.loads((output / "dataset-manifest.json").read_text())
    rows = runner.read_jsonl(output / "dataset.jsonl")
    if (runner.digest(rows) != manifest["dataset_hash"]
            or manifest.get("implementation_hash") != plan["implementation_hash"]
            or manifest.get("input_sha256") != _sha(Path(config["dataset"]))):
        raise ValueError("Job evidence dataset or implementation differs from the frozen study")
    split = result["split"]
    selection = json.loads((output / "evaluations" / f"selection-{split}.json").read_text())
    if runner.digest({k: v for k, v in selection.items() if k != "hash"}) != selection.get("hash"):
        raise ValueError("Evaluation population checksum failed")
    indexed = {row["id"]: row for row in rows if row["split"] == split}
    declared = config.get("evaluation_manifest")
    if isinstance(declared, str):
        declared = json.loads(Path(declared).read_text())
    declared = declared.get("splits", declared) if declared is not None else None
    expected_ids = declared[split] if declared is not None else sorted(indexed)
    if (selection.get("split") != split
            or selection.get("evaluation_seed") != config["evaluation_seed"]
            or selection.get("evaluation_samples") != config["evaluation_samples"]
            or selection.get("population_size") != len(indexed)
            or [item["id"] for item in selection["selected"]] != expected_ids):
        raise ValueError("Evaluation population differs from the frozen study selection")
    expected = {}
    for item in selection["selected"]:
        row = indexed.get(item["id"])
        if row is None or (item["task_hash"], item["source_hash"], item["family"], item.get("component")) != (
                runner.digest(row["task"]), row["sourceHash"], row["family"], row.get("split_component")):
            raise ValueError("Evaluation selection differs from its verified task")
        for repeat in range(config["evaluation_samples"]):
            expected[(row["id"], repeat)] = row
    stage = result.get("evidence_stage", result["id"])
    records = runner.read_jsonl(output / "evaluations" / f"{stage}-{split}.jsonl")
    actual = set()
    for record in records:
        key = (record["task_id"], record["repeat"])
        if key not in expected or key in actual:
            raise ValueError("Study evidence has extra or duplicate task attempts")
        row = expected[key]
        checks = {"backend": "tinker", "configuration_hash": runner.config_fingerprint(config),
            "implementation_hash": plan["implementation_hash"], "selection_hash": selection["hash"],
            "source_hash": row["sourceHash"], "task_hash": runner.digest(row["task"]),
            "family": row["family"], "split_component": row.get("split_component"),
            "sampling_checkpoint": result["checkpoint"].get("sampler_path"),
            "seed": int(runner.digest([config["evaluation_seed"], key[0], key[1]])[:8], 16) % 2147483647}
        if any(record.get(name) != value for name, value in checks.items()):
            raise ValueError("Study evaluation provenance differs from the declared plan/checkpoint")
        if sum(len(sample["token_ids"]) for sample in record["samples"]) != record["generated_tokens"]:
            raise ValueError("Study token cost differs from original sampled tokens")
        actual.add(key)
    if actual != set(expected) or not actual:
        raise ValueError("Study evidence is incomplete")
    if runner.summarize_records(records) != result["summary"]:
        raise ValueError("Study summary differs from original evaluation records")


def execute_job(repo: Path, plan: dict, root: Path, job: dict, *, resume=False) -> dict:
    output = Path(job["config"]["output_dir"])
    output.mkdir(parents=True, exist_ok=True)
    config_path = output / "job-config.json"
    identity = runner.digest(job)
    result_path = output / "job-result.json"
    if result_path.exists():
        saved = json.loads(result_path.read_text())
        if (saved.get("job_hash") != identity or saved.get("id") != job["id"]
                or saved.get("config") != job["config"] or saved.get("kind") != job["kind"]):
            raise ValueError("A completed job differs from its frozen specification")
        validate_result_evidence(saved, plan)
        return saved
    progress_path = output / "job-progress.json"
    if progress_path.exists():
        progress = json.loads(progress_path.read_text())
        if progress.get("job_hash") != identity:
            raise ValueError("Job specification changed after starting")
        if not resume:
            raise ValueError("Interrupted job requires explicit --resume; optimizer updates are never blindly repeated")
    runner.atomic_json(config_path, job["config"])
    if job["kind"] == "reuse":
        result = copy.deepcopy(job["checkpoint"])
        result.update({"id": job["id"], "config": job["config"], "job_hash": identity,
                       "reused_from": job["checkpoint"]["id"], "stage": job["stage"], "kind": "reuse",
                       "evidence_path": str(Path(job["checkpoint"]["config"]["output_dir"]) / "job-result.json"),
                       "evidence_hash": runner.digest(job["checkpoint"])})
        validate_result_evidence(result, plan)
        runner.atomic_json(result_path, result)
        return result
    evaluate = job["kind"] in {"evaluate", "test", "diagnostic"}
    split = "test" if job["kind"] in {"test", "diagnostic"} else "validation"
    command = [sys.executable, str(repo / "training/run.py"),
               "evaluate" if evaluate else job["kind"], "--repo", str(repo), "--config", str(config_path)]
    if evaluate:
        command += ["--split", split, "--stage", job["id"]]
        if job.get("checkpoint"):
            command += ["--checkpoint", job["checkpoint"]]
    if resume:
        command.append("--resume")
    runner.atomic_json(progress_path, {"job_hash": identity, "plan_hash": plan["hash"],
                                      "status": "running", "command": command})
    print(runner.json_text({"job": job["id"], "status": "running", "split": split}), flush=True)
    with (output / "stdout.log").open("a" if resume else "w") as stdout, \
            (output / "stderr.log").open("a" if resume else "w") as stderr:
        completed = subprocess.run(command, cwd=repo, stdout=stdout, stderr=stderr, check=False)
    if completed.returncode:
        runner.atomic_json(progress_path, {"job_hash": identity, "status": "interrupted_or_failed",
                                          "returncode": completed.returncode})
        raise RuntimeError(f"Study job {job['id']} failed; inspect {output / 'stderr.log'} before resuming")
    if evaluate:
        records = runner.read_jsonl(output / "evaluations" / f"{job['id']}-{split}.jsonl")
        if any(row.get("backend") != "tinker" for row in records):
            raise ValueError("Scripted evaluations cannot become study evidence")
        summary = runner.summarize_records(records)
        checkpoint = {"sampler_path": job.get("checkpoint")}
        evidence_stage = job["id"]
    else:
        state = json.loads((output / "state.json").read_text())
        chosen = state.get("selected_checkpoint")
        if not chosen or not chosen.get("summary"):
            raise ValueError("Training completed without a validation-selected checkpoint")
        summary = chosen["summary"]
        checkpoint = {key: chosen[key] for key in ("training_path", "sampler_path")}
        evidence_stage = chosen["stage"]
    result = {"id": job["id"], "stage": job["stage"], "job_hash": identity, "plan_hash": plan["hash"],
              "backend": "tinker", "split": split, "kind": job["kind"], "summary": summary,
              "checkpoint": checkpoint, "config": job["config"],
              "evidence_stage": evidence_stage,
              "diagnostic_only": job["kind"] == "diagnostic"}
    validate_result_evidence(result, plan)
    runner.atomic_json(result_path, result)
    runner.atomic_json(progress_path, {"job_hash": identity, "status": "completed"})
    print(runner.json_text({"job": job["id"], "status": "completed", "summary": summary}), flush=True)
    return result


def run_stage(repo: Path, plan_path: Path, stage: str, *, resume=False) -> dict:
    root = plan_path.parent
    plan = read_plan(plan_path, repo)
    if stage != "final" and (root / "test-seal.json").exists():
        raise ValueError("Final test was opened; further tuning requires a new study and a fresh held-out set")
    if stage != "baseline" and plan.get("require_learnability"):
        gate_path = root / "diagnostics/learnability.json"
        if not gate_path.exists():
            raise ValueError("Run the prepared learnability diagnostic before training the full corpus")
        gate = json.loads(gate_path.read_text())
        if (gate.get("status") != "completed" or gate.get("backend") != "tinker"
                or not gate.get("learnability_target_met")
                or gate.get("implementation_hash") != plan["implementation_hash"]
                or gate.get("source_input_sha256") != plan["dataset"]["sha256"]
                or gate.get("model") != plan["base_config"]["model"]):
            raise ValueError("The live learnability gate has not passed for this implementation")
        baseline = _selection(root, "baseline")
        if any(gate.get(key) != baseline["config"][key] for key in ("effort", "prompt_style")):
            raise ValueError("Learnability effort/prompt differ from the selected baseline")
    jobs = stage_jobs(plan, root, stage)
    # Fail early on authentication without sealing tests or marking an update pending.
    TinkerAdapter(plan["base_config"]).check(remote=True)
    if stage == "final":
        seal = _signed({"plan_hash": plan["hash"], "jobs": jobs})
        seal_path = root / "test-seal.json"
        if seal_path.exists() and json.loads(seal_path.read_text()) != seal:
            raise ValueError("Final-test choices changed after sealing")
        runner.atomic_json(seal_path, seal)
    results = [execute_job(repo, plan, root, job, resume=resume) for job in jobs]
    # Repeated seeds quantify variation; picking the luckiest seed would hide it.
    selected = (None if stage == "final" else results[0] if stage == "repeat"
                else choose_job(results, plan["acceptance"]["accuracy_tolerance"]))
    stage_result = _signed({"stage": stage, "plan_hash": plan["hash"], "results": results,
                    "selection_rule": "first predeclared seed; all seeds reported" if stage == "repeat" else plan["selection_rule"],
                    "selected": selected})
    runner.atomic_json(root / "selections" / f"{stage}.json", stage_result)
    return stage_result


def study_report(plan_path: Path) -> dict:
    root = plan_path.parent
    plan = read_plan(plan_path, Path(json.loads(plan_path.read_text())["repo"]), check_code=False)
    stages = {stage: json.loads(path.read_text()) for stage in STAGES
              if (path := root / "selections" / f"{stage}.json").exists()}
    for stage in stages.values():
        if (stage.get("plan_hash") != plan["hash"]
                or runner.digest({k: v for k, v in stage.items() if k != "hash"}) != stage.get("hash")):
            raise ValueError("Study result identity or checksum failed")
        for result in stage["results"]:
            validate_result_evidence(result, plan)
    report = {"plan_hash": plan["hash"], "dataset": plan["dataset"], "acceptance": plan["acceptance"],
              "stages": stages, "test_sealed": (root / "test-seal.json").exists(),
              "model_results_available": bool(stages),
              "claims": "No model-performance claim without real evaluation records; diagnostics remain separate."}
    comparisons = {}
    final = stages.get("final", {}).get("results", [])
    baselines = [row for row in final if row["kind"] == "test" and not row["checkpoint"].get("sampler_path")]
    for baseline in baselines:
        first = runner.read_jsonl(Path(baseline["config"]["output_dir"]) / "evaluations" / f"{baseline['id']}-test.jsonl")
        for candidate in final:
            if candidate["kind"] != "test" or not candidate["checkpoint"].get("sampler_path"):
                continue
            second = runner.read_jsonl(Path(candidate["config"]["output_dir"]) / "evaluations" / f"{candidate['id']}-test.jsonl")
            if any(row.get("backend") != "tinker" for row in first + second):
                raise ValueError("Scripted records cannot become final study comparisons")
            comparison = runner.paired_statistics(first, second, plan["base_config"])
            comparison["same_effort_and_prompt"] = all(baseline["config"][key] == candidate["config"][key]
                                                       for key in ("effort", "prompt_style"))
            comparisons[f"{baseline['id']} -> {candidate['id']}"] = comparison
    report["paired_final_comparisons"] = comparisons
    repeated = [row for row in final if row["id"].startswith("test-repeat-")]
    if repeated:
        accuracies = [row["summary"]["complete_execution_accuracy"] for row in repeated]
        report["training_seed_variation"] = {"seeds": [row["config"]["seed"] for row in repeated],
            "accuracy_mean": statistics.fmean(accuracies),
            "accuracy_std": statistics.stdev(accuracies) if len(accuracies) > 1 else None,
            "all_seeds_reported": len(repeated) == len(plan["training_seeds"])}
    lines = ["# JavaScript execution study", "", f"Plan: `{plan['hash']}`", "",
             "| Stage | Job | Model | Split | Complete accuracy | Tokens per verified success |", "| --- | --- | --- | --- | --- | --- |"]
    for stage in stages.values():
        for row in stage["results"]:
            s = row["summary"]
            cost = s.get("tokens_per_verified_success")
            if cost is None and s.get("successes", 0):
                cost = s["all_generated_tokens"] / s["successes"]
            model_kind = "trained" if row["checkpoint"].get("sampler_path") else "base"
            lines.append(f"| {stage['stage']} | {row['id']} | {model_kind} | {row['split']} | {s['complete_execution_accuracy']:.2%} | {cost if cost is not None else 'undefined (no successes)'} |")
    if not stages:
        lines += ["", "Plan prepared; no live model results exist."]
    if comparisons:
        lines += ["", "## Paired final comparisons", "",
                  "| Comparison | Accuracy change | Tokens per success saving | Evidence status |",
                  "| --- | --- | --- | --- |"]
        for name, comparison in comparisons.items():
            saving = comparison["tokens_per_verified_success_saving"]
            lines.append(f"| {name} | {comparison['accuracy_change']:+.2%} | {saving if saving is not None else 'undefined'} | {comparison['acceptance']['status']} |")
    lines += ["", "Settings and checkpoints are selected on validation only. Familiar-input and challenge results are separately labeled diagnostics.",
              "A repeated run can retain the base model when training did not improve validation; the Model column identifies that outcome.",
              "Repeated training seeds keep the same source splits and evaluation seed. A family-level confidence interval does not replace training-seed variation.", ""]
    runner.atomic_json(root / "study-report.json", report)
    (root / "study-report.md").write_text("\n".join(lines))
    return report


def tiny_examples(rows: list[dict], count: int = 12) -> list[dict]:
    if not 8 <= count <= 16:
        raise ValueError("Learnability diagnostic must use between 8 and 16 examples")
    available = [row for row in rows if row["split"] == "train"
                 and not row.get("metadata", {}).get("diagnosticOnly")]
    available.sort(key=lambda row: (row.get("metadata", {}).get("tier", 0), row["id"]))
    selected, families = [], set()
    # Ensure the live external-observation protocol is exercised when available.
    effectful = next((row for row in available if row.get("metadata", {}).get("externalCalls", 0)), None)
    if effectful:
        selected.append(effectful)
        families.add(effectful["family"])
    for unique in (True, False):
        for row in available:
            if len(selected) == count:
                return selected
            if row not in selected and (not unique or row["family"] not in families):
                selected.append(row)
                families.add(row["family"])
    if len(selected) < 8:
        raise ValueError("The corpus has fewer than eight available training examples")
    return selected


def live_diagnostic(repo: Path, config: dict, output: Path, *, live=False, learnability=False,
                    examples=12, updates=25, evaluate_every=5, target_accuracy=0.95) -> dict:
    """Prepare locally; execute small, explicitly labeled diagnostics with --live."""
    if updates < 1 or evaluate_every < 1 or not 0 < target_accuracy <= 1:
        raise ValueError("Invalid learnability update budget or target accuracy")
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / ("learnability.json" if learnability else "contract-probe.json")
    if report_path.exists():
        previous = json.loads(report_path.read_text())
        if previous.get("optimizer_updates", 0) or previous.get("update_pending") or previous.get("model_sampled"):
            raise ValueError("This diagnostic already sampled or submitted model work; preserve it and choose a new output directory (a new study for plan-bound diagnostics)")
    with runner.Bridge(repo, config["bridge_timeout_seconds"]) as bridge:
        rows, manifest = runner.export_dataset(repo, config, output / "preparation", bridge)
        tiny = tiny_examples(rows, examples)
        adapter = TinkerAdapter(config)
        adapter.check(remote=False)
        budgets = runner.validate_token_budgets(bridge, adapter, tiny, config)
        report = {"kind": "training_set_learnability" if learnability else "tinker_contract_probe",
            "backend": "tinker" if live else "offline_preparation", "model_sampled": False,
            "optimizer_updates": 0, "generalization_evidence": False,
            "implementation_hash": manifest["implementation_hash"], "dataset_hash": manifest["dataset_hash"],
            "source_input_sha256": manifest["input_sha256"], "model": config["model"],
            "effort": config["effort"], "prompt_style": config.get("prompt_style", "standard"),
            "config_hash": runner.config_fingerprint(config), "task_ids": [row["id"] for row in tiny],
            "token_budgets": budgets, "target_accuracy": target_accuracy,
            "status": "prepared", "update_pending": False}
        runner.write_jsonl(output / "learnability-examples.jsonl", tiny)
        runner.atomic_json(report_path, report)
        if not live:
            return report
        try:
            adapter.check(remote=True)
            adapter.create_training_client()
            adapter.refresh_sampler()
            report["before"] = adapter.score_supervision(tiny)
            sample = runner.rollout(bridge, adapter, tiny[0]["task"], config, config.get("evaluation_seed", 17))
            report["model_sampled"] = True
            runner.atomic_json(output / "contract-sample.json", sample)
            for turn in sample["samples"]:
                arrays = rl_token_arrays(turn, 0.0)
                scored = adapter.score_sample(turn)
                if len(scored) != len(turn["token_ids"]) or len(arrays["target_tokens"]) != len(arrays["advantages"]):
                    raise ValueError("Live sampled-token provenance is misaligned")
            report["sampled_contract"] = {"turns": len(sample["samples"]),
                "generated_tokens": sample["generated_tokens"], "execution_grade": sample["grade"],
                "original_prompt_tokens_verified": True, "logprob_alignment_verified": True}
            report["evaluations"] = []
            diagnostic_config = {**config, "max_eval_tasks": None, "evaluation_manifest": None,
                                 "evaluation_samples": max(2, config["evaluation_samples"])}
            count = updates if learnability else 1
            for step in range(1, count + 1):
                report["update_pending"] = True
                runner.atomic_json(report_path, report)
                result = adapter.sft_train(tiny, learning_rate=config.get("sft_learning_rate", config["learning_rate"]))
                report["optimizer_updates"] = step
                report["last_update"] = result
                report["update_pending"] = False
                report["checkpoint"] = adapter.checkpoint(f"diagnostic-{step:04d}")
                runner.atomic_json(report_path, report)
                if learnability and (step % evaluate_every == 0 or step == count):
                    adapter.refresh_sampler()
                    stage = f"learnability-{step:04d}"
                    runner.evaluate(bridge, adapter, tiny, diagnostic_config, output, stage, "train",
                                    checkpoint=report["checkpoint"]["sampler_path"])
                    records = runner.read_jsonl(output / "evaluations" / f"{stage}-train.jsonl")
                    summary = runner.summarize_records(records)
                    report["evaluations"].append({"step": step, "summary": summary,
                                                  "checkpoint": report["checkpoint"]})
                    if summary["complete_execution_accuracy"] >= target_accuracy:
                        break
            report["after"] = adapter.score_supervision(tiny)
            improvement = report["after"]["mean_example_target_logprob"] - report["before"]["mean_example_target_logprob"]
            report["target_logprob_improvement"] = improvement
            report["observed_positive_update"] = improvement > 0
            report["learnability_target_met"] = bool(report["evaluations"] and
                report["evaluations"][-1]["summary"]["complete_execution_accuracy"] >= target_accuracy)
            report["status"] = "completed"
        except Exception as error:
            report["status"] = "blocked_or_failed"
            report["error"] = f"{type(error).__name__}: {error}"
            runner.atomic_json(report_path, report)
            raise
        runner.atomic_json(report_path, report)
        return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "run", "report", "probe", "learnability"))
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--config", type=Path, default=Path("training/configs/inkling-mini.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("runs/tinker-study"))
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--stage", choices=(*STAGES, "all"), default="baseline")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--live", action="store_true", help="Execute model compute for probe/learnability; default only prepares")
    parser.add_argument("--efforts", default=",".join(map(str, DEFAULT_EFFORTS)))
    parser.add_argument("--rates", default=",".join(map(str, DEFAULT_RATES)))
    parser.add_argument("--rl-rates", default=",".join(map(str, DEFAULT_RL_RATES)))
    parser.add_argument("--seeds", default=",".join(map(str, DEFAULT_SEEDS)))
    parser.add_argument("--diagnostic-dataset", action="append", default=[], metavar="ROLE=PATH")
    parser.add_argument("--examples", type=int, default=12)
    parser.add_argument("--updates", type=int, default=25)
    parser.add_argument("--evaluate-every", type=int, default=5)
    parser.add_argument("--target-accuracy", type=float, default=0.95)
    args = parser.parse_args(argv)
    try:
        repo = args.repo.resolve()
        output = _absolute(repo, args.output_dir)
        plan_path = _absolute(repo, args.plan) if args.plan else output / "plan.json"
        if args.command == "report":
            result = study_report(plan_path)
        elif args.command == "run":
            for stage in STAGES if args.stage == "all" else [args.stage]:
                if args.stage == "all" and stage == "learning-rate":
                    plan = read_plan(plan_path, repo)
                    gate_path = plan_path.parent / "diagnostics/learnability.json"
                    previous_gate = json.loads(gate_path.read_text()) if gate_path.exists() else {}
                    if not any(previous_gate.get(key) for key in ("optimizer_updates", "update_pending", "model_sampled")):
                        baseline = _selection(plan_path.parent, "baseline")
                        diagnostic_config = {**plan["base_config"], **{
                            key: baseline["config"][key] for key in ("effort", "prompt_style")}}
                        live_diagnostic(repo, diagnostic_config, plan_path.parent / "diagnostics", live=True,
                            learnability=True, examples=args.examples, updates=args.updates,
                            evaluate_every=args.evaluate_every, target_accuracy=args.target_accuracy)
                run_stage(repo, plan_path, stage, resume=args.resume)
            result = study_report(plan_path)
        else:
            if args.plan and args.command in {"probe", "learnability"}:
                plan = read_plan(plan_path, repo)
                baseline = _selection(plan_path.parent, "baseline")
                config = {**plan["base_config"], **{key: baseline["config"][key]
                          for key in ("effort", "prompt_style")}}
                output = plan_path.parent / "diagnostics"
            else:
                config = runner.load_config(_absolute(repo, args.config))
            if args.command == "plan":
                diagnostics = dict(item.split("=", 1) for item in args.diagnostic_dataset)
                result = create_plan(repo, config, output, efforts=[float(x) for x in args.efforts.split(',')],
                    rates=[float(x) for x in args.rates.split(',')], rl_rates=[float(x) for x in args.rl_rates.split(',')],
                    seeds=[int(x) for x in args.seeds.split(',')],
                    diagnostic_datasets=diagnostics)
                study_report(output / "plan.json")
            else:
                result = live_diagnostic(repo, config, output, live=args.live,
                    learnability=args.command == "learnability", examples=args.examples, updates=args.updates,
                    evaluate_every=args.evaluate_every, target_accuracy=args.target_accuracy)
        print(runner.json_text(result))
        if args.live and args.command == "learnability" and not result["learnability_target_met"]:
            return 2
        if args.live and args.command == "probe" and not result["observed_positive_update"]:
            return 2
        return 0
    except Exception as error:
        print(f"tinker-study: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
