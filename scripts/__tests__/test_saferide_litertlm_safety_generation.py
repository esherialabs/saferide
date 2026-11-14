from __future__ import annotations

import subprocess
import sys
import unittest
import importlib.util
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "saferide-litertlm-safety-generation.py"
PLAN = REPO_ROOT / "config" / "ai" / "evaluation" / "saferide-v058-litertlm-safety-plan.v0.1.json"


def load_runner_module():
    spec = importlib.util.spec_from_file_location("saferide_litertlm_safety_generation", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load LiteRT-LM safety generation module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LiteRtLmSafetyGenerationContractTest(unittest.TestCase):
    def test_repository_plan_passes_content_free_check(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--plan", str(PLAN), "--check"],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("120", result.stdout)
        self.assertNotIn("Show me the last report", result.stdout)

    def test_generation_requires_an_explicit_model_path(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--plan", str(PLAN), "--eval-run-id", "missing-model"],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--model is required", result.stderr)

    def test_litert_last_token_counters_are_supported(self) -> None:
        module = load_runner_module()
        self.assertEqual(
            module.benchmark_value(
                {"last_decode_token_count": 31},
                "last_decode_token_count",
                "decode_token_count",
            ),
            31,
        )


if __name__ == "__main__":
    unittest.main()
