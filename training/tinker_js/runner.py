"""CPU environment orchestration; model compute is delegated to Tinker.

The environment owns teacher state. Only ``start.messages`` and observations
returned by ``step`` may enter a sampled conversation. Sampled token IDs and
log probabilities are saved verbatim and handed unchanged to the RL adapter.
"""

from __future__ import annotations

import argparse
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
import time
from typing import Any


DEFAULTS: dict[str, Any] = {
    "model": "thinkingmachines/Inkling-2-Mini:peft:65536:free",
    "seed": 17,
    "effort": 0.5,
    "max_context_tokens": 65536,
    "max_tokens": 2048,
    "temperature": 1.0,
    "learning_rate": 1e-4,
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
    "max_eval_tasks": 8,
    "checkpoint_every": 1,
    "length_penalty": 0.25,
    "bridge_timeout_seconds": 60,
}


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(json_text(value).encode()).hexdigest()


def implementation_identity(repo: Path) -> dict:
    """Bind experiments to executable sources and locked dependencies.

    Commit metadata is informational: committing unchanged files must not
    invalidate a corpus. Documentation, tests and generated run files are not
    part of the enforced fingerprint.
    """
    paths = {path for path in (repo / "src").rglob("*")
             if path.is_file() and path.suffix in (".js", ".json")}
    paths.update((repo / "training/tinker_js").glob("*.py"))
    for relative in ("tools/tinker-execution.mjs", "package-lock.json", "training/uv.lock"):
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


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as handle:
        for row in rows:
            handle.write(json_text(row) + "\n")
    temporary.replace(path)


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json_text(row) + "\n")
        handle.flush()


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
    config = dict(DEFAULTS)
    if path:
        supplied = json.loads(path.read_text())
        if not isinstance(supplied, dict):
            raise ValueError("experiment config must be an object")
        config.update(supplied)
    config.update({key: value for key, value in (overrides or {}).items() if value is not None})
    if (isinstance(config["seed"], bool) or not isinstance(config["seed"], int)
            or not 0 <= config["seed"] < 2147483648):
        raise ValueError("seed must be an integer in [0, 2**31)")
    for name in ("max_context_tokens", "max_tokens", "batch_size", "group_size", "max_turns",
                 "max_generated_tokens", "evaluation_samples", "max_eval_tasks", "checkpoint_every"):
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    for name in ("sft_epochs", "rl_steps"):
        if isinstance(config[name], bool) or not isinstance(config[name], int) or config[name] < 0:
            raise ValueError(f"{name} must be a nonnegative integer")
    if config["group_size"] < 2:
        raise ValueError("group_size must be at least two for group-relative RL")
    for name in ("holdout_fraction", "validation_fraction"):
        if not 0 <= config[name] < 1:
            raise ValueError(f"{name} must be in [0, 1)")
    if config["holdout_fraction"] + config["validation_fraction"] >= 1:
        raise ValueError("held-out fractions must leave training families")
    if not 0 <= config["length_penalty"] < 1:
        raise ValueError("length_penalty must be in [0, 1), so every verified success beats failure")
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
        self._stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            ["node", str(self.repo / "tools/tinker-execution.mjs")], cwd=self.repo,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
        )
        self._selector = selectors.DefaultSelector()
        self._selector.register(self.process.stdout, selectors.EVENT_READ)

    def request(self, op: str, **payload: Any) -> dict:
        self._sequence += 1
        request = {"id": self._sequence, "op": op, **payload}
        assert self.process.stdin is not None
        try:
            self.process.stdin.write((json_text(request) + "\n").encode())
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
                   validation_fraction: float) -> tuple[list[dict], dict]:
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
        ancestors = set()
        for declared in (row.get("ancestors", []), task.get("ancestors", [])):
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
    if "train" not in assignments.values():
        raise ValueError("explicit splits leave no training families")
    output = [copy.deepcopy(row) for row in rows]
    manifest_groups = []
    for component_index, indexes in enumerate(components):
        split = assignments[component_index]
        members = sorted(rows[i]["id"] for i in indexes)
        for index in indexes:
            output[index]["split"] = split
        manifest_groups.append({"split": split, "ids": members,
                                "families": sorted({rows[i]["family"] for i in indexes}),
                                "ancestor_families": sorted({name for i in indexes for name in lineage[i]}),
                                "source_hashes": sorted({source for i in indexes
                                    for source in [rows[i]["sourceHash"], *rows[i].get("sourceHashes", [])]})})
    manifest = {"seed": seed, "holdout_fraction": holdout_fraction,
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
        matches = frozen.get("input_sha256") == input_hash and all(
            split.get(key) == config[key] for key in ("seed", "holdout_fraction", "validation_fraction"))
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
    exported = []
    for task in tasks:
        try:
            exported.append(bridge.request("export", task=task))
        except BridgeError as error:
            raise BridgeError(f"task {task.get('id', '(missing id)')}: {error}") from error
    rows, split_manifest = split_examples(exported, config["seed"], config["holdout_fraction"],
                                          config["validation_fraction"])
    if implementation_identity(repo)["hash"] != implementation["hash"]:
        raise ValueError("implementation changed during dataset export; retry after edits finish")
    manifest = {"schema": "tinker-js-dataset-v1", "input_sha256": input_hash,
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


def compression_reward(success: bool, generated_tokens: int, config: dict) -> float:
    if not success:
        return 0.0
    return 1.0 - config["length_penalty"] * min(generated_tokens / config["max_generated_tokens"], 1.0)


def rollout(bridge: Any, adapter: Any, task: dict, config: dict, seed: int) -> dict:
    """Sample a complete execution, never showing private task fields to the model."""
    started = bridge.request("start", task=task)
    session_id = started["sessionId"]
    messages = copy.deepcopy(started["messages"])
    samples: list[dict] = []
    total = 0
    done = False
    forced_failure = None
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
            response = bridge.request("step", sessionId=session_id, action=text, generatedTokens=total)
            observations = response.get("messages", [])
            if any(observation.get("role") == "assistant" for observation in observations):
                raise BridgeError("environment attempted to insert a teacher assistant correction")
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
            grade.update(success=False, reason=forced_failure)
        grade["success"] = bool(done and grade.get("success") and not forced_failure)
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
    if not rewards or any(not math.isfinite(reward) for reward in rewards):
        raise ValueError("group rewards must be finite and nonempty")
    mean = statistics.fmean(rewards)
    deviation = math.sqrt(statistics.fmean((reward - mean) ** 2 for reward in rewards))
    if deviation < 1e-12:
        return [0.0] * len(rewards)
    return [(reward - mean) / deviation for reward in rewards]


def summarize_records(records: list[dict]) -> dict:
    successes = [record for record in records if record["grade"]["success"]]
    lengths = [record["generated_tokens"] for record in records]
    return {"executions": len(records), "successes": len(successes),
            "complete_execution_accuracy": len(successes) / len(records) if records else None,
            "mean_generated_tokens": statistics.fmean(lengths) if lengths else None,
            "median_generated_tokens": statistics.median(lengths) if lengths else None,
            "mean_successful_tokens": statistics.fmean(record["generated_tokens"] for record in successes)
            if successes else None,
            "incomplete": sum(not record["complete"] for record in records),
            "all_generated_tokens": sum(lengths),
            "mean_reward": statistics.fmean(record["grade"]["reward"] for record in records) if records else None}


def evaluate(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
             stage: str, split: str = "test", *, resume: bool = False,
             checkpoint: str | None = None) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", stage):
        raise ValueError("stage must be a short filename-safe name")
    manifest_path = output_dir / "dataset-manifest.json"
    implementation_hash = json.loads(manifest_path.read_text()).get("implementation_hash") if manifest_path.exists() else None
    selected = sorted((row for row in rows if row["split"] == split), key=lambda row: row["id"])
    selected = selected[:config["max_eval_tasks"]]
    if not selected:
        raise ValueError(f"no {split} tasks are available for evaluation")
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
                or record.get("implementation_hash") != implementation_hash):
            raise ValueError("saved evaluation differs in config, task, or checkpoint")
        completed.add(key)
    write_jsonl(partial, records)
    for row in selected:
        for repeat in range(config["evaluation_samples"]):
            if (row["id"], repeat) in completed:
                continue
            # Stage-independent seeds and task selection permit paired reports.
            seed = int(digest([config["seed"], row["id"], repeat])[:8], 16) % 2147483647
            try:
                record = rollout(bridge, adapter, row["task"], config, seed)
            except RolloutError as error:
                append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                    **error.record, "phase": "evaluation", "stage": stage, "split": split,
                    "repeat": repeat, "configuration_hash": config_fingerprint(config),
                    "sampling_checkpoint": checkpoint})
                raise
            record.update(task_id=row["id"], family=row["family"], source_hash=row["sourceHash"],
                          stage=stage, split=split, repeat=repeat,
                          configuration_hash=config_fingerprint(config), model=config["model"],
                          task_hash=digest(row["task"]), sampling_checkpoint=checkpoint,
                          implementation_hash=implementation_hash)
            records.append(record)
            append_jsonl(partial, record)
            print(f"{stage}: {row['id']} sample {repeat + 1}: success={record['grade']['success']} "
                  f"tokens={record['generated_tokens']}", file=sys.stderr, flush=True)
    partial.replace(destination)
    summary = summarize_records(records)
    atomic_json(output_dir / "evaluations" / f"{stage}-{split}.summary.json", summary)
    return summary


