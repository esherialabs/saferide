import argparse
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/saferide-gemma4-v051-training.py"
SPEC = importlib.util.spec_from_file_location("saferide_gemma4_v051_training", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


class V051TrainingTests(unittest.TestCase):
    def fixture(self, root):
        artifacts = root / "artifacts"
        train_path = artifacts / "dataset/controlled/train.jsonl"
        dev_path = artifacts / "dataset/controlled/dev.jsonl"
        pilot_path = artifacts / "dataset/controlled/pilot-row-manifest.json"
        manifest_path = artifacts / "dataset/public-safe/dataset-manifest.json"
        register_path = root / "register.json"
        source = [{"id": f"source-{index:04d}", "datasetId": MODULE.SOURCE_DATASET_ID, "split": "train"} for index in range(1600)]
        mitigation = [{"id": f"mitigation-{index:04d}", "datasetId": MODULE.DATASET_ID, "split": "train"} for index in range(120)]
        dev = [{"id": f"dev-{index:04d}", "datasetId": MODULE.SOURCE_DATASET_ID, "split": "dev"} for index in range(300)]
        write_jsonl(train_path, source + mitigation)
        write_jsonl(dev_path, dev)
        pilot_ids = [row["id"] for row in source[:200] + mitigation]
        pilot = {
            "schema": "com.saferide.ai.v051-pilot-row-manifest",
            "datasetId": MODULE.DATASET_ID,
            "status": "frozen",
            "seed": 419805,
            "composition": {"sourceRows": 200, "sourceRowsPerCategoryLanguage": 10, "mitigationRows": 120},
            "combinedTrainSha256": MODULE.sha256_file(train_path),
            "rowIds": pilot_ids,
            "rowIdInventorySha256": hashlib.sha256("\n".join(pilot_ids).encode()).hexdigest(),
            "mitigationHoldoutIncluded": False,
            "developmentRowsIncluded": False,
        }
        write_json(pilot_path, pilot)
        manifest = {
            "schema": "com.saferide.ai.v051-mitigation-manifest",
            "status": "frozen",
            "bindings": {"candidateManifestSha256": MODULE.CANDIDATE_MANIFEST_SHA256, "historicalCandidateManifestSha256": MODULE.CANDIDATE_MANIFEST_SHA256, "sourceDevelopmentSha256": MODULE.sha256_file(dev_path)},
            "trainingAllowed": True,
            "promotionAllowed": False,
            "review": {"status": "not_required", "approvedRoles": []},
        }
        write_json(manifest_path, manifest)
        evidence = {
            "semantic-report.json": {
                "schema": "com.saferide.ai.v051-prompt-semantic-summary",
                "schemaVersion": 2,
                "status": "passed",
                "blockingResult": {"representation": "normalized-user-turns-only-v1", "flaggedPairCount": 0, "unresolvedPairCount": 0},
                "diagnosticReconciliation": {"reproducedFlaggedPairCount": 31, "reconciled": True},
            },
            "tokenization-report.json": {"status": "passed", "truncatedRowCount": 0, "assistantOnlyLabels": True},
            "governance-state.json": {"status": "automated-eligibility-only"},
        }
        hashes = {}
        for name, value in evidence.items():
            path = artifacts / "evidence" / name
            write_json(path, value)
            hashes[name] = MODULE.sha256_file(path)
        register = {
            "schema": "com.saferide.ai.v051-mitigation-register",
            "datasetId": MODULE.DATASET_ID,
            "status": "training-ready-promotion-blocked",
            "trainingAllowed": True,
            "promotionAllowed": False,
            "candidateManifestSha256": MODULE.CANDIDATE_MANIFEST_SHA256,
            "historicalCandidateManifestSha256": MODULE.CANDIDATE_MANIFEST_SHA256,
            "intermediateReviewStatus": "not_required",
            "semanticReportSha256": hashes["semantic-report.json"],
            "tokenizationReportSha256": hashes["tokenization-report.json"],
            "governanceStateSha256": hashes["governance-state.json"],
            "files": [
                {"recordCount": 1720, "sha256": MODULE.sha256_file(train_path)},
                {"recordCount": 320, "sha256": MODULE.sha256_file(pilot_path)},
            ],
        }
        write_json(register_path, register)
        args = argparse.Namespace(register=str(register_path), train_data=str(train_path), dev_data=str(dev_path), dataset_manifest=str(manifest_path), artifact_root=str(artifacts), pilot_row_manifest=str(pilot_path))
        return args, artifacts

    def test_exact_training_package_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, _ = self.fixture(Path(temporary))
            self.assertEqual(0, MODULE.verify(args))

    def test_holdout_named_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, artifacts = self.fixture(Path(temporary))
            (artifacts / "mitigation-holdout.private.jsonl").write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "protected or reviewer bytes"):
                MODULE.verify(args)


if __name__ == "__main__":
    unittest.main()
