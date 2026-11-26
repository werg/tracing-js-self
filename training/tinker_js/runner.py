"""CPU environment orchestration; model compute is delegated to Tinker.

The environment owns teacher state. Only ``start.messages`` and observations
returned by ``step`` may enter a sampled conversation. Sampled token IDs and
log probabilities are saved verbatim and handed unchanged to the RL adapter.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import selectors
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from .learning import (choose_validation_checkpoint, compression_coefficient, curriculum_pick,
                       execution_advantages, likelihood_advantages, sft_epoch_rows, task_metadata, update_curriculum)
from .metrics import paired_statistics, summarize_records


DEFAULTS: dict[str, Any] = {
    "model": "thinkingmachines/Inkling-2-Mini:peft:65536:free",
    "seed": 17,
    "split_seed": 17,
    "evaluation_seed": 17,
    "effort": 0.5,
    "max_context_tokens": 65536,
    "max_tokens": 2048,
    "temperature": 1.0,
    "learning_rate": 1e-4,
    "sft_learning_rate": 1e-4,
    "rl_learning_rate": 1e-5,
    "sft_weighting": "example",
    "rl_loss_fn": "importance_sampling",
    "rl_loss_fn_config": {},
    "reference_kl_coef": 0.0,
    "reference_kl_clip": 20.0,
    "lora_rank": 32,
    "dataset": "training/fixtures/executor.jsonl",
    "output_dir": "runs/tinker-mini",
    "holdout_fraction": 0.2,
    "validation_fraction": 0.2,
    "sft_epochs": 1,
    "batch_size": 2,
    "rl_steps": 1,
    "group_size": 4,
    "max_turns": 8,
    "max_generated_tokens": 8192,
    "evaluation_samples": 1,
    "max_eval_tasks": None,
    "evaluation_manifest": None,
    "checkpoint_every": 1,
    "length_penalty": 0.25,
    "length_scale_tokens": 2048,
    "advantage_mode": "decoupled",
    "rl_objective": "likelihood",
    "target_anchor_weight": 0.25,
    "compression_warmup_steps": 0,
    "compression_ramp_steps": 4,
    "compression_min_accuracy": 0.5,
    "validation_every": 25,
    "accuracy_tolerance": 0.02,
    "min_token_saving": 0.1,
    "bootstrap_samples": 1000,
    "confidence_level": 0.95,
    "minimum_evaluation_families": 30,
    "final_test": True,
    "evaluation_only": False,
    "diagnostic_only": False,
    "initial_sft_checkpoint": None,
    "trace_format": "full",
    "reasoning_channel": "auto",
    "prompt_style": "standard",
    "rl_prompts_per_step": 1,
    "rl_token_normalization": "none",
    "rollout_concurrency": 1,
    "lr_schedule": "constant",
    "lr_warmup_fraction": 0.0,
    "lr_min_ratio": 0.1,
    "checkpoint_every_update": True,
    "recovery_checkpoint_ttl_seconds": 86400,
    "enforce_turn_budget": False,
    "curriculum": {"enabled": False, "retention_fraction": 0.25, "groups_per_tier": 20,
                   "window_groups": 20, "minimum_groups": 4, "advance_success_rate": 0.25},
    "bridge_timeout_seconds": 60,
}


def resolve_reasoning_channel(config: dict) -> str:
    channel = config.get("reasoning_channel", "auto")
    if channel == "auto":
        return "thinking" if config.get("effort", 0.5) > 0 else "text"
    return channel


def scheduled_learning_rate(base_lr: float, step_index: int, total_steps: int, config: dict) -> float:
    """Optional linear warmup + cosine/linear decay; constant by default."""
    schedule = config.get("lr_schedule", "constant")
    if schedule == "constant" or total_steps <= 1:
        return base_lr
    min_lr = base_lr * config.get("lr_min_ratio", 0.1)
    warmup_steps = int(round(total_steps * config.get("lr_warmup_fraction", 0.0)))
    step = max(0, min(step_index, total_steps - 1))
    if warmup_steps > 0 and step < warmup_steps:
        return min_lr + (base_lr - min_lr) * ((step + 1) / warmup_steps)
    decay_steps = max(1, total_steps - warmup_steps - 1)
    progress = min(1.0, max(0.0, (step - warmup_steps) / decay_steps))
    if schedule == "linear":
        return base_lr - (base_lr - min_lr) * progress
    return min_lr + 0.5 * (base_lr - min_lr) * (1.0 + math.cos(math.pi * progress))


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def json_preserve_order(value: Any) -> str:
    """Serialize JSON preserving JS own-property insertion order."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(json_text(value).encode()).hexdigest()


def implementation_identity(repo: Path) -> dict:
    """Bind experiments to Tinker-relevant executable sources and locked dependencies.

    Scoped to the runtime, host boundary, Tinker JS modules, and Python trainer
    so unrelated documentation or legacy repo cleanups do not invalidate studies.
    """
    paths: set[Path] = set()
    paths.update((repo / "training/tinker_js").glob("*.py"))
    paths.update((repo / "src/training").glob("tinker-*.js"))
    paths.update((repo / "src/host").glob("*.js"))
    for relative in (
        "tools/tinker-execution.mjs",
        "src/runtime.js",
        "src/frontend.js",
        "src/values.js",
        "src/typescript.js",
        "src/semantic/normalize.js",
        "src/semantic/source-reference.js",
        "src/training/fixture-broker.js",
        "src/training/graph.js",
        "src/training/data-graph-contract.js",
        "src/training/profile.js",
        "package-lock.json",
        "training/uv.lock",
    ):
        path = repo / relative
        if path.is_file():
            paths.add(path)
    entries = [(str(path.relative_to(repo)), hashlib.sha256(path.read_bytes()).hexdigest())
               for path in sorted(paths)]
    try:
        revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True,
                                  text=True, timeout=10, check=False)
        commit = revision.stdout.strip() if revision.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        commit = None
    return {"hash": digest(entries), "files": len(entries), "git_revision": commit}


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    _sync_directory(path.parent)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as handle:
        for row in rows:
            handle.write(json_preserve_order(row) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    _sync_directory(path.parent)


def append_jsonl(path: Path, row: dict, *, durable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json_preserve_order(row) + "\n")
        handle.flush()
        if durable:
            os.fsync(handle.fileno())
    if durable:
        _sync_directory(path.parent)


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {error}") from error
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            rows.append(row)
    return rows


def load_config(path: Path | None = None, overrides: dict | None = None) -> dict:
    config = copy.deepcopy(DEFAULTS)
    if path:
        supplied = json.loads(path.read_text())
        if not isinstance(supplied, dict):
            raise ValueError("experiment config must be an object")
        config.update(supplied)
    config.update({key: value for key, value in (overrides or {}).items() if value is not None})
    for name in ("seed", "split_seed", "evaluation_seed"):
        if (isinstance(config[name], bool) or not isinstance(config[name], int)
                or not 0 <= config[name] < 2147483648):
            raise ValueError(f"{name} must be an integer in [0, 2**31)")
    if not isinstance(config["final_test"], bool):
        raise ValueError("final_test must be a boolean")
    for name in ("evaluation_only", "diagnostic_only"):
        if not isinstance(config[name], bool):
            raise ValueError(f"{name} must be a boolean")
    if config["diagnostic_only"]:
        config["evaluation_only"] = True
        if config["holdout_fraction"] != 0 or config["validation_fraction"] != 0:
            raise ValueError("diagnostic_only datasets require zero holdout_fraction and validation_fraction and explicit test splits")
    initial = config["initial_sft_checkpoint"]
    if initial is not None:
        if (not isinstance(initial, dict) or set(initial) != {"training_path", "sampler_path"}
                or any(not isinstance(value, str) or not value.startswith("tinker://") or len(value) <= 9 for value in initial.values())):
            raise ValueError("initial_sft_checkpoint requires Tinker training_path and sampler_path")
    for name in ("max_context_tokens", "max_tokens", "batch_size", "group_size", "max_turns",
                 "max_generated_tokens", "evaluation_samples", "checkpoint_every", "length_scale_tokens",
                 "bootstrap_samples", "minimum_evaluation_families", "rl_prompts_per_step",
                 "rollout_concurrency", "recovery_checkpoint_ttl_seconds"):
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    for name in ("checkpoint_every_update", "enforce_turn_budget"):
        if not isinstance(config[name], bool):
            raise ValueError(f"{name} must be a boolean")
    for name in ("sft_epochs", "rl_steps", "validation_every", "compression_warmup_steps", "compression_ramp_steps"):
        if isinstance(config[name], bool) or not isinstance(config[name], int) or config[name] < 0:
            raise ValueError(f"{name} must be a nonnegative integer")
    if config["group_size"] < 2:
        raise ValueError("group_size must be at least two for group-relative RL")
    maximum = config["max_eval_tasks"]
    if maximum is not None and (isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0):
        raise ValueError("max_eval_tasks must be null for the full split or a positive integer")
    for name in ("holdout_fraction", "validation_fraction"):
        if not 0 <= config[name] < 1:
            raise ValueError(f"{name} must be in [0, 1)")
    if config["holdout_fraction"] + config["validation_fraction"] >= 1:
        raise ValueError("held-out fractions must leave training families")
    if not 0 <= config["length_penalty"] < 1:
        raise ValueError("length_penalty must be in [0, 1), so every verified success beats failure")
    for name in ("learning_rate", "sft_learning_rate", "rl_learning_rate", "reference_kl_clip", "bridge_timeout_seconds"):
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be finite and positive")
    if (isinstance(config["reference_kl_coef"], bool) or not isinstance(config["reference_kl_coef"], (int, float))
            or not math.isfinite(config["reference_kl_coef"]) or config["reference_kl_coef"] < 0):
        raise ValueError("reference_kl_coef must be finite and nonnegative")
    if (isinstance(config["target_anchor_weight"], bool) or not isinstance(config["target_anchor_weight"], (int, float))
            or not math.isfinite(config["target_anchor_weight"]) or config["target_anchor_weight"] < 0):
        raise ValueError("target_anchor_weight must be finite and nonnegative")
    for name in ("accuracy_tolerance", "min_token_saving", "compression_min_accuracy"):
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"{name} must be finite in [0, 1]")
    if not isinstance(config["confidence_level"], (int, float)) or not 0 < config["confidence_level"] < 1:
        raise ValueError("confidence_level must be in (0, 1)")
    for name, choices in (("advantage_mode", {"decoupled", "centered"}),
                          ("rl_objective", {"likelihood", "compression", "correctness"}),
                          ("sft_weighting", {"example", "token"}),
                          ("rl_loss_fn", {"importance_sampling", "ppo"}),
                          ("trace_format", {"full", "compact", "actions-only"}),
                          ("reasoning_channel", {"auto", "thinking", "text"}),
                          ("rl_token_normalization", {"none", "trajectory"}),
                          ("lr_schedule", {"constant", "cosine", "linear"}),
                          ("prompt_style", {"standard", "concise"})):
        if config[name] not in choices:
            raise ValueError(f"{name} must be one of {sorted(choices)}")
    if (isinstance(config["lr_warmup_fraction"], bool) or not isinstance(config["lr_warmup_fraction"], (int, float))
            or not math.isfinite(config["lr_warmup_fraction"]) or not 0 <= config["lr_warmup_fraction"] <= 0.5):
        raise ValueError("lr_warmup_fraction must be finite in [0, 0.5]")
    if (isinstance(config["lr_min_ratio"], bool) or not isinstance(config["lr_min_ratio"], (int, float))
            or not math.isfinite(config["lr_min_ratio"]) or not 0 < config["lr_min_ratio"] <= 1):
        raise ValueError("lr_min_ratio must be finite in (0, 1]")
    loss_config = config["rl_loss_fn_config"]
    if (not isinstance(loss_config, dict)
            or any(not isinstance(key, str) or isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) or value <= 0 for key, value in loss_config.items())):
        raise ValueError("rl_loss_fn_config must map names to finite positive numbers")
    if config["rl_loss_fn"] == "importance_sampling" and loss_config:
        raise ValueError("importance_sampling does not accept PPO clipping configuration")
    if config["rl_loss_fn"] == "ppo" and set(loss_config) - {"clip_low_threshold", "clip_high_threshold"}:
        raise ValueError("PPO supports clip_low_threshold and clip_high_threshold")
    if loss_config.get("clip_low_threshold", 0.8) >= 1 or loss_config.get("clip_high_threshold", 1.2) <= 1:
        raise ValueError("PPO clipping thresholds must bracket one")
    if config["evaluation_manifest"] is not None and not isinstance(config["evaluation_manifest"], (str, dict)):
        raise ValueError("evaluation_manifest must be a path or a split-to-IDs object")
    curriculum = config["curriculum"]
    if not isinstance(curriculum, dict) or not isinstance(curriculum.get("enabled", False), bool):
        raise ValueError("curriculum must be an object with boolean enabled")
    curriculum = {**DEFAULTS["curriculum"], **curriculum}
    for name in ("groups_per_tier", "window_groups", "minimum_groups"):
        value = curriculum[name]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"curriculum.{name} must be a positive integer")
    if curriculum["minimum_groups"] > curriculum["window_groups"]:
        raise ValueError("curriculum.minimum_groups exceeds its history window")
    for name, upper in (("retention_fraction", .9), ("advance_success_rate", 1.0)):
        value = curriculum[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= upper:
            raise ValueError(f"curriculum.{name} must be finite in [0, {upper}]")
    config["curriculum"] = curriculum
    if not 0 <= config["effort"] < 1:
        raise ValueError("effort must be in [0, 1)")
    if config["bridge_timeout_seconds"] <= 0:
        raise ValueError("bridge_timeout_seconds must be positive")
    return config


class BridgeError(RuntimeError):
    pass


class RolloutError(BridgeError):
    """Infrastructure failure with every sample already received attached."""

    def __init__(self, message: str, record: dict):
        super().__init__(message)
        self.record = record


class Bridge:
    """One owned Node process, with bounded waits and no shell interpolation."""

    def __init__(self, repo: Path, timeout: float = 60):
        self.repo = Path(repo).resolve()
        self.timeout = timeout
        self._sequence = 0
        self._buffer = b""
        self._lock = threading.Lock()
        self._stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            ["node", str(self.repo / "tools/tinker-execution.mjs")], cwd=self.repo,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
        )
        self._selector = selectors.DefaultSelector()
        self._selector.register(self.process.stdout, selectors.EVENT_READ)

    def request(self, op: str, **payload: Any) -> dict:
        with self._lock:
            self._sequence += 1
            request = {"id": self._sequence, "op": op, **payload}
            assert self.process.stdin is not None
            try:
                self.process.stdin.write((json_preserve_order(request) + "\n").encode())
                self.process.stdin.flush()
            except BrokenPipeError as error:
                raise BridgeError("JS environment exited before accepting a request") from error
            deadline = time.monotonic() + self.timeout
            while b"\n" not in self._buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._selector.select(remaining):
                    raise BridgeError(f"JS environment exceeded {self.timeout:g}s for {op}")
                data = os.read(self.process.stdout.fileno(), 65536)
                if not data:
                    self._stderr.seek(0)
                    detail = self._stderr.read().decode(errors="replace")[-2000:]
                    raise BridgeError(f"JS environment exited during {op}: {detail}")
                self._buffer += data
                if len(self._buffer) > 128 * 1024 * 1024:
                    raise BridgeError("JS environment response exceeded 128 MiB")
            line, self._buffer = self._buffer.split(b"\n", 1)
            try:
                response = json.loads(line)
            except ValueError as error:
                raise BridgeError("JS environment emitted non-JSON stdout") from error
            if response.get("id") != self._sequence:
                raise BridgeError("JS environment response ID mismatch")
            if not response.get("ok"):
                raise BridgeError(f"JS environment {op} failed: {response.get('error', 'unknown error')}")
            return response["result"]

    def close(self) -> None:
        with self._lock:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            self._selector.close()
            if self.process.stdout:
                self.process.stdout.close()
            self._stderr.close()

    def __enter__(self) -> Bridge:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def split_examples(rows: list[dict], seed: int, holdout_fraction: float,
                   validation_fraction: float, *, evaluation_only: bool = False) -> tuple[list[dict], dict]:
    """Split connected components of family, lineage and source identity.

    Ancestors share the family namespace, so descendants also connect to rows
    whose family names an ancestor. Source copies and lineage chains merge
    transitively rather than being assigned independent held-out splits.
    """
    if not rows:
        raise ValueError("cannot split an empty dataset")
    parents = list(range(len(rows)))

    def find(i: int) -> int:
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    seen: dict[tuple[str, str], int] = {}
    ids: set[str] = set()
    lineage: dict[int, set[str]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row.get("id"), str) or not row["id"] or row["id"] in ids:
            raise ValueError("each exported task requires a unique nonempty string id")
        ids.add(row["id"])
        for field in ("family", "sourceHash"):
            if not isinstance(row.get(field), str) or not row[field]:
                raise ValueError(f"task {row['id']} requires {field}")
        additional_sources = row.get("sourceHashes", [])
        if (not isinstance(additional_sources, list)
                or any(not isinstance(source, str) or not source for source in additional_sources)):
            raise ValueError(f"task {row['id']} sourceHashes must be a list of nonempty strings")
        task = row.get("task", {})
        if not isinstance(task, dict):
            raise ValueError(f"task {row['id']} task must be an object")
        metadata = task_metadata(row)
        ancestors = set()
        for declared in (row.get("ancestors", []), task.get("ancestors", []), metadata.get("lineage", [])):
            if (not isinstance(declared, list) or len(declared) > 256
                    or any(not isinstance(name, str) or not name.strip() or len(name) > 1024
                           for name in declared)):
                raise ValueError(f"task {row['id']} ancestors must contain at most 256 nonempty strings of at most 1024 characters")
            ancestors.update(declared)
        if len(ancestors) > 256:
            raise ValueError(f"task {row['id']} has more than 256 combined ancestors")
        lineage[index] = ancestors
        identities = [("family", name) for name in {row["family"], *ancestors}] + [("sourceHash", source)
                       for source in {row["sourceHash"], *additional_sources}]
        template = metadata.get("template")
        if template is not None:
            if not isinstance(template, str) or not template.strip() or len(template) > 1024:
                raise ValueError("metadata.template must be a nonempty string of at most 1024 characters")
            identities.append(("template", template))
        for key in identities:
            if key in seen:
                parents[find(index)] = find(seen[key])
            else:
                seen[key] = index
    groups: dict[int, list[int]] = {}
    for index in range(len(rows)):
        groups.setdefault(find(index), []).append(index)
    components = sorted(groups.values(), key=lambda indexes: min(rows[i]["id"] for i in indexes))
    random.Random(seed).shuffle(components)
    explicit: dict[int, str] = {}
    for component_index, indexes in enumerate(components):
        choices = {rows[i].get("split", rows[i].get("task", {}).get("split")) for i in indexes}
        choices.discard(None)
        if choices - {"train", "validation", "test"}:
            raise ValueError("explicit split must be train, validation, or test")
        if len(choices) > 1:
            raise ValueError("contradictory explicit splits in the same family/source component")
        if choices:
            explicit[component_index] = choices.pop()
    count = len(components)
    targets = {
        "test": max(1, round(count * holdout_fraction)) if holdout_fraction else 0,
        "validation": max(1, round(count * validation_fraction)) if validation_fraction else 0,
    }
    if sum(targets.values()) >= count:
        raise ValueError("not enough independent source families for nonempty train/held-out splits")
    assignments = dict(explicit)
    unassigned = [i for i in range(count) if i not in assignments]
    for split in ("test", "validation"):
        missing = max(0, targets[split] - sum(value == split for value in assignments.values()))
        for _ in range(missing):
            if not unassigned:
                raise ValueError("explicit splits leave no families for required held-out split")
            assignments[unassigned.pop(0)] = split
    assignments.update({i: "train" for i in unassigned})
    if not evaluation_only and "train" not in assignments.values():
        raise ValueError("explicit splits leave no training families")
    output = [copy.deepcopy(row) for row in rows]
    manifest_groups = []
    for component_index, indexes in enumerate(components):
        split = assignments[component_index]
        members = sorted(rows[i]["id"] for i in indexes)
        component = digest(members)
        for index in indexes:
            output[index]["split"] = split
            output[index]["split_component"] = component
        manifest_groups.append({"split": split, "ids": members, "component": component,
                                "families": sorted({rows[i]["family"] for i in indexes}),
                                "templates": sorted({task_metadata(rows[i])["template"] for i in indexes
                                                     if task_metadata(rows[i]).get("template")}),
                                "ancestor_families": sorted({name for i in indexes for name in lineage[i]}),
                                "source_hashes": sorted({source for i in indexes
                                    for source in [rows[i]["sourceHash"], *rows[i].get("sourceHashes", [])]})})
    manifest = {"seed": seed, "holdout_fraction": holdout_fraction, "evaluation_only": evaluation_only,
                "validation_fraction": validation_fraction,
                "components": sorted(manifest_groups, key=lambda group: group["ids"])}
    manifest["hash"] = digest(manifest)
    return output, manifest


