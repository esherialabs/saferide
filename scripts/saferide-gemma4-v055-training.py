#!/usr/bin/env python3
"""Strict content-free training-input gate for the SafeRide v0.5.5 pilot."""

from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REMEDIATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v055-remediation.py")
DATASET_ID = "saferide-synthetic-guidance-v0.5.5"
BASE_MODEL = {"modelId": "google/gemma-4-E2B-it", "revision": "70af34e20bd4b7a91f0de6b22675850c43922a03"}
EXPECTED_LINEAGE = {
    "saferide-synthetic-guidance-v0.5.0": 1600,
    "saferide-synthetic-guidance-v0.5.1": 120,
    "saferide-synthetic-guidance-v0.5.2": 48,
    "saferide-synthetic-guidance-v0.5.3": 64,
    "saferide-synthetic-guidance-v0.5.4": 32,
    DATASET_ID: 32,
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_remediation() -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("saferide_v055_training_remediation", REMEDIATION_PATH)
    require(spec is not None and spec.loader is not None, "v0.5.5 remediation implementation is unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    require(path.is_file(), f"Required v0.5.5 JSON is unavailable: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    require(path.is_file(), f"Required v0.5.5 JSONL is unavailable: {path.name}")
    result = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                require(isinstance(value, dict), "v0.5.5 JSONL contains a non-object row.")
                result.append(value)
    return result


def file_record(manifest: dict[str, Any], name: str, count: int) -> dict[str, Any]:
    record = next((item for item in manifest.get("files", []) if item.get("path") == name), None)
    require(record is not None and record.get("recordCount") == count, f"v0.5.5 manifest record differs: {name}")
    return record


def verify(args: argparse.Namespace) -> int:
    register_path = Path(args.register).resolve()
    train_path = Path(args.train_data).resolve()
    dev_path = Path(args.dev_data).resolve()
    manifest_path = Path(args.dataset_manifest).resolve()
    artifact_root = Path(args.artifact_root).resolve()
    recipe_path = Path(args.pilot_row_manifest).resolve()
    audit_path = Path(args.audit).resolve()
    register = read_json(register_path)
    manifest = read_json(manifest_path)
    recipe = read_json(recipe_path)
    audit = read_json(audit_path)
    remediation = load_remediation()
    require(register.get("schema") == "com.saferide.ai.v055-mitigation-register", "v0.5.5 register schema differs.")
    require(register.get("datasetId") == DATASET_ID and register.get("status") == "experimental-final-targeted-pilot-ready-promotion-blocked", "v0.5.5 register state differs.")
    require(register.get("baseModel") == BASE_MODEL, "v0.5.5 base-model binding differs.")
    require(register.get("trainingAllowed") is True and register.get("targetedPilotOnly") is True, "v0.5.5 pilot authorization differs.")
    require(register.get("fullCandidatesAllowed") is False and register.get("promotionAllowed") is False, "v0.5.5 promotion boundary differs.")
    require(register.get("bindings", {}).get("scoringPolicySha256") == remediation.canonical_sha256(remediation.SCORING_POLICY), "v0.5.5 scorer binding differs.")
    require(register.get("bindings", {}).get("lossPolicySha256") == remediation.canonical_sha256(remediation.LOSS_POLICY), "v0.5.5 loss-policy binding differs.")
    require(manifest.get("schema") == "com.saferide.ai.v055-mitigation-manifest" and manifest.get("status") == "frozen", "v0.5.5 frozen manifest differs.")
    require(manifest.get("sourceCommit") == register.get("sourceCommit"), "v0.5.5 source-commit lineage differs.")
    require(manifest.get("bindings", {}).get("registerSha256") == sha256_file(register_path), "v0.5.5 register hash binding differs.")
    train_record = file_record(manifest, "combined-train.private.jsonl", 1896)
    recipe_record = file_record(manifest, "training-recipe.private.json", 1992)
    require(sha256_file(train_path) == train_record.get("sha256") == manifest.get("bindings", {}).get("combinedTrainSha256"), "v0.5.5 combined training bytes differ.")
    require(sha256_file(recipe_path) == recipe_record.get("sha256") == manifest.get("bindings", {}).get("trainingRecipeSha256"), "v0.5.5 recipe bytes differ.")
    require(audit.get("schema") == "com.saferide.ai.v055-dataset-audit" and audit.get("status") == "passed", "v0.5.5 audit is not passed.")
    require(sha256_file(audit_path) == manifest.get("bindings", {}).get("datasetAuditSha256"), "v0.5.5 audit binding differs.")
    train = read_jsonl(train_path)
    dev = read_jsonl(dev_path)
    require(len(train) == 1896 and len({str(row.get("id")) for row in train}) == 1896, "v0.5.5 unique training inventory differs.")
    require(len(dev) == 300 and sha256_file(dev_path) == register.get("bindings", {}).get("originalDevelopmentSha256"), "Frozen 300-row development comparator differs.")
    require(all(row.get("split") == "train" for row in train) and all(row.get("split") == "dev" for row in dev), "v0.5.5 split isolation differs.")
    require(collections.Counter(row.get("datasetId") for row in train) == EXPECTED_LINEAGE, "v0.5.5 training lineage differs.")
    order = recipe.get("sampleOrder")
    require(recipe.get("schema") == "com.saferide.ai.v055-training-recipe" and recipe.get("status") == "frozen-for-final-targeted-pilot", "v0.5.5 recipe identity differs.")
    require(recipe.get("seed") == 419805 and recipe.get("learningRate") == 1e-5 and recipe.get("epochs") == 1, "v0.5.5 pilot recipe differs.")
    require(recipe.get("scheduler") == "cosine" and recipe.get("warmupRatio") == 0.03, "v0.5.5 scheduler recipe differs.")
    require(recipe.get("gradientAccumulationSteps") == 8 and recipe.get("maxGradientNorm") == 1.0, "v0.5.5 gradient controls differ.")
    require(recipe.get("assistantOnlyLoss") is True and recipe.get("fullCandidateSubmissionAuthorized") is False, "v0.5.5 loss or authorization boundary differs.")
    require(isinstance(order, list) and len(order) == 1992 and len(set(order)) == 1896, "v0.5.5 weighted order differs.")
    require(set(order) == {str(row.get("id")) for row in train}, "v0.5.5 order references unavailable rows.")
    require(recipe.get("sampleOrderSha256") == hashlib.sha256("\n".join(order).encode("utf-8")).hexdigest(), "v0.5.5 order hash differs.")
    counts = collections.Counter(order)
    new_ids = {str(row.get("id")) for row in train if row.get("datasetId") == DATASET_ID}
    require(len(new_ids) == 32 and all(counts[row_id] == 4 for row_id in new_ids), "v0.5.5 new rows are not weighted exactly four times.")
    require(all(count == 1 for row_id, count in counts.items() if row_id not in new_ids), "v0.5.5 source rows are not single-weighted.")
    semantic_path = artifact_root / "semantic-report.private.json"
    tokenization_path = artifact_root / "tokenization-report.private.json"
    semantic = read_json(semantic_path)
    tokenization = read_json(tokenization_path)
    require(sha256_file(semantic_path) == manifest.get("bindings", {}).get("semanticReportSha256"), "v0.5.5 semantic binding differs.")
    require(semantic.get("status") == "passed" and semantic.get("threshold") == 0.92 and semantic.get("blockingResult") == {"flaggedPairCount": 0, "unresolvedPairCount": 0}, "v0.5.5 semantic gate differs.")
    require(semantic.get("scope", {}).get("sealedMitigationHoldoutRead") is False, "v0.5.5 semantic gate opened the holdout.")
    require(sha256_file(tokenization_path) == manifest.get("bindings", {}).get("tokenizationReportSha256"), "v0.5.5 tokenizer binding differs.")
    require(tokenization.get("status") == "passed" and tokenization.get("truncatedRowCount") == 0 and tokenization.get("assistantOnlyLabels") is True, "v0.5.5 tokenizer or assistant labels differ.")
    require(manifest.get("privacy", {}).get("sealedMitigationHoldoutRead") is False and manifest.get("privacy", {}).get("containsDevelopmentRows") is False, "v0.5.5 privacy boundary differs.")
    print("SafeRide v0.5.5 training-input gate passed.")
    print("Unique train: 1896; weighted pilot examples: 1992; development: 300; holdout read: false; promotion: false.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    verify_parser = subparsers.add_parser("verify")
    for argument in ("register", "train-data", "dev-data", "dataset-manifest", "artifact-root", "pilot-row-manifest", "audit"):
        verify_parser.add_argument(f"--{argument}", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "contract-check":
        require(re.fullmatch(r"[a-f0-9]{40}", BASE_MODEL["revision"]) is not None, "v0.5.5 base revision differs.")
        remediation = load_remediation()
        require(remediation.EXPECTED_MODEL_TERMINATORS == (1, 106, 50), "v0.5.5 terminator inventory differs.")
        print("SafeRide v0.5.5 training-input contract passed.")
        return 0
    return verify(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - content-free failure only.
        print(str(error).replace("\r", " ").replace("\n", " ")[:600], file=sys.stderr)
        raise SystemExit(1)
