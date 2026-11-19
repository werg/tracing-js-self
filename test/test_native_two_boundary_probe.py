"""Native history identities preserve repeated reserved controls and physical uniqueness."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
SPEC = importlib.util.spec_from_file_location("native_two_boundary_probe", ROOT / "tools/native_two_boundary_probe.py")
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


def boundary(prefix):
    return {
        "tracks": ["track:0"], "trackRegistry": ["__transducer_query__", "track:0"],
        "trackDescriptions": [], "eventsSeen": [4], "meridiansSeen": [4],
        "modelVersion": 0,
        "historyEventIds": ["__transducer_query__", prefix + "a", "__transducer_query__", prefix + "b"],
        "historyTracks": ["__transducer_query__", "track:0", "__transducer_query__", "track:0"],
        "historyPositions": [0, 1, 2, 3], "contextDropped": [],
        "frontierEventIds": [prefix + "b"], "frontierTracks": ["track:0"],
        "frontierModalities": ["text"], "meridianSizes": [1, 1, 1, 1],
        "contextSeen": 4, "contextPolicy": {},
    }


class TrackIdentityTests(unittest.TestCase):
    def compare(self, left, right):
        return PROBE.compare_track_context({"boundary": left}, {"boundary": right})

    def test_repeated_reserved_controls_keep_exact_chronology(self):
        left, right = boundary("training:"), boundary("serving:")
        before = copy.deepcopy((left, right))
        result = self.compare(left, right)
        self.assertEqual(result["status"], "passed")
        self.assertEqual((left, right), before)
        self.assertEqual(len(result["opaqueEventIdCorrespondence"]["historyEventIds"]), 4)
        self.assertFalse(result["eventIdsRewritten"])

    def test_duplicate_physical_event_is_rejected(self):
        left, right = boundary("training:"), boundary("serving:")
        right["historyEventIds"][3] = right["historyEventIds"][1]
        self.assertEqual(self.compare(left, right)["status"], "failed")

    def test_reserved_identity_cannot_alias_an_ordinary_event(self):
        left, right = boundary("training:"), boundary("serving:")
        right["historyEventIds"][1] = "__transducer_query__"
        self.assertEqual(self.compare(left, right)["status"], "failed")

    def test_control_identity_must_match_its_reserved_track(self):
        left, right = boundary("training:"), boundary("serving:")
        right["historyEventIds"][2] = "__metadata__"
        self.assertEqual(self.compare(left, right)["status"], "failed")

    def test_attachment_length_and_chronological_position_must_match(self):
        left, right = boundary("training:"), boundary("serving:")
        right["historyEventIds"].pop()
        self.assertEqual(self.compare(left, right)["status"], "failed")
        right = boundary("serving:")
        right["historyPositions"][2] = 1
        self.assertEqual(self.compare(left, right)["status"], "failed")



class DecisionControlTests(unittest.TestCase):
    def captures(self):
        tensor = {"shape": [1, 1, 2], "values": [0.1, 0.2]}
        return (
            {"trainingCall": {"controlHex": ["6162"]},
             "boundary": {"encodedControl": copy.deepcopy(tensor)}, "encoderCalls": [{}]},
            {"servingCall": {"controlHex": ["6162"]},
             "boundary": {"encodedControl": copy.deepcopy(tensor)}, "encoderCalls": [{}, {}, {}]},
        )

    def test_different_hook_intervals_do_not_hide_equal_current_controls(self):
        left, right = self.captures()
        row = PROBE.compare_decision_controls(left, right)
        self.assertEqual(row["status"], "passed")
        self.assertFalse(row["fullEncoderHookListsComparable"])
        self.assertEqual(row["observedEncoderCallCounts"], {"training": 1, "serving": 3})

    def test_different_bytes_fail_even_when_an_encoded_tensor_collides(self):
        left, right = self.captures()
        right["servingCall"]["controlHex"] = ["6163"]
        self.assertEqual(PROBE.compare_decision_controls(left, right)["status"], "failed")

    def test_changed_actual_control_tensor_fails(self):
        left, right = self.captures()
        right["boundary"]["encodedControl"]["values"][1] = 0.3
        self.assertEqual(PROBE.compare_decision_controls(left, right)["status"], "failed")

    def test_missing_capture_does_not_count_as_equal(self):
        left, right = self.captures()
        left["trainingCall"] = {}
        right["servingCall"] = {}
        self.assertEqual(PROBE.compare_decision_controls(left, right)["status"], "failed")



class SingletonChoiceTests(unittest.TestCase):
    def captures(self):
        capture = {
            "modalityCalls": [{"rows": [{"support": [0], "probabilities": [1.0]}]}],
            "decoderExecution": {
                "publicModeSupports": [[0]],
                "categoricals": [{"name": "mode", "support": [0],
                                   "probabilities": [1.0], "selected": 0}],
            },
        }
        return copy.deepcopy(capture), copy.deepcopy(capture)

    def test_actual_text_only_supports_are_deterministic(self):
        left, right = self.captures()
        row = PROBE.compare_singleton_text_choices(left, right)
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["conditionalProbability"], 1.0)

    def test_installed_alternative_modality_cannot_pass_as_text_only(self):
        left, right = self.captures()
        left["modalityCalls"][0]["rows"][0] = {
            "support": [0, 1], "probabilities": [0.6, 0.4]}
        self.assertEqual(PROBE.compare_singleton_text_choices(left, right)["status"], "failed")

    def test_alternative_format_or_missing_support_is_not_inferred(self):
        left, right = self.captures()
        left["decoderExecution"]["publicModeSupports"] = [[0, 1]]
        self.assertEqual(PROBE.compare_singleton_text_choices(left, right)["status"], "failed")
        left, right = self.captures()
        left["modalityCalls"] = []
        self.assertEqual(PROBE.compare_singleton_text_choices(left, right)["status"], "failed")



class ActualSampleTests(unittest.TestCase):
    def captures(self):
        tensor = {"shape": [1, 2], "values": [0.1, 0.2], "float32Sha256": "original"}
        capture = {"actualSampledFacets": tensor,
                   "coupledSamples": [{"seed": 17, "eventIds": ["event"],
                                       "nativeUnmodifiedSample": copy.deepcopy(tensor)}]}
        return copy.deepcopy(capture), copy.deepcopy(capture)

    def test_actual_same_draw_is_compared(self):
        left, right = self.captures()
        row = PROBE.compare_actual_samples(left, right, 1)
        self.assertEqual(row["status"], "passed")
        self.assertTrue(row["bitwiseEqual"])
        self.assertEqual(row["comparedCoordinates"], 2)

    def test_different_draw_fails_even_if_gaussian_metadata_were_equal(self):
        left, right = self.captures()
        right["actualSampledFacets"]["values"][0] = 0.4
        right["actualSampledFacets"]["float32Sha256"] = "changed"
        right["coupledSamples"][0]["nativeUnmodifiedSample"] = copy.deepcopy(right["actualSampledFacets"])
        self.assertEqual(PROBE.compare_actual_samples(left, right, 1)["status"], "failed")

    def test_wrapper_cannot_replace_or_mislabel_actual_sample(self):
        left, right = self.captures()
        right["coupledSamples"][0]["nativeUnmodifiedSample"]["values"][0] = 0.4
        self.assertEqual(PROBE.compare_actual_samples(left, right, 1)["status"], "failed")
        left, right = self.captures()
        right["coupledSamples"][0]["seed"] = 18
        self.assertEqual(PROBE.compare_actual_samples(left, right, 1)["status"], "failed")



class ProbabilityToleranceTests(unittest.TestCase):
    def comparison(self, structural_delta):
        import torch
        from types import SimpleNamespace
        valid = torch.tensor([True, True])
        weights = torch.eye(2)
        model = SimpleNamespace(decoder=SimpleNamespace(
            valid_utf8=valid,
            vocabulary=SimpleNamespace(embedding=SimpleNamespace(weight=weights))))
        import hashlib
        alphabet_sha = hashlib.sha256(valid.numpy().tobytes()).hexdigest()
        lexical = {
            "alphabetSha256": alphabet_sha, "positions": 1,
            "fullConditionalProbabilitiesSha256": "same",
            "projectedStates": {"shape": [1, 2], "values": [1.0, 0.0]},
            "tokens": [{"tokenId": 0}],
        }
        teacher = {"categoricals": [
            {"name": "length", "support": [1, 2], "selected": 1, "probabilities": [0.5, 0.5], "logits": [0.0, 0.0]},
            {"name": "terminal", "support": [0, 1], "selected": 1, "probabilities": [0.25, 0.75], "logits": [0.0, 1.0]},
        ], "lexical": [lexical]}
        renderer = copy.deepcopy(teacher)
        renderer["categoricals"][0]["probabilities"] = [0.5 + structural_delta, 0.5 - structural_delta]
        return PROBE.numeric_decoder_comparison(model, teacher, renderer, [0])

    def test_native_float32_unit_scale_roundoff_has_an_explicit_bound(self):
        import torch
        row = self.comparison(1.1e-7)
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["absoluteProbabilityTolerance"], torch.finfo(torch.float32).eps)
        self.assertEqual(row["totalVariationTolerance"], 1e-5)
        self.assertEqual(row["selectedLogProbabilityTolerance"], 1e-4)

    def test_changed_conditional_fails_even_below_the_aggregate_tv_limit(self):
        row = self.comparison(1e-6)
        self.assertLess(row["maximumTotalVariation"], row["totalVariationTolerance"])
        self.assertEqual(row["status"], "failed")



class ExecutionSettingsTests(unittest.TestCase):
    def capture(self):
        return {"executionSettings": {
            "deterministicAlgorithms": True, "cpuThreads": 1, "nnpackEnabled": False,
            "float32MatmulPrecision": "highest", "defaultDtype": "torch.float32"}}

    def test_same_native_cpu_policy_is_required(self):
        left, right = self.capture(), self.capture()
        self.assertEqual(PROBE.compare_execution_settings(left, right)["status"], "passed")

    def test_earlier_service_default_nnpack_cannot_pass(self):
        left, right = self.capture(), self.capture()
        right["executionSettings"]["nnpackEnabled"] = True
        right["executionSettings"]["deterministicAlgorithms"] = False
        self.assertEqual(PROBE.compare_execution_settings(left, right)["status"], "failed")

    def test_same_undeclared_or_nondeterministic_settings_are_not_enough(self):
        left, right = self.capture(), self.capture()
        left["executionSettings"]["deterministicAlgorithms"] = False
        right["executionSettings"]["deterministicAlgorithms"] = False
        self.assertEqual(PROBE.compare_execution_settings(left, right)["status"], "failed")
        self.assertEqual(PROBE.compare_execution_settings({}, {})["status"], "failed")


if __name__ == "__main__":
    unittest.main()
