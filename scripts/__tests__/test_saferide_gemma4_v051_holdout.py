import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v051-holdout.py"


def load_module():
    spec = importlib.util.spec_from_file_location("saferide_v051_holdout", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOLDOUT = load_module()


class V051HoldoutTests(unittest.TestCase):
    def test_holdout_thresholds_fail_closed(self):
        passing = {
            "rowCount": 20, "completed": 20, "truncated": 0, "errors": 0,
            "criticalFailures": 0, "overRefusalRate": 0.05, "usefulnessAverage": 2.8,
        }
        self.assertEqual(HOLDOUT.holdout_eligibility(passing, passing), (True, []))
        unsafe = {**passing, "criticalFailures": 1}
        passed, reasons = HOLDOUT.holdout_eligibility(unsafe, passing)
        self.assertFalse(passed)
        self.assertIn("critical-failure-threshold", reasons)

    def test_holdout_requires_completed_selection_and_never_promotes(self):
        run = {
            "seed": 419806,
            "runId": "saferide-v051-candidate-fixture-419806",
            "manifestSha256": "a" * 64,
            "bestCheckpoint": "checkpoint-200",
            "developmentPanel": {"status": "passed", "summarySha256": "b" * 64},
        }
        selection = {
            "schema": "com.saferide.ai.v051-training-selection",
            "datasetId": "saferide-synthetic-guidance-v0.5.1",
            "status": "selected",
            "blockers": [],
            "promotionEligible": False,
            "privacy": {"mitigationHoldoutUsedForSelection": False},
            "selected": {
                "runId": run["runId"], "seed": 419806, "checkpoint": "checkpoint-200",
                "candidateManifestSha256": "a" * 64, "panelSummarySha256": "b" * 64,
            },
            "candidateRuns": [run],
        }
        selected, matched = HOLDOUT.selected_lineage(selection)
        self.assertEqual(selected["seed"], 419806)
        self.assertEqual(matched["runId"], run["runId"])
        with self.assertRaisesRegex(RuntimeError, "lacks an eligible"):
            HOLDOUT.selected_lineage({**selection, "status": "blocked"})
        with self.assertRaisesRegex(RuntimeError, "lacks an eligible"):
            HOLDOUT.selected_lineage({**selection, "promotionEligible": True})


if __name__ == "__main__":
    unittest.main()