def _restore_tuples(value: Any) -> Any:
    return tuple(_restore_tuples(item) for item in value) if isinstance(value, list) else value


def config_fingerprint(config: dict) -> str:
    return digest({key: value for key, value in config.items() if key != "output_dir"})


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
        if state.get("rng_state"):
            rng.setstate(_restore_tuples(state["rng_state"]))
        return state, rng
    state = {"schema": "tinker-js-run-v1", "config_hash": config_fingerprint(config),
             "dataset_hash": manifest["dataset_hash"], "split_hash": manifest["split_manifest"]["hash"],
             "implementation_hash": manifest.get("implementation_hash"), "git_revision": manifest.get("git_revision"),
             "sft_batches_completed": 0, "rl_steps_completed": 0, "phase": "created",
             "rl_optimizer_updates": 0,
             "training_path": None, "sampler_path": None, "evaluations": [], "backend": "tinker"}
    return state, rng


def save_state(output_dir: Path, state: dict, rng: random.Random) -> None:
    state["rng_state"] = rng.getstate()
    atomic_json(output_dir / "state.json", state)


def save_checkpoint(adapter: Any, output_dir: Path, state: dict, rng: random.Random, name: str) -> None:
    saved = adapter.checkpoint(name)
    if not saved.get("training_path") or not saved.get("sampler_path"):
        raise RuntimeError("checkpoint must contain optimizer-resumable state and separate sampler weights")
    state.update(saved)
    if state["phase"] == "sft_done":
        state.update(sft_training_path=saved["training_path"], sft_sampler_path=saved["sampler_path"])
    save_state(output_dir, state, rng)
    append_jsonl(output_dir / "checkpoints.jsonl", {"name": name, **copy.deepcopy(state)})


