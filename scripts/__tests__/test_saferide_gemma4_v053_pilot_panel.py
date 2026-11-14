import importlib.util
import unittest
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v053-pilot-panel.py"
SPEC = importlib.util.spec_from_file_location("saferide_v053_pilot_panel_test", SCRIPT)
assert SPEC and SPEC.loader
PANEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL)


class Tokenizer:
    eos_token_id = 2

    @staticmethod
    def decode(token_ids, skip_special_tokens=True):
        return " ".join(str(token_id) for token_id in token_ids if token_id != 2)


class V053PilotPanelTests(unittest.TestCase):
    def test_historical_panel_loader_uses_bundled_v052_verifier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code = root / "code"
            code.mkdir()
            (code / PANEL.HISTORICAL_PANEL_NAME).write_text("MARKER = 'immutable-v052'\n", encoding="utf-8")
            historical = PANEL.load_historical_v052_module(root)
            self.assertEqual(historical.MARKER, "immutable-v052")

    def test_fixed_batches_preserve_order_and_bound_size(self):
        rows = list(range(7))
        self.assertEqual(PANEL.fixed_batches(rows), [[0, 1], [2, 3], [4, 5], [6]])
        with self.assertRaisesRegex(RuntimeError, "batch size differs"):
            PANEL.fixed_batches(rows, 3)

    def test_generated_token_finalization_stops_at_first_eos(self):
        completion, generation = PANEL.finalize_generated_tokens([11, 12, 2, 0], Tokenizer(), 4)
        self.assertEqual(completion, "11 12")
        self.assertEqual(generation, {"state": "complete", "outputTokens": 3, "stopReason": "eos"})

    def test_generated_token_finalization_retains_token_cap_failure(self):
        completion, generation = PANEL.finalize_generated_tokens([11, 12, 13, 14], Tokenizer(), 4)
        self.assertEqual(completion, "11 12 13 14")
        self.assertEqual(generation, {"state": "truncated", "outputTokens": 4, "stopReason": "token-cap"})


if __name__ == "__main__":
    unittest.main()
