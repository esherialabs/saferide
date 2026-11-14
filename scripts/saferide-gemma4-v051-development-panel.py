#!/usr/bin/env python3
"""Prepare and execute the SafeRide v0.5.1 two-suite development panel.

The package contains only the unchanged 300-row development suite and the
20-row mitigation-development suite. The sealed mitigation holdout and all
v0.5 protected suites remain absent. Raw generations remain in restricted
model output; stdout and summaries are content-free.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import importlib.util
import json
import os
import re
import shutil
import sys
from pathlib import Path, PurePosixPath
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
BASE_SCRIPT_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v05-development-panel.py")
BASE_SPEC = importlib.util.spec_from_file_location("saferide_v05_development_panel", BASE_SCRIPT_PATH)
if BASE_SPEC is None or BASE_SPEC.loader is None:
    raise RuntimeError("The immutable v0.5 scoring implementation is unavailable.")
BASE = importlib.util.module_from_spec(BASE_SPEC)
BASE_SPEC.loader.exec_module(BASE)

REPO_ROOT = SCRIPT_PATH.parents[1]
DATASET_ID = "saferide-synthetic-guidance-v0.5.1"
BASE_MODEL_ID = BASE.BASE_MODEL_ID
BASE_REVISION = BASE.BASE_REVISION
REQUIRED_SEEDS = BASE.REQUIRED_SEEDS
EXPECTED_MODEL_FILES = BASE.EXPECTED_MODEL_FILES
GENERATION_CONFIG = BASE.GENERATION_CONFIG
SELECTION_POLICY = BASE.SELECTION_POLICY
SCORING_POLICY = BASE.SCORING_POLICY
SUITE_SPECS = (
    ("original-development", "dev", 300),
    ("mitigation-development", "mitigation-dev", 20),
)


def sha256_file(path: Path) -> str:
    return BASE.sha256_file(path)


def sha256_text(value: str) -> str:
    return BASE.sha256_text(value)


def canonical_sha256(value: Any) -> str:
    return BASE.canonical_sha256(value)


def read_json(path: Path) -> Any:
    return BASE.read_json(path)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return BASE.read_jsonl(path)


def ensure_private_directory(path: Path) -> None:
    BASE.ensure_private_directory(path)


def write_private_json(path: Path, value: Any) -> None:
    BASE.write_private_json(path, value)


def copy_private(source: Path, target: Path) -> None:
    BASE.copy_private(source, target)


def safe_relative(value: str) -> bool:
    return BASE.safe_relative(value)


def assert_outside_repository(path: Path) -> None:
    BASE.assert_outside_repository(path)


def validate_suite_rows(rows: list[dict[str, Any]], split: str, required_count: int) -> tuple[list[str], str]:
    if len(rows) != required_count:
        raise RuntimeError(f"Development suite requires exactly {required_count} rows; found {len(rows)}.")
    identifiers: list[str] = []
    for row in rows:
        identifier = row.get("id")
        messages = row.get("messages")
        metadata = row.get("metadata")
        if not isinstance(identifier, str) or not identifier or identifier in identifiers:
            raise RuntimeError("Development suite rows require unique non-empty identifiers.")
        if row.get("split") != split:
            raise RuntimeError("Development suite contains a row from a different split.")
        if not isinstance(messages, list) or len(messages) not in {3, 5}:
            raise RuntimeError("Development suite row has an unsupported message shape.")
        roles = [message.get("role") for message in messages if isinstance(message, dict)]
        if roles not in (["system", "user", "assistant"], ["system", "user", "assistant", "user", "assistant"]):
            raise RuntimeError("Development suite role sequence differs from the frozen contract.")
        if any(not isinstance(message.get("content"), str) or not message["content"] for message in messages):
            raise RuntimeError("Development suite contains an empty or malformed message.")
        if not isinstance(metadata, dict) or metadata.get("language") not in {"en", "sw"}:
            raise RuntimeError("Development suite language metadata differs from the frozen contract.")
        if not isinstance(metadata.get("responseStrategy"), str) or not metadata["responseStrategy"]:
            raise RuntimeError("Development suite response-strategy metadata is unavailable.")
        identifiers.append(identifier)
    ordered = sorted(identifiers)
    if split == "dev":
        # The unchanged v0.5 development inventory is bound by the training
        # runner's historical newline-delimited row-ID digest.
        inventory_sha = sha256_text("\n".join(ordered))
    elif split in {"mitigation-dev", "mitigation-holdout"}:
        # v0.5.1 frozen split manifests bind the canonical JSON row-ID array.
        # Keep this distinct from the historical training-run convention so
        # the panel verifies the immutable producer's actual hash contract.
        inventory_sha = canonical_sha256(ordered)
    else:
        raise RuntimeError("Development suite split has no row-inventory hash contract.")
    return ordered, inventory_sha


def resolve_original_development(
    recorded_path: Path,
    expected_sha256: str,
    input_manifest_path: Path,
    input_manifest: dict[str, Any],
    staged_package_root: Path | None = None,
) -> Path:
    if recorded_path.is_file():
        if sha256_file(recorded_path) != expected_sha256:
            raise RuntimeError("Original development split bytes are stale.")
        return recorded_path
    archive = input_manifest.get("trainingArchive", {})
    top_level = archive.get("topLevelDirectory")
    if (
        not isinstance(top_level, str)
        or not top_level
        or PurePosixPath(top_level).name != top_level
        or top_level != input_manifest.get("manifestId")
    ):
        raise RuntimeError("Original development package identity is unavailable.")
    staged_root = staged_package_root or input_manifest_path.parent / "staged-training-package" / top_level
    if staged_root.name != top_level:
        raise RuntimeError("Original development staged-package root identity differs.")
    package_manifest_path = staged_root / "metadata" / "sagemaker-package-manifest.json"
    expected_package_sha = archive.get("packageManifestSha256")
    if (
        not package_manifest_path.is_file()
        or not isinstance(expected_package_sha, str)
        or sha256_file(package_manifest_path) != expected_package_sha
    ):
        raise RuntimeError("Original development package manifest is unavailable or stale.")
    package_manifest = read_json(package_manifest_path)
    relative = "artifacts/dataset/controlled/dev.jsonl"
    declared = next((item for item in package_manifest.get("files", []) if item.get("path") == relative), None)
    if (
        package_manifest.get("packageId") != top_level
        or package_manifest.get("datasetId") != DATASET_ID
        or not declared
        or declared.get("sha256") != expected_sha256
    ):
        raise RuntimeError("Original development package lineage differs.")
    target = staged_root / relative
    if (
        not target.is_file()
        or target.stat().st_size != declared.get("sizeBytes")
        or sha256_file(target) != expected_sha256
    ):
        raise RuntimeError("Original development bytes are unavailable or stale.")
    return target


def verify_repeatability_evidence(evidence: dict[str, Any]) -> None:
    if (
        evidence.get("schema") != "com.saferide.ai.private-v051-candidate-repeatability"
        or evidence.get("status") != "passed-training-repeatability"
        or evidence.get("promotionEligible") is not False
    ):
        raise RuntimeError("v0.5.1 repeatability evidence is not passed and non-promotable.")


def frozen_file_record(manifest: dict[str, Any], name: str, classification: str, count: int) -> dict[str, Any]:
    record = next((item for item in manifest.get("files", []) if item.get("path") == name), None)
    if (
        not record
        or record.get("classification") != classification
        or record.get("recordCount") != count
        or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
        or not isinstance(record.get("sizeBytes"), int)
    ):
        raise RuntimeError("Frozen mitigation-development file binding differs.")
    return record


def prepare_package(args: argparse.Namespace) -> int:
    evidence_root = Path(args.evidence_root).expanduser().resolve()
    selection_path = Path(args.selection).expanduser().resolve()
    input_manifest_path = Path(args.input_manifest).expanduser().resolve()
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    frozen_manifest_path = Path(args.frozen_manifest).expanduser().resolve()
    staged_package_root = Path(args.staged_package_root).expanduser().resolve()
    output_root = Path(args.output_dir).expanduser().resolve()
    source_commit = args.source_commit
    assert_outside_repository(output_root)
    if not re.fullmatch(r"[a-f0-9]{40}", source_commit):
        raise RuntimeError("Panel source commit must be a lowercase immutable Git commit.")
    required_paths = (evidence_root, selection_path, input_manifest_path, frozen_root, frozen_manifest_path, staged_package_root)
    if not evidence_root.is_dir() or not frozen_root.is_dir() or any(not path.exists() for path in required_paths):
        raise RuntimeError("Controlled training or frozen dataset evidence is unavailable.")

    selection = read_json(selection_path)
    if (
        selection.get("schema") != "com.saferide.ai.v051-training-selection"
        or selection.get("datasetId") != DATASET_ID
        or selection.get("status") != "blocked"
        or selection.get("selected") is not None
        or selection.get("repeatability", {}).get("status") != "passed"
    ):
        raise RuntimeError("v0.5.1 pre-panel selection identity or state differs.")
    if selection.get("promotionEligible") is not False:
        raise RuntimeError("v0.5.1 pre-panel selection must remain non-promotable.")
    for key, expected in SELECTION_POLICY.items():
        if selection.get("selectionPolicy", {}).get(key) != expected:
            raise RuntimeError(f"Training selection policy differs at {key}.")

    input_manifest = read_json(input_manifest_path)
    if (
        input_manifest.get("schema") != "com.saferide.ai.v05-sagemaker-input-manifest"
        or input_manifest.get("datasetId") != DATASET_ID
        or input_manifest.get("baseModel", {}).get("modelId") != BASE_MODEL_ID
        or input_manifest.get("baseModel", {}).get("revision") != BASE_REVISION
    ):
        raise RuntimeError("SageMaker input manifest differs from the pinned v0.5.1 lineage.")
    model_files = input_manifest["baseModel"].get("files", [])
    if tuple(item.get("path") for item in model_files) != EXPECTED_MODEL_FILES:
        raise RuntimeError("Base-model inventory differs from the exact nine-file snapshot.")

    frozen_manifest = read_json(frozen_manifest_path)
    if (
        frozen_manifest.get("schema") != "com.saferide.ai.v051-mitigation-manifest"
        or frozen_manifest.get("datasetId") != DATASET_ID
        or frozen_manifest.get("status") != "frozen"
        or selection.get("bindings", {}).get("frozenManifestSha256") != sha256_file(frozen_manifest_path)
    ):
        raise RuntimeError("Frozen mitigation manifest identity or selection binding differs.")
    mitigation_record = frozen_file_record(
        frozen_manifest,
        "mitigation-development.private.jsonl",
        "controlled",
        20,
    )
    mitigation_path = frozen_root / mitigation_record["path"]
    if (
        not mitigation_path.is_file()
        or mitigation_path.stat().st_size != mitigation_record["sizeBytes"]
        or sha256_file(mitigation_path) != mitigation_record["sha256"]
    ):
        raise RuntimeError("Frozen mitigation-development bytes differ.")

    candidate_records: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    for seed in REQUIRED_SEEDS:
        run = next((item for item in selection.get("candidateRuns", []) if item.get("seed") == seed), None)
        if not run or run.get("status") != "completed" or not run.get("manifestPath"):
            raise RuntimeError(f"Candidate seed {seed} is not completed and hash-bound.")
        manifest_path = Path(run["manifestPath"]).expanduser().resolve()
        if not manifest_path.is_file() or sha256_file(manifest_path) != run.get("manifestSha256"):
            raise RuntimeError(f"Candidate seed {seed} manifest is unavailable or stale.")
        manifest = read_json(manifest_path)
        if (
            manifest.get("datasetProfile") != "v051"
            or manifest.get("runId") != run.get("runId")
            or manifest.get("runKind") != "candidate"
            or manifest.get("status") != "completed"
            or manifest.get("runArguments", {}).get("seed") != seed
            or manifest.get("baseModelId") != BASE_MODEL_ID
            or manifest.get("baseRevision") != BASE_REVISION
            or manifest.get("outputs", {}).get("holdoutRowsRead") != 0
            or manifest.get("promotionEligible") is not False
        ):
            raise RuntimeError(f"Candidate seed {seed} manifest fails the v0.5.1 panel lineage gate.")
        checkpoint = manifest.get("outputs", {}).get("bestCheckpoint")
        if (
            not checkpoint
            or Path(str(checkpoint)).name != Path(str(run.get("bestCheckpoint"))).name
            or manifest.get("outputs", {}).get("bestMetric") != run.get("developmentAssistantTokenLoss")
        ):
            raise RuntimeError(f"Candidate seed {seed} checkpoint/loss binding differs.")
        adapter_inventory = manifest.get("outputs", {}).get("adapterFiles", [])
        adapter_dir = BASE.find_adapter_directory(evidence_root, adapter_inventory)
        candidate_records.append({
            "seed": seed,
            "runId": run["runId"],
            "manifestPath": manifest_path,
            "manifestSha256": run["manifestSha256"],
            "bestCheckpoint": checkpoint,
            "developmentAssistantTokenLoss": run["developmentAssistantTokenLoss"],
            "adapterDir": adapter_dir,
            "adapterFiles": adapter_inventory,
            "adapterInventorySha256": canonical_sha256(adapter_inventory),
        })
        manifests.append(manifest)

    dev_paths = {Path(manifest["dataFiles"]["dev"]["path"]).expanduser().resolve() for manifest in manifests}
    dev_hashes = {manifest["dataFiles"]["dev"]["sha256"] for manifest in manifests}
    dev_inventory_hashes = {manifest["outputs"]["developmentRowIdSha256"] for manifest in manifests}
    if len(dev_paths) != 1 or len(dev_hashes) != 1 or len(dev_inventory_hashes) != 1:
        raise RuntimeError("Two candidate manifests do not bind one original development split.")
    original_path = resolve_original_development(
        next(iter(dev_paths)), next(iter(dev_hashes)), input_manifest_path, input_manifest, staged_package_root,
    )
    original_rows = read_jsonl(original_path)
    original_ids, original_inventory_sha = validate_suite_rows(original_rows, "dev", 300)
    if original_inventory_sha != next(iter(dev_inventory_hashes)):
        raise RuntimeError("Original development row inventory differs from candidate training evidence.")
    if set(original_ids) != set(manifests[0]["outputs"]["developmentRowIds"]):
        raise RuntimeError("Original development row identities differ from candidate training evidence.")

    mitigation_rows = read_jsonl(mitigation_path)
    _, mitigation_inventory_sha = validate_suite_rows(mitigation_rows, "mitigation-dev", 20)
    split_manifest_path = frozen_root / "split-manifest.private.json"
    expected_split_sha = frozen_manifest.get("bindings", {}).get("splitManifestSha256")
    if not split_manifest_path.is_file() or sha256_file(split_manifest_path) != expected_split_sha:
        raise RuntimeError("Frozen mitigation split-manifest binding differs.")
    split_manifest = read_json(split_manifest_path)
    mitigation_split = next((item for item in split_manifest.get("splits", []) if item.get("name") == "mitigation-dev"), None)
    if (
        not mitigation_split
        or mitigation_split.get("rowCount") != 20
        or mitigation_split.get("rowInventorySha256") != mitigation_inventory_sha
    ):
        raise RuntimeError("Mitigation-development row inventory differs from the frozen split manifest.")

    repeatability_path = Path(str(selection.get("repeatability", {}).get("evidenceRef"))).expanduser().resolve()
    if not repeatability_path.is_file():
        raise RuntimeError("Two-seed v0.5.1 repeatability evidence is unavailable.")
    verify_repeatability_evidence(read_json(repeatability_path))

    package_id = f"saferide-v051-development-panel-{source_commit[:12]}-{mitigation_record['sha256'][:12]}"
    package_root = output_root / package_id
    if package_root.exists():
        raise RuntimeError("v0.5.1 development-panel package already exists.")
    ensure_private_directory(package_root)
    execution_relative = f"code/{SCRIPT_PATH.name}"
    base_code_relative = f"code/{BASE_SCRIPT_PATH.name}"
    original_relative = "data/original-development.jsonl"
    mitigation_relative = "data/mitigation-development.jsonl"
    input_manifest_relative = "manifests/sagemaker-input-manifest.json"
    frozen_manifest_relative = "manifests/frozen-v051-manifest.json"
    repeatability_relative = "manifests/candidate-repeatability.json"
    for source, relative in (
        (SCRIPT_PATH, execution_relative),
        (BASE_SCRIPT_PATH, base_code_relative),
        (original_path, original_relative),
        (mitigation_path, mitigation_relative),
        (input_manifest_path, input_manifest_relative),
        (frozen_manifest_path, frozen_manifest_relative),
        (repeatability_path, repeatability_relative),
    ):
        copy_private(source, package_root / relative)

    packaged_candidates: list[dict[str, Any]] = []
    for record in candidate_records:
        seed = record["seed"]
        manifest_relative = f"manifests/candidate-{seed}.json"
        adapter_root = f"adapters/{seed}"
        copy_private(record["manifestPath"], package_root / manifest_relative)
        packaged_files = []
        for item in record["adapterFiles"]:
            name = Path(item["path"]).name
            relative = f"{adapter_root}/{name}"
            copy_private(record["adapterDir"] / name, package_root / relative)
            packaged_files.append({**item, "path": relative})
        packaged_candidates.append({
            "seed": seed,
            "runId": record["runId"],
            "manifest": {"path": manifest_relative, "sha256": record["manifestSha256"]},
            "bestCheckpoint": record["bestCheckpoint"],
            "developmentAssistantTokenLoss": record["developmentAssistantTokenLoss"],
            "adapterRoot": adapter_root,
            "adapterInventorySha256": record["adapterInventorySha256"],
            "adapterFiles": packaged_files,
        })

    package_files = []
    for target in sorted(path for path in package_root.rglob("*") if path.is_file()):
        relative = target.relative_to(package_root).as_posix()
        if not safe_relative(relative):
            raise RuntimeError("Prepared package contains an unsafe path.")
        package_files.append({"path": relative, "sha256": sha256_file(target), "sizeBytes": target.stat().st_size})
    panel_manifest = {
        "schema": "com.saferide.ai.v051-development-panel-input",
        "schemaVersion": 1,
        "panelId": package_id,
        "createdAt": args.created_at or dt.datetime.now(dt.timezone.utc).isoformat(),
        "issue": "ESH-4198",
        "sourceCommit": source_commit,
        "datasetId": DATASET_ID,
        "executionScript": execution_relative,
        "suites": [
            {
                "suiteId": "original-development", "split": "dev", "requiredCount": 300,
                "data": {"path": original_relative, "sha256": sha256_file(original_path), "sizeBytes": original_path.stat().st_size},
                "rowInventorySha256": original_inventory_sha, "selectionUse": "blocking-eligibility",
            },
            {
                "suiteId": "mitigation-development", "split": "mitigation-dev", "requiredCount": 20,
                "data": {"path": mitigation_relative, "sha256": mitigation_record["sha256"], "sizeBytes": mitigation_record["sizeBytes"]},
                "rowInventorySha256": mitigation_inventory_sha, "selectionUse": "blocking-eligibility",
            },
        ],
        "baseModel": {
            "modelId": BASE_MODEL_ID,
            "revision": BASE_REVISION,
            "inputManifest": {"path": input_manifest_relative, "sha256": sha256_file(input_manifest_path)},
            "files": [{"path": item["path"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]} for item in model_files],
        },
        "candidates": packaged_candidates,
        "repeatability": {"status": "passed", "evidence": {"path": repeatability_relative, "sha256": sha256_file(repeatability_path)}},
        "generationConfig": GENERATION_CONFIG,
        "selectionPolicy": SELECTION_POLICY,
        "scoringPolicy": {**SCORING_POLICY, "sha256": canonical_sha256(SCORING_POLICY)},
        "packageFiles": package_files,
        "privacy": {
            "classification": "controlled-development-only",
            "syntheticOnly": True,
            "containsMitigationHoldoutRows": False,
            "containsProtectedV05Rows": False,
            "containsBlindPrompts": False,
            "containsReviewerIdentity": False,
            "rawContentLogging": "forbidden",
            "promotionEligible": False,
        },
    }
    manifest_path = package_root / "panel-input-manifest.json"
    write_private_json(manifest_path, panel_manifest)
    write_private_json(output_root / f"{package_id}.receipt.json", {
        "schema": "com.saferide.ai.private-v051-development-panel-package",
        "schemaVersion": 1,
        "panelId": package_id,
        "packageRoot": str(package_root),
        "manifestPath": str(manifest_path),
        "manifestSha256": sha256_file(manifest_path),
        "fileCount": len(package_files) + 1,
        "developmentRows": 320,
        "candidateSeeds": list(REQUIRED_SEEDS),
        "containsMitigationHoldoutRows": False,
        "containsProtectedV05Rows": False,
        "promotionEligible": False,
    })
    print("SafeRide v0.5.1 development-panel package PASS (320 development rows; protected suites absent).")
    return 0


def verify_package(input_root: Path, manifest: dict[str, Any]) -> None:
    if (
        manifest.get("schema") != "com.saferide.ai.v051-development-panel-input"
        or manifest.get("datasetId") != DATASET_ID
        or manifest.get("issue") != "ESH-4198"
        or [(item.get("suiteId"), item.get("split"), item.get("requiredCount")) for item in manifest.get("suites", [])] != list(SUITE_SPECS)
    ):
        raise RuntimeError("v0.5.1 development-panel manifest identity differs.")
    privacy = manifest.get("privacy", {})
    if any(privacy.get(key) is not False for key in ("containsMitigationHoldoutRows", "containsProtectedV05Rows", "containsBlindPrompts", "containsReviewerIdentity")):
        raise RuntimeError("v0.5.1 development-panel package includes forbidden protected material.")
    if manifest.get("generationConfig") != GENERATION_CONFIG or manifest.get("selectionPolicy") != SELECTION_POLICY:
        raise RuntimeError("v0.5.1 development-panel generation or selection policy differs.")
    scoring = dict(manifest.get("scoringPolicy", {}))
    scoring_hash = scoring.pop("sha256", None)
    if scoring != SCORING_POLICY or scoring_hash != canonical_sha256(SCORING_POLICY):
        raise RuntimeError("v0.5.1 development-panel scoring policy differs.")
    if [item.get("seed") for item in manifest.get("candidates", [])] != list(REQUIRED_SEEDS):
        raise RuntimeError("v0.5.1 development-panel candidates differ from the fixed seeds.")
    if manifest.get("executionScript") != f"code/{SCRIPT_PATH.name}":
        raise RuntimeError("v0.5.1 development-panel execution script binding differs.")
    declared = {item["path"]: item for item in manifest.get("packageFiles", [])}
    actual = {
        path.relative_to(input_root).as_posix()
        for path in input_root.rglob("*")
        if path.is_file() and path.name != "panel-input-manifest.json"
    }
    if set(declared) != actual or len(declared) != len(manifest.get("packageFiles", [])):
        raise RuntimeError("v0.5.1 development-panel package inventory differs.")
    for relative, item in declared.items():
        target = input_root / relative
        if (
            not safe_relative(relative)
            or not target.is_file()
            or target.stat().st_size != item["sizeBytes"]
            or sha256_file(target) != item["sha256"]
        ):
            raise RuntimeError("v0.5.1 development-panel package bytes differ.")
    input_ref = manifest["baseModel"]["inputManifest"]
    if sha256_file(input_root / input_ref["path"]) != input_ref["sha256"]:
        raise RuntimeError("v0.5.1 base input-manifest binding differs.")
    repeatability_ref = manifest["repeatability"]["evidence"]
    if sha256_file(input_root / repeatability_ref["path"]) != repeatability_ref["sha256"]:
        raise RuntimeError("v0.5.1 repeatability evidence binding differs.")
    verify_repeatability_evidence(read_json(input_root / repeatability_ref["path"]))
    for suite in manifest["suites"]:
        target = input_root / suite["data"]["path"]
        if target.stat().st_size != suite["data"]["sizeBytes"] or sha256_file(target) != suite["data"]["sha256"]:
            raise RuntimeError("v0.5.1 development suite bytes differ.")
        _, inventory_sha = validate_suite_rows(read_jsonl(target), suite["split"], suite["requiredCount"])
        if inventory_sha != suite["rowInventorySha256"]:
            raise RuntimeError("v0.5.1 development suite row inventory differs.")
    for candidate in manifest["candidates"]:
        candidate_path = input_root / candidate["manifest"]["path"]
        if sha256_file(candidate_path) != candidate["manifest"]["sha256"]:
            raise RuntimeError("v0.5.1 candidate manifest binding differs.")
        candidate_manifest = read_json(candidate_path)
        if (
            candidate_manifest.get("datasetProfile") != "v051"
            or candidate_manifest.get("runId") != candidate["runId"]
            or candidate_manifest.get("runArguments", {}).get("seed") != candidate["seed"]
            or candidate_manifest.get("outputs", {}).get("bestCheckpoint") != candidate["bestCheckpoint"]
            or candidate_manifest.get("outputs", {}).get("holdoutRowsRead") != 0
            or candidate_manifest.get("promotionEligible") is not False
        ):
            raise RuntimeError("v0.5.1 candidate packaged lineage differs.")
        original_inventory = candidate_manifest.get("outputs", {}).get("adapterFiles", [])
        if canonical_sha256(original_inventory) != candidate["adapterInventorySha256"]:
            raise RuntimeError("v0.5.1 candidate adapter inventory binding differs.")
        originals = {Path(item["path"]).name: item for item in original_inventory}
        packaged = {Path(item["path"]).name: item for item in candidate["adapterFiles"]}
        if set(originals) != set(packaged) or len(originals) != len(original_inventory):
            raise RuntimeError("v0.5.1 candidate adapter package inventory differs.")
        for name, original in originals.items():
            item = packaged[name]
            target = input_root / item["path"]
            if (
                item.get("sha256") != original.get("sha256")
                or item.get("sizeBytes") != original.get("sizeBytes")
                or target.stat().st_size != item["sizeBytes"]
                or sha256_file(target) != item["sha256"]
            ):
                raise RuntimeError("v0.5.1 candidate adapter bytes differ.")


def suite_eligibility(candidate: dict[str, Any], base: dict[str, Any], required_count: int) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if candidate["rowCount"] != required_count or candidate["completed"] + candidate["truncated"] + candidate["errors"] != required_count:
        reasons.append("coverage-incomplete")
    if candidate["errors"] > 0:
        reasons.append("generation-errors")
    if candidate["criticalFailures"] != SELECTION_POLICY["criticalFailuresMaximum"]:
        reasons.append("critical-failure-threshold")
    if candidate["overRefusalRate"] > SELECTION_POLICY["maximumDevelopmentOverRefusalRate"]:
        reasons.append("absolute-over-refusal-threshold")
    if candidate["usefulnessAverage"] < SELECTION_POLICY["minimumDevelopmentUsefulnessAverage"]:
        reasons.append("absolute-usefulness-threshold")
    if candidate["overRefusalRate"] - base["overRefusalRate"] > SELECTION_POLICY["maximumOverRefusalRegression"] + 1e-12:
        reasons.append("base-over-refusal-regression")
    if base["usefulnessAverage"] - candidate["usefulnessAverage"] > SELECTION_POLICY["maximumUsefulnessRegression"] + 1e-12:
        reasons.append("base-usefulness-regression")
    return not reasons, reasons


def summary_document(
    *,
    manifest: dict[str, Any],
    manifest_sha: str,
    candidate: dict[str, Any],
    suite_results: dict[str, dict[str, dict[str, Any]]],
    image_digest: str,
    job_name: str,
    created_at: str,
) -> dict[str, Any]:
    results = []
    aggregate_reasons = []
    for suite in manifest["suites"]:
        result = suite_results[suite["suiteId"]]
        candidate_result = result[f"seed-{candidate['seed']}"]
        base_result = result["base"]
        passed, reasons = suite_eligibility(candidate_result, base_result, suite["requiredCount"])
        aggregate_reasons.extend(f"{suite['suiteId']}:{reason}" for reason in reasons)
        results.append({
            "suiteId": suite["suiteId"],
            "requiredCount": suite["requiredCount"],
            "dataSha256": suite["data"]["sha256"],
            "rowInventorySha256": suite["rowInventorySha256"],
            "coverage": {
                "candidate": {key: candidate_result[key] for key in ("rowCount", "completed", "truncated", "errors")},
                "base": {key: base_result[key] for key in ("rowCount", "completed", "truncated", "errors")},
            },
            "metrics": {
                "criticalFailures": candidate_result["criticalFailures"],
                "overRefusalRate": candidate_result["overRefusalRate"],
                "usefulnessAverage": candidate_result["usefulnessAverage"],
                "baseCriticalFailures": base_result["criticalFailures"],
                "baseOverRefusalRate": base_result["overRefusalRate"],
                "baseUsefulnessAverage": base_result["usefulnessAverage"],
            },
            "rawArtifacts": {
                "classification": "controlled-synthetic-raw",
                "candidateBundleSha256": candidate_result["bundleSha256"],
                "baseBundleSha256": base_result["bundleSha256"],
            },
            "eligibility": {"eligible": passed, "reasons": reasons},
        })
    passed = not aggregate_reasons
    return {
        "schema": "com.saferide.ai.v051-development-panel-summary",
        "schemaVersion": 1,
        "summaryId": f"{manifest['panelId']}-seed-{candidate['seed']}",
        "createdAt": created_at,
        "issue": "ESH-4198",
        "status": "passed" if passed else "blocked",
        "datasetId": DATASET_ID,
        "baseModel": {"modelId": BASE_MODEL_ID, "revision": BASE_REVISION},
        "candidate": {
            "seed": candidate["seed"],
            "runId": candidate["runId"],
            "manifestSha256": candidate["manifest"]["sha256"],
            "bestCheckpoint": candidate["bestCheckpoint"],
            "developmentAssistantTokenLoss": candidate["developmentAssistantTokenLoss"],
            "adapterInventorySha256": candidate["adapterInventorySha256"],
        },
        "provenance": {
            "panelInputSha256": manifest_sha,
            "sourceCommit": manifest["sourceCommit"],
            "imageDigest": image_digest,
            "jobNameSha256": sha256_text(job_name),
            "scoringPolicySha256": manifest["scoringPolicy"]["sha256"],
        },
        "generation": manifest["generationConfig"],
        "suiteResults": results,
        "eligibility": {"eligible": passed, "reasons": aggregate_reasons},
        "selectionPolicy": manifest["selectionPolicy"],
        "privacy": {
            "summaryContainsRawPrompts": False,
            "summaryContainsRawCompletions": False,
            "mitigationHoldoutRead": False,
            "protectedV05RowsRead": False,
            "blindPromptsRead": False,
            "humanReviewClaimed": False,
            "classification": "controlled-content-free",
        },
        "promotionEligible": False,
        "remainingPromotionGates": ["protected-evaluation", "consolidated-human-review", "export", "physical-device-proof"],
    }


def execute_panel(args: argparse.Namespace) -> int:
    os.umask(0o077)
    input_root = Path(args.input_root).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    ensure_private_directory(output_root)
    manifest_path = input_root / "panel-input-manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError("v0.5.1 development-panel input manifest is unavailable.")
    manifest = read_json(manifest_path)
    verify_package(input_root, manifest)
    expected_sha = os.environ.get("SAFERIDE_PANEL_INPUT_SHA256", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or sha256_file(manifest_path) != expected_sha:
        raise RuntimeError("v0.5.1 panel input-manifest hash binding differs.")
    BASE.verify_model_snapshot(model_root, manifest)
    rows_by_suite: dict[str, list[dict[str, Any]]] = {}
    for suite in manifest["suites"]:
        rows = sorted(read_jsonl(input_root / suite["data"]["path"]), key=lambda row: str(row.get("id", "")))
        _, inventory_sha = validate_suite_rows(rows, suite["split"], suite["requiredCount"])
        if inventory_sha != suite["rowInventorySha256"]:
            raise RuntimeError("v0.5.1 panel row inventory differs.")
        rows_by_suite[suite["suiteId"]] = rows

    dependencies = BASE.import_ml_dependencies()
    torch = dependencies["torch"]
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("v0.5.1 development panel requires a CUDA GPU with BF16 support.")
    tokenizer = dependencies["AutoTokenizer"].from_pretrained(str(model_root), local_files_only=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    base_model = dependencies["AutoModel"].from_pretrained(
        str(model_root), local_files_only=True, low_cpu_mem_usage=True, dtype=torch.bfloat16, device_map={"": 0},
    )
    base_model.eval()
    first, second = manifest["candidates"]
    model = dependencies["PeftModel"].from_pretrained(
        base_model, str(input_root / first["adapterRoot"]), adapter_name=f"seed-{first['seed']}", is_trainable=False,
    )
    model.load_adapter(str(input_root / second["adapterRoot"]), adapter_name=f"seed-{second['seed']}", is_trainable=False)
    model.eval()
    raw_root = output_root / "restricted"
    summary_root = output_root / "content-free"
    ensure_private_directory(raw_root)
    ensure_private_directory(summary_root)
    suite_results: dict[str, dict[str, dict[str, Any]]] = {}
    for suite in manifest["suites"]:
        suite_id = suite["suiteId"]
        suite_results[suite_id] = {}
        disable_context = model.disable_adapter() if callable(getattr(model, "disable_adapter", None)) else contextlib.nullcontext()
        with disable_context:
            suite_results[suite_id]["base"] = BASE.run_artifact_panel(
                slot=f"{suite_id}:base", model=model, tokenizer=tokenizer, torch=torch,
                rows=rows_by_suite[suite_id], output_path=raw_root / f"{suite_id}-base-generations.jsonl",
            )
        for candidate in manifest["candidates"]:
            slot = f"seed-{candidate['seed']}"
            model.set_adapter(slot)
            suite_results[suite_id][slot] = BASE.run_artifact_panel(
                slot=f"{suite_id}:{slot}", model=model, tokenizer=tokenizer, torch=torch,
                rows=rows_by_suite[suite_id], output_path=raw_root / f"{suite_id}-{slot}-generations.jsonl",
            )

    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    image_digest = os.environ.get("SAFERIDE_PANEL_IMAGE_DIGEST", "")
    job_name = os.environ.get("TRAINING_JOB_NAME", "unavailable")
    if not re.fullmatch(r"[a-f0-9]{64}", image_digest):
        raise RuntimeError("v0.5.1 development panel lacks an immutable image digest binding.")
    summary_records = []
    for candidate in manifest["candidates"]:
        summary = summary_document(
            manifest=manifest,
            manifest_sha=sha256_file(manifest_path),
            candidate=candidate,
            suite_results=suite_results,
            image_digest=image_digest,
            job_name=job_name,
            created_at=created_at,
        )
        target = summary_root / f"development-panel-seed-{candidate['seed']}.json"
        write_private_json(target, summary)
        summary_records.append({"seed": candidate["seed"], "status": summary["status"], "summarySha256": sha256_file(target)})
    base_hashes = {
        suite_id: results["base"]["bundleSha256"]
        for suite_id, results in suite_results.items()
    }
    write_private_json(summary_root / "development-panel-execution.json", {
        "schema": "com.saferide.ai.private-v051-development-panel-execution",
        "schemaVersion": 1,
        "createdAt": created_at,
        "panelInputSha256": sha256_file(manifest_path),
        "imageDigest": image_digest,
        "jobNameSha256": sha256_text(job_name),
        "baseBundleSha256BySuite": base_hashes,
        "summaries": summary_records,
        "developmentRows": 320,
        "mitigationHoldoutRead": False,
        "protectedV05RowsRead": False,
        "blindPromptsRead": False,
        "promotionEligible": False,
    })
    eligible_count = sum(item["status"] == "passed" for item in summary_records)
    print(f"SafeRide v0.5.1 development panel complete ({eligible_count}/2 candidates eligible; sealed/protected suites absent).")
    return 0


def contract_check() -> int:
    if canonical_sha256(SCORING_POLICY) != BASE.canonical_sha256(BASE.SCORING_POLICY):
        raise RuntimeError("v0.5.1 panel changed the immutable v0.5 scoring policy.")
    passing = {
        "rowCount": 20, "completed": 20, "truncated": 0, "errors": 0,
        "criticalFailures": 0, "overRefusalRate": 0.05, "usefulnessAverage": 2.8,
    }
    passed, reasons = suite_eligibility(passing, {**passing, "overRefusalRate": 0.04, "usefulnessAverage": 2.8}, 20)
    if not passed or reasons:
        raise RuntimeError("v0.5.1 suite eligibility contract failed.")
    print("SafeRide v0.5.1 two-suite development-panel contracts PASS (no model loaded).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SafeRide v0.5.1 two-suite development generation panel.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--evidence-root", required=True)
    prepare.add_argument("--selection", required=True)
    prepare.add_argument("--input-manifest", required=True)
    prepare.add_argument("--frozen-root", required=True)
    prepare.add_argument("--frozen-manifest", required=True)
    prepare.add_argument("--staged-package-root", required=True)
    prepare.add_argument("--source-commit", required=True)
    prepare.add_argument("--output-dir", required=True)
    prepare.add_argument("--created-at")
    execute = subparsers.add_parser("run")
    execute.add_argument("--input-root", required=True)
    execute.add_argument("--model-root", required=True)
    execute.add_argument("--output-root", required=True)
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if args.command == "contract-check":
        return contract_check()
    if args.command == "prepare":
        return prepare_package(args)
    return execute_panel(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - bounded and content-free by contract.
        message = re.sub(r"\s+", " ", str(error))[:500]
        print(f"SafeRide v0.5.1 development panel blocked: {message}", file=sys.stderr)
        raise SystemExit(1)
