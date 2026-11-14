#!/usr/bin/env python3
"""Strict content-free training-input gate for SafeRide v0.5.2 pilots."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


DATASET_ID = "saferide-synthetic-guidance-v0.5.2"
BASE_DATASET_ID = "saferide-synthetic-guidance-v0.5.0"
V051_DATASET_ID = "saferide-synthetic-guidance-v0.5.1"
BASE_MODEL_ID = "google/gemma-4-E2B-it"
BASE_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    require(path.is_file(), f"Required v0.5.2 JSON is unavailable: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    require(path.is_file(), f"Required v0.5.2 JSONL is unavailable: {path.name}")
    values = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                require(isinstance(value, dict), "v0.5.2 JSONL contains a non-object row.")
                values.append(value)
    return values


def file_record(manifest: dict[str, Any], name: str, count: int) -> dict[str, Any]:
    record = next((item for item in manifest.get("files", []) if item.get("path") == name), None)
    require(record is not None and record.get("recordCount") == count, f"v0.5.2 manifest record differs: {name}")
    return record


def verify(args: argparse.Namespace) -> int:
    register_path = Path(args.register).resolve()
    train_path = Path(args.train_data).resolve()
    dev_path = Path(args.dev_data).resolve()
    manifest_path = Path(args.dataset_manifest).resolve()
    artifact_root = Path(args.artifact_root).resolve()
    sampling_path = Path(args.pilot_row_manifest).resolve()
    register = read_json(register_path)
    manifest = read_json(manifest_path)
    audit = read_json(Path(args.audit).resolve())
    recipe = read_json(sampling_path)
    require(register.get("schema") == "com.saferide.ai.v052-mitigation-register", "v0.5.2 register schema differs.")
    require(register.get("datasetId") == DATASET_ID and register.get("status") == "experimental-training-ready-promotion-blocked", "v0.5.2 register state differs.")
    require(register.get("baseModel") == {"modelId": BASE_MODEL_ID, "revision": BASE_REVISION}, "v0.5.2 base-model binding differs.")
    require(register.get("trainingAllowed") is True and register.get("fullCandidatesAllowed") is False and register.get("promotionAllowed") is False, "v0.5.2 authorization boundary differs.")
    require(manifest.get("schema") == "com.saferide.ai.v052-mitigation-manifest" and manifest.get("datasetId") == DATASET_ID and manifest.get("status") == "frozen", "v0.5.2 frozen manifest differs.")
    require(manifest.get("sourceCommit") == register.get("sourceCommit"), "v0.5.2 source-commit lineage differs.")
    require(manifest.get("bindings", {}).get("registerSha256") == sha256_file(register_path), "v0.5.2 register hash binding differs.")
    train_record = file_record(manifest, "combined-train.private.jsonl", 1768)
    recipe_record = file_record(manifest, "training-recipe.private.json", 1864)
    require(sha256_file(train_path) == train_record.get("sha256") == manifest.get("bindings", {}).get("combinedTrainSha256"), "v0.5.2 combined training bytes differ.")
    require(sha256_file(sampling_path) == recipe_record.get("sha256") == manifest.get("bindings", {}).get("trainingRecipeSha256"), "v0.5.2 sampling recipe bytes differ.")
    require(audit.get("schema") == "com.saferide.ai.v052-dataset-audit" and audit.get("status") == "passed", "v0.5.2 dataset audit is not passed.")
    require(sha256_file(Path(args.audit).resolve()) == manifest.get("bindings", {}).get("datasetAuditSha256"), "v0.5.2 dataset audit binding differs.")
    train = read_jsonl(train_path)
    dev = read_jsonl(dev_path)
    require(len(train) == 1768 and len({str(row.get("id")) for row in train}) == 1768, "v0.5.2 unique training inventory differs.")
    require(len(dev) == 300 and sha256_file(dev_path) == register.get("bindings", {}).get("originalDevelopmentSha256"), "v0.5.2 development comparator differs.")
    require(all(row.get("split") == "train" for row in train) and all(row.get("split") == "dev" for row in dev), "v0.5.2 training/development split isolation differs.")
    require(sum(row.get("datasetId") == BASE_DATASET_ID for row in train) == 1600, "v0.5.2 base training lineage count differs.")
    require(sum(row.get("datasetId") == V051_DATASET_ID for row in train) == 120, "v0.5.2 v0.5.1 training lineage count differs.")
    require(sum(row.get("datasetId") == DATASET_ID for row in train) == 48, "v0.5.2 new mitigation lineage count differs.")
    sample_order = recipe.get("sampleOrder")
    require(recipe.get("schema") == "com.saferide.ai.v052-training-recipe" and recipe.get("status") == "frozen-for-cost-controlled-pilot", "v0.5.2 training recipe differs.")
    require(recipe.get("learningRate") == 2e-5 and recipe.get("epochs") == 1 and recipe.get("fullCandidateSubmissionAuthorized") is False, "v0.5.2 pilot recipe boundary differs.")
    require(isinstance(sample_order, list) and len(sample_order) == 1864 and len(set(sample_order)) == 1768, "v0.5.2 weighted sample order differs.")
    require(set(sample_order) == {str(row.get("id")) for row in train}, "v0.5.2 weighted sample order references unavailable rows.")
    require(recipe.get("sampleOrderSha256") == hashlib.sha256("\n".join(sample_order).encode("utf-8")).hexdigest(), "v0.5.2 weighted sample-order hash differs.")
    counts = __import__("collections").Counter(sample_order)
    new_ids = {str(row.get("id")) for row in train if row.get("datasetId") == DATASET_ID}
    require(all(counts[row_id] == 3 for row_id in new_ids) and all(count == 1 for row_id, count in counts.items() if row_id not in new_ids), "v0.5.2 weighting multipliers differ from the three-times-new-data policy.")
    semantic_path = artifact_root / "semantic/semantic-report.json"
    tokenization_path = artifact_root / "tokenization/tokenization-report.json"
    semantic = read_json(semantic_path)
    tokenization = read_json(tokenization_path)
    require(sha256_file(semantic_path) == manifest.get("bindings", {}).get("semanticReportSha256"), "v0.5.2 semantic report binding differs.")
    require(semantic.get("status") == "passed" and semantic.get("threshold") == 0.92 and semantic.get("blockingResult") == {"flaggedPairCount": 0, "unresolvedPairCount": 0}, "v0.5.2 prompt-only semantic gate differs.")
    require(semantic.get("scope", {}).get("sealedMitigationHoldoutRead") is False and semantic.get("scope", {}).get("blindSuiteTextRead") is False, "v0.5.2 semantic gate opened forbidden inputs.")
    require(sha256_file(tokenization_path) == manifest.get("bindings", {}).get("tokenizationReportSha256"), "v0.5.2 tokenization report binding differs.")
    require(tokenization.get("status") == "passed" and tokenization.get("truncatedRowCount") == 0 and tokenization.get("assistantOnlyLabels") is True, "v0.5.2 tokenizer/assistant-label gate differs.")
    require(manifest.get("privacy", {}).get("sealedMitigationHoldoutRead") is False and manifest.get("privacy", {}).get("containsDevelopmentRows") is False, "v0.5.2 frozen package privacy boundary differs.")
    print("SafeRide v0.5.2 training-input gate passed.")
    print("Unique train: 1768; weighted pilot examples: 1864; development: 300; protected rows: absent; promotion: false.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--register", required=True)
    verify_parser.add_argument("--train-data", required=True)
    verify_parser.add_argument("--dev-data", required=True)
    verify_parser.add_argument("--dataset-manifest", required=True)
    verify_parser.add_argument("--artifact-root", required=True)
    verify_parser.add_argument("--pilot-row-manifest", required=True)
    verify_parser.add_argument("--audit", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "contract-check":
        require(re.fullmatch(r"[a-f0-9]{40}", BASE_REVISION) is not None, "v0.5.2 base revision differs.")
        print("SafeRide v0.5.2 training-input contract passed.")
        return 0
    return verify(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - content-free failure only.
        print(str(error).replace("\r", " ").replace("\n", " ")[:600], file=sys.stderr)
        raise SystemExit(1)