def export_dataset(repo: Path, config: dict, output_dir: Path, bridge: Any,
                   *, refresh: bool = False) -> tuple[list[dict], dict]:
    source = Path(config["dataset"])
    if not source.is_absolute():
        source = repo / source
    input_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    implementation = implementation_identity(repo)
    export_settings = {key: config[key] for key in ("trace_format", "prompt_style", "evaluation_only", "diagnostic_only")}
    export_settings["reasoning_channel"] = resolve_reasoning_channel(config)
    state_path = output_dir / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if state and state.get("config_hash") != config_fingerprint(config):
        raise ValueError("config differs from the checkpoint; use a new output directory")
    if state and state.get("implementation_hash") != implementation["hash"]:
        raise ValueError("implementation changed since the checkpoint; use a new output directory")
    if refresh and state:
        raise ValueError("cannot refresh a dataset attached to checkpoint state; use a new output directory")
    manifest_path = output_dir / "dataset-manifest.json"
    dataset_path = output_dir / "dataset.jsonl"
    if not refresh and manifest_path.exists() and dataset_path.exists():
        frozen = json.loads(manifest_path.read_text())
        if frozen.get("implementation_hash") != implementation["hash"]:
            raise ValueError("implementation changed since frozen export; use --refresh-export before training or a new directory")
        split = frozen.get("split_manifest", {})
        matches = (frozen.get("input_sha256") == input_hash and frozen.get("export_settings") == export_settings
            and split.get("seed") == config["split_seed"] and all(
            split.get(key) == config[key] for key in ("holdout_fraction", "validation_fraction"))
        )
        if matches:
            rows = read_jsonl(dataset_path)
            if digest(rows) != frozen["dataset_hash"]:
                raise ValueError("frozen dataset checksum failed; do not train on modified artifacts")
            if digest({key: value for key, value in split.items() if key != "hash"}) != split.get("hash"):
                raise ValueError("split manifest checksum failed")
            if state and state.get("dataset_hash") != frozen["dataset_hash"]:
                raise ValueError("frozen dataset differs from checkpoint state")
            return rows, frozen
        if state:
            raise ValueError("dataset input or split settings changed since checkpoint; use a new output directory")
    tasks = read_jsonl(source)
    diagnostic_flags = [bool(task.get("diagnosticOnly") or task.get("metadata", {}).get("diagnosticOnly")) for task in tasks]
    if config["diagnostic_only"]:
        if not all(diagnostic_flags) or any(task.get("split") != "test" for task in tasks):
            raise ValueError("diagnostic_only requires every input task marked diagnosticOnly with explicit test split")
    elif any(diagnostic_flags):
        raise ValueError("diagnosticOnly tasks require a separate diagnostic_only evaluation dataset")
    exported: list[dict] = []
    channel = resolve_reasoning_channel(config)

    def _export_one(active_bridge: Any, task: dict) -> dict:
        try:
            row = active_bridge.request("export", task=task, traceFormat=config["trace_format"], reasoningChannel=channel)
            row["metadata"] = {**task.get("metadata", {}), **row.get("metadata", {})}
            if task.get("diagnosticOnly"):
                row["metadata"]["diagnosticOnly"] = True
            row["metadata"] = task_metadata(row)
            row["messages"] = prompt_messages(row["messages"], config)
            return row
        except BridgeError as error:
            raise BridgeError(f"task {task.get('id', '(missing id)')}: {error}") from error

    export_workers = min(6, max(1, os.cpu_count() or 1)) if isinstance(bridge, Bridge) and len(tasks) > 32 else 1
    if export_workers == 1:
        for idx, task in enumerate(tasks, 1):
            exported.append(_export_one(bridge, task))
            if len(tasks) > 100 and idx % 100 == 0:
                print(f"export: {idx}/{len(tasks)}", file=sys.stderr, flush=True)
    else:
        ordered_exported: list[dict | None] = [None] * len(tasks)
        extra_bridges = [Bridge(repo, config["bridge_timeout_seconds"]) for _ in range(export_workers - 1)]
        bridges = [bridge, *extra_bridges]
        progress_lock = threading.Lock()
        done_export = 0
        next_index = 0

        def _worker(worker_bridge: Bridge) -> None:
            nonlocal next_index, done_export
            while True:
                with progress_lock:
                    if next_index >= len(tasks):
                        return
                    idx = next_index
                    next_index += 1
                result = _export_one(worker_bridge, tasks[idx])
                ordered_exported[idx] = result
                with progress_lock:
                    done_export += 1
                    if done_export % 100 == 0 or done_export == len(tasks):
                        print(f"export: {done_export}/{len(tasks)}", file=sys.stderr, flush=True)

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=export_workers) as pool:
                futs = [pool.submit(_worker, b) for b in bridges]
                for fut in concurrent.futures.as_completed(futs):
                    fut.result()
        finally:
            for extra in extra_bridges:
                try:
                    extra.close()
                except Exception:
                    pass
        exported = [row for row in ordered_exported if row is not None]
    rows, split_manifest = split_examples(exported, config["split_seed"], config["holdout_fraction"],
                                          config["validation_fraction"], evaluation_only=config["evaluation_only"])
    if implementation_identity(repo)["hash"] != implementation["hash"]:
        raise ValueError("implementation changed during dataset export; retry after edits finish")
    manifest = {"schema": "tinker-js-dataset-v1", "input_sha256": input_hash, "export_settings": export_settings,
                "implementation_hash": implementation["hash"], "implementation_files": implementation["files"],
                "git_revision": implementation["git_revision"],
                "dataset_hash": digest(rows), "split_manifest": split_manifest,
                "counts": {split: sum(row["split"] == split for row in rows)
                           for split in ("train", "validation", "test")}}
    if state:
        if state.get("dataset_hash") != manifest["dataset_hash"]:
            raise ValueError("dataset changed since the saved checkpoint; use a new output directory")
    write_jsonl(output_dir / "dataset.jsonl", rows)
    for split in ("train", "validation", "test"):
        write_jsonl(output_dir / f"{split}.jsonl", [row for row in rows if row["split"] == split])
    atomic_json(output_dir / "dataset-manifest.json", manifest)
    return rows, manifest


