import importlib.util
import unittest
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v052-pilot-panel.py"
SPEC = importlib.util.spec_from_file_location("saferide_v052_pilot_panel_test", SCRIPT)
assert SPEC and SPEC.loader
PANEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL)


class Tokenizer:
    eos_token_id = 2

    @staticmethod
    def decode(token_ids, skip_special_tokens=True):
        return " ".join(str(token_id) for token_id in token_ids if token_id != 2)


class V052PilotPanelTests(unittest.TestCase):
    def test_historical_panel_loader_keeps_immutable_scorer_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            code = root / "code"
            code.mkdir()
            (code / "saferide-gemma4-v05-development-panel.py").write_text(
                "SCORING_POLICY = {'policyId': 'saferide-v05-development-panel-deterministic-rubric.1'}\n"
                "BASE_MODEL_ID = 'model'\nBASE_REVISION = 'revision'\n"
                "REQUIRED_SEEDS = (419805, 419806)\nEXPECTED_MODEL_FILES = ()\n"
                "GENERATION_CONFIG = {}\nSELECTION_POLICY = {}\n",
                encoding="utf-8",
            )
            (code / "saferide-gemma4-v051-development-panel.py").write_text(
                PANEL.V051_PATH.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            historical = PANEL.load_historical_v051_module(root)
            self.assertEqual(
                historical.SCORING_POLICY["policyId"],
                "saferide-v05-development-panel-deterministic-rubric.1",
            )

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
