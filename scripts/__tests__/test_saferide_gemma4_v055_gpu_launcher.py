import argparse
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v055-gpu-launcher.py"
SPEC = importlib.util.spec_from_file_location("saferide_v055_gpu_launcher_test", SCRIPT)
assert SPEC and SPEC.loader
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class V055GpuLauncherTests(unittest.TestCase):
    @staticmethod
    def args(mode="pilot"):
        return argparse.Namespace(
            mode=mode,
            code_root="/controlled/code",
            frozen_dir="/controlled/frozen",
            dev_data="/controlled/dev/original-development.jsonl",
            model_dir="/controlled/model",
            runtime_root="/controlled/runtime",
            model_output_dir="/controlled/model-output",
            output_data_dir="/controlled/output-data",
            checkpoint_dir="/controlled/checkpoints",
            panel_input="/controlled/panel" if mode == "panel" else None,
            run_id=f"saferide-v055-{mode}-contract-test",
            container_name=f"sr4198-v055-{mode}-abcd",
            plan="/controlled/current-plan.json",
            plan_sha256="a" * 64,
            authorized_at="2026-08-08T20:00:00Z",
            execution_commit=None,
            original_code_root=None,
            original_plan=None,
            prior_run_root=None,
            original_pilot_run_id=None,
        )

    @staticmethod
    def plan():
        return {
            "runtime": {
                "baseModel": {"revision": "70af34e20bd4b7a91f0de6b22675850c43922a03"},
                "image": {"runtimeManifestDigest": "e" * 64},
            }
        }

    def test_pilot_is_offline_read_only_single_gpu_and_low_rate(self):
        joined = " ".join(LAUNCHER.training_command(self.args(), self.plan(), "f" * 64))
        self.assertIn("--network none", joined)
        self.assertIn("--gpus device=0", joined)
        self.assertIn("--read-only", joined)
        self.assertIn("--run-kind pilot", joined)
        self.assertIn("--learning-rate 0.00001", joined)
        self.assertIn("--max-grad-norm 1.0", joined)
        self.assertNotIn("candidate", joined)

    def test_parser_has_neither_candidate_nor_reuse_mode(self):
        with self.assertRaises(SystemExit):
            LAUNCHER.parse_args(["launch", "--mode", "candidate"])
        with self.assertRaises(SystemExit):
            LAUNCHER.parse_args(["launch", "--mode", "reuse"])

    def test_preflight_remains_exactly_one_step(self):
        joined = " ".join(LAUNCHER.training_command(self.args("preflight"), self.plan(), "f" * 64))
        self.assertIn("--max-steps 1", joined)
        self.assertIn("--logging-steps 1", joined)
        self.assertIn("--eval-steps 1", joined)
        self.assertIn("--save-steps 1", joined)

    def test_raw_and_normalized_loss_relation_is_exact(self):
        self.assertTrue(LAUNCHER.math_close(20.0, 2.5, 8))
        self.assertFalse(LAUNCHER.math_close(20.0, 20.0, 8))


if __name__ == "__main__":
    unittest.main()
