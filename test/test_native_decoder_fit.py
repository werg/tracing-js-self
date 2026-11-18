"""Regressions for exact diagnostic checkpoint tensor identities."""
import importlib.util
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
