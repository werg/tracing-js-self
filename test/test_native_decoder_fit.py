"""Regressions for exact diagnostic checkpoint tensor identities."""
import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_decoder_fit", ROOT / "tools/fit-native-semantic-record.py")
FIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIT)


class TensorIdentityTests(unittest.TestCase):
    def test_scalar_float_and_bfloat16_values_are_hashed_without_losing_shape(self):
        import torch

        for dtype in (torch.float32, torch.bfloat16):
            with self.subTest(dtype=dtype):
                one = torch.tensor(1.0, dtype=dtype)
                digest = FIT.tensor_identity({"value": one})
                self.assertEqual(len(digest), 64)
                self.assertEqual(digest, FIT.tensor_identity({"value": one.clone()}))
                self.assertNotEqual(digest, FIT.tensor_identity({"value": one + 1}))
                self.assertNotEqual(digest, FIT.tensor_identity({"value": one.reshape(1)}))

    def test_names_dtypes_and_empty_tensors_remain_part_of_identity(self):
        import torch

        value = torch.tensor(True)
        original = FIT.tensor_identity({"flag": value, "empty": torch.empty(0)})
        self.assertEqual(original, FIT.tensor_identity({"empty": torch.empty(0), "flag": value}))
        self.assertNotEqual(original, FIT.tensor_identity({"other": value, "empty": torch.empty(0)}))
        self.assertNotEqual(original, FIT.tensor_identity({"flag": value.to(torch.uint8), "empty": torch.empty(0)}))


class FrozenPrefixTests(unittest.TestCase):
    def test_real_prefix_replay_is_frozen_without_disabling_decoder_gradients(self):
        import torch
        from megatoken.data.media_assets import TensorAssetStore
        from megatoken.data.schema import Episode, Lineage, Meridian, PhysicalRecord, TrackEvent, TrackSpec
        from megatoken.generation.codec import ByteCodec
        from megatoken.loading import build_model
        from megatoken.model.config import ModelConfig
        from megatoken.model.multitrack import MultiTrackGenerator
        from megatoken.training.config import TrainConfig
        from megatoken.training.meridians import forward_meridian_batch

        torch.set_num_threads(1)
        torch.manual_seed(37)
        codec = ByteCodec.byte_fallback()
        records = (PhysicalRecord("request", "user", b"repeat fact", turn_index=0),
                   PhysicalRecord("answer", "assistant", b"fact", turn_index=1,
                                  policy_mask=True, provenance="teacher"))
        episode = Episode("fit-prefix", records,
                          Lineage("fit-source", "fixture", "fit-family", frozen_split="train"),
                          tracks=tuple(TrackSpec(row.record_id, row.role) for row in records),
                          meridians=tuple(Meridian(i, (TrackEvent(row.record_id, row.record_id,
                                          "text", i, row.role),)) for i, row in enumerate(records)))
        config = TrainConfig(purpose="diagnostic", phase="P1", model="tiny", datasets=["unused"],
                             output="unused", codec="byte", device="cpu", precision="fp32",
                             max_steps=1, microbatch_episodes=1, max_accumulation_windows=1,
                             max_history_tokens=128, max_window_records=4, max_record_bytes=128,
                             generated_capacity=16, checkpoint_every=0, eval_every=0,
                             gradient_checkpointing=False, use_stage_mixture=False, use_effort_mixture=False)
        model = build_model(ModelConfig.tiny(vocab_size=codec.vocab_size, max_capacity=16,
                                             max_history_chunks=8), codec, device="cpu", precision="fp32")
        observed = []

        def replay(*args, **kwargs):
            observed.append(torch.is_grad_enabled())
            return forward_meridian_batch(*args, **kwargs)

        with torch.enable_grad(), patch("megatoken.training.meridians.forward_meridian_batch", replay):
            captured = FIT.capture_training_boundary(model, SimpleNamespace(payload={"global_step": 0}),
                        episode, TensorAssetStore("text-only"), codec, config, b"fact", 17)
            self.assertTrue(torch.is_grad_enabled(), "decoder optimization must retain gradient tracking")
            selected = MultiTrackGenerator.of(model).supervised_meridian(
                captured["state"], **captured["kwargs"])
            sum(total for total, count in selected.losses.values() if count).backward()
            self.assertTrue(any(parameter.grad is not None and bool(parameter.grad.abs().sum() > 0)
                                for parameter in model.decoder.parameters()))
        self.assertEqual(observed, [False])
        self.assertFalse(captured["prefixReplayGradientEnabled"])
        for tensor in (captured["state"].raw, captured["state"].final,
                       captured["state"].history.keys, captured["state"].history.values):
            self.assertFalse(tensor.requires_grad)
        self.assertEqual(captured["targetTokenIds"], list(codec.encode(b"fact")))


if __name__ == "__main__":
    unittest.main()
