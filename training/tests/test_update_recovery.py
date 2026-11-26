"""Fault injection against the runner's durability boundary, never model evidence."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tinker_js import runner


MANIFEST = {"dataset_hash": "fixture-corpus", "split_manifest": {"hash": "fixture-splits"},
            "implementation_hash": "fixture-implementation"}


def training_rows(count=3):
    return [{"id": str(index), "family": "fixture-family", "sourceHash": f"source-{index}",
             "split": "train", "task": {"id": str(index)}, "metadata": {"features": ["scalar"], "tier": 1},
             "messages": [{"role": "assistant", "content": f"fixture target {index}"}]}
            for index in range(count)]


class CommittedButUnacknowledged(TimeoutError):
    pass


class LocalCrash(BaseException):
    pass


class FixtureService:
    def __init__(self):
        self.optimizers = {}
        self.samplers = {}
        self.commits = []


class RecoveryAdapter:
    backend_name = "fixture"
    training_identity = {"verified": False, "reason": "local durability fixture, no model service"}

    def __init__(self, service, *, fail_update=None, fail_checkpoint=None, output=None):
        self.service = service
        self.fail_update = fail_update
        self.fail_checkpoint = fail_checkpoint
        self.output = output
        self.weights = []
        self.restored = []
        self.sampling_revision = None
        self.calls = []

    def create_training_client(self, checkpoint=None):
        self.restored.append(checkpoint)
        self.weights = copy.deepcopy(self.service.optimizers[checkpoint]) if checkpoint else []

    def create_sampling_client(self, checkpoint=None):
        self.sampling_revision = checkpoint
        if checkpoint:
            self.sampled_weights = copy.deepcopy(self.service.samplers[checkpoint])

    def refresh_sampler(self):
        self.sampled_weights = copy.deepcopy(self.weights)

    def _update(self, method, inputs, options):
        if self.output:
            pending = json.loads((self.output / "pending-update.json").read_text())
            ledger = runner.read_jsonl(self.output / "update-ledger.jsonl")
            assert ledger[-1]["event"] == "submitted"
            assert pending["identity_hash"] == ledger[-1]["identity_hash"]
            persisted = json.loads((self.output / "updates" / f"{pending['attempt_id']}.input.json").read_text())
            assert runner.digest(persisted) == pending["identity"]["input_hash"]
            assert persisted["call"]["method"] == method
            assert persisted["call"].get("examples", persisted["call"].get("trajectories")) == inputs
            assert persisted["call"]["options"] == options
        self.calls.append((method, copy.deepcopy(inputs)))
        commit = len(self.service.commits) + 1
        self.weights.append(commit)
        self.service.commits.append({"method": method, "inputs": copy.deepcopy(inputs), "commit": commit})
        if commit == self.fail_update:
            raise CommittedButUnacknowledged("fixture optimizer committed; acknowledgement was lost")
        return {"fixture_commit": commit, "model_performance_evidence": False}

    def sft_train(self, examples, **options):
        return self._update("sft_train", examples, options)

    def rl_train(self, trajectories, **options):
        return self._update("rl_train", trajectories, options)

    def checkpoint(self, name):
        training = f"fixture://optimizer/{name}"
        sampler = f"fixture://sampler/{name}"
        self.service.optimizers[training] = copy.deepcopy(self.weights)
        self.service.samplers[sampler] = copy.deepcopy(self.weights)
        if name == self.fail_checkpoint:
            raise CommittedButUnacknowledged("fixture checkpoint exists remotely; path acknowledgement was lost")
        return {"training_path": training, "sampler_path": sampler}


class RolloutScript:
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.calls = []

    def __call__(self, bridge, adapter, task, config, seed):
        self.calls.append((seed, adapter.sampling_revision, copy.deepcopy(adapter.sampled_weights)))
        success = next(self.outcomes)
        if success is None:
            raise runner.RolloutError("fixture sampling interruption", {
                "backend": "fixture", "seed": seed, "generated_tokens": 0, "samples": [], "grade": None})
        return {"backend": "fixture", "seed": seed, "generated_tokens": 3, "complete": True,
                "grade": {"success": success, "reward": float(success)}, "samples": [{
                    "prompt_tokens": [10, 20], "token_ids": [seed % 100, 31, 32], "logprobs": [-.2] * 3,
                    "sampler_revision": adapter.sampling_revision,
                    "message": {"role": "assistant", "content": "fixture action"}}]}


class UpdateRecoveryTests(unittest.TestCase):
    def config(self, **overrides):
        return runner.load_config(overrides={"checkpoint_every": 10, "validation_every": 0,
            "sft_epochs": 1, "batch_size": 1, "rl_steps": 3, "group_size": 2, "rl_objective": "compression", **overrides})

    def crash_before_state(self, output, attempt_id):
        real_atomic = runner.atomic_json

        def crash(path, value):
            if path == output / "state.json" and value.get("last_recovered_update") == attempt_id:
                raise LocalCrash("fixture crash after durable recovery receipt, before state replacement")
            return real_atomic(path, value)

        return mock.patch.object(runner, "atomic_json", side_effect=crash)

    def test_sft_timeout_after_commit_is_unknown_and_never_replayed(self):
        config = self.config()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            model = RecoveryAdapter(service, fail_update=2, output=output)
            with self.assertRaises(CommittedButUnacknowledged):
                runner.train_sft(None, model, training_rows(), config, output, state, rng)
            self.assertEqual(len(service.commits), 2)
            disk = json.loads((output / "state.json").read_text())
            self.assertEqual(disk["sft_batches_completed"], 1)
            self.assertEqual(disk["training_path"], "fixture://optimizer/recovery-sft-000001")
            with self.assertRaisesRegex(runner.UpdateRecoveryError, "unknown optimizer outcome"):
                runner.load_state(output, config, MANIFEST, True)
            with self.assertRaisesRegex(runner.UpdateRecoveryError, "unfinished optimizer attempt"):
                runner.train_sft(None, RecoveryAdapter(service), training_rows(), config, output, state, rng)
            self.assertEqual(len(service.commits), 2)
            report = runner.make_report(output, config)
            self.assertFalse(report["model_performance_evidence"])
            self.assertEqual(report["backend"], "fixture")
            self.assertEqual(report["training_updates"]["sft_batches"], 1)
            counts = report["optimizer_attempts"]
            self.assertEqual((counts["submission_attempts"], counts["confirmed_optimizer_updates"],
                              counts["unknown_outcome_attempts"], counts["recovery_checkpointed_updates"]), (2, 1, 1, 1))
            self.assertTrue((output / "updates/sft-000002.input.json").exists())
            self.assertTrue((output / "pending-update.json").exists())

    def test_rl_timeout_retains_exact_group_and_policy_and_refuses_resume(self):
        config = self.config()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            model = RecoveryAdapter(service, fail_update=2, output=output)
            script = RolloutScript([True, False, True, False])
            with mock.patch.object(runner, "rollout", side_effect=script), self.assertRaises(CommittedButUnacknowledged):
                runner.train_rl(None, model, training_rows(1), config, output, state, rng)
            with self.assertRaises(runner.UpdateRecoveryError):
                runner.load_state(output, config, MANIFEST, True)
            inputs = json.loads((output / "updates/rl-000002.input.json").read_text())
            records = runner.read_jsonl(output / "rollouts/rl-000002.jsonl")
            self.assertEqual(inputs["context"]["rollout_hash"], runner.digest(records))
            self.assertEqual(inputs["context"]["policy"]["sampler_path"], "fixture://sampler/recovery-rl-000001")
            self.assertEqual(inputs["call"]["trajectories"], [
                {"samples": row["samples"], "advantage": row["advantage"]} for row in records])
            self.assertTrue(all(sample["sampler_revision"] == records[0]["policy"]["sampler_path"]
                                for row in records for sample in row["samples"]))
            self.assertEqual(len(service.commits), 2)
            self.assertEqual(runner.optimizer_update_accounting(output)["unknown_outcome_attempts"], 1)

    def test_sft_receipt_repairs_state_without_repeating_completed_batches(self):
        config = self.config()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            first = RecoveryAdapter(service, output=output)
            with self.crash_before_state(output, "sft-000002"), self.assertRaises(LocalCrash):
                runner.train_sft(None, first, training_rows(), config, output, state, rng)
            self.assertEqual(json.loads((output / "state.json").read_text())["sft_batches_completed"], 1)
            self.assertTrue((output / "updates/sft-000002.recovery.json").exists())
            state, rng = runner.load_state(output, config, MANIFEST, True)
            self.assertEqual(state["sft_batches_completed"], 2)
            self.assertEqual(state["training_path"], "fixture://optimizer/recovery-sft-000002")
            self.assertFalse((output / "pending-update.json").exists())
            second = RecoveryAdapter(service, output=output)
            runner.train_sft(None, second, training_rows(), config, output, state, rng)
            self.assertEqual(len(first.calls), 2)
            self.assertEqual(len(second.calls), 1)
            self.assertEqual(len(service.commits), 3)
            self.assertEqual(second.restored[0], "fixture://optimizer/recovery-sft-000002")
            self.assertEqual(state["optimizer_lineage"]["sft_updates"], 3)
            counts = runner.optimizer_update_accounting(output)
            self.assertEqual(counts["confirmed_optimizer_updates"], 3)
            self.assertEqual(counts["repaired_on_resume"], 1)
            self.assertEqual(counts["unknown_outcome_attempts"], 0)
            # Cadence 10 does not publish intermediate recovery snapshots.
            names = [row["name"] for row in runner.read_jsonl(output / "checkpoints.jsonl")]
            self.assertEqual(names, ["sft-initial", "sft-final-000003"])

    def test_rl_receipt_restores_rng_and_exact_next_policy(self):
        config = self.config(rl_steps=2)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "interrupted"
            reference = Path(directory) / "uninterrupted"
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            first_script = RolloutScript([True, False])
            with (self.crash_before_state(output, "rl-000001"),
                  mock.patch.object(runner, "rollout", side_effect=first_script), self.assertRaises(LocalCrash)):
                runner.train_rl(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            state, rng = runner.load_state(output, config, MANIFEST, True)
            resumed_script = RolloutScript([True, False])
            with mock.patch.object(runner, "rollout", side_effect=resumed_script):
                runner.train_rl(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            reference_state, reference_rng = runner.load_state(reference, config, MANIFEST, False)
            reference_script = RolloutScript([True, False, True, False])
            with mock.patch.object(runner, "rollout", side_effect=reference_script):
                runner.train_rl(None, RecoveryAdapter(FixtureService()), training_rows(1), config,
                                reference, reference_state, reference_rng)
            self.assertEqual(resumed_script.calls, reference_script.calls[2:])
            self.assertEqual(runner.read_jsonl(output / "rollouts/rl-000002.jsonl"),
                             runner.read_jsonl(reference / "rollouts/rl-000002.jsonl"))
            self.assertEqual(len(service.commits), 2)
            self.assertEqual(state["rl_optimizer_updates"], 2)

    def test_partial_later_group_is_reused_only_with_the_same_durable_sampler(self):
        config = self.config(rl_steps=2)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            service = FixtureService()
            state, rng = runner.load_state(output, config, MANIFEST, False)
            first_script = RolloutScript([True, False, True, None])
            with mock.patch.object(runner, "rollout", side_effect=first_script), self.assertRaises(runner.RolloutError):
                runner.train_rl(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            prefix = runner.read_jsonl(output / "rollouts/rl-000002.partial.jsonl")
            state, rng = runner.load_state(output, config, MANIFEST, True)
            self.assertEqual(state["rl_steps_completed"], 1)
            second_script = RolloutScript([False])
            with mock.patch.object(runner, "rollout", side_effect=second_script):
                runner.train_rl(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            records = runner.read_jsonl(output / "rollouts/rl-000002.jsonl")
            self.assertEqual(records[0]["samples"], prefix[0]["samples"])
            self.assertEqual(second_script.calls[0][1:], first_script.calls[2][1:])
            self.assertEqual(len(service.commits), 2)
            self.assertEqual(len(second_script.calls), 1)
            self.assertEqual(state["rl_generated_tokens"], 12)

    def test_remote_checkpoint_without_receipt_is_confirmed_but_not_recoverable(self):
        config = self.config()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            model = RecoveryAdapter(service, fail_checkpoint="recovery-sft-000001")
            with self.assertRaises(CommittedButUnacknowledged):
                runner.train_sft(None, model, training_rows(), config, output, state, rng)
            self.assertIn("fixture://optimizer/recovery-sft-000001", service.optimizers)
            self.assertFalse((output / "updates/sft-000001.recovery.json").exists())
            with self.assertRaisesRegex(runner.UpdateRecoveryError, "confirmed but missing"):
                runner.load_state(output, config, MANIFEST, True)
            counts = runner.optimizer_update_accounting(output)
            self.assertEqual(counts["confirmed_optimizer_updates"], 1)
            self.assertEqual(counts["unknown_outcome_attempts"], 0)
            self.assertEqual(counts["confirmed_without_recovery_checkpoint"], 1)
            self.assertEqual(len(service.commits), 1)

    def test_crash_after_local_state_before_marker_removal_recovers_idempotently(self):
        config = self.config(checkpoint_every=1)
        real_unlink = Path.unlink

        def fail_marker(path, *args, **kwargs):
            if path.name == "pending-update.json":
                raise LocalCrash("fixture crash after durable state, before marker removal")
            return real_unlink(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            with mock.patch.object(Path, "unlink", fail_marker), self.assertRaises(LocalCrash):
                runner.train_sft(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            self.assertEqual(json.loads((output / "state.json").read_text())["sft_batches_completed"], 1)
            state, rng = runner.load_state(output, config, MANIFEST, True)
            runner.train_sft(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            self.assertEqual(len(service.commits), 1)
            counts = runner.optimizer_update_accounting(output)
            self.assertEqual(counts["state_committed_updates"], 1)
            names = [item["name"] for item in runner.read_jsonl(output / "checkpoints.jsonl")]
            self.assertEqual(names.count("sft-000001"), 1)

    def test_changed_recovery_inputs_and_deleted_marker_both_fail_closed(self):
        for change in ("input", "marker"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                config = self.config()
                state, rng = runner.load_state(output, config, MANIFEST, False)
                service = FixtureService()
                with self.crash_before_state(output, "sft-000001"), self.assertRaises(LocalCrash):
                    runner.train_sft(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
                if change == "input":
                    path = output / "updates/sft-000001.input.json"
                    inputs = json.loads(path.read_text())
                    inputs["call"]["examples"][0]["messages"][0]["content"] = "different input"
                    runner.atomic_json(path, inputs)
                else:
                    (output / "pending-update.json").unlink()
                with self.assertRaises(runner.UpdateRecoveryError):
                    runner.load_state(output, config, MANIFEST, True)
                self.assertEqual(len(service.commits), 1)

    def test_zero_advantage_groups_do_not_claim_optimizer_attempts(self):
        config = self.config(rl_steps=2)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            state, rng = runner.load_state(output, config, MANIFEST, False)
            service = FixtureService()
            with mock.patch.object(runner, "rollout", side_effect=RolloutScript([False] * 4)):
                runner.train_rl(None, RecoveryAdapter(service), training_rows(1), config, output, state, rng)
            self.assertEqual(len(service.commits), 0)
            self.assertEqual(runner.optimizer_update_accounting(output)["submission_attempts"], 0)
            self.assertEqual(state["rl_steps_completed"], 2)
            restored, _ = runner.load_state(output, config, MANIFEST, True)
            self.assertEqual(restored["rl_generated_tokens"], 12)


if __name__ == "__main__":
    unittest.main()
