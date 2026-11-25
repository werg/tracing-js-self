"""Actual forward-weight diagnostics, independent of aggregate API loss metrics."""

import importlib.util
import json
from types import SimpleNamespace
import unittest

from tinker_js.adapter import AdapterError, TinkerAdapter, _supervised_action_kind, _tensor_values
from test_adapter import Future, ModelInput, Trainer, fake_adapter


CALL = {"type": "call", "operation": "read", "arguments": ["x"]}
COMPLETE = {"type": "complete", "kind": "return", "value": 3, "arguments": []}


class Tokenizer:
    pieces = {1: "<|message_system|>", 2: "<|content_text|>", 3: "instruction",
              4: "<|end_message|>", 5: "<|message_model|>", 6: json.dumps(CALL),
              7: "<|content_model_end_sampling|>", 8: "<|message_user|>",
              9: "PRIVATE_FUTURE_OBSERVATION", 10: json.dumps(COMPLETE)}

    def decode(self, tokens):
        return "".join(self.pieces[token] for token in tokens)


TOKENS = [1, 2, 3, 4, 5, 2, 6, 4, 7, 8, 2, 9, 4, 5, 2, 10, 4, 7]
WEIGHTS = [0] * 4 + [1] * 5 + [0] * 4 + [1] * 5
SHORT_TOKENS = [8, 2, 9, 4, 5, 2, 10, 4, 7]
SHORT_WEIGHTS = [0] * 4 + [1] * 5
MESSAGES = [{"role": "user", "content": "Program"},
            {"role": "assistant", "content": json.dumps(CALL)},
            {"role": "user", "content": "PRIVATE_FUTURE_OBSERVATION", "trainable": True},
            {"role": "assistant", "content": json.dumps(COMPLETE)}]


def prepared_adapter(config=None):
    adapter, service, renderer = fake_adapter(config)
    adapter._runtime.tokenizer = Tokenizer()
    renderer.examples = [(ModelInput(TOKENS), WEIGHTS)]
    return adapter, service, renderer


