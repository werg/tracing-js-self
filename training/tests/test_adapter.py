"""Loss masking, exact RL provenance, context limits and checkpoint contracts."""

import copy
import importlib.util
import inspect
import unittest
from types import SimpleNamespace

from tinker_js.adapter import (
    DEFAULT_MODEL,
    AdapterError,
    ContextOverflow,
    TinkerAdapter,
    assistant_text,
    rl_token_arrays,
)


class Future:
    def __init__(self, value=None, error=None):
        self.value, self.error = value, error

    def result(self, timeout=None):
        if self.error:
            raise self.error
        return self.value


class ModelInput:
    def __init__(self, tokens):
        self.tokens = list(tokens)

    @classmethod
    def from_ints(cls, tokens):
        return cls(tokens)

    def to_ints(self):
        return list(self.tokens)


class Renderer:
    def __init__(self):
        self.prompt = [10, 11, 12]
        self.sft_messages = None
        self.examples = [(ModelInput([10, 11, 12, 20, 21]), [0, 0, 0, 1, 1])]
        self.termination = SimpleNamespace(value="stop_sequence", is_clean=True)
        self.message = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "retained reasoning"},
                {"type": "text", "text": '{"return":3}'},
            ],
        }

    def build_generation_prompt(self, messages, effort):
        self.prompt_messages = copy.deepcopy(messages)
        self.effort = effort
        return ModelInput(self.prompt)

    def build_supervised_examples(self, messages, train_on_what, effort):
        self.sft_messages = copy.deepcopy(messages)
        self.train_on_what, self.effort = train_on_what, effort
        return self.examples

    def get_stop_sequences(self):
        return [99]

    def parse_response(self, tokens):
        return copy.deepcopy(self.message), self.termination


class Sampler:
    def __init__(self):
        self.sequence = SimpleNamespace(tokens=[51, 52, 99], logprobs=[-0.1, -0.2, -0.3], stop_reason="stop")
        self.calls = []

    def sample(self, **kwargs):
        self.calls.append(kwargs)
        return Future(SimpleNamespace(sequences=[self.sequence]))

    def compute_logprobs(self, prompt, prompt_logprobs_last_n=None):
        self.last_scored_tokens = prompt.to_ints()
        self.last_scored_suffix = prompt_logprobs_last_n
        return Future([None] + [-0.2] * (len(prompt.to_ints()) - 1))


class Trainer:
    def __init__(self, sampler):
        self.sampler = sampler
        self.calls = []
        self.failure = None

    def forward_backward(self, datums, loss_fn, loss_fn_config=None):
        self.calls.append(("forward_backward", datums, loss_fn))
        self.loss_fn_config = loss_fn_config
        return Future(SimpleNamespace(metrics={"loss:sum": 0.5}, loss_fn_outputs=[
            {"logprobs": [-0.2] * len(getattr(d.loss_fn_inputs["target_tokens"], "data", d.loss_fn_inputs["target_tokens"]))} for d in datums]), self.failure)

    def forward(self, datums, loss_fn):
        return Future(SimpleNamespace(metrics={}, loss_fn_outputs=[
            {"logprobs": [-0.3] * len(getattr(d.loss_fn_inputs["target_tokens"], "data", d.loss_fn_inputs["target_tokens"]))} for d in datums]))

    def optim_step(self, params):
        self.calls.append(("optim_step", params))
        return Future(None)

    def save_weights_and_get_sampling_client(self):
        self.calls.append(("refresh",))
        return Future(self.sampler)

    def save_state(self, name):
        self.calls.append(("save_state", name))
        return Future(SimpleNamespace(path=f"tinker://run/weights/{name}"))

    def save_weights_for_sampler(self, name):
        self.calls.append(("save_sampler", name))
        return Future(SimpleNamespace(path=f"tinker://run/sampler_weights/{name}"))


class Service:
    def __init__(self):
        self.sampler = Sampler()
        self.trainer = Trainer(self.sampler)
        self.calls = []

    def create_lora_training_client(self, **kwargs):
        self.calls.append(("create", kwargs))
        return Future(self.trainer)

    def create_training_client_from_state_with_optimizer(self, **kwargs):
        self.calls.append(("resume", kwargs))
        return Future(self.trainer)

    def create_sampling_client(self, **kwargs):
        self.calls.append(("sample", kwargs))
        return Future(self.sampler)


