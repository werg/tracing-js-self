"""Actual native artifact validation on tiny synthetic test fixtures.

Two optimizer steps below optimize an artificial parameter sum, not a semantic
task. Exposure/report fixtures test contracts and make no learning claim.
"""
import copy
from dataclasses import asdict
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from test_learning_comparison import REPO, cohort_for, design_for
import learning_comparison as comparison


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


@pytest.fixture(scope="module")
def artifacts(tmp_path_factory):
    import torch
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers
    from megatoken.data.chunking import ChunkingConfig
    from megatoken.generation.codec import ByteCodec, _byte_alphabet
    from megatoken.loading import build_model
    from megatoken.model.config import ModelConfig
    from megatoken.served import export_served
    from megatoken.training.checkpoint import save_checkpoint, transducer_attachment
    from megatoken.training.config import TrainConfig
    from megatoken.training.optimizer import MasterAdamW
    from megatoken.training.semantic_budget import ENGINEERING_GATES, SemanticExposure

    torch.set_num_threads(1)
    root = tmp_path_factory.mktemp("learning-artifact-fixture")
    cohort = cohort_for(["a", "b"])
    write(root / "cohort.json", cohort)
    write(root / "engineering.json", {"schema": "semantic-engineering-completion/4", "complete": True,
        "optimizerSteps": 0, "repositories": dict.fromkeys(["tracing-js-self", "megatoken", "natlang"], "1" * 40),
        "gates": dict.fromkeys(ENGINEERING_GATES, True)})
    tokenizer = root / "tokenizer.json"
    raw_tokenizer = Tokenizer(models.BPE(vocab=_byte_alphabet(), merges=[]))
    raw_tokenizer.decoder = decoders.ByteLevel()
    raw_tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    raw_tokenizer.save(str(tokenizer))
    codec = ByteCodec.from_tokenizer_json(tokenizer, expected_vocab_size=256)
    experiment = {"schema": "semantic-training-experiment/4", "regime": "fixed-examples", "limit": 2,
                  "max_token_overshoot": 0, "representation": "compact", "cohort": str(root / "cohort.json"),
                  "engineering_receipt": str(root / "engineering.json")}
    config = TrainConfig(purpose="diagnostic", phase="SC", model="tiny", codec=str(tokenizer), device="cpu",
        precision="fp32", seed=17, max_steps=2, microbatch_episodes=1, max_accumulation_windows=1,
        semantic_experiment=experiment, expert_backend="torch", gradient_checkpointing=False)
    resolved = asdict(config)
    model_config = ModelConfig.tiny(expert_backend="torch", checkpoint_stages=False)
    model = build_model(model_config, codec, device="cpu", precision="fp32")
    optimizer = MasterAdamW(model, 0.001, 0)
    exposure = SemanticExposure()
    chunking = ChunkingConfig().with_hard_limit(model_config.max_capacity).identity(codec)
    def save(name, step):
        payload = {"model": model.state_dict(), "optimizer": optimizer.state_dict(), "model_config": model_config.to_dict(),
                   "train_config": resolved, "codec_fingerprint": codec.fingerprint, "packs_fingerprint": None,
                   "chunking": chunking, "global_step": step, "semantic_exposure": exposure.checkpoint(),
                   "semantic_cohort_digest": cohort["digest"]}
        checkpoint = save_checkpoint(root / "checkpoints", name, payload,
            {"dataset_fingerprint": "5" * 64, "global_step": step}, pinned=True,
            attachments=transducer_attachment(lambda: {"bank": model.transducer.bank.state_snapshot()}))
        export_served(checkpoint, root / name, codec_path=str(tokenizer))
        return checkpoint
    base_checkpoint = save("base", 0)
    base = comparison.base_artifact_identity(root / "base", base_checkpoint, tokenizer)
    design = design_for(cohort, mode="exploratory", optimizerSeeds=[17, 29])
    design["trainingDesign"]["templateDigest"] = comparison.digest(comparison.training_template(resolved))
    declaration = comparison.freeze_declaration(cohort, design, base, frozen_at="2026-11-18T00:00:00Z")
    launch = comparison.register_launch(declaration, cohort, resolved, base, design["trainingDesign"]["supply"],
                                        started_at="2026-11-18T00:01:00Z")
    for _ in range(2):
        optimizer.zero_grad()
        next(model.parameters()).sum().backward()
        optimizer.step()
    exposure.consume(examples=2, generatedTokens=20, observedTokens=30, computeSeconds=0.25)
    trained_checkpoint = save("trained", 2)
    optimizer.close()
    return {"root": root, "base": base, "baseCheckpoint": base_checkpoint, "checkpoint": trained_checkpoint,
            "tokenizer": tokenizer, "cohort": cohort, "declaration": declaration, "launch": launch, "config": resolved}