class ForwardDiagnosticsTests(unittest.TestCase):
    def test_original_fractional_weights_and_masked_observations_are_respected(self):
        adapter, service, renderer = prepared_adapter({"sft_weighting": "token"})
        weights = [0] * 4 + [.2] * 5 + [0] * 4 + [.8] * 5
        renderer.examples = [(ModelInput(TOKENS), weights)]
        def forward(datums, loss_fn, **kwargs):
            service.trainer.calls.append(("forward_backward", datums, loss_fn))
            scores = [None] * 3 + [-1] * 5 + [float("nan")] * 4 + [-3] * 5
            return Future(SimpleNamespace(metrics={"loss:sum": 99999}, loss_fn_outputs=[{"logprobs": scores}]))
        service.trainer.forward_backward = forward
        service.trainer.forward = lambda *args, **kwargs: self.fail("diagnostics requested extra model compute")
        result = adapter.sft_train([{"messages": MESSAGES, "metadata": {"tier": 2, "features": ["effects", "mutation"]}}])
        diagnostic = result["metrics"]["sft_diagnostics"]
        self.assertTrue(diagnostic["loss_available"])
        self.assertEqual(diagnostic["total"]["trainable_tokens"], 10)
        self.assertAlmostEqual(diagnostic["total"]["prediction_weight"], 5)
        self.assertAlmostEqual(diagnostic["total"]["weighted_nll_sum"], 13)
        self.assertAlmostEqual(diagnostic["total"]["weighted_mean_nll"], 2.6)
        self.assertAlmostEqual(diagnostic["by_action"]["call_request"]["weighted_nll_sum"], 1)
        self.assertAlmostEqual(diagnostic["by_action"]["completion"]["weighted_nll_sum"], 12)
        self.assertEqual(diagnostic["masked_target_tokens"], 7)
        self.assertEqual(diagnostic["masked_nonassistant_tokens"], 7)
        self.assertEqual(diagnostic["by_tier"]["2"], diagnostic["total"])
        self.assertFalse(renderer.sft_messages[2]["trainable"])
        self.assertEqual([call[0] for call in service.trainer.calls], ["forward_backward", "optim_step"])
        self.assertNotIn("accuracy", diagnostic["total"])

    def test_example_normalization_and_all_disjoint_group_totals_reconcile(self):
        adapter, service, renderer = prepared_adapter({"sft_diagnostic_long_tokens": 8})
        def render(messages, **kwargs):
            return [(ModelInput(TOKENS), WEIGHTS)] if messages[0]["content"] == "long" else [(ModelInput(SHORT_TOKENS), SHORT_WEIGHTS)]
        renderer.build_supervised_examples = render
        def forward(datums, loss_fn, **kwargs):
            return Future(SimpleNamespace(metrics={"loss:sum": .00001}, loss_fn_outputs=[
                {"logprobs": [-1] * 17}, {"logprobs": [-3] * 8}]))
        service.trainer.forward_backward = forward
        examples = [{"messages": [{"role": "user", "content": name}, {"role": "assistant", "content": "target"}],
                     "metadata": {"tier": index + 1, "features": ["feature-" + name]}}
                    for index, name in enumerate(("long", "short"))]
        diagnostic = adapter.sft_train(examples)["metrics"]["sft_diagnostics"]
        self.assertAlmostEqual(diagnostic["total"]["prediction_weight"], 2)
        self.assertAlmostEqual(diagnostic["total"]["weighted_nll_sum"], 4)
        self.assertAlmostEqual(diagnostic["total"]["weighted_mean_nll"], 2)
        self.assertEqual(diagnostic["by_execution_length"]["long"]["trainable_tokens"], 10)
        self.assertEqual(diagnostic["by_execution_length"]["short"]["trainable_tokens"], 5)
        for dimension in ("by_action", "by_execution_length", "by_tier"):
            for field in ("trainable_tokens", "prediction_weight", "weighted_nll_sum"):
                self.assertAlmostEqual(sum(bucket[field] for bucket in diagnostic[dimension].values()),
                                       diagnostic["total"][field])

    def test_unknown_renderer_keeps_loss_and_metadata_without_inventing_action_labels(self):
        adapter, _, _ = fake_adapter()
        diagnostic = adapter.sft_train([{"messages": MESSAGES, "metadata": {"tier": 3}}])["metrics"]["sft_diagnostics"]
        self.assertTrue(diagnostic["loss_available"])
        self.assertEqual(diagnostic["action_boundaries_available_datums"], 0)
        self.assertEqual(set(diagnostic["by_action"]), {"unknown"})
        self.assertAlmostEqual(diagnostic["total"]["weighted_mean_nll"], .2)
        self.assertEqual(diagnostic["by_tier"]["3"], diagnostic["total"])

    def test_unavailable_forward_outputs_do_not_reclassify_a_committed_update_as_failed(self):
        for outputs in (None, [], [{"logprobs": [1]}]):
            adapter, service, _ = prepared_adapter()
            service.trainer.forward_backward = lambda *args, **kwargs: Future(SimpleNamespace(metrics={}, loss_fn_outputs=outputs))
            result = adapter.sft_train([{"messages": MESSAGES, "metadata": {"tier": 1}}])
            diagnostic = result["metrics"]["sft_diagnostics"]
            self.assertEqual(result["step"], 1)
            self.assertEqual(len([call for call in service.trainer.calls if call[0] == "optim_step"]), 1)
            self.assertFalse(diagnostic["loss_available"])
            self.assertEqual(diagnostic["total"]["trainable_tokens"], 10)
            self.assertIsNone(diagnostic["total"]["weighted_nll_sum"])
            self.assertIn("metadata only", diagnostic["source"])

    def test_positive_observation_weight_is_rejected_before_any_update(self):
        adapter, service, renderer = prepared_adapter()
        weights = list(WEIGHTS)
        weights[11] = 1
        renderer.examples = [(ModelInput(TOKENS), weights)]
        with self.assertRaisesRegex(ValueError, "non-assistant"):
            adapter.sft_train([{"messages": MESSAGES}])
        self.assertEqual(service.trainer.calls, [])

    def test_only_valid_final_protocol_actions_get_call_or_completion_labels(self):
        self.assertEqual(_supervised_action_kind("A short trace.\n```json\n" + json.dumps(CALL) + "\n```"), "call_request")
        self.assertEqual(_supervised_action_kind(json.dumps(COMPLETE)), "completion")
        for value in (json.dumps({**COMPLETE, "kind": {}}), json.dumps({"type": "complete"}),
                      "```json\n" + json.dumps(CALL) + "\n``` trailing text", "just explanatory text"):
            self.assertEqual(_supervised_action_kind(value), "unknown")


