"""Strict post-inference comparisons of matched canonical v5 learning runs.

The CLI verifies real checkpoint/served/tokenizer artifacts before statistics.
This module never generates predictions, repairs a trace, or supplies labels to
a model. The original evaluator and its independent validators remain authority.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import re

DECLARATION_SCHEMA = "semantic-learning-declaration/1"
LAUNCH_SCHEMA = "semantic-learning-launch/1"
COMPARISON_SCHEMA = "semantic-learning-comparison/1"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def sha256(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 identity")
    return value


def number(value, label, *, positive=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or positive and value <= 0:
        raise ValueError(f"{label} must be a finite {'positive' if positive else 'nonnegative'} measurement")
    return float(value)


def integer(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("An explicit timezone-aware UTC timestamp is required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("A timestamp without timezone cannot establish ordering")
    return parsed.astimezone(timezone.utc)


def sealed(payload):
    return {**payload, "digest": digest(payload)}


def check_seal(document, schema):
    if document.get("schema") != schema or document.get("digest") != digest(
            {key: value for key, value in document.items() if key != "digest"}):
        raise ValueError(f"Missing or changed {schema} declaration")


def served_identity(directory, tokenizer_path):
    """Hash actual files and construct the same raw tokenizer as the evaluator."""
    from megatoken.generation.codec import ByteCodec
    from megatoken.model.config import ARCHITECTURE_VERSION
    from megatoken.controls import CONTROL_SCHEMA_VERSION
    from megatoken.lifecycle import LIFECYCLE_VERSION
    from megatoken.model.multitrack import GROUP_TAPE_VERSION
    directory = Path(directory)
    manifest = read_json(directory / "manifest.json")
    for filename, field in (("model.safetensors", "model_sha256"), ("model_config.json", "config_sha256"),
                            ("transducer.pt", "transducer_sha256"), ("tokenizer.json", "tokenizer_sha256")):
        if file_digest(directory / filename) != manifest.get(field):
            raise ValueError(f"Actual served {filename} differs from its immutable manifest")
    if manifest.get("codec_file") != "tokenizer.json" or manifest.get("training_heads") is not False:
        raise ValueError("A served model with an actual bound tokenizer is required")
    for field, expected in (("format_version", ARCHITECTURE_VERSION), ("control_schema_version", CONTROL_SCHEMA_VERSION),
                            ("lifecycle_version", LIFECYCLE_VERSION), ("tape_version", GROUP_TAPE_VERSION),
                            ("event_addressing", "independent_peer_events")):
        if manifest.get(field) != expected:
            raise ValueError(f"Actual served model has an incompatible {field}")
    sha256(manifest.get("checkpoint_sha256"), "served checkpoint")
    config = read_json(directory / "model_config.json")
    codec = ByteCodec.from_tokenizer_json(tokenizer_path, expected_sha256=manifest["tokenizer_sha256"],
                                         expected_vocab_size=config["vocab_size"])
    if codec.fingerprint != manifest.get("codec_fingerprint"):
        raise ValueError("Actual tokenizer identity differs from the served model")
    integer(manifest.get("model_version"), "served model version")
    return {"checkpointIdentity": manifest["model_sha256"], "trainingCheckpointSha256": manifest["checkpoint_sha256"],
            "tokenizerIdentity": codec.fingerprint, "tokenizerSha256": manifest["tokenizer_sha256"],
            "manifestSha256": file_digest(directory / "manifest.json"), "modelVersion": manifest["model_version"]}


def _same_tensors(left, right):
    import torch
    if isinstance(left, torch.Tensor) or isinstance(right, torch.Tensor):
        return isinstance(left, torch.Tensor) and isinstance(right, torch.Tensor) and left.dtype == right.dtype and torch.equal(left, right)
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_tensors(value, right[key]) for key, value in left.items())
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(_same_tensors(a, b) for a, b in zip(left, right))
    return left == right


def checkpoint_binding(directory, served_directory, actual):
    """Bind real served tensors and bank to the checksummed native training state."""
    import torch
    from safetensors import safe_open
    from megatoken.training.checkpoint import load_checkpoint
    from megatoken.training.semantic_launch import _validate_model_and_masters
    from megatoken.training.config import TrainConfig
    from megatoken.model.config import ModelConfig
    from megatoken.generation.codec import ByteCodec
    directory, served_directory = Path(directory), Path(served_directory)
    # Avoid resolving mutable latest pointers or repairing checkpoint directories.
    if not (directory / "state.pt").is_file() or directory.name.startswith("."):
        raise ValueError("An explicit immutable native checkpoint directory is required")
    payload, metadata = load_checkpoint(directory)
    if metadata["state_sha256"] != actual["trainingCheckpointSha256"] or payload.get("global_step") != actual["modelVersion"]:
        raise ValueError("Served model is not bound to this actual checkpoint")
    if payload.get("codec_fingerprint") != actual["tokenizerIdentity"]:
        raise ValueError("Native checkpoint has a different tokenizer identity")
    native_config = ModelConfig.from_dict(payload["model_config"])
    codec = ByteCodec.from_tokenizer_json(served_directory / "tokenizer.json", expected_sha256=actual["tokenizerSha256"],
                                         expected_vocab_size=native_config.vocab_size)
    _validate_model_and_masters(payload, native_config, codec, TrainConfig.from_dict(payload["train_config"]),
                                coordinator_bootstrap=True)
    with safe_open(served_directory / "model.safetensors", framework="pt", device="cpu") as saved:
        if set(saved.keys()) != set(payload.get("model", {})) or not saved.keys():
            raise ValueError("Served tensor inventory differs from the native checkpoint")
        for name in saved.keys():
            if not _same_tensors(saved.get_tensor(name), payload["model"][name]):
                raise ValueError(f"Served tensor differs from the native checkpoint: {name}")
    expected_config = {**payload["model_config"], "checkpoint_stages": False}
    if read_json(served_directory / "model_config.json") != expected_config:
        raise ValueError("Served model geometry differs from its native checkpoint")
    saved_bank = torch.load(served_directory / "transducer.pt", weights_only=True, map_location="cpu")
    native_bank = torch.load(directory / metadata["transducer_checkpoint"]["file"], weights_only=True, map_location="cpu")
    expected_bank = native_bank.get("bank")
    if not isinstance(expected_bank, dict):
        raise ValueError("Native checkpoint is missing its transducer bank")
    # Native export reloads into a fresh bank. load_snapshot increments its
    # cache-invalidation version once; every semantic row and other field stays exact.
    expected_bank = {**expected_bank, "version": integer(expected_bank.get("version"), "native bank version") + 1}
    if set(saved_bank) != {"bank"} or not _same_tensors(saved_bank["bank"], expected_bank):
        raise ValueError("Served transducer bank differs from its native checkpoint")
    return payload, metadata


def base_artifact_identity(served_directory, checkpoint_directory, tokenizer_path):
    actual = served_identity(served_directory, tokenizer_path)
    payload, _ = checkpoint_binding(checkpoint_directory, served_directory, actual)
    return {**actual, "checkpointMetadataSha256": file_digest(Path(checkpoint_directory) / "metadata.json"),
            "semanticExposure": payload.get("semantic_exposure"), "semanticCohortDigest": payload.get("semantic_cohort_digest")}


def component_map_from_registry(cohort, registry):
    """Project an independently verified frozen registry onto cohort families."""
    if registry.get("schema") != "semantic-source-registry/1" or registry.get("policy") != "source-components/1":
        raise ValueError("A current frozen source/ancestor registry is required")
    family_map = {}
    for component in registry["components"]:
        members = component["members"]
        expected = "component:" + hashlib.sha256(json.dumps(members, separators=(",", ":"),
                                                             ensure_ascii=False).encode()).hexdigest()
        if members != sorted(set(members)) or component["id"] != expected:
            raise ValueError("Frozen component membership or identity changed")
        for member in members:
            if member in family_map:
                raise ValueError("A source or ancestor belongs to multiple frozen components")
            family_map[member] = component["id"]
    for source in registry["sources"]:
        if source["family"] not in family_map or any(family_map.get(ancestor) != family_map[source["family"]]
                                                    for ancestor in source["ancestorIds"]):
            raise ValueError("Frozen ancestry crosses component boundaries")
    families = {case["family"] for case in cohort["cases"]}
    if not families.issubset(family_map):
        raise ValueError("A held-out family is missing from the frozen registry")
    by_component = {component["id"]: component for component in registry["components"]}
    for case in cohort["cases"]:
        component = by_component[family_map[case["family"]]]
        if component["split"] != "test":
            raise ValueError("The evaluation cohort contains a source component assigned outside test")
        programs = case["request"].get("programs")
        if programs is None:
            programs = [case["request"].get("program")]
        sources = {source["source"] for source in registry["sources"] if source["family"] in component["members"]}
        if not programs or any(not isinstance(program, dict) or program.get("source") not in sources for program in programs):
            raise ValueError("Held-out program bytes are not bound to the frozen family/ancestor component")
    return {family: family_map[family] for family in sorted(families)}


def normalized_training_config(config):
    from megatoken.training.config import TrainConfig
    return asdict(TrainConfig.from_dict(config))


def training_template(config):
    """Exclude execution identities, retaining every objective/budget/topology setting."""
    template = {key: value for key, value in config.items() if key not in {"seed", "output"}}
    if isinstance(template.get("decoupled"), dict):
        template["decoupled"] = {key: value for key, value in template["decoupled"].items()
                                  if key not in {"run_id", "coordinator_url"}}
    return template


def prepared_component_inventory(config, registry, codec):
    """Read checksummed native rows, including validation used for model selection."""
    from megatoken.data.storage import PreparedCorpus
    from megatoken.data.recipes import stage_recipe
    from megatoken.training.config import TrainConfig
    from megatoken.training.engine import window_config
    from megatoken.training.stream import MixtureWindowStream, WindowStream, IndependentWindowStream
    from megatoken.training.semantic_budget import SemanticExperimentConfig, validate_stage_supply
    experiment = SemanticExperimentConfig(**config["semantic_experiment"])
    experiment.preflight(phase=config["phase"])
    repositories = read_json(experiment.engineering_receipt)["repositories"]
    supply = validate_stage_supply(config["datasets"], phase=config["phase"],
        representation=config["semantic_experiment"]["representation"], codec=codec,
        producer_revision=repositories["tracing-js-self"], consumer_revision=repositories["megatoken"])
    by_member = {member: component for component in registry["components"] for member in component["members"]}
    counts, used = Counter(), set()
    with PreparedCorpus(config["datasets"], split=None) as corpus:
        for part in corpus.parts:
            for index in range(len(part)):
                split = part.index_entry(index)["split"]
                if split not in {"train", "validation"}:
                    continue
                episode = part[index]
                identities = {episode.lineage.family_id, *episode.lineage.ancestor_ids}
                if any(identity not in by_member for identity in identities):
                    raise ValueError("Actual prepared training lineage is missing from the frozen global registry")
                components = {by_member[identity]["id"] for identity in identities}
                if len(components) != 1 or any(by_member[identity]["split"] != split for identity in identities):
                    raise ValueError("Actual prepared lineage/split disagrees with the frozen source registry")
                if episode.lineage.frozen_split not in {None, split}:
                    raise ValueError("Prepared index and episode split disagree")
                used.update(components)
                counts[split] += 1
        if corpus.codec_fingerprint != codec.fingerprint or corpus.identity != supply["corpusIdentity"]:
            raise ValueError("Native prepared training identity changed during inventory")
    resolved = TrainConfig.from_dict(config)
    windows = window_config(resolved)
    if resolved.use_stage_mixture:
        stream = MixtureWindowStream(config["datasets"], codec, windows, stage_recipe(config["phase"]).mixture,
            resolved.schedule.meter, seed=config["seed"], rank=0, world_size=1, independent=resolved.decoupled is not None)
    else:
        kind = IndependentWindowStream if resolved.decoupled is not None else WindowStream
        stream = kind(PreparedCorpus(config["datasets"]), codec, windows, seed=config["seed"])
    try:
        stream_fingerprint = stream.fingerprint
    finally:
        stream.close()
    return {"schema": "semantic-learning-supply/1", "corpusIdentity": supply["corpusIdentity"],
            "streamFingerprint": stream_fingerprint,
            "components": sorted(used), "episodes": dict(counts), "nativeSupply": supply}


def freeze_declaration(cohort, design, base_identity, *, frozen_at=None):
    from megatoken.training.semantic_evaluation import SEEDS, verify_cohort
    verify_cohort(cohort)
    if any(case["split"] != "test" for case in cohort["cases"]):
        raise ValueError("Learning comparisons require the independently frozen test-only cohort")
    seeds = design.get("optimizerSeeds")
    if not isinstance(seeds, list) or not seeds or seeds != sorted(set(seeds)) or any(seed not in SEEDS for seed in seeds):
        raise ValueError("Declare distinct registered optimizer/evaluation seeds in sorted order")
    mode = design.get("mode")
    if mode not in {"exploratory", "confirmatory"} or mode == "confirmatory" and len(seeds) < 3:
        raise ValueError("Confirmatory comparisons need at least three planned optimizer seeds")
    threshold = number(design.get("minimumPracticalImprovement"), "minimum practical improvement", positive=True)
    if threshold > 1:
        raise ValueError("Accuracy improvement is an absolute proportion, not a percentage")
    seed_threshold = number(design.get("minimumSeedImprovement", 0), "minimum seed improvement")
    confidence = number(design.get("confidenceLevel", 0.95), "confidence level", positive=True)
    if not 0 < confidence < 1:
        raise ValueError("Confidence level must be strictly between zero and one")
    repetitions = integer(design.get("bootstrapReplicates", 10000), "bootstrap replicates", minimum=1000)
    if repetitions > 100000:
        raise ValueError("Bootstrap repetitions exceed the bounded comparison profile")
    bootstrap_seed = integer(design.get("bootstrapSeed", 20261118), "bootstrap seed")
    minimum_components = integer(design.get("minimumIndependentComponents", 20), "minimum independent components", minimum=2)
    families = {case["family"] for case in cohort["cases"]}
    components = design.get("componentByFamily")
    if not isinstance(components, dict) or set(components) != families or any(
            not isinstance(value, str) or not value for value in components.values()):
        raise ValueError("Every frozen family needs exactly one declared source/ancestor component")
    training_components = design.get("trainingComponents", [])
    if not isinstance(training_components, list) or any(not isinstance(value, str) or not value for value in training_components):
        raise ValueError("Training components must be explicit identities")
    if set(training_components).intersection(components.values()):
        raise ValueError("Training ancestry overlaps the held-out components")
    training = design.get("trainingDesign")
    if not isinstance(training, dict) or set(training) != {"templateDigest", "supply", "budget", "phase"}:
        raise ValueError("Freeze a native training configuration, actual prepared inventory and budget before runs")
    sha256(training["templateDigest"], "training template")
    if training["supply"].get("schema") != "semantic-learning-supply/1" or training["supply"].get("components") != sorted(set(training_components)):
        raise ValueError("Training ancestry is not bound to the scanned prepared corpus")
    sha256(training["supply"].get("corpusIdentity"), "prepared corpus")
    if not training_components or any(training["supply"].get("episodes", {}).get(split, 0) < 1 for split in ("train", "validation")):
        raise ValueError("Actual train and validation source inventories are required")
    budget = training["budget"]
    if set(budget) != {"regime", "limit", "maxTokenOvershoot", "representation"} or budget["regime"] not in {"fixed-examples", "fixed-tokens", "measured-compute"} or budget["representation"] != "compact":
        raise ValueError("Freeze the exact native experiment budget policy")
    number(budget["limit"], "declared training budget", positive=True)
    integer(budget["maxTokenOvershoot"], "declared token overshoot")
    case_ids = {case["id"] for case in cohort["cases"]}
    slices = design.get("slices", {})
    if not isinstance(slices, dict):
        raise ValueError("Slices must be explicitly declared before evaluation")
    for name, specification in slices.items():
        ids = specification.get("caseIds") if isinstance(specification, dict) else None
        if not isinstance(name, str) or not name or not isinstance(ids, list) or not ids or len(set(ids)) != len(ids) or not set(ids).issubset(case_ids):
            raise ValueError("A declared slice must name nonempty unique frozen case IDs")
        if number(specification.get("maximumRegression"), "slice maximum regression") > 1:
            raise ValueError("Slice regression bounds are absolute proportions")
    excluded = design.get("excludedCriticalSlices", {})
    if not isinstance(excluded, dict) or set(excluded) - {"effects", "errors", "cleanup"} or set(excluded).intersection(slices) or any(
            not isinstance(reason, str) or not reason.strip() for reason in excluded.values()):
        raise ValueError("Out-of-scope critical slices need explicit pre-run reasons")
    if mode == "confirmatory" and {"effects", "errors", "cleanup"} - set(slices) - set(excluded):
        raise ValueError("Confirmatory designs must declare each critical slice or explicitly exclude it from the claim")
    if design.get("baseKind") not in {"pretrained", "newly-initialized"}:
        raise ValueError("Declare whether the starting checkpoint is pretrained or newly initialized")
    consumer_revision = design.get("consumerRevision")
    if not isinstance(consumer_revision, str) or re.fullmatch(r"[0-9a-f]{40}", consumer_revision) is None:
        raise ValueError("Freeze the exact native consumer revision")
    frozen_at = frozen_at or datetime.now(timezone.utc).isoformat()
    timestamp(frozen_at)
    return sealed({"schema": DECLARATION_SCHEMA, "name": design.get("name", "execution-transfer"),
        "frozenAt": frozen_at, "cohortDigest": cohort["digest"], "cohort": cohort["name"],
        "consumerRevision": consumer_revision,
        "mode": mode, "optimizerSeeds": seeds, "evaluationSeedPolicy": "paired-with-optimizer-seed/1",
        "baseKind": design["baseKind"], "base": base_identity,
        "minimumPracticalImprovement": threshold, "minimumSeedImprovement": seed_threshold,
        "confidenceLevel": confidence, "bootstrapReplicates": repetitions, "bootstrapSeed": bootstrap_seed,
        "minimumIndependentComponents": minimum_components, "componentByFamily": dict(sorted(components.items())),
        "trainingComponents": sorted(set(training_components)), "trainingDesign": training,
        "slices": slices, "excludedCriticalSlices": excluded,
        "componentEvidence": design.get("componentEvidence", {"kind": "explicit-declaration"}),
        "primaryMetric": "family-weighted-whole-task-correctness",
        "evaluationTask": "selected-execution", "analysisLabelsForInference": False})


def verify_declaration(declaration, cohort):
    check_seal(declaration, DECLARATION_SCHEMA)
    if declaration.get("cohortDigest") != cohort.get("digest"):
        raise ValueError("Comparison declaration belongs to another frozen cohort")
    rebuilt = freeze_declaration(cohort, declaration, declaration["base"], frozen_at=declaration["frozenAt"])
    if rebuilt != declaration:
        raise ValueError("Learning declaration is not the canonical pre-run design")


def validate_launch_qualification(declaration, config, inventory, qualification):
    """Keep a production/confirmatory claim behind the existing native preflight."""
    from megatoken.io import content_hash
    if declaration["mode"] == "exploratory" and config["purpose"] == "diagnostic" and qualification is None:
        return False
    required = {"configurationFile", "configuration", "resolvedBindings", "codeRevisions", "engineering",
                "modelGeometry", "tokenizer", "corpus", "donors", "hindsight", "checkpoint",
                "bootstrapProvenance", "outputLocation", "hardware", "coordinator"}
    if config["purpose"] != "production" or not isinstance(qualification, dict):
        raise ValueError("Confirmatory comparisons require actual production native launch qualification")
    if qualification.get("schema") != "semantic-launch-qualification/1" or qualification.get("preflightReady") is not True or qualification.get("optimizerSteps") != 0 or qualification.get("learnerStarted") is not False:
        raise ValueError("Native training launch was not independently qualified before starting")
    if qualification.get("digest") != content_hash({key: value for key, value in qualification.items() if key != "digest"}):
        raise ValueError("Native launch qualification changed")
    gates = qualification.get("gates", {})
    if not required.issubset(gates) or any(gate.get("status") != "passed" for gate in gates.values()):
        raise ValueError("Native launch qualification omits or fails a required gate")
    evidence = {name: gate["evidence"] for name, gate in gates.items()}
    if evidence["configuration"]["resolvedConfigDigest"] != content_hash(config):
        raise ValueError("Native launch qualified a different training configuration")
    if evidence["checkpoint"]["state"]["sha256"] != declaration["base"]["trainingCheckpointSha256"] or evidence["checkpoint"]["metadata"]["sha256"] != declaration["base"]["checkpointMetadataSha256"]:
        raise ValueError("Native launch did not bind the actual frozen starting checkpoint")
    if evidence["checkpoint"].get("mode") not in {"resume", "coordinator-bootstrap"}:
        raise ValueError("Native launch must use the frozen starting checkpoint")
    if evidence["checkpoint"]["mode"] == "coordinator-bootstrap":
        bootstrap = evidence["bootstrapProvenance"]
        coordinator = evidence["coordinator"]
        if not isinstance(bootstrap, dict) or bootstrap.get("schema") != "diloco-bootstrap-provenance/1" or bootstrap.get("source_kind") != "checkpoint" or bootstrap.get("source_checkpoint_state_sha256") != declaration["base"]["trainingCheckpointSha256"] or bootstrap.get("source_checkpoint_metadata_sha256") != declaration["base"]["checkpointMetadataSha256"]:
            raise ValueError("Fresh worker counters require exact native coordinator bootstrap provenance")
        if coordinator.get("bootstrapProvenance") != bootstrap or coordinator.get("bootstrapArtifact", {}).get("sha256") != bootstrap.get("coordinator_bootstrap_sha256"):
            raise ValueError("Native coordinator bootstrap was not independently read and hashed")
    if evidence["tokenizer"]["fingerprint"] != declaration["base"]["tokenizerIdentity"] or evidence["codeRevisions"]["megatoken"]["revision"] != declaration["consumerRevision"]:
        raise ValueError("Native launch changed the frozen tokenizer or consumer")
    if evidence["corpus"] != inventory["nativeSupply"] or evidence["engineering"]["cohortDigest"] != declaration["cohortDigest"]:
        raise ValueError("Native launch changed the held-out cohort or actual prepared training supply")
    return True


def register_launch(declaration, cohort, config, base_identity, inventory, *, started_at=None, qualification=None):
    from megatoken.training.semantic_budget import SemanticExperimentConfig
    verify_declaration(declaration, cohort)
    if base_identity != declaration["base"]:
        raise ValueError("Training launch changed the actual base checkpoint/tokenizer")
    config = normalized_training_config(config)
    seed = config.get("seed")
    if seed not in declaration["optimizerSeeds"] or not config.get("semantic_experiment"):
        raise ValueError("Launch needs a planned seed and a real semantic_experiment budget configuration")
    experiment = SemanticExperimentConfig(**config["semantic_experiment"])
    if experiment.preflight(phase=config["phase"]) != cohort["digest"]:
        raise ValueError("Actual training configuration references a different frozen cohort")
    if digest(training_template(config)) != declaration["trainingDesign"]["templateDigest"] or inventory != declaration["trainingDesign"]["supply"]:
        raise ValueError("Training launch changed the frozen configuration, budget or prepared source inventory")
    qualified = validate_launch_qualification(declaration, config, inventory, qualification)
    started_at = started_at or datetime.now(timezone.utc).isoformat()
    if timestamp(started_at) < timestamp(declaration["frozenAt"]):
        raise ValueError("Learning declaration must be frozen before launch")
    return sealed({"schema": LAUNCH_SCHEMA, "declarationDigest": declaration["digest"],
                   "seed": seed, "startedAt": started_at, "base": base_identity,
                   "trainingConfigDigest": digest(config), "trainingSupply": inventory,
                   "nativeLaunchQualification": qualification, "nativeLaunchQualified": qualified,
                   "cohortDigest": cohort["digest"]})


def bind_training_artifacts(declaration, cohort, launch, served_directory, checkpoint_directory, tokenizer_path):
    """Require native exposure receipt plus positive actual checkpoint optimizer state."""
    verify_declaration(declaration, cohort)
    from megatoken.training.semantic_budget import SemanticExposure, SemanticExperimentConfig
    check_seal(launch, LAUNCH_SCHEMA)
    if launch["declarationDigest"] != declaration["digest"] or launch["base"] != declaration["base"] or launch["cohortDigest"] != cohort["digest"]:
        raise ValueError("Run did not bind this predeclared base checkpoint and cohort")
    if timestamp(launch["startedAt"]) < timestamp(declaration["frozenAt"]):
        raise ValueError("Run precedes its frozen practical threshold")
    served_directory = Path(served_directory)
    actual = served_identity(served_directory, tokenizer_path)
    if actual["tokenizerIdentity"] != declaration["base"]["tokenizerIdentity"] or actual["tokenizerSha256"] != declaration["base"]["tokenizerSha256"]:
        raise ValueError("Trained arm changed the frozen tokenizer")
    if actual["checkpointIdentity"] == declaration["base"]["checkpointIdentity"]:
        raise ValueError("Trained arm has unchanged served model bytes")
    manifest = read_json(served_directory / "manifest.json")
    budget_path = served_directory / "semantic-budget.json"
    if file_digest(budget_path) != manifest.get("semantic_budget_sha256"):
        raise ValueError("A genuine checksummed native semantic optimizer-budget receipt is required")
    budget = read_json(budget_path)
    payload, metadata = checkpoint_binding(checkpoint_directory, served_directory, actual)
    total_steps = integer(payload.get("global_step"), "actual optimizer steps", minimum=1)
    if digest(payload["train_config"]) != launch["trainingConfigDigest"] or payload["train_config"]["seed"] != launch["seed"]:
        raise ValueError("Actual training configuration or optimizer seed differs from launch")
    if digest(training_template(payload["train_config"])) != declaration["trainingDesign"]["templateDigest"] or launch.get("trainingSupply") != declaration["trainingDesign"]["supply"]:
        raise ValueError("Trained arm changed the predeclared replicated experiment")
    if metadata.get("dataset_fingerprint") != declaration["trainingDesign"]["supply"]["streamFingerprint"]:
        raise ValueError("Actual trained checkpoint used another prepared dataset inventory")
    qualified = validate_launch_qualification(declaration, payload["train_config"], launch["trainingSupply"], launch.get("nativeLaunchQualification"))
    if launch.get("nativeLaunchQualified") is not qualified:
        raise ValueError("Launch qualification classification changed")
    mode = launch["nativeLaunchQualification"]["gates"]["checkpoint"]["evidence"]["mode"] if qualified else "resume"
    # A fresh coordinator bootstrap copies parameters into a new worker whose
    # step/exposure counters start at zero. Exact worker resume retains counters.
    baseline_steps = 0 if mode == "coordinator-bootstrap" else declaration["base"]["modelVersion"]
    steps = integer(total_steps - baseline_steps, "new optimizer steps beyond the frozen base", minimum=1)
    if payload.get("semantic_cohort_digest") != cohort["digest"]:
        raise ValueError("Training budget did not bind the frozen test cohort")
    exposure = SemanticExposure.restore(payload["semantic_exposure"])
    config = SemanticExperimentConfig(**payload["train_config"]["semantic_experiment"])
    if {key: getattr(config, {"maxTokenOvershoot": "max_token_overshoot"}.get(key, key)) for key in declaration["trainingDesign"]["budget"]} != declaration["trainingDesign"]["budget"]:
        raise ValueError("Trained arm changed the frozen optimizer budget")
    if not exposure.finished(config):
        raise ValueError("Training stopped before the predeclared comparison budget")
    expected = exposure.receipt(config, seed=launch["seed"], checkpoint_identity=actual["checkpointIdentity"], cohort_digest=cohort["digest"])
    expected["trainingCheckpointSha256"] = metadata["state_sha256"]
    if budget != expected:
        raise ValueError("Native budget differs from actual checkpoint exposure counters")
    for field in ("examples", "generatedTokens", "computeSeconds"):
        number(budget.get(field), "actual training " + field, positive=True)
    number(budget.get("observedTokens"), "actual training observed tokens")
    baseline_exposure = declaration["base"].get("semanticExposure") if mode == "resume" else None
    if baseline_exposure is not None:
        if declaration["base"].get("semanticCohortDigest") != cohort["digest"]:
            raise ValueError("Exact worker resume inherited another semantic cohort's exposure")
        baseline_exposure = SemanticExposure.restore(baseline_exposure).checkpoint()
    new_exposure = {field: budget[field] - (baseline_exposure or {}).get(field, 0)
                    for field in ("examples", "generatedTokens", "observedTokens", "computeSeconds")}
    for field, value in new_exposure.items():
        number(value, "new training exposure " + field, positive=field != "observedTokens")
    moments = payload.get("optimizer", {}).get("moments", {})
    updated = []
    for name, value in moments.items():
        step = number(float(value.get("step", 0)), "actual optimizer owner step")
        if step > 0:
            updated.append(name)
    if not updated:
        raise ValueError("Positive global steps have no actual optimizer-owner updates")
    return {"schema": "semantic-verified-learning-arm/1", "seed": launch["seed"], "served": actual,
            "optimizerSteps": steps, "checkpointGlobalStep": total_steps, "updatedOptimizerOwners": len(updated), "budget": budget,
            "nativeLaunchQualified": qualified,
            "startingCounterPolicy": mode, "newTrainingExposure": new_exposure,
            "launchDigest": launch["digest"], "checkpointMetadataSha256": file_digest(Path(checkpoint_directory) / "metadata.json")}


def _validated_report(cohort, report, origin, seed, checkpoint_identity, tokenizer_identity):
    from megatoken.training.semantic_analysis import COST_FIELDS, analyze_semantic_evaluation
    from megatoken.training.semantic_evaluation import HARD_GATES, OUTCOMES
    analysis = analyze_semantic_evaluation(cohort, report)
    if report["origin"] != origin or origin not in {"fixed-weights", "trained"}:
        raise ValueError("Only paired fixed-weight base and actually trained model reports may be compared")
    if report["seed"] != seed or report["checkpointIdentity"] != checkpoint_identity or report.get("tokenizerIdentity") != tokenizer_identity:
        raise ValueError("Evaluation seed, checkpoint or tokenizer is not the actual paired arm")
    if report.get("evaluationSplits") != ["test"] or report.get("optimizerStepsDuringEvaluation") != 0:
        raise ValueError("Comparison requires test-only inference without optimizer steps during evaluation")
    for row in report["cases"]:
        if set(row.get("hardGates", {})) != set(HARD_GATES) or set(row.get("costs", {})) != set(COST_FIELDS):
            raise ValueError("Missing hard-gate or cost measurements cannot enter a learning comparison")
        if set(row.get("matches", {})) != set(OUTCOMES) and not (row["traceValid"] is False and isinstance(row.get("failure"), str) and row["failure"]):
            raise ValueError("Missing outcome measurements need an explicit terminal invalid-trace failure")
        for field in ("generatedTokens", "observedTokens"):
            integer(row.get(field), field)
        if row.get("generatedTokenBasis") != "original-decoder-token-ids":
            raise ValueError("Learning cost must retain original decoder tokens, including rejected selections")
        sha256(row.get("evidenceDigest"), "original runner evidence digest")
        if row["wholeTaskSuccess"] and (row.get("failure") is not None or row.get("firstSemanticInconsistency") is not None):
            raise ValueError("A positive success contradicts retained failure evidence")
    rows = report["cases"]
    correct = sum(row["wholeTaskSuccess"] for row in rows)
    if report["summary"].get("wholeTaskSuccess") != correct / len(rows):
        raise ValueError("Reported aggregate accuracy contradicts the actual case inventory")
    for field in ("generatedTokens", "observedTokens"):
        if report["summary"].get(field) != sum(row[field] for row in rows):
            raise ValueError("Reported token costs contradict actual cases")
    if report["summary"].get("computeSeconds") != sum(row["costs"]["computeSeconds"] for row in rows):
        raise ValueError("Reported compute costs contradict actual cases")
    if report["summary"].get("hardGates") != {key: sum(row["hardGates"][key] for row in rows) for key in HARD_GATES}:
        raise ValueError("Reported hard-gate aggregate contradicts actual cases")
    return analysis


def _rates(rows, component_by_family):
    by_family, by_component = defaultdict(list), defaultdict(list)
    for row in rows:
        success = int(row["wholeTaskSuccess"])
        by_family[row["family"]].append(success)
        by_component[component_by_family[row["family"]]].append(success)
    mean = lambda values: sum(values) / len(values)
    family_rates = {key: mean(values) for key, values in sorted(by_family.items())}
    component_rates = {key: mean(values) for key, values in sorted(by_component.items())}
    correct = sum(row["wholeTaskSuccess"] for row in rows)
    tokens = sum(row["generatedTokens"] for row in rows)
    seconds = sum(row["latencySeconds"] for row in rows)
    compute = sum(row["costs"]["computeSeconds"] for row in rows)
    return {"cases": len(rows), "correctCases": correct, "declaredFamilies": len(by_family),
            "independentComponents": len(by_component), "episodeWeightedAccuracy": correct / len(rows),
            "traceValidRate": sum(row["traceValid"] for row in rows) / len(rows),
            "familyWeightedAccuracy": mean(list(family_rates.values())),
            "componentWeightedAccuracy": mean(list(component_rates.values())),
            "familyRates": family_rates, "componentRates": component_rates,
            "costs": {"generatedTokens": tokens, "observedTokens": sum(row["observedTokens"] for row in rows),
                      "wallSeconds": seconds, "computeSeconds": compute,
                      "generatedTokensPerCorrectTask": tokens / correct if correct else None,
                      "wallSecondsPerCorrectTask": seconds / correct if correct else None,
                      "computeSecondsPerCorrectTask": compute / correct if correct else None}}


def _interval(matrix, *, confidence, repetitions, seed, weights=None):
    """Crossed paired bootstrap: same resampled components for all sampled seeds."""
    seed_count, component_count = len(matrix), len(matrix[0])
    weights = weights or [1] * component_count
    estimate = sum(sum(value * weight for value, weight in zip(row, weights)) for row in matrix) / (seed_count * sum(weights))
    if component_count < 2:
        return {"estimate": estimate, "lower": None, "upper": None, "identifiable": False,
                "reason": "At least two independent source/ancestor components are required"}
    rng = random.Random(seed)
    draws = []
    for _ in range(repetitions):
        selected_seeds = [rng.randrange(seed_count) for _ in range(seed_count)]
        selected_components = [rng.randrange(component_count) for _ in range(component_count)]
        draws.append(sum(matrix[s][c] * weights[c] for s in selected_seeds for c in selected_components) /
                     (seed_count * sum(weights[c] for c in selected_components)))
    draws.sort()
    alpha = (1 - confidence) / 2
    quantile = lambda p: draws[min(len(draws) - 1, max(0, math.ceil(p * len(draws)) - 1))]
    return {"estimate": estimate, "lower": quantile(alpha), "upper": quantile(1 - alpha),
            "identifiable": True, "confidenceLevel": confidence, "replicates": repetitions,
            "bootstrapSeed": seed, "samplingUnit": "paired-frozen-components-and-optimizer-seeds",
            "optimizerSeeds": seed_count, "independentComponents": component_count,
            "familiesPerComponent": weights}


def compare_validated_runs(declaration, cohort, pairs):
    """Statistics after real artifact binding; caller provides verified arm receipts."""
    from megatoken.training.semantic_evaluation import HARD_GATES
    verify_declaration(declaration, cohort)
    seeds = [pair["seed"] for pair in pairs]
    if len(seeds) != len(set(seeds)) or sorted(seeds) != declaration["optimizerSeeds"]:
        raise ValueError("Every planned seed needs exactly one matched base/trained pair")
    components = sorted(set(declaration["componentByFamily"].values()))
    component_families = {component: sorted(family for family, group in declaration["componentByFamily"].items()
                                           if group == component) for component in components}
    weights = [len(component_families[component]) for component in components]
    results, deltas, all_gates, slice_rows = [], [], Counter(), defaultdict(list)
    for pair in sorted(pairs, key=lambda item: item["seed"]):
        seed, arm = pair["seed"], pair["artifactBinding"]
        if arm.get("schema") != "semantic-verified-learning-arm/1" or arm["seed"] != seed or arm["optimizerSteps"] < 1:
            raise ValueError("Every trained arm needs a positive verified optimizer-budget binding")
        analyses = {}
        for role, origin, identity in (("base", "fixed-weights", declaration["base"]["checkpointIdentity"]),
                                       ("trained", "trained", arm["served"]["checkpointIdentity"])):
            analyses[role] = _validated_report(cohort, pair[role], origin, seed, identity,
                                               declaration["base"]["tokenizerIdentity"])
            all_gates.update(pair[role]["summary"]["hardGates"])
        base = _rates(pair["base"]["cases"], declaration["componentByFamily"])
        trained = _rates(pair["trained"]["cases"], declaration["componentByFamily"])
        delta = [sum(trained["familyRates"][family] - base["familyRates"][family] for family in component_families[component]) /
                 len(component_families[component]) for component in components]
        deltas.append(delta)
        failures = {role: [{"caseId": row["caseId"], "family": row["family"],
                            "component": declaration["componentByFamily"][row["family"]],
                            "failure": row.get("failure"), "failureEvidence": row.get("failureEvidence"),
                            "firstSemanticInconsistency": row.get("firstSemanticInconsistency"),
                            "firstSemanticInconsistencyMeasured": "firstSemanticInconsistency" in row,
                            "evidenceDigest": row["evidenceDigest"]}
                           for row in pair[role]["cases"] if not row["wholeTaskSuccess"]]
                    for role in ("base", "trained")}
        for name, specification in declaration["slices"].items():
            selected = set(specification["caseIds"])
            a = _rates([row for row in pair["base"]["cases"] if row["caseId"] in selected], declaration["componentByFamily"])
            b = _rates([row for row in pair["trained"]["cases"] if row["caseId"] in selected], declaration["componentByFamily"])
            slice_rows[name].append({"seed": seed, "base": a, "trained": b,
                                    "delta": b["familyWeightedAccuracy"] - a["familyWeightedAccuracy"]})
        results.append({"seed": seed, "base": base, "trained": trained,
                        "absoluteCohortGates": {role: {
                            "wholeTaskSuccess": metrics["episodeWeightedAccuracy"] >= cohort["thresholds"]["wholeTaskSuccess"],
                            "traceValid": metrics["traceValidRate"] >= cohort["thresholds"]["traceValid"]}
                            for role, metrics in (("base", base), ("trained", trained))},
                        "delta": {key: trained[key] - base[key] for key in ("episodeWeightedAccuracy", "familyWeightedAccuracy", "componentWeightedAccuracy")},
                        "pairedComponentInterval": _interval([delta], confidence=declaration["confidenceLevel"],
                            repetitions=declaration["bootstrapReplicates"], seed=declaration["bootstrapSeed"] + seed, weights=weights),
                        "budget": arm["budget"], "optimizerSteps": arm["optimizerSteps"], "failures": failures,
                        "artifactBinding": arm, "inputReportDigests": {role: digest(pair[role]) for role in ("base", "trained")},
                        "measurementCoverage": {role: analyses[role]["summary"]["successEvidenceCoverage"] for role in ("base", "trained")}})
    interval = _interval(deltas, confidence=declaration["confidenceLevel"], repetitions=declaration["bootstrapReplicates"], seed=declaration["bootstrapSeed"], weights=weights)
    slices = {}
    for name, rows in slice_rows.items():
        maximum = declaration["slices"][name]["maximumRegression"]
        slices[name] = {"maximumRegression": maximum, "runs": rows,
                        "meanDelta": sum(row["delta"] for row in rows) / len(rows),
                        "noMaterialRegressionEverySeed": all(row["delta"] >= -maximum for row in rows)}
    sufficient_seeds = len(seeds) >= 3
    eligibility = declaration["mode"] == "confirmatory" and sufficient_seeds and len(components) >= declaration["minimumIndependentComponents"]
    gates = {"confirmatoryDesign": eligibility,
             "qualifiedNativeLaunches": all(pair["artifactBinding"].get("nativeLaunchQualified") is True for pair in pairs),
             "positivePairedUncertaintyInterval": interval["lower"] is not None and interval["lower"] > 0,
             "practicalImprovement": interval["estimate"] >= declaration["minimumPracticalImprovement"],
             "consistentAcrossSeeds": all(row["delta"]["familyWeightedAccuracy"] > declaration["minimumSeedImprovement"] for row in results),
             "noIntegrityFailures": not any(all_gates.values()),
             "noDeclaredSliceRegression": all(value["noMaterialRegressionEverySeed"] for value in slices.values())}
    return {"schema": COMPARISON_SCHEMA, "declarationDigest": declaration["digest"], "cohortDigest": cohort["digest"],
            "evidenceScope": "confirmatory" if eligibility else "exploratory", "baseKind": declaration["baseKind"],
            "primaryMetric": declaration["primaryMetric"], "optimizerSeeds": sorted(seeds),
            "casesPerSeed": len(cohort["cases"]), "declaredFamilies": len(declaration["componentByFamily"]),
            "independentComponents": len(components), "pairedImprovement": interval, "runs": results,
            "slices": slices, "criticalSliceStatus": {name: "declared" if name in slices else
                "explicitly-out-of-scope" if name in declaration["excludedCriticalSlices"] else "not-declared-unmeasured"
                for name in ("effects", "errors", "cleanup")},
            "excludedCriticalSlices": declaration["excludedCriticalSlices"],
            "meanAccuracy": {role: {metric: sum(run[role][metric] for run in results) / len(results)
                for metric in ("episodeWeightedAccuracy", "familyWeightedAccuracy", "componentWeightedAccuracy", "traceValidRate")}
                for role in ("base", "trained")},
            "hardGateTotals": {key: all_gates[key] for key in HARD_GATES}, "gates": gates,
            "accepted": all(gates.values()), "acceptanceMeaning": "relative-learning-improvement/1",
            "optimizerStepsDuringComparison": 0,
            "limitations": ["Source/ancestor components, not declared names or repeated episodes, determine independent resampling units.",
                "Bootstrap intervals describe this frozen component collection; they are not a power guarantee or evidence against pretraining contamination.",
                "Pre-run declarations and launch receipts require trusted external retention; checksums are not signatures.",
                "Undeclared behavioral slices remain unmeasured and are not silently scored as passing."],
            "analysisLabelsForInference": False}
