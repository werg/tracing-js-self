"""Native supervision audit regression using a real tiny Megatoken byte model."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPANION = ROOT.parent / "megatoken"
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(COMPANION / "src"))

from native_supervision_audit import capture_native_supervision_audit  # noqa: E402


class NativeSupervisionAuditTests(unittest.TestCase):
    def test_one_native_byte_episode_has_exact_masks_context_targets_and_gradients(self):
        import torch

        from megatoken.data.media_assets import TensorAssetStore
        from megatoken.data.packing import TrainingWindow
        from megatoken.data.schema import (
            Episode,
            Lineage,
            Meridian,
            PhysicalRecord,
            TrackEvent,
            TrackSpec,
            encode_record,
        )
        from megatoken.generation.codec import ByteCodec
        from megatoken.loading import build_model
        from megatoken.model.config import ModelConfig
        from megatoken.model.multitrack import MultiTrackGenerator
        from megatoken.training.config import TrainConfig
        from megatoken.training.history import NativeHistory
        from megatoken.training.meridians import prepare_meridian_batch
        from megatoken.training.stream import EpisodeWindow
        from megatoken.training.transducer import TransducerTrainer

        torch.set_num_threads(1)
        torch.manual_seed(37)
        codec = ByteCodec.byte_fallback()
        records = (
            PhysicalRecord("doc", "document", b"a small fact"),
            PhysicalRecord("request", "user", b"repeat it", turn_index=0),
            PhysicalRecord("answer", "assistant", b"fact", turn_index=1,
                           policy_mask=True, provenance="teacher"),
            PhysicalRecord("future", "user", b"later question", turn_index=2),
        )
        tracks = tuple(TrackSpec(row.record_id, row.role) for row in records)
        meridians = (
            Meridian(0, (
                TrackEvent("doc", "doc", "text", 0, "document"),
                TrackEvent("request", "request", "text", 0, "user"),
            )),
            Meridian(1, (TrackEvent("answer", "answer", "text", 1, "assistant"),)),
            Meridian(2, (TrackEvent("future", "future", "text", 2, "user"),)),
        )
        episode = Episode("audit-episode", records,
                          Lineage("audit-source", "fixture-revision", "audit-family",
                                  frozen_split="train"),
                          tracks=tracks, meridians=meridians)
        config = TrainConfig(
            purpose="diagnostic", phase="P1", model="tiny", datasets=["unused"],
            output="unused", codec="byte", device="cpu", precision="fp32",
            max_steps=1, microbatch_episodes=1, max_accumulation_windows=1,
            max_history_tokens=128, max_window_records=4, max_record_bytes=128,
            generated_capacity=16, checkpoint_every=0, eval_every=0,
            gradient_checkpointing=False, use_stage_mixture=False,
            use_effort_mixture=False,
            model_overrides={"vocab_size": codec.vocab_size, "max_capacity": 16,
                             "max_history_chunks": 8},
        )
        model_config = ModelConfig.tiny(vocab_size=codec.vocab_size,
                                        max_capacity=16, max_history_chunks=8)
        model = build_model(model_config, codec, device="cpu", precision="fp32")
        multi = MultiTrackGenerator.of(model)
        encoded = tuple(encode_record(record, codec) for record in records)
        window = TrainingWindow(episode, (), encoded, 0, len(encoded), 0)
        item = EpisodeWindow(episode, window, TensorAssetStore("text-only"), True)
        native = NativeHistory.of(episode, model)
        batch = prepare_meridian_batch(model, item, native, config)
        trainer = TransducerTrainer(model.transducer, bank_trainable=False)
        trainer.reading = None

        report = capture_native_supervision_audit(
            model,
            batch,
            codec=codec,
            config=config,
            device=torch.device("cpu"),
            model_version=model.core.model_version,
            transducer=trainer,
            checkpoint_sha256="a" * 64,
            decoder_seed=17,
        )

        self.assertEqual(report["schema"], "native-token-supervision-audit/1")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["optimizerSteps"], 0)
        self.assertTrue(report["allGeneratedTokensScored"])
        self.assertTrue(report["allObservedTokensUnscored"])
        decision = report["decisions"][0]
        self.assertEqual(decision["context"]["earlierPhysicalEventIds"], ["doc", "request"])
        self.assertTrue(decision["context"]["visibleEventsAreStrictlyEarlier"])
        target = decision["targets"][0]
        self.assertEqual([row["targetTokenId"] for row in target["tokenTargets"]],
                         list(codec.encode(b"fact")))
        self.assertTrue(all(target["lexicalLossMask"]))
        self.assertEqual(target["structuralTargets"]["outputLengthTokens"], 4)
        self.assertTrue(target["terminalTarget"])
        self.assertTrue(decision["gradients"]["lexical"]["lexicalVocabulary"]["rawGradientNorm"] > 0)
        self.assertTrue(decision["gradients"]["structure"]["structureHeads"]["rawGradientNorm"] > 0)
        self.assertTrue(decision["gradients"]["terminal"]["terminalHead"]["rawGradientNorm"] > 0)
        self.assertEqual(report["futureObservationCanary"]["status"], "passed")
        canary_check = report["futureObservationCanary"]["comparisons"][0]
        self.assertTrue(canary_check["conditionalDistributionsEqual"])
        self.assertTrue(canary_check["selectedLogProbabilitiesEqual"])
        self.assertTrue(all(canary_check["objectiveGradientValuesEqual"]["lexical"].values()))
        self.assertTrue(decision["decoderEmission"]["completeValidGroup"])
        self.assertEqual(len(decision["decoderEmission"]["conditionalDistribution"]["jointSha256"]), 64)
        self.assertTrue(report["semanticParserStatus"] == "unmeasured")
        emitted = decision["decoderEmission"]["events"][0]
        self.assertEqual(codec.decode(emitted["emittedTokenIds"]).hex(), emitted["payloadHex"])
        json.dumps(report, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
