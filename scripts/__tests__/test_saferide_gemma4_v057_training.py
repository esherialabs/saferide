import argparse
import hashlib
import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v057-training.py"
SPEC = importlib.util.spec_from_file_location("saferide_v057_training_test", SCRIPT)
assert SPEC and SPEC.loader
TRAINING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINING)

RUNNER_SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v057-finetune-runner.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("saferide_v057_finetune_runner_test", RUNNER_SCRIPT)
assert RUNNER_SPEC and RUNNER_SPEC.loader
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER)


class V057TrainingContractTests(unittest.TestCase):
    def test_contract_check_passes(self):
        self.assertEqual(TRAINING.contract_check(), 0)

    def test_initial_adapter_is_exactly_bound(self):
        plan = TRAINING.DATASET.validate_plan()
        self.assertEqual(plan["trainingHypothesis"]["initialAdapterTensorSha256"], TRAINING.EXPECTED_ADAPTER_SHA256)
        self.assertEqual(plan["rowCounts"]["weightedTrainingExamples"], 104)
        self.assertEqual(plan["rowCounts"]["expectedOptimizerSteps"], 13)


class V057ContinuationRunnerRegressionTests(unittest.TestCase):
    @staticmethod
    def wrapper_args(root: Path) -> argparse.Namespace:
        return argparse.Namespace(
            frozen_dir=str(root / "frozen"), dev_data=str(root / "dev.jsonl"),
            initial_adapter=str(root / "initial-adapter"), base_model_path=str(root / "model"),
            output_root=str(root / "model-output"), checkpoint_root=str(root / "checkpoints"),
            run_id="saferide-v057-pilot-s419805-regression",
        )

    @staticmethod
    def prepare(root: Path) -> tuple[argparse.Namespace, str, int, list[str]]:
        for name in ("frozen", "initial-adapter", "model", "model-output", "checkpoints"):
            (root / name).mkdir(mode=0o700)
        frozen = root / "frozen"
        order = [f"synthetic-train-{index:03d}" for index in range(104)]
        (frozen / "weighted-continuation-train.private.jsonl").write_text(
            "".join(json.dumps({"id": row_id, "split": "train"}) + "\n" for row_id in order),
            encoding="utf-8",
        )
        (root / "dev.jsonl").write_text(
            "".join(json.dumps({"id": f"synthetic-dev-{index:03d}", "split": "dev"}) + "\n" for index in range(300)),
            encoding="utf-8",
        )
        for name in ("register.private.json", "dataset-audit.private.json", "frozen-manifest.private.json"):
            (frozen / name).write_text("{}\n", encoding="utf-8")
        (frozen / "training-recipe.private.json").write_text(json.dumps({
            "sampleOrder": order, "sampleOrderSha256": "c" * 64,
        }), encoding="utf-8")
        initial = root / "initial-adapter"
        tensor = initial / "adapter_model.safetensors"
        tensor.write_bytes(b"synthetic-finite-initial-adapter")
        (initial / "adapter_config.json").write_text(json.dumps({
            "r": 8, "lora_alpha": 16, "lora_dropout": 0.05,
            "target_modules": [f"module-{index:03d}" for index in range(205)],
        }), encoding="utf-8")
        for name in ("README.md", "chat_template.jinja", "tokenizer.json", "tokenizer_config.json"):
            (initial / name).write_text(f"synthetic {name}\n", encoding="utf-8")
        tensor_sha = hashlib.sha256(tensor.read_bytes()).hexdigest()
        return V057ContinuationRunnerRegressionTests.wrapper_args(root), tensor_sha, tensor.stat().st_size, order

    @staticmethod
    def completed_outputs(order: list[str]) -> dict:
        adapter_files = [{
            "path": f"/private/output/{name}",
            "sha256": hashlib.sha256(name.encode()).hexdigest(),
            "sizeBytes": index + 1,
        } for index, name in enumerate(RUNNER.EXPECTED_ADAPTER_FILES)]
        return {
            "runKind": "pilot", "globalSteps": 13, "rowsSeen": 104, "epochsCompleted": 1.0,
            "sampleOrder": order, "sampleOrderSha256": "c" * 64, "holdoutRowsRead": 0,
            "lossMaskPolicy": "assistant-turns-only", "bestMetric": 1.5,
            "trainMetrics": {"train_loss": 16.0}, "logHistory": [{"step": 13, "loss": 2.0}],
            "adapterTensorValidation": {"tensorCount": 410, "elementCount": 12079104, "nonFiniteTensorCount": 0},
            "adapterFiles": adapter_files, "adapterDir": "/private/output/adapter",
            "bestCheckpoint": "/private/checkpoints/checkpoint-13", "checkpointRoot": "/private/checkpoints",
            "checkpoints": [{"path": "/private/checkpoints/checkpoint-13", "fileCount": 11, "manifestSha256": "d" * 64}],
        }

    @staticmethod
    def finite_loss() -> dict:
        return {
            "finite": True, "meanTrainingObjectiveLoss": 2.0,
            "bestDevelopmentLoss": 1.5, "finalDevelopmentLoss": 1.5,
        }

    def patches(self, tensor_sha: str, tensor_size: int, run_training):
        return (
            mock.patch.object(RUNNER, "EXPECTED_INITIAL_TENSOR_SHA256", tensor_sha),
            mock.patch.object(RUNNER, "EXPECTED_INITIAL_TENSOR_SIZE", tensor_size),
            mock.patch.object(RUNNER.TRAINING, "verify", return_value={"status": "passed"}),
            mock.patch.object(RUNNER.BASE, "load_training_lock", return_value={"torch": "2.7.0"}),
            mock.patch.object(RUNNER.BASE, "verify_installed_training_lock", return_value={"torch": "2.7.0"}),
            mock.patch.object(RUNNER.BASE, "run_training", side_effect=run_training),
            mock.patch.object(RUNNER.REMEDIATION, "build_loss_report", return_value=self.finite_loss()),
        )

    def test_complete_namespace_executes_inherited_model_card_as_pilot(self):
        wrapper = argparse.Namespace(run_id="saferide-v057-pilot-s419805-regression")
        base_args = RUNNER.build_inherited_runner_args(
            wrapper, model=Path("/controlled/model"), output_root=Path("/controlled/output"),
            checkpoint_root=Path("/controlled/checkpoints"), weighted=Path("/controlled/train.jsonl"),
            dev=Path("/controlled/dev.jsonl"), register=Path("/controlled/register.json"),
            audit=Path("/controlled/audit.json"), manifest=Path("/controlled/manifest.json"),
            frozen=Path("/controlled/frozen"), recipe_path=Path("/controlled/recipe.json"),
        )
        self.assertEqual(tuple(vars(base_args)), RUNNER.EXPECTED_INHERITED_NAMESPACE_FIELDS)
        self.assertEqual(base_args.run_kind, "pilot")
        self.assertFalse(base_args.dry_run)
        self.assertIn("| Run kind | `pilot` |", RUNNER.BASE.model_card_text(base_args, base_args.base_model_id))

    def test_completed_metadata_proves_model_card_finite_adapter_and_six_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, tensor_sha, tensor_size, order = self.prepare(root)

            def inherited_output(namespace, *_args, **_kwargs):
                self.assertEqual(tuple(vars(namespace)), RUNNER.EXPECTED_INHERITED_NAMESPACE_FIELDS)
                self.assertIn("| Run kind | `pilot` |", RUNNER.BASE.model_card_text(namespace, namespace.base_model_id))
                return self.completed_outputs(order)

            patches = self.patches(tensor_sha, tensor_size, inherited_output)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
                self.assertEqual(RUNNER.run(args), 0)
            metadata = json.loads((root / "model-output" / args.run_id / "metadata.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["status"], "completed")
            self.assertIsNone(metadata["failure"])
            self.assertTrue(metadata["inheritedRunner"]["modelCardPathPreflightPassed"])
            self.assertEqual(metadata["inheritedRunner"]["runKind"], "pilot")
            self.assertEqual(metadata["outputs"]["adapterInventoryFileCount"], 6)
            self.assertEqual(metadata["outputs"]["adapterTensorValidation"]["nonFiniteTensorCount"], 0)
            self.assertTrue(metadata["outputs"]["metadataPathsSanitized"])
            self.assertNotIn("/private/", json.dumps(metadata["outputs"]))

    def test_non_finite_adapter_cannot_reach_completed_metadata(self):
        outputs = self.completed_outputs([f"row-{index}" for index in range(104)])
        outputs["sampleOrderSha256"] = "e" * 64
        outputs["lossReport"] = self.finite_loss()
        outputs["adapterTensorValidation"]["nonFiniteTensorCount"] = 1
        with self.assertRaisesRegex(RuntimeError, "output adapter integrity"):
            RUNNER.validate_and_sanitize_completed_outputs(outputs, {
                "sampleOrder": outputs["sampleOrder"], "sampleOrderSha256": "e" * 64,
            })

    def test_failure_metadata_redacts_private_path_and_credential_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, tensor_sha, tensor_size, _order = self.prepare(root)

            def fail_after_model_card(namespace, *_args, **_kwargs):
                RUNNER.BASE.model_card_text(namespace, namespace.base_model_id)
                query_key = "".join(["to", "ken"])
                raise RuntimeError(f"failure under {root / 'model-output'}?{query_key}=visible-value")

            patches = self.patches(tensor_sha, tensor_size, fail_after_model_card)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
                with self.assertRaisesRegex(RuntimeError, "private-path"):
                    RUNNER.run(args)
            metadata = json.loads((root / "model-output" / args.run_id / "metadata.json").read_text(encoding="utf-8"))
            message = metadata["failure"]["message"]
            self.assertEqual(metadata["status"], "blocked")
            self.assertNotIn(str(root), message)
            self.assertNotIn("visible-value", message)
            self.assertIn("<private-path>", message)
            self.assertIn("[redacted]", message)
            self.assertEqual(metadata["outputs"], {})

    def test_non_finite_loss_is_rejected(self):
        outputs = self.completed_outputs([f"row-{index}" for index in range(104)])
        outputs["sampleOrderSha256"] = "e" * 64
        outputs["lossReport"] = {**self.finite_loss(), "finalDevelopmentLoss": math.nan}
        with self.assertRaisesRegex(RuntimeError, "loss evidence is non-finite"):
            RUNNER.validate_and_sanitize_completed_outputs(outputs, {
                "sampleOrder": outputs["sampleOrder"], "sampleOrderSha256": "e" * 64,
            })


if __name__ == "__main__":
    unittest.main()
