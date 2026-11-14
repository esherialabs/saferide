import argparse
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v054-gpu-launcher.py"
SPEC = importlib.util.spec_from_file_location("saferide_v054_gpu_launcher_test", SCRIPT)
assert SPEC and SPEC.loader
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class V054GpuLauncherTests(unittest.TestCase):
    def args(self, mode="pilot"):
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
            run_id=f"saferide-v054-{mode}-contract-test",
            container_name=f"sr4198-v054-{mode}-abcd",
            plan="/controlled/current-plan.json",
            plan_sha256="a" * 64,
            authorized_at="2026-08-08T20:00:00Z",
            execution_commit="b" * 40,
            original_code_root="/controlled/original-code",
            original_plan="/controlled/original-plan.json",
            prior_run_root="/controlled/prior-run",
            original_pilot_run_id="saferide-v054-pilot-s419805-20260808-b6df81",
        )

    def plan(self):
        return {
            "runtime": {
                "baseModel": {"revision": "70af34e20bd4b7a91f0de6b22675850c43922a03"},
                "image": {"runtimeManifestDigest": "e" * 64},
            }
        }

    def test_training_command_is_offline_read_only_single_gpu_and_not_candidate(self):
        command = LAUNCHER.training_command(self.args(), self.plan(), "f" * 64)
        joined = " ".join(command)
        self.assertIn("--network none", joined)
        self.assertIn("--gpus device=0", joined)
        self.assertIn("--read-only", command)
        self.assertIn("--run-kind pilot", joined)
        self.assertNotIn("candidate", joined)
        self.assertIn("--learning-rate 0.00002", joined)
        self.assertIn("--logging-steps 5", joined)
        self.assertIn("--max-grad-norm 1.0", joined)

    def test_preflight_is_exactly_one_step_and_uses_truthful_smoke_rate(self):
        command = LAUNCHER.training_command(self.args("preflight"), self.plan(), "f" * 64)
        joined = " ".join(command)
        self.assertIn("--max-steps 1", joined)
        self.assertIn("--learning-rate 0.00001", joined)
        self.assertIn("--logging-steps 1", joined)
        self.assertNotIn("--logging-steps 5", joined)
        self.assertIn("--eval-steps 1", joined)
        self.assertIn("--save-steps 1", joined)

    def test_parser_has_no_candidate_mode(self):
        with self.assertRaises(SystemExit):
            LAUNCHER.parse_args(["launch", "--mode", "candidate"])

    def test_reuse_command_is_read_only_offline_and_has_no_training_entrypoint(self):
        command = LAUNCHER.reuse_command(self.args("reuse"), self.plan(), "f" * 64)
        joined = " ".join(command)
        self.assertIn("--network none", joined)
        self.assertIn("--gpus device=0", joined)
        self.assertIn("--read-only", command)
        self.assertIn("pilot-reuse.py attest", joined)
        self.assertIn("/opt/saferide-prior", joined)
        self.assertNotIn("Trainer.train", joined)
        self.assertNotIn("finetune-runner.py", joined)
        self.assertNotIn("candidate", joined)

    def test_panel_verification_is_cpu_only_offline_and_uses_pinned_runtime(self):
        args = self.args("panel")
        args.plan = str(Path(__file__).resolve().parents[2] / "config/ai/datasets/saferide-gemma4-v054-next-pilot-plan.json")
        command = LAUNCHER.panel_verification_command(args)
        joined = " ".join(command)
        self.assertIn("--network none", joined)
        self.assertIn("--read-only", command)
        self.assertIn("--entrypoint python", joined)
        self.assertIn("pilot-panel.py verify-output", joined)
        self.assertNotIn("--gpus", joined)

    def test_raw_and_normalized_pilot_loss_relation_is_exact(self):
        self.assertTrue(LAUNCHER.math_close(20.0, 2.5, 8))
        self.assertFalse(LAUNCHER.math_close(20.0, 20.0, 8))


if __name__ == "__main__":
    unittest.main()
