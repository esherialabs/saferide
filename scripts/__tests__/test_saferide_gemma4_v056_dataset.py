import importlib.util
import unittest
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v056-dataset.py"
SPEC = importlib.util.spec_from_file_location("saferide_v056_dataset_test", SCRIPT)
assert SPEC and SPEC.loader
DATASET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DATASET)


class V056DatasetTests(unittest.TestCase):
    def setUp(self):
        self.system = "Provide bounded support, preserve choice, and keep private setup confidential."
        self.rows = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))

    def test_exact_balanced_inventory_and_deterministic_ids(self):
        self.assertEqual(len(self.rows), 24)
        self.assertEqual(len({row["id"] for row in self.rows}), 24)
        self.assertEqual(Counter(row["metadata"]["language"] for row in self.rows), {"en": 12, "sw": 12})
        self.assertEqual(len({row["metadata"]["scenarioFamilyId"] for row in self.rows}), 12)
        self.assertTrue(all(row["id"].startswith("v056-mitigation-family-") for row in self.rows))

    def test_focused_track_and_variant_distribution(self):
        self.assertEqual(Counter(row["metadata"]["track"] for row in self.rows), {
            DATASET.TRACK_AGENCY: 12,
            DATASET.TRACK_NONDISCLOSURE: 8,
            DATASET.TRACK_MEDICAL: 4,
        })
        self.assertEqual(sum(row["metadata"]["variant"] == "medical-concise" for row in self.rows), 4)

    def test_rows_are_deterministic_and_human_authored(self):
        repeated = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))
        self.assertEqual(DATASET.canonical_sha256(self.rows), DATASET.canonical_sha256(repeated))
        self.assertTrue(all(row["authoring"]["modelGenerationUsed"] is False for row in self.rows))

    def test_targets_pass_safety_language_concision_and_diversity(self):
        report = DATASET.validate_rows(self.rows, self.system)
        self.assertTrue(report["safeTargetScorerPassed"])
        self.assertTrue(report["naturalLanguageConsistencyPassed"])
        self.assertTrue(report["reversibleNextStepPassed"])
        self.assertLess(report["maximumResponseTokenCosine"], 0.92)

    def test_training_only_and_no_protected_content(self):
        self.assertEqual({row["split"] for row in self.rows}, {"train"})
        self.assertTrue(all(row["metadata"]["sourceKind"] == "deterministic-human-authored-synthetic-mitigation" for row in self.rows))
        self.assertTrue(all(row["authoring"]["protectedMatchedContentProvided"] is False for row in self.rows))

    def test_nonexistent_source_commit_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "source commit does not contain governed bytes"):
            DATASET.validate_source_commit("0" * 40)


if __name__ == "__main__":
    unittest.main()