def visible_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content
                         if isinstance(part, dict) and part.get("type") in ("text", "output_text"))
    raise ValueError("sampled assistant message content must be text or structured parts")


CONCISE_INSTRUCTION = ("Execute the supplied program accurately. Keep any explanation concise; "
                       "include every required external action and the complete observable outcome.")


def prompt_messages(messages: list[dict], config: dict) -> list[dict]:
    result = copy.deepcopy(messages)
    if config.get("prompt_style", "standard") == "concise":
        result.insert(0, {"role": "system", "content": CONCISE_INSTRUCTION})
    return result


def compression_reward(success: bool, generated_tokens: int, config: dict) -> float:
    if not success:
        return 0.0
    coefficient = config["length_penalty"] if config.get("rl_objective", "likelihood") in ("compression", "likelihood") else 0.0
    return 1.0 - coefficient * min(generated_tokens / config["length_scale_tokens"], 1.0)


def _has_thinking_without_text(message: dict, text: str) -> bool:
    if text.strip() or message.get("tool_calls"):
        return False
    content = message.get("content")
    return isinstance(content, list) and any(
        isinstance(part, dict) and part.get("type") == "thinking" and str(part.get("thinking", "")).strip()
        for part in content
    )


def _step_action(message: dict, text: str | None = None) -> Any:
    if message.get("tool_calls"):
        return message
    return visible_text(message) if text is None else text


def rollout(bridge: Any, adapter: Any, task: dict, config: dict, seed: int) -> dict:
    """Sample a complete execution, never showing private task fields to the model."""
    started = bridge.request("start", task=task)
    session_id = started["sessionId"]
    messages = prompt_messages(started["messages"], config)
    samples: list[dict] = []
    total = 0
    done = False
    forced_failure = None
    thinking_only_turn = False
    grade: dict = {}
    try:
        for turn in range(config["max_turns"]):
            remaining = config["max_generated_tokens"] - total
            if remaining <= 0:
                forced_failure = "generated_token_budget_exhausted"
                break
            sample = adapter.sample(copy.deepcopy(messages), max_tokens=min(config["max_tokens"], remaining),
                                    seed=(seed + turn) % 2147483647)
            token_ids = sample.get("token_ids")
            if not isinstance(token_ids, list) or any(isinstance(token, bool) or not isinstance(token, int)
                                                      for token in token_ids):
                raise ValueError("sampling adapter must preserve all generated token IDs")
            samples.append(copy.deepcopy(sample))
            total += len(token_ids)
            if total > config["max_generated_tokens"]:
                forced_failure = "generated_token_budget_exceeded"
                break
            message = sample.get("message")
            if isinstance(message, dict) and message.get("role") == "assistant":
                messages.append(copy.deepcopy(message))
            if not sample.get("complete", True) or sample.get("stop_reason") in ("length", "max_tokens"):
                forced_failure = (sample.get("failure_reason")
                    or ("sampling_provenance_error" if sample.get("provenance_error") else None)
                    or ("sample_parse_error" if sample.get("parse_error") else None)
                    or "truncated_sample")
                break
            if not isinstance(message, dict) or message.get("role") != "assistant":
                raise ValueError("sampling adapter must return an assistant message")
            text = sample.get("text")
            if text is None:
                text = visible_text(message)
            if _has_thinking_without_text(message, text):
                thinking_only_turn = True
            response = bridge.request("step", sessionId=session_id, action=_step_action(message, text), generatedTokens=total)
            observations = response.get("messages", [])
            if any(not isinstance(observation, dict) or observation.get("role") not in ("user", "tool")
                   for observation in observations):
                raise BridgeError("environment attempted to insert a teacher assistant correction or non-observation role")
            messages.extend(copy.deepcopy(observations))
            done = bool(response.get("done"))
            if done:
                grade = response.get("grade") or bridge.request("grade", sessionId=session_id,
                                                                totalGeneratedTokens=total)
                break
        if not done and forced_failure is None:
            forced_failure = "turn_budget_exhausted"
        if not grade:
            grade = bridge.request("grade", sessionId=session_id, totalGeneratedTokens=total)
        grade = copy.deepcopy(grade)
        grade["environmentReward"] = grade.get("reward")
        if forced_failure:
            # The CPU session is merely unfinished; the sampler/budget failure
            # is the more specific cause and must not inherit that category.
            grade.pop("failureCategory", None)
            grade.update(success=False, reason=forced_failure)
        grade["success"] = bool(done and grade.get("success") and not forced_failure)
        if not grade["success"] and not forced_failure and thinking_only_turn:
            grade["failureCategory"] = "thinking_without_text"
        grade["reward"] = compression_reward(grade["success"], total, config)
        grade["generatedTokens"] = total
        return {"task_id": task.get("id"), "family": task.get("family"), "seed": seed,
                "backend": getattr(adapter, "backend_name", "test-double"), "samples": samples, "messages": messages,
                "generated_tokens": total, "complete": bool(done and not forced_failure and grade.get("complete", True)),
                "grade": grade}
    except Exception as error:
        partial_record = {"task_id": task.get("id"), "family": task.get("family"), "seed": seed,
                          "backend": getattr(adapter, "backend_name", "test-double"),
                          "samples": samples, "messages": messages, "generated_tokens": total,
                          "complete": False, "grade": None,
                          "infrastructure_error": {"type": type(error).__name__, "message": str(error)}}
        raise RolloutError(f"rollout infrastructure failure: {error}", partial_record) from error
    finally:
        primary_error = sys.exc_info()[0] is not None
        try:
            bridge.request("close", sessionId=session_id)
        except Exception as error:
            if not primary_error:
                print(f"warning: completed environment session cleanup failed: {error}", file=sys.stderr)


def group_advantages(rewards: list[float]) -> list[float]:
    """Generic standardization retained for diagnostics, never the RL objective."""
    if not rewards or any(not math.isfinite(reward) for reward in rewards):
        raise ValueError("group rewards must be finite and nonempty")
    mean = statistics.fmean(rewards)
    deviation = math.sqrt(statistics.fmean((reward - mean) ** 2 for reward in rewards))
    if deviation < 1e-12:
        return [0.0] * len(rewards)
    return [(reward - mean) / deviation for reward in rewards]


def evaluation_selection(rows: list[dict], config: dict, output_dir: Path, split: str) -> tuple[list[dict], dict]:
    population = sorted((row for row in rows if row["split"] == split), key=lambda row: row["id"])
    if not population:
        raise ValueError(f"no {split} tasks are available for evaluation")
    declared = config.get("evaluation_manifest")
    if isinstance(declared, str):
        declared = json.loads(Path(declared).read_text())
    if declared is not None:
        if not isinstance(declared, dict):
            raise ValueError("evaluation manifest must map split names to task IDs")
        declared = declared.get("splits", declared)
        if not isinstance(declared, dict) or split not in declared:
            raise ValueError(f"evaluation manifest has no {split} selection")
        ids = declared[split]
        if not isinstance(ids, list) or not ids or any(not isinstance(item, str) for item in ids) or len(set(ids)) != len(ids):
            raise ValueError("evaluation manifest IDs must be a nonempty list of unique strings")
        indexed = {row["id"]: row for row in population}
        if set(ids) - set(indexed):
            raise ValueError("evaluation manifest selects missing tasks or tasks from another split")
        selected = [indexed[identifier] for identifier in ids]
        if config["max_eval_tasks"] is not None and len(selected) > config["max_eval_tasks"]:
            raise ValueError("explicit evaluation manifest exceeds max_eval_tasks; do not silently truncate it")
        method = "explicit_manifest"
    elif config["max_eval_tasks"] is not None and len(population) > config["max_eval_tasks"]:
        # Round-robin families within tier strata. Ordering is seeded, then
        # frozen, so an ID prefix cannot accidentally define the benchmark.
        strata: dict[int, dict[str, list[dict]]] = {}
        for row in population:
            tier = task_metadata(row)["tier"]
            family = row.get("split_component") or row["family"]
            strata.setdefault(tier, {}).setdefault(family, []).append(row)
        queues = []
        for tier, families in sorted(strata.items()):
            rng = random.Random(config["evaluation_seed"] + tier)
            names = sorted(families)
            rng.shuffle(names)
            for family in names:
                rng.shuffle(families[family])
            queue = []
            while any(families.values()):
                for family in names:
                    if families[family]:
                        queue.append(families[family].pop())
            queues.append(queue)
        selected = []
        while len(selected) < config["max_eval_tasks"]:
            for queue in queues:
                if queue and len(selected) < config["max_eval_tasks"]:
                    selected.append(queue.pop(0))
        method = "seeded_tier_and_family_round_robin"
    else:
        selected, method = population, "full_split"
    identity = lambda row: {"id": row["id"], "task_hash": digest(row["task"]), "source_hash": row["sourceHash"],
                            "family": row["family"], "component": row.get("split_component"),
                            "metadata": task_metadata(row)}
    selection = {"split": split, "method": method, "evaluation_seed": config["evaluation_seed"],
                 "evaluation_samples": config["evaluation_samples"], "population_size": len(population),
                 "population_hash": digest([identity(row) for row in population]),
                 "selected": [identity(row) for row in selected]}
    selection["hash"] = digest(selection)
    path = output_dir / "evaluations" / f"selection-{split}.json"
    if path.exists() and json.loads(path.read_text()) != selection:
        raise ValueError("frozen evaluation selection changed; use a new run directory")
    atomic_json(path, selection)
    return selected, selection


