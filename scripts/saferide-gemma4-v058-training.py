#!/usr/bin/env python3
"""Fail-closed training-input validator for v0.5.8 full candidates."""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import random
import stat
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
DATASET_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-dataset.py")
EXPECTED_DEV_SHA256 = "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"
EXPECTED_UNIQUE_ROWS = 1904
EXPECTED_WEIGHTED_EXAMPLES = 1992
EXPECTED_OPTIMIZER_STEPS = 249


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DATASET = load_module(DATASET_PATH, "saferide_v058_training_dataset")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def verify(frozen_root: Path, dev_data: Path, seed: int) -> dict[str, Any]:
    frozen_root = frozen_root.expanduser().resolve()
    dev_data = dev_data.expanduser().resolve()
    package = frozen_root / "package"
    package_result = DATASET.verify_root(frozen_root)
    require(seed in {419805, 419806}, "v0.5.8 candidate seed is not authorized.")
    require(dev_data.is_file() and not dev_data.is_symlink(), "Frozen original-development suite is unavailable.")
    require(stat.S_IMODE(dev_data.stat().st_mode) in {0o400, 0o600}, "Original-development suite permissions differ.")
    require(DATASET.sha256_file(dev_data) == EXPECTED_DEV_SHA256, "Frozen original-development bytes differ.")

    unique_rows = DATASET.read_jsonl(package / "combined-unique-train.private.jsonl")
    weighted_rows = DATASET.read_jsonl(package / "weighted-train.private.jsonl")
    dev_rows = DATASET.read_jsonl(dev_data)
    require(len(unique_rows) == EXPECTED_UNIQUE_ROWS, "v0.5.8 unique training count differs.")
    require(len(weighted_rows) == EXPECTED_WEIGHTED_EXAMPLES, "v0.5.8 weighted training count differs.")
    require(len(dev_rows) == 300 and all(row.get("split") == "dev" for row in dev_rows), "Original-development suite contract differs.")
    require(all(row.get("split") == "train" for row in unique_rows + weighted_rows), "Training package contains a non-training split.")
    unique_ids = [str(row.get("id", "")) for row in unique_rows]
    weighted_ids = [str(row.get("id", "")) for row in weighted_rows]
    require(len(set(unique_ids)) == EXPECTED_UNIQUE_ROWS and set(weighted_ids) == set(unique_ids), "v0.5.8 stable row inventory differs.")
    multiplicities = collections.Counter(collections.Counter(weighted_ids).values())
    require(multiplicities == {1: 1832, 2: 56, 3: 16}, "v0.5.8 controlled weighting multiplicities differ.")

    recipe = DATASET.read_json(package / "training-recipe.private.json")
    require(
        recipe.get("runKind") == "candidate"
        and recipe.get("seeds") == [419805, 419806]
        and recipe.get("epochs") == 1
        and recipe.get("learningRate") == 2e-5
        and recipe.get("maxSteps") is None
        and recipe.get("maximumSequenceLength") == 1024
        and recipe.get("rejectTruncation") is True
        and recipe.get("trainBatchSize") == 1
        and recipe.get("gradientAccumulationSteps") == 8
        and recipe.get("precision") == "bf16"
        and recipe.get("gradientCheckpointing") is True
        and recipe.get("assistantOnlyLoss") is True
        and recipe.get("scheduler") == "cosine"
        and recipe.get("warmupRatio") == 0.03
        and recipe.get("maximumGradientNorm") == 1.0
        and recipe.get("loggingSteps") == 5
        and recipe.get("evaluationSteps") == 25
        and recipe.get("saveSteps") == 25
        and recipe.get("earlyStoppingPatience") == 3
        and recipe.get("lora") == {"rank": 8, "alpha": 16, "dropout": 0.05}
        and recipe.get("weightedExamples") == EXPECTED_WEIGHTED_EXAMPLES
        and recipe.get("expectedOptimizerSteps") == EXPECTED_OPTIMIZER_STEPS,
        "v0.5.8 full-candidate recipe differs.",
    )
    order_contract = DATASET.read_json(package / "sample-order-contract.private.json")
    declared = {item.get("seed"): item for item in order_contract.get("candidateOrders", [])}
    require(set(declared) == {419805, 419806}, "v0.5.8 sample-order seed inventory differs.")
    replay = list(weighted_rows)
    random.Random(seed).shuffle(replay)
    sample_hash = DATASET.sha256_bytes("\n".join(str(row["id"]) for row in replay).encode("utf-8"))
    require(declared[seed].get("rowIdentityOrderSha256") == sample_hash, "v0.5.8 candidate sample order differs.")
    require(DATASET.read_json(package / "tokenization-report.private.json").get("truncatedRows") == 0, "v0.5.8 no-truncation gate differs.")
    return {
        "status": "passed",
        "seed": seed,
        "uniqueRows": EXPECTED_UNIQUE_ROWS,
        "weightedExamples": EXPECTED_WEIGHTED_EXAMPLES,
        "optimizerSteps": EXPECTED_OPTIMIZER_STEPS,
        "developmentRows": 300,
        "sampleOrderSha256": sample_hash,
        "frozenManifestSha256": package_result["frozenManifestSha256"],
        "inputManifestSha256": package_result["inputManifestSha256"],
        "developmentSha256": EXPECTED_DEV_SHA256,
        "holdoutRowsRead": 0,
    }


def contract_check() -> int:
    DATASET.contract_check()
    require((EXPECTED_WEIGHTED_EXAMPLES + 7) // 8 == EXPECTED_OPTIMIZER_STEPS, "v0.5.8 optimizer-step contract differs.")
    print("SafeRide v0.5.8 training contract PASS (candidate-only; 1,904/1,992/249).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    check = sub.add_parser("verify")
    check.add_argument("--frozen-root", required=True)
    check.add_argument("--dev-data", required=True)
    check.add_argument("--seed", required=True, type=int)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check())
        print(json.dumps(verify(Path(parsed.frozen_root), Path(parsed.dev_data), parsed.seed), sort_keys=True, separators=(",", ":")))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SafeRide v0.5.8 training blocked: {str(error).replace(chr(10), ' ')[:500]}", file=sys.stderr)
        raise SystemExit(1)
