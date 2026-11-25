#!/usr/bin/env python3
"""Freeze and run one minimal v0.5.8 Kiswahili continuation from seed 419806."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import random
import re
import stat
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[1]
BASE_PATH = SCRIPT_PATH.with_name("saferide-gemma4-finetune-runner.py")
V058_RUNNER_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-finetune-runner.py")
REMEDIATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-remediation.py")
REQUIREMENTS_PATH = REPO_ROOT / "requirements-ai-smoke.txt"
CONSTRAINTS_PATH = REPO_ROOT / "constraints-ai-training.txt"

PLAN_SCHEMA = "com.saferide.ai.v058-kiswahili-continuation-plan"
PACKAGE_SCHEMA = "com.saferide.ai.v058-kiswahili-continuation-package"
RUN_SCHEMA = "com.saferide.ai.v058-kiswahili-continuation-run"
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
FROZEN_MANIFEST_SHA256 = "0ad58d367f1ef1b6e46d57a741aef75f573734d024f9e4dc9318bbda281df272"
COMBINED_TRAIN_SHA256 = "669835b5f680b2198cf06d8c23a02d2e9aba2acba816c6283a0cdbbf8586a15e"
ORIGINAL_DEVELOPMENT_SHA256 = "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"
MITIGATION_DEVELOPMENT_SHA256 = "55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd"
INITIAL_METADATA_SHA256 = "5334c8f274570bf18743b76869c90adfcbfb62c9bffaf90d5adf87a5712ef823"
INITIAL_ADAPTER_INVENTORY_SHA256 = "37987476374abb7a2f1cbc8158067bd5a0a9e43b495ac076a1378d30a4e22b72"
INITIAL_ADAPTER_TENSOR_SHA256 = "1f8631d41dd3e16a62b1a95a7676c7585655ea97d100719ce0908902fb9e80aa"
INITIAL_ADAPTER_CONFIG_SHA256 = "574ba8ba8a6f8173ee1d660796d31eaf45d172e3d3b6affd650f94e0e40a1e3c"
INITIAL_ADAPTER_TENSOR_SIZE = 48_376_416
SEED = 419806
SELECTED_ROWS = 32
MAXIMUM_ASSISTANT_TOKENS = 96
LEARNING_RATE = 5e-6
OPTIMIZER_STEPS = 4
RUN_KIND = "continuation"
RUN_ID_PATTERN = re.compile(r"saferide-v058-kiswahili-s419806-[a-z0-9-]+")
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
        raise RuntimeError(f"Required implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load_module(BASE_PATH, "saferide_v058_kiswahili_base")
V058 = load_module(V058_RUNNER_PATH, "saferide_v058_kiswahili_runner")
REMEDIATION = load_module(REMEDIATION_PATH, "saferide_v058_kiswahili_remediation")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Required JSON differs: {path.name}")
    return value


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    values = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                value = json.loads(line)
                require(isinstance(value, dict), f"Required JSONL differs: {path.name}")
                values.append(value)
    return values


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    path.chmod(0o600)


def write_private_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for value in values:
            handle.write(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
    path.chmod(0o600)


def private_directory(path: Path, label: str, *, empty: bool = False) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, f"{label} must be mode 0700.")
    if empty:
        require(not any(path.iterdir()), f"{label} must be newly empty.")


def plan_gate(plan_path: Path) -> dict[str, Any]:
    plan = read_json(plan_path)
    require(
        plan.get("schema") == PLAN_SCHEMA
        and plan.get("status") == "authorized-single-low-lr-continuation"
        and plan.get("issue") == "ESH-4198",
        "Kiswahili continuation plan identity differs.",
    )
    diagnosis = plan.get("diagnosis", {})
    require(
        diagnosis.get("classification") == "genuine-token-cap-cutoff"
        and diagnosis.get("sameFrozenRowAcrossCandidates") is True
        and diagnosis.get("evaluatorDefectFound") is False,
        "Cutoff diagnosis does not authorize continuation.",
    )
    initial = plan.get("initialCandidate", {})
    require(
        initial.get("seed") == SEED
        and initial.get("provisionalWinner") is True
        and initial.get("metadataSha256") == INITIAL_METADATA_SHA256
        and initial.get("adapterInventorySha256") == INITIAL_ADAPTER_INVENTORY_SHA256
        and initial.get("adapterTensorSha256") == INITIAL_ADAPTER_TENSOR_SHA256,
        "Initial 419806 candidate binding differs.",
    )
    recipe = plan.get("recipe", {})
    require(
        recipe.get("seed") == SEED
        and recipe.get("learningRate") == LEARNING_RATE
        and recipe.get("epochs") == 1
        and recipe.get("selectedTrainingRows") == SELECTED_ROWS
        and recipe.get("maximumAssistantTokens") == MAXIMUM_ASSISTANT_TOKENS
        and recipe.get("expectedOptimizerSteps") == OPTIMIZER_STEPS
        and recipe.get("gradientAccumulationSteps") == 8
        and recipe.get("assistantOnlyLoss") is True,
        "Minimal continuation recipe differs.",
    )
    bindings = plan.get("codeBindings", {})
    require(
        bindings.get("continuationSha256") == sha256_file(SCRIPT_PATH),
        "Continuation implementation binding differs.",
    )
    return plan


def adapter_inventory(root: Path) -> tuple[list[dict[str, Any]], str]:
    private_directory(root, "Initial adapter root")
    files = [
        {"path": path.name, "sha256": sha256_file(path), "sizeBytes": path.stat().st_size}
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]
    require(
        tuple(item["path"] for item in files) == EXPECTED_ADAPTER_FILES,
        "Initial adapter six-file inventory differs.",
    )
    return files, canonical_sha256(files)


def initial_candidate_gate(metadata_path: Path, adapter_root: Path) -> dict[str, Any]:
    require(metadata_path.is_file() and not metadata_path.is_symlink(), "Initial candidate metadata is unavailable.")
    require(sha256_file(metadata_path) == INITIAL_METADATA_SHA256, "Initial candidate metadata bytes differ.")
    metadata = read_json(metadata_path)
    require(
        metadata.get("schema") == "com.saferide.ai.v058-candidate-run"
        and metadata.get("status") == "completed"
        and metadata.get("seed") == SEED
        and metadata.get("candidateAuthorizationConsumed") is True
        and metadata.get("optimizerStepsCompleted") == 249
        and metadata.get("outputs", {}).get("holdoutRowsRead") == 0,
        "Initial candidate completion evidence differs.",
    )
    files, inventory_sha = adapter_inventory(adapter_root)
    require(inventory_sha == INITIAL_ADAPTER_INVENTORY_SHA256, "Initial adapter inventory hash differs.")
    by_name = {item["path"]: item for item in files}
    require(
        by_name["adapter_model.safetensors"]["sha256"] == INITIAL_ADAPTER_TENSOR_SHA256
        and by_name["adapter_model.safetensors"]["sizeBytes"] == INITIAL_ADAPTER_TENSOR_SIZE
        and by_name["adapter_config.json"]["sha256"] == INITIAL_ADAPTER_CONFIG_SHA256,
        "Initial adapter tensor or configuration differs.",
    )
    declared = sorted(metadata["outputs"].get("adapterFiles", []), key=lambda item: item.get("path", ""))
    require(files == declared, "Initial adapter inventory does not match candidate metadata.")
    return {
        "metadataSha256": INITIAL_METADATA_SHA256,
        "adapterInventorySha256": inventory_sha,
        "adapterTensorSha256": INITIAL_ADAPTER_TENSOR_SHA256,
        "adapterConfigSha256": INITIAL_ADAPTER_CONFIG_SHA256,
    }


def source_paths(frozen_root: Path) -> tuple[Path, Path]:
    package = frozen_root / "package"
    manifest = package / "frozen-manifest.private.json"
    combined = package / "combined-unique-train.private.jsonl"
    private_directory(frozen_root, "Frozen v0.5.8 root")
    private_directory(package, "Frozen v0.5.8 package")
    require(
        sha256_file(manifest) == FROZEN_MANIFEST_SHA256
        and sha256_file(combined) == COMBINED_TRAIN_SHA256,
        "Frozen v0.5.8 source bytes differ.",
    )
    return manifest, combined


def selected_rows(combined: Path, model_root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    require(model_root.is_dir() and not model_root.is_symlink(), "Pinned model root is unavailable.")
    tokenizer_path = model_root / "tokenizer.json"
    require(
        tokenizer_path.is_file()
        and sha256_file(tokenizer_path) == V058.DATASET.TOKENIZER_JSON_SHA256,
        "Pinned tokenizer bytes differ.",
    )
    from transformers import AutoTokenizer  # type: ignore[import-not-found]

    tokenizer = AutoTokenizer.from_pretrained(str(model_root), local_files_only=True)
    rows = read_jsonl(combined)
    require(len(rows) == 1904, "Frozen v0.5.8 unique training row count differs.")
    selected: list[tuple[str, dict[str, Any], int, int]] = []
    for row in rows:
        metadata = row.get("metadata", {})
        if metadata.get("language") != "sw" or metadata.get("primaryCategory") != "tone":
            continue
        require(row.get("split") == "train", "Concise Kiswahili selection contains a non-training row.")
        assistant = "\n".join(
            str(item["content"]) for item in row["messages"] if item.get("role") == "assistant"
        )
        token_count = len(tokenizer.encode(assistant, add_special_tokens=False))
        if token_count <= MAXIMUM_ASSISTANT_TOKENS:
            selected.append((str(row["id"]), row, token_count, len(assistant.split())))
    selected.sort(key=lambda item: item[0])
    require(len(selected) == SELECTED_ROWS, "Concise Kiswahili selection count differs.")
    values = [item[1] for item in selected]
    require(len({str(row["id"]) for row in values}) == SELECTED_ROWS, "Continuation selection contains duplicates.")
    tokens = [item[2] for item in selected]
    words = [item[3] for item in selected]
    return values, {
        "rowCount": SELECTED_ROWS,
        "minimumAssistantTokens": min(tokens),
        "maximumAssistantTokens": max(tokens),
        "minimumAssistantWords": min(words),
        "maximumAssistantWords": max(words),
        "language": "sw",
        "primaryCategory": "tone",
        "split": "train",
    }


def prepare(args: argparse.Namespace) -> int:
    os.umask(0o077)
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    metadata_path = Path(args.initial_metadata).expanduser().resolve()
    adapter_root = Path(args.initial_adapter).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    private_directory(output_root, "Continuation package output", empty=True)
    plan = plan_gate(plan_path)
    initial = initial_candidate_gate(metadata_path, adapter_root)
    source_manifest, combined = source_paths(frozen_root)
    rows, selection = selected_rows(combined, model_root)
    train_path = output_root / "concise-kiswahili-train.private.jsonl"
    write_private_jsonl(train_path, rows)
    expected_order = list(rows)
    random.Random(SEED).shuffle(expected_order)
    order_sha = hashlib.sha256(
        "\n".join(str(row["id"]) for row in expected_order).encode()
    ).hexdigest()
    recipe = {
        "schema": "com.saferide.ai.v058-kiswahili-continuation-recipe",
        "schemaVersion": 1,
        "status": "frozen",
        "seed": SEED,
        "initialization": "immutable-v058-seed-419806-adapter",
        "learningRate": LEARNING_RATE,
        "epochs": 1,
        "selectedTrainingRows": SELECTED_ROWS,
        "expectedOptimizerSteps": OPTIMIZER_STEPS,
        "maximumSequenceLength": 1024,
        "rejectTruncation": True,
        "trainBatchSize": 1,
        "evaluationBatchSize": 1,
        "gradientAccumulationSteps": 8,
        "effectiveBatchSize": 8,
        "maximumGradientNorm": 1.0,
        "scheduler": "cosine",
        "warmupRatio": 0.03,
        "loggingSteps": 1,
        "evaluationSteps": OPTIMIZER_STEPS,
        "saveSteps": OPTIMIZER_STEPS,
        "earlyStoppingPatience": 3,
        "assistantOnlyLoss": True,
        "sampleOrderSha256": order_sha,
        "selection": selection,
    }
    recipe_path = output_root / "training-recipe.private.json"
    write_private_json(recipe_path, recipe)
    register_path = output_root / "register.private.json"
    audit_path = output_root / "dataset-audit.private.json"
    write_private_json(register_path, {
        "schema": "com.saferide.ai.v058-kiswahili-continuation-register",
        "schemaVersion": 1,
        "status": "frozen-for-one-continuation",
        "datasetId": "saferide-synthetic-guidance-v0.5.8-kiswahili-continuation",
        "promotionEligible": False,
    })
    write_private_json(audit_path, {
        "schema": "com.saferide.ai.v058-kiswahili-continuation-audit",
        "schemaVersion": 1,
        "status": "passed",
        "trainingRows": SELECTED_ROWS,
        "developmentRowsRead": 0,
        "holdoutRowsRead": 0,
        "rawContentIncluded": False,
    })
    package_manifest = {
        "schema": PACKAGE_SCHEMA,
        "schemaVersion": 1,
        "status": "frozen",
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "issue": "ESH-4198",
        "planSha256": sha256_file(plan_path),
        "source": {
            "v058FrozenManifestSha256": sha256_file(source_manifest),
            "v058CombinedTrainSha256": sha256_file(combined),
            "sourceUniqueRows": 1904,
            "selectedRows": SELECTED_ROWS,
        },
        "initialCandidate": initial,
        "recipeSha256": sha256_file(recipe_path),
        "trainSha256": sha256_file(train_path),
        "registerSha256": sha256_file(register_path),
        "auditSha256": sha256_file(audit_path),
        "sampleOrderSha256": order_sha,
        "privacy": {
            "developmentRowsRead": 0,
            "holdoutRowsRead": 0,
            "rawContentIncluded": False,
            "rowIdentifiersIncluded": False,
        },
        "promotionEligible": False,
        "selectionPerformed": False,
        "planStatus": plan["status"],
    }
    write_private_json(output_root / "package-manifest.private.json", package_manifest)
    print("SafeRide v0.5.8 concise-Kiswahili package PASS (32 train rows; dev 0; holdout 0).")
    return 0


def verify_package(root: Path, plan_path: Path) -> dict[str, Any]:
    private_directory(root, "Continuation package")
    manifest_path = root / "package-manifest.private.json"
    recipe_path = root / "training-recipe.private.json"
    train_path = root / "concise-kiswahili-train.private.jsonl"
    register_path = root / "register.private.json"
    audit_path = root / "dataset-audit.private.json"
    manifest = read_json(manifest_path)
    recipe = read_json(recipe_path)
    require(
        manifest.get("schema") == PACKAGE_SCHEMA
        and manifest.get("status") == "frozen"
        and manifest.get("planSha256") == sha256_file(plan_path)
        and manifest.get("trainSha256") == sha256_file(train_path)
        and manifest.get("recipeSha256") == sha256_file(recipe_path)
        and manifest.get("registerSha256") == sha256_file(register_path)
        and manifest.get("auditSha256") == sha256_file(audit_path)
        and manifest.get("source", {}).get("v058FrozenManifestSha256") == FROZEN_MANIFEST_SHA256
        and manifest.get("source", {}).get("v058CombinedTrainSha256") == COMBINED_TRAIN_SHA256,
        "Continuation package manifest differs.",
    )
    rows = read_jsonl(train_path)
    require(
        len(rows) == SELECTED_ROWS
        and all(
            row.get("split") == "train"
            and row.get("metadata", {}).get("language") == "sw"
            and row.get("metadata", {}).get("primaryCategory") == "tone"
            for row in rows
        ),
        "Continuation training rows differ.",
    )
    replay = list(rows)
    random.Random(SEED).shuffle(replay)
    order_sha = hashlib.sha256("\n".join(str(row["id"]) for row in replay).encode()).hexdigest()
    require(
        recipe.get("sampleOrderSha256") == order_sha == manifest.get("sampleOrderSha256")
        and recipe.get("learningRate") == LEARNING_RATE
        and recipe.get("expectedOptimizerSteps") == OPTIMIZER_STEPS,
        "Continuation sample order or recipe differs.",
    )
    return {
        "manifestSha256": sha256_file(manifest_path),
        "trainSha256": sha256_file(train_path),
        "recipeSha256": sha256_file(recipe_path),
        "sampleOrderSha256": order_sha,
        "trainingRows": SELECTED_ROWS,
        "optimizerSteps": OPTIMIZER_STEPS,
        "holdoutRowsRead": 0,
    }


def inherited_namespace_defaults() -> dict[str, Any]:
    original = sys.argv
    try:
        sys.argv = [str(BASE_PATH)]
        defaults = vars(BASE.parse_args())
    finally:
        sys.argv = original
    require(tuple(defaults) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Inherited runner namespace changed.")
    return defaults


def build_base_args(
    args: argparse.Namespace, package: Path, model: Path, output: Path, checkpoints: Path
) -> argparse.Namespace:
    values = inherited_namespace_defaults()
    values.update({
        "register": str(package / "register.private.json"),
        "data": None,
        "train_data": str(package / "concise-kiswahili-train.private.jsonl"),
        "dev_data": str(Path(args.dev_data).resolve()),
        "audit": str(package / "dataset-audit.private.json"),
        "dataset_manifest": str(package / "package-manifest.private.json"),
        "artifact_root": str(package),
        "pilot_row_manifest": str(package / "training-recipe.private.json"),
        "run_id": args.run_id,
        "paired_run_id": None,
        "lora_rank_approval_ref": None,
        "output_root": str(output),
        "constraints": str(CONSTRAINTS_PATH),
        "base_model_id": "google/gemma-4-E2B-it",
        "base_model_path": str(model),
        "base_revision": MODEL_REVISION,
        "checkpoint_root": str(checkpoints),
        "dry_run": False,
        "tiny_smoke": False,
        "allow_base_download": False,
        "approved_local_cpu_risk": False,
        "run_kind": RUN_KIND,
        "seed": SEED,
        "epochs": 1.0,
        "max_steps": None,
        "max_seq_length": 1024,
        "train_batch_size": 1,
        "eval_batch_size": 1,
        "gradient_accumulation_steps": 8,
        "max_grad_norm": 1.0,
        "warmup_ratio": 0.03,
        "lr_scheduler_type": "cosine",
        "logging_steps": 1,
        "eval_steps": OPTIMIZER_STEPS,
        "save_steps": OPTIMIZER_STEPS,
        "early_stopping_patience": 3,
        "learning_rate": LEARNING_RATE,
        "lora_r": 8,
        "lora_alpha": 16,
        "lora_dropout": 0.05,
    })
    namespace = argparse.Namespace(**values)
    require(tuple(vars(namespace)) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Continuation namespace is incomplete.")
    BASE.validate_run_configuration(namespace, RUN_KIND, "v04")
    return namespace


def patched_training_dependencies(initial_adapter: Path, expected_targets: set[str]):
    original = BASE.import_training_deps

    def load_dependencies():
        dependencies = original()
        from peft import PeftModel  # type: ignore[import-not-found]

        def load_existing_adapter(model: Any, lora_config: Any) -> Any:
            configured = set(getattr(lora_config, "target_modules", []) or [])
            require(configured == expected_targets, "Continuation target modules differ.")
            loaded = PeftModel.from_pretrained(
                model, str(initial_adapter), is_trainable=True, local_files_only=True
            )
            trainable = sum(parameter.numel() for parameter in loaded.parameters() if parameter.requires_grad)
            require(trainable == 12_079_104, "Continuation trainable parameter count differs.")
            return loaded

        dependencies["get_peft_model"] = load_existing_adapter
        return dependencies

    return load_dependencies


def preflight(args: argparse.Namespace) -> int:
    os.umask(0o077)
    package = Path(args.package).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve()
    initial_adapter = Path(args.initial_adapter).expanduser().resolve()
    initial_metadata = Path(args.initial_metadata).expanduser().resolve()
    dev = Path(args.dev_data).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    output = Path(args.output_root).expanduser().resolve()
    checkpoints = Path(args.checkpoint_root).expanduser().resolve()
    private_directory(output, "Preflight output", empty=True)
    private_directory(checkpoints, "Preflight checkpoint root", empty=True)
    plan_gate(plan_path)
    package_gate = verify_package(package, plan_path)
    initial_gate = initial_candidate_gate(initial_metadata, initial_adapter)
    require(
        dev.is_file() and not dev.is_symlink() and sha256_file(dev) == ORIGINAL_DEVELOPMENT_SHA256,
        "Frozen original development bytes differ.",
    )
    require(len(read_jsonl(dev)) == 300, "Frozen original development count differs.")
    model_gate = V058.verify_model(model)
    build_base_args(args, package, model, output, checkpoints)
    installed = BASE.verify_installed_training_lock(BASE.load_training_lock(REQUIREMENTS_PATH, CONSTRAINTS_PATH))
    dependencies = BASE.import_training_deps()
    torch = dependencies["torch"]
    require(torch.cuda.is_available() and BASE.cuda_bf16_supported(torch, True), "A11 CUDA/BF16 preflight differs.")
    require(int(os.environ.get("WORLD_SIZE", "1")) == 1, "Continuation requires WORLD_SIZE=1.")
    evidence = {
        "schema": "com.saferide.ai.v058-kiswahili-continuation-preflight",
        "schemaVersion": 1,
        "status": "passed",
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candidateAuthorizationConsumed": False,
        "optimizerStepsCompleted": 0,
        "package": package_gate,
        "initialCandidate": initial_gate,
        "modelInventorySha256": model_gate["inventorySha256"],
        "installedLockPackageCount": len(installed),
        "cudaAvailable": True,
        "cudaBf16Supported": True,
        "developmentRowsRead": 300,
        "holdoutRowsRead": 0,
        "rawContentIncluded": False,
    }
    write_private_json(output / "preflight.json", evidence)
    print("SafeRide v0.5.8 Kiswahili continuation preflight PASS (zero optimizer steps; holdout 0).")
    return 0


def sanitized_failure(error: Exception, roots: list[Path]) -> str:
    message = BASE.sanitized_error_message(error)
    for root in sorted((str(path) for path in roots), key=len, reverse=True):
        message = message.replace(root, "<private-path>")
    return re.sub(r"\s+", " ", message).strip()[:500]


def validate_outputs(outputs: dict[str, Any], sample_order_sha: str) -> dict[str, Any]:
    require(
        outputs.get("runKind") == RUN_KIND
        and outputs.get("globalSteps") == OPTIMIZER_STEPS
        and outputs.get("rowsSeen") == SELECTED_ROWS
        and float(outputs.get("epochsCompleted", 0)) >= 0.999,
        "Continuation coverage differs.",
    )
    require(
        outputs.get("sampleOrderSha256") == sample_order_sha
        and outputs.get("holdoutRowsRead") == 0
        and outputs.get("lossMaskPolicy") == "assistant-turns-only",
        "Continuation order, holdout, or loss mask differs.",
    )
    tensor = outputs.get("adapterTensorValidation", {})
    require(
        tensor.get("tensorCount") == 410
        and tensor.get("elementCount") == 12_079_104
        and tensor.get("nonFiniteTensorCount") == 0,
        "Continuation adapter tensor integrity differs.",
    )
    loss = outputs.get("lossReport", {})
    require(
        loss.get("finite") is True
        and all(
            math.isfinite(float(loss.get(field, math.nan)))
            for field in ("meanTrainingObjectiveLoss", "bestDevelopmentLoss", "finalDevelopmentLoss")
        ),
        "Continuation loss evidence is non-finite.",
    )
    files = []
    for item in outputs.get("adapterFiles", []):
        name = Path(str(item.get("path", ""))).name
        if name in EXPECTED_ADAPTER_FILES:
            files.append({"path": name, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
    files.sort(key=lambda item: item["path"])
    require(tuple(item["path"] for item in files) == EXPECTED_ADAPTER_FILES, "Continuation six-file adapter differs.")
    checkpoints = outputs.get("checkpoints", [])
    require(
        len(checkpoints) == 1
        and Path(str(checkpoints[0].get("path", ""))).name == "checkpoint-4"
        and checkpoints[0].get("fileCount") == 11,
        "Continuation checkpoint-4 inventory differs.",
    )
    outputs["adapterFiles"] = files
    outputs["adapterDir"] = "adapter"
    outputs["adapterInventorySha256"] = canonical_sha256(files)
    outputs["adapterInventoryFileCount"] = 6
    outputs["adapterInventorySizeBytes"] = sum(item["sizeBytes"] for item in files)
    outputs["bestCheckpoint"] = "checkpoint-4"
    outputs["checkpointRoot"] = "checkpoints"
    outputs["checkpoints"] = [{**checkpoints[0], "path": "checkpoint-4"}]
    outputs["checkpointInventorySha256"] = canonical_sha256(outputs["checkpoints"])
    outputs["metadataPathsSanitized"] = True
    return outputs


def run(args: argparse.Namespace) -> int:
    os.umask(0o077)
    require(RUN_ID_PATTERN.fullmatch(args.run_id) is not None, "Continuation run id is unsafe.")
    package = Path(args.package).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve()
    initial_adapter = Path(args.initial_adapter).expanduser().resolve()
    initial_metadata = Path(args.initial_metadata).expanduser().resolve()
    dev = Path(args.dev_data).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    output = Path(args.output_root).expanduser().resolve()
    checkpoints = Path(args.checkpoint_root).expanduser().resolve()
    private_directory(output, "Continuation output", empty=True)
    private_directory(checkpoints, "Continuation checkpoint root", empty=True)
    plan = plan_gate(plan_path)
    package_gate = verify_package(package, plan_path)
    initial_gate = initial_candidate_gate(initial_metadata, initial_adapter)
    require(sha256_file(dev) == ORIGINAL_DEVELOPMENT_SHA256 and len(read_jsonl(dev)) == 300, "Development bytes differ.")
    model_gate = V058.verify_model(model)
    base_args = build_base_args(args, package, model, output, checkpoints)
    config = read_json(initial_adapter / "adapter_config.json")
    expected_targets = set(config.get("target_modules", []))
    require(len(expected_targets) == 205, "Initial adapter target-module inventory differs.")
    train_rows = BASE.parse_jsonl(package / "concise-kiswahili-train.private.jsonl")
    dev_rows = BASE.parse_jsonl(dev)
    require(len(train_rows) == SELECTED_ROWS and len(dev_rows) == 300, "Continuation train/development counts differ.")
    run_dir = output / args.run_id
    run_dir.mkdir(mode=0o700)
    metadata_path = run_dir / "metadata.json"
    metadata: dict[str, Any] = {
        "schema": RUN_SCHEMA,
        "schemaVersion": 1,
        "issue": "ESH-4198",
        "status": "running",
        "runId": args.run_id,
        "seed": SEED,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "initialCandidate": initial_gate,
        "bindings": {
            "planSha256": sha256_file(plan_path),
            "packageManifestSha256": package_gate["manifestSha256"],
            "trainSha256": package_gate["trainSha256"],
            "sampleOrderSha256": package_gate["sampleOrderSha256"],
            "developmentSha256": sha256_file(dev),
            "modelInventorySha256": model_gate["inventorySha256"],
            "continuationSha256": sha256_file(SCRIPT_PATH),
            "requirementsSha256": sha256_file(REQUIREMENTS_PATH),
            "constraintsSha256": sha256_file(CONSTRAINTS_PATH),
        },
        "recipe": plan["recipe"],
        "optimizerStepsCompleted": 0,
        "privacy": {"holdoutRowsRead": 0, "rawContentLogged": False, "privatePathsRecorded": False},
        "promotionEligible": False,
        "selectionPerformed": False,
        "outputs": {},
        "failure": None,
    }
    write_private_json(metadata_path, metadata)
    original_loader = BASE.import_training_deps
    BASE.import_training_deps = patched_training_dependencies(initial_adapter, expected_targets)
    try:
        BASE.verify_installed_training_lock(BASE.load_training_lock(REQUIREMENTS_PATH, CONSTRAINTS_PATH))
        outputs = BASE.run_training(base_args, run_dir, train_rows + dev_rows, RUN_KIND, dataset_profile="v04")
        outputs["lossReport"] = REMEDIATION.build_loss_report(
            train_metrics=outputs["trainMetrics"],
            log_history=outputs["logHistory"],
            gradient_accumulation_steps=8,
            resumed_from_step=None,
            recorded_best_metric=outputs["bestMetric"],
        )
        outputs = validate_outputs(outputs, package_gate["sampleOrderSha256"])
        require(sha256_file(initial_adapter / "adapter_model.safetensors") == INITIAL_ADAPTER_TENSOR_SHA256, "Initial adapter changed.")
        metadata["outputs"] = outputs
        metadata["optimizerStepsCompleted"] = OPTIMIZER_STEPS
        metadata["status"] = "completed"
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_private_json(metadata_path, metadata)
    except Exception as error:
        metadata["status"] = "blocked"
        metadata["failure"] = {
            "phase": "single-low-lr-continuation",
            "errorType": type(error).__name__,
            "message": sanitized_failure(
                error, [package, model, initial_adapter, initial_metadata, dev, plan_path, output, checkpoints]
            ),
        }
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_private_json(metadata_path, metadata)
        raise RuntimeError(metadata["failure"]["message"]) from error
    finally:
        BASE.import_training_deps = original_loader
    print("SafeRide v0.5.8 Kiswahili continuation PASS (seed 419806; 32 rows; 4 steps; holdout 0).")
    return 0


def contract_check(args: argparse.Namespace) -> int:
    plan = plan_gate(Path(args.plan).expanduser().resolve())
    require(
        SELECTED_ROWS // 8 == OPTIMIZER_STEPS
        and RUN_KIND == "continuation"
        and RUN_ID_PATTERN.fullmatch("saferide-v058-kiswahili-s419806-contract") is not None
        and tuple(inherited_namespace_defaults()) == EXPECTED_INHERITED_NAMESPACE_FIELDS,
        "Continuation static contract differs.",
    )
    require(plan.get("downstream", {}).get("sealedHoldoutMaximumOpens") == 1, "One-time holdout boundary differs.")
    print("SafeRide v0.5.8 Kiswahili continuation contracts PASS (one candidate; 32/4; LR 5e-6).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    contract = sub.add_parser("contract-check")
    contract.add_argument("--plan", required=True)
    prepare_parser = sub.add_parser("prepare")
    for name in ("frozen-root", "initial-metadata", "initial-adapter", "model-root", "plan", "output-root"):
        prepare_parser.add_argument(f"--{name}", required=True)
    for command in ("preflight", "run"):
        launch = sub.add_parser(command)
        for name in (
            "package", "initial-metadata", "initial-adapter", "dev-data", "base-model-path",
            "plan", "output-root", "checkpoint-root", "run-id",
        ):
            launch.add_argument(f"--{name}", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check(parsed))
        if parsed.command == "prepare":
            raise SystemExit(prepare(parsed))
        raise SystemExit(preflight(parsed) if parsed.command == "preflight" else run(parsed))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SafeRide v0.5.8 Kiswahili continuation blocked: {re.sub(r'\s+', ' ', str(error))[:500]}", file=sys.stderr)
        raise SystemExit(1)
