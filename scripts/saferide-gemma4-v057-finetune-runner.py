#!/usr/bin/env python3
"""Run exactly one hash-bound v0.5.7 continuation from the v0.5.6 adapter."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[1]
BASE_PATH = SCRIPT_PATH.with_name("saferide-gemma4-finetune-runner.py")
TRAINING_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-training.py")
REMEDIATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-remediation.py")
REQUIREMENTS_PATH = REPO_ROOT / "requirements-ai-smoke.txt"
CONSTRAINTS_PATH = REPO_ROOT / "constraints-ai-training.txt"
EXPECTED_INITIAL_TENSOR_SHA256 = "6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4"
EXPECTED_INITIAL_TENSOR_SIZE = 48376416
RUN_ID_PATTERN = re.compile(r"saferide-v057-pilot-s419805-[a-z0-9-]+")
EXPECTED_ADAPTER_FILES = (
    "README.md",
    "adapter_config.json",
    "adapter_model.safetensors",
    "chat_template.jinja",
    "tokenizer.json",
    "tokenizer_config.json",
)
EXPECTED_INHERITED_NAMESPACE_FIELDS = (
    "register", "data", "train_data", "dev_data", "audit", "dataset_manifest",
    "artifact_root", "pilot_row_manifest", "run_id", "paired_run_id",
    "lora_rank_approval_ref", "output_root", "constraints", "base_model_id",
    "base_model_path", "base_revision", "checkpoint_root", "dry_run", "tiny_smoke",
    "allow_base_download", "approved_local_cpu_risk", "run_kind", "seed", "epochs",
    "max_steps", "max_seq_length", "train_batch_size", "eval_batch_size",
    "gradient_accumulation_steps", "max_grad_norm", "warmup_ratio",
    "lr_scheduler_type", "logging_steps", "eval_steps", "save_steps",
    "early_stopping_patience", "learning_rate", "lora_r", "lora_alpha", "lora_dropout",
)


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required training implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load_module(BASE_PATH, "saferide_v057_finetune_base")
TRAINING = load_module(TRAINING_PATH, "saferide_v057_finetune_gate")
REMEDIATION = load_module(REMEDIATION_PATH, "saferide_v057_finetune_remediation")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def tree_inventory(root: Path) -> dict[str, Any]:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            files.append({"path": path.relative_to(root).as_posix(), "sha256": sha256_file(path), "sizeBytes": path.stat().st_size})
    require(files, "Initial adapter inventory is empty.")
    return {"sha256": canonical_sha256(files), "fileCount": len(files), "sizeBytes": sum(item["sizeBytes"] for item in files), "files": files}


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    path.chmod(0o600)


def inherited_namespace_defaults() -> dict[str, Any]:
    """Obtain the inherited parser's full namespace without consuming wrapper CLI args."""
    original_argv = sys.argv
    try:
        sys.argv = [str(BASE_PATH)]
        defaults = vars(BASE.parse_args())
    finally:
        sys.argv = original_argv
    require(tuple(defaults) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Inherited runner namespace contract changed.")
    return defaults


def build_inherited_runner_args(
    args: argparse.Namespace,
    *,
    model: Path,
    output_root: Path,
    checkpoint_root: Path,
    weighted: Path,
    dev: Path,
    register: Path,
    audit: Path,
    manifest: Path,
    frozen: Path,
    recipe_path: Path,
) -> argparse.Namespace:
    values = inherited_namespace_defaults()
    values.update({
        "register": str(register), "data": None, "train_data": str(weighted),
        "dev_data": str(dev), "audit": str(audit), "dataset_manifest": str(manifest),
        "artifact_root": str(frozen), "pilot_row_manifest": str(recipe_path),
        "run_id": args.run_id, "paired_run_id": None, "lora_rank_approval_ref": None,
        "output_root": str(output_root), "constraints": str(CONSTRAINTS_PATH),
        "base_model_id": "google/gemma-4-E2B-it", "base_model_path": str(model),
        "base_revision": "70af34e20bd4b7a91f0de6b22675850c43922a03",
        "checkpoint_root": str(checkpoint_root), "dry_run": False, "tiny_smoke": False,
        "allow_base_download": False, "approved_local_cpu_risk": False,
        "run_kind": "pilot", "seed": 419805, "epochs": 1.0, "max_steps": None,
        "max_seq_length": 1024, "train_batch_size": 1, "eval_batch_size": 1,
        "gradient_accumulation_steps": 8, "max_grad_norm": 1.0,
        "warmup_ratio": 0.03, "lr_scheduler_type": "cosine", "logging_steps": 1,
        "eval_steps": 13, "save_steps": 13, "early_stopping_patience": 3,
        "learning_rate": 5e-6, "lora_r": 8, "lora_alpha": 16, "lora_dropout": 0.05,
    })
    namespace = argparse.Namespace(**values)
    require(tuple(vars(namespace)) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Inherited runner namespace is incomplete.")
    require(BASE.resolve_run_kind(namespace) == "pilot", "Inherited runner did not resolve the continuation as a pilot.")
    return namespace


def sanitized_failure_message(error: Exception, roots: list[Path]) -> str:
    message = BASE.sanitized_error_message(error)
    for root in sorted((str(path.resolve()) for path in roots), key=len, reverse=True):
        message = message.replace(root, "<private-path>")
    message = re.sub(r"(?<![A-Za-z0-9])/(?:[^\s:]+/)+[^\s:]*", "<private-path>", message)
    return re.sub(r"\s+", " ", message).strip()[:500]


def validate_and_sanitize_completed_outputs(outputs: dict[str, Any], recipe: dict[str, Any]) -> dict[str, Any]:
    require(
        outputs.get("runKind") == "pilot"
        and outputs.get("globalSteps") == 13
        and outputs.get("rowsSeen") == 104
        and outputs.get("epochsCompleted", 0) >= 0.999,
        "v0.5.7 continuation coverage differs.",
    )
    require(
        outputs.get("sampleOrder") == recipe.get("sampleOrder")
        and outputs.get("sampleOrderSha256") == recipe.get("sampleOrderSha256"),
        "v0.5.7 effective sample order differs.",
    )
    require(
        outputs.get("holdoutRowsRead") == 0 and outputs.get("lossMaskPolicy") == "assistant-turns-only",
        "v0.5.7 holdout or loss-mask boundary differs.",
    )
    tensor = outputs.get("adapterTensorValidation", {})
    require(
        tensor.get("nonFiniteTensorCount") == 0
        and tensor.get("tensorCount") == 410
        and tensor.get("elementCount") == 12079104,
        "v0.5.7 output adapter integrity differs.",
    )
    loss = outputs.get("lossReport", {})
    require(
        loss.get("finite") is True
        and all(math.isfinite(float(loss.get(field, math.nan))) for field in (
            "meanTrainingObjectiveLoss", "bestDevelopmentLoss", "finalDevelopmentLoss",
        )),
        "v0.5.7 loss evidence is non-finite.",
    )
    adapter_files = []
    seen_names = set()
    for item in outputs.get("adapterFiles", []):
        name = Path(str(item.get("path", ""))).name
        require(name not in seen_names, "v0.5.7 adapter inventory contains duplicate names.")
        require(
            name in EXPECTED_ADAPTER_FILES
            and re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))) is not None
            and isinstance(item.get("sizeBytes"), int)
            and item["sizeBytes"] > 0,
            "v0.5.7 adapter inventory is incomplete or malformed.",
        )
        seen_names.add(name)
        adapter_files.append({"path": name, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
    require(tuple(sorted(seen_names)) == tuple(sorted(EXPECTED_ADAPTER_FILES)), "v0.5.7 requires the exact six-file adapter inventory.")
    checkpoints = outputs.get("checkpoints", [])
    require(
        len(checkpoints) == 1
        and Path(str(checkpoints[0].get("path", ""))).name == "checkpoint-13"
        and checkpoints[0].get("fileCount") == 11
        and re.fullmatch(r"[a-f0-9]{64}", str(checkpoints[0].get("manifestSha256", ""))) is not None,
        "v0.5.7 checkpoint-13 inventory differs.",
    )
    outputs["adapterFiles"] = sorted(adapter_files, key=lambda item: item["path"])
    outputs["adapterDir"] = "adapter"
    outputs["bestCheckpoint"] = "checkpoint-13"
    outputs["checkpointRoot"] = "checkpoints"
    outputs["checkpoints"] = [{**checkpoints[0], "path": "checkpoint-13"}]
    outputs["adapterInventorySha256"] = canonical_sha256(outputs["adapterFiles"])
    outputs["adapterInventoryFileCount"] = len(outputs["adapterFiles"])
    outputs["adapterInventorySizeBytes"] = sum(item["sizeBytes"] for item in outputs["adapterFiles"])
    outputs["checkpointInventorySha256"] = canonical_sha256(outputs["checkpoints"])
    outputs["metadataPathsSanitized"] = True
    return outputs


def initial_adapter_evidence(root: Path) -> dict[str, Any]:
    root = root.resolve()
    tensor = root / "adapter_model.safetensors"; config_path = root / "adapter_config.json"
    require(root.is_dir() and tensor.is_file() and config_path.is_file(), "Initial v0.5.6 adapter is incomplete.")
    require(not tensor.is_symlink() and not config_path.is_symlink(), "Initial v0.5.6 adapter may not use symlinks.")
    require(sha256_file(tensor) == EXPECTED_INITIAL_TENSOR_SHA256 and tensor.stat().st_size == EXPECTED_INITIAL_TENSOR_SIZE, "Initial v0.5.6 adapter tensor differs.")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    targets = config.get("target_modules")
    require(config.get("r") == 8 and config.get("lora_alpha") == 16 and abs(float(config.get("lora_dropout", 0)) - 0.05) <= 1e-12, "Initial v0.5.6 LoRA configuration differs.")
    require(isinstance(targets, list) and len(targets) == 205, "Initial v0.5.6 target-module inventory differs.")
    inventory = tree_inventory(root)
    return {
        "tensorSha256": EXPECTED_INITIAL_TENSOR_SHA256, "tensorSizeBytes": EXPECTED_INITIAL_TENSOR_SIZE,
        "configSha256": sha256_file(config_path), "targetModuleCount": 205,
        "inventorySha256": inventory["sha256"], "inventoryFileCount": inventory["fileCount"],
        "inventorySizeBytes": inventory["sizeBytes"],
    }


def patched_training_dependencies(initial_adapter: Path, expected_targets: set[str]):
    original = BASE.import_training_deps

    def load_dependencies():
        deps = original()
        from peft import PeftModel  # type: ignore

        def load_existing_adapter(model: Any, lora_config: Any) -> Any:
            configured = set(getattr(lora_config, "target_modules", []) or [])
            require(configured == expected_targets, "Continuation target modules differ from the initial adapter.")
            loaded = PeftModel.from_pretrained(model, str(initial_adapter), is_trainable=True, local_files_only=True)
            trainable = sum(parameter.numel() for parameter in loaded.parameters() if parameter.requires_grad)
            require(trainable == 12079104, "Continuation trainable parameter count differs.")
            return loaded

        deps["get_peft_model"] = load_existing_adapter
        return deps

    return load_dependencies


def run(args: argparse.Namespace) -> int:
    os.umask(0o077)
    require(RUN_ID_PATTERN.fullmatch(args.run_id) is not None, "v0.5.7 run id is unsafe.")
    frozen = Path(args.frozen_dir).expanduser().resolve(); dev = Path(args.dev_data).expanduser().resolve()
    initial_adapter = Path(args.initial_adapter).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve(); output_root = Path(args.output_root).expanduser().resolve()
    checkpoint_root = Path(args.checkpoint_root).expanduser().resolve()
    require(model.is_dir(), "Pinned base model is unavailable.")
    require(output_root.is_dir() and not any(output_root.iterdir()), "Model output root must be a new empty private directory.")
    require(checkpoint_root.is_dir() and not any(checkpoint_root.iterdir()), "Checkpoint root must be a new empty private directory.")
    gate = TRAINING.verify(frozen, dev)
    adapter_source = initial_adapter_evidence(initial_adapter)
    config = json.loads((initial_adapter / "adapter_config.json").read_text(encoding="utf-8"))
    expected_targets = set(config["target_modules"])
    recipe_path = frozen / "training-recipe.private.json"
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    weighted = frozen / "weighted-continuation-train.private.jsonl"
    register = frozen / "register.private.json"; audit = frozen / "dataset-audit.private.json"
    manifest = frozen / "frozen-manifest.private.json"
    train_rows = BASE.parse_jsonl(weighted); dev_rows = BASE.parse_jsonl(dev)
    require(len(train_rows) == 104 and len(dev_rows) == 300, "v0.5.7 runner row counts differ.")
    run_dir = output_root / args.run_id
    run_dir.mkdir(mode=0o700)
    metadata_path = run_dir / "metadata.json"
    metadata: dict[str, Any] = {
        "schema": "com.saferide.ai.v057-pilot-run", "schemaVersion": 1,
        "issue": "ESH-4198", "status": "running", "runId": args.run_id,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "datasetId": "saferide-synthetic-guidance-v0.5.7",
        "bindings": {
            "registerSha256": sha256_file(register), "auditSha256": sha256_file(audit),
            "frozenManifestSha256": sha256_file(manifest), "weightedTrainSha256": sha256_file(weighted),
            "developmentSha256": sha256_file(dev), "sampleOrderSha256": recipe["sampleOrderSha256"],
            "initialAdapterTensorSha256": adapter_source["tensorSha256"],
            "initialAdapterInventorySha256": adapter_source["inventorySha256"],
            "requirementsSha256": sha256_file(REQUIREMENTS_PATH),
            "constraintsSha256": sha256_file(CONSTRAINTS_PATH),
        },
        "recipe": {
            "initialization": "immutable-v0.5.6-adapter", "seed": 419805, "epochs": 1,
            "learningRate": 5e-6, "scheduler": "cosine", "warmupRatio": 0.03,
            "trainBatchSize": 1, "evaluationBatchSize": 1, "gradientAccumulationSteps": 8,
            "effectiveBatchSize": 8, "maximumGradientNorm": 1.0, "loggingSteps": 1,
            "evaluationSteps": 13, "saveSteps": 13, "maximumSequenceLength": 1024,
            "loraRank": 8, "loraAlpha": 16, "loraDropout": 0.05, "loraTargetModuleCount": 205,
            "v054Multiplier": 1, "v056Multiplier": 1, "v057Multiplier": 3,
            "weightedExamples": 104, "expectedSteps": 13, "assistantOnlyLoss": True,
        },
        "inputGate": gate, "initialAdapter": adapter_source,
        "inheritedRunner": {
            "requiredFieldCount": len(EXPECTED_INHERITED_NAMESPACE_FIELDS),
            "requiredFieldsSha256": canonical_sha256(list(EXPECTED_INHERITED_NAMESPACE_FIELDS)),
            "runKind": "pilot", "modelCardPathPreflightPassed": False,
        },
        "privacy": {"sealedHoldoutRowsRead": 0, "rawContentLogged": False, "metadataOnly": True},
        "promotionEligible": False, "retryAllowed": False, "outputs": {}, "failure": None,
    }
    write_private_json(metadata_path, metadata)
    base_args = build_inherited_runner_args(
        args, model=model, output_root=output_root, checkpoint_root=checkpoint_root,
        weighted=weighted, dev=dev, register=register, audit=audit, manifest=manifest,
        frozen=frozen, recipe_path=recipe_path,
    )
    original_loader = BASE.import_training_deps
    BASE.import_training_deps = patched_training_dependencies(initial_adapter, expected_targets)
    try:
        model_card = BASE.model_card_text(base_args, base_args.base_model_id)
        require("| Run kind | `pilot` |" in model_card, "Inherited model-card path did not bind the pilot run kind.")
        metadata["inheritedRunner"]["modelCardPathPreflightPassed"] = True
        write_private_json(metadata_path, metadata)
        BASE.verify_installed_training_lock(BASE.load_training_lock(REQUIREMENTS_PATH, CONSTRAINTS_PATH))
        outputs = BASE.run_training(base_args, run_dir, train_rows + dev_rows, "pilot", dataset_profile="v04")
        loss = REMEDIATION.build_loss_report(
            train_metrics=outputs["trainMetrics"], log_history=outputs["logHistory"],
            gradient_accumulation_steps=8, resumed_from_step=None, recorded_best_metric=outputs["bestMetric"],
        )
        outputs["lossReport"] = loss
        outputs = validate_and_sanitize_completed_outputs(outputs, recipe)
        require(sha256_file(initial_adapter / "adapter_model.safetensors") == EXPECTED_INITIAL_TENSOR_SHA256, "Initial adapter changed during continuation.")
        outputs["initialAdapter"] = adapter_source
        metadata["outputs"] = outputs; metadata["status"] = "completed"
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_private_json(metadata_path, metadata)
    except Exception as error:
        metadata["status"] = "blocked"
        metadata["failure"] = {
            "phase": "one-targeted-continuation", "errorType": type(error).__name__,
            "message": sanitized_failure_message(error, [frozen, dev, initial_adapter, model, output_root, checkpoint_root]),
        }
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_private_json(metadata_path, metadata)
        raise RuntimeError(metadata["failure"]["message"]) from error
    finally:
        BASE.import_training_deps = original_loader
    print("SafeRide v0.5.7 one targeted continuation PASS (promotion false; retry false).")
    return 0


def contract_check() -> int:
    REMEDIATION.contract_check()
    require(EXPECTED_INITIAL_TENSOR_SIZE == 48376416 and RUN_ID_PATTERN.fullmatch("saferide-v057-pilot-s419805-contract"), "v0.5.7 continuation constants differ.")
    defaults = inherited_namespace_defaults()
    require(set(defaults) == set(EXPECTED_INHERITED_NAMESPACE_FIELDS) and len(EXPECTED_ADAPTER_FILES) == 6, "v0.5.7 inherited namespace or adapter inventory contract differs.")
    print("SafeRide v0.5.7 continuation runner contract PASS (complete inherited namespace; six-file adapter).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    launch = sub.add_parser("run")
    launch.add_argument("--frozen-dir", required=True); launch.add_argument("--dev-data", required=True)
    launch.add_argument("--initial-adapter", required=True); launch.add_argument("--base-model-path", required=True)
    launch.add_argument("--output-root", required=True); launch.add_argument("--checkpoint-root", required=True)
    launch.add_argument("--run-id", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        raise SystemExit(contract_check() if parsed.command == "contract-check" else run(parsed))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SafeRide v0.5.7 continuation blocked: {re.sub(r'\s+', ' ', str(error))[:500]}", file=sys.stderr)
        raise SystemExit(1)
