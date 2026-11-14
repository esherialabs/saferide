import importlib.util
import unittest
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v057-dataset.py"
SPEC = importlib.util.spec_from_file_location("saferide_v057_dataset_test", SCRIPT)
assert SPEC and SPEC.loader
DATASET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DATASET)


class V057DatasetTests(unittest.TestCase):
    def setUp(self):
        self.system = "Provide bounded support, preserve choice, keep private setup confidential, and use concise safety guidance."
        self.rows = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))

    def test_minimal_balanced_inventory(self):
        self.assertEqual(len(self.rows), 16)
        self.assertEqual(Counter(row["metadata"]["language"] for row in self.rows), {"en": 8, "sw": 8})
        self.assertEqual(Counter(row["metadata"]["track"] for row in self.rows), {
            DATASET.TRACK_AGENCY: 8, DATASET.TRACK_NONDISCLOSURE: 4, DATASET.TRACK_CONCISE: 4,
        })
        self.assertEqual(len({row["metadata"]["scenarioFamilyId"] for row in self.rows}), 8)

    def test_rows_are_deterministic_human_authored_and_training_only(self):
        repeated = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))
        self.assertEqual(DATASET.canonical_sha256(self.rows), DATASET.canonical_sha256(repeated))
        self.assertEqual({row["split"] for row in self.rows}, {"train"})
        self.assertTrue(all(row["authoring"]["modelGenerationUsed"] is False for row in self.rows))
        self.assertTrue(all(row["authoring"]["developmentTextViewedForAuthoring"] is False for row in self.rows))

    def test_targets_pass_all_shape_language_safety_and_echo_gates(self):
        report = DATASET.validate_rows(self.rows, self.system)
        self.assertTrue(report["safeTargetScorerPassed"])
        self.assertTrue(report["naturalLanguageConsistencyPassed"])
        self.assertTrue(report["twoSentenceEarlyAnswerPassed"])
        self.assertTrue(report["twoConcreteOptionsPassed"])
        self.assertTrue(report["reversibleNextStepPassed"])
        self.assertTrue(report["commandFreePassed"])
        self.assertTrue(report["nondisclosureProtectedEchoBlocked"])
        self.assertLess(report["maximumResponseTokenCosine"], 0.92)

    def test_plan_binds_one_short_low_rate_continuation(self):
        plan = DATASET.validate_plan()
        self.assertEqual(plan["trainingHypothesis"]["count"], 1)
        self.assertEqual(plan["trainingHypothesis"]["learningRate"], 5e-6)
        self.assertEqual(plan["trainingHypothesis"]["optimizerSteps"], 13)
        self.assertFalse(plan["trainingHypothesis"]["retryAllowed"])


if __name__ == "__main__":
    unittest.main()