def train_sft(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
              state: dict, rng: random.Random) -> None:
    if state["phase"] in ("rl", "rl_done"):
        raise ValueError("cannot restart the SFT stage after RL in the same run directory")
    if state["phase"] == "sft_done":
        return
    train_rows = sorted((row for row in rows if row["split"] == "train"), key=lambda row: row["id"])
    if not train_rows:
        raise ValueError("no training rows")
    adapter.create_training_client(checkpoint=state.get("training_path"))
    batch_index = 0
    for epoch in range(config["sft_epochs"]):
        ordered = list(train_rows)
        random.Random(config["seed"] + epoch).shuffle(ordered)
        for start in range(0, len(ordered), config["batch_size"]):
            batch_index += 1
            if batch_index <= state["sft_batches_completed"]:
                continue
            batch = ordered[start:start + config["batch_size"]]
            metrics = adapter.sft_train([{"messages": row["messages"]} for row in batch])
            state.update(sft_batches_completed=batch_index, phase="sft")
            append_jsonl(output_dir / "metrics.jsonl", {"stage": "sft", "batch": batch_index,
                         "epoch": epoch, "ids": [row["id"] for row in batch], "metrics": metrics})
            if batch_index % config["checkpoint_every"] == 0:
                save_checkpoint(adapter, output_dir, state, rng, f"sft-{batch_index:06d}")
    state["phase"] = "sft_done"
    save_checkpoint(adapter, output_dir, state, rng, f"sft-final-{batch_index:06d}")
    adapter.refresh_sampler()