def fake_adapter(config=None):
    service = Service()
    renderer = Renderer()

    def datum_builder(model_input, weights, reduction):
        tokens = model_input.to_ints()
        total = sum(weights[1:])
        return SimpleNamespace(
            model_input=ModelInput(tokens[:-1]),
            loss_fn_inputs={"target_tokens": tokens[1:],
                            "weights": [w / total if reduction == "mean" else w for w in weights[1:]]},
        )

    runtime = SimpleNamespace(
        types=SimpleNamespace(ModelInput=ModelInput, Datum=SimpleNamespace, SamplingParams=SimpleNamespace, AdamParams=SimpleNamespace),
        renderer=renderer,
        renderer_name="tml_v0",
        tokenizer=None,
        datum_builder=datum_builder,
        customized="customized",
        service_factory=lambda: service,
        rest_factory=lambda: SimpleNamespace(
            get_server_capabilities=lambda: Future(SimpleNamespace(supported_models=[SimpleNamespace(model_name=DEFAULT_MODEL)]))
        ),
    )
    return TinkerAdapter(config, runtime=runtime, service_client=service), service, renderer


class AdapterTests(unittest.TestCase):
    def test_exact_rl_shift_masks_original_prompt(self):
        sample = {"prompt_tokens": [9, 8, 7], "token_ids": [30, 31, 99], "logprobs": [-1.1, -2.2, -0.1]}
        arrays = rl_token_arrays(sample, 0.75)
        self.assertEqual(arrays["input_tokens"], [9, 8, 7, 30, 31])
        self.assertEqual(arrays["target_tokens"], [8, 7, 30, 31, 99])
        self.assertEqual(arrays["logprobs"], [0, 0, -1.1, -2.2, -0.1])
        self.assertEqual(arrays["advantages"], [0, 0, 0.75, 0.75, 0.75])

    def test_rl_rejects_missing_or_nonfinite_provenance(self):
        for bad in ([], [None], [float("nan")]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                rl_token_arrays({"prompt_tokens": [1], "token_ids": [2], "logprobs": bad}, 1)

    def test_observations_always_have_zero_sft_loss(self):
        adapter, _, renderer = fake_adapter({"effort": 0.2})
        messages = [
            {"role": "system", "content": "instruction", "trainable": True},
            {"role": "user", "content": "program", "trainable": True},
            {"role": "assistant", "content": "request"},
            {"role": "tool", "content": "private observation", "trainable": True},
            {"role": "assistant", "content": "result"},
        ]
        original = copy.deepcopy(messages)
        data = adapter.render_sft(messages)
        self.assertEqual([m["trainable"] for m in renderer.sft_messages], [False, False, True, False, True])
        self.assertEqual(renderer.train_on_what, "customized")
        self.assertEqual(renderer.effort, 0.2)
        self.assertEqual(messages, original)
        self.assertEqual(data[0].loss_fn_inputs["target_tokens"], [11, 12, 20, 21])
        self.assertEqual(data[0].loss_fn_inputs["weights"], [0, 0, 0.5, 0.5])

    def test_renderer_multiple_supervised_examples_are_all_used(self):
        adapter, service, renderer = fake_adapter()
        renderer.examples *= 2
        result = adapter.sft_train([{"messages": [{"role": "assistant", "content": "result"}]}])
        self.assertEqual(result["examples"], 2)
        self.assertEqual(len(service.trainer.calls[0][1]), 2)
        self.assertEqual(result["step"], 1)

    def test_sft_does_not_silently_truncate(self):
        adapter, service, _ = fake_adapter({"max_context_tokens": 4})
        with self.assertRaises(ContextOverflow):
            adapter.sft_train([{"messages": [{"role": "assistant", "content": "result"}]}])
        self.assertEqual(service.calls, [])

    def test_sample_retains_reasoning_and_every_token(self):
        adapter, service, renderer = fake_adapter()
        result = adapter.sample([{"role": "user", "content": "program"}], seed=7)
        self.assertEqual(result["text"], '{"return":3}')
        self.assertEqual(result["message"], renderer.message)
        self.assertEqual(result["prompt_tokens"], [10, 11, 12])
        self.assertEqual(result["token_ids"], [51, 52, 99])
        self.assertEqual(result["logprobs"], [-0.1, -0.2, -0.3])
        self.assertEqual(result["generated_tokens"], 3)
        self.assertTrue(result["complete"])
        self.assertEqual(service.sampler.calls[0]["sampling_params"].stop, [99])
        self.assertEqual(service.sampler.calls[0]["sampling_params"].seed, 7)
        adapter.sample([{"role": "user", "content": "program"}, result["message"], {"role": "tool", "content": "arrived"}])
        self.assertEqual(renderer.prompt_messages[1]["content"][0]["thinking"], "retained reasoning")

    def test_malformed_enum_is_not_truthy_success(self):
        adapter, _, renderer = fake_adapter()
        renderer.termination = SimpleNamespace(value="malformed", is_clean=False)
        sample = adapter.sample([{"role": "user", "content": "program"}])
        self.assertFalse(sample["complete"])
        self.assertEqual(sample["generated_tokens"], 3)

    def test_sampler_length_stop_is_incomplete(self):
        adapter, service, _ = fake_adapter()
        service.sampler.sequence.stop_reason = "length"
        self.assertFalse(adapter.sample([{"role": "user", "content": "program"}])["complete"])

    def test_missing_sampling_logprobs_preserve_cost_but_reject_rl(self):
        adapter, service, _ = fake_adapter()
        service.sampler.sequence.logprobs = None
        sample = adapter.sample([{"role": "user", "content": "program"}])
        self.assertEqual(sample["generated_tokens"], 3)
        self.assertEqual(sample["token_ids"], [51, 52, 99])
        self.assertFalse(sample["complete"])
        self.assertIn("logprob", sample["provenance_error"])
        with self.assertRaisesRegex(ValueError, "provenance_error"):
            adapter.rl_train([{"samples": [sample], "advantage": 0}])

    def test_parser_failure_and_over_budget_preserve_all_tokens(self):
        adapter, _, renderer = fake_adapter()
        def fail_parse(tokens):
            raise ValueError("broken parse")
        renderer.parse_response = fail_parse
        sample = adapter.sample([{"role": "user", "content": "program"}])
        self.assertEqual(sample["generated_tokens"], 3)
        self.assertFalse(sample["complete"])
        self.assertIn("parse_error", sample)
        self.assertEqual(rl_token_arrays(sample, -1)["advantages"], [0, 0, -1, -1, -1])
        over = adapter.sample([{"role": "user", "content": "program"}], max_tokens=2)
        self.assertEqual(over["generated_tokens"], 3)
        self.assertIn("provenance_error", over)

    def test_dataset_prompt_preflight_uses_exact_render_without_clients(self):
        adapter, service, renderer = fake_adapter({"max_context_tokens": 10, "max_tokens": 4})
        result = adapter.validate_prompt([{"role": "user", "content": "program"}])
        self.assertEqual(result, {"prompt_tokens": 3, "reserved_output_tokens": 4,
                                  "total_tokens": 7, "limit": 10})
        self.assertEqual(service.calls, [])
        self.assertEqual(renderer.prompt_messages[0]["content"], "program")
        with self.assertRaises(ContextOverflow):
            adapter.validate_prompt([{"role": "user", "content": "program"}], max_tokens=8)
        self.assertEqual(service.calls, [])

    def test_sampling_context_reserves_output_before_network(self):
        adapter, service, _ = fake_adapter({"max_context_tokens": 5, "max_tokens": 3})
        with self.assertRaises(ContextOverflow):
            adapter.sample([{"role": "user", "content": "program"}])
        self.assertEqual(service.calls, [])

    def test_multi_turn_rl_uses_each_original_prompt(self):
        adapter, service, _ = fake_adapter()
        samples = [
            {"prompt_tokens": [1, 2], "token_ids": [3, 4], "logprobs": [-0.1, -0.2]},
            {"prompt_tokens": [1, 2, 3, 4, 8, 9], "token_ids": [5], "logprobs": [-0.3]},
        ]
        adapter.rl_train([{"samples": samples, "advantage": -0.25}])
        _, datums, loss_fn = service.trainer.calls[0]
        self.assertEqual(loss_fn, "importance_sampling")
        self.assertEqual(datums[0].model_input.to_ints(), [1, 2, 3])
        self.assertEqual(datums[1].model_input.to_ints(), [1, 2, 3, 4, 8, 9])
        self.assertEqual(datums[1].loss_fn_inputs["advantages"], [0, 0, 0, 0, 0, -0.25])
        self.assertEqual(set(datums[1].loss_fn_inputs), {"target_tokens", "logprobs", "advantages"})

    def test_checkpoint_resume_preserves_optimizer_and_separates_sampler(self):
        adapter, service, _ = fake_adapter()
        adapter.create_training_client(checkpoint="tinker://old/weights/step-10")
        self.assertEqual(service.calls[0], ("resume", {"path": "tinker://old/weights/step-10", "base_model": DEFAULT_MODEL}))
        self.assertIsNone(adapter.sampling_client)
        adapter.refresh_sampler()
        self.assertIs(adapter.sampling_client, service.sampler)
        paths = adapter.checkpoint("step-11")
        self.assertEqual(paths["training_path"], "tinker://run/weights/step-11")
        self.assertEqual(paths["sampler_path"], "tinker://run/sampler_weights/step-11")
        adapter.create_sampling_client(paths["sampler_path"])
        self.assertEqual(service.calls[-1], ("sample", {"model_path": paths["sampler_path"]}))

    def test_no_paid_fallback_and_free_context_bound(self):
        adapter, service, _ = fake_adapter()
        adapter.create_sampling_client()
        self.assertEqual(service.calls[0], ("sample", {"base_model": DEFAULT_MODEL}))
        with self.assertRaises(ValueError):
            TinkerAdapter({"max_context_tokens": 65537})

    def test_mutation_failure_does_not_retry_or_count_step(self):
        adapter, service, _ = fake_adapter()
        service.trainer.failure = TimeoutError("private server detail")
        with self.assertRaisesRegex(AdapterError, "not automatically replayed") as caught:
            adapter.sft_train([{"messages": [{"role": "assistant", "content": "result"}]}])
        self.assertNotIn("private server detail", str(caught.exception))
        self.assertEqual(adapter.training_steps, 0)
        self.assertEqual([c[0] for c in service.trainer.calls], ["forward_backward", "optim_step"])

    def test_invalid_effort_and_empty_supervision(self):
        for value in (1, -0.1, float("nan"), True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                TinkerAdapter({"effort": value})
        adapter, _, _ = fake_adapter()
        with self.assertRaises(ValueError):
            adapter.render_sft([{"role": "tool", "content": "result"}])

    def test_capability_check_is_compute_free(self):
        adapter, service, _ = fake_adapter()
        self.assertTrue(adapter.check(remote=True)["model_available"])
        self.assertEqual(service.calls, [])

    def test_weighting_changes_only_assistant_weight_scale(self):
        equal, _, _ = fake_adapter({"sft_weighting": "example"})
        tokens, _, _ = fake_adapter({"sft_weighting": "token"})
        messages = [{"role": "user", "content": "observation", "trainable": True},
                    {"role": "assistant", "content": "answer"}]
        a, b = equal.render_sft(messages)[0], tokens.render_sft(messages)[0]
        self.assertEqual(a.loss_fn_inputs["target_tokens"], b.loss_fn_inputs["target_tokens"])
        self.assertEqual(a.loss_fn_inputs["weights"], [0, 0, 0.5, 0.5])
        self.assertEqual(b.loss_fn_inputs["weights"], [0, 0, 1, 1])

    def test_separate_stage_rates_and_ppo_configuration_reach_sdk(self):
        adapter, service, _ = fake_adapter()
        adapter.sft_train([{"messages": [{"role": "assistant", "content": "x"}]}], learning_rate=0.003)
        self.assertEqual(service.trainer.calls[1][1].learning_rate, 0.003)
        sample = {"prompt_tokens": [10, 11], "token_ids": [12], "logprobs": [-0.4]}
        result = adapter.rl_train([{"samples": [sample], "advantage": 1}], learning_rate=0.00002,
                                  loss_fn="ppo", loss_fn_config={"clip_low_threshold": 0.9,
                                                                 "clip_high_threshold": 1.1})
        self.assertEqual(service.trainer.loss_fn_config, {"clip_low_threshold": 0.9, "clip_high_threshold": 1.1})
        self.assertEqual(result["learning_rate"], 0.00002)
        self.assertTrue(result["metrics"]["learner_diagnostics_available"])
        self.assertEqual(result["metrics"]["sampler_learner_scored_tokens"], 1)
        self.assertAlmostEqual(result["metrics"]["sampler_learner_sampled_log_ratio_mean"], -0.2)
        with self.assertRaises(ValueError):
            adapter.rl_train([], loss_fn="ppo", loss_fn_config={"clip_high_threshold": 0.9})
        with self.assertRaises(ValueError):
            adapter.rl_train([], loss_fn_config={"clip_low_threshold": 0.9})

    def test_reference_shaping_scores_actual_tokens_and_never_prompt_positions(self):
        adapter, service, _ = fake_adapter({"reference_kl_coef": 0.1, "reference_kl_clip": 0.25})
        adapter.set_reference_checkpoint("tinker://sft/sampler_weights/fixed")
        sample = {"prompt_tokens": [9, 8, 7], "token_ids": [6, 5], "logprobs": [-0.1, -0.8]}
        result = adapter.rl_train([{"samples": [sample], "advantage": 0.5}])
        self.assertEqual(service.sampler.last_scored_tokens, [9, 8, 7, 6, 5])
        self.assertEqual(service.sampler.last_scored_suffix, 2)
        advantages = service.trainer.calls[0][1][0].loss_fn_inputs["advantages"]
        self.assertEqual(advantages[:2], [0, 0])
        self.assertAlmostEqual(advantages[2], 0.49)
        self.assertAlmostEqual(advantages[3], 0.525)
        self.assertEqual(result["metrics"]["reference_kl_shaping_clipped_tokens"], 1)
        self.assertEqual(result["metrics"]["reference_checkpoint"], "tinker://sft/sampler_weights/fixed")
        self.assertEqual(result["metrics"]["sft_reference_scored_tokens"], 2)
        adapter.refresh_sampler()
        with self.assertRaisesRegex(ValueError, "cannot change"):
            adapter.set_reference_checkpoint("tinker://other/sampler_weights/new")

    def test_reference_is_required_and_misalignment_fails_before_update(self):
        adapter, service, _ = fake_adapter({"reference_kl_coef": 0.1})
        sample = {"prompt_tokens": [1, 2], "token_ids": [3], "logprobs": [-0.1]}
        with self.assertRaisesRegex(AdapterError, "fixed SFT"):
            adapter.rl_train([{"samples": [sample], "advantage": 1}])
        adapter.set_reference_checkpoint("tinker://sft/sampler_weights/fixed")
        service.sampler.compute_logprobs = lambda *args, **kwargs: Future([-0.1])
        with self.assertRaisesRegex(AdapterError, "misaligned"):
            adapter.rl_train([{"samples": [sample], "advantage": 1}])
        self.assertEqual(service.trainer.calls, [])

    def test_score_supervision_is_forward_only_with_masked_targets(self):
        adapter, service, _ = fake_adapter()
        result = adapter.score_supervision([{"messages": [{"role": "assistant", "content": "x"}]}])
        self.assertAlmostEqual(result["mean_example_target_logprob"], -0.3)
        self.assertEqual(result["trainable_tokens"], 2)
        self.assertEqual(adapter.training_steps, 0)
        self.assertEqual(service.trainer.calls, [])

    def test_unknown_tokenizer_keeps_all_tokens_unclassified(self):
        adapter, _, _ = fake_adapter()
        self.assertEqual(adapter.token_accounting([1, 2, 3]), {
            "reasoning": 0, "trace": 0, "protocol": 0, "other": 0, "unclassified": 3})


@unittest.skipUnless(importlib.util.find_spec("tinker") and importlib.util.find_spec("tinker_cookbook"), "optional pinned Tinker SDK is not installed")
class InstalledSdkTests(unittest.TestCase):
    def test_pinned_sdk_future_contracts_without_a_network_request(self):
        import tinker
        expected = {
            "create_lora_training_client": "BackcompatTrainingClientFuture",
            "create_training_client_from_state_with_optimizer": "BackcompatTrainingClientFuture",
            "create_sampling_client": "BackcompatSamplingClientFuture",
        }
        for method, return_type in expected.items():
            self.assertEqual(inspect.signature(getattr(tinker.ServiceClient, method)).return_annotation, return_type)
        self.assertEqual(inspect.signature(tinker.RestClient).parameters["_holder"].default, None)
        self.assertIn("timeout", inspect.signature(tinker.APIFuture.result).parameters)

    def test_real_renderer_masks_observations_and_keeps_thinking(self):
        adapter = TinkerAdapter({"effort": 0.2, "max_tokens": 512})
        adapter.check()
        messages = [
            {"role": "user", "content": "readFile('x'); return 3;"},
            {"role": "assistant", "content": '{"op":"observe","name":"readFile","args":["x"]}'},
            {"role": "tool", "name": "readFile", "content": "OBS_ONLY_7931", "trainable": True},
            {"role": "assistant", "content": '{"op":"finish","value":3}'},
        ]
        sdk = adapter._sdk()
        for datum in adapter.render_sft(messages):
            weighted = sdk.tokenizer.decode([
                token for token, weight in zip(datum.loss_fn_inputs["target_tokens"].data, datum.loss_fn_inputs["weights"].data) if weight > 0
            ])
            self.assertNotIn("OBS_ONLY_7931", weighted)
            self.assertIn("finish", weighted)
            self.assertIn("content_model_end_sampling", weighted)
        base = [{"role": "user", "content": "Return 3."}]
        assistant = {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "Add the operands."},
            {"type": "text", "text": '{"op":"finish","value":3}'},
        ]}
        prompt = sdk.renderer.build_generation_prompt(base, effort=adapter.effort).to_ints()
        full = sdk.renderer.build_supervised_examples(base + [assistant], effort=adapter.effort)[0][0].to_ints()
        self.assertEqual(full[:len(prompt)], prompt)
        sampled = full[len(prompt):]
        sampler = Sampler()
        sampler.sequence = SimpleNamespace(tokens=sampled, logprobs=[-1.0] * len(sampled), stop_reason="stop")
        adapter.sampling_client = sampler
        record = adapter.sample(base)
        self.assertTrue(record["complete"])
        self.assertEqual(record["message"], assistant)
        self.assertEqual(record["generated_tokens"], len(sampled))
        self.assertEqual(sum(record["token_accounting"].values()), len(sampled))
        self.assertGreater(record["token_accounting"]["reasoning"], 0)
        self.assertGreater(record["token_accounting"]["protocol"], 0)
        # Real SDK Datum coerces list-valued inputs to aligned TensorData.
        trainer = Trainer(sampler)
        adapter.training_client = trainer
        adapter.rl_train([{"samples": [record], "advantage": -0.25}])
        datum = trainer.calls[0][1][0]
        self.assertEqual(datum.loss_fn_inputs["target_tokens"].data, (prompt + sampled)[1:])
        self.assertEqual(datum.loss_fn_inputs["logprobs"].data[-len(sampled):], [-1.0] * len(sampled))

    def test_json_tool_calls_are_accepted_by_real_renderer(self):
        adapter = TinkerAdapter()
        messages = [
            {"role": "user", "content": "Read x"},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": "read1", "type": "function", "function": {"name": "read", "arguments": '{"path":"x"}'},
            }]},
            {"role": "tool", "name": "read", "tool_call_id": "read1", "content": "hello"},
            {"role": "assistant", "content": "hello"},
        ]
        self.assertGreater(len(adapter.render_sft(messages)), 0)
        self.assertIsInstance(messages[1]["tool_calls"][0], dict)


if __name__ == "__main__":
    unittest.main()