def evaluate(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
             stage: str, split: str = "test", *, resume: bool = False,
             checkpoint: str | None = None) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", stage):
        raise ValueError("stage must be a short filename-safe name")
    manifest_path = output_dir / "dataset-manifest.json"
    implementation_hash = json.loads(manifest_path.read_text()).get("implementation_hash") if manifest_path.exists() else None
    selected, selection = evaluation_selection(rows, config, output_dir, split)
    destination = output_dir / "evaluations" / f"{stage}-{split}.jsonl"
    partial = destination.with_suffix(".partial.jsonl")
    records = read_jsonl(destination if destination.exists() else partial) if resume and (destination.exists() or partial.exists()) else []
    expected = {(row["id"], repeat): row for row in selected for repeat in range(config["evaluation_samples"])}
    completed = set()
    for record in records:
        key = (record["task_id"], record["repeat"])
        if key not in expected or key in completed:
            raise ValueError("saved evaluation has unexpected or duplicated tasks")
        if (record.get("configuration_hash") != config_fingerprint(config)
                or record.get("task_hash") != digest(expected[key]["task"])
                or record.get("sampling_checkpoint") != checkpoint
                or record.get("implementation_hash") != implementation_hash
                or record.get("selection_hash") != selection["hash"]
                or record.get("source_hash") != expected[key]["sourceHash"]
                or record.get("family") != expected[key]["family"]
                or record.get("seed") != int(digest([config["evaluation_seed"], key[0], key[1]])[:8], 16) % 2147483647):
            raise ValueError("saved evaluation differs in config, task, or checkpoint")
        completed.add(key)
    write_jsonl(partial, records)
    selected_order = {row["id"]: index for index, row in enumerate(selected)}
    pending_jobs = [
        (row, repeat, int(digest([config["evaluation_seed"], row["id"], repeat])[:8], 16) % 2147483647)
        for row in selected for repeat in range(config["evaluation_samples"])
        if (row["id"], repeat) not in completed
    ]
    total_jobs = len(expected)
    done_count = len(records)
    ok_count = sum(1 for r in records if r["grade"]["success"])
    tok_sum = sum(r["generated_tokens"] for r in records)
    started_at = time.monotonic()

    def _run_eval_job(row: dict, repeat: int, seed: int) -> dict:
        record = rollout(bridge, adapter, row["task"], config, seed)
        record.update(task_id=row["id"], family=row["family"], source_hash=row["sourceHash"],
                      stage=stage, split=split, repeat=repeat,
                      configuration_hash=config_fingerprint(config), model=config["model"],
                      task_hash=digest(row["task"]), sampling_checkpoint=checkpoint,
                      implementation_hash=implementation_hash, selection_hash=selection["hash"],
                      split_component=row.get("split_component"),
                      features=task_metadata(row)["features"], tier=task_metadata(row)["tier"])
        return record

    def _record_eval_result(record: dict) -> None:
        nonlocal done_count, ok_count, tok_sum
        records.append(record)
        append_jsonl(partial, record)
        done_count += 1
        ok_count += int(bool(record["grade"]["success"]))
        tok_sum += record["generated_tokens"]
        print(f"[{done_count}/{total_jobs}] {stage}/{split}: {record['task_id']} sample {record['repeat'] + 1}: "
              f"success={record['grade']['success']} tokens={record['generated_tokens']} "
              f"(acc={ok_count / done_count:.1%}, mean_tok={tok_sum / done_count:.0f})",
              file=sys.stderr, flush=True)

    concurrency = max(1, int(config.get("rollout_concurrency", 1)))
    if concurrency == 1 or len(pending_jobs) <= 1:
        for row, repeat, seed in pending_jobs:
            try:
                _record_eval_result(_run_eval_job(row, repeat, seed))
            except RolloutError as error:
                append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                    **error.record, "phase": "evaluation", "stage": stage, "split": split,
                    "repeat": repeat, "configuration_hash": config_fingerprint(config),
                    "sampling_checkpoint": checkpoint})
                raise
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(concurrency, len(pending_jobs))) as pool:
            futures = {pool.submit(_run_eval_job, row, repeat, seed): (row, repeat)
                       for row, repeat, seed in pending_jobs}
            try:
                for future in concurrent.futures.as_completed(futures):
                    row, repeat = futures[future]
                    try:
                        record = future.result()
                    except RolloutError as error:
                        append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                            **error.record, "phase": "evaluation", "stage": stage, "split": split,
                            "repeat": repeat, "configuration_hash": config_fingerprint(config),
                            "sampling_checkpoint": checkpoint})
                        raise
                    _record_eval_result(record)
            except Exception:
                for future in futures:
                    future.cancel()
                raise
        records.sort(key=lambda r: (selected_order[r["task_id"]], r["repeat"]))
        write_jsonl(partial, records)
    partial.replace(destination)
    summary = summarize_records(records)
    elapsed = time.monotonic() - started_at
    acc = summary["complete_execution_accuracy"] or 0.0
    mean_tok = summary["mean_generated_tokens"] or 0.0
    med_tok = summary["median_generated_tokens"] or 0.0
    print(f"{stage}/{split} done ({elapsed:.1f}s): acc={acc:.1%} ({summary['successes']}/{summary['executions']}) "
          f"mean_tok={mean_tok:.0f} median_tok={med_tok:.0f} failures={summary['failure_categories']}",
          file=sys.stderr, flush=True)
    atomic_json(output_dir / "evaluations" / f"{stage}-{split}.summary.json", summary)
    return summary


def _restore_tuples(value: Any) -> Any:
    return tuple(_restore_tuples(item) for item in value) if isinstance(value, list) else value


def config_fingerprint(config: dict) -> str:
    return digest({key: value for key, value in config.items() if key != "output_dir"})


class UpdateRecoveryError(RuntimeError):
    """An optimizer attempt cannot safely be repeated or silently abandoned."""


def _optimizer_lineage(state: dict) -> dict:
    return copy.deepcopy(state.get("optimizer_lineage") or {
        "origin_training_path": state.get("training_path"),
        "sft_updates": 0, "rl_updates": 0, "last_update_id": None,
    })


def _update_attempts(output_dir: Path) -> dict[str, dict]:
    path = output_dir / "update-ledger.jsonl"
    attempts: dict[str, dict] = {}
    allowed = {"submitted", "optimizer_confirmed", "outcome_unknown", "recovery_error",
               "checkpoint_persisted", "state_committed", "resume_recovered"}
    for row in read_jsonl(path) if path.exists() else []:
        attempt_id, event = row.get("attempt_id"), row.get("event")
        if not isinstance(attempt_id, str) or event not in allowed:
            raise UpdateRecoveryError("invalid optimizer update ledger; refusing to infer or repeat updates")
        if event == "submitted":
            if attempt_id in attempts or digest(row.get("identity")) != row.get("identity_hash"):
                raise UpdateRecoveryError("duplicate or changed optimizer submission identity")
            attempts[attempt_id] = {"submission": row, "events": {}}
        attempt = attempts.get(attempt_id)
        if attempt is None or row.get("identity_hash") != attempt["submission"]["identity_hash"]:
            raise UpdateRecoveryError("optimizer outcome has no matching submission identity")
        if event in attempt["events"] and event != "recovery_error":
            raise UpdateRecoveryError("duplicate optimizer update outcome")
        if event in {"checkpoint_persisted", "state_committed", "resume_recovered"} and (
                "optimizer_confirmed" not in attempt["events"]):
            raise UpdateRecoveryError("optimizer recovery was recorded without a confirmed update")
        if event == "state_committed" and "checkpoint_persisted" not in attempt["events"] and not row.get("checkpoint_skipped"):
            raise UpdateRecoveryError("optimizer progress was recorded before a recovery checkpoint")
        attempt["events"][event] = row
    return attempts


def _update_event(output_dir: Path, pending: dict, event: str, **values: Any) -> None:
    append_jsonl(output_dir / "update-ledger.jsonl", {
        "event": event, "attempt_id": pending["attempt_id"],
        "identity_hash": pending["identity_hash"], "recorded_at": time.time(), **values,
    }, durable=True)


def optimizer_update_accounting(output_dir: Path) -> dict:
    """Count durable attempts, not the progress of a selected/rolled-back model.

    A pre-dispatch record cannot establish server acceptance. Unknown attempts
    may have committed, including when the process died before an acknowledgement.
    """
    attempts = _update_attempts(output_dir)
    def counts(items: list[dict]) -> dict:
        confirmed = sum("optimizer_confirmed" in item["events"] for item in items)
        recovered = sum("checkpoint_persisted" in item["events"] for item in items)
        return {"submission_attempts": len(items), "confirmed_optimizer_updates": confirmed,
                "unknown_outcome_attempts": len(items) - confirmed,
                "recovery_checkpointed_updates": recovered,
                "confirmed_without_recovery_checkpoint": confirmed - recovered,
                "state_committed_updates": sum("state_committed" in item["events"] for item in items),
                "repaired_on_resume": sum("resume_recovered" in item["events"] for item in items)}
    pending_path = output_dir / "pending-update.json"
    pending = json.loads(pending_path.read_text()) if pending_path.exists() else None
    values = list(attempts.values())
    by_stage = {stage: counts([item for item in values if item["submission"]["identity"]["stage"] == stage])
                for stage in sorted({item["submission"]["identity"]["stage"] for item in values})}
    backends = sorted({item["submission"]["identity"]["backend"] for item in values})
    return {**counts(values), "by_stage": by_stage, "backends": backends,
            "pending_attempt": pending["attempt_id"] if pending else None,
            "prepared_without_submission_record": int(bool(pending and pending["attempt_id"] not in attempts)),
            "ledger": "update-ledger.jsonl",
            "scope": "Durable adapter dispatch attempts, including work later rolled back. A dispatch record does not prove server acceptance; confirmed updates are a lower bound when any outcome is unknown. These are not billing totals or the number of updates retained by the selected model."}


def _unresolved_update(output_dir: Path, pending: dict, attempts: dict) -> UpdateRecoveryError:
    attempt = attempts.get(pending["attempt_id"])
    confirmed = bool(attempt and "optimizer_confirmed" in attempt["events"])
    status = "confirmed but missing a durable recovery checkpoint" if confirmed else "of unknown optimizer outcome"
    safe = pending["identity"]["policy"]["training_path"]
    return UpdateRecoveryError(
        f"Optimizer attempt {pending['attempt_id']} is {status}; automatic resume is refused. "
        f"Last safe optimizer checkpoint: {safe!r}. Preserve state.json, pending-update.json, updates/, "
        "update-ledger.jsonl and rollouts/. Resolve the original service operation/checkpoint, or explicitly "
        "start a separate recovery lineage from this saved state and checkpoint, without copying later rollouts. "
        "Deleting the marker or repeating this update would discard evidence and may repeat committed work.")


def _finish_update_recovery(output_dir: Path, pending: dict, *, resumed: bool = False) -> dict:
    """Install an acknowledged recovery receipt without issuing any model call."""
    attempts = _update_attempts(output_dir)
    attempt = attempts.get(pending["attempt_id"])
    receipt_path = output_dir / "updates" / f"{pending['attempt_id']}.recovery.json"
    if not receipt_path.exists():
        if attempt and "optimizer_confirmed" not in attempt["events"] and "outcome_unknown" not in attempt["events"]:
            _update_event(output_dir, pending, "outcome_unknown", error_type="InterruptedBeforeAcknowledgement")
        raise _unresolved_update(output_dir, pending, attempts)
    receipt = json.loads(receipt_path.read_text())
    checksum = receipt.pop("hash", None)
    state = receipt.get("state", {})
    if (attempt is None or "optimizer_confirmed" not in attempt["events"]
            or attempt["submission"]["identity_hash"] != pending["identity_hash"]
            or digest(receipt) != checksum or receipt.get("attempt_id") != pending["attempt_id"]
            or receipt.get("identity_hash") != pending["identity_hash"]
            or digest(pending["identity"]) != pending["identity_hash"]
            or digest(state) != receipt.get("state_hash")
            or state.get("last_recovered_update") != pending["attempt_id"]
            or any(not receipt.get("checkpoint", {}).get(key)
                   or state.get(key) != receipt["checkpoint"][key] for key in ("training_path", "sampler_path"))):
        raise UpdateRecoveryError("optimizer recovery receipt identity/checksum is invalid")
    persisted = attempt["events"].get("checkpoint_persisted")
    if persisted and (persisted.get("receipt_hash") != checksum
                      or persisted.get("checkpoint") != receipt["checkpoint"]):
        raise UpdateRecoveryError("optimizer checkpoint ledger differs from its recovery receipt")
    input_path = output_dir / "updates" / f"{pending['attempt_id']}.input.json"
    inputs = json.loads(input_path.read_text())
    if (digest(inputs) != pending["identity"]["input_hash"]
            or digest(inputs["before_state"]) != pending["identity"]["before_state_hash"]
            or any(state.get(key) != inputs["before_state"].get(key)
                   for key in ("config_hash", "dataset_hash", "implementation_hash"))):
        raise UpdateRecoveryError("optimizer recovery inputs or run identity changed")
    current = json.loads((output_dir / "state.json").read_text())
    if digest(current) not in {pending["identity"]["before_state_hash"], receipt["state_hash"]}:
        raise UpdateRecoveryError("local state is neither the before-update state nor its recovery receipt")
    if "checkpoint_persisted" not in attempt["events"]:
        _update_event(output_dir, pending, "checkpoint_persisted", checkpoint=receipt["checkpoint"],
                      receipt_hash=checksum)
    if digest(current) != receipt["state_hash"]:
        atomic_json(output_dir / "state.json", state)
    if "state_committed" not in attempt["events"]:
        _update_event(output_dir, pending, "state_committed", state_hash=receipt["state_hash"])
    if resumed and "resume_recovered" not in attempt["events"]:
        _update_event(output_dir, pending, "resume_recovered", state_hash=receipt["state_hash"])
    if receipt.get("published_name"):
        path = output_dir / "checkpoints.jsonl"
        published = read_jsonl(path) if path.exists() else []
        if not any(item.get("recovery_attempt") == pending["attempt_id"] for item in published):
            append_jsonl(path, {"name": receipt["published_name"], "recovery_attempt": pending["attempt_id"],
                               **copy.deepcopy(state)}, durable=True)
    (output_dir / "pending-update.json").unlink()
    _sync_directory(output_dir)
    return state


def _recover_updates(output_dir: Path, state: dict) -> dict:
    pending_path = output_dir / "pending-update.json"
    if pending_path.exists():
        state = _finish_update_recovery(output_dir, json.loads(pending_path.read_text()), resumed=True)
    if any("state_committed" not in item["events"] for item in _update_attempts(output_dir).values()):
        raise UpdateRecoveryError("unfinished optimizer ledger entry has no pending marker; automatic resume is refused")
    return state


def _require_clean_updates(output_dir: Path, state: dict, rng: random.Random) -> None:
    if (output_dir / "pending-update.json").exists() or any(
            "state_committed" not in item["events"] for item in _update_attempts(output_dir).values()):
        raise UpdateRecoveryError("unfinished optimizer attempt; use --resume to check its durable recovery receipt")
    if not (output_dir / "state.json").exists():
        save_state(output_dir, state, rng)


