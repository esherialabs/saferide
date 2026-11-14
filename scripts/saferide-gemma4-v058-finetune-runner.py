#!/usr/bin/env python3
"""Run one immutable v0.5.8 full candidate on the A11 backend."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[1]
BASE_PATH = SCRIPT_PATH.with_name("saferide-gemma4-finetune-runner.py")
TRAINING_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-training.py")
DATASET_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-dataset.py")
REMEDIATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-remediation.py")
REQUIREMENTS_PATH = REPO_ROOT / "requirements-ai-smoke.txt"
CONSTRAINTS_PATH = REPO_ROOT / "constraints-ai-training.txt"
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
MODEL_INVENTORY_SHA256 = "ff7ebf6346e08ddc6c9901686b1a007ff383995a2bf15182feef5c1dbcb1d25b"
EXPECTED_MODEL_FILES = {
    ".gitattributes": (1570, "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930"),
    "README.md": (26744, "be82a1570493c695dd2da37dcf80f2c3fca7e7d5bdf25eacebb0acef0c3a3758"),
    "chat_template.jinja": (17336, "2f1b4d75d067bae3fe44e676721c7f077d243bc007156cb9c2f8b5836613d082"),
    "config.json": (4954, "1b28f3d2c3100f6c594754b81107428bd7b822a7f48272ca681dae9d2ec38330"),
    "generation_config.json": (208, "d4226bbe3117d2d253ba4609720ba82c6c4ce4627a9a6ae05387c78983ac03de"),
    "model.safetensors": (10246621918, "2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550"),
    "processor_config.json": (1689, "32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c"),
    "tokenizer.json": (32169626, "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f"),
    "tokenizer_config.json": (2095, "90c3a3ba5bf53818383a58e1a776cbcacd2a038d4812eaa373e1522f2d06f3df"),
}
EXPECTED_MODEL_TOTAL_BYTES = 10278846140
EXPECTED_ADAPTER_FILES = (
    "README.md", "adapter_config.json", "adapter_model.safetensors",
    "chat_template.jinja", "tokenizer.json", "tokenizer_config.json",
)
EXPECTED_CHECKPOINT_STEPS = tuple(range(25, 250, 25))
EXPECTED_TERMINAL_CHECKPOINT_STEP = 249
RECOVERABLE_RUNNER_SHA256 = "96fa4d3b59820c07465550bee2fa3491ffa9b051ad67ab3724bb59b39515be28"
RUN_ID_PATTERN = re.compile(r"saferide-v058-candidate-s(419805|419806)-[a-z0-9-]+")
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


BASE = load_module(BASE_PATH, "saferide_v058_finetune_base")
TRAINING = load_module(TRAINING_PATH, "saferide_v058_finetune_training")
DATASET = load_module(DATASET_PATH, "saferide_v058_finetune_dataset")
REMEDIATION = load_module(REMEDIATION_PATH, "saferide_v058_finetune_remediation")


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
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Required JSON differs: {path.name}")
    return value


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    path.chmod(0o600)


def private_directory(path: Path, label: str) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, f"{label} must be mode 0700.")


def inherited_namespace_defaults() -> dict[str, Any]:
    original = sys.argv
    try:
        sys.argv = [str(BASE_PATH)]
        defaults = vars(BASE.parse_args())
    finally:
        sys.argv = original
    require(tuple(defaults) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Inherited runner namespace contract changed.")
    return defaults


def build_base_args(args: argparse.Namespace, package: Path, model: Path, output: Path, checkpoints: Path) -> argparse.Namespace:
    values = inherited_namespace_defaults()
    values.update({
        "register": str(package / "register.private.json"), "data": None,
        "train_data": str(package / "weighted-train.private.jsonl"), "dev_data": str(Path(args.dev_data).resolve()),
        "audit": str(package / "dataset-audit.private.json"),
        "dataset_manifest": str(package / "frozen-manifest.private.json"), "artifact_root": str(package),
        "pilot_row_manifest": str(package / "training-recipe.private.json"), "run_id": args.run_id,
        "paired_run_id": args.paired_run_id, "lora_rank_approval_ref": None,
        "output_root": str(output), "constraints": str(CONSTRAINTS_PATH),
        "base_model_id": "google/gemma-4-E2B-it", "base_model_path": str(model),
        "base_revision": MODEL_REVISION, "checkpoint_root": str(checkpoints),
        "dry_run": False, "tiny_smoke": False, "allow_base_download": False,
        "approved_local_cpu_risk": False, "run_kind": "candidate", "seed": args.seed,
        "epochs": 1.0, "max_steps": None, "max_seq_length": 1024,
        "train_batch_size": 1, "eval_batch_size": 1, "gradient_accumulation_steps": 8,
        "max_grad_norm": 1.0, "warmup_ratio": 0.03, "lr_scheduler_type": "cosine",
        "logging_steps": 5, "eval_steps": 25, "save_steps": 25,
        "early_stopping_patience": 3, "learning_rate": 2e-5,
        "lora_r": 8, "lora_alpha": 16, "lora_dropout": 0.05,
    })
    namespace = argparse.Namespace(**values)
    require(tuple(vars(namespace)) == EXPECTED_INHERITED_NAMESPACE_FIELDS, "Inherited candidate namespace is incomplete.")
    BASE.validate_run_configuration(namespace, "candidate", "v04")
    return namespace


def verify_model(model: Path) -> dict[str, Any]:
    private_directory(model, "Pinned base-model root")
    entries = sorted(path for path in model.iterdir() if path.is_file())
    require([path.name for path in entries] == sorted(EXPECTED_MODEL_FILES), "Pinned model nine-file inventory differs.")
    files = []
    for path in entries:
        size, expected_hash = EXPECTED_MODEL_FILES[path.name]
        require(not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) in {0o400, 0o600}, f"Pinned model file is unsafe: {path.name}")
        require(path.stat().st_size == size and sha256_file(path) == expected_hash, f"Pinned model bytes differ: {path.name}")
        files.append({"path": path.name, "sizeBytes": size, "sha256": expected_hash})
    require(sum(item[0] for item in EXPECTED_MODEL_FILES.values()) == EXPECTED_MODEL_TOTAL_BYTES, "Pinned model total size differs.")
    model_object = {
        "modelId": "google/gemma-4-E2B-it", "revision": MODEL_REVISION,
        "fileCount": 9, "totalBytes": EXPECTED_MODEL_TOTAL_BYTES, "files": files,
    }
    require(canonical_sha256(model_object) == MODEL_INVENTORY_SHA256, "Pinned model canonical inventory differs.")
    return {"inventorySha256": MODEL_INVENTORY_SHA256, "fileCount": 9, "totalBytes": EXPECTED_MODEL_TOTAL_BYTES}


def verify_plan(plan_path: Path, frozen_root: Path) -> dict[str, str]:
    require(plan_path.is_file() and not plan_path.is_symlink(), "Runnable v0.5.8 plan is unavailable.")
    plan = read_json(plan_path)
    manifest = frozen_root / "package/frozen-manifest.private.json"
    input_manifest = frozen_root / "a11-input-manifest.json"
    recipe = plan.get("governedCandidateRecipeBoundary", {})
    freeze = plan.get("requiredV058CombinedInputFreeze", {})
    require(plan.get("schema") == "com.saferide.ai.v058-development-candidate-training-plan" and plan.get("status") == "authorized-runnable-a11-candidates", "v0.5.8 plan is not runnable.")
    require(plan.get("executionReadiness") == "runnable-a11-two-sequential-candidates", "v0.5.8 plan readiness differs.")
    require(freeze.get("frozenManifestSha256") == sha256_file(manifest) and freeze.get("a11InputManifestSha256") == sha256_file(input_manifest), "Runnable plan package binding differs.")
    require(recipe.get("candidateRunnerSha256") == sha256_file(SCRIPT_PATH) and recipe.get("fullFinetuneRunnerSha256") == sha256_file(BASE_PATH), "Runnable plan runner binding differs.")
    require(recipe.get("runKind") == "candidate" and recipe.get("runnable") is True and recipe.get("seeds") == [419805, 419806], "Runnable candidate recipe differs.")
    return {"planSha256": sha256_file(plan_path), "frozenManifestSha256": sha256_file(manifest), "a11InputManifestSha256": sha256_file(input_manifest)}


def predecessor_evidence(args: argparse.Namespace, frozen_manifest_sha: str) -> dict[str, Any] | None:
    if args.seed == 419805:
        require(args.paired_run_id is None and args.paired_run_metadata is None, "First candidate must not declare a predecessor.")
        return None
    require(args.paired_run_id is not None and args.paired_run_metadata is not None, "Seed 419806 requires the completed seed-419805 predecessor.")
    path = Path(args.paired_run_metadata).expanduser().resolve()
    require(path.is_file() and not path.is_symlink(), "Paired predecessor metadata is unavailable.")
    metadata = read_json(path)
    outputs = metadata.get("outputs", {})
    require(
        metadata.get("schema") == "com.saferide.ai.v058-candidate-run"
        and metadata.get("status") == "completed"
        and metadata.get("seed") == 419805
        and metadata.get("runId") == args.paired_run_id
        and metadata.get("candidateAuthorizationConsumed") is True
        and outputs.get("globalSteps") == 249
        and outputs.get("rowsSeen") == 1992
        and metadata.get("bindings", {}).get("frozenManifestSha256") == frozen_manifest_sha,
        "Paired seed-419805 predecessor is not a completed matching candidate.",
    )
    return {"runId": args.paired_run_id, "metadataSha256": sha256_file(path), "seed": 419805, "globalSteps": 249}


def checkpoint_evidence(root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    import torch  # type: ignore

    def evidence_for(step: int, role: str) -> dict[str, Any]:
        directory = root / f"checkpoint-{step}"
        require(directory.is_dir() and not directory.is_symlink(), f"Required checkpoint-{step} is unavailable.")
        records = []
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                require(not path.is_symlink(), f"checkpoint-{step} contains a symlink.")
                records.append({"path": path.relative_to(directory).as_posix(), "sha256": sha256_file(path), "sizeBytes": path.stat().st_size})
        tensor = directory / "adapter_model.safetensors"
        require(tensor.is_file(), f"checkpoint-{step} adapter tensor is unavailable.")
        tensor_gate = BASE.verify_finite_adapter_tensors(tensor, torch)
        require(tensor_gate == {"tensorCount": 410, "elementCount": 12079104, "nonFiniteTensorCount": 0}, f"checkpoint-{step} tensor integrity differs.")
        return {
            "step": step, "role": role, "path": f"checkpoint-{step}", "fileCount": len(records),
            "sizeBytes": sum(item["sizeBytes"] for item in records), "manifestSha256": canonical_sha256(records),
            "adapterTensorSha256": sha256_file(tensor), "adapterTensorSizeBytes": tensor.stat().st_size,
            "tensorValidation": tensor_gate,
        }

    expected_names = {
        *(f"checkpoint-{step}" for step in EXPECTED_CHECKPOINT_STEPS),
        f"checkpoint-{EXPECTED_TERMINAL_CHECKPOINT_STEP}",
    }
    require({path.name for path in root.glob("checkpoint-*") if path.is_dir()} == expected_names, "Unexpected or missing checkpoint directory.")
    scheduled = [evidence_for(step, "scheduled-recovery") for step in EXPECTED_CHECKPOINT_STEPS]
    terminal = evidence_for(EXPECTED_TERMINAL_CHECKPOINT_STEP, "automatic-terminal-state")
    return scheduled, terminal


def validate_outputs(outputs: dict[str, Any], sample_order_sha: str, checkpoint_root: Path) -> dict[str, Any]:
    require(outputs.get("runKind") == "candidate" and outputs.get("precision") == "bf16", "Candidate run kind or precision differs.")
    require(outputs.get("globalSteps") == 249 and outputs.get("rowsSeen") == 1992 and float(outputs.get("epochsCompleted", 0)) >= 0.999, "Candidate epoch/step coverage differs.")
    require(outputs.get("sampleOrderSha256") == sample_order_sha and outputs.get("holdoutRowsRead") == 0 and outputs.get("lossMaskPolicy") == "assistant-turns-only", "Candidate order, holdout, or loss-mask boundary differs.")
    require(outputs.get("effectiveBatchSize") == 8 and outputs.get("loraTargetModuleCount") == 205, "Candidate effective batch or LoRA target inventory differs.")
    tensor = outputs.get("adapterTensorValidation", {})
    require(tensor == {"tensorCount": 410, "elementCount": 12079104, "nonFiniteTensorCount": 0}, "Final adapter tensor integrity differs.")
    loss = outputs.get("lossReport", {})
    require(loss.get("finite") is True and all(math.isfinite(float(loss.get(field, math.nan))) for field in ("meanTrainingObjectiveLoss", "bestDevelopmentLoss", "finalDevelopmentLoss")), "Candidate loss evidence is non-finite.")
    adapter_files = []
    names = set()
    for item in outputs.get("adapterFiles", []):
        name = Path(str(item.get("path", ""))).name
        require(name in EXPECTED_ADAPTER_FILES and name not in names, "Final adapter inventory differs.")
        require(re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", ""))) is not None and int(item.get("sizeBytes", 0)) > 0, "Final adapter file binding differs.")
        names.add(name)
        adapter_files.append({"path": name, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
    require(names == set(EXPECTED_ADAPTER_FILES), "Candidate requires the exact final six-file adapter inventory.")
    checkpoints, terminal_checkpoint = checkpoint_evidence(checkpoint_root)
    outputs["adapterFiles"] = sorted(adapter_files, key=lambda item: item["path"])
    outputs["adapterDir"] = "adapter"
    outputs["adapterInventorySha256"] = canonical_sha256(outputs["adapterFiles"])
    outputs["adapterInventoryFileCount"] = 6
    outputs["adapterInventorySizeBytes"] = sum(item["sizeBytes"] for item in outputs["adapterFiles"])
    outputs["checkpoints"] = checkpoints
    outputs["terminalCheckpoint"] = terminal_checkpoint
    outputs["checkpointRoot"] = "checkpoints"
    outputs["checkpointInventorySha256"] = canonical_sha256({
        "scheduledCheckpoints": checkpoints,
        "terminalCheckpoint": terminal_checkpoint,
    })
    outputs["bestCheckpoint"] = Path(str(outputs.get("bestCheckpoint", ""))).name
    for private_field in ("sampleOrder", "trainRowIds", "developmentRowIds"):
        outputs.pop(private_field, None)
    outputs["rowIdentifiersRemovedFromReceipt"] = True
    return outputs


def sanitized_failure(error: Exception, roots: list[Path]) -> str:
    message = BASE.sanitized_error_message(error)
    for root in sorted((str(path) for path in roots), key=len, reverse=True):
        message = message.replace(root, "<private-path>")
    return re.sub(r"\s+", " ", message).strip()[:500]


def preflight(args: argparse.Namespace) -> int:
    """Run every non-consuming candidate gate inside the governed image."""
    os.umask(0o077)
    match = RUN_ID_PATTERN.fullmatch(args.run_id)
    require(match is not None and int(match.group(1)) == args.seed, "v0.5.8 preflight run id/seed differs.")
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    package = frozen_root / "package"
    dev = Path(args.dev_data).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve()
    output = Path(args.output_root).expanduser().resolve()
    checkpoints = Path(args.checkpoint_root).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    for directory, label in (
        (frozen_root, "Frozen input root"), (package, "Frozen package"),
        (output, "Candidate output root"), (checkpoints, "Candidate checkpoint root"),
    ):
        private_directory(directory, label)
    require(not any(output.iterdir()) and not any(checkpoints.iterdir()), "Candidate preflight requires fresh empty output/checkpoint roots.")
    gate = TRAINING.verify(frozen_root, dev, args.seed)
    model_gate = verify_model(model)
    plan_gate = verify_plan(plan_path, frozen_root)
    predecessor = predecessor_evidence(args, plan_gate["frozenManifestSha256"])
    build_base_args(args, package, model, output, checkpoints)
    installed = BASE.verify_installed_training_lock(BASE.load_training_lock(REQUIREMENTS_PATH, CONSTRAINTS_PATH))
    import torch  # type: ignore

    cuda_available = bool(torch.cuda.is_available())
    device_count = int(torch.cuda.device_count()) if cuda_available else 0
    bf16_supported = BASE.cuda_bf16_supported(torch, cuda_available)
    require(cuda_available and device_count == 1 and bf16_supported, "A11 CUDA/BF16 preflight differs.")
    require(int(os.environ.get("WORLD_SIZE", "1")) == 1, "A11 candidate preflight requires WORLD_SIZE=1.")
    print(json.dumps({
        "status": "passed", "runId": args.run_id, "seed": args.seed,
        "candidateAuthorizationConsumed": False, "optimizerStepsCompleted": 0,
        "inputGate": gate, "modelGate": model_gate, "planGate": plan_gate,
        "pairedPredecessor": predecessor,
        "runtime": {
            "cudaAvailable": cuda_available, "cudaDeviceCount": device_count,
            "cudaBf16Supported": bf16_supported, "installedLockPackageCount": len(installed),
        },
        "privacy": {"developmentRowsRead": 300, "holdoutRowsRead": 0, "rawContentIncluded": False},
    }, sort_keys=True, separators=(",", ":")))
    return 0


def recover(args: argparse.Namespace) -> int:
    """Recover a fully completed consumed run that failed only at checkpoint inventory validation."""
    os.umask(0o077)
    match = RUN_ID_PATTERN.fullmatch(args.run_id)
    require(match is not None and int(match.group(1)) == args.seed, "v0.5.8 recovery run id/seed differs.")
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    package = frozen_root / "package"
    dev = Path(args.dev_data).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve()
    output = Path(args.output_root).expanduser().resolve()
    checkpoints = Path(args.checkpoint_root).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    container_log = Path(args.container_log).expanduser().resolve()
    for directory, label in (
        (frozen_root, "Frozen input root"), (package, "Frozen package"),
        (output, "Candidate output root"), (checkpoints, "Candidate checkpoint root"),
    ):
        private_directory(directory, label)
    require(plan_path.is_file() and not plan_path.is_symlink(), "Executed candidate plan is unavailable.")
    require(container_log.is_file() and not container_log.is_symlink(), "Candidate container log is unavailable.")
    gate = TRAINING.verify(frozen_root, dev, args.seed)
    model_gate = verify_model(model)
    plan = read_json(plan_path)
    plan_sha = sha256_file(plan_path)
    recipe = plan.get("governedCandidateRecipeBoundary", {})
    require(
        plan.get("status") == "authorized-runnable-a11-candidates"
        and plan.get("executionReadiness") == "runnable-a11-two-sequential-candidates"
        and recipe.get("candidateRunnerSha256") == RECOVERABLE_RUNNER_SHA256,
        "Executed recovery plan binding differs.",
    )
    run_dir = output / args.run_id
    metadata_path = run_dir / "metadata.json"
    marker_path = run_dir / "candidate-consumption.json"
    adapter_dir = run_dir / "adapter"
    checkpoint_run_root = checkpoints / args.run_id
    metadata = read_json(metadata_path)
    require(
        metadata.get("status") == "terminal-failed-consumed"
        and metadata.get("seed") == args.seed
        and metadata.get("candidateAuthorizationConsumed") is True
        and metadata.get("optimizerStepsCompleted") == 0
        and metadata.get("failure", {}).get("message") == "Unexpected or missing checkpoint directory."
        and metadata.get("bindings", {}).get("planSha256") == plan_sha
        and metadata.get("bindings", {}).get("candidateRunnerSha256") == RECOVERABLE_RUNNER_SHA256,
        "Candidate is not the exact recoverable terminal-checkpoint case.",
    )
    marker = read_json(marker_path)
    require(marker.get("status") == "candidate-authorization-consumed" and marker.get("firstOptimizerStep") == 1, "Candidate consumption marker differs.")
    state_path = checkpoint_run_root / f"checkpoint-{EXPECTED_TERMINAL_CHECKPOINT_STEP}/trainer_state.json"
    state = read_json(state_path)
    require(
        state.get("global_step") == 249 and float(state.get("epoch", 0)) == 1.0
        and state.get("max_steps") == 249 and state.get("num_train_epochs") == 1
        and Path(str(state.get("best_model_checkpoint", ""))).name == "checkpoint-249"
        and math.isfinite(float(state.get("best_metric", math.nan))),
        "Terminal Trainer state does not prove 249 steps and one epoch.",
    )
    log_history = state.get("log_history")
    require(isinstance(log_history, list) and log_history, "Terminal Trainer loss history is unavailable.")
    BASE.assert_finite_training_evidence(log_history)
    log_text = container_log.read_text(encoding="utf-8", errors="replace")
    recovered_train_losses = re.findall(r"train_loss': '([0-9]+(?:\.[0-9]+)?)'", log_text)
    require(recovered_train_losses, "Terminal Trainer console loss is unavailable for recovery.")
    rounded_train_loss = float(recovered_train_losses[-1])
    loss = REMEDIATION.build_loss_report(
        train_metrics={"train_loss": rounded_train_loss}, log_history=log_history,
        gradient_accumulation_steps=8, resumed_from_step=None,
        recorded_best_metric=float(state["best_metric"]),
    )
    loss["recoverySource"] = "terminal-trainer-console-two-decimal"
    loss["rawTrainerAccumulatedLossPrecision"] = "rounded-to-two-decimals-by-trainer-console"
    loss["meanTrainingObjectiveLossPrecision"] = "derived-from-rounded-terminal-console-loss"
    import torch  # type: ignore

    tensor_gate = BASE.verify_finite_adapter_tensors(adapter_dir / "adapter_model.safetensors", torch)
    adapter_files = [
        {"path": path.name, "sha256": sha256_file(path), "sizeBytes": path.stat().st_size}
        for path in sorted(adapter_dir.rglob("*")) if path.is_file()
    ]
    outputs: dict[str, Any] = {
        "runKind": "candidate", "precision": "bf16", "globalSteps": 249,
        "rowsSeen": 1992, "epochsCompleted": 1.0,
        "sampleOrderSha256": gate["sampleOrderSha256"], "holdoutRowsRead": 0,
        "lossMaskPolicy": "assistant-turns-only", "effectiveBatchSize": 8,
        "loraTargetModuleCount": 205, "adapterTensorValidation": tensor_gate,
        "adapterFiles": adapter_files, "bestCheckpoint": state["best_model_checkpoint"],
        "bestMetric": state["best_metric"], "lossReport": loss,
        "trainMetrics": {"train_loss": rounded_train_loss, "recoveredFromTerminalConsole": True},
        "devMetrics": {"eval_loss": float(state["best_metric"]), "step": 249},
        "logHistory": [
            {key: value for key, value in item.items() if key in {
                "epoch", "step", "loss", "eval_loss", "learning_rate", "grad_norm",
            } and isinstance(value, (int, float))}
            for item in log_history
        ],
    }
    outputs = validate_outputs(outputs, gate["sampleOrderSha256"], checkpoint_run_root)
    original_metadata = metadata_path.read_bytes()
    original_metadata_sha = hashlib.sha256(original_metadata).hexdigest()
    backup_path = run_dir / "metadata.pre-recovery.json"
    require(not backup_path.exists(), "Candidate recovery metadata backup already exists; silent recovery retry is forbidden.")
    backup_path.write_bytes(original_metadata)
    backup_path.chmod(0o600)
    recovered_at = dt.datetime.now(dt.timezone.utc).isoformat()
    historical_failure = metadata["failure"]
    metadata["status"] = "completed"
    metadata["optimizerStepsCompleted"] = 249
    metadata["outputs"] = outputs
    metadata["failure"] = None
    metadata["historicalTerminalFailure"] = historical_failure
    metadata["recovery"] = {
        "status": "passed", "recoveredAt": recovered_at,
        "recoveryRunnerSha256": sha256_file(SCRIPT_PATH),
        "originalMetadataSha256": original_metadata_sha,
        "executedPlanSha256": plan_sha, "trainingRerun": False,
        "optimizerOperationsPerformedDuringRecovery": 0,
        "automaticTerminalCheckpointClassifiedSeparately": True,
    }
    metadata["bindings"]["recoveryRunnerSha256"] = sha256_file(SCRIPT_PATH)
    write_private_json(metadata_path, metadata)
    receipt = {
        "schema": "com.saferide.ai.v058-candidate-recovery-receipt", "schemaVersion": 1,
        "status": "passed", "runId": args.run_id, "seed": args.seed,
        "recoveredAt": recovered_at, "trainingRerun": False,
        "optimizerOperationsPerformedDuringRecovery": 0,
        "optimizerStepsRecovered": 249, "epochsRecovered": 1.0,
        "scheduledCheckpointSteps": list(EXPECTED_CHECKPOINT_STEPS),
        "automaticTerminalCheckpointStep": EXPECTED_TERMINAL_CHECKPOINT_STEP,
        "bindings": {
            "originalMetadataSha256": original_metadata_sha,
            "recoveredMetadataSha256": sha256_file(metadata_path),
            "executedPlanSha256": plan_sha, "modelInventorySha256": model_gate["inventorySha256"],
            "recoveryRunnerSha256": sha256_file(SCRIPT_PATH),
            "checkpointInventorySha256": outputs["checkpointInventorySha256"],
            "adapterInventorySha256": outputs["adapterInventorySha256"],
        },
        "lossReport": loss,
        "privacy": {"rawContentIncluded": False, "privatePathsIncluded": False, "holdoutRowsRead": 0},
        "selectionPerformed": False, "promotionPerformed": False,
    }
    write_private_json(run_dir / "recovery-receipt.json", receipt)
    print("SafeRide v0.5.8 candidate recovery PASS (249 steps; 1 epoch; 9 scheduled plus terminal checkpoint; no retraining).")
    return 0


def run(args: argparse.Namespace) -> int:
    os.umask(0o077)
    match = RUN_ID_PATTERN.fullmatch(args.run_id)
    require(match is not None and int(match.group(1)) == args.seed, "v0.5.8 candidate run id/seed differs.")
    frozen_root = Path(args.frozen_root).expanduser().resolve()
    package = frozen_root / "package"
    dev = Path(args.dev_data).expanduser().resolve()
    model = Path(args.base_model_path).expanduser().resolve()
    output = Path(args.output_root).expanduser().resolve()
    checkpoints = Path(args.checkpoint_root).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    for directory, label in ((frozen_root, "Frozen input root"), (package, "Frozen package"), (output, "Candidate output root"), (checkpoints, "Candidate checkpoint root")):
        private_directory(directory, label)
    require(not any(output.iterdir()) and not any(checkpoints.iterdir()), "Fresh candidate output/checkpoint roots must be empty; silent retry is forbidden.")
    gate = TRAINING.verify(frozen_root, dev, args.seed)
    model_gate = verify_model(model)
    plan_gate = verify_plan(plan_path, frozen_root)
    predecessor = predecessor_evidence(args, plan_gate["frozenManifestSha256"])
    run_dir = output / args.run_id
    run_dir.mkdir(mode=0o700)
    metadata_path = run_dir / "metadata.json"
    marker_path = run_dir / "candidate-consumption.json"
    base_args = build_base_args(args, package, model, output, checkpoints)
    metadata: dict[str, Any] = {
        "schema": "com.saferide.ai.v058-candidate-run", "schemaVersion": 1,
        "issue": "ESH-4198", "status": "running", "runKind": "candidate",
        "runId": args.run_id, "seed": args.seed, "pairedPredecessor": predecessor,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candidateAuthorizationConsumed": False, "optimizerStepsCompleted": 0,
        "bindings": {
            **plan_gate, "weightedTrainSha256": sha256_file(package / "weighted-train.private.jsonl"),
            "developmentSha256": sha256_file(dev), "sampleOrderSha256": gate["sampleOrderSha256"],
            "modelInventorySha256": model_gate["inventorySha256"],
            "candidateRunnerSha256": sha256_file(SCRIPT_PATH), "fullRunnerSha256": sha256_file(BASE_PATH),
            "trainingValidatorSha256": sha256_file(TRAINING_PATH), "datasetBuilderSha256": sha256_file(DATASET_PATH),
            "requirementsSha256": sha256_file(REQUIREMENTS_PATH), "constraintsSha256": sha256_file(CONSTRAINTS_PATH),
        },
        "recipe": {
            "epochs": 1, "weightedExamples": 1992, "expectedOptimizerSteps": 249,
            "learningRate": 2e-5, "maximumSequenceLength": 1024, "rejectTruncation": True,
            "trainBatchSize": 1, "evaluationBatchSize": 1, "gradientAccumulationSteps": 8,
            "precision": "bf16", "gradientCheckpointing": True, "assistantOnlyLoss": True,
            "scheduler": "cosine", "warmupRatio": 0.03, "maximumGradientNorm": 1.0,
            "loggingSteps": 5, "evaluationSteps": 25, "saveSteps": 25,
            "earlyStoppingPatience": 3, "lora": {"rank": 8, "alpha": 16, "dropout": 0.05},
        },
        "inputGate": gate, "modelGate": model_gate,
        "privacy": {"holdoutRowsRead": 0, "rawContentLogged": False, "privatePathsRecorded": False},
        "retryAuthorized": False, "promotionEligible": False, "outputs": {}, "failure": None,
    }
    write_private_json(metadata_path, metadata)
    old_marker = os.environ.get("SAFERIDE_CANDIDATE_CONSUMPTION_MARKER")
    os.environ["SAFERIDE_CANDIDATE_CONSUMPTION_MARKER"] = str(marker_path)
    try:
        BASE.verify_installed_training_lock(BASE.load_training_lock(REQUIREMENTS_PATH, CONSTRAINTS_PATH))
        rows = BASE.parse_jsonl(package / "weighted-train.private.jsonl") + BASE.parse_jsonl(dev)
        require(len(rows) == 2292, "Candidate train/development input total differs.")
        outputs = BASE.run_training(base_args, run_dir, rows, "candidate", dataset_profile="v04")
        require(marker_path.is_file(), "Candidate completed without an optimization-consumption marker.")
        loss = REMEDIATION.build_loss_report(
            train_metrics=outputs["trainMetrics"], log_history=outputs["logHistory"],
            gradient_accumulation_steps=8, resumed_from_step=None, recorded_best_metric=outputs["bestMetric"],
        )
        outputs["lossReport"] = loss
        outputs = validate_outputs(outputs, gate["sampleOrderSha256"], checkpoints / args.run_id)
        metadata["outputs"] = outputs
        metadata["candidateAuthorizationConsumed"] = True
        metadata["optimizerStepsCompleted"] = 249
        metadata["consumptionMarkerSha256"] = sha256_file(marker_path)
        metadata["status"] = "completed"
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_private_json(metadata_path, metadata)
    except Exception as error:
        consumed = marker_path.is_file()
        metadata["candidateAuthorizationConsumed"] = consumed
        metadata["status"] = "terminal-failed-consumed" if consumed else "pre-execution-failed-zero-steps"
        metadata["failure"] = {
            "phase": "candidate-execution", "errorType": type(error).__name__,
            "message": sanitized_failure(error, [frozen_root, dev, model, output, checkpoints, plan_path]),
        }
        metadata["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        if consumed:
            metadata["consumptionMarkerSha256"] = sha256_file(marker_path)
        write_private_json(metadata_path, metadata)
        raise RuntimeError(metadata["failure"]["message"]) from error
    finally:
        if old_marker is None:
            os.environ.pop("SAFERIDE_CANDIDATE_CONSUMPTION_MARKER", None)
        else:
            os.environ["SAFERIDE_CANDIDATE_CONSUMPTION_MARKER"] = old_marker
    print(f"SafeRide v0.5.8 full candidate PASS (seed {args.seed}; 1,992 rows; 249 steps; holdout 0).")
    return 0


def contract_check() -> int:
    TRAINING.contract_check()
    REMEDIATION.contract_check()
    model_object = {
        "modelId": "google/gemma-4-E2B-it", "revision": MODEL_REVISION,
        "fileCount": 9, "totalBytes": EXPECTED_MODEL_TOTAL_BYTES,
        "files": [
            {"path": name, "sizeBytes": size, "sha256": digest}
            for name, (size, digest) in sorted(EXPECTED_MODEL_FILES.items())
        ],
    }
    require(canonical_sha256(model_object) == MODEL_INVENTORY_SHA256, "v0.5.8 nine-file model inventory contract differs.")
    require(EXPECTED_CHECKPOINT_STEPS == (25, 50, 75, 100, 125, 150, 175, 200, 225), "v0.5.8 checkpoint contract differs.")
    require(EXPECTED_TERMINAL_CHECKPOINT_STEP == 249, "v0.5.8 automatic terminal-checkpoint contract differs.")
    require(RUN_ID_PATTERN.fullmatch("saferide-v058-candidate-s419805-contract") is not None, "v0.5.8 run-id contract differs.")
    require(tuple(inherited_namespace_defaults()) == EXPECTED_INHERITED_NAMESPACE_FIELDS and len(EXPECTED_ADAPTER_FILES) == 6, "v0.5.8 inherited runner or adapter contract differs.")
    print("SafeRide v0.5.8 candidate runner contract PASS (candidate-only; paired seeds; all checkpoints retained).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    for command in ("preflight", "recover", "run"):
        launch = sub.add_parser(command)
        launch.add_argument("--frozen-root", required=True); launch.add_argument("--dev-data", required=True)
        launch.add_argument("--base-model-path", required=True); launch.add_argument("--plan", required=True)
        launch.add_argument("--output-root", required=True); launch.add_argument("--checkpoint-root", required=True)
        launch.add_argument("--run-id", required=True); launch.add_argument("--seed", required=True, type=int, choices=(419805, 419806))
        launch.add_argument("--paired-run-id"); launch.add_argument("--paired-run-metadata")
        if command == "recover":
            launch.add_argument("--container-log", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check())
        if parsed.command == "preflight":
            raise SystemExit(preflight(parsed))
        raise SystemExit(recover(parsed) if parsed.command == "recover" else run(parsed))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        message = re.sub(r"\s+", " ", str(error))[:500]
        print(f"SafeRide v0.5.8 candidate blocked: {message}", file=sys.stderr)
        raise SystemExit(1)
