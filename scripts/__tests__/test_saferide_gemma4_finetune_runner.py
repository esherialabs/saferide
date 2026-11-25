import argparse
import importlib.util
import json
import math
import tempfile
import unittest
from collections import UserDict
from pathlib import Path


RUNNER_PATH = Path(__file__).resolve().parents[1] / "saferide-gemma4-finetune-runner.py"
SPEC = importlib.util.spec_from_file_location("saferide_gemma4_finetune_runner", RUNNER_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)

SMOKE_PATH = Path(__file__).resolve().parents[1] / "saferide-gemma4-assistant-loss-smoke.py"
SMOKE_SPEC = importlib.util.spec_from_file_location("saferide_gemma4_assistant_loss_smoke", SMOKE_PATH)
assert SMOKE_SPEC and SMOKE_SPEC.loader
SMOKE = importlib.util.module_from_spec(SMOKE_SPEC)
SMOKE_SPEC.loader.exec_module(SMOKE)


class FakeTokenizer:
    chat_template = "fake-canonical-template-v1"
    pad_token_id = 0

    @staticmethod
    def render(messages, add_generation_prompt):
        text = "".join(f"<{item['role']}>{item['content']}</{item['role']}>" for item in messages)
        if add_generation_prompt:
            text += "<assistant>"
        return text

    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt, return_tensors):
        assert tokenize is True
        assert return_tensors is None
        return [ord(character) for character in self.render(messages, add_generation_prompt)]


class UnstableTokenizer(FakeTokenizer):
    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt, return_tensors):
        prefix = "unstable" if add_generation_prompt else "stable"
        return [ord(character) for character in prefix + self.render(messages, add_generation_prompt)]


class MappingTokenizer(FakeTokenizer):
    def apply_chat_template(self, messages, *, tokenize, add_generation_prompt, return_tensors):
        input_ids = super().apply_chat_template(
            messages,
            tokenize=tokenize,
            add_generation_prompt=add_generation_prompt,
            return_tensors=return_tensors,
        )
        return UserDict({"input_ids": input_ids, "attention_mask": [1] * len(input_ids)})


class AssistantOnlyFormattingTests(unittest.TestCase):
    def setUp(self):
        self.row = {
            "id": "synthetic-row-1",
            "messages": [
                {"role": "system", "content": "S"},
                {"role": "user", "content": "U"},
                {"role": "assistant", "content": "A"},
                {"role": "user", "content": "V"},
                {"role": "assistant", "content": "B"},
            ],
        }

    def test_masks_system_and_user_tokens_and_trains_each_assistant_turn(self):
        encoded = RUNNER.encode_assistant_only_row(FakeTokenizer(), self.row, 1024)
        rendered = "".join(chr(token) for token in encoded["input_ids"])
        labelled = "".join(
            rendered[index] for index, label in enumerate(encoded["labels"]) if label != -100
        )
        self.assertEqual(labelled, "A</assistant>B</assistant>")
        self.assertEqual(encoded["assistant_turn_count"], 2)
        self.assertGreater(encoded["assistant_token_count"], 2)
        for marker in ["<system>S</system>", "<user>U</user>", "<user>V</user>"]:
            start = rendered.index(marker)
            self.assertTrue(all(label == -100 for label in encoded["labels"][start : start + len(marker)]))

    def test_accepts_transformers_mapping_style_tokenizer_results(self):
        encoded = RUNNER.encode_assistant_only_row(MappingTokenizer(), self.row, 1024)
        self.assertEqual(encoded["assistant_turn_count"], 2)
        self.assertGreater(encoded["assistant_token_count"], 2)

    def test_missing_chat_template_fails_without_manual_role_fallback(self):
        tokenizer = FakeTokenizer()
        tokenizer.chat_template = None
        with self.assertRaisesRegex(RuntimeError, "manual role-label fallback is forbidden"):
            RUNNER.encode_assistant_only_row(tokenizer, self.row, 1024)

    def test_non_prefix_stable_template_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "assistant-only labels cannot be proven"):
            RUNNER.encode_assistant_only_row(UnstableTokenizer(), self.row, 1024)

    def test_overlength_row_is_rejected_instead_of_truncated(self):
        with self.assertRaisesRegex(RuntimeError, "silent truncation is forbidden"):
            RUNNER.encode_assistant_only_row(FakeTokenizer(), self.row, 10)