def _submit_update(adapter: Any, output_dir: Path, state: dict, config: dict, *, stage: str,
                   step: int, payload: dict, context: dict, call: Any) -> tuple[dict, dict]:
    """Write intent before dispatch; an exception never licenses another update."""
    attempt_id = f"{stage}-{step:06d}"
    input_path = output_dir / "updates" / f"{attempt_id}.input.json"
    if input_path.exists() or (output_dir / "pending-update.json").exists():
        raise UpdateRecoveryError("optimizer attempt already has durable evidence; refusing to repeat it")
    before_state = json.loads((output_dir / "state.json").read_text())
    policy = {"training_path": state.get("training_path"), "sampler_path": state.get("sampler_path"),
              "lineage": _optimizer_lineage(state), "model": config["model"],
              "training_identity": copy.deepcopy(getattr(adapter, "training_identity", None))}
    inputs = {"call": payload, "context": context, "policy": policy, "before_state": before_state}
    identity = {"stage": stage, "step": step, "backend": getattr(adapter, "backend_name", "unknown"),
                "input_hash": digest(inputs), "before_state_hash": digest(before_state), "policy": policy,
                "config_hash": config_fingerprint(config), "dataset_hash": state.get("dataset_hash"),
                "implementation_hash": state.get("implementation_hash")}
    pending = {"attempt_id": attempt_id, "identity": identity, "identity_hash": digest(identity)}
    atomic_json(input_path, inputs)
    atomic_json(output_dir / "pending-update.json", pending)
    _update_event(output_dir, pending, "submitted", identity=identity)
    try:
        metrics = call()
    except BaseException as error:
        _update_event(output_dir, pending, "outcome_unknown", error_type=type(error).__name__)
        raise
    _update_event(output_dir, pending, "optimizer_confirmed", metrics_hash=digest(metrics))
    return metrics, pending


def _commit_update(adapter: Any, output_dir: Path, state: dict, rng: random.Random,
                   pending: dict, *, published: bool, validation_pending: bool = False,
                   config: dict | None = None) -> None:
    attempt_id = pending["attempt_id"]
    checkpoint_every_update = True if config is None else config.get("checkpoint_every_update", True)
    if not published and not checkpoint_every_update:
        lineage = _optimizer_lineage(state)
        lineage[pending["identity"]["stage"] + "_updates"] += 1
        lineage["last_update_id"] = attempt_id
        state.update(optimizer_lineage=lineage, last_recovered_update=attempt_id)
        save_state(output_dir, state, rng)
        _update_event(output_dir, pending, "state_committed", state_hash=digest(state), checkpoint_skipped=True)
        (output_dir / "pending-update.json").unlink()
        _sync_directory(output_dir)
        return
    name = attempt_id if published else f"recovery-{attempt_id}"
    ttl = None if published or config is None else config.get("recovery_checkpoint_ttl_seconds")
    saved = None
    try:
        saved = adapter.checkpoint(name, ttl_seconds=ttl) if ttl is not None and _accepts_kwarg(adapter.checkpoint, "ttl_seconds") else adapter.checkpoint(name)
        if not saved.get("training_path") or not saved.get("sampler_path"):
            raise RuntimeError("recovery checkpoint must include optimizer state and sampler weights")
        recovered = copy.deepcopy(state)
        recovered.update(saved)
        lineage = _optimizer_lineage(state)
        lineage[pending["identity"]["stage"] + "_updates"] += 1
        lineage["last_update_id"] = attempt_id
        recovered.update(optimizer_lineage=lineage, last_recovered_update=attempt_id, rng_state=rng.getstate())
        if validation_pending:
            recovered["pending_validation"] = {"stage": attempt_id, "training_path": saved["training_path"],
                                                "sampler_path": saved["sampler_path"]}
        receipt = {"attempt_id": attempt_id, "identity_hash": pending["identity_hash"],
                   "checkpoint": saved, "state": recovered, "state_hash": digest(recovered),
                   "published_name": attempt_id if published else None}
        atomic_json(output_dir / "updates" / f"{attempt_id}.recovery.json", {**receipt, "hash": digest(receipt)})
    except BaseException as error:
        _update_event(output_dir, pending, "recovery_error", error_type=type(error).__name__,
                      acknowledged_checkpoint=saved)
        raise
    recovered = _finish_update_recovery(output_dir, pending)
    state.clear()
    state.update(recovered)


def _accepts_kwarg(func: Any, name: str) -> bool:
    import inspect
    try:
        params = inspect.signature(func).parameters
        return name in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
    except (TypeError, ValueError):
        return False


def load_state(output_dir: Path, config: dict, manifest: dict, resume: bool) -> tuple[dict, random.Random]:
    path = output_dir / "state.json"
    rng = random.Random(config["seed"])
    if path.exists():
        if not resume:
            raise ValueError("output directory already has experiment state; use --resume or a new directory")
        state = json.loads(path.read_text())
        if state.get("config_hash") != config_fingerprint(config):
            raise ValueError("config differs from the checkpoint; resume requires the recorded configuration")
        if state.get("dataset_hash") != manifest["dataset_hash"]:
            raise ValueError("dataset differs from the checkpoint")
        if state.get("implementation_hash") != manifest.get("implementation_hash"):
            raise ValueError("implementation differs from the checkpoint")
        state = _recover_updates(output_dir, state)
        if state.get("rng_state"):
            rng.setstate(_restore_tuples(state["rng_state"]))
        return state, rng
    if (output_dir / "pending-update.json").exists() or (output_dir / "update-ledger.jsonl").exists():
        raise UpdateRecoveryError("optimizer evidence exists without state.json; refusing to start a fresh learner")
    state = {"schema": "tinker-js-run-v1", "config_hash": config_fingerprint(config),
             "dataset_hash": manifest["dataset_hash"], "split_hash": manifest["split_manifest"]["hash"],
             "implementation_hash": manifest.get("implementation_hash"), "git_revision": manifest.get("git_revision"),
             "sft_batches_completed": 0, "rl_steps_completed": 0, "phase": "created",
             "rl_optimizer_updates": 0,
             "training_path": None, "sampler_path": None, "evaluations": [], "backend": "tinker"}
    if config.get("initial_sft_checkpoint"):
        initial = config["initial_sft_checkpoint"]
        state.update(training_path=initial["training_path"], sampler_path=initial["sampler_path"],
                     sft_training_path=initial["training_path"], sft_sampler_path=initial["sampler_path"],
                     phase="sft_done", initial_sft_checkpoint=copy.deepcopy(initial))
    state["optimizer_lineage"] = _optimizer_lineage(state)
    save_state(output_dir, state, rng)
    return state, rng


def save_state(output_dir: Path, state: dict, rng: random.Random) -> None:
    state["rng_state"] = rng.getstate()
    atomic_json(output_dir / "state.json", state)


def save_checkpoint(adapter: Any, output_dir: Path, state: dict, rng: random.Random, name: str,
                    *, validation_pending: bool = False) -> None:
    saved = adapter.checkpoint(name)
    if not saved.get("training_path") or not saved.get("sampler_path"):
        raise RuntimeError("checkpoint must contain optimizer-resumable state and separate sampler weights")
    state.update(saved)
    if state["phase"] == "sft_done":
        state.update(sft_training_path=saved["training_path"], sft_sampler_path=saved["sampler_path"])
    if validation_pending:
        state["pending_validation"] = {"stage": name, "training_path": saved["training_path"],
                                       "sampler_path": saved["sampler_path"]}
    save_state(output_dir, state, rng)
    append_jsonl(output_dir / "checkpoints.jsonl", {"name": name, **copy.deepcopy(state)})


def _ensure_initial_checkpoint(adapter: Any, output_dir: Path, state: dict,
                               rng: random.Random, stage: str) -> None:
    # Bind even a newly initialized learner to retrievable, exact weights before
    # the first rollout/update. A seed or process-local training-step label is
    # not a durable sampling-policy identity.
    state.setdefault("optimizer_lineage", _optimizer_lineage(state))
    if not state.get("training_path") or not state.get("sampler_path"):
        save_checkpoint(adapter, output_dir, state, rng, f"{stage}-initial")
    else:
        save_state(output_dir, state, rng)


def record_validation(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
                      state: dict, rng: random.Random, stage: str,
                      training_path: str | None, sampler_path: str | None) -> dict | None:
    """Durably record validation and select checkpoints without consulting test."""
    if config.get("diagnostic_only") or any(task_metadata(row).get("diagnosticOnly") for row in rows):
        raise ValueError("diagnostic-only tasks cannot drive validation or checkpoint selection")
    if not any(row["split"] == "validation" for row in rows):
        state["compression_gate_open"] = False
        state["validation_unavailable"] = True
        state["pending_validation"] = None
        save_state(output_dir, state, rng)
        return None
    if state.get("final_selection_hash"):
        raise ValueError("final test selection is sealed; further validation requires a new experiment")
    pending = {"stage": stage, "training_path": training_path, "sampler_path": sampler_path}
    if state.get("pending_validation") not in (None, pending):
        raise ValueError("another checkpoint has unfinished validation")
    state["pending_validation"] = pending
    save_state(output_dir, state, rng)
    adapter.create_sampling_client(checkpoint=sampler_path)
    summary = evaluate(bridge, adapter, rows, config, output_dir, stage, "validation", resume=True,
                       checkpoint=sampler_path)
    candidate = {**pending, "split": "validation", "summary": summary,
                 "sft_batches_completed": state.get("sft_batches_completed", 0),
                 "rl_steps_completed": state.get("rl_steps_completed", 0),
                 "optimizer_lineage": _optimizer_lineage(state) if training_path
                 and training_path == state.get("training_path") else _optimizer_lineage({"training_path": training_path})}
    candidates = state.setdefault("validation_candidates", [])
    existing = next((item for item in candidates if item["stage"] == stage), None)
    if existing is not None and existing != candidate:
        raise ValueError("validation stage changed its checkpoint or summary")
    if existing is None:
        candidates.append(candidate)
    state["selected_checkpoint"] = choose_validation_checkpoint(candidates, config)
    trained = [item for item in candidates if item["training_path"]]
    state["best_trained_checkpoint"] = choose_validation_checkpoint(trained, config)
    anchor = max(item["summary"]["complete_execution_accuracy"] for item in candidates)
    accuracy = summary["complete_execution_accuracy"]
    gate = accuracy >= config["compression_min_accuracy"] and accuracy >= anchor - config["accuracy_tolerance"]
    state["compression_gate_open"] = gate
    previous = state.get("last_validation_summary")
    alert = bool(previous and accuracy < previous["complete_execution_accuracy"]
                 and summary["mean_generated_tokens"] < previous["mean_generated_tokens"])
    state["last_validation_summary"] = summary
    state["pending_validation"] = None
    append_jsonl(output_dir / "metrics.jsonl", {"stage": "validation", "checkpoint_stage": stage,
                 "accuracy_anchor": anchor, "compression_gate_open": gate,
                 "accuracy_fell_while_tokens_fell": alert, "summary": summary,
                 "selected_stage": state["selected_checkpoint"]["stage"]})
    # Keep rollback inside the durable validation transaction. Resuming a
    # partially completed validation must perform the same restoration as an
    # uninterrupted run, even when the RL step itself was already checkpointed.
    best = state.get("best_trained_checkpoint")
    # Roll back on compression-gate failure during compression RL, or on a real
    # accuracy regression beyond accuracy_tolerance during correctness RL (never
    # merely because accuracy is still climbing below compression_min_accuracy).
    regressed = (not gate) if config.get("rl_objective", "likelihood") in ("compression", "likelihood") else (accuracy < anchor - config["accuracy_tolerance"])
    if stage.startswith("rl-") and regressed and best and best["training_path"] != state.get("training_path"):
        event = {"step": state.get("rl_steps_completed", 0), "validation_stage": stage,
                 "from": state.get("training_path"), "to": best["training_path"],
                 "reason": "validation accuracy below compression gate; restore selected optimizer state"}
        adapter.create_training_client(checkpoint=best["training_path"])
        state.update(training_path=best["training_path"], sampler_path=best["sampler_path"],
                     optimizer_lineage=_optimizer_lineage(best))
        state.setdefault("rollback_events", []).append(event)
        append_jsonl(output_dir / "metrics.jsonl", {"stage": "rollback", **event})
    save_state(output_dir, state, rng)
    return candidate


def resume_validation(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
                      state: dict, rng: random.Random) -> None:
    pending = state.get("pending_validation")
    if pending:
        record_validation(bridge, adapter, rows, config, output_dir, state, rng, **pending)


def maybe_validate_checkpoint(bridge: Any, adapter: Any, rows: list[dict], config: dict,
                              output_dir: Path, state: dict, rng: random.Random,
                              name: str, *, force: bool = False) -> dict | None:
    if not force and not config["validation_every"]:
        return None
    return record_validation(bridge, adapter, rows, config, output_dir, state, rng, name,
                             state.get("training_path"), state.get("sampler_path"))


