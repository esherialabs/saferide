import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v054-pilot-panel.py"
SPEC = importlib.util.spec_from_file_location("saferide_v054_panel_test", SCRIPT)
assert SPEC and SPEC.loader
PANEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL)


class Vector:
    def __init__(self, values):
        self.values = values
        self.shape = (len(values), len(values[0]) if values and isinstance(values[0], list) else len(values))

    def sum(self, dim=-1):
        return Values([sum(row) for row in self.values])

    def to(self, _device):
        return self


class Values:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class OutputRow:
    def __init__(self, values):
        self.values = values

    def __getitem__(self, item):
        return OutputRow(self.values[item]) if isinstance(item, slice) else self.values[item]

    def tolist(self):
        return self.values


class Output:
    def __init__(self, rows):
        self.rows = rows

    def __getitem__(self, index):
        return OutputRow(self.rows[index])


class Tokenizer:
    eos_token_id = 1
    pad_token_id = 0

    def apply_chat_template(self, contexts, **_kwargs):
        return {"input_ids": Vector([[2, 3, 4] for _ in contexts]), "attention_mask": Vector([[1, 1, 1] for _ in contexts])}

    @staticmethod
    def decode(values, skip_special_tokens=True):
        return " ".join(str(value) for value in values if value not in {1, 50, 106})


class Model:
    class GenerationConfig:
        eos_token_id = [1, 106, 50]

    generation_config = GenerationConfig()

    def __init__(self):
        self.generate_args = None

    def parameters(self):
        return iter(())

    def generate(self, **kwargs):
        self.generate_args = kwargs
        count = len(kwargs["input_ids"].values)
        return Output([[2, 3, 4, 20, 21, 106, 22] for _ in range(count)])


class Torch:
    @staticmethod
    def device(value):
        return value

    class inference_mode:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False


class V054PilotPanelTests(unittest.TestCase):
    def test_batch_generation_passes_every_model_terminator_and_stops_on_turn(self):
        model = Model()
        results = PANEL.batch_generate_completions(model, Tokenizer(), Torch(), [[{"role": "user", "content": "x"}]])
        self.assertEqual(model.generate_args["eos_token_id"], [1, 106, 50])
        self.assertEqual(results[0][0], "20 21")
        self.assertEqual(results[0][1]["state"], "complete")
        self.assertEqual(results[0][1]["terminatorId"], 106)

    def test_zero_truncation_is_a_strict_gate(self):
        passing = {"rowCount": 20, "completed": 20, "truncated": 0, "errors": 0, "criticalFailures": 0, "overRefusalRate": 0.0, "usefulnessAverage": 3.0, "modelTerminatorStops": 20}
        self.assertTrue(PANEL.eligibility(passing, passing, 20)[0])
        allowed, reasons = PANEL.eligibility({**passing, "completed": 19, "truncated": 1}, passing, 20)
        self.assertFalse(allowed)
        self.assertIn("truncation-nonzero", reasons)

    def test_missing_model_terminator_coverage_is_blocking(self):
        passing = {"rowCount": 20, "completed": 20, "truncated": 0, "errors": 0, "criticalFailures": 0, "overRefusalRate": 0.0, "usefulnessAverage": 3.0, "modelTerminatorStops": 20}
        allowed, reasons = PANEL.eligibility({**passing, "modelTerminatorStops": 19}, passing, 20)
        self.assertFalse(allowed)
        self.assertIn("model-terminator-coverage-incomplete", reasons)


if __name__ == "__main__":
    unittest.main()
