import importlib.util
import copy
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/saferide-gemma4-v051-semantic.py"
SPEC = importlib.util.spec_from_file_location("saferide_gemma4_v051_semantic", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class V051SemanticTests(unittest.TestCase):
    def test_visible_conversation_excludes_system_prompt(self):
        row = {
            "messages": [
                {"role": "system", "content": "hidden system text"},
                {"role": "user", "content": "visible request"},
                {"role": "assistant", "content": "visible target"},
            ]
        }
        self.assertEqual("user:\nvisible request\nassistant:\nvisible target", MODULE.semantic_text(row))

    def test_prompt_representation_excludes_system_and_assistant_content(self):
        row = {
            "messages": [
                {"role": "system", "content": "hidden system text"},
                {"role": "user", "content": "  First\tvisible\r\nrequest  "},
                {"role": "assistant", "content": "shared safe response"},
                {"role": "user", "content": "Second   visible request"},
                {"role": "assistant", "content": "another shared safe response"},
            ]
        }
        self.assertEqual("First visible request\nSecond visible request", MODULE.prompt_only_text(row))

    def test_assistant_or_system_changes_do_not_change_prompt_representation(self):
        first = {
            "messages": [
                {"role": "system", "content": "system one"},
                {"role": "user", "content": "same user request"},
                {"role": "assistant", "content": "safe target one"},
            ]
        }
        second = copy.deepcopy(first)
        second["messages"][0]["content"] = "completely different system"
        second["messages"][2]["content"] = "completely different safe target"
        self.assertEqual(MODULE.prompt_only_text(first), MODULE.prompt_only_text(second))
        self.assertNotEqual(MODULE.full_dialogue_text(first), MODULE.full_dialogue_text(second))

    def test_prompt_normalization_is_nfkc_deterministic_and_case_preserving(self):
        self.assertEqual("ABC Case", MODULE.normalize_prompt_turn("ＡＢＣ\u00a0Case"))
        self.assertNotEqual(MODULE.normalize_prompt_turn("Case"), MODULE.normalize_prompt_turn("case"))

    def test_cross_split_inventory_is_exact(self):
        pairs = list(MODULE.iter_cross_split_pairs({
            "train": list(range(120)),
            "mitigation-dev": list(range(20)),
            "mitigation-holdout": list(range(20)),
        }))
        self.assertEqual(5200, sum(len(left) * len(right) for left, right in pairs))

    def test_bilingual_siblings_are_required_in_one_split_and_never_cross_split_exempted(self):
        rows = []
        for family_index in range(80):
            split = "train" if family_index < 60 else "mitigation-dev" if family_index < 70 else "mitigation-holdout"
            for language in ("en", "sw"):
                rows.append({
                    "split": split,
                    "metadata": {
                        "scenarioFamilyId": f"family-{family_index:04d}",
                        "language": language,
                    },
                })
        indices = MODULE.candidate_split_indices(rows)
        self.assertEqual({"train": 120, "mitigation-dev": 20, "mitigation-holdout": 20}, {key: len(value) for key, value in indices.items()})
        rows[1]["split"] = "mitigation-dev"
        rows[121]["split"] = "train"
        with self.assertRaisesRegex(RuntimeError, "crosses split boundaries"):
            MODULE.candidate_split_indices(rows)

    def test_controlled_remediation_record_has_only_approved_content_free_fields(self):
        row = {
            "candidateId": "v051-candidate-" + "a" * 24,
            "split": "train",
            "metadata": {
                "reviewableContentSha256": "b" * 64,
                "scenarioFamilyId": "v051-mitigation-family-0001",
                "language": "en",
                "track": "agency-preserving-deescalation",
            },
        }
        record = MODULE.remediation_record(row, "prompt-source-blocking", 0.93)
        self.assertEqual({"candidateId", "candidateHash", "family", "language", "split", "track", "collisionType", "similarityScore"}, set(record))
        self.assertNotIn("sourceId", record)
        self.assertNotIn("prompt", record)

    def test_full_dialogue_only_and_prompt_findings_can_be_reconciled_by_pair_identity(self):
        full = {("source", 0, 1), ("cross", 2, 3), ("source", 4, 5)}
        prompt = {("cross", 2, 3), ("source", 8, 9)}
        self.assertEqual(2, len(full - prompt))
        self.assertEqual(1, len(full & prompt))
        self.assertEqual(1, len(prompt - full))

    def test_contract_keeps_human_gate_retired_and_threshold_fixed(self):
        self.assertEqual(0, MODULE.contract_check())
        self.assertEqual(0.92, MODULE.THRESHOLD)
        self.assertEqual("fd277cdb16ad3e3543d50bcc28e91a1be1b0180145c1701b92ebd55c7f76a6a6", MODULE.HISTORICAL_REPORT_SHA256)


if __name__ == "__main__":
    unittest.main()
