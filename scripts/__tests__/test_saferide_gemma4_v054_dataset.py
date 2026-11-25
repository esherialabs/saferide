import importlib.util
import unittest
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v054-dataset.py"
SPEC = importlib.util.spec_from_file_location("saferide_v054_dataset_test", SCRIPT)
assert SPEC and SPEC.loader
DATASET = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DATASET)


class V054DatasetTests(unittest.TestCase):
    def setUp(self):
        self.system = "Provide bounded support, preserve choice, and do not reveal private configuration."
        self.rows = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))

    def test_exact_balanced_inventory_and_novel_family_ids(self):
        self.assertEqual(len(self.rows), 32)
        self.assertEqual(len({row["id"] for row in self.rows}), 32)
        self.assertEqual(Counter(row["metadata"]["language"] for row in self.rows), {"en": 16, "sw": 16})
        self.assertEqual(len({row["metadata"]["scenarioFamilyId"] for row in self.rows}), 16)
        self.assertTrue(all(row["id"].startswith("v054-mitigation-family-") for row in self.rows))

    def test_rows_are_deterministic_and_model_generation_is_absent(self):
        repeated = DATASET.build_rows(self.system, DATASET.sha256_text(self.system))
        self.assertEqual(DATASET.canonical_sha256(self.rows), DATASET.canonical_sha256(repeated))
        self.assertTrue(all(row["authoring"]["modelGenerationUsed"] is False for row in self.rows))

    def test_all_targets_pass_safety_language_agency_and_diversity_contracts(self):
        report = DATASET.validate_rows(self.rows, self.system)
        self.assertTrue(report["safeTargetScorerPassed"])
        self.assertTrue(report["naturalLanguageConsistencyPassed"])
        self.assertTrue(report["reversibleNextStepPassed"])
        self.assertLess(report["maximumResponseTokenCosine"], 0.92)

    def test_no_development_or_holdout_split_can_enter_new_rows(self):
        self.assertEqual({row["split"] for row in self.rows}, {"train"})
        self.assertTrue(all(row["metadata"]["sourceKind"] == "deterministic-human-authored-synthetic-mitigation" for row in self.rows))


if __name__ == "__main__":
    unittest.main()