def require_training_data(rows: list[dict], config: dict) -> None:
    if (config.get("evaluation_only") or config.get("diagnostic_only")
            or any(row.get("diagnosticOnly") or task_metadata(row).get("diagnosticOnly") for row in rows)):
        raise ValueError("evaluation-only or diagnosticOnly datasets are prohibited from training")


def train_sft(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
              state: dict, rng: random.Random) -> None:
    require_training_data(rows, config)
    _require_clean_updates(output_dir, state, rng)
    resume_validation(bridge, adapter, rows, config, output_dir, state, rng)
    if state["phase"] in ("rl", "rl_done"):
        raise ValueError("cannot restart the SFT stage after RL in the same run directory")
    if state["phase"] == "sft_done":
        finish_sft_selection(adapter, config, output_dir, state, rng)
        return
    train_rows = sorted((row for row in rows if row["split"] == "train"), key=lambda row: row["id"])
    if not train_rows:
        raise ValueError("no training rows")
    adapter.create_training_client(checkpoint=state.get("training_path"))
    _ensure_initial_checkpoint(adapter, output_dir, state, rng, "sft")
    epoch_plans = [sft_epoch_rows(train_rows, config, epoch) for epoch in range(config["sft_epochs"])]
    total_batches = sum((len(ordered) + config["batch_size"] - 1) // config["batch_size"] for ordered in epoch_plans)
    batch_index = 0
    for epoch, ordered in enumerate(epoch_plans):
        for start in range(0, len(ordered), config["batch_size"]):
            batch_index += 1
            if batch_index <= state["sft_batches_completed"]:
                continue
            batch_started = time.monotonic()
            batch = ordered[start:start + config["batch_size"]]
            examples = [{"messages": row["messages"], "metadata": task_metadata(row)} for row in batch]
            lr = scheduled_learning_rate(config["sft_learning_rate"], batch_index - 1, total_batches, config)
            options = {"learning_rate": lr}
            metrics, pending = _submit_update(adapter, output_dir, state, config, stage="sft", step=batch_index,
                payload={"method": "sft_train", "examples": examples, "options": options},
                context={"epoch": epoch, "ids": [row["id"] for row in batch],
                         "source_hashes": [row["sourceHash"] for row in batch]},
                call=lambda: adapter.sft_train(examples, **options))
            state.update(sft_batches_completed=batch_index, phase="sft")
            append_jsonl(output_dir / "metrics.jsonl", {"stage": "sft", "batch": batch_index,
                         "update_attempt_id": pending["attempt_id"],
                         "epoch": epoch, "ids": [row["id"] for row in batch], "metrics": metrics,
                         "learning_rate": lr, "weighting": config["sft_weighting"],
                         "tiers": [task_metadata(row)["tier"] for row in batch],
                         "features": sorted({feature for row in batch for feature in task_metadata(row)["features"]})})
            inner_metrics = metrics.get("metrics", {}) if isinstance(metrics, dict) else {}
            loss_val = inner_metrics.get("loss:sum", inner_metrics.get("loss"))
            loss_str = f"{loss_val:.4f}" if isinstance(loss_val, (int, float)) else "n/a"
            print(f"sft batch {batch_index}/{total_batches} (epoch {epoch + 1}/{config['sft_epochs']}): "
                  f"lr={lr:.2e} loss={loss_str} ({time.monotonic() - batch_started:.1f}s)",
                  file=sys.stderr, flush=True)
            validate = bool(config["validation_every"] and batch_index % config["validation_every"] == 0)
            _commit_update(adapter, output_dir, state, rng, pending,
                           published=batch_index % config["checkpoint_every"] == 0 or validate,
                           validation_pending=validate, config=config)
            if validate:
                maybe_validate_checkpoint(bridge, adapter, rows, config, output_dir, state, rng,
                                          f"sft-{batch_index:06d}")
    state["phase"] = "sft_done"
    final_name = f"sft-final-{batch_index:06d}"
    save_checkpoint(adapter, output_dir, state, rng, final_name, validation_pending=True)
    maybe_validate_checkpoint(bridge, adapter, rows, config, output_dir, state, rng, final_name, force=True)
    finish_sft_selection(adapter, config, output_dir, state, rng)
    adapter.refresh_sampler()


def finish_sft_selection(adapter: Any, config: dict, output_dir: Path, state: dict, rng: random.Random) -> None:
    sft_candidates = [candidate for candidate in state.get("validation_candidates", [])
                      if candidate["stage"].startswith("sft-")]
    selected = choose_validation_checkpoint(sft_candidates, config)
    if selected:
        state.update(sft_training_path=selected["training_path"], sft_sampler_path=selected["sampler_path"],
                     training_path=selected["training_path"], sampler_path=selected["sampler_path"],
                     optimizer_lineage=_optimizer_lineage(selected))
        adapter.create_training_client(checkpoint=state["training_path"])
        save_state(output_dir, state, rng)


def train_rl(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
             state: dict, rng: random.Random, training_ready: bool = False) -> None:
    require_training_data(rows, config)
    _require_clean_updates(output_dir, state, rng)
    resume_validation(bridge, adapter, rows, config, output_dir, state, rng)
    if state["phase"] == "rl_done":
        return
    train_rows = sorted((row for row in rows if row["split"] == "train"), key=lambda row: row["id"])
    if not train_rows:
        raise ValueError("no training rows")
    if not training_ready:
        adapter.create_training_client(checkpoint=state.get("training_path"))
    _ensure_initial_checkpoint(adapter, output_dir, state, rng, "rl")
    if (state.get("sft_sampler_path") and not any(candidate["sampler_path"] == state["sft_sampler_path"]
            for candidate in state.get("validation_candidates", []))):
        record_validation(bridge, adapter, rows, config, output_dir, state, rng, "sft-initial",
                          state.get("sft_training_path", state.get("training_path")), state["sft_sampler_path"])
    if config["reference_kl_coef"]:
        if not state.get("sft_sampler_path"):
            raise ValueError("reference KL requires the recorded SFT sampler checkpoint")
        adapter.set_reference_checkpoint(state["sft_sampler_path"])
    prompts_per_step = config.get("rl_prompts_per_step", 1)
    concurrency = max(1, int(config.get("rollout_concurrency", 1)))
    likelihood_mode = config.get("rl_objective") == "likelihood"
    turn_cache: dict[str, list[dict]] = {}
    ephemeral_sampler_active = False
    for step in range(state["rl_steps_completed"], config["rl_steps"]):
        step_started = time.monotonic()
        if not ephemeral_sampler_active:
            adapter.create_sampling_client(checkpoint=state["sampler_path"])
        active_sampler = getattr(adapter, "sampling_revision", state["sampler_path"]) if ephemeral_sampler_active else state["sampler_path"]
        policy = {"training_path": state["training_path"], "sampler_path": active_sampler,
                  "lineage": _optimizer_lineage(state)}
        coefficient = compression_coefficient(config, step, gate_open=state.get("compression_gate_open", False))
        batch_groups = []
        for _ in range(prompts_per_step):
            row, curriculum_selection = curriculum_pick(train_rows, config, state, rng)
            turn_target = None
            if likelihood_mode:
                turns = turn_cache.get(row["id"])
                if turns is None:
                    turns = adapter.extract_turn_targets(row["messages"])
                    turn_cache[row["id"]] = turns
                if not turns:
                    raise ValueError(f"Task {row['id']} has no assistant turns for likelihood RL")
                turn_target = turns[rng.randrange(len(turns))]
            seeds = [rng.randrange(2147483647) for _ in range(config["group_size"])]
            batch_groups.append((row, curriculum_selection, seeds, turn_target))
        if prompts_per_step == 1:
            row, curriculum_selection, seeds, turn_target = batch_groups[0]
            group_context = digest({"step": step + 1, "task": row["task"], "seeds": seeds,
                                    **({"turn_index": turn_target["turn_index"]} if turn_target is not None else {}),
                                    "config_hash": config_fingerprint(config), "compression_coefficient": coefficient,
                                    "curriculum": curriculum_selection,
                                    "implementation_hash": state.get("implementation_hash"),
                                    "policy": policy})
        else:
            group_context = digest({"step": step + 1,
                                    "groups": [{"task": r["task"], "seeds": s, "curriculum": c,
                                                **({"turn_index": tt["turn_index"]} if tt is not None else {})}
                                               for r, c, s, tt in batch_groups],
                                    "config_hash": config_fingerprint(config), "compression_coefficient": coefficient,
                                    "implementation_hash": state.get("implementation_hash"),
                                    "policy": policy})
        expected_total = prompts_per_step * config["group_size"]
        flat_plan = [(r, c, s, tt) for r, c, seeds, tt in batch_groups for s in seeds]
        destination = output_dir / "rollouts" / f"rl-{step + 1:06d}.jsonl"
        partial = destination.with_suffix(".partial.jsonl")
        records = read_jsonl(destination if destination.exists() else partial) if destination.exists() or partial.exists() else []
        if len(records) > expected_total or any(
                record.get("group_context") != group_context or record.get("seed") != flat_plan[index][2]
                or record.get("policy") != policy
                for index, record in enumerate(records)):
            raise ValueError("saved RL group differs in task, seeds, configuration, or policy checkpoint")
        write_jsonl(partial, records)
        pending_plan = flat_plan[len(records):]

        def _run_rl_rollout(row: dict, seed: int, turn_target: dict | None) -> dict:
            if likelihood_mode:
                assert turn_target is not None
                sample = adapter.sample_thinking_and_score_target(
                    turn_target, seed=seed, max_tokens=config["max_tokens"], temperature=config["temperature"],
                )
                terminated = bool(sample["terminated"] and sample["target_logprob_sum"] is not None)
                record = {
                    "seed": seed,
                    "samples": [sample],
                    "generated_tokens": sample["generated_tokens"],
                    "turns": 1,
                    "turn_index": turn_target["turn_index"],
                    "operation": turn_target["operation"],
                    "is_tool_call": turn_target["is_tool_call"],
                    "terminated": terminated,
                    "truncated": not terminated,
                    "target_logprob_sum": sample["target_logprob_sum"],
                    "target_logprob_mean": sample["target_logprob_mean"],
                    "grade": {
                        "success": terminated,
                        "reward": float(sample["target_logprob_sum"]) if terminated else -200.0,
                        "reason": "likelihood-scored" if terminated else "thinking-truncated",
                        "failureCategory": None if terminated else "truncation",
                        "generatedTokens": sample["generated_tokens"],
                        "externalCalls": 1 if turn_target["is_tool_call"] else 0,
                        "complete": terminated,
                    },
                    "token_categories": sample["token_categories"],
                }
            else:
                record = rollout(bridge, adapter, row["task"], config, seed)
            record.update(group_context=group_context, task_id=row["id"], family=row["family"],
                          source_hash=row["sourceHash"], split="train", step=step + 1,
                          policy=copy.deepcopy(policy),
                          split_component=row.get("split_component"), features=task_metadata(row)["features"],
                          tier=task_metadata(row)["tier"])
            return record

        if concurrency == 1 or len(pending_plan) <= 1:
            for row, _curriculum_selection, seed, turn_target in pending_plan:
                try:
                    record = _run_rl_rollout(row, seed, turn_target)
                except RolloutError as error:
                    append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                        **error.record, "phase": "rl", "step": step + 1,
                        "group_context": group_context, "configuration_hash": config_fingerprint(config)})
                    raise
                records.append(record)
                append_jsonl(partial, record)
        else:
            ordered_results: list[dict | None] = [None] * len(pending_plan)
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(concurrency, len(pending_plan))) as pool:
                futures = {pool.submit(_run_rl_rollout, row, seed, turn_target): idx
                           for idx, (row, _c, seed, turn_target) in enumerate(pending_plan)}
                try:
                    for future in concurrent.futures.as_completed(futures):
                        idx = futures[future]
                        try:
                            ordered_results[idx] = future.result()
                        except RolloutError as error:
                            append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                                **error.record, "phase": "rl", "step": step + 1,
                                "group_context": group_context, "configuration_hash": config_fingerprint(config)})
                            raise
                except Exception:
                    for future in futures:
                        future.cancel()
                    raise
            for record in ordered_results:
                assert record is not None
                records.append(record)
                append_jsonl(partial, record)
        if any(sample.get("sampler_revision", policy["sampler_path"]) != policy["sampler_path"]
               for record in records for sample in record["samples"]):
            raise ValueError("sampled RL sequence does not match the durable sampler checkpoint")
        group_size = config["group_size"]
        all_signals = []
        counters = state.setdefault("rl_group_counts", {"all_failure": 0, "mixed_success": 0,
                                                         "all_success": 0, "zero_advantage": 0, "useful": 0})
        curriculum_results = []
        for group_idx, (row, curriculum_selection, _seeds, _tt) in enumerate(batch_groups):
            group_records = records[group_idx * group_size:(group_idx + 1) * group_size]
            sig = likelihood_advantages(group_records, config, coefficient) if likelihood_mode else execution_advantages(group_records, config, coefficient)
            all_signals.append(sig)
            for index, record in enumerate(group_records):
                record.update(advantage=sig["advantages"][index],
                              correctness_advantage=sig["correctness_advantages"][index],
                              length_advantage=sig["length_advantages"][index],
                              length_contribution=sig["length_contributions"][index],
                              compression_coefficient=coefficient)
                if likelihood_mode:
                    t_adv = sig["target_advantages"][index]
                    record["target_advantage"] = t_adv
                    if record["samples"]:
                        record["samples"][0]["target_advantage"] = t_adv
            counters[sig["group_kind"]] += 1
            counters["zero_advantage" if sig["zero_advantage_group"] else "useful"] += 1
            curriculum_results.append(update_curriculum(train_rows, config, state, curriculum_selection, group_records))
        signals = all_signals[0] if prompts_per_step == 1 else {
            "group_kind": "batched",
            "zero_advantage_group": all(s["zero_advantage_group"] for s in all_signals),
            "length_signal": any(s["length_signal"] for s in all_signals),
            "correctness_signal": any(s["correctness_signal"] for s in all_signals),
        }
        write_jsonl(destination, records)
        partial.unlink(missing_ok=True)
        if any(sample.get("provenance_error") for record in records for sample in record["samples"]):
            raise RuntimeError("sampled RL provenance is invalid; saved raw rollout and aborted the entire update")
        nonzero = [
            record for record in records
            if abs(record["advantage"]) > 1e-12 or abs(record.get("target_advantage", 0.0)) > 1e-12
        ]
        update_records = records if config["reference_kl_coef"] else nonzero
        regularization_only = bool(update_records) and not nonzero
        lr = scheduled_learning_rate(config["rl_learning_rate"], step, config["rl_steps"], config)
        pending = None
        if update_records:
            trajectories = [{"samples": record["samples"], "advantage": record["advantage"]}
                            for record in update_records]
            options = {"loss_fn": config["rl_loss_fn"], "loss_fn_config": config["rl_loss_fn_config"],
                       "learning_rate": lr}
            metrics, pending = _submit_update(adapter, output_dir, state, config, stage="rl", step=step + 1,
                payload={"method": "rl_train", "trajectories": trajectories, "options": options},
                context={"group_context": group_context, "rollout_hash": digest(records),
                         "rollout_path": str(destination.relative_to(output_dir)), "policy": policy,
                         "reference_checkpoint": state.get("sft_sampler_path") if config["reference_kl_coef"] else None},
                call=lambda: adapter.rl_train(trajectories, **options))
            state["rl_optimizer_updates"] = state.get("rl_optimizer_updates", 0) + 1
            if regularization_only:
                state["rl_regularization_only_updates"] = state.get("rl_regularization_only_updates", 0) + 1
        else:
            metrics = {"skipped": True, "reason": "zero correctness and controlled length advantages"}
        state["rl_generated_tokens"] = state.get("rl_generated_tokens", 0) + sum(record["generated_tokens"] for record in records)
        curriculum_result = curriculum_results[-1]
        state.update(rl_steps_completed=step + 1, phase="rl")
        step_summary = summarize_records(records)
        useful_in_step = sum(not s["zero_advantage_group"] for s in all_signals)
        ll_means = [s["mean_target_ll"] for s in all_signals if s.get("mean_target_ll") is not None]
        ll_bests = [s["best_target_ll"] for s in all_signals if s.get("best_target_ll") is not None]
        append_jsonl(output_dir / "metrics.jsonl", {"stage": "rl", "step": step + 1,
                     "update_attempt_id": pending["attempt_id"] if pending else None,
                     "learning_rate": lr,
                     "task_id": batch_groups[0][0]["id"] if prompts_per_step == 1 else [g[0]["id"] for g in batch_groups],
                     "prompts_in_step": prompts_per_step,
                     **step_summary, "metrics": metrics,
                     **({"mean_target_ll": statistics.fmean(ll_means), "best_target_ll": statistics.fmean(ll_bests)}
                        if likelihood_mode and ll_means else {}),
                     "group_kind": signals["group_kind"], "zero_advantage_group": signals["zero_advantage_group"],
                     "compression_coefficient": coefficient, "length_signal": signals["length_signal"],
                     "correctness_signal": signals["correctness_signal"], "curriculum": curriculum_result,
                     "regularization_only_update": regularization_only,
                     "group_counts": dict(counters), "optimizer_updates": state.get("rl_optimizer_updates", 0),
                     "useful_groups_per_thousand_tokens": 1000 * counters["useful"] / state["rl_generated_tokens"]
                     if state["rl_generated_tokens"] else None})
        step_acc = step_summary["complete_execution_accuracy"] or 0.0
        step_tok = step_summary["mean_generated_tokens"] or 0.0
        status_label = "updated" if pending else "skipped"
        if likelihood_mode:
            ll_str = f"{statistics.fmean(ll_means):.2f}" if ll_means else "n/a"
            best_str = f"{statistics.fmean(ll_bests):.2f}" if ll_bests else "n/a"
            print(f"rl step {step + 1}/{config['rl_steps']}: lr={lr:.2e} "
                  f"mean_ll={ll_str} best_ll={best_str} term={step_acc:.1%} "
                  f"mean_tok={step_tok:.0f} useful={useful_in_step}/{len(all_signals)} "
                  f"coef={coefficient:.3f} {status_label} ({time.monotonic() - step_started:.1f}s)",
                  file=sys.stderr, flush=True)
        else:
            print(f"rl step {step + 1}/{config['rl_steps']}: lr={lr:.2e} "
                  f"acc={step_acc:.1%} ({step_summary['successes']}/{step_summary['executions']}) "
                  f"mean_tok={step_tok:.0f} useful={useful_in_step}/{len(all_signals)} "
                  f"coef={coefficient:.3f} {status_label} ({time.monotonic() - step_started:.1f}s)",
                  file=sys.stderr, flush=True)
        validate = bool(config["validation_every"] and (step + 1) % config["validation_every"] == 0)
        published = (step + 1) % config["checkpoint_every"] == 0 or validate
        name = f"rl-{step + 1:06d}"
        if pending:
            _commit_update(adapter, output_dir, state, rng, pending, published=published,
                           validation_pending=validate, config=config)
            if not published and not config.get("checkpoint_every_update", True):
                adapter.refresh_sampler()
                ephemeral_sampler_active = True
            else:
                ephemeral_sampler_active = False
        elif published:
            save_checkpoint(adapter, output_dir, state, rng, name, validation_pending=validate)
            ephemeral_sampler_active = False
        else:
            save_state(output_dir, state, rng)
        if validate:
            maybe_validate_checkpoint(bridge, adapter, rows, config, output_dir, state, rng, name)
            ephemeral_sampler_active = False
    state["phase"] = "rl_done"
    name = f"rl-final-{state['rl_steps_completed']:06d}"
    save_checkpoint(adapter, output_dir, state, rng, name, validation_pending=True)
    maybe_validate_checkpoint(bridge, adapter, rows, config, output_dir, state, rng, name, force=True)



