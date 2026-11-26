"""Causal prompts and actual renderer/token checks; no model compute or model scores."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest

from tinker_js.adapter import TinkerAdapter, rl_token_arrays
from tinker_js.runner import Bridge, load_config, rollout


REPO = Path(__file__).resolve().parents[2]
FORMATS = ("full", "compact", "actions-only")


def fixture_sample(value, *, reasoning, length):
    text = reasoning + "\n```json\n" + json.dumps(value) + "\n```"
    return {"message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Deliberately wrong student belief: 7 + 2 is 999999."},
        {"type": "text", "text": text},
    ]}, "text": text, "prompt_tokens": [4, 8, 15], "token_ids": list(range(100, 100 + length)),
        "logprobs": [-0.25] * length, "generated_tokens": length, "complete": True, "stop_reason": "stop"}


class FixtureSampler:
    backend_name = "fixture"

    def __init__(self, samples):
        self.samples = list(samples)
        self.histories = []

    def sample(self, messages, **_):
        self.histories.append(copy.deepcopy(messages))
        return copy.deepcopy(self.samples.pop(0))


@unittest.skipUnless(shutil.which("node"), "Node is required for the actual CPU boundary")
class FollowupPrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge(REPO, timeout=60)
        cls.bridge.request("health")

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def setUp(self):
        self.config = load_config(overrides={"max_tokens": 256, "max_generated_tokens": 1024, "max_turns": 8})

    def input(self, second="PRIVATE_FUTURE_OBSERVATION_938272"):
        return {"id": "causal-history", "family": "causal-history",
                "source": 'function run(){const first=lookup("first");lookup("second");return first+2;}',
                "args": [], "metadata": {"privateTeacherAnswer": "TEACHER_PRIVATE_628191"},
                "nativeBindings": [{"name": "lookup", "kind": "synchronous"}],
                "fixture": {"calls": [
                    {"operation": "natlang.callSync", "arguments": ["lookup", {"$js": "undefined"}, ["first"]], "result": 7},
                    {"operation": "natlang.callSync", "arguments": ["lookup", {"$js": "undefined"}, ["second"]], "result": {"unused": second}},
                ]}}

    def samples(self):
        return [
            fixture_sample({"type": "call", "operation": "lookup", "arguments": ["first"]},
                           reasoning="I incorrectly predict that the final answer will be 999999.", length=19),
            fixture_sample({"type": "call", "operation": "lookup", "arguments": ["second"]},
                           reasoning="I keep my mistaken calculation in my own history.", length=23),
            fixture_sample({"type": "complete", "kind": "return", "arguments": [], "value": 999999},
                           reasoning="I have not silently replaced my belief with a teacher answer.", length=29),
        ]

    def test_every_prompt_retains_student_thinking_and_wrong_computation_exactly(self):
        samples = self.samples()
        model = FixtureSampler(samples)
        result = rollout(self.bridge, model, self.input(), self.config, 17)
        self.assertEqual(result["backend"], "fixture")
        self.assertFalse(result["grade"]["success"])
        self.assertEqual(result["grade"]["failureCategory"], "wrong-return")
        self.assertEqual(result["generated_tokens"], 71)
        self.assertEqual(len(model.histories), 3)
        self.assertEqual(model.histories[1][3], samples[0]["message"])
        self.assertEqual(model.histories[2][3], samples[0]["message"])
        self.assertEqual(model.histories[2][5], samples[1]["message"])
        self.assertEqual(model.histories[2][:len(model.histories[1])], model.histories[1])
        self.assertEqual(model.histories[2][-2], samples[1]["message"])
        self.assertEqual(model.histories[2][-1]["role"], "tool")
        self.assertIn("999999", json.dumps(model.histories[2]))
        self.assertNotIn("PRIVATE_FUTURE_OBSERVATION_938272", json.dumps(model.histories[0]))
        self.assertNotIn("PRIVATE_FUTURE_OBSERVATION_938272", json.dumps(model.histories[1]))
        self.assertIn("PRIVATE_FUTURE_OBSERVATION_938272", json.dumps(model.histories[2]))
        self.assertNotIn("TEACHER_PRIVATE_628191", json.dumps(model.histories))
        self.assertEqual(result["samples"][0]["token_ids"], samples[0]["token_ids"])
        self.assertEqual(result["samples"][1]["logprobs"], samples[1]["logprobs"])

    def test_counterfactual_future_observation_changes_only_prompts_after_arrival(self):
        left, right = FixtureSampler(self.samples()), FixtureSampler(self.samples())
        rollout(self.bridge, left, self.input("PRIVATE_COUNTERFACTUAL_LEFT"), self.config, 17)
        rollout(self.bridge, right, self.input("PRIVATE_COUNTERFACTUAL_RIGHT"), self.config, 17)
        self.assertEqual(left.histories[:2], right.histories[:2])
        self.assertEqual(left.histories[2][:-1], right.histories[2][:-1])
        self.assertNotEqual(left.histories[2][-1], right.histories[2][-1])

    def test_invalid_request_stops_before_another_sampler_call_without_a_correction(self):
        samples = self.samples()
        samples[1] = fixture_sample({"type": "call", "operation": "lookup", "arguments": ["wrong"]},
                                    reasoning="Wrong arguments are my own decision.", length=31)
        model = FixtureSampler(samples)
        result = rollout(self.bridge, model, self.input(), self.config, 17)
        self.assertEqual(len(model.histories), 2)
        self.assertEqual(len(model.samples), 1)
        self.assertEqual(result["generated_tokens"], 50)
        self.assertEqual(result["grade"]["failureCategory"], "incorrect-external-request")
        self.assertEqual(result["grade"]["reward"], 0)
        self.assertNotIn("PRIVATE_FUTURE_OBSERVATION_938272", json.dumps(result["messages"]))
        self.assertEqual(result["messages"][-1], samples[1]["message"])
        self.assertNotIn("TEACHER_PRIVATE_628191", json.dumps(result["messages"]))


class _Future:
    def __init__(self, value):
        self.value = value

    def result(self, timeout=None):
        return self.value


class _RenderedTokenSampler:
    """Returns renderer-produced tokens for an offline alignment test, never inference."""
    def __init__(self, tokens):
        self.tokens = tokens
        self.calls = []

    def sample(self, **kwargs):
        self.calls.append(kwargs)
        return _Future(SimpleNamespace(sequences=[SimpleNamespace(
            tokens=self.tokens, logprobs=[-1.0] * len(self.tokens), stop_reason="stop")]))


@unittest.skipUnless(shutil.which("node") and importlib.util.find_spec("tinker") and
                     importlib.util.find_spec("tinker_cookbook"), "optional pinned SDK and Node are required")
class RenderedSupervisionPrivacyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge(REPO, timeout=60)
        cls.bridge.request("health")
        cls.adapter = TinkerAdapter({"effort": 0.2, "max_tokens": 2048})
        cls.adapter.check()

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def export(self, trace_format):
        return self.bridge.request("export", traceFormat=trace_format, task={
            "id": "rendered-mask", "family": "rendered-mask",
            "source": 'function run(){lookup("unused");return 7;}', "args": [],
            "nativeBindings": [{"name": "lookup", "kind": "synchronous"}],
            "fixture": {"calls": [{"operation": "natlang.callSync",
                "arguments": ["lookup", {"$js": "undefined"}, ["unused"]],
                "result": {"unusedObjectSentinel": "OBS_ONLY_UNUSED_648291"}}]},
        })

    def test_actual_renderer_masks_entire_observation_for_all_teacher_formats(self):
        sdk = self.adapter._sdk()
        for trace_format in FORMATS:
            with self.subTest(trace_format=trace_format):
                exported = self.export(trace_format)
                self.assertEqual(exported["metadata"]["traceFormat"], trace_format)
                messages = copy.deepcopy(exported["messages"])
                observation = next(message["content"] for message in messages if message["role"] == "tool")
                self.assertIn("OBS_ONLY_UNUSED_648291", observation)
                self.assertNotIn("OBS_ONLY_UNUSED_648291", json.dumps([message for message in messages if message["role"] == "assistant"]))
                for message in messages:
                    if message["role"] != "assistant":
                        message["trainable"] = True  # The adapter must override this hostile annotation.
                located, weighted_text = 0, ""
                for datum in self.adapter.render_sft(messages):
                    tokens = datum.loss_fn_inputs["target_tokens"].data
                    weights = datum.loss_fn_inputs["weights"].data
                    pieces = [sdk.tokenizer.decode([token]) for token in tokens]
                    decoded = sdk.tokenizer.decode(tokens)
                    self.assertEqual("".join(pieces), decoded, "ASCII test fixture requires additive token decoding")
                    weighted_text += sdk.tokenizer.decode([token for token, weight in zip(tokens, weights) if weight > 0])
                    start = decoded.find(observation)
                    if start < 0:
                        continue
                    located += 1
                    end = start + len(observation)
                    offset = 0
                    covered = 0
                    for piece, weight in zip(pieces, weights):
                        next_offset = offset + len(piece)
                        if offset < end and next_offset > start:
                            self.assertEqual(weight, 0, "Every token overlapping an actual observation must have zero loss")
                            covered += 1
                        offset = next_offset
                    self.assertGreater(covered, 0)
                self.assertGreater(located, 0)
                self.assertNotIn("OBS_ONLY_UNUSED_648291", weighted_text)
                self.assertIn("complete", weighted_text)
                self.assertIn("content_model_end_sampling", weighted_text)

    def test_original_thinking_trace_action_and_termination_tokens_are_all_accounted(self):
        sdk = self.adapter._sdk()
        for trace_format in FORMATS:
            with self.subTest(trace_format=trace_format):
                exported = self.export(trace_format)
                base = exported["messages"][:-1]
                last = exported["messages"][-1]
                if isinstance(last["content"], list):
                    assistant = copy.deepcopy(last)
                else:
                    assistant = {"role": "assistant", "content": [
                        {"type": "thinking", "thinking": "The external result is unused, so return seven."},
                        {"type": "text", "text": last["content"]},
                    ]}
                prompt = sdk.renderer.build_generation_prompt(base, effort=self.adapter.effort).to_ints()
                full = sdk.renderer.build_supervised_examples(base + [assistant], effort=self.adapter.effort)[0][0].to_ints()
                self.assertEqual(full[:len(prompt)], prompt)
                generated = full[len(prompt):]
                sampler = _RenderedTokenSampler(generated)
                self.adapter.sampling_client = sampler
                record = self.adapter.sample(base)
                self.assertTrue(record["complete"])
                self.assertEqual(record["token_ids"], generated)
                self.assertEqual(record["prompt_tokens"], prompt)
                self.assertEqual(record["message"], assistant)
                self.assertEqual(record["generated_tokens"], len(generated))
                accounting = record["token_accounting"]
                self.assertEqual(sum(accounting.values()), len(generated))
                self.assertGreater(accounting["reasoning"], 0)
                self.assertGreater(accounting["protocol"], 0)
                arrays = rl_token_arrays(record, 0.5)
                self.assertEqual(arrays["target_tokens"], (prompt + generated)[1:])
                self.assertEqual(arrays["advantages"][:len(prompt) - 1], [0.0] * (len(prompt) - 1))
                self.assertEqual(arrays["advantages"][-len(generated):], [0.5] * len(generated))
                self.assertEqual(arrays["logprobs"][-len(generated):], [-1.0] * len(generated))
                self.assertIsNone(self.adapter.training_client)


if __name__ == "__main__":
    unittest.main()