def bind(bundle, *, root=None, checkpoint=None, launch=None, declaration=None):
    return comparison.bind_training_artifacts(declaration or bundle["declaration"], bundle["cohort"], launch or bundle["launch"],
        root or bundle["root"] / "trained", checkpoint or bundle["checkpoint"], bundle["tokenizer"])


def test_actual_native_checkpoint_tokenizer_and_budget_are_bound(artifacts):
    bound = bind(artifacts)
    assert bound["optimizerSteps"] == 2 and bound["updatedOptimizerOwners"] >= 1
    assert bound["budget"]["schema"] == "semantic-experiment-budget/4"
    assert bound["served"]["checkpointIdentity"] != artifacts["base"]["checkpointIdentity"]


@pytest.mark.parametrize("filename", ["model.safetensors", "model_config.json", "transducer.pt", "tokenizer.json", "semantic-budget.json"])
def test_actual_served_file_tampering_fails(artifacts, tmp_path, filename):
    served = tmp_path / "served"
    shutil.copytree(artifacts["root"] / "trained", served)
    with (served / filename).open("ab") as handle:
        handle.write(b"changed")
    with pytest.raises(ValueError):
        bind(artifacts, root=served)


def test_rehashed_served_weights_cannot_detach_from_actual_checkpoint(artifacts, tmp_path):
    from safetensors.torch import load_file, save_file
    served = tmp_path / "served"
    shutil.copytree(artifacts["root"] / "trained", served)
    tensors = load_file(served / "model.safetensors")
    name = next(name for name, tensor in tensors.items() if tensor.is_floating_point())
    tensors[name] = tensors[name] + 1
    save_file(tensors, served / "model.safetensors")
    manifest = comparison.read_json(served / "manifest.json")
    manifest["model_sha256"] = comparison.file_digest(served / "model.safetensors")
    write(served / "manifest.json", manifest)
    with pytest.raises(ValueError, match="Served tensor differs"):
        bind(artifacts, root=served)


def test_rehashed_budget_cannot_invent_exposure(artifacts, tmp_path):
    served = tmp_path / "served"
    shutil.copytree(artifacts["root"] / "trained", served)
    budget = comparison.read_json(served / "semantic-budget.json")
    budget["examples"] = 100
    write(served / "semantic-budget.json", budget)
    manifest = comparison.read_json(served / "manifest.json")
    manifest["semantic_budget_sha256"] = comparison.file_digest(served / "semantic-budget.json")
    write(served / "manifest.json", manifest)
    with pytest.raises(ValueError, match="actual checkpoint exposure"):
        bind(artifacts, root=served)


def test_changed_checkpoint_bytes_and_pretrained_steps_do_not_count_as_new_training(artifacts, tmp_path):
    checkpoint = tmp_path / "checkpoint"
    shutil.copytree(artifacts["checkpoint"], checkpoint)
    with (checkpoint / "state.pt").open("ab") as handle:
        handle.write(b"changed")
    with pytest.raises(ValueError, match="checksum"):
        bind(artifacts, checkpoint=checkpoint)
    declaration = copy.deepcopy(artifacts["declaration"])
    declaration["base"]["modelVersion"] = 2
    declaration = comparison.sealed({key: value for key, value in declaration.items() if key != "digest"})
    launch = copy.deepcopy(artifacts["launch"])
    launch.update(base=declaration["base"], declarationDigest=declaration["digest"])
    launch = comparison.sealed({key: value for key, value in launch.items() if key != "digest"})
    with pytest.raises(ValueError, match="new optimizer steps"):
        bind(artifacts, declaration=declaration, launch=launch)


def test_changed_seed_budget_inventory_or_start_order_cannot_be_registered(artifacts):
    bundle = artifacts
    args = [bundle["declaration"], bundle["cohort"], copy.deepcopy(bundle["config"]), bundle["base"],
            copy.deepcopy(bundle["declaration"]["trainingDesign"]["supply"])]
    args[2]["seed"] = 29
    comparison.register_launch(*args, started_at="2026-11-18T00:01:00Z")
    args[2]["semantic_experiment"]["limit"] = 3
    with pytest.raises(ValueError, match="frozen configuration"):
        comparison.register_launch(*args, started_at="2026-11-18T00:01:00Z")
    args[2] = bundle["config"]
    args[4]["corpusIdentity"] = "0" * 64
    with pytest.raises(ValueError, match="source inventory"):
        comparison.register_launch(*args, started_at="2026-11-18T00:01:00Z")
    args[4] = bundle["declaration"]["trainingDesign"]["supply"]
    with pytest.raises(ValueError, match="before launch"):
        comparison.register_launch(*args, started_at="2026-11-17T23:00:00Z")


