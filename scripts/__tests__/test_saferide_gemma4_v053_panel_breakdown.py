import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v053-panel-breakdown.py"
SPEC = importlib.util.spec_from_file_location("saferide_v053_panel_breakdown_test", SCRIPT)
assert SPEC and SPEC.loader
BREAKDOWN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BREAKDOWN
SPEC.loader.exec_module(BREAKDOWN)


class PanelBreakdownTests(unittest.TestCase):
    def test_content_free_breakdowns_preserve_frozen_coverage_and_gates(self):
        records = []
        for category in BREAKDOWN.ORIGINAL_CATEGORIES:
            for index in range(30):
                records.append({
                    "suiteId": "original-development",
                    "language": "en" if index < 15 else "sw",
                    "category": category,
                    "state": "complete",
                    "criticalSignals": [],
                    "overRefusal": False,
                    "usefulness": 3,
                })
        records[0]["state"] = "truncated"
        records[0]["criticalSignals"] = ["coercion-blame-or-retaliation"]
        records[0]["usefulness"] = 0
        for index in range(20):
            records.append({
                "suiteId": "mitigation-development",
                "language": "en" if index < 10 else "sw",
                "category": "agency-preserving-deescalation" if index < 12 else "hidden-instruction-nondisclosure",
                "state": "complete",
                "criticalSignals": [],
                "overRefusal": False,
                "usefulness": 2,
            })
        original = BREAKDOWN.metrics(records[:300])
        mitigation = BREAKDOWN.metrics(records[300:])

        def governed(suite_id, value):
            return {
                "suiteId": suite_id,
                "coverage": {"candidate": {
                    "rowCount": value["rowCount"],
                    "completed": value["completed"],
                    "truncated": value["truncated"],
                    "errors": value["executionErrors"],
                }},
                "metrics": {
                    "criticalFailures": value["criticalFailures"],
                    "usefulnessAverage": value["usefulnessAverage"],
                    "overRefusalRate": value["overRefusalRate"],
                },
            }

        document = BREAKDOWN.build_document(
            records,
            manifest={"panelId": "saferide-v053-pilot-panel-fixture"},
            summary={
                "candidate": {"runId": "saferide-v053-pilot-fixture"},
                "provenance": {"scoringPolicySha256": "1" * 64},
                "suiteResults": [
                    governed("original-development", original),
                    governed("mitigation-development", mitigation),
                ],
            },
            input_sha256="2" * 64,
            summary_sha256="3" * 64,
            raw_bindings=[
                {"suiteId": "original-development", "sha256": "4" * 64, "rowCount": 300},
                {"suiteId": "mitigation-development", "sha256": "5" * 64, "rowCount": 20},
            ],
            created_at="2026-08-08T00:00:00Z",
        )
        self.assertEqual([item["rowCount"] for item in document["byLanguage"]], [160, 160])
        self.assertEqual(len(document["byCategory"]), 12)
        self.assertFalse(document["gates"]["allPassed"])
        self.assertEqual(document["gates"]["reasons"], ["critical-failure-threshold", "truncation-threshold"])
        self.assertEqual(document["criticalSignals"], [{"signal": "coercion-blame-or-retaliation", "count": 1}])
        self.assertFalse(document["sealedHoldoutOpened"])
        self.assertFalse(document["privacy"]["containsRowIds"])

    def test_contract(self):
        self.assertEqual(BREAKDOWN.contract_check(), 0)


if __name__ == "__main__":
    unittest.main()
