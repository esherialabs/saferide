#!/usr/bin/env python3
"""Verify frozen v0.5.7 continuation inputs before any GPU use."""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import random
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
DATASET_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-dataset.py")
EXPECTED_DEV_SHA256 = "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"
EXPECTED_ADAPTER_SHA256 = "6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4"


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DATASET = load_module(DATASET_PATH, "saferide_v057_training_dataset")
require = DATASET.require


def verify(frozen_dir: Path, dev_data: Path) -> dict[str, Any]:
    frozen_dir = frozen_dir.expanduser().resolve(); dev_data = dev_data.expanduser().resolve()
    DATASET.assert_private(frozen_dir); DATASET.assert_private(dev_data)
    manifest_path = frozen_dir / "frozen-manifest.private.json"
    manifest = DATASET.read_json(manifest_path)
    require(manifest.get("schema") == "com.saferide.ai.v057-mitigation-manifest" and manifest.get("status") == "frozen", "v0.5.7 frozen manifest identity differs.")
    require(manifest.get("counts") == {"newRows": 16, "newFamilies": 8, "uniqueTrainRows": 72, "weightedTrainingExamples": 104, "developmentRows": 300, "mitigationDevelopmentRows": 20}, "v0.5.7 frozen counts differ.")
    declared = {item.get("path"): item for item in manifest.get("files", [])}
    for name, item in declared.items():
        path = frozen_dir / str(name)
        require(path.is_file() and not path.is_symlink(), f"v0.5.7 frozen file is unavailable: {Path(str(name)).name}")
        require(DATASET.sha256_file(path) == item.get("sha256") and path.stat().st_size == item.get("sizeBytes"), f"v0.5.7 frozen file differs: {path.name}")
    register_path = frozen_dir / "register.private.json"
    audit_path = frozen_dir / "dataset-audit.private.json"
    recipe_path = frozen_dir / "training-recipe.private.json"
    semantic_path = frozen_dir / "semantic-report.private.json"
    tokenization_path = frozen_dir / "tokenization-report.private.json"
    unique_path = frozen_dir / "continuation-unique-train.private.jsonl"
    weighted_path = frozen_dir / "weighted-continuation-train.private.jsonl"
    new_path = frozen_dir / "v057-mitigation-train.private.jsonl"
    bindings = manifest.get("bindings", {})
    for field, path in (
        ("registerSha256", register_path), ("datasetAuditSha256", audit_path),
        ("trainingRecipeSha256", recipe_path), ("semanticReportSha256", semantic_path),
        ("tokenizationReportSha256", tokenization_path), ("uniqueTrainSha256", unique_path),
        ("weightedTrainSha256", weighted_path), ("newMitigationTrainSha256", new_path),
    ):
        require(bindings.get(field) == DATASET.sha256_file(path), f"v0.5.7 manifest binding differs: {field}")
    register = DATASET.read_json(register_path); audit = DATASET.read_json(audit_path)
    recipe = DATASET.read_json(recipe_path); semantic = DATASET.read_json(semantic_path)
    tokenization = DATASET.read_json(tokenization_path)
    require(register.get("schema") == "com.saferide.ai.v057-mitigation-register" and register.get("status") == "experimental-one-targeted-continuation-ready-promotion-blocked", "v0.5.7 register differs.")
    require(register.get("initialAdapter", {}).get("tensorSha256") == EXPECTED_ADAPTER_SHA256, "v0.5.7 initial adapter binding differs.")
    require(audit.get("status") == "passed" and semantic.get("status") == "passed" and tokenization.get("status") == "passed", "v0.5.7 dataset, semantic, or tokenizer gate failed.")
    require(tokenization.get("truncatedRowCount") == 0 and tokenization.get("assistantOnlyLabels") is True, "v0.5.7 tokenizer or label gate failed.")
    require(manifest.get("semanticGate") == {"status": "passed", "threshold": 0.92, "flaggedPairCount": 0}, "v0.5.7 semantic summary differs.")
    require(manifest.get("privacy", {}).get("sealedMitigationHoldoutRead") is False and register.get("protectedEvaluationAllowed") is False, "v0.5.7 protected-data boundary differs.")
    unique_rows = DATASET.read_jsonl(unique_path); weighted_rows = DATASET.read_jsonl(weighted_path); new_rows = DATASET.read_jsonl(new_path)
    require(len(unique_rows) == 72 and len({row.get("id") for row in unique_rows}) == 72 and len(weighted_rows) == 104 and len(new_rows) == 16, "v0.5.7 row inventory differs.")
    counts = collections.Counter(str(row.get("id")) for row in weighted_rows)
    new_ids = {str(row.get("id")) for row in new_rows}
    require(len(counts) == 72 and all(counts[row_id] == 3 for row_id in new_ids) and all(count == 1 for row_id, count in counts.items() if row_id not in new_ids), "v0.5.7 weighting differs.")
    input_order = [str(row.get("id")) for row in weighted_rows]
    require(recipe.get("inputOrder") == input_order and recipe.get("inputOrderSha256") == DATASET.sha256_text("\n".join(input_order)), "v0.5.7 input order differs.")
    effective = list(input_order); random.Random(419805).shuffle(effective)
    require(recipe.get("sampleOrder") == effective and recipe.get("sampleOrderSha256") == DATASET.sha256_text("\n".join(effective)), "v0.5.7 effective order differs.")
    require(recipe.get("learningRate") == 5e-6 and recipe.get("expectedOptimizerSteps") == 13 and recipe.get("weightedTrainingExamples") == 104, "v0.5.7 recipe differs.")
    require(recipe.get("assistantOnlyLoss") is True and recipe.get("retryAllowed") is False and recipe.get("promotionEligible") is False, "v0.5.7 training boundary differs.")
    require(DATASET.sha256_file(dev_data) == EXPECTED_DEV_SHA256 and len(DATASET.read_jsonl(dev_data)) == 300, "Frozen original development suite differs.")
    return {
        "status": "passed", "manifestSha256": DATASET.sha256_file(manifest_path),
        "weightedTrainSha256": DATASET.sha256_file(weighted_path),
        "sampleOrderSha256": recipe["sampleOrderSha256"], "uniqueRows": 72,
        "weightedExamples": 104, "optimizerSteps": 13, "developmentRows": 300,
        "assistantOnlyLoss": True, "sealedHoldoutRowsRead": 0,
    }


def contract_check() -> int:
    plan = DATASET.validate_plan()
    require(plan["trainingHypothesis"]["initialAdapterTensorSha256"] == EXPECTED_ADAPTER_SHA256, "v0.5.7 adapter contract differs.")
    print("SafeRide v0.5.7 training contracts PASS (one 13-step adapter continuation only).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--frozen-dir", required=True)
    verify_parser.add_argument("--dev-data", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        args = parse_args()
        if args.command == "contract-check":
            raise SystemExit(contract_check())
        result = verify(Path(args.frozen_dir), Path(args.dev_data))
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SafeRide v0.5.7 training blocked: {error}", file=sys.stderr)
        raise SystemExit(1)