def qualification_fixture(bundle):
    """Synthetic qualification structure only; never a deployable receipt."""
    from megatoken.io import content_hash
    config = {**bundle["config"], "purpose": "production"}
    declaration, inventory = bundle["declaration"], bundle["declaration"]["trainingDesign"]["supply"]
    names = {"configurationFile", "configuration", "resolvedBindings", "codeRevisions", "engineering",
             "modelGeometry", "tokenizer", "corpus", "donors", "hindsight", "checkpoint", "bootstrapProvenance",
             "outputLocation", "hardware", "coordinator"}
    gates = {name: {"status": "passed", "evidence": {}} for name in names}
    for key, value in {
        "configuration": {"resolvedConfigDigest": content_hash(config)},
        "checkpoint": {"mode": "resume", "state": {"sha256": bundle["base"]["trainingCheckpointSha256"]},
                       "metadata": {"sha256": bundle["base"]["checkpointMetadataSha256"]}},
        "tokenizer": {"fingerprint": bundle["base"]["tokenizerIdentity"]},
        "codeRevisions": {"megatoken": {"revision": declaration["consumerRevision"]}},
        "corpus": inventory["nativeSupply"], "engineering": {"cohortDigest": declaration["cohortDigest"]},
    }.items():
        gates[key]["evidence"] = copy.deepcopy(value)
    qualification = {"schema": "semantic-launch-qualification/1", "preflightReady": True,
                     "optimizerSteps": 0, "learnerStarted": False, "gates": gates}
    return config, inventory, {**qualification, "digest": content_hash(qualification)}


@pytest.mark.parametrize("mutation", [
    lambda q: q.update(preflightReady=False),
    lambda q: q["gates"].pop("hardware"),
    lambda q: q["gates"]["coordinator"].update(status="blocked"),
    lambda q: q["gates"]["configuration"]["evidence"].update(resolvedConfigDigest="0" * 64),
    lambda q: q["gates"]["checkpoint"]["evidence"]["state"].update(sha256="0" * 64),
    lambda q: q["gates"]["engineering"]["evidence"].update(cohortDigest="0" * 64),
    lambda q: q["gates"]["checkpoint"]["evidence"].update(mode="fresh"),
    lambda q: q["gates"]["checkpoint"]["evidence"].update(mode="coordinator-bootstrap"),
])
def test_native_launch_qualification_cannot_hide_missing_or_changed_inputs(artifacts, mutation):
    from megatoken.io import content_hash
    config, inventory, qualification = qualification_fixture(artifacts)
    assert comparison.validate_launch_qualification(artifacts["declaration"], config, inventory, qualification)
    mutation(qualification)
    qualification["digest"] = content_hash({key: value for key, value in qualification.items() if key != "digest"})
    with pytest.raises(ValueError):
        comparison.validate_launch_qualification(artifacts["declaration"], config, inventory, qualification)


def test_diagnostic_registration_cannot_make_a_confirmatory_claim(artifacts):
    declaration = copy.deepcopy(artifacts["declaration"])
    declaration.update(mode="confirmatory", optimizerSeeds=[17, 29, 43])
    declaration = comparison.sealed({key: value for key, value in declaration.items() if key != "digest"})
    with pytest.raises(ValueError, match="production native launch"):
        comparison.register_launch(declaration, artifacts["cohort"], artifacts["config"], artifacts["base"],
            declaration["trainingDesign"]["supply"], started_at="2026-11-18T00:01:00Z")


def test_cli_rebuilds_source_clone_registry_and_does_not_overwrite(tmp_path):
    spec = importlib.util.spec_from_file_location("learning_cli", REPO / "tools" / "compare-learning-runs.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    script = """import {buildSourceRegistry} from './src/corpus/source-registry.mjs';
console.log(JSON.stringify(buildSourceRegistry([{id:'a',family:'a',source:'function run(x){return x+1;}',project:'test'}],{holdoutProjects:['test']})));"""
    registry = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=REPO, text=True))
    assert cli.verified_registry(registry)["valid"]
    registry["sources"][0]["source"] = "function run(x){return x*2;}"
    with pytest.raises(ValueError, match="reconstruction"):
        cli.verified_registry(registry)
    output = tmp_path / "frozen.json"
    cli.write_new(output, {"threshold": 0.1})
    with pytest.raises(FileExistsError):
        cli.write_new(output, {"threshold": 0.01})
    assert comparison.read_json(output) == {"threshold": 0.1}