class TrainingIdentityTests(unittest.TestCase):
    def test_cached_get_info_accepts_only_exact_base_and_rank(self):
        adapter, service, _ = fake_adapter()
        service.trainer.get_info = lambda: SimpleNamespace(
            model_data=SimpleNamespace(model_name="thinkingmachines/Inkling-2-Mini"), lora_rank=32)
        adapter.create_training_client(checkpoint="tinker://source/state")
        self.assertTrue(adapter.training_identity["verified"])
        self.assertTrue(adapter.training_identity["restored_checkpoint"])
        self.assertEqual(service.calls[0][0], "resume")
        self.assertEqual(service.trainer.calls, [])

    def test_other_model_rank_or_arbitrary_alias_cannot_be_used(self):
        for model, rank in (("thinkingmachines/Inkling-2-Small", 32),
                            ("thinkingmachines/Inkling-2-Mini", 64),
                            ("thinkingmachines/Inkling-2-Mini:other-alias", 32)):
            adapter, service, _ = fake_adapter()
            service.trainer.get_info = lambda: SimpleNamespace(model_data=SimpleNamespace(model_name=model), lora_rank=rank)
            with self.assertRaisesRegex(AdapterError, "differs"):
                adapter.create_training_client(checkpoint="tinker://source/state")
            self.assertIsNone(adapter.training_client)
            self.assertEqual(service.trainer.calls, [])

    def test_missing_identity_is_tolerated_only_for_injected_test_runtime(self):
        adapter, _, _ = fake_adapter()
        adapter.create_training_client()
        self.assertFalse(adapter.training_identity["verified"])
        adapter._injected_runtime = False
        with self.assertRaisesRegex(AdapterError, "get_info"):
            adapter.create_training_client()
        self.assertIsNone(adapter.training_client)


@unittest.skipUnless(importlib.util.find_spec("tinker") and importlib.util.find_spec("tml_renderers"), "installed SDK required")
class InstalledRendererDiagnosticsTests(unittest.TestCase):
    def test_actual_tml_masks_and_tensor_outputs_preserve_action_tier_and_length_partition(self):
        adapter = TinkerAdapter({"effort": .5, "sft_diagnostic_long_tokens": 512})
        sdk = adapter._sdk()
        messages = [*MESSAGES]
        messages[2] = {"role": "user", "content": "PRIVATE_OBSERVATION " * 800, "trainable": True}
        class ActualTensorTrainer(Trainer):
            def forward_backward(self, datums, loss_fn, **kwargs):
                self.calls.append(("forward_backward", datums, loss_fn))
                return Future(SimpleNamespace(metrics={"loss:sum": 99999}, loss_fn_outputs=[
                    {"logprobs": sdk.types.TensorData(data=[-.7] * len(_tensor_values(datum.loss_fn_inputs["weights"])),
                                                     dtype="float32", shape=[len(_tensor_values(datum.loss_fn_inputs["weights"]))])}
                    for datum in datums]))
        adapter.training_client = ActualTensorTrainer(None)
        diagnostic = adapter.sft_train([{"messages": messages, "metadata": {"tier": 4, "features": ["external-call"]}}])["metrics"]["sft_diagnostics"]
        self.assertTrue(diagnostic["loss_available"])
        self.assertEqual(diagnostic["action_boundaries_available_datums"], 1)
        self.assertEqual(set(diagnostic["by_action"]), {"call_request", "completion"})
        self.assertEqual(set(diagnostic["by_execution_length"]), {"short"})
        self.assertGreater(diagnostic["masked_nonassistant_tokens"], 512)
        self.assertAlmostEqual(diagnostic["total"]["weighted_mean_nll"], .7, places=6)
        self.assertEqual(diagnostic["by_tier"]["4"], diagnostic["total"])
        for field in ("trainable_tokens", "prediction_weight", "weighted_nll_sum"):
            self.assertAlmostEqual(sum(bucket[field] for bucket in diagnostic["by_action"].values()), diagnostic["total"][field])
        self.assertEqual([call[0] for call in adapter.training_client.calls], ["forward_backward", "optim_step"])

    def test_inkling_thinking_and_text_frames_inherit_turn_action_label(self):
        adapter = TinkerAdapter({"effort": .5})
        sdk = adapter._sdk()
        thinking_messages = [
            {"role": "user", "content": "Program"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "x = 1\nreturn 3"},
                {"type": "text", "text": "```json\n" + json.dumps(COMPLETE) + "\n```"},
            ]},
        ]
        class ActualTensorTrainer(Trainer):
            def forward_backward(self, datums, loss_fn, **kwargs):
                self.calls.append(("forward_backward", datums, loss_fn))
                return Future(SimpleNamespace(metrics={}, loss_fn_outputs=[
                    {"logprobs": sdk.types.TensorData(data=[-.5] * len(_tensor_values(datum.loss_fn_inputs["weights"])),
                                                     dtype="float32", shape=[len(_tensor_values(datum.loss_fn_inputs["weights"]))])}
                    for datum in datums]))
        adapter.training_client = ActualTensorTrainer(None)
        diagnostic = adapter.sft_train([{"messages": thinking_messages, "metadata": {"tier": 1}}])["metrics"]["sft_diagnostics"]
        self.assertEqual(set(diagnostic["by_action"]), {"completion"})
        self.assertAlmostEqual(diagnostic["by_action"]["completion"]["weighted_mean_nll"], .5, places=6)


if __name__ == "__main__":
    unittest.main()