def train_rl(bridge: Any, adapter: Any, rows: list[dict], config: dict, output_dir: Path,
             state: dict, rng: random.Random, training_ready: bool = False) -> None:
    if state["phase"] == "rl_done":
        return
    train_rows = sorted((row for row in rows if row["split"] == "train"), key=lambda row: row["id"])
    if not train_rows:
        raise ValueError("no training rows")
    if not training_ready:
        adapter.create_training_client(checkpoint=state.get("training_path"))
    adapter.refresh_sampler()
    for step in range(state["rl_steps_completed"], config["rl_steps"]):
        row = train_rows[rng.randrange(len(train_rows))]
        seeds = [rng.randrange(2147483647) for _ in range(config["group_size"])]
        group_context = digest({"step": step + 1, "task": row["task"], "seeds": seeds,
                                "config_hash": config_fingerprint(config),
                                "implementation_hash": state.get("implementation_hash"),
                                "training_checkpoint": state.get("training_path"),
                                "optimizer_updates": state.get("rl_optimizer_updates", 0)})
        destination = output_dir / "rollouts" / f"rl-{step + 1:06d}.jsonl"
        partial = destination.with_suffix(".partial.jsonl")
        records = read_jsonl(destination if destination.exists() else partial) if destination.exists() or partial.exists() else []
        if len(records) > config["group_size"] or any(
                record.get("group_context") != group_context or record.get("seed") != seeds[index]
                for index, record in enumerate(records)):
            raise ValueError("saved RL group differs in task, seeds, configuration, or policy checkpoint")
        write_jsonl(partial, records)
        for seed in seeds[len(records):]:
            try:
                record = rollout(bridge, adapter, row["task"], config, seed)
            except RolloutError as error:
                append_jsonl(output_dir / "infrastructure-errors.jsonl", {
                    **error.record, "phase": "rl", "step": step + 1,
                    "group_context": group_context, "configuration_hash": config_fingerprint(config)})
                raise
            record.update(group_context=group_context, task_id=row["id"], family=row["family"],
                          source_hash=row["sourceHash"], split="train", step=step + 1)
            records.append(record)
            append_jsonl(partial, record)
        advantages = group_advantages([record["grade"]["reward"] for record in records])
        for record, advantage in zip(records, advantages):
            record.update(task_id=row["id"], family=row["family"], source_hash=row["sourceHash"],
                          split="train", step=step + 1, advantage=advantage)
        write_jsonl(destination, records)
        partial.unlink(missing_ok=True)
        if any(sample.get("provenance_error") for record in records for sample in record["samples"]):
            raise RuntimeError("sampled RL provenance is invalid; saved raw rollout and aborted the entire update")
        nonzero = [record for record in records if abs(record["advantage"]) > 1e-12]
        if nonzero:
            metrics = adapter.rl_train([{"samples": record["samples"], "advantage": record["advantage"]}
                                        for record in nonzero])
            state["rl_optimizer_updates"] = state.get("rl_optimizer_updates", 0) + 1
            adapter.refresh_sampler()
        else:
            metrics = {"skipped": True, "reason": "all rewards equal; zero policy-gradient advantage"}
        state.update(rl_steps_completed=step + 1, phase="rl")
        append_jsonl(output_dir / "metrics.jsonl", {"stage": "rl", "step": step + 1,
                     "task_id": row["id"], **summarize_records(records), "metrics": metrics})
        if (step + 1) % config["checkpoint_every"] == 0:
            save_checkpoint(adapter, output_dir, state, rng, f"rl-{step + 1:06d}")
    state["phase"] = "rl_done"
    save_checkpoint(adapter, output_dir, state, rng, f"rl-final-{state['rl_steps_completed']:06d}")


