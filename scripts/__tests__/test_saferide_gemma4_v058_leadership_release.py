import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v058-leadership-release.py"
LAUNCHER = SCRIPT.with_name("saferide-gemma4-v058-holdout-a11-launcher.sh")
SELECTION = SCRIPT.parents[1] / "config/ai/training/saferide-gemma4-v058-leadership-selection.json"
SPEC = importlib.util.spec_from_file_location("saferide_v058_leadership_test", SCRIPT)
assert SPEC and SPEC.loader
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)


class V058LeadershipReleaseTests(unittest.TestCase):
    def test_current_selection_is_bound_to_exact_release_code(self):
        selection = RELEASE.selection_gate(SELECTION)
        self.assertEqual(selection["selected"]["seed"], 419806)
        self.assertFalse(selection["selected"]["continuationSelected"])

    def test_holdout_acceptance_has_only_the_two_authorized_gates(self):
        reported_but_not_gated = {
            "criticalFailures": 0,
            "errors": 0,
            "truncated": 20,
            "modelTerminatorStops": 0,
            "usefulnessAverage": 0,
            "languageMismatchRows": 20,
        }
        self.assertEqual(RELEASE.holdout_acceptance(reported_but_not_gated), (True, []))
        self.assertEqual(
            RELEASE.holdout_acceptance({**reported_but_not_gated, "criticalFailures": 1}),
            (False, ["critical-failures-nonzero"]),
        )
        self.assertEqual(
            RELEASE.holdout_acceptance({**reported_but_not_gated, "errors": 1}),
            (False, ["execution-errors-nonzero"]),
        )

    def test_one_time_receipt_requires_immutable_exact_bindings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selection = root / "selection.json"
            selection.write_bytes(SELECTION.read_bytes())
            receipt = root / "receipt.json"
            value = {
                "schema": "com.saferide.ai.private-v058-one-time-holdout-access",
                "status": "claimed-for-exactly-one-controlled-evaluation",
                "selectionSha256": RELEASE.sha256_file(selection),
                "selectedMetadataSha256": RELEASE.SELECTED_METADATA_SHA256,
                "selectedAdapterInventorySha256": RELEASE.SELECTED_ADAPTER_INVENTORY_SHA256,
                "holdoutSha256": RELEASE.SEALED_HOLDOUT_SHA256,
                "holdoutSizeBytes": RELEASE.SEALED_HOLDOUT_SIZE_BYTES,
                "recordCount": RELEASE.SEALED_HOLDOUT_ROWS,
                "maximumEvaluatorRuns": 1,
                "holdoutContentParsedBeforeClaim": False,
                "evaluatorSha256": RELEASE.sha256_file(SCRIPT),
                "launcherSha256": RELEASE.sha256_file(LAUNCHER),
                "v057PanelDependencySha256": RELEASE.V057_PANEL_SHA256,
                "modelInventorySha256": RELEASE.MODEL_INVENTORY_SHA256,
                "imageConfigDigest": RELEASE.IMAGE_CONFIG_DIGEST,
                "lineageProofSha256": hashlib.sha256(b"content-free-lineage-proof").hexdigest(),
                "accessTransactionId": "synthetic-test-transaction",
            }
            receipt.write_text(json.dumps(value), encoding="utf-8")
            receipt.chmod(0o400)
            self.assertEqual(RELEASE.validate_access_receipt(receipt, selection)["maximumEvaluatorRuns"], 1)
            receipt.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, "immutable mode"):
                RELEASE.validate_access_receipt(receipt, selection)

    def test_continuation_checkpoint_gate_detects_byte_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkpoints"
            checkpoint = root / "checkpoint-4"
            checkpoint.mkdir(parents=True, mode=0o700)
            root.chmod(0o700)
            for index in range(11):
                name = "adapter_model.safetensors" if index == 0 else f"checkpoint-file-{index}.json"
                (checkpoint / name).write_bytes(f"controlled-checkpoint-{index}".encode("utf-8"))
            files = RELEASE.file_inventory(checkpoint)
            historical_files = [
                {**item, "path": f"/checkpoints/{RELEASE.CONTINUATION_RUN_ID}/checkpoint-4/{item['path']}"}
                for item in files
            ]
            declared = {
                "path": "checkpoint-4",
                "fileCount": len(files),
                "manifestSha256": RELEASE.canonical_sha256(historical_files),
            }
            metadata = {"outputs": {"checkpoints": [declared]}}
            tensor_sha = next(item["sha256"] for item in files if item["path"] == "adapter_model.safetensors")
            with mock.patch.multiple(
                RELEASE,
                CONTINUATION_CHECKPOINT_INVENTORY_SHA256=RELEASE.canonical_sha256([declared]),
                CONTINUATION_ADAPTER_TENSOR_SHA256=tensor_sha,
            ):
                self.assertEqual(RELEASE.continuation_checkpoint_gate(metadata, root), files)
                (checkpoint / "checkpoint-file-1.json").write_text("mutated", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "checkpoint bytes differ"):
                    RELEASE.continuation_checkpoint_gate(metadata, root)

    def test_adapter_file_map_accepts_the_governed_nested_tokenizer_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "adapter"
            tokenizer = root / "tokenizer"
            tokenizer.mkdir(parents=True)
            root.chmod(0o700)
            for name in ("README.md", "adapter_config.json", "adapter_model.safetensors"):
                (root / name).write_text(name, encoding="utf-8")
            for name in ("chat_template.jinja", "tokenizer.json", "tokenizer_config.json"):
                (tokenizer / name).write_text(name, encoding="utf-8")
            self.assertEqual(set(RELEASE.adapter_file_map(root)), set(RELEASE.EXPECTED_ADAPTER_FILES))

    def test_model_card_is_truthful_and_content_free(self):
        selection = json.loads(SELECTION.read_text(encoding="utf-8"))
        summary = {
            "metrics": {
                "rowCount": 20, "completed": 19, "truncated": 1, "errors": 0,
                "criticalFailures": 0, "modelTerminatorStops": 19,
                "usefulnessAverage": 2.5, "overRefusalRate": 0.05,
            },
            "byCategory": [{
                "category": "controlled-category", "rowCount": 20, "completed": 19,
                "truncated": 1, "errors": 0, "criticalFailures": 0,
                "modelTerminatorStops": 19, "usefulnessAverage": 2.5,
            }],
            "language": {"languageMatchRows": 20},
            "safety": {"systemPromptDisclosureFindings": 0},
        }
        card = RELEASE.model_card(selection, summary)
        self.assertIn("319 of 320", card)
        self.assertIn("one noncritical truncation", card)
        self.assertIn("not deployed, not published", card)
        self.assertNotIn("/home/", card)
        self.assertNotIn("rowId", card)

    def test_source_orders_receipt_validation_before_semantic_parse(self):
        source = SCRIPT.read_text(encoding="utf-8")
        evaluate_source = source[source.index("def evaluate("):source.index("def model_card(")]
        self.assertLess(evaluate_source.index("validate_access_receipt"), evaluate_source.index("read_jsonl(holdout_path)"))
        self.assertEqual(evaluate_source.count("read_jsonl(holdout_path)"), 1)
        self.assertNotIn("huggingface_hub", source)
        self.assertNotIn("HfApi", source)

    def test_launcher_is_one_offline_container_and_has_no_screen_or_aws_path(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertEqual(source.count("docker run --rm"), 1)
        self.assertIn("--network none", source)
        self.assertIn("--pull never", source)
        self.assertIn("--read-only", source)
        self.assertNotIn("screen ", source)
        self.assertNotIn("aws ", source.lower())
        self.assertIn("final_idle", source)
        self.assertLess(source.index("final_idle=false"), source.index("container_exit_code\" -eq 2"))


if __name__ == "__main__":
    unittest.main()