def make_report(output_dir: Path, config: dict | None = None) -> dict:
    config = config or json.loads((output_dir / "config.json").read_text())
    stages: dict[str, list[dict]] = {}
    validation_stages: dict[str, list[dict]] = {}
    for split, destination in (("test", stages), ("validation", validation_stages)):
        for path in sorted((output_dir / "evaluations").glob(f"*-{split}.jsonl")):
            destination[path.name.removesuffix(f"-{split}.jsonl")] = read_jsonl(path)
    report: dict[str, Any] = {"schema": "tinker-js-report-v1", "model": config["model"],
        "backend": "tinker", "generated_token_scope": "All sampled token IDs, including reasoning, protocol formatting and stop tokens",
        "test_used_for": "fixed final comparisons after validation selection; never gradient updates or checkpoint selection",
        "stages": {name: summarize_records(rows) for name, rows in stages.items()},
        "validation_stages": {name: summarize_records(rows) for name, rows in validation_stages.items()},
        "evaluation_unit": "Single attempt; repetitions are separate attempts and all sampled tokens count",
        "diagnostic_only": config.get("diagnostic_only", False),
        "paired": {}, "acceptance_criteria": {key: config[key] for key in
            ("accuracy_tolerance", "min_token_saving", "minimum_evaluation_families", "confidence_level")}}
    manifest_path = output_dir / "dataset-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        report.update(dataset_hash=manifest["dataset_hash"], split_hash=manifest["split_manifest"]["hash"],
                      implementation_hash=manifest.get("implementation_hash"), git_revision=manifest.get("git_revision"))
    for records in [*stages.values(), *validation_stages.values()]:
        if any(row.get("backend") != "tinker" for row in records):
            raise ValueError("a Tinker performance report cannot contain fixture/mock backend records")
        if any(row.get("configuration_hash") != config_fingerprint(config) for row in records):
            raise ValueError("evaluation configuration differs; use separate run directories")
        if any(row.get("implementation_hash") != report.get("implementation_hash") for row in records):
            raise ValueError("evaluation implementation differs; use separate run directories")
    errors_path = output_dir / "infrastructure-errors.jsonl"
    errors = read_jsonl(errors_path) if errors_path.exists() else []
    report["interrupted_attempts"] = {"attempts": len(errors),
        "received_generated_tokens": sum(record["generated_tokens"] for record in errors),
        "note": "Infrastructure failures abort updates and are excluded from model accuracy; all received sample tokens remain in the audit."}
    report["optimizer_attempts"] = optimizer_update_accounting(output_dir)
    update_backends = report["optimizer_attempts"]["backends"]
    if any(backend != "tinker" for backend in update_backends):
        if stages or validation_stages or "tinker" in update_backends:
            raise ValueError("a Tinker performance report cannot mix fixture optimizer evidence with model evaluations")
        report.update(backend="fixture", model_performance_evidence=False,
                      evidence_kind="infrastructure tests; no model performance evidence")
    for name, records in stages.items():
        if name != "baseline" and "baseline" in stages:
            report["paired"][name] = paired_statistics(stages["baseline"], records, config)
    state_path = output_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
        report.update(checkpoint={key: state.get(key) for key in ("training_path", "sampler_path")},
                      selected_checkpoint=state.get("selected_checkpoint"),
                      validation_candidates=state.get("validation_candidates", []),
                      compression_gate_open=state.get("compression_gate_open", False),
                      rollback_events=state.get("rollback_events", []),
                      curriculum=state.get("curriculum"), curriculum_transitions=state.get("curriculum_transitions", []),
                      dataset_hash=state.get("dataset_hash"), split_hash=state.get("split_hash"),
                      implementation_hash=state.get("implementation_hash"), git_revision=state.get("git_revision"),
                      training_updates={"sft_batches": state.get("sft_batches_completed", 0),
                                        "rl_optimizer_steps": state.get("rl_optimizer_updates", 0),
                                        "rl_regularization_only_steps": state.get("rl_regularization_only_updates", 0),
                                        "sampled_rl_groups": state.get("rl_steps_completed", 0),
                                        "scope": "Durably recovered execution progress; cumulative optimizer attempts are reported separately"},
                      active_checkpoint_optimizer_lineage=_optimizer_lineage(state),
                      selected_checkpoint_optimizer_lineage=(state.get("selected_checkpoint") or {}).get("optimizer_lineage"),
                      rl_group_counts=state.get("rl_group_counts", {}),
                      rl_generated_tokens=state.get("rl_generated_tokens", 0))
    selections = {}
    for path in sorted((output_dir / "evaluations").glob("selection-*.json")):
        selection = json.loads(path.read_text())
        selections[selection["split"]] = selection
    report["evaluation_selections"] = selections
    atomic_json(output_dir / "report.json", report)
    lines = ["# JavaScript execution training report", "", f"Model: `{config['model']}`", "",
             "All sampled tokens count, including reasoning and formatting. Accuracy requires the complete "
             "return/exception, input mutations, and externally visible behavior to match.", "",
             "| Stage | Attempts | Complete accuracy | Mean tokens | P95 tokens | Failed tokens | Tokens per success |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    order = ["baseline", "sft", "selected", "rl"] + sorted(set(stages) - {"baseline", "sft", "selected", "rl"})
    for name in order:
        if name not in report["stages"]:
            continue
        summary = report["stages"][name]
        accuracy = summary["complete_execution_accuracy"]
        cost = summary["tokens_per_verified_success"]
        lines.append(f"| {name} | {summary['executions']} | {accuracy:.1%} | {summary['mean_generated_tokens']:.1f} | "
                     f"{summary['p95_generated_tokens']:.1f} | {summary['failed_execution_tokens']} | "
                     f"{cost if cost is not None else 'undefined: no successes'} |")
    if not stages:
        lines.extend(["", "No final test evaluation has been recorded. Validation-only results are development evidence."])
    attempts = report["optimizer_attempts"]
    lines.extend(["", f"Optimizer dispatch attempts: {attempts['submission_attempts']}; "
                  f"confirmed optimizer updates: {attempts['confirmed_optimizer_updates']}; "
                  f"unknown outcomes: {attempts['unknown_outcome_attempts']}; "
                  f"confirmed updates without a recovery checkpoint: {attempts['confirmed_without_recovery_checkpoint']}.", "",
                  "These cumulative attempts include work later rolled back and are separate from recovered progress "
                  "and the selected model's update lineage. Dispatch records do not establish server acceptance or billing; "
                  "unknown outcomes may include committed updates. Every confirmed update requires a durable recovery "
                  "checkpoint before another update may run."])
    selected = report.get("selected_checkpoint")
    if selected:
        lines.extend(["", f"Selected on validation: `{selected['stage']}`. "
                      "The selection applies the predeclared accuracy tolerance and minimum cost saving."])
    for name, pair in report["paired"].items():
        lines.extend(["", f"## Baseline versus {name}", "",
                      f"Independent family components: {pair['uncertainty']['independent_components']}. "
                      f"Acceptance status: **{pair['acceptance']['status']}**.", "",
                      "Paired family-bootstrap intervals, both-correct comparisons, full failure costs, and task-level "
                      "identities are retained in `report.json`. Degenerate or small samples do not establish a precise accuracy margin."])
    lines.extend(["", "Held-out source families and evaluation selections are frozen before use. "
                  "Validation drives checkpoint selection; final test results never drive updates.", "",
                  "The JSON report includes per-family/feature/tier failures, token categories, useful-group counts, "
                  "curriculum transitions, checkpoint selection, and infrastructure interruption costs.", ""])
    (output_dir / "report.md").write_text("\n".join(lines))
    return report



def validate_fixtures(bridge: Any, rows: list[dict]) -> dict:
    """Replay supervised targets to check fixtures, explicitly without a model."""
    results = []
    agent_rows = 0
    for row in rows:
        teacher_messages = row["messages"]
        if row.get("metadata", {}).get("importedFrom") == "agent-tool-conversation":
            # Agent examples supervise code selection. Only their attached
            # executor task has an oracle; this does not verify the agent goal.
            teacher_messages = bridge.request("export", task=row["task"])["messages"]
            agent_rows += 1
        started = bridge.request("start", task=row["task"])
        session = started["sessionId"]
        done = False
        grade = {}
        try:
            for message in teacher_messages:
                if message.get("role") != "assistant":
                    continue
                response = bridge.request("step", sessionId=session, action=_step_action(message), generatedTokens=0)
                if response.get("done"):
                    done = True
                    grade = response.get("grade") or bridge.request("grade", sessionId=session, totalGeneratedTokens=0)
                    break
            results.append({"id": row["id"], "valid": bool(done and grade.get("success"))})
        finally:
            bridge.request("close", sessionId=session)
    return {"kind": "offline_fixture_validation", "model_sampled": False, "training_performed": False,
            "scope": "attached_executor_tasks", "agentObjectiveVerified": False,
            "imported_agent_rows": agent_rows,
            "valid": sum(result["valid"] for result in results), "total": len(results),
            "failures": [result["id"] for result in results if not result["valid"]]}


def validate_token_budgets(bridge: Any, adapter: Any, rows: list[dict], config: dict) -> dict:
    """Render actual SFT data and initial rollout prompts without model compute.

    Also verifies that supervised teacher target lengths are compatible with the
    configured rollout generation budgets when enforce_turn_budget is enabled.
    """
    train_examples = 0
    train_tokens = []
    episode_assistant_tokens = []
    single_turn_assistant_tokens = []
    over_turn_budget: list[dict] = []
    over_episode_budget: list[dict] = []
    prompt_tokens = []
    for row in rows:
        try:
            if row["split"] == "train" and config.get("sft_epochs", 1) > 0:
                datums = adapter.render_sft(row["messages"])
                train_examples += len(datums)
                assistant_turns = sum(1 for message in row["messages"] if message.get("role") == "assistant")
                episode_trainable = 0
                for datum in datums:
                    target_data = datum.loss_fn_inputs["target_tokens"]
                    weight_data = datum.loss_fn_inputs["weights"]
                    targets = target_data.data if hasattr(target_data, "data") else list(target_data)
                    weights = weight_data.data if hasattr(weight_data, "data") else list(weight_data)
                    train_tokens.append(len(targets))
                    episode_trainable += sum(1 for w in weights if w > 0)
                episode_assistant_tokens.append(episode_trainable)
                if episode_trainable > config["max_generated_tokens"]:
                    over_episode_budget.append({"id": row["id"], "tokens": episode_trainable,
                                                "limit": config["max_generated_tokens"]})
                if assistant_turns == 1:
                    single_turn_assistant_tokens.append(episode_trainable)
                    if episode_trainable > config["max_tokens"]:
                        over_turn_budget.append({"id": row["id"], "tokens": episode_trainable,
                                                 "limit": config["max_tokens"]})
            started = bridge.request("start", task=row["task"])
            try:
                checked = adapter.validate_prompt(prompt_messages(started["messages"], config), max_tokens=config["max_tokens"])
                prompt_tokens.append(checked["prompt_tokens"])
            finally:
                bridge.request("close", sessionId=started["sessionId"])
        except Exception as error:
            raise ValueError(f"token preflight for task {row['id']}: {error}") from error
    if config.get("enforce_turn_budget", False) and (over_turn_budget or over_episode_budget):
        detail = over_turn_budget[:3] or over_episode_budget[:3]
        raise ValueError(
            f"SFT teacher trace exceeds rollout generation budget ({len(over_turn_budget)} turns > "
            f"max_tokens={config['max_tokens']}, {len(over_episode_budget)} episodes > "
            f"max_generated_tokens={config['max_generated_tokens']}): {detail}"
        )
    return {"training_datums": train_examples, "max_training_tokens": max(train_tokens, default=0),
            "max_episode_assistant_tokens": max(episode_assistant_tokens, default=0),
            "max_single_turn_assistant_tokens": max(single_turn_assistant_tokens, default=0),
            "turns_exceeding_max_tokens": len(over_turn_budget),
            "episodes_exceeding_max_generated_tokens": len(over_episode_budget),
            "initial_prompts": len(prompt_tokens), "max_initial_prompt_tokens": max(prompt_tokens, default=0),
            "reserved_output_tokens": config["max_tokens"], "max_generated_tokens": config["max_generated_tokens"],
            "context_limit": config["max_context_tokens"], "model_sampled": False}


def _backend(config: dict) -> Any:
    from .adapter import TinkerAdapter
    return TinkerAdapter(config)


def final_test(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
               state: dict, rng: random.Random) -> None:
    selected = state.get("selected_checkpoint")
    if selected is None:
        raise ValueError("final test requires a checkpoint selected on validation")
    identity = digest(selected)
    if state.get("final_selection_hash") not in (None, identity):
        raise ValueError("checkpoint selection changed after final test was unsealed")
    state["final_selection_hash"] = identity
    comparisons = {"baseline": None, "selected": selected["sampler_path"]}
    if state.get("sft_sampler_path"):
        comparisons["sft"] = state["sft_sampler_path"]
    if state.get("final_stage_checkpoints") not in (None, comparisons):
        raise ValueError("final comparison checkpoints changed after test was unsealed")
    state["final_stage_checkpoints"] = comparisons
    save_state(output_dir, state, rng)
    for stage, checkpoint in comparisons.items():
        marker = f"{stage}-test"
        if marker in state["evaluations"]:
            continue
        adapter.create_sampling_client(checkpoint=checkpoint)
        evaluate(bridge, adapter, rows, config, output_dir, stage, "test", resume=True, checkpoint=checkpoint)
        state["evaluations"].append(marker)
        save_state(output_dir, state, rng)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export", "evaluate", "rollout", "sft", "rl", "report", "run"))
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output-dir")
    parser.add_argument("--dataset")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--refresh-export", action="store_true", help="Regenerate a frozen corpus before any checkpoint exists")
    parser.add_argument("--checkpoint", help="Sampler checkpoint for evaluate/rollout; training state for sft/rl")
    parser.add_argument("--split", choices=("train", "validation", "test"))
    parser.add_argument("--stage", default="baseline")
    parser.add_argument("--rollout-concurrency", type=int, help="Concurrent rollout threads for eval and RL")
    parser.add_argument("--live", action="store_true", help="For check: query service capabilities without model compute")
    parser.add_argument("--skip-sdk", action="store_true", help="For check: validate CPU fixtures without installing the SDK")
    args = parser.parse_args(argv)
    try:
        repo = args.repo.resolve()
        config_path = args.config
        if config_path is not None and not config_path.is_absolute():
            config_path = repo / config_path
        config = load_config(config_path, {
            "output_dir": args.output_dir,
            "dataset": args.dataset,
            "rollout_concurrency": args.rollout_concurrency,
        })
        if isinstance(config["evaluation_manifest"], str):
            selection_path = Path(config["evaluation_manifest"])
            if not selection_path.is_absolute():
                config["evaluation_manifest"] = str(repo / selection_path)
        output_dir = Path(config["output_dir"])
        if not output_dir.is_absolute():
            output_dir = repo / output_dir
        if args.command == "report":
            print(json_text(make_report(output_dir, config if args.config else None)))
            return 0
        with Bridge(repo, config["bridge_timeout_seconds"]) as bridge:
            rows, manifest = export_dataset(repo, config, output_dir, bridge, refresh=args.refresh_export)
            if args.command == "export":
                atomic_json(output_dir / "config.json", config)
                print(json_text(manifest))
                return 0
            if args.command == "check":
                result = {"api_key_present": bool(os.environ.get("TINKER_API_KEY")),
                          "dataset": manifest, "fixtures": validate_fixtures(bridge, rows)}
                if not args.skip_sdk:
                    try:
                        checked_adapter = _backend(config)
                        result["sdk"] = checked_adapter.check(remote=args.live)
                        result["token_budgets"] = validate_token_budgets(bridge, checked_adapter, rows, config)
                    except Exception as error:
                        result["sdk"] = {"error": str(error), "ready": False}
                sdk_ready = not args.skip_sdk and "error" not in result["sdk"]
                result["local_setup_ready"] = sdk_ready and not result["fixtures"]["failures"]
                result["credentials_status"] = "verified" if sdk_ready and args.live else "unverified"
                result["ready_for_live_training"] = result["local_setup_ready"] and args.live
                atomic_json(output_dir / "check.json", result)
                print(json_text(result))
                return 1 if result["fixtures"]["failures"] or (not args.skip_sdk and "error" in result["sdk"]) else 0
            adapter = _backend(config)
            if args.command in ("evaluate", "rollout"):
                if args.command == "evaluate" and args.checkpoint and args.stage == "baseline":
                    raise ValueError("a trained checkpoint cannot be labeled baseline; pass --stage sft, rl, or a distinct name")
                adapter.create_sampling_client(checkpoint=args.checkpoint)
                split = args.split or ("train" if args.command == "rollout" else "validation")
                stage = "rollout" if args.command == "rollout" else args.stage
                print(json_text(evaluate(bridge, adapter, rows, config, output_dir, stage, split,
                                        resume=args.resume, checkpoint=args.checkpoint)))
                atomic_json(output_dir / "config.json", config)
                return 0
            state, rng = load_state(output_dir, config, manifest, args.resume)
            token_check = validate_token_budgets(bridge, adapter, rows, config)
            atomic_json(output_dir / "token-budgets.json", token_check)
            if args.checkpoint:
                if state.get("training_path") and state["training_path"] != args.checkpoint:
                    raise ValueError("explicit checkpoint disagrees with resumed optimizer state")
                if not state.get("training_path"):
                    state["optimizer_lineage"] = _optimizer_lineage({"training_path": args.checkpoint})
                state["training_path"] = args.checkpoint
            atomic_json(output_dir / "config.json", config)
            if args.command == "run":
                resume_validation(bridge, adapter, rows, config, output_dir, state, rng)
                if "baseline-validation" not in state["evaluations"]:
                    record_validation(bridge, adapter, rows, config, output_dir, state, rng, "baseline", None, None)
                    state["evaluations"].append("baseline-validation")
                    save_state(output_dir, state, rng)
                training_ready = False
                if config["sft_epochs"] > 0 and state["phase"] not in ("rl", "rl_done"):
                    train_sft(bridge, adapter, rows, config, output_dir, state, rng)
                if state["phase"] != "rl_done":
                    train_rl(bridge, adapter, rows, config, output_dir, state, rng, training_ready)
                if config["final_test"]:
                    final_test(bridge, adapter, rows, config, output_dir, state, rng)
                print(json_text(make_report(output_dir, config)))
            elif args.command == "sft":
                train_sft(bridge, adapter, rows, config, output_dir, state, rng)
                print(json_text({"training_path": state["training_path"], "sampler_path": state["sampler_path"]}))
            elif args.command == "rl":
                train_rl(bridge, adapter, rows, config, output_dir, state, rng)
                print(json_text({"training_path": state["training_path"], "sampler_path": state["sampler_path"]}))
        return 0
    except Exception as error:
        print(f"tinker-js: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