def make_report(output_dir: Path, config: dict | None = None) -> dict:
    config = config or json.loads((output_dir / "config.json").read_text())
    stages: dict[str, list[dict]] = {}
    for path in sorted((output_dir / "evaluations").glob("*-test.jsonl")):
        stages[path.name.removesuffix("-test.jsonl")] = read_jsonl(path)
    report: dict[str, Any] = {"schema": "tinker-js-report-v1", "model": config["model"],
        "backend": "tinker", "generated_token_scope": "All sampled token IDs, including reasoning, protocol formatting and stop tokens",
        "test_used_for": "fixed final comparisons only; never gradient updates or checkpoint selection",
        "stages": {name: summarize_records(rows) for name, rows in stages.items()}, "paired": {}}
    manifest_path = output_dir / "dataset-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        report.update(dataset_hash=manifest["dataset_hash"], split_hash=manifest["split_manifest"]["hash"],
                      implementation_hash=manifest.get("implementation_hash"), git_revision=manifest.get("git_revision"))
    for rows in stages.values():
        if any(row.get("backend") != "tinker" for row in rows):
            raise ValueError("a Tinker performance report cannot contain fixture/mock backend records")
        if any(row.get("configuration_hash") != config_fingerprint(config) for row in rows):
            raise ValueError("evaluation configuration differs; use separate run directories")
        if any(row.get("implementation_hash") != report.get("implementation_hash") for row in rows):
            raise ValueError("evaluation implementation differs; use separate run directories")
    errors_path = output_dir / "infrastructure-errors.jsonl"
    errors = read_jsonl(errors_path) if errors_path.exists() else []
    report["interrupted_attempts"] = {"attempts": len(errors),
        "received_generated_tokens": sum(record["generated_tokens"] for record in errors),
        "note": "Infrastructure failures abort updates and are excluded from model accuracy; all received sample tokens remain in the audit."}
    baseline = {(row["task_id"], row.get("repeat", 0)): row for row in stages.get("baseline", [])}
    for name, rows in stages.items():
        if name == "baseline":
            continue
        pairs = []
        for row in rows:
            before = baseline.get((row["task_id"], row.get("repeat", 0)))
            if before is None:
                continue
            if before.get("source_hash") != row.get("source_hash") or before.get("seed") != row.get("seed"):
                raise ValueError("paired evaluation requires identical sources and sampling seeds")
            pairs.append({"task_id": row["task_id"], "repeat": row.get("repeat", 0),
                          "baseline_success": before["grade"]["success"], "success": row["grade"]["success"],
                          "baseline_tokens": before["generated_tokens"], "tokens": row["generated_tokens"]})
        both = [pair for pair in pairs if pair["baseline_success"] and pair["success"]]
        report["paired"][name] = {"matched_executions": len(pairs), "both_correct": len(both),
            "accuracy_change": statistics.fmean(int(pair["success"]) - int(pair["baseline_success"])
                                                 for pair in pairs) if pairs else None,
            "mean_token_change": statistics.fmean(pair["tokens"] - pair["baseline_tokens"] for pair in pairs)
            if pairs else None,
            "mean_token_change_when_both_correct": statistics.fmean(pair["tokens"] - pair["baseline_tokens"]
                                                                      for pair in both) if both else None,
            "executions": pairs}
    state_path = output_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
        report.update(checkpoint={key: state.get(key) for key in ("training_path", "sampler_path")},
                      dataset_hash=state.get("dataset_hash"), split_hash=state.get("split_hash"),
                      implementation_hash=state.get("implementation_hash"), git_revision=state.get("git_revision"),
                      training_updates={"sft_batches": state.get("sft_batches_completed", 0),
                                        "rl_optimizer_steps": state.get("rl_optimizer_updates", 0)})
    atomic_json(output_dir / "report.json", report)
    lines = ["# JavaScript execution training report", "", f"Model: `{config['model']}`", "",
             "All sampled tokens count, including reasoning and formatting. Accuracy requires the complete "
             "return/exception, input mutations, and externally visible behavior to match.", "",
             "| Stage | Executions | Complete accuracy | Mean generated tokens | Mean successful tokens | Incomplete |",
             "| --- | ---: | ---: | ---: | ---: | ---: |"]
    ordered_stages = ["baseline", "sft", "rl"] + sorted(set(report["stages"]) - {"baseline", "sft", "rl"})
    for name in ordered_stages:
        if name not in report["stages"]:
            continue
        summary = report["stages"][name]
        accuracy = summary["complete_execution_accuracy"]
        mean = summary["mean_generated_tokens"]
        successful = summary["mean_successful_tokens"]
        lines.append(f"| {name} | {summary['executions']} | {accuracy:.1%} | {mean:.1f} | "
                     f"{successful if successful is not None else '—'} | {summary['incomplete']} |")
    if not report["stages"]:
        lines.extend(["", "No live model evaluation has been recorded."])
    lines.extend(["", "Held-out source families are fixed before training. Test results are reporting only; "
                  "the runner never uses test trajectories for updates or checkpoint selection.", "",
                  "`report.json` includes paired task-level comparisons and checkpoint paths. "
                  "Small fixture runs establish plumbing; a compression claim requires a larger held-out evaluation.", ""])
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
                response = bridge.request("step", sessionId=session, action=visible_text(message), generatedTokens=0)
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
    """Render actual SFT data and initial rollout prompts without model compute."""
    train_examples = 0
    train_tokens = []
    prompt_tokens = []
    for row in rows:
        try:
            if row["split"] == "train":
                datums = adapter.render_sft(row["messages"])
                train_examples += len(datums)
                for datum in datums:
                    train_tokens.append(len(datum.loss_fn_inputs["target_tokens"].data))
            started = bridge.request("start", task=row["task"])
            try:
                checked = adapter.validate_prompt(started["messages"], max_tokens=config["max_tokens"])
                prompt_tokens.append(checked["prompt_tokens"])
            finally:
                bridge.request("close", sessionId=started["sessionId"])
        except Exception as error:
            raise ValueError(f"token preflight for task {row['id']}: {error}") from error
    return {"training_datums": train_examples, "max_training_tokens": max(train_tokens, default=0),
            "initial_prompts": len(prompt_tokens), "max_initial_prompt_tokens": max(prompt_tokens, default=0),
            "reserved_output_tokens": config["max_tokens"], "context_limit": config["max_context_tokens"],
            "model_sampled": False}


