#!/usr/bin/env python3
"""Freeze and verify the private SafeRide v0.5.8 full-candidate input."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
import random
import re
import stat
import tarfile
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[1]
BASE_RUNNER_PATH = SCRIPT_PATH.with_name("saferide-gemma4-finetune-runner.py")
SHA_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DATASET_ID = "saferide-synthetic-guidance-v0.5.8"
EXPECTED_UNIQUE_ROWS = 1904
EXPECTED_WEIGHTED_EXAMPLES = 1992
EXPECTED_OPTIMIZER_STEPS = 249
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
MODEL_INVENTORY_SHA256 = "ff7ebf6346e08ddc6c9901686b1a007ff383995a2bf15182feef5c1dbcb1d25b"
MODEL_TENSOR_SHA256 = "2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550"
GENERATION_CONFIG_SHA256 = "d4226bbe3117d2d253ba4609720ba82c6c4ce4627a9a6ae05387c78983ac03de"
TOKENIZER_CONFIG_SHA256 = "90c3a3ba5bf53818383a58e1a776cbcacd2a038d4812eaa373e1522f2d06f3df"
TOKENIZER_JSON_SHA256 = "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f"
CHAT_TEMPLATE_SHA256 = "2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082"
IMAGE_ARCHIVE_SHA256 = "a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf"
IMAGE_ARCHIVE_SIZE = 3350200320
IMAGE_MANIFEST_DIGEST = "ec30ecf55a9231d2ef9f87148ac967654f3880ebe6405164078151d157da77ca"
IMAGE_CONFIG_DIGEST = "7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87"
POLICY_SHA256 = "3cfdab48ad265e146f6e5d2e6f8d1aa1d46b42ba11ec322175fc0bd585182b4b"
DECISION_SHA256 = "c147e3e086dc356301401e070a13e29cd7bd23de858dadb880422d584c8f46c4"
PENDING_PLAN_SHA256 = "591efdd8f0092592756aa676e03b6ff4e9c9f6e930ec41306a2c3ca4030cedcb"

SOURCE_SPECS: tuple[dict[str, Any], ...] = (
    {
        "version": "v0.5", "argument": "base_root", "relative": "dataset/controlled/train.jsonl",
        "manifestRelative": "dataset/public-safe/dataset-manifest.json", "rows": 1600, "weight": 1,
        "sha256": "dd8b09648f4af001202787309ad8aefc5f23d67d028b6d5c655cd7b0fbec1f6f",
        "manifestSha256": "9d42b4d871c8d382c76e8fe71733e4e6ccf7138228fbcd0b5ab2ce8a96374801",
        "semanticRelative": "semantic/semantic-report.json",
        "semanticSha256": "bba3bcfcef40c6ee43567cae0aa3f70753ccc91afc5f44e6745b491e80895205",
    },
    {
        "version": "v0.5.1", "argument": "v051_root", "relative": "mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 120, "weight": 1,
        "sha256": "f74f2be4fc9a19975334c3d1e0a754720a36e0ae0b4381cda716c891cf7f5521",
        "manifestSha256": "b499a74cb4e8346b291462cee7a3a45d9be0afedaf17d6c0ae39a7b51f665ffd",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "d218b5afadca033f6de34483fec4e20d4b13109158a1ed21a0503002a8ccbd29",
    },
    {
        "version": "v0.5.2", "argument": "v052_root", "relative": "v052-mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 48, "weight": 1,
        "sha256": "5e182744b39096324051e902bbbee0976d25e7aed1bfde0a7e9e69f0df28445a",
        "manifestSha256": "3bbacbe8c74cb07ff0c59f64d158ead5065751f3aa2ecb9e7ca08a7bb0cbca6c",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "58e44611670fd47f7b4c8caa2592a23bbc3c3694121178ae865d6cb12bb03bde",
    },
    {
        "version": "v0.5.3", "argument": "v053_root", "relative": "v053-mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 64, "weight": 1,
        "sha256": "5a7bbcd7fa214c0e3c16ada53035e004fa56eceef137e4dafd1ff2317d6e4dd2",
        "manifestSha256": "6527d563b3fbf0d7e1f67d8b5cbc374ad1d487473ea0b9e8c89d1c86dff77228",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "c21f2e4d3a44404f6db97eb167320022afcdd37f75bb6412fc55e644fb12f22d",
    },
    {
        "version": "v0.5.4", "argument": "v054_root", "relative": "v054-mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 32, "weight": 2,
        "sha256": "3eb607e8e4fd7ab6ca5954fb676c12f98b3721f6b689ac3a0e152a69c9cd73d0",
        "manifestSha256": "92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "d548a6784dd9701631be044805556cd1f1d27d8e54547f72f8f847045ae55c52",
    },
    {
        "version": "v0.5.6", "argument": "v056_root", "relative": "v056-mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 24, "weight": 2,
        "sha256": "54f311799a13e4d6d894a8e43447710b84cd8fff0461645760243b1b155b3b54",
        "manifestSha256": "9900b4d55eef76d5dcc2deead3a5586695f08aaaea38ebbe6783ee5f23138dc0",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "728782556a05d81ed7f19cc3b11f16b56f2c067c66b56bc49b925efee0727883",
    },
    {
        "version": "v0.5.7", "argument": "v057_root", "relative": "v057-mitigation-train.private.jsonl",
        "manifestRelative": "frozen-manifest.private.json", "rows": 16, "weight": 3,
        "sha256": "9dd1b91a5cb14c06cb52e1418dfd71f0da3aeb86108d0266d1265194a307b3c5",
        "manifestSha256": "f16c071a0bad06f5b425db9e2feb899c958497fcc0d0e7a59b02316e60a8e6d5",
        "semanticRelative": "semantic-report.private.json",
        "semanticSha256": "93f6731ffacb6eae961eebe02f1c55140fe9806f614ab547206ce8215510cc62",
    },
)

V055_EXCLUSION = {
    "version": "v0.5.5", "relative": "v055-mitigation-train.private.jsonl", "rows": 32,
    "sha256": "2db4b3f6a30f3166d0524db527dbf539c4b257ae69fc7d888402540c57196736",
    "declaredFrozenManifestSha256": "1c077d8cc62177afc8cbef25aa8c9d9fa85903a13d6d44a32fed9862facc91c4",
    "planSha256": "2187a1e4a01f5f8728011c164c70d4f745fc623a024e089ff3960f516cde1fa2",
}

EVALUATION_EXCLUSIONS = {
    "original-development": {"rows": 300, "sha256": "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"},
    "mitigation-development": {"rows": 20, "sha256": "55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd"},
    "quality-holdout": {"rows": 300, "sha256": "7d94d8d76d108a0c17c1eef086e4391a25995f02c66a6c74b93c40d9f6658b29"},
    "safety-holdout": {"rows": 400, "sha256": "3849f45aecd40f97b87f467f4d8092209e5f5a0b76587454660c82f8bb925152"},
    "sealed-mitigation-holdout": {"rows": None, "sha256": "6631477003f5029ca2210484b30be542e5ec47d72da5f9e0aba6d79ccb7e3bc4"},
}

PACKAGE_FILES_BEFORE_MANIFEST = (
    "combined-unique-train.private.jsonl", "weighted-train.private.jsonl",
    "selection-inventory.private.json", "exclusions.private.json",
    "deduplication-report.private.json", "weighting-recipe.private.json",
    "sample-order-contract.private.json", "semantic-separation-report.private.json",
    "leakage-report.private.json", "training-recipe.private.json",
    "tokenization-report.private.json", "dataset-audit.private.json", "register.private.json",
)


class FreezeError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FreezeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def private_directory(path: Path, label: str, *, empty: bool = False) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, f"{label} must be mode 0700.")
    if empty:
        require(not any(path.iterdir()), f"{label} must be newly empty.")


def private_file(path: Path, label: str, *, allow_readonly: bool = False) -> None:
    require(path.is_file() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    mode = stat.S_IMODE(path.stat().st_mode)
    require(mode == 0o600 or (allow_readonly and mode == 0o400), f"{label} permissions differ.")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path.name} is not a JSON object.")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            require(isinstance(value, dict), f"Controlled training row {line_number} is invalid.")
            rows.append(value)
    return rows


def write_private(path: Path, value: bytes) -> None:
    path.write_bytes(value)
    path.chmod(0o600)


def write_private_json(path: Path, value: Any) -> None:
    write_private(path, json.dumps(value, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n")


def write_private_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
    path.chmod(0o600)


def normalized_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"[^\w\s]", " ", normalized, flags=re.UNICODE)
    return re.sub(r"\s+", " ", normalized).strip()


def joined_role(row: dict[str, Any], role: str) -> str:
    return "\n".join(str(item.get("content", "")) for item in row["messages"] if item.get("role") == role)


def identity_record(row: dict[str, Any]) -> dict[str, str]:
    identity = canonical_sha256({
        "datasetId": row.get("datasetId"), "id": row.get("id"), "candidateId": row.get("candidateId"),
    })
    prompt = sha256_bytes(normalized_text(joined_role(row, "user")).encode("utf-8"))
    assistant = sha256_bytes(normalized_text(joined_role(row, "assistant")).encode("utf-8"))
    return {"stableIdentitySha256": identity, "normalizedPromptSha256": prompt, "normalizedAssistantSha256": assistant}


def validate_row(row: dict[str, Any]) -> None:
    require(row.get("split") == "train", "Selected v0.5.8 source contains a non-training row.")
    require(isinstance(row.get("id"), str) and row["id"], "Selected training row identity is missing.")
    require(isinstance(row.get("candidateId"), str) and row["candidateId"], "Selected candidate identity is missing.")
    require(isinstance(row.get("datasetId"), str) and row["datasetId"], "Selected dataset identity is missing.")
    messages = row.get("messages")
    require(isinstance(messages, list) and len(messages) >= 3, "Selected training row messages are malformed.")
    require(all(isinstance(item, dict) and item.get("role") in {"system", "user", "assistant"} and isinstance(item.get("content"), str) and item["content"] for item in messages), "Selected training row contains an invalid message.")
    require(messages[0].get("role") == "system" and any(item.get("role") == "user" for item in messages) and any(item.get("role") == "assistant" for item in messages), "Selected training row role order is invalid.")


def load_source(args: argparse.Namespace, spec: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    root = Path(getattr(args, spec["argument"])).expanduser().resolve()
    private_directory(root, f"{spec['version']} controlled source root")
    train = root / spec["relative"]
    manifest = root / spec["manifestRelative"]
    semantic = root / spec["semanticRelative"]
    private_file(train, f"{spec['version']} selected training source", allow_readonly=spec["version"] == "v0.5")
    private_file(manifest, f"{spec['version']} source manifest")
    private_file(semantic, f"{spec['version']} source semantic report")
    require(sha256_file(train) == spec["sha256"], f"{spec['version']} selected training bytes differ.")
    require(sha256_file(manifest) == spec["manifestSha256"], f"{spec['version']} source manifest differs.")
    require(sha256_file(semantic) == spec["semanticSha256"], f"{spec['version']} semantic report differs.")
    semantic_document = read_json(semantic)
    require(semantic_document.get("status") == "passed", f"{spec['version']} semantic source gate is not passed.")
    blocking = semantic_document.get("blockingResult")
    if isinstance(blocking, dict):
        require(blocking.get("flaggedPairCount") == 0 and blocking.get("unresolvedPairCount") == 0, f"{spec['version']} semantic findings are unresolved.")
    rows = read_jsonl(train)
    require(len(rows) == spec["rows"], f"{spec['version']} selected row count differs.")
    for row in rows:
        validate_row(row)
    return rows, {
        "version": spec["version"], "selected": True, "rowCount": len(rows), "weight": spec["weight"],
        "trainingSha256": spec["sha256"], "sourceManifestSha256": spec["manifestSha256"],
        "semanticReportSha256": spec["semanticSha256"], "semanticStatus": "passed",
    }


def collision_summary(records: list[dict[str, str]], key: str) -> dict[str, int]:
    counter = Counter(item[key] for item in records)
    return {
        "unique": len(counter), "duplicateValueCount": sum(1 for count in counter.values() if count > 1),
        "duplicateRowCount": sum(count - 1 for count in counter.values() if count > 1),
        "maximumMultiplicity": max(counter.values(), default=0),
    }


def prepare(args: argparse.Namespace) -> int:
    os.umask(0o077)
    output_root = Path(args.output_root).expanduser().resolve()
    private_directory(output_root, "v0.5.8 freeze root", empty=True)
    package = output_root / "package"
    package.mkdir(mode=0o700)
    all_rows: list[dict[str, Any]] = []
    source_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    selection_sources = []
    semantic_sources = []
    for spec in SOURCE_SPECS:
        rows, evidence = load_source(args, spec)
        all_rows.extend(rows)
        source_rows.append((spec, rows))
        selection_sources.append(evidence)
        semantic_sources.append({
            "version": spec["version"], "reportSha256": spec["semanticSha256"],
            "status": "passed", "flaggedPairCount": 0, "unresolvedPairCount": 0,
        })
    require(len(all_rows) == EXPECTED_UNIQUE_ROWS, "v0.5.8 selected unique row count differs.")

    excluded_root = Path(args.v055_root).expanduser().resolve()
    private_directory(excluded_root, "v0.5.5 excluded historical root")
    excluded_path = excluded_root / V055_EXCLUSION["relative"]
    private_file(excluded_path, "v0.5.5 excluded historical training source")
    require(sha256_file(excluded_path) == V055_EXCLUSION["sha256"], "v0.5.5 excluded historical bytes differ.")
    excluded_rows = read_jsonl(excluded_path)
    require(len(excluded_rows) == V055_EXCLUSION["rows"] and all(row.get("split") == "train" for row in excluded_rows), "v0.5.5 excluded historical row contract differs.")

    records = [identity_record(row) for row in all_rows]
    stable = collision_summary(records, "stableIdentitySha256")
    prompts = collision_summary(records, "normalizedPromptSha256")
    assistants = collision_summary(records, "normalizedAssistantSha256")
    composites = Counter((item["stableIdentitySha256"], item["normalizedPromptSha256"], item["normalizedAssistantSha256"]) for item in records)
    composite = {
        "unique": len(composites), "duplicateValueCount": sum(1 for count in composites.values() if count > 1),
        "duplicateRowCount": sum(count - 1 for count in composites.values() if count > 1),
        "maximumMultiplicity": max(composites.values(), default=0),
    }
    for label, value in (("stable identity", stable), ("normalized prompt", prompts), ("normalized assistant", assistants), ("composite", composite)):
        require(value["unique"] == EXPECTED_UNIQUE_ROWS and value["duplicateRowCount"] == 0, f"v0.5.8 {label} deduplication count differs.")

    weighted_rows: list[dict[str, Any]] = []
    weighted_versions: list[str] = []
    for spec, rows in source_rows:
        for _copy in range(spec["weight"]):
            weighted_rows.extend(rows)
            weighted_versions.extend([spec["version"]] * len(rows))
    require(len(weighted_rows) == EXPECTED_WEIGHTED_EXAMPLES, "v0.5.8 weighted example count differs.")

    write_private_jsonl(package / "combined-unique-train.private.jsonl", all_rows)
    write_private_jsonl(package / "weighted-train.private.jsonl", weighted_rows)

    selection = {
        "schema": "com.saferide.ai.v058-selection-inventory", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "frozen", "sourceOrder": [spec["version"] for spec in SOURCE_SPECS],
        "selectedSources": selection_sources, "selectedUniqueRows": EXPECTED_UNIQUE_ROWS,
        "selectedWeightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "privacy": {"rawRowsIncluded": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    exclusions = {
        "schema": "com.saferide.ai.v058-exclusion-inventory", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "frozen", "historicalMitigation": {
            **V055_EXCLUSION, "selectedForTraining": False,
            "reason": "v0.5.6 explicitly branched from v0.5.4 and superseded the v0.5.5 intervention",
        },
        "evaluationInputs": {name: {**value, "selectedForTraining": False, "bytesReadDuringFreeze": 0} for name, value in EVALUATION_EXCLUSIONS.items()},
        "privacy": {"rawRowsIncluded": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    dedup = {
        "schema": "com.saferide.ai.v058-deduplication-report", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "passed", "normalization": "NFKC-casefold-punctuation-to-space-whitespace-collapse-v1",
        "identityDefinition": "sha256(canonical(datasetId,id,candidateId))",
        "promptDefinition": "sha256(normalized concatenated user turns)",
        "assistantDefinition": "sha256(normalized concatenated assistant turns)",
        "inputRows": EXPECTED_UNIQUE_ROWS, "outputRows": EXPECTED_UNIQUE_ROWS,
        "stableIdentity": stable, "normalizedPrompt": prompts, "normalizedAssistant": assistants, "composite": composite,
        "stableIdentityInventorySha256": canonical_sha256(sorted(item["stableIdentitySha256"] for item in records)),
        "normalizedPromptInventorySha256": canonical_sha256(sorted(item["normalizedPromptSha256"] for item in records)),
        "normalizedAssistantInventorySha256": canonical_sha256(sorted(item["normalizedAssistantSha256"] for item in records)),
        "privacy": {"rawRowsIncluded": False, "rowIdentifiersIncluded": False, "contentHashesIncluded": False},
    }
    weights = {
        "schema": "com.saferide.ai.v058-weighting-recipe", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "frozen", "sourceOrder": [spec["version"] for spec in SOURCE_SPECS],
        "multipliers": {spec["version"]: spec["weight"] for spec in SOURCE_SPECS},
        "uniqueRowsBySource": {spec["version"]: spec["rows"] for spec in SOURCE_SPECS},
        "weightedExamplesBySource": {spec["version"]: spec["rows"] * spec["weight"] for spec in SOURCE_SPECS},
        "uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "baseOrderPolicy": "source-version-order-then-source-file-order-repeated-by-multiplier",
        "candidateOrderPolicy": "independent-python-random-seed-shuffle-once-then-sequential",
    }
    seed_contracts = []
    for seed in (419805, 419806):
        indexes = list(range(len(weighted_rows)))
        random.Random(seed).shuffle(indexes)
        order_ids = [str(weighted_rows[index]["id"]) for index in indexes]
        occurrence_keys = [f"{records_for_weighted_index(source_rows, index)[0]}:{records_for_weighted_index(source_rows, index)[1]}" for index in indexes]
        seed_contracts.append({
            "seed": seed, "examples": len(order_ids),
            "rowIdentityOrderSha256": sha256_bytes("\n".join(order_ids).encode("utf-8")),
            "occurrenceOrderSha256": sha256_bytes("\n".join(occurrence_keys).encode("utf-8")),
        })
    require(seed_contracts[0]["rowIdentityOrderSha256"] != seed_contracts[1]["rowIdentityOrderSha256"], "Candidate seed sample orders are not independent.")
    sample_order = {
        "schema": "com.saferide.ai.v058-sample-order-contract", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "frozen", "baseWeightedVersionOrderSha256": sha256_bytes("\n".join(weighted_versions).encode("utf-8")),
        "weightedTrainSha256": sha256_file(package / "weighted-train.private.jsonl"),
        "candidateOrders": seed_contracts, "pairedRunRequiredForSecondSeed": True,
        "privacy": {"rowIdentifiersIncluded": False, "rawRowsIncluded": False},
    }
    semantic_report = {
        "schema": "com.saferide.ai.v058-semantic-separation-report", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "passed", "method": "governed-LaBSE-source-reports-plus-cross-version-normalized-exact-separation",
        "threshold": 0.92, "sourceReports": semantic_sources,
        "crossVersionExactNormalizedPromptCollisions": prompts["duplicateRowCount"],
        "crossVersionExactNormalizedAssistantCollisions": assistants["duplicateRowCount"],
        "flaggedPairCount": 0, "unresolvedPairCount": 0,
        "developmentRowsReadDuringFreeze": 0, "holdoutRowsReadDuringFreeze": 0,
        "privacy": {"rawTextIncluded": False, "embeddingsIncluded": False, "rowIdentifiersIncluded": False},
    }
    leakage = {
        "schema": "com.saferide.ai.v058-leakage-report", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "passed", "selectedRows": EXPECTED_UNIQUE_ROWS,
        "selectedSplitCounts": {"train": EXPECTED_UNIQUE_ROWS},
        "evaluationInputsIncluded": 0, "evaluationRowsReadDuringFreeze": 0,
        "holdoutRowsReadDuringFreeze": 0, "excludedEvaluationBindings": EVALUATION_EXCLUSIONS,
        "v055HistoricalRowsIncluded": 0, "v055HistoricalSha256": V055_EXCLUSION["sha256"],
        "sourceSemanticLeakageGatesPassed": len(semantic_sources),
        "privacy": {"rawTextIncluded": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    training_recipe = {
        "schema": "com.saferide.ai.v058-candidate-training-recipe", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "frozen-for-two-full-candidates", "runKind": "candidate", "seeds": [419805, 419806],
        "seedOrder": [419805, 419806], "pairedRunRequiredForSeed419806": True,
        "epochs": 1, "learningRate": 2e-5, "maxSteps": None, "maximumSequenceLength": 1024,
        "rejectTruncation": True, "trainBatchSize": 1, "evaluationBatchSize": 1,
        "gradientAccumulationSteps": 8, "effectiveBatchSize": 8, "precision": "bf16",
        "gradientCheckpointing": True, "assistantOnlyLoss": True, "scheduler": "cosine",
        "warmupRatio": 0.03, "maximumGradientNorm": 1.0, "loggingSteps": 5,
        "evaluationSteps": 25, "saveSteps": 25, "earlyStoppingPatience": 3,
        "lora": {"rank": 8, "alpha": 16, "dropout": 0.05},
        "uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "expectedOptimizerSteps": EXPECTED_OPTIMIZER_STEPS, "saveAllCheckpoints": True,
        "sampleOrderContractSha256": None, "weightingRecipeSha256": None,
        "automaticRetryAuthorized": False, "zeroStepFailureConsumesCandidate": False,
        "optimizationStartedConsumesCandidate": True,
    }
    for name, value in (
        ("selection-inventory.private.json", selection), ("exclusions.private.json", exclusions),
        ("deduplication-report.private.json", dedup), ("weighting-recipe.private.json", weights),
        ("sample-order-contract.private.json", sample_order), ("semantic-separation-report.private.json", semantic_report),
        ("leakage-report.private.json", leakage),
    ):
        write_private_json(package / name, value)
    training_recipe["sampleOrderContractSha256"] = sha256_file(package / "sample-order-contract.private.json")
    training_recipe["weightingRecipeSha256"] = sha256_file(package / "weighting-recipe.private.json")
    write_private_json(package / "training-recipe.private.json", training_recipe)
    write_private_json(output_root / "prepare-receipt.json", {
        "schema": "com.saferide.ai.v058-prepare-receipt", "schemaVersion": 1, "status": "prepared-tokenization-pending",
        "uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "combinedUniqueTrainSha256": sha256_file(package / "combined-unique-train.private.jsonl"),
        "weightedTrainSha256": sha256_file(package / "weighted-train.private.jsonl"),
        "developmentRowsRead": 0, "holdoutRowsRead": 0,
    })
    print("SafeRide v0.5.8 prepare PASS (1,904 unique; 1,992 weighted; development/holdout reads 0).")
    return 0


def records_for_weighted_index(source_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]], index: int) -> tuple[str, int]:
    cursor = 0
    for spec, rows in source_rows:
        span = len(rows) * spec["weight"]
        if cursor <= index < cursor + span:
            local = index - cursor
            return spec["version"], local // len(rows)
        cursor += span
    raise FreezeError("Weighted occurrence index is outside the frozen inventory.")


def load_base_runner() -> Any:
    spec = importlib.util.spec_from_file_location("saferide_v058_base_runner", BASE_RUNNER_PATH)
    require(spec is not None and spec.loader is not None, "Base fine-tune runner cannot be loaded.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tokenize(args: argparse.Namespace) -> int:
    os.umask(0o077)
    package = Path(args.package_dir).expanduser().resolve()
    model = Path(args.model_dir).expanduser().resolve()
    private_directory(package, "Prepared v0.5.8 package")
    private_directory(model, "Pinned model root")
    report_path = package / "tokenization-report.private.json"
    require(not report_path.exists(), "Tokenization report already exists; overwrite is forbidden.")
    expected_model = {
        "tokenizer.json": TOKENIZER_JSON_SHA256, "tokenizer_config.json": TOKENIZER_CONFIG_SHA256,
        "chat_template.jinja": CHAT_TEMPLATE_SHA256, "model.safetensors": MODEL_TENSOR_SHA256,
        "generation_config.json": GENERATION_CONFIG_SHA256,
    }
    for name, expected in expected_model.items():
        path = model / name
        private_file(path, f"Pinned model file {name}")
        require(sha256_file(path) == expected, f"Pinned model file differs: {name}")
    from transformers import AutoTokenizer  # type: ignore[import-not-found]

    base = load_base_runner()
    tokenizer = AutoTokenizer.from_pretrained(str(model), local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    require(tokenizer.pad_token_id is not None, "Pinned tokenizer has no pad token.")
    require(sha256_bytes(str(tokenizer.chat_template).encode("utf-8")) == CHAT_TEMPLATE_SHA256, "Effective tokenizer chat template differs.")
    unique_rows = read_jsonl(package / "combined-unique-train.private.jsonl")
    weighted_rows = read_jsonl(package / "weighted-train.private.jsonl")
    require(len(unique_rows) == EXPECTED_UNIQUE_ROWS and len(weighted_rows) == EXPECTED_WEIGHTED_EXAMPLES, "Prepared tokenization inputs differ.")
    unique_encoded = [base.encode_assistant_only_row(tokenizer, row, 1024) for row in unique_rows]
    weighted_encoded = [base.encode_assistant_only_row(tokenizer, row, 1024) for row in weighted_rows]
    lengths = [len(item["input_ids"]) for item in unique_encoded]
    assistant_lengths = [item["assistant_token_count"] for item in unique_encoded]
    report = {
        "schema": "com.saferide.ai.v058-tokenization-report", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "passed", "tokenizer": {
            "modelId": "google/gemma-4-E2B-it", "revision": MODEL_REVISION,
            "tokenizerJsonSha256": TOKENIZER_JSON_SHA256, "tokenizerConfigSha256": TOKENIZER_CONFIG_SHA256,
            "chatTemplateSha256": CHAT_TEMPLATE_SHA256, "padTokenId": int(tokenizer.pad_token_id),
            "eosTokenId": int(tokenizer.eos_token_id),
        },
        "maximumSequenceLength": 1024, "rejectTruncation": True,
        "uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "uniqueRowsTokenized": len(unique_encoded), "weightedExamplesTokenized": len(weighted_encoded),
        "truncatedRows": 0, "rowsWithoutAssistantLabels": 0,
        "minimumTokens": min(lengths), "maximumTokens": max(lengths), "totalUniqueTokens": sum(lengths),
        "minimumAssistantTokens": min(assistant_lengths), "maximumAssistantTokens": max(assistant_lengths),
        "totalUniqueAssistantTokens": sum(assistant_lengths),
        "totalWeightedTokens": sum(len(item["input_ids"]) for item in weighted_encoded),
        "totalWeightedAssistantTokens": sum(item["assistant_token_count"] for item in weighted_encoded),
        "assistantOnlyLoss": True, "developmentRowsRead": 0, "holdoutRowsRead": 0,
        "privacy": {"rawTextIncluded": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    write_private_json(report_path, report)
    print(f"SafeRide v0.5.8 exact tokenizer PASS (1,904 unique; max {max(lengths)}/1,024; truncations 0).")
    return 0


def file_record(package: Path, name: str, classification: str, record_count: int) -> dict[str, Any]:
    path = package / name
    private_file(path, f"v0.5.8 package file {name}")
    return {"path": name, "classification": classification, "recordCount": record_count, "sha256": sha256_file(path), "sizeBytes": path.stat().st_size}


def deterministic_archive(package: Path, archive_path: Path, top_level: str, file_names: list[str]) -> None:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            root_info = tarfile.TarInfo(top_level)
            root_info.type = tarfile.DIRTYPE; root_info.mode = 0o700; root_info.mtime = 0; root_info.uid = 0; root_info.gid = 0
            root_info.uname = ""; root_info.gname = ""
            archive.addfile(root_info)
            for name in sorted(file_names):
                source = package / name
                data = source.read_bytes()
                info = tarfile.TarInfo(f"{top_level}/{name}")
                info.size = len(data); info.mode = 0o600; info.mtime = 0; info.uid = 0; info.gid = 0
                info.uname = ""; info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    write_private(archive_path, buffer.getvalue())


def finalize(args: argparse.Namespace) -> int:
    os.umask(0o077)
    root = Path(args.output_root).expanduser().resolve()
    package = root / "package"
    private_directory(root, "v0.5.8 freeze root")
    private_directory(package, "Prepared v0.5.8 package")
    require(not (package / "frozen-manifest.private.json").exists(), "Frozen v0.5.8 package already finalized; overwrite is forbidden.")
    tokenization = read_json(package / "tokenization-report.private.json")
    require(tokenization.get("status") == "passed" and tokenization.get("uniqueRows") == EXPECTED_UNIQUE_ROWS and tokenization.get("weightedExamples") == EXPECTED_WEIGHTED_EXAMPLES and tokenization.get("truncatedRows") == 0, "Exact tokenizer/no-truncation report is incomplete.")
    selection_hash = sha256_file(package / "selection-inventory.private.json")
    exclusions_hash = sha256_file(package / "exclusions.private.json")
    dedup_hash = sha256_file(package / "deduplication-report.private.json")
    weighting_hash = sha256_file(package / "weighting-recipe.private.json")
    order_hash = sha256_file(package / "sample-order-contract.private.json")
    semantic_hash = sha256_file(package / "semantic-separation-report.private.json")
    leakage_hash = sha256_file(package / "leakage-report.private.json")
    recipe_hash = sha256_file(package / "training-recipe.private.json")
    tokenization_hash = sha256_file(package / "tokenization-report.private.json")
    unique_hash = sha256_file(package / "combined-unique-train.private.jsonl")
    weighted_hash = sha256_file(package / "weighted-train.private.jsonl")
    audit = {
        "schema": "com.saferide.ai.v058-dataset-audit", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "passed", "counts": {"uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES, "optimizerSteps": EXPECTED_OPTIMIZER_STEPS},
        "gates": {"selection": "passed", "exclusions": "passed", "deduplication": "passed", "weighting": "passed", "sampleOrder": "passed", "semanticSeparation": "passed", "tokenization": "passed", "leakage": "passed"},
        "bindings": {"selectionInventorySha256": selection_hash, "exclusionsSha256": exclusions_hash, "deduplicationReportSha256": dedup_hash, "weightingRecipeSha256": weighting_hash, "sampleOrderContractSha256": order_hash, "semanticReportSha256": semantic_hash, "tokenizationReportSha256": tokenization_hash, "leakageReportSha256": leakage_hash, "trainingRecipeSha256": recipe_hash, "combinedUniqueTrainSha256": unique_hash, "weightedTrainSha256": weighted_hash},
        "privacy": {"developmentRowsReadDuringFreeze": 0, "holdoutRowsReadDuringFreeze": 0, "rawRowsIncluded": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    write_private_json(package / "dataset-audit.private.json", audit)
    audit_hash = sha256_file(package / "dataset-audit.private.json")
    register = {
        "schema": "com.saferide.ai.v058-candidate-register", "schemaVersion": 1, "datasetId": DATASET_ID,
        "status": "approved-for-two-full-development-candidates", "issue": "ESH-4198",
        "authorization": {"reference": "ESH-4198-v058-global-usefulness-floor-20260809-01", "authorizedSeeds": [419805, 419806], "authorizedCandidateCount": 2, "holdoutAuthorized": False, "selectionAuthorized": False, "promotionAuthorized": False},
        "counts": {"uniqueTrainRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES, "expectedOptimizerSteps": EXPECTED_OPTIMIZER_STEPS},
        "artifacts": {"combinedUniqueTrainSha256": unique_hash, "weightedTrainSha256": weighted_hash, "selectionInventorySha256": selection_hash, "exclusionsSha256": exclusions_hash, "deduplicationReportSha256": dedup_hash, "weightingRecipeSha256": weighting_hash, "sampleOrderContractSha256": order_hash, "semanticReportSha256": semantic_hash, "tokenizationReportSha256": tokenization_hash, "leakageReportSha256": leakage_hash, "trainingRecipeSha256": recipe_hash, "datasetAuditSha256": audit_hash},
        "runtime": {"modelRevision": MODEL_REVISION, "modelInventorySha256": MODEL_INVENTORY_SHA256, "imageArchiveSha256": IMAGE_ARCHIVE_SHA256, "imageRuntimeConfigDigest": IMAGE_CONFIG_DIGEST},
        "privacy": {"realSurvivorDataUsed": False, "developmentRowsIncluded": False, "holdoutRowsIncluded": False, "rawRowsIncludedInRegister": False, "rowIdentifiersIncluded": False, "privatePathsIncluded": False},
    }
    write_private_json(package / "register.private.json", register)
    register_hash = sha256_file(package / "register.private.json")
    records = []
    for name in PACKAGE_FILES_BEFORE_MANIFEST:
        classification = "controlled" if name.endswith(".jsonl") else "controlled-content-free"
        count = EXPECTED_UNIQUE_ROWS if name == "combined-unique-train.private.jsonl" else EXPECTED_WEIGHTED_EXAMPLES if name == "weighted-train.private.jsonl" else 1
        records.append(file_record(package, name, classification, count))
    manifest = {
        "schema": "com.saferide.ai.v058-frozen-candidate-manifest", "schemaVersion": 1, "manifestId": "saferide-v058-full-candidate-input",
        "datasetId": DATASET_ID, "status": "frozen-runnable", "issue": "ESH-4198",
        "counts": {"selectedSourceRows": EXPECTED_UNIQUE_ROWS, "uniqueTrainRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES, "optimizerStepsPerCandidate": EXPECTED_OPTIMIZER_STEPS, "authorizedCandidates": 2},
        "bindings": {"pendingPlanSha256": PENDING_PLAN_SHA256, "policySha256": POLICY_SHA256, "decisionSha256": DECISION_SHA256, "implementationSha256": sha256_file(SCRIPT_PATH), "selectionInventorySha256": selection_hash, "exclusionsSha256": exclusions_hash, "deduplicationReportSha256": dedup_hash, "weightingRecipeSha256": weighting_hash, "sampleOrderContractSha256": order_hash, "combinedUniqueTrainSha256": unique_hash, "weightedTrainSha256": weighted_hash, "registerSha256": register_hash, "datasetAuditSha256": audit_hash, "semanticReportSha256": semantic_hash, "tokenizationReportSha256": tokenization_hash, "leakageReportSha256": leakage_hash, "trainingRecipeSha256": recipe_hash},
        "runtime": {"modelRevision": MODEL_REVISION, "modelInventorySha256": MODEL_INVENTORY_SHA256, "modelTensorSha256": MODEL_TENSOR_SHA256, "generationConfigSha256": GENERATION_CONFIG_SHA256, "tokenizerConfigSha256": TOKENIZER_CONFIG_SHA256, "chatTemplateSha256": CHAT_TEMPLATE_SHA256, "imageArchiveSha256": IMAGE_ARCHIVE_SHA256, "imageArchiveSizeBytes": IMAGE_ARCHIVE_SIZE, "imageRuntimeManifestDigest": IMAGE_MANIFEST_DIGEST, "imageRuntimeConfigDigest": IMAGE_CONFIG_DIGEST},
        "files": records,
        "privacy": {"developmentRowsIncluded": False, "mitigationDevelopmentRowsIncluded": False, "baseHoldoutRowsIncluded": False, "sealedMitigationHoldoutIncluded": False, "rawRowsCommitted": False, "privatePathsIncluded": False},
    }
    write_private_json(package / "frozen-manifest.private.json", manifest)
    manifest_hash = sha256_file(package / "frozen-manifest.private.json")
    top_level = f"saferide-v058-a11-input-{manifest_hash[:12]}"
    archive_path = root / "saferide-v058-a11-training-input.tar.gz"
    deterministic_archive(package, archive_path, top_level, [*PACKAGE_FILES_BEFORE_MANIFEST, "frozen-manifest.private.json"])
    input_manifest = {
        "schema": "com.saferide.ai.v058-a11-input-manifest", "schemaVersion": 1, "manifestId": top_level,
        "status": "frozen-runnable", "issue": "ESH-4198", "backend": "A11-only",
        "trainingArchive": {"fileName": archive_path.name, "sha256": sha256_file(archive_path), "sizeBytes": archive_path.stat().st_size, "topLevelDirectory": top_level, "packageManifestSha256": manifest_hash},
        "counts": {"uniqueRows": EXPECTED_UNIQUE_ROWS, "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES, "optimizerStepsPerCandidate": EXPECTED_OPTIMIZER_STEPS},
        "runtime": manifest["runtime"],
        "authorization": {"runKind": "candidate", "seeds": [419805, 419806], "sequential": True, "pairedPredecessorRequiredForSeed419806": True, "automaticRetryAuthorized": False},
        "privacy": {
            "containsControlledTrainingRows": True,
            "controlledTrainingRowsRemainPrivate": True,
            "containsPrivatePaths": False,
            "containsCredentials": False,
            "developmentIncluded": False,
            "holdoutIncluded": False,
        },
    }
    write_private_json(root / "a11-input-manifest.json", input_manifest)
    verify_root(root)
    print("SafeRide v0.5.8 finalize PASS (frozen runnable A11 package; 1,904 unique; 1,992 weighted; 249 steps).")
    return 0


def archive_members(archive_path: Path) -> tuple[str, dict[str, tarfile.TarInfo]]:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
    require(members and members[0].isdir(), "v0.5.8 archive root is missing.")
    top_level = members[0].name.rstrip("/")
    return top_level, {member.name: member for member in members}


def verify_root(root: Path) -> dict[str, Any]:
    private_directory(root, "Frozen v0.5.8 root")
    package = root / "package"
    private_directory(package, "Frozen v0.5.8 package")
    input_path = root / "a11-input-manifest.json"
    archive_path = root / "saferide-v058-a11-training-input.tar.gz"
    private_file(input_path, "v0.5.8 A11 input manifest")
    private_file(archive_path, "v0.5.8 A11 training archive")
    input_manifest = read_json(input_path)
    require(input_manifest.get("schema") == "com.saferide.ai.v058-a11-input-manifest" and input_manifest.get("status") == "frozen-runnable" and input_manifest.get("backend") == "A11-only", "A11 input manifest identity differs.")
    archive_binding = input_manifest.get("trainingArchive", {})
    require(archive_binding.get("fileName") == archive_path.name and archive_binding.get("sha256") == sha256_file(archive_path) and archive_binding.get("sizeBytes") == archive_path.stat().st_size, "A11 training archive binding differs.")
    manifest_path = package / "frozen-manifest.private.json"
    private_file(manifest_path, "v0.5.8 frozen manifest")
    require(archive_binding.get("packageManifestSha256") == sha256_file(manifest_path), "A11 package manifest binding differs.")
    manifest = read_json(manifest_path)
    require(manifest.get("schema") == "com.saferide.ai.v058-frozen-candidate-manifest" and manifest.get("status") == "frozen-runnable", "Frozen v0.5.8 manifest identity differs.")
    require(manifest.get("counts") == {"selectedSourceRows": 1904, "uniqueTrainRows": 1904, "weightedExamples": 1992, "optimizerStepsPerCandidate": 249, "authorizedCandidates": 2}, "Frozen v0.5.8 manifest counts differ.")
    declared = {item["path"]: item for item in manifest.get("files", [])}
    require(set(declared) == set(PACKAGE_FILES_BEFORE_MANIFEST), "Frozen v0.5.8 file inventory differs.")
    for name, item in declared.items():
        path = package / name
        private_file(path, f"Frozen v0.5.8 file {name}")
        require(item.get("sha256") == sha256_file(path) and item.get("sizeBytes") == path.stat().st_size, f"Frozen v0.5.8 file differs: {name}")
    unique_rows = read_jsonl(package / "combined-unique-train.private.jsonl")
    weighted_rows = read_jsonl(package / "weighted-train.private.jsonl")
    require(len(unique_rows) == EXPECTED_UNIQUE_ROWS and len(weighted_rows) == EXPECTED_WEIGHTED_EXAMPLES, "Frozen v0.5.8 row counts differ.")
    require(all(row.get("split") == "train" for row in unique_rows + weighted_rows), "Frozen v0.5.8 package includes a non-training split.")
    records = [identity_record(row) for row in unique_rows]
    require(all(collision_summary(records, key)["duplicateRowCount"] == 0 for key in ("stableIdentitySha256", "normalizedPromptSha256", "normalizedAssistantSha256")), "Frozen v0.5.8 deduplication replay failed.")
    recipe = read_json(package / "training-recipe.private.json")
    order = read_json(package / "sample-order-contract.private.json")
    require(recipe.get("runKind") == "candidate" and recipe.get("weightedExamples") == EXPECTED_WEIGHTED_EXAMPLES and recipe.get("expectedOptimizerSteps") == EXPECTED_OPTIMIZER_STEPS and recipe.get("maxSteps") is None, "Frozen v0.5.8 training recipe differs.")
    expected_orders = {item["seed"]: item for item in order.get("candidateOrders", [])}
    require(set(expected_orders) == {419805, 419806}, "Frozen candidate order inventory differs.")
    for seed in (419805, 419806):
        replay = list(weighted_rows); random.Random(seed).shuffle(replay)
        actual = sha256_bytes("\n".join(str(row["id"]) for row in replay).encode("utf-8"))
        require(expected_orders[seed].get("rowIdentityOrderSha256") == actual, f"Frozen candidate sample order differs for seed {seed}.")
    for name in ("selection-inventory.private.json", "exclusions.private.json", "deduplication-report.private.json", "weighting-recipe.private.json", "sample-order-contract.private.json", "semantic-separation-report.private.json", "leakage-report.private.json", "tokenization-report.private.json", "dataset-audit.private.json", "register.private.json"):
        require(read_json(package / name).get("status") in {"passed", "frozen", "approved-for-two-full-development-candidates"}, f"Frozen v0.5.8 gate is not passed: {name}")
    top_level, members = archive_members(archive_path)
    require(top_level == archive_binding.get("topLevelDirectory"), "A11 archive top-level binding differs.")
    expected_member_names = {top_level, *(f"{top_level}/{name}" for name in [*PACKAGE_FILES_BEFORE_MANIFEST, "frozen-manifest.private.json"])}
    require(set(members) == expected_member_names, "A11 archive member inventory differs.")
    with tarfile.open(archive_path, "r:gz") as archive:
        for name in [*PACKAGE_FILES_BEFORE_MANIFEST, "frozen-manifest.private.json"]:
            member = members[f"{top_level}/{name}"]
            require(member.isfile() and stat.S_IMODE(member.mode) == 0o600, f"A11 archive member mode differs: {name}")
            stream = archive.extractfile(member)
            require(stream is not None and sha256_bytes(stream.read()) == sha256_file(package / name), f"A11 archive member bytes differ: {name}")
    return {
        "status": "passed", "inputManifestSha256": sha256_file(input_path),
        "archiveSha256": sha256_file(archive_path), "archiveSizeBytes": archive_path.stat().st_size,
        "frozenManifestSha256": sha256_file(manifest_path), "uniqueRows": len(unique_rows),
        "weightedExamples": len(weighted_rows), "optimizerSteps": EXPECTED_OPTIMIZER_STEPS,
    }


def verify(args: argparse.Namespace) -> int:
    result = verify_root(Path(args.output_root).expanduser().resolve())
    print(f"SafeRide v0.5.8 frozen package PASS ({result['uniqueRows']} unique; {result['weightedExamples']} weighted; {result['optimizerSteps']} steps).")
    return 0


def contract_check() -> int:
    require(sum(spec["rows"] for spec in SOURCE_SPECS) == EXPECTED_UNIQUE_ROWS, "v0.5.8 selected source count contract differs.")
    require(sum(spec["rows"] * spec["weight"] for spec in SOURCE_SPECS) == EXPECTED_WEIGHTED_EXAMPLES, "v0.5.8 weighting count contract differs.")
    require((EXPECTED_WEIGHTED_EXAMPLES + 7) // 8 == EXPECTED_OPTIMIZER_STEPS, "v0.5.8 optimizer-step contract differs.")
    require([spec["version"] for spec in SOURCE_SPECS] == ["v0.5", "v0.5.1", "v0.5.2", "v0.5.3", "v0.5.4", "v0.5.6", "v0.5.7"], "v0.5.8 selected lineage differs.")
    require(V055_EXCLUSION["version"] == "v0.5.5" and V055_EXCLUSION["rows"] == 32, "v0.5.5 exclusion contract differs.")
    print("SafeRide v0.5.8 dataset contract PASS (1,904 unique; 1,992 weighted; v0.5.5 excluded; evaluation/holdout rows excluded).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    prepare_parser = sub.add_parser("prepare")
    for name in ("base-root", "v051-root", "v052-root", "v053-root", "v054-root", "v055-root", "v056-root", "v057-root", "output-root"):
        prepare_parser.add_argument(f"--{name}", required=True)
    tokenize_parser = sub.add_parser("tokenize")
    tokenize_parser.add_argument("--package-dir", required=True); tokenize_parser.add_argument("--model-dir", required=True)
    finalize_parser = sub.add_parser("finalize"); finalize_parser.add_argument("--output-root", required=True)
    verify_parser = sub.add_parser("verify"); verify_parser.add_argument("--output-root", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check())
        if parsed.command == "prepare":
            raise SystemExit(prepare(parsed))
        if parsed.command == "tokenize":
            raise SystemExit(tokenize(parsed))
        if parsed.command == "finalize":
            raise SystemExit(finalize(parsed))
        raise SystemExit(verify(parsed))
    except (OSError, ValueError, json.JSONDecodeError, FreezeError) as error:
        print(f"SafeRide v0.5.8 dataset blocked: {re.sub(r'\s+', ' ', str(error))[:500]}", file=os.sys.stderr)
        raise SystemExit(1)