class CandidateConfigurationTests(unittest.TestCase):
    @staticmethod
    def args(**overrides):
        values = {
            "max_seq_length": 1024,
            "train_batch_size": 1,
            "eval_batch_size": 1,
            "gradient_accumulation_steps": 8,
            "logging_steps": 5,
            "eval_steps": 5,
            "save_steps": 5,
            "early_stopping_patience": 3,
            "epochs": 1.0,
            "max_steps": None,
            "warmup_ratio": 0.03,
            "base_revision": "a" * 40,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_candidate_requires_full_epoch_and_immutable_revision(self):
        RUNNER.validate_run_configuration(self.args(), "candidate")
        with self.assertRaisesRegex(RuntimeError, "at least 1"):
            RUNNER.validate_run_configuration(self.args(epochs=0.5), "candidate")
        with self.assertRaisesRegex(RuntimeError, "immutable"):
            RUNNER.validate_run_configuration(self.args(base_revision="main"), "candidate")

    def test_step_cap_is_pilot_only(self):
        with self.assertRaisesRegex(RuntimeError, "cannot use --max-steps"):
            RUNNER.validate_run_configuration(self.args(max_steps=10), "candidate")

    def test_failure_handoff_redacts_credentials_and_url_tokens(self):
        query_key = "".join(["to", "ken"])
        message = RUNNER.sanitized_error_message(RuntimeError(f"download failed ?{query_key}=visible-value"))
        self.assertNotIn("visible-value", message)
        self.assertIn("[redacted]", message)

    def test_training_lock_pins_direct_and_transitive_python_dependencies(self):
        pins = RUNNER.load_training_lock(RUNNER.DEFAULT_REQUIREMENTS, RUNNER.DEFAULT_CONSTRAINTS)
        self.assertGreater(len(pins), 8)
        self.assertEqual(pins["huggingface-hub"], "1.5.0")
        self.assertEqual(pins["protobuf"], "6.33.6")
        self.assertEqual(pins["torch"], "2.7.0")
        self.assertEqual(pins["transformers"], "5.5.4")

    def test_training_lock_rejects_an_installed_version_mismatch(self):
        with self.assertRaisesRegex(RuntimeError, "do not match the approved training lock"):
            RUNNER.verify_installed_training_lock(
                {"torch": "2.7.0"},
                version_getter=lambda _name: "2.8.0",
            )

    def test_training_lock_accepts_a_cuda_local_version_of_the_exact_torch_release(self):
        installed = RUNNER.verify_installed_training_lock(
            {"torch": "2.7.0"},
            version_getter=lambda _name: "2.7.0+cu126",
        )
        self.assertEqual(installed["torch"], "2.7.0+cu126")

    def test_cuda_bf16_is_preferred_only_when_the_device_supports_it(self):
        class FakeCuda:
            @staticmethod
            def is_bf16_supported():
                return True

        class FakeTorch:
            cuda = FakeCuda()

        self.assertTrue(RUNNER.cuda_bf16_supported(FakeTorch(), True))
        self.assertFalse(RUNNER.cuda_bf16_supported(FakeTorch(), False))

    def test_non_finite_training_evidence_fails_closed(self):
        RUNNER.assert_finite_training_evidence({"loss": 1.0, "history": [{"grad_norm": 2.0}]})
        for value in (math.nan, math.inf, -math.inf):
            with self.assertRaisesRegex(RuntimeError, "Non-finite training metric"):
                RUNNER.assert_finite_training_evidence({"history": [{"grad_norm": value}]})

    def test_metadata_writer_rejects_non_standard_json_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                RUNNER.write_metadata(Path(directory) / "run", {"grad_norm": math.nan})

    def test_v054_register_selects_the_targeted_pilot_profile(self):
        self.assertEqual(
            RUNNER.dataset_profile_for_register({"schema": "com.saferide.ai.v054-mitigation-register"}),
            "v054",
        )

    def test_v054_targeted_pilot_recipe_is_fixed_and_candidate_is_forbidden(self):
        args = self.args(
            seed=419805,
            base_model_id=RUNNER.DEFAULT_BASE_MODEL,
            learning_rate=2e-5,
            lora_r=8,
            lora_alpha=16,
            lora_dropout=0.05,
            lora_rank_approval_ref=None,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            eval_steps=25,
            save_steps=25,
        )
        RUNNER.validate_run_configuration(args, "pilot", "v054")
        with self.assertRaisesRegex(RuntimeError, "full candidate submission is not authorized"):
            RUNNER.validate_run_configuration(args, "candidate", "v054")
        with self.assertRaisesRegex(RuntimeError, "frozen 2e-5"):
            RUNNER.validate_run_configuration(argparse.Namespace(**{**vars(args), "learning_rate": 1e-5}), "pilot", "v054")
        with self.assertRaisesRegex(RuntimeError, "clipping"):
            RUNNER.validate_run_configuration(argparse.Namespace(**{**vars(args), "max_grad_norm": 2.0}), "pilot", "v054")

    def test_v054_preflight_requires_step_one_training_loss_logging(self):
        args = self.args(
            seed=419805,
            base_model_id=RUNNER.DEFAULT_BASE_MODEL,
            learning_rate=1e-5,
            lora_r=8,
            lora_alpha=16,
            lora_dropout=0.05,
            lora_rank_approval_ref=None,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            max_steps=1,
            logging_steps=1,
            eval_steps=1,
            save_steps=1,
        )
        RUNNER.validate_run_configuration(args, "preflight", "v054")
        with self.assertRaisesRegex(RuntimeError, "training-loss logging at step 1"):
            RUNNER.validate_run_configuration(
                argparse.Namespace(**{**vars(args), "logging_steps": 5}),
                "preflight",
                "v054",
            )

    def test_v054_preflight_binds_the_frozen_recipe_without_consuming_pilot_order(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipe.json"
            order = [f"row-{index}" for index in range(1864)] + [f"row-{index}" for index in range(32)]
            path.write_text(json.dumps({
                "schema": "com.saferide.ai.v054-training-recipe",
                "datasetId": "saferide-synthetic-guidance-v0.5.4",
                "status": "frozen-for-targeted-next-pilot",
                "learningRate": 2e-5,
                "epochs": 1,
                "fullCandidateSubmissionAuthorized": False,
                "seed": 419805,
                "sampleOrder": order,
                "sampleOrderSha256": RUNNER.hashlib.sha256("\n".join(order).encode("utf-8")).hexdigest(),
            }), encoding="utf-8")
            self.assertIsNone(RUNNER.load_pilot_row_ids(path, "v054", "preflight"))

    def test_v055_register_selects_final_targeted_profile(self):
        self.assertEqual(
            RUNNER.dataset_profile_for_register({"schema": "com.saferide.ai.v055-mitigation-register"}),
            "v055",
        )

    def test_v055_low_rate_pilot_is_fixed_and_candidate_is_forbidden(self):
        args = self.args(
            seed=419805,
            base_model_id=RUNNER.DEFAULT_BASE_MODEL,
            learning_rate=1e-5,
            lora_r=8,
            lora_alpha=16,
            lora_dropout=0.05,
            lora_rank_approval_ref=None,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            eval_steps=25,
            save_steps=25,
        )
        RUNNER.validate_run_configuration(args, "pilot", "v055")
        with self.assertRaisesRegex(RuntimeError, "full candidate submission is not authorized"):
            RUNNER.validate_run_configuration(args, "candidate", "v055")
        with self.assertRaisesRegex(RuntimeError, "frozen 1e-5"):
            RUNNER.validate_run_configuration(argparse.Namespace(**{**vars(args), "learning_rate": 2e-5}), "pilot", "v055")

    def test_v055_weighted_recipe_is_exact_and_preflight_does_not_consume_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipe.json"
            unique = [f"row-{index}" for index in range(1896)]
            order = unique + [f"row-{index}" for index in range(32)] * 3
            path.write_text(json.dumps({
                "schema": "com.saferide.ai.v055-training-recipe",
                "datasetId": "saferide-synthetic-guidance-v0.5.5",
                "status": "frozen-for-final-targeted-pilot",
                "learningRate": 1e-5,
                "epochs": 1,
                "fullCandidateSubmissionAuthorized": False,
                "seed": 419805,
                "sampleOrder": order,
                "sampleOrderSha256": RUNNER.hashlib.sha256("\n".join(order).encode("utf-8")).hexdigest(),
            }), encoding="utf-8")
            self.assertEqual(len(RUNNER.load_pilot_row_ids(path, "v055", "pilot")), 1992)
            self.assertIsNone(RUNNER.load_pilot_row_ids(path, "v055", "preflight"))

    def test_v056_control_replay_is_fixed_and_candidate_is_forbidden(self):
        self.assertEqual(
            RUNNER.dataset_profile_for_register({"schema": "com.saferide.ai.v056-mitigation-register"}),
            "v056",
        )
        args = self.args(
            seed=419805,
            base_model_id=RUNNER.DEFAULT_BASE_MODEL,
            learning_rate=2e-5,
            lora_r=8,
            lora_alpha=16,
            lora_dropout=0.05,
            lora_rank_approval_ref=None,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            eval_steps=25,
            save_steps=25,
        )
        RUNNER.validate_run_configuration(args, "pilot", "v056")
        with self.assertRaisesRegex(RuntimeError, "full candidate submission is not authorized"):
            RUNNER.validate_run_configuration(args, "candidate", "v056")
        with self.assertRaisesRegex(RuntimeError, "frozen 2e-5"):
            RUNNER.validate_run_configuration(argparse.Namespace(**{**vars(args), "learning_rate": 1e-5}), "pilot", "v056")

    def test_v056_weighted_recipe_preserves_v054_control_multiplicity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recipe.json"
            unique = [f"row-{index}" for index in range(1888)]
            focused = unique[-56:]
            order = unique + focused
            path.write_text(json.dumps({
                "schema": "com.saferide.ai.v056-training-recipe",
                "datasetId": "saferide-synthetic-guidance-v0.5.6",
                "status": "frozen-for-targeted-next-pilot",
                "learningRate": 2e-5,
                "epochs": 1,
                "fullCandidateSubmissionAuthorized": False,
                "seed": 419805,
                "sampleOrder": order,
                "sampleOrderSha256": RUNNER.hashlib.sha256("\n".join(order).encode("utf-8")).hexdigest(),
            }), encoding="utf-8")
            self.assertEqual(len(RUNNER.load_pilot_row_ids(path, "v056", "pilot")), 1944)
            self.assertIsNone(RUNNER.load_pilot_row_ids(path, "v056", "preflight"))


class FinalEvaluationControlFlowTests(unittest.TestCase):
    class FakeTrainer:
        def __init__(self, history):
            self.state = argparse.Namespace(global_step=237, log_history=history)
            self.evaluate_calls = 0

        def evaluate(self):
            self.evaluate_calls += 1
            return {"eval_loss": 2.0, "eval_runtime": 25.0, "epoch": 1.0}

    def test_reuses_scheduled_evaluation_at_final_step_without_replay(self):
        trainer = self.FakeTrainer([{
            "step": 237,
            "epoch": 1.0,
            "eval_loss": 1.8524575233459473,
            "eval_runtime": 24.6787,
        }])
        metrics = RUNNER.final_evaluation_metrics(trainer)
        self.assertEqual(metrics, {
            "epoch": 1.0,
            "eval_loss": 1.8524575233459473,
            "eval_runtime": 24.6787,
        })
        self.assertEqual(trainer.evaluate_calls, 0)

    def test_runs_one_explicit_evaluation_when_final_step_was_not_evaluated(self):
        trainer = self.FakeTrainer([{"step": 225, "epoch": 0.95, "eval_loss": 1.9}])
        self.assertEqual(RUNNER.final_evaluation_metrics(trainer)["eval_loss"], 2.0)
        self.assertEqual(trainer.evaluate_calls, 1)

    def test_duplicate_final_step_evaluations_fail_closed(self):
        trainer = self.FakeTrainer([
            {"step": 237, "epoch": 1.0, "eval_loss": 1.85},
            {"step": 237, "epoch": 1.0, "eval_loss": 1.85},
        ])
        with self.assertRaisesRegex(RuntimeError, "duplicate evaluation entries"):
            RUNNER.final_evaluation_metrics(trainer)
        self.assertEqual(trainer.evaluate_calls, 0)


class OfflineGradientSmokeTests(unittest.TestCase):
    def test_two_assistant_turns_have_nonzero_gradient_and_masked_turns_have_none(self):
        report = SMOKE.run_smoke()
        self.assertTrue(report["passed"])
        self.assertEqual(report["assistantTurns"], 2)
        self.assertGreater(report["supervisedAssistantTokens"], 0)
        self.assertGreater(report["maskedSystemUserAndPaddingTokens"], 0)
        self.assertEqual(report["maskedGradientContributions"], 0)
        self.assertTrue(report["lossDecreasedAfterOneStep"])
        self.assertFalse(report["rawContentRecorded"])
        self.assertEqual(report["modelDownloads"], 0)


if __name__ == "__main__":
    unittest.main()