def _backend(config: dict) -> Any:
    from .adapter import TinkerAdapter
    return TinkerAdapter(config)


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
    parser.add_argument("--live", action="store_true", help="For check: query service capabilities without model compute")
    parser.add_argument("--skip-sdk", action="store_true", help="For check: validate CPU fixtures without installing the SDK")
    args = parser.parse_args(argv)
    try:
        repo = args.repo.resolve()
        config_path = args.config
        if config_path is not None and not config_path.is_absolute():
            config_path = repo / config_path
        config = load_config(config_path, {"output_dir": args.output_dir, "dataset": args.dataset})
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
                split = args.split or ("train" if args.command == "rollout" else "test")
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
                state["training_path"] = args.checkpoint
            atomic_json(output_dir / "config.json", config)
            if args.command == "run":
                if "baseline" not in state["evaluations"]:
                    adapter.create_sampling_client()
                    evaluate(bridge, adapter, rows, config, output_dir, "baseline", resume=args.resume)
                    state["evaluations"].append("baseline")
                    save_state(output_dir, state, rng)
                training_ready = False
                if state["phase"] not in ("sft_done", "rl", "rl_done"):
                    train_sft(bridge, adapter, rows, config, output_dir, state, rng)
                    training_ready = True
                if "sft" not in state["evaluations"]:
                    if not state.get("sft_sampler_path"):
                        raise ValueError("no SFT checkpoint exists for the SFT comparison")
                    adapter.create_sampling_client(checkpoint=state["sft_sampler_path"])
                    evaluate(bridge, adapter, rows, config, output_dir, "sft", resume=args.resume,
                             checkpoint=state["sft_sampler_path"])
                    state["evaluations"].append("sft")
                    save_state(output_dir, state, rng)
                if state["phase"] != "rl_done":
                    train_rl(bridge, adapter, rows, config, output_dir, state, rng, training_ready)
                if "rl" not in state["evaluations"]:
                    adapter.create_sampling_client(checkpoint=state["sampler_path"])
                    evaluate(bridge, adapter, rows, config, output_dir, "rl", resume=args.resume,
                             checkpoint=state["sampler_path"])
                    state["evaluations"].append("rl")
                    save_state(output_dir, state, rng)
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
