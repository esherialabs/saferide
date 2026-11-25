import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


PANEL_PATH = Path(__file__).resolve().parents[1] / "saferide-gemma4-v051-development-panel.py"


def load_module():
    spec = importlib.util.spec_from_file_location("saferide_v051_development_panel", PANEL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PANEL = load_module()


def rows(count, split):
    return [
        {
            "id": f"synthetic-{split}-{index:03d}",
            "split": split,
            "messages": [
                {"role": "system", "content": "Use bounded survivor-centred guidance."},
                {"role": "user", "content": "What is one safe option?"},
                {"role": "assistant", "content": "You can choose a safe next step that preserves your agency."},
            ],
            "metadata": {"language": "en", "responseStrategy": "agency-preserving-deescalation"},
        }
        for index in range(count)
    ]


class V051DevelopmentPanelTests(unittest.TestCase):
    def test_both_suite_shapes_are_strict(self):
        original_ids, original_sha = PANEL.validate_suite_rows(rows(300, "dev"), "dev", 300)
        mitigation_ids, mitigation_sha = PANEL.validate_suite_rows(rows(20, "mitigation-dev"), "mitigation-dev", 20)
        self.assertEqual(len(original_ids), 300)
        self.assertEqual(len(mitigation_ids), 20)
        self.assertEqual(original_sha, PANEL.sha256_text("\n".join(original_ids)))
        self.assertEqual(mitigation_sha, PANEL.canonical_sha256(mitigation_ids))
        self.assertNotEqual(mitigation_sha, PANEL.sha256_text("\n".join(mitigation_ids)))
        self.assertNotEqual(original_sha, mitigation_sha)
        with self.assertRaisesRegex(RuntimeError, "different split"):
            PANEL.validate_suite_rows(rows(20, "mitigation-holdout"), "mitigation-dev", 20)

    def test_frozen_holdout_uses_the_same_canonical_inventory_contract(self):
        identifiers, observed = PANEL.validate_suite_rows(rows(20, "mitigation-holdout"), "mitigation-holdout", 20)
        self.assertEqual(observed, PANEL.canonical_sha256(identifiers))

    def test_each_suite_independently_blocks_critical_or_generation_failures(self):
        passing = {
            "rowCount": 20, "completed": 20, "truncated": 0, "errors": 0,
            "criticalFailures": 0, "overRefusalRate": 0.05, "usefulnessAverage": 2.8,
        }
        self.assertEqual(PANEL.suite_eligibility(passing, passing, 20), (True, []))
        critical = {**passing, "criticalFailures": 1}
        passed, reasons = PANEL.suite_eligibility(critical, passing, 20)
        self.assertFalse(passed)
        self.assertIn("critical-failure-threshold", reasons)
        errored = {**passing, "completed": 19, "errors": 1}
        passed, reasons = PANEL.suite_eligibility(errored, passing, 20)
        self.assertFalse(passed)
        self.assertIn("generation-errors", reasons)

    def test_repeatability_remains_non_promotable(self):
        PANEL.verify_repeatability_evidence({
            "schema": "com.saferide.ai.private-v051-candidate-repeatability",
            "status": "passed-training-repeatability",
            "promotionEligible": False,
        })
        with self.assertRaisesRegex(RuntimeError, "not passed and non-promotable"):
            PANEL.verify_repeatability_evidence({
                "schema": "com.saferide.ai.private-v051-candidate-repeatability",
                "status": "passed-training-repeatability",
                "promotionEligible": True,
            })

    def test_explicit_staged_package_root_resolves_container_development_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            controlled = Path(temporary)
            package_id = "saferide-v051-sagemaker-input-fixture"
            staged_root = controlled / package_id
            dev_path = staged_root / "artifacts/dataset/controlled/dev.jsonl"
            dev_path.parent.mkdir(parents=True)
            dev_path.write_text('{"fixture":"development-only"}\n', encoding="utf-8")
            dev_sha = PANEL.sha256_file(dev_path)
            package_manifest_path = staged_root / "metadata/sagemaker-package-manifest.json"
            package_manifest_path.parent.mkdir(parents=True)
            package_manifest_path.write_text(json.dumps({
                "packageId": package_id,
                "datasetId": PANEL.DATASET_ID,
                "files": [{
                    "path": "artifacts/dataset/controlled/dev.jsonl",
                    "sha256": dev_sha,
                    "sizeBytes": dev_path.stat().st_size,
                }],
            }), encoding="utf-8")
            input_manifest_path = controlled / "input-manifest.json"
            input_manifest = {
                "manifestId": package_id,
                "trainingArchive": {
                    "topLevelDirectory": package_id,
                    "packageManifestSha256": PANEL.sha256_file(package_manifest_path),
                },
            }
            resolved = PANEL.resolve_original_development(
                Path("/opt/ml/input/data/missing/dev.jsonl"),
                dev_sha,
                input_manifest_path,
                input_manifest,
                staged_root,
            )
            self.assertEqual(resolved, dev_path)


if __name__ == "__main__":
    unittest.main()
