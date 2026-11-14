#!/usr/bin/env python3
"""Verify a staged SafeRide v0.5.1 training package without reading holdouts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


DATASET_ID = "saferide-synthetic-guidance-v0.5.1"
SOURCE_DATASET_ID = "saferide-synthetic-guidance-v0.5.0"
CANDIDATE_MANIFEST_SHA256 = "0f9ea98bd6a196d0b8a4f466b360eadccc3882963d94543e7f395ca18eb9d4ec"
FORBIDDEN = re.compile(r"(?:^|/)(?:mitigation-holdout|quality-holdout|safety-holdout|blind|reviews?|credentials?)(?:[./_-]|/|$)", re.IGNORECASE)


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
    require(path.is_file(), f"Required training evidence is missing: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    require(path.is_file(), f"Required training data is missing: {path.name}")
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"Training JSONL is invalid at line {line_number}: {path.name}") from error
            require(isinstance(value, dict), f"Training JSONL row is invalid: {path.name}")
            rows.append(value)
    return rows


def file_hash(register: dict[str, Any], record_count: int) -> str:
    matches = [item for item in register.get("files", []) if item.get("recordCount") == record_count]
    require(len(matches) == 1, f"Register must bind exactly one {record_count}-record artifact.")
    return str(matches[0].get("sha256"))


def verify(args: argparse.Namespace) -> int:
    register_path = Path(args.register).expanduser().resolve()
    train_path = Path(args.train_data).expanduser().resolve()
    dev_path = Path(args.dev_data).expanduser().resolve()
    manifest_path = Path(args.dataset_manifest).expanduser().resolve()
    pilot_path = Path(args.pilot_row_manifest).expanduser().resolve()
    artifact_root = Path(args.artifact_root).expanduser().resolve()
    for path in (register_path, train_path, dev_path, manifest_path, pilot_path):
        require(path.is_file(), f"Required v0.5.1 training input is missing: {path.name}")
    require(artifact_root.is_dir(), "v0.5.1 artifact root is missing.")
    actual_paths = [path.relative_to(artifact_root).as_posix() for path in artifact_root.rglob("*") if path.is_file()]
    require(not any(FORBIDDEN.search(path) for path in actual_paths), "Training artifact root contains protected or reviewer bytes.")

    register = read_json(register_path)
    manifest = read_json(manifest_path)
    pilot = read_json(pilot_path)
    require(register.get("schema") == "com.saferide.ai.v051-mitigation-register" and register.get("datasetId") == DATASET_ID, "v0.5.1 training register identity differs.")
    require(register.get("status") == "training-ready-promotion-blocked" and register.get("trainingAllowed") is True and register.get("promotionAllowed") is False, "v0.5.1 training register state differs.")
    candidate_manifest_sha = register.get("candidateManifestSha256")
    require(isinstance(candidate_manifest_sha, str) and re.fullmatch(r"[a-f0-9]{64}", candidate_manifest_sha) is not None, "v0.5.1 candidate-manifest hash is invalid.")
    require(register.get("historicalCandidateManifestSha256") == CANDIDATE_MANIFEST_SHA256 and register.get("intermediateReviewStatus") == "not_required", "v0.5.1 register governance binding differs.")
    require(manifest.get("schema") == "com.saferide.ai.v051-mitigation-manifest" and manifest.get("status") == "frozen", "v0.5.1 frozen manifest identity differs.")
    require(manifest.get("bindings", {}).get("candidateManifestSha256") == candidate_manifest_sha and manifest.get("bindings", {}).get("historicalCandidateManifestSha256") == CANDIDATE_MANIFEST_SHA256 and manifest.get("trainingAllowed") is True and manifest.get("promotionAllowed") is False, "v0.5.1 frozen manifest state differs.")
    require(manifest.get("review", {}).get("status") == "not_required" and manifest.get("review", {}).get("approvedRoles") == [], "Retired reviews must not appear approved in training evidence.")

    train = read_jsonl(train_path)
    dev = read_jsonl(dev_path)
    require(len(train) == 1720 and sha256_file(train_path) == file_hash(register, 1720), "v0.5.1 combined training bytes or count differ.")
    require(len(dev) == 300 and sha256_file(dev_path) == manifest.get("bindings", {}).get("sourceDevelopmentSha256"), "v0.5 development comparator bytes or count differ.")
    require(len({str(row.get("id")) for row in train}) == 1720, "v0.5.1 training row IDs are not unique.")
    require(all(row.get("split") == "train" for row in train), "v0.5.1 training input contains a non-training split.")
    require(sum(row.get("datasetId") == SOURCE_DATASET_ID for row in train) == 1600 and sum(row.get("datasetId") == DATASET_ID for row in train) == 120, "v0.5.1 training lineage composition differs.")
    require(all(row.get("datasetId") == SOURCE_DATASET_ID and row.get("split") == "dev" for row in dev), "Development comparator lineage differs.")

    row_ids = pilot.get("rowIds")
    require(pilot.get("schema") == "com.saferide.ai.v051-pilot-row-manifest" and pilot.get("datasetId") == DATASET_ID and pilot.get("status") == "frozen", "v0.5.1 pilot manifest identity differs.")
    require(pilot.get("seed") == 419805 and pilot.get("composition") == {"sourceRows": 200, "sourceRowsPerCategoryLanguage": 10, "mitigationRows": 120}, "v0.5.1 pilot composition differs.")
    require(pilot.get("combinedTrainSha256") == sha256_file(train_path) and sha256_file(pilot_path) == file_hash(register, 320), "v0.5.1 pilot bindings differ.")
    require(isinstance(row_ids, list) and len(row_ids) == len(set(row_ids)) == 320 and set(row_ids).issubset({str(row.get("id")) for row in train}), "v0.5.1 pilot row inventory differs.")
    mitigation_ids = {str(row.get("id")) for row in train if row.get("datasetId") == DATASET_ID}
    require(mitigation_ids.issubset(set(row_ids)), "v0.5.1 pilot omits mitigation-training rows.")
    require(pilot.get("mitigationHoldoutIncluded") is False and pilot.get("developmentRowsIncluded") is False, "v0.5.1 pilot includes a forbidden split.")

    required_evidence = {
        "semantic-report.json": register.get("semanticReportSha256"),
        "tokenization-report.json": register.get("tokenizationReportSha256"),
        "governance-state.json": register.get("governanceStateSha256"),
    }
    for name, expected_sha in required_evidence.items():
        matches = [path for path in artifact_root.rglob(name) if path.is_file()]
        require(len(matches) == 1 and sha256_file(matches[0]) == expected_sha, f"Staged {name} binding differs.")
    semantic = read_json(next(artifact_root.rglob("semantic-report.json")))
    tokenization = read_json(next(artifact_root.rglob("tokenization-report.json")))
    require(semantic.get("schema") == "com.saferide.ai.v051-prompt-semantic-summary" and semantic.get("schemaVersion") == 2 and semantic.get("status") == "passed", "Prompt-only automated semantic gate is not passed.")
    require(semantic.get("blockingResult", {}).get("representation") == "normalized-user-turns-only-v1" and semantic.get("blockingResult", {}).get("flaggedPairCount") == 0 and semantic.get("blockingResult", {}).get("unresolvedPairCount") == 0, "Prompt-only automated semantic gate contains findings.")
    require(semantic.get("diagnosticReconciliation", {}).get("reproducedFlaggedPairCount") == 31 and semantic.get("diagnosticReconciliation", {}).get("reconciled") is True, "Historical full-dialogue semantic evidence did not reconcile.")
    require(tokenization.get("status") == "passed" and tokenization.get("truncatedRowCount") == 0 and tokenization.get("assistantOnlyLabels") is True, "Tokenizer/assistant-label gate is not passed.")
    print("SafeRide v0.5.1 training-input gate passed.")
    print("Train: 1720; development: 300; pilot: 320; protected/reviewer bytes: absent; promotion: false.")
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "contract-check":
        require(CANDIDATE_MANIFEST_SHA256 == "0f9ea98bd6a196d0b8a4f466b360eadccc3882963d94543e7f395ca18eb9d4ec", "Candidate manifest contract differs.")
        print("SafeRide v0.5.1 training-input contract passed.")
        return 0
    return verify(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - output is content-free.
        print(str(error).replace("\r", " ").replace("\n", " ")[:800], file=sys.stderr)
        raise SystemExit(1)
