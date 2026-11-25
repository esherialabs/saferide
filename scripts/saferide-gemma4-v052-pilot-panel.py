#!/usr/bin/env python3
"""Prepare, execute, and verify the SafeRide v0.5.2 candidate-only pilot panel.

The evaluator generates only the v0.5.2 pilot outputs. It compares them with
the version-pinned base outputs rescored by the current policy, avoiding a
redundant base-model generation pass. Raw development rows and completions
remain in controlled storage; stdout and summaries are content-free.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import math
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[1]
BASE_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v05-development-panel.py")
V051_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v051-development-panel.py")
DIAGNOSIS_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v052-diagnose.py")
DATASET_ID = "saferide-synthetic-guidance-v0.5.2"
BASE_MODEL_ID = "google/gemma-4-E2B-it"
BASE_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
EXPECTED_SEED = 419805
EXPECTED_ADAPTER_FILES = (
    "README.md",
    "adapter_config.json",
    "adapter_model.safetensors",
    "chat_template.jinja",
    "tokenizer.json",
    "tokenizer_config.json",
)
SUITES = (("original-development", "dev", 300), ("mitigation-development", "mitigation-dev", 20))
EXECUTION_POLICY = {
    "generationBatchSize": 2,
    "batchOrder": "suite-order-then-canonical-row-id",
    "paddingSide": "left",
    "decoding": "deterministic-greedy-no-sampling",
}


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required v0.5.2 pilot module cannot be loaded: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_historical_v051_module(historical_root: Path) -> Any:
    """Load the v0.5.1 scorer bundled with the immutable panel package."""
    historical_path = historical_root / "code" / V051_PATH.name
    require(historical_path.is_file(), "Historical v0.5.1 panel implementation is unavailable.")
    return load_module(historical_path, "saferide_v052_historical_v051_panel")


BASE = load_module(BASE_PATH, "saferide_v052_pilot_base")
V051 = load_module(V051_PATH, "saferide_v052_pilot_v051")
DIAGNOSIS = load_module(DIAGNOSIS_PATH, "saferide_v052_pilot_diagnosis")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_file(path: Path) -> str:
    return BASE.sha256_file(path)


def canonical_sha256(value: Any) -> str:
    return BASE.canonical_sha256(value)


def read_json(path: Path) -> Any:
    require(path.is_file(), f"Required controlled file is unavailable: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return BASE.read_jsonl(path)


def ensure_new_private_directory(path: Path) -> None:
    resolved = path.resolve()
    require(REPO_ROOT.resolve() not in resolved.parents and resolved != REPO_ROOT.resolve(), "Pilot-panel output must remain outside Git.")
    require(not resolved.exists(), "Pilot-panel output already exists; immutable evidence cannot be overwritten.")
    resolved.mkdir(parents=True, mode=0o700)
    resolved.chmod(0o700)


def copy_private(source: Path, target: Path) -> None:
    require(source.is_file(), f"Controlled source is unavailable: {source.name}")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with source.open("rb") as input_handle, target.open("xb") as output_handle:
        shutil.copyfileobj(input_handle, output_handle, 8 * 1024 * 1024)
    target.chmod(0o600)


def find_adapter_files(adapter_root: Path, inventory: list[dict[str, Any]]) -> dict[str, Path]:
    require(adapter_root.is_dir(), "Recovered pilot adapter root is unavailable.")
    by_name = {Path(str(item.get("path"))).name: item for item in inventory}
    require(tuple(sorted(by_name)) == tuple(sorted(EXPECTED_ADAPTER_FILES)) and len(by_name) == len(inventory), "Pilot adapter inventory differs from the exact six-file contract.")
    actual_files = [path for path in adapter_root.rglob("*") if path.is_file()]
    actual_by_name: dict[str, Path] = {}
    for path in actual_files:
        require(path.name not in actual_by_name, "Recovered pilot adapter contains duplicate basenames.")
        actual_by_name[path.name] = path
    require(set(actual_by_name) == set(EXPECTED_ADAPTER_FILES), "Recovered pilot adapter contains missing or additional files.")
    for name, item in by_name.items():
        path = actual_by_name[name]
        require(path.stat().st_size == item.get("sizeBytes") and sha256_file(path) == item.get("sha256"), f"Recovered pilot adapter bytes differ: {name}")
    return actual_by_name


def verify_pilot_manifest(manifest: dict[str, Any], frozen: dict[str, Any]) -> None:
    outputs = manifest.get("outputs", {})
    arguments = manifest.get("runArguments", {})
    require(
        manifest.get("schema") == "com.saferide.ai.training-run"
        and manifest.get("status") == "completed"
        and manifest.get("datasetProfile") == "v052"
        and manifest.get("runKind") == "pilot"
        and manifest.get("promotionEligible") is False,
        "v0.5.2 pilot manifest identity or state differs.",
    )
    require(
        arguments.get("seed") == EXPECTED_SEED
        and arguments.get("learningRate") == 2e-5
        and arguments.get("epochs") == 1.0
        and arguments.get("maxSteps") is None
        and arguments.get("loraRank") == 8,
        "v0.5.2 pilot training recipe differs.",
    )
    require(manifest.get("baseModelId") == BASE_MODEL_ID and manifest.get("baseRevision") == BASE_REVISION, "v0.5.2 pilot base-model binding differs.")
    require(manifest.get("dataFiles", {}).get("train", {}).get("sha256") == frozen.get("bindings", {}).get("combinedTrainSha256"), "v0.5.2 pilot training-data hash differs.")
    require(manifest.get("dataFiles", {}).get("dev", {}).get("sha256") == frozen.get("bindings", {}).get("originalDevelopmentSha256"), "v0.5.2 pilot development-data hash differs.")
    require(outputs.get("holdoutRowsRead") == 0 and outputs.get("rowsSeen") == 1864 and outputs.get("epochsCompleted", 0) >= 0.999, "v0.5.2 pilot coverage or protected-data boundary differs.")
    require(isinstance(outputs.get("bestMetric"), (int, float)) and math.isfinite(float(outputs["bestMetric"])), "v0.5.2 pilot loss is unavailable or non-finite.")
    best_checkpoint = outputs.get("bestCheckpoint")
    checkpoints = outputs.get("checkpoints", [])
    require(isinstance(best_checkpoint, str) and any(Path(str(item.get("path"))).name == Path(best_checkpoint).name and item.get("fileCount", 0) > 0 for item in checkpoints), "v0.5.2 best checkpoint lacks hash-bound checkpoint evidence.")
    tensor_gate = outputs.get("adapterTensorValidation", {})
    require(tensor_gate.get("nonFiniteTensorCount") == 0 and tensor_gate.get("tensorCount", 0) > 0 and tensor_gate.get("elementCount", 0) > 0, "v0.5.2 pilot adapter tensor gate is not passed.")
    sample_order = outputs.get("sampleOrder")
    require(isinstance(sample_order, list) and len(sample_order) == 1864 and len(set(sample_order)) == 1768, "v0.5.2 pilot weighted sample order differs.")


def archived_base_comparator(diagnosis: dict[str, Any]) -> dict[str, Any]:
    policy_sha = canonical_sha256(BASE.SCORING_POLICY)
    require(
        diagnosis.get("schema") == "com.saferide.ai.v052-failure-diagnosis-summary"
        and diagnosis.get("status") == "diagnosis-complete"
        and diagnosis.get("promotionEligible") is False,
        "Failure-diagnosis summary identity differs.",
    )
    rescore = diagnosis.get("archivedProspectiveRescore", {})
    require(rescore.get("outputsRegenerated") is False and rescore.get("policySha256") == policy_sha, "Archived base comparator was not rescored with the current policy.")
    inputs = diagnosis.get("inputs", {})
    require(inputs.get("prospectiveScoringImplementationSha256") == sha256_file(BASE_PATH), "Archived base comparator scoring implementation is stale.")
    require(inputs.get("diagnosticImplementationSha256") == sha256_file(DIAGNOSIS_PATH), "Archived base comparator diagnostic implementation is stale.")
    comparator: dict[str, Any] = {
        "diagnosisSha256": None,
        "scoringPolicySha256": policy_sha,
        "outputsRegenerated": False,
        "suites": [],
    }
    raw_hashes = inputs.get("rawBundleSha256", {})
    for suite_id, _split, count in SUITES:
        value = rescore.get("suites", {}).get(suite_id, {}).get("base", {})
        require(value.get("rows") == count and value.get("errors") == 0, "Archived base comparator coverage differs.")
        bundle_sha = raw_hashes.get(f"{suite_id}/base")
        require(isinstance(bundle_sha, str) and re.fullmatch(r"[a-f0-9]{64}", bundle_sha), "Archived base bundle hash is unavailable.")
        comparator["suites"].append({
            "suiteId": suite_id,
            "bundleSha256": bundle_sha,
            "metrics": {
                "rowCount": value["rows"],
                "completed": value["completed"],
                "truncated": value["truncated"],
                "errors": value["errors"],
                "criticalFailures": value["criticalFailures"],
                "overRefusalRate": value["overRefusalRate"],
                "usefulnessAverage": value["usefulnessAverage"],
            },
        })
    return comparator


def prepare(args: argparse.Namespace) -> int:
    output_root = Path(args.output_dir).expanduser().resolve()
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    historical_root = Path(args.historical_panel_package).expanduser().resolve()
    input_manifest_path = Path(args.input_manifest).expanduser().resolve()
    diagnosis_path = Path(args.diagnosis_summary).expanduser().resolve()
    pilot_manifest_path = Path(args.pilot_manifest).expanduser().resolve()
    adapter_root = Path(args.adapter_root).expanduser().resolve()
    require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit) is not None, "Pilot-panel source commit must be immutable.")

    historical_v051 = load_historical_v051_module(historical_root)

    frozen_path = frozen_root / "frozen-manifest.private.json"
    frozen = read_json(frozen_path)
    require(
        frozen.get("schema") == "com.saferide.ai.v052-mitigation-manifest"
        and frozen.get("datasetId") == DATASET_ID
        and frozen.get("status") == "frozen"
        and frozen.get("sourceCommit") == args.source_commit
        and frozen.get("fullCandidatesAllowed") is False,
        "Frozen v0.5.2 manifest differs.",
    )
    require(all(frozen.get("privacy", {}).get(key) is False for key in ("sealedMitigationHoldoutRead", "protectedV05SourceTextRead", "blindSuiteTextRead")), "Frozen v0.5.2 lineage indicates forbidden protected-data access.")
    input_manifest = read_json(input_manifest_path)
    require(
        input_manifest.get("schema") == "com.saferide.ai.v05-sagemaker-input-manifest"
        and input_manifest.get("datasetId") == DATASET_ID
        and input_manifest.get("sourceCommit") == args.source_commit
        and input_manifest.get("baseModel", {}).get("modelId") == BASE_MODEL_ID
        and input_manifest.get("baseModel", {}).get("revision") == BASE_REVISION,
        "Staged v0.5.2 input manifest differs.",
    )
    model_files = input_manifest.get("baseModel", {}).get("files", [])
    require(tuple(item.get("path") for item in model_files) == BASE.EXPECTED_MODEL_FILES, "Pinned base-model inventory differs.")

    historical_manifest = read_json(historical_root / "panel-input-manifest.json")
    historical_v051.verify_package(historical_root, historical_manifest)
    require(all(historical_manifest.get("privacy", {}).get(key) is False for key in ("containsMitigationHoldoutRows", "containsProtectedV05Rows", "containsBlindPrompts")), "Historical panel package contains forbidden suites.")
    diagnosis = read_json(diagnosis_path)
    comparator = archived_base_comparator(diagnosis)
    comparator["diagnosisSha256"] = sha256_file(diagnosis_path)

    pilot_manifest = read_json(pilot_manifest_path)
    verify_pilot_manifest(pilot_manifest, frozen)
    adapter_sources = find_adapter_files(adapter_root, pilot_manifest.get("outputs", {}).get("adapterFiles", []))
    suites = []
    for suite_id, split, count in SUITES:
        historical_suite = next((item for item in historical_manifest["suites"] if item["suiteId"] == suite_id), None)
        require(historical_suite is not None and historical_suite["split"] == split and historical_suite["requiredCount"] == count, "Historical development suite contract differs.")
        source = historical_root / historical_suite["data"]["path"]
        rows = read_jsonl(source)
        _, inventory_sha = historical_v051.validate_suite_rows(rows, split, count)
        require(sha256_file(source) == historical_suite["data"]["sha256"] and inventory_sha == historical_suite["rowInventorySha256"], "Historical development suite bytes differ.")
        expected_hash = frozen.get("bindings", {}).get("originalDevelopmentSha256" if suite_id == "original-development" else "mitigationDevelopmentSha256")
        require(sha256_file(source) == expected_hash, "v0.5.2 frozen suite binding differs.")
        suites.append((historical_suite, source))

    ensure_new_private_directory(output_root)
    package_id = f"saferide-v052-pilot-panel-{args.source_commit[:12]}-{sha256_file(pilot_manifest_path)[:12]}"
    package_root = output_root / package_id
    package_root.mkdir(mode=0o700)
    copies = (
        (SCRIPT_PATH, f"code/{SCRIPT_PATH.name}"),
        (BASE_PATH, f"code/{BASE_PATH.name}"),
        (V051_PATH, f"code/{V051_PATH.name}"),
        (DIAGNOSIS_PATH, f"code/{DIAGNOSIS_PATH.name}"),
        (input_manifest_path, "manifests/sagemaker-input-manifest.json"),
        (frozen_path, "manifests/frozen-v052-manifest.json"),
        (diagnosis_path, "manifests/failure-diagnosis.content-free.json"),
        (pilot_manifest_path, "manifests/pilot-run.json"),
    )
    for source, relative in copies:
        copy_private(source, package_root / relative)
    packaged_suites = []
    for historical_suite, source in suites:
        relative = f"data/{historical_suite['suiteId']}.jsonl"
        copy_private(source, package_root / relative)
        packaged_suites.append({**historical_suite, "data": {"path": relative, "sha256": sha256_file(source), "sizeBytes": source.stat().st_size}})
    adapter_files = []
    for name in EXPECTED_ADAPTER_FILES:
        relative = f"adapter/{name}"
        copy_private(adapter_sources[name], package_root / relative)
        item = next(item for item in pilot_manifest["outputs"]["adapterFiles"] if Path(item["path"]).name == name)
        adapter_files.append({"path": relative, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})

    package_files = [
        {"path": path.relative_to(package_root).as_posix(), "sha256": sha256_file(path), "sizeBytes": path.stat().st_size}
        for path in sorted(package_root.rglob("*")) if path.is_file()
    ]
    candidate = {
        "seed": EXPECTED_SEED,
        "runId": pilot_manifest["runId"],
        "runKind": "pilot",
        "manifest": {"path": "manifests/pilot-run.json", "sha256": sha256_file(pilot_manifest_path)},
        "bestCheckpoint": pilot_manifest["outputs"]["bestCheckpoint"],
        "developmentAssistantTokenLoss": pilot_manifest["outputs"]["bestMetric"],
        "adapterRoot": "adapter",
        "adapterInventorySha256": canonical_sha256(pilot_manifest["outputs"]["adapterFiles"]),
        "adapterFiles": adapter_files,
        "finiteTensorGate": pilot_manifest["outputs"]["adapterTensorValidation"],
    }
    panel_manifest = {
        "schema": "com.saferide.ai.v052-pilot-panel-input",
        "schemaVersion": 1,
        "panelId": package_id,
        "createdAt": args.created_at or dt.datetime.now(dt.timezone.utc).isoformat(),
        "issue": "ESH-4198",
        "sourceCommit": args.source_commit,
        "datasetId": DATASET_ID,
        "executionScript": f"code/{SCRIPT_PATH.name}",
        "suites": packaged_suites,
        "baseModel": {
            "modelId": BASE_MODEL_ID,
            "revision": BASE_REVISION,
            "inputManifest": {"path": "manifests/sagemaker-input-manifest.json", "sha256": sha256_file(input_manifest_path)},
            "files": [{"path": item["path"], "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]} for item in model_files],
        },
        "candidate": candidate,
        "archivedBaseComparator": comparator,
        "generationConfig": BASE.GENERATION_CONFIG,
        "executionPolicy": EXECUTION_POLICY,
        "selectionPolicy": BASE.SELECTION_POLICY,
        "scoringPolicy": {**BASE.SCORING_POLICY, "sha256": canonical_sha256(BASE.SCORING_POLICY)},
        "packageFiles": package_files,
        "privacy": {
            "classification": "controlled-development-only",
            "syntheticOnly": True,
            "containsMitigationHoldoutRows": False,
            "containsProtectedV05Rows": False,
            "containsBlindPrompts": False,
            "containsReviewerIdentity": False,
            "baseOutputsRegenerated": False,
            "rawContentLogging": "forbidden",
            "promotionEligible": False,
        },
    }
    manifest_path = package_root / "panel-input-manifest.json"
    BASE.write_private_json(manifest_path, panel_manifest)
    receipt_path = output_root / f"{package_id}.receipt.json"
    BASE.write_private_json(receipt_path, {
        "schema": "com.saferide.ai.private-v052-pilot-panel-package",
        "schemaVersion": 1,
        "panelId": package_id,
        "packageRoot": str(package_root),
        "manifestPath": str(manifest_path),
        "manifestSha256": sha256_file(manifest_path),
        "fileCount": len(package_files) + 1,
        "developmentRows": 320,
        "generatedResponses": 320,
        "baseResponsesReused": 320,
        "holdoutsRead": False,
        "promotionEligible": False,
    })
    print("SafeRide v0.5.2 pilot-panel package PASS (320 candidate generations; archived base reused; holdouts absent).")
    print(f"Panel input SHA-256: {sha256_file(manifest_path)}")
    return 0


def verify_package(input_root: Path, manifest: dict[str, Any]) -> None:
    require(
        manifest.get("schema") == "com.saferide.ai.v052-pilot-panel-input"
        and manifest.get("datasetId") == DATASET_ID
        and manifest.get("issue") == "ESH-4198"
        and [(item.get("suiteId"), item.get("split"), item.get("requiredCount")) for item in manifest.get("suites", [])] == list(SUITES),
        "v0.5.2 pilot-panel identity differs.",
    )
    privacy = manifest.get("privacy", {})
    require(all(privacy.get(key) is False for key in ("containsMitigationHoldoutRows", "containsProtectedV05Rows", "containsBlindPrompts", "containsReviewerIdentity", "baseOutputsRegenerated", "promotionEligible")), "v0.5.2 pilot-panel privacy boundary differs.")
    require(manifest.get("generationConfig") == BASE.GENERATION_CONFIG and manifest.get("executionPolicy") == EXECUTION_POLICY and manifest.get("selectionPolicy") == BASE.SELECTION_POLICY, "v0.5.2 pilot-panel generation, execution, or eligibility policy differs.")
    scoring = dict(manifest.get("scoringPolicy", {}))
    scoring_hash = scoring.pop("sha256", None)
    require(scoring == BASE.SCORING_POLICY and scoring_hash == canonical_sha256(BASE.SCORING_POLICY), "v0.5.2 pilot-panel scoring policy differs.")
    declared = {item["path"]: item for item in manifest.get("packageFiles", [])}
    actual = {path.relative_to(input_root).as_posix() for path in input_root.rglob("*") if path.is_file() and path.name != "panel-input-manifest.json"}
    require(set(declared) == actual and len(declared) == len(manifest.get("packageFiles", [])), "v0.5.2 pilot-panel file inventory differs.")
    for relative, item in declared.items():
        target = input_root / relative
        require(BASE.safe_relative(relative) and target.is_file() and target.stat().st_size == item["sizeBytes"] and sha256_file(target) == item["sha256"], "v0.5.2 pilot-panel file bytes differ.")
    for suite in manifest["suites"]:
        target = input_root / suite["data"]["path"]
        _, inventory_sha = V051.validate_suite_rows(read_jsonl(target), suite["split"], suite["requiredCount"])
        require(sha256_file(target) == suite["data"]["sha256"] and inventory_sha == suite["rowInventorySha256"], "v0.5.2 pilot-panel suite binding differs.")
    candidate = manifest.get("candidate", {})
    pilot_path = input_root / candidate.get("manifest", {}).get("path", "missing")
    require(candidate.get("seed") == EXPECTED_SEED and candidate.get("runKind") == "pilot" and sha256_file(pilot_path) == candidate.get("manifest", {}).get("sha256"), "v0.5.2 pilot candidate binding differs.")
    pilot = read_json(pilot_path)
    frozen = read_json(input_root / "manifests/frozen-v052-manifest.json")
    verify_pilot_manifest(pilot, frozen)
    original_inventory = pilot["outputs"]["adapterFiles"]
    require(canonical_sha256(original_inventory) == candidate.get("adapterInventorySha256"), "v0.5.2 pilot adapter inventory hash differs.")
    original_by_name = {Path(item["path"]).name: item for item in original_inventory}
    packaged_by_name = {Path(item["path"]).name: item for item in candidate.get("adapterFiles", [])}
    require(set(original_by_name) == set(packaged_by_name) == set(EXPECTED_ADAPTER_FILES), "v0.5.2 packaged adapter inventory differs.")
    for name, original in original_by_name.items():
        packaged = packaged_by_name[name]
        target = input_root / packaged["path"]
        require(original["sha256"] == packaged["sha256"] == sha256_file(target) and original["sizeBytes"] == packaged["sizeBytes"] == target.stat().st_size, f"v0.5.2 packaged adapter bytes differ: {name}")
    diagnosis_path = input_root / "manifests/failure-diagnosis.content-free.json"
    comparator = archived_base_comparator(read_json(diagnosis_path))
    comparator["diagnosisSha256"] = sha256_file(diagnosis_path)
    require(comparator == manifest.get("archivedBaseComparator"), "v0.5.2 archived base comparator binding differs.")


def candidate_metrics(raw_rows: list[dict[str, Any]]) -> dict[str, Any]:
    count = len(raw_rows)
    states = {state: sum(row["generation"]["state"] == state for row in raw_rows) for state in ("complete", "truncated", "error")}
    return {
        "rowCount": count,
        "completed": states["complete"],
        "truncated": states["truncated"],
        "errors": states["error"],
        "criticalFailures": sum(bool(row["score"]["criticalSignals"]) for row in raw_rows),
        "overRefusalRate": round(sum(bool(row["score"]["overRefusal"]) for row in raw_rows) / count, 6),
        "usefulnessAverage": round(sum(int(row["score"]["usefulness"]) for row in raw_rows) / count, 6),
    }


def quality_summary(rows: list[dict[str, Any]], raw_rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {row["id"]: row for row in rows}
    records = []
    for raw in raw_rows:
        row = by_id[raw["rowId"]]
        metadata = row["metadata"]
        records.append({
            "language": metadata["language"],
            "track": metadata["track"],
            "variant": metadata["variant"],
            "features": DIAGNOSIS.response_features(row, raw),
        })
    return {"overall": DIAGNOSIS.aggregate_feature_rows([item["features"] for item in records]), "byDimension": DIAGNOSIS.grouped_aggregates(records, "features")}


def fixed_batches(rows: list[Any], batch_size: int = EXECUTION_POLICY["generationBatchSize"]) -> list[list[Any]]:
    require(batch_size == EXECUTION_POLICY["generationBatchSize"], "v0.5.2 generation batch size differs from the frozen execution policy.")
    return [rows[index:index + batch_size] for index in range(0, len(rows), batch_size)]


def finalize_generated_tokens(token_ids: list[int], tokenizer: Any, max_new_tokens: int) -> tuple[str, dict[str, Any]]:
    eos_value = tokenizer.eos_token_id
    eos_ids = set(eos_value if isinstance(eos_value, (list, tuple)) else [eos_value])
    eos_index = next((index for index, token_id in enumerate(token_ids) if token_id in eos_ids), None)
    effective = token_ids if eos_index is None else token_ids[:eos_index + 1]
    output_length = len(effective)
    ended_with_eos = eos_index is not None
    hit_cap = output_length >= max_new_tokens and not ended_with_eos
    state = "truncated" if hit_cap else "complete" if output_length else "error"
    completion = tokenizer.decode(effective, skip_special_tokens=True).strip()
    return completion, {
        "state": state,
        "outputTokens": output_length,
        "stopReason": "token-cap" if hit_cap else "eos" if ended_with_eos else "empty" if not output_length else "other",
    }


def batch_generate_completions(model: Any, tokenizer: Any, torch: Any, contexts: list[list[dict[str, str]]]) -> list[tuple[str, dict[str, Any]]]:
    require(1 <= len(contexts) <= EXECUTION_POLICY["generationBatchSize"], "v0.5.2 generation batch is empty or oversized.")
    try:
        encoded_value = tokenizer.apply_chat_template(
            contexts,
            tokenize=True,
            add_generation_prompt=True,
            padding=True,
            return_tensors="pt",
            return_dict=True,
        )
    except Exception as error:
        raise RuntimeError("Canonical batched development chat-template application failed.") from error
    encoded = dict(encoded_value.items()) if hasattr(encoded_value, "items") else {"input_ids": encoded_value}
    require(encoded.get("input_ids") is not None and encoded.get("attention_mask") is not None, "Batched development encoding lacks input IDs or attention mask.")
    input_width = int(encoded["input_ids"].shape[-1])
    input_lengths = [int(value) for value in encoded["attention_mask"].sum(dim=-1).tolist()]
    require(len(input_lengths) == len(contexts), "Batched development input inventory differs.")
    available = [BASE.GENERATION_CONFIG["maxSequenceLength"] - length for length in input_lengths]
    max_new_tokens = BASE.GENERATION_CONFIG["maxNewTokens"]
    require(all(value >= max_new_tokens for value in available), "Batched development input cannot retain the frozen generation token cap.")
    device = BASE.model_device(model, torch)
    encoded = {key: value.to(device) if hasattr(value, "to") else value for key, value in encoded.items()}
    with torch.inference_mode():
        output = model.generate(
            **encoded,
            do_sample=False,
            max_new_tokens=max_new_tokens,
            repetition_penalty=BASE.GENERATION_CONFIG["repetitionPenalty"],
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
            use_cache=True,
        )
    results = []
    for index, input_length in enumerate(input_lengths):
        completion, generation = finalize_generated_tokens(
            [int(token_id) for token_id in output[index][input_width:].tolist()], tokenizer, max_new_tokens,
        )
        results.append((completion, {**generation, "inputTokens": input_length}))
    return results


def run_batched_artifact_panel(*, slot: str, model: Any, tokenizer: Any, torch: Any, rows: list[dict[str, Any]], output_path: Path) -> dict[str, Any]:
    raw_rows: list[dict[str, Any]] = []
    critical_count = over_refusal_count = usefulness_total = completed = truncated = errors = 0
    processed = 0
    for batch in fixed_batches(rows):
        generations = batch_generate_completions(model, tokenizer, torch, [row["messages"][:-1] for row in batch])
        require(len(generations) == len(batch), "Batched development output inventory differs.")
        for row, (completion, generation) in zip(batch, generations):
            messages = row["messages"]
            reference = messages[-1]["content"]
            score = BASE.score_completion(
                completion=completion,
                reference=reference,
                system_prompt=messages[0]["content"],
                language=row["metadata"]["language"],
                response_strategy=row["metadata"]["responseStrategy"],
                state=generation["state"],
            )
            critical_count += int(bool(score["criticalSignals"]))
            over_refusal_count += int(score["overRefusal"])
            usefulness_total += int(score["usefulness"])
            completed += int(generation["state"] == "complete")
            truncated += int(generation["state"] == "truncated")
            errors += int(generation["state"] == "error")
            raw_rows.append({
                "rowId": row["id"],
                "rowContentSha256": BASE.sha256_text(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))),
                "referenceSha256": BASE.sha256_text(reference),
                "completion": completion,
                "completionSha256": BASE.sha256_text(completion),
                "generation": generation,
                "score": score,
            })
        processed += len(batch)
        if processed % 20 == 0 or processed == len(rows):
            print(f"v0.5.2 pilot panel progress: {slot} {processed}/{len(rows)}", flush=True)
    BASE.write_private_jsonl(output_path, raw_rows)
    count = len(rows)
    return {
        "bundlePath": output_path,
        "bundleSha256": sha256_file(output_path),
        "rowCount": count,
        "completed": completed,
        "truncated": truncated,
        "errors": errors,
        "criticalFailures": critical_count,
        "overRefusalRate": round(over_refusal_count / count, 6),
        "usefulnessAverage": round(usefulness_total / count, 6),
    }


def summary_document(manifest: dict[str, Any], manifest_sha: str, results: dict[str, dict[str, Any]], image_digest: str, job_name: str, created_at: str) -> dict[str, Any]:
    candidate = manifest["candidate"]
    comparator_by_suite = {item["suiteId"]: item for item in manifest["archivedBaseComparator"]["suites"]}
    suite_results = []
    reasons_all = []
    for suite in manifest["suites"]:
        candidate_result = results[suite["suiteId"]]
        base_item = comparator_by_suite[suite["suiteId"]]
        base_result = base_item["metrics"]
        passed, reasons = V051.suite_eligibility(candidate_result, base_result, suite["requiredCount"])
        reasons_all.extend(f"{suite['suiteId']}:{reason}" for reason in reasons)
        suite_results.append({
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
                "baseBundleSha256": base_item["bundleSha256"],
                "baseOutputsRegenerated": False,
            },
            "eligibility": {"eligible": passed, "reasons": reasons},
        })
    passed = not reasons_all
    return {
        "schema": "com.saferide.ai.v052-pilot-panel-summary",
        "schemaVersion": 1,
        "summaryId": f"{manifest['panelId']}-seed-{candidate['seed']}",
        "createdAt": created_at,
        "issue": "ESH-4198",
        "status": "passed" if passed else "blocked",
        "datasetId": DATASET_ID,
        "baseModel": {"modelId": BASE_MODEL_ID, "revision": BASE_REVISION},
        "candidate": {
            "seed": candidate["seed"], "runId": candidate["runId"], "runKind": "pilot",
            "manifestSha256": candidate["manifest"]["sha256"], "bestCheckpoint": candidate["bestCheckpoint"],
            "developmentAssistantTokenLoss": candidate["developmentAssistantTokenLoss"],
            "adapterInventorySha256": candidate["adapterInventorySha256"], "finiteTensorGate": candidate["finiteTensorGate"],
        },
        "provenance": {
            "panelInputSha256": manifest_sha, "sourceCommit": manifest["sourceCommit"], "imageDigest": image_digest,
            "jobNameSha256": BASE.sha256_text(job_name), "scoringPolicySha256": manifest["scoringPolicy"]["sha256"],
            "baseComparatorDiagnosisSha256": manifest["archivedBaseComparator"]["diagnosisSha256"],
        },
        "generation": manifest["generationConfig"],
        "executionPolicy": manifest["executionPolicy"],
        "suiteResults": suite_results,
        "eligibility": {"eligible": passed, "reasons": reasons_all},
        "selectionPolicy": manifest["selectionPolicy"],
        "privacy": {
            "summaryContainsRawPrompts": False, "summaryContainsRawCompletions": False,
            "mitigationHoldoutRead": False, "protectedV05RowsRead": False, "blindPromptsRead": False,
            "baseOutputsRegenerated": False, "humanReviewClaimed": False, "classification": "controlled-content-free",
        },
        "promotionEligible": False,
        "fullCandidateSubmissionAuthorized": False,
    }


def execute(args: argparse.Namespace) -> int:
    os.umask(0o077)
    input_root = Path(args.input_root).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    output_root.chmod(0o700)
    manifest_path = input_root / "panel-input-manifest.json"
    manifest = read_json(manifest_path)
    verify_package(input_root, manifest)
    expected_sha = os.environ.get("SAFERIDE_PANEL_INPUT_SHA256", "")
    require(re.fullmatch(r"[a-f0-9]{64}", expected_sha) is not None and sha256_file(manifest_path) == expected_sha, "v0.5.2 panel input hash binding differs.")
    BASE.verify_model_snapshot(model_root, manifest)
    rows_by_suite = {
        suite["suiteId"]: sorted(read_jsonl(input_root / suite["data"]["path"]), key=lambda row: str(row["id"]))
        for suite in manifest["suites"]
    }
    dependencies = BASE.import_ml_dependencies()
    torch = dependencies["torch"]
    require(torch.cuda.is_available() and torch.cuda.is_bf16_supported(), "v0.5.2 pilot panel requires CUDA BF16.")
    tokenizer = dependencies["AutoTokenizer"].from_pretrained(str(model_root), local_files_only=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    model = dependencies["AutoModel"].from_pretrained(
        str(model_root), local_files_only=True, low_cpu_mem_usage=True, dtype=torch.bfloat16, device_map={"": 0},
    )
    model = dependencies["PeftModel"].from_pretrained(model, str(input_root / manifest["candidate"]["adapterRoot"]), is_trainable=False)
    model.eval()
    raw_root = output_root / "restricted"
    summary_root = output_root / "content-free"
    raw_root.mkdir(mode=0o700)
    summary_root.mkdir(mode=0o700)
    results: dict[str, dict[str, Any]] = {}
    raw_by_suite: dict[str, list[dict[str, Any]]] = {}
    for suite_id, _split, _count in SUITES:
        output_path = raw_root / f"{suite_id}-pilot-generations.jsonl"
        result = run_batched_artifact_panel(slot=f"{suite_id}:pilot", model=model, tokenizer=tokenizer, torch=torch, rows=rows_by_suite[suite_id], output_path=output_path)
        results[suite_id] = {**result, "bundleSha256": result["bundleSha256"]}
        raw_by_suite[suite_id] = read_jsonl(output_path)
    mitigation_quality = quality_summary(rows_by_suite["mitigation-development"], raw_by_suite["mitigation-development"])
    quality_path = summary_root / "mitigation-quality.content-free.json"
    BASE.write_private_json(quality_path, {
        "schema": "com.saferide.ai.v052-pilot-mitigation-quality",
        "schemaVersion": 1,
        "status": "complete",
        "responses": 20,
        "aggregate": mitigation_quality,
        "privacy": {"containsRawPrompts": False, "containsRawCompletions": False, "containsRowIdentifiers": False, "holdoutsRead": False},
    })
    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    image_digest = os.environ.get("SAFERIDE_PANEL_IMAGE_DIGEST", "")
    require(re.fullmatch(r"[a-f0-9]{64}", image_digest) is not None, "v0.5.2 pilot panel image digest binding is unavailable.")
    job_name = os.environ.get("TRAINING_JOB_NAME", "unavailable")
    summary = summary_document(manifest, sha256_file(manifest_path), results, image_digest, job_name, created_at)
    summary_path = summary_root / "pilot-panel-summary.json"
    BASE.write_private_json(summary_path, summary)
    BASE.write_private_json(summary_root / "pilot-panel-execution.json", {
        "schema": "com.saferide.ai.private-v052-pilot-panel-execution",
        "schemaVersion": 1,
        "createdAt": created_at,
        "panelInputSha256": sha256_file(manifest_path),
        "imageDigest": image_digest,
        "jobNameSha256": BASE.sha256_text(job_name),
        "executionPolicy": EXECUTION_POLICY,
        "summarySha256": sha256_file(summary_path),
        "mitigationQualitySha256": sha256_file(quality_path),
        "candidateBundleSha256BySuite": {key: value["bundleSha256"] for key, value in results.items()},
        "baseOutputsRegenerated": False,
        "generatedResponses": 320,
        "holdoutsRead": False,
        "promotionEligible": False,
        "fullCandidateSubmissionAuthorized": False,
    })
    print(f"SafeRide v0.5.2 pilot panel complete (eligible={str(summary['eligibility']['eligible']).lower()}; 320 candidate responses; archived base reused).")
    return 0


def verify_output(args: argparse.Namespace) -> int:
    input_root = Path(args.input_root).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    manifest_path = input_root / "panel-input-manifest.json"
    manifest = read_json(manifest_path)
    verify_package(input_root, manifest)
    summary_path = output_root / "content-free/pilot-panel-summary.json"
    execution_path = output_root / "content-free/pilot-panel-execution.json"
    quality_path = output_root / "content-free/mitigation-quality.content-free.json"
    summary = read_json(summary_path)
    execution = read_json(execution_path)
    quality = read_json(quality_path)
    require(summary.get("schema") == "com.saferide.ai.v052-pilot-panel-summary" and summary.get("promotionEligible") is False and summary.get("fullCandidateSubmissionAuthorized") is False, "v0.5.2 pilot summary identity differs.")
    require(summary.get("provenance", {}).get("panelInputSha256") == sha256_file(manifest_path) and summary.get("provenance", {}).get("scoringPolicySha256") == canonical_sha256(BASE.SCORING_POLICY), "v0.5.2 pilot summary lineage differs.")
    require(summary.get("executionPolicy") == EXECUTION_POLICY and execution.get("executionPolicy") == EXECUTION_POLICY, "v0.5.2 pilot execution policy differs.")
    require(execution.get("summarySha256") == sha256_file(summary_path) and execution.get("mitigationQualitySha256") == sha256_file(quality_path), "v0.5.2 pilot output hash bindings differ.")
    require(execution.get("generatedResponses") == 320 and execution.get("baseOutputsRegenerated") is False and execution.get("holdoutsRead") is False, "v0.5.2 pilot execution boundary differs.")
    summary_by_suite = {item["suiteId"]: item for item in summary.get("suiteResults", [])}
    for suite in manifest["suites"]:
        raw_path = output_root / f"restricted/{suite['suiteId']}-pilot-generations.jsonl"
        require((raw_path.stat().st_mode & 0o077) == 0, "v0.5.2 pilot raw output is not mode 0600.")
        raw = read_jsonl(raw_path)
        rows = read_jsonl(input_root / suite["data"]["path"])
        by_id = {row["id"]: row for row in rows}
        require(len(raw) == suite["requiredCount"] and {item["rowId"] for item in raw} == set(by_id), "v0.5.2 pilot raw output inventory differs.")
        for item in raw:
            row = by_id[item["rowId"]]
            replay = BASE.score_completion(
                completion=item["completion"], reference=row["messages"][-1]["content"],
                system_prompt=row["messages"][0]["content"], language=row["metadata"]["language"],
                response_strategy=row["metadata"]["responseStrategy"], state=item["generation"]["state"],
            )
            require(replay == item["score"], "v0.5.2 pilot scorer replay differs.")
        metrics = candidate_metrics(raw)
        result = summary_by_suite.get(suite["suiteId"], {})
        require(result.get("metrics", {}).get("criticalFailures") == metrics["criticalFailures"] and result.get("metrics", {}).get("overRefusalRate") == metrics["overRefusalRate"] and result.get("metrics", {}).get("usefulnessAverage") == metrics["usefulnessAverage"], "v0.5.2 pilot summary metrics differ from raw output.")
        require(result.get("rawArtifacts", {}).get("candidateBundleSha256") == sha256_file(raw_path) and result.get("rawArtifacts", {}).get("baseOutputsRegenerated") is False, "v0.5.2 pilot raw bundle binding differs.")
    require(quality.get("schema") == "com.saferide.ai.v052-pilot-mitigation-quality" and quality.get("responses") == 20 and quality.get("privacy", {}).get("holdoutsRead") is False, "v0.5.2 pilot mitigation-quality summary differs.")
    print(f"SafeRide v0.5.2 pilot output PASS (status={summary['status']}; holdouts absent; base outputs reused).")
    return 0


def contract_check() -> int:
    require(BASE.SCORING_POLICY.get("policyId") == "saferide-v05-development-panel-deterministic-rubric.2", "v0.5.2 pilot requires scoring policy v2.")
    passing = {"rowCount": 20, "completed": 20, "truncated": 0, "errors": 0, "criticalFailures": 0, "overRefusalRate": 0.05, "usefulnessAverage": 2.7}
    passed, reasons = V051.suite_eligibility(passing, {**passing, "usefulnessAverage": 1.4}, 20)
    require(passed and not reasons, "v0.5.2 pilot eligibility contract differs.")
    print("SafeRide v0.5.2 candidate-only pilot-panel contracts PASS.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--frozen-root", required=True)
    prepare_parser.add_argument("--historical-panel-package", required=True)
    prepare_parser.add_argument("--input-manifest", required=True)
    prepare_parser.add_argument("--diagnosis-summary", required=True)
    prepare_parser.add_argument("--pilot-manifest", required=True)
    prepare_parser.add_argument("--adapter-root", required=True)
    prepare_parser.add_argument("--source-commit", required=True)
    prepare_parser.add_argument("--output-dir", required=True)
    prepare_parser.add_argument("--created-at")
    execute_parser = subparsers.add_parser("run")
    execute_parser.add_argument("--input-root", required=True)
    execute_parser.add_argument("--model-root", required=True)
    execute_parser.add_argument("--output-root", required=True)
    verify_parser = subparsers.add_parser("verify-output")
    verify_parser.add_argument("--input-root", required=True)
    verify_parser.add_argument("--output-root", required=True)
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if args.command == "contract-check":
        return contract_check()
    if args.command == "prepare":
        return prepare(args)
    if args.command == "run":
        return execute(args)
    return verify_output(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - content-free failures only.
        print(f"SafeRide v0.5.2 pilot panel blocked: {re.sub(r'\s+', ' ', str(error))[:500]}", file=sys.stderr)
        raise SystemExit(1)
