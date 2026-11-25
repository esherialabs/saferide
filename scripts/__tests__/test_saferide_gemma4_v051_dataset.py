import argparse
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/saferide-gemma4-v051-dataset.py"
SPEC = importlib.util.spec_from_file_location("saferide_gemma4_v051_dataset", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class V051DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan, cls.prompt = MODULE.load_plan_and_prompt(MODULE.PLAN_PATH, MODULE.PROMPT_PATH)

    def source_document(self):
        families = []
        for slot in MODULE.allocation_slots(419805):
            factory = MODULE.draft_agency_content if slot["track"] == MODULE.AGENCY_TRACK else MODULE.draft_nondisclosure_content
            families.append({
                "ordinal": slot["ordinal"],
                "familyId": slot["familyId"],
                "split": slot["split"],
                "track": slot["track"],
                "variant": slot["variant"],
                "conversationForm": slot["conversationForm"],
                "en": factory(slot, "en"),
                "sw": factory(slot, "sw"),
            })
        return {
            "schema": "com.saferide.ai.v051-mitigation-authoring-source",
            "schemaVersion": 1,
            "sourceId": "saferide-v051-mitigation-authoring-testfixture",
            "datasetId": MODULE.DATASET_ID,
            "classification": "restricted-synthetic-content",
            "createdAt": "2026-08-04T00:00:00Z",
            "authoringSeed": 419851,
            "allocationSeed": 419805,
            "adjudicationSummarySha256": MODULE.ADJUDICATION_SHA256,
            "systemPromptTextSha256": self.prompt["textSha256"],
            "families": families,
            "attestations": {
                "syntheticOnly": True,
                "failedDevelopmentPromptsNotViewedForAuthoring": True,
                "failedDevelopmentPromptsNotCopiedOrParaphrased": True,
                "negativeBehaviorOnlyInUserTurns": True,
                "assistantTargetsSafeOnly": True,
                "noSurvivorData": True,
                "noProductionData": True,
            },
        }

    def rendered_rows(self):
        source = self.source_document()
        return MODULE.render_rows(source, self.plan, self.prompt, "a" * 40, MODULE.canonical_sha256(source))

    def test_allocation_is_reproducible_and_exact(self):
        first = MODULE.allocation_slots(419805)
        second = MODULE.allocation_slots(419805)
        self.assertEqual(first, second)
        self.assertEqual(80, len(first))
        self.assertEqual({"train": 60, "mitigation-dev": 10, "mitigation-holdout": 10}, dict(MODULE.collections.Counter(item["split"] for item in first)))
        self.assertEqual({MODULE.AGENCY_TRACK: 48, MODULE.NONDISCLOSURE_TRACK: 32}, dict(MODULE.collections.Counter(item["track"] for item in first)))

    def test_authoring_source_and_rendered_rows_pass_strict_structural_gates(self):
        source = self.source_document()
        MODULE.validate_authoring_source(source, self.plan, self.prompt)
        rows = self.rendered_rows()
        counts = MODULE.validate_row_shapes(rows, self.plan, self.prompt)
        quality = MODULE.safety_and_quality_checks(rows, self.prompt)
        diversity = MODULE.assistant_diversity_checks(rows)
        self.assertEqual(160, len(rows))
        self.assertEqual({"en": 80, "sw": 80}, counts["languageCounts"])
        self.assertEqual("passed", quality["status"])
        self.assertEqual("passed", diversity["status"])
        self.assertEqual(0, quality["unsafeTargetFindingCount"])

    def test_family_reassignment_and_target_duplication_fail_closed(self):
        source = self.source_document()
        source["families"][0]["split"] = "mitigation-holdout"
        with self.assertRaisesRegex(RuntimeError, "allocation differs"):
            MODULE.validate_authoring_source(source, self.plan, self.prompt)
        rows = self.rendered_rows()
        rows[1]["messages"][-1]["content"] = rows[0]["messages"][-1]["content"]
        with self.assertRaisesRegex(RuntimeError, "targets are not unique"):
            MODULE.safety_and_quality_checks(rows, self.prompt)

    def test_historical_review_templates_remain_blank_and_are_not_gates(self):
        rows = self.rendered_rows()
        manifest_sha = "b" * 64
        for role in MODULE.REVIEW_ROLES:
            template = MODULE.review_template(role, rows, manifest_sha, self.prompt["textSha256"])
            MODULE.validate_pending_review(template, role, rows, manifest_sha)
            self.assertIsNone(template["reviewer"])
            self.assertTrue(all(decision["status"] is None for decision in template["rowDecisions"]))
        governance = MODULE.load_governance()
        self.assertTrue(all(item["status"] == "not_required" for item in governance["retiredIntermediateGates"]))
        self.assertFalse(governance["historicalForms"]["approvalInferred"])

    def test_historical_form_rejects_auto_filled_approval(self):
        rows = self.rendered_rows()
        template = MODULE.review_template("technical-ml", rows, "c" * 64, self.prompt["textSha256"])
        template["attestation"]["humanAuthored"] = True
        with self.assertRaisesRegex(RuntimeError, "pre-fills human attestations"):
            MODULE.validate_pending_review(template, "technical-ml", rows, "c" * 64)

    def test_final_rows_mark_retired_reviews_not_required(self):
        row = self.rendered_rows()[0]
        final = MODULE.final_row(row)
        self.assertEqual("final", final["stage"])
        self.assertEqual("not_required", final["metadata"]["reviewStatus"])
        self.assertEqual([], final["metadata"]["reviewLedgerRefs"])

    def test_governance_never_interprets_retired_forms_as_approved(self):
        governance = copy.deepcopy(MODULE.load_governance())
        governance["retiredIntermediateGates"][0]["status"] = "approved"
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "governance.json"
            path.write_text(json.dumps(governance), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "not_required"):
                MODULE.load_governance(path)

    def test_visible_source_separation_evaluates_every_pair(self):
        rows = self.rendered_rows()
        source_rows = []
        for index in range(1900):
            split = "train" if index < 1600 else "dev"
            source_rows.append({
                "id": f"v05-fixture-{index:04d}",
                "split": split,
                "messages": [
                    {"role": "system", "content": "fixture system"},
                    {"role": "user", "content": f"quartz xenon fixturetoken{index} nebula"},
                    {"role": "assistant", "content": f"orbit cobalt uniquetarget{index} prism"},
                ],
            })
        report = MODULE.separation_checks(rows, source_rows, self.plan)
        self.assertEqual(304000, report["visibleSourceComparisonPairs"])
        self.assertEqual(5200, report["newCrossSplitPairs"])
        self.assertEqual(0, report["flaggedPairCount"])

    def test_pilot_selection_is_deterministic_and_includes_all_mitigation_train_rows(self):
        source = []
        categories = [f"category-{index:02d}" for index in range(10)]
        for category in categories:
            for language in ("en", "sw"):
                for index in range(80):
                    source.append({
                        "id": f"source-{category}-{language}-{index:03d}",
                        "metadata": {"primaryCategory": category, "language": language},
                    })
        mitigation = [row for row in self.rendered_rows() if row["split"] == "train"]
        first = MODULE.build_pilot_manifest(source, mitigation, "d" * 64)
        second = MODULE.build_pilot_manifest(source, mitigation, "d" * 64)
        self.assertEqual(first, second)
        self.assertEqual({"sourceRows": 200, "sourceRowsPerCategoryLanguage": 10, "mitigationRows": 120}, first["composition"])
        self.assertEqual(320, len(first["rowIds"]))
        self.assertTrue({row["id"] for row in mitigation}.issubset(set(first["rowIds"])))

    def test_targeted_remediation_is_deterministic_and_uses_fresh_round_scenarios(self):
        slot = MODULE.allocation_slots(419805)[0]
        first = MODULE.remediation_content(slot, "en", 419852, 1)
        repeated = MODULE.remediation_content(slot, "en", 419852, 1)
        second_round = MODULE.remediation_content(slot, "en", 419853, 2)
        self.assertEqual(first, repeated)
        self.assertNotEqual(first, second_round)
        self.assertNotEqual(first["userTurns"], second_round["userTurns"])

    def test_all_production_generator_branches_pass_diversity_deterministically(self):
        slots = MODULE.allocation_slots(419805)
        for branch in ("draft", "round-one-remediation", "mixed"):
            families = []
            for slot in slots:
                use_remediation = branch == "round-one-remediation" or (branch == "mixed" and slot["ordinal"] % 2 == 0)
                if use_remediation:
                    generated = {language: MODULE.remediation_content(slot, language, 419852, 1) for language in ("en", "sw")}
                else:
                    factory = MODULE.draft_agency_content if slot["track"] == MODULE.AGENCY_TRACK else MODULE.draft_nondisclosure_content
                    generated = {language: factory(slot, language) for language in ("en", "sw")}
                families.append({
                    **{key: slot[key] for key in ("ordinal", "familyId", "split", "track", "variant", "conversationForm")},
                    **generated,
                })
            source = {"authoringSeed": 419852, "createdAt": "2026-08-04T00:00:00Z", "families": families}
            first = MODULE.render_rows(source, self.plan, self.prompt, "a" * 40, MODULE.canonical_sha256(source))
            second = MODULE.render_rows(source, self.plan, self.prompt, "a" * 40, MODULE.canonical_sha256(source))
            self.assertEqual(first, second)
            MODULE.safety_and_quality_checks(first, self.prompt)
            report = MODULE.assistant_diversity_checks(first)
            self.assertLessEqual(report["sixWordOpeningMaximumCount"], 8)
            self.assertLessEqual(report["responseTemplateMaximumCount"], 4)
            self.assertLessEqual(report["semanticClusterMaximumCount"], 4)

    def test_diversity_distribution_enforces_opening_template_and_cluster_limits(self):
        rows = self.rendered_rows()
        for index, row in enumerate(rows):
            if row["metadata"]["track"] == MODULE.NONDISCLOSURE_TRACK:
                row["messages"][-1]["content"] = f"Visible scenario {index} keeps this boundary distinct. " + row["messages"][-1]["content"]
        report = MODULE.assistant_diversity_checks(rows)
        self.assertEqual("passed", report["status"])
        self.assertLessEqual(report["sixWordOpeningMaximumCount"], 8)
        self.assertLessEqual(report["responseTemplateMaximumCount"], 4)
        self.assertEqual(2, report["semanticClusterMaximumCount"])
        rows[0]["messages"][-1]["content"] = rows[1]["messages"][-1]["content"]
        rows[2]["messages"][-1]["content"] = rows[1]["messages"][-1]["content"]
        rows[3]["messages"][-1]["content"] = rows[1]["messages"][-1]["content"]
        rows[4]["messages"][-1]["content"] = rows[1]["messages"][-1]["content"]
        with self.assertRaisesRegex(RuntimeError, "response-template share"):
            MODULE.assistant_diversity_checks(rows)

    def test_remediated_bilingual_corpus_passes_structural_and_safety_gates(self):
        source = self.source_document()
        for family in source["families"]:
            slot = {key: family[key] for key in ("ordinal", "familyId", "split", "track", "variant", "conversationForm")}
            family["en"] = MODULE.remediation_content(slot, "en", 419852, 1)
            family["sw"] = MODULE.remediation_content(slot, "sw", 419852, 1)
        source["schemaVersion"] = 2
        source["authoringSeed"] = 419852
        source["remediation"] = {
            "round": 1,
            "seed": 419852,
            "priorAuthoringSourceSha256": "a" * 64,
            "priorCandidateManifestSha256": "b" * 64,
            "semanticSummarySha256": "c" * 64,
            "remediationFileSha256": "d" * 64,
            "affectedFamilyCount": 80,
            "affectedFamilyInventorySha256": "e" * 64,
            "generatorInput": "candidate-family-specification-only",
            "matchedProtectedContentProvided": False,
            "matchedProtectedIdentifiersProvided": False,
            "completeBilingualFamiliesRegenerated": True,
            "unaffectedFamiliesPreserved": True,
            "repeatedCollisionAction": "not-applicable-first-round",
        }
        MODULE.validate_authoring_source(source, self.plan, self.prompt)
        rows = MODULE.render_rows(source, self.plan, self.prompt, "f" * 40, MODULE.canonical_sha256(source))
        counts = MODULE.validate_row_shapes(rows, self.plan, self.prompt)
        quality = MODULE.safety_and_quality_checks(rows, self.prompt)
        diversity = MODULE.assistant_diversity_checks(rows)
        self.assertEqual({"en": 80, "sw": 80}, counts["languageCounts"])
        self.assertEqual("passed", quality["status"])
        self.assertEqual("passed", diversity["status"])
        self.assertTrue(all(row["metadata"]["generationSeed"] == 419852 for row in rows))
        self.assertTrue(all(row["authoring"]["toolRevision"] == "v2-remediation" for row in rows))

    def test_remediate_source_changes_only_selected_complete_bilingual_family(self):
        source = self.source_document()
        family = source["families"][0]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_path = root / "source.private.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            source_path.chmod(0o600)
            manifest_path = root / "manifest.private.json"
            manifest = {
                "schema": "com.saferide.ai.v051-mitigation-manifest",
                "datasetId": MODULE.DATASET_ID,
                "bindings": {"authoringSourceSha256": MODULE.sha256_file(source_path)},
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            manifest_path.chmod(0o600)
            manifest_sha = MODULE.sha256_file(manifest_path)
            finding = {
                "candidateId": "v051-candidate-" + "a" * 24,
                "candidateHash": "b" * 64,
                "family": family["familyId"],
                "language": "en",
                "split": family["split"],
                "track": family["track"],
                "collisionType": "prompt-cross-split-blocking",
                "similarityScore": 0.93,
            }
            remediation_path = root / "remediation.private.json"
            remediation_path.write_text(json.dumps([finding]), encoding="utf-8")
            remediation_path.chmod(0o600)
            summary_path = root / "summary.private.json"
            summary = {
                "schema": "com.saferide.ai.v051-prompt-semantic-summary",
                "schemaVersion": 2,
                "status": "blocked",
                "candidateManifestSha256": manifest_sha,
                "threshold": 0.92,
                "blockingResult": {"flaggedPairCount": 1, "unresolvedPairCount": 1},
                "remediation": {"fileSha256": MODULE.sha256_file(remediation_path), "affectedFamilyCount": 1},
            }
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            summary_path.chmod(0o600)
            output = root / "remediated.private.json"
            args = argparse.Namespace(
                source=str(source_path),
                candidate_manifest=str(manifest_path),
                semantic_summary=str(summary_path),
                remediation_file=str(remediation_path),
                round=1,
                seed=419852,
                created_at="2026-08-04T05:00:00Z",
                output=str(output),
            )
            self.assertEqual(0, MODULE.remediate_source(args))
            remediated = json.loads(output.read_text(encoding="utf-8"))
            changed = [
                item["familyId"]
                for before, item in zip(source["families"], remediated["families"])
                if MODULE.canonical_sha256(before) != MODULE.canonical_sha256(item)
            ]
            self.assertEqual([family["familyId"]], changed)
            self.assertEqual(1, remediated["remediation"]["affectedFamilyCount"])
            self.assertFalse(remediated["remediation"]["matchedProtectedContentProvided"])


if __name__ == "__main__":
    unittest.main()
