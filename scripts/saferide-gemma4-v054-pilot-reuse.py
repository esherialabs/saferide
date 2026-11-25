#!/usr/bin/env python3
"""Attest and recover the completed SafeRide v0.5.4 step-237 pilot.

This tool is deliberately narrower than a training runner.  It never invokes
``Trainer.train``.  It verifies the immutable failed-run evidence, replays one
development evaluation from the read-only checkpoint, and emits a recovered
content-free training manifest only when the duplicate step-237 evaluations
are equivalent under the governed loss contract.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import stat
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
CODE_ROOT = SCRIPT_PATH.parents[1]
RUNNER_PATH = SCRIPT_PATH.with_name("saferide-gemma4-finetune-runner.py")
REMEDIATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v054-remediation.py")

EXPECTED_FROZEN_MANIFEST_SHA256 = "92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad"
EXPECTED_ORIGINAL_PLAN_SHA256 = "4e502eae6ccd25a7dcb1e9b92b8b33e8173056e992ac7e4191fed0547eeb2dcf"
EXPECTED_BLOCKED_MANIFEST_SHA256 = "b68b7fb208694c8e0e2a50a8de7f99f4a12cfab3d9c0eab4b59bb3489e9d13e4"
EXPECTED_FAILURE_RECEIPT_SHA256 = "31c7632adb681133717db7679888118600378bf1cb9a72248f019ae544fa1ef3"
EXPECTED_HOST_SNAPSHOT_SHA256 = "5e22fad486daac59e14233c050cc9c0a1afcedd017e1724e036427d9f7ba6f70"
EXPECTED_SANITIZED_LOG_SHA256 = "5c650e5f1f615014aee1a1636a92dc3346fef55a8c90b21a43a09db56c0d42df"
EXPECTED_CHECKPOINT_ROOT_SHA256 = "1e8e5c7980d8867a4a952d9aa8529e500bdeff10cab70a230ee5fb907b9bce44"
EXPECTED_CHECKPOINT_237_SHA256 = "91ab22058111e14e9129d5df2d18290517d4a6dbdfe387d3661c1ce0732cb307"
EXPECTED_ADAPTER_SHA256 = "2f1f760cbc3e84835a0ff6309a3cfa6ba26ccb0009dcb6f921c56a84d2d2431d"
EXPECTED_ORIGINAL_RUN_ID = "saferide-v054-pilot-s419805-20260808-b6df81"
EXPECTED_FAILURE = "Development loss history contains duplicate evaluation steps."
EXPECTED_MODEL_ID = "google/gemma-4-E2B-it"
EXPECTED_MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
EXPECTED_TERMINATORS = [1, 106, 50]
EXPECTED_ADAPTER_FILES = (
    "README.md",
    "adapter_config.json",
    "adapter_model.safetensors",
    "chat_template.jinja",
    "tokenizer.json",
    "tokenizer_config.json",
)
EXPECTED_EVAL_STEPS = [25, 50, 75, 100, 125, 150, 175, 200, 225, 237]
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}$")
RUN_ID_PATTERN = re.compile(r"^saferide-v054-reuse-[a-z0-9][a-z0-9-]{7,79}$")


class ReuseError(RuntimeError):
    """Content-safe fail-closed reuse error."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReuseError(message)


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"Required module is unavailable: {path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def read_json(path: Path) -> dict[str, Any]:
    require(path.is_file() and not path.is_symlink(), f"Required controlled JSON is unavailable: {path.name}")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Controlled JSON is not an object: {path.name}")
    return value


def read_jsonl(path: Path, expected_split: str) -> list[dict[str, Any]]:
    require(path.is_file() and not path.is_symlink(), f"Required controlled JSONL is unavailable: {path.name}")
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ReuseError(f"Controlled JSONL is malformed at line {line_number}.") from error
            require(isinstance(row, dict) and row.get("split") == expected_split, "Controlled row split differs.")
            rows.append(row)
    return rows


def write_private_json(path: Path, value: Any) -> None:
    require(not path.exists(), f"Immutable recovery output already exists: {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    with path.open("xb") as handle:
        handle.write(canonical_bytes(value))
    path.chmod(0o600)


def private_directory(path: Path, label: str) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, f"{label} must be mode 0700.")


def tree_inventory(root: Path) -> dict[str, Any]:
    private_directory(root, "Controlled inventory root")
    records: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Controlled inventory contains a symlink.")
        if path.is_dir():
            require(stat.S_IMODE(path.stat().st_mode) == 0o700, "Controlled inventory directory permissions differ.")
        elif path.is_file():
            require(stat.S_IMODE(path.stat().st_mode) == 0o600, "Controlled inventory file permissions differ.")
            records.append({
                "path": path.relative_to(root).as_posix(),
                "sha256": sha256_file(path),
                "sizeBytes": path.stat().st_size,
            })
        else:
            raise ReuseError("Controlled inventory contains a non-regular entry.")
    require(bool(records), "Controlled inventory is unexpectedly empty.")
    return {
        "sha256": hashlib.sha256(canonical_bytes(records)).hexdigest(),
        "fileCount": len(records),
        "totalBytes": sum(item["sizeBytes"] for item in records),
    }


def verify_code_bindings(plan: dict[str, Any], code_root: Path) -> None:
    private_directory(code_root, "Bound code root")
    declared = {str(item.get("path")): item for item in plan.get("codeBindings", [])}
    actual = {path.relative_to(code_root).as_posix(): path for path in code_root.rglob("*") if path.is_file()}
    require(set(actual) == set(declared) and len(declared) == len(plan.get("codeBindings", [])), "Bound code inventory differs.")
    for relative, path in actual.items():
        require(stat.S_IMODE(path.stat().st_mode) == 0o600, "Bound code file permissions differ.")
        require(sha256_file(path) == declared[relative].get("sha256"), f"Bound code bytes differ: {Path(relative).name}")


def verify_model(plan: dict[str, Any], model_root: Path) -> None:
    private_directory(model_root, "Pinned model root")
    expected = {item["path"]: item for item in plan["runtime"]["baseModel"]["files"]}
    actual = {path.name: path for path in model_root.iterdir() if path.is_file()}
    require(set(actual) == set(expected) and len(actual) == 9, "Pinned nine-file model inventory differs.")
    for name, path in actual.items():
        item = expected[name]
        require(path.stat().st_size == item["sizeBytes"] and sha256_file(path) == item["sha256"], f"Pinned model bytes differ: {name}")
    generation = read_json(model_root / "generation_config.json")
    require(generation.get("eos_token_id") == EXPECTED_TERMINATORS, "Pinned model terminator inventory differs.")


def verify_immutable_contract(original: dict[str, Any], current: dict[str, Any]) -> None:
    for key in ("datasetId", "dataset", "fixedSuites", "recipe", "generation", "runtime"):
        require(original.get(key) == current.get(key), f"Current plan changed the frozen {key} contract.")
    require(current.get("dataset", {}).get("frozenManifestSha256") == EXPECTED_FROZEN_MANIFEST_SHA256, "Frozen manifest binding differs.")


def verify_prior_evidence(args: argparse.Namespace, original_plan: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    blocked_path = Path(args.blocked_manifest).resolve()
    receipt_path = Path(args.failure_receipt).resolve()
    snapshot_path = Path(args.host_snapshot).resolve()
    log_path = Path(args.sanitized_log).resolve()
    require(sha256_file(blocked_path) == EXPECTED_BLOCKED_MANIFEST_SHA256, "Prior blocked pilot manifest bytes differ.")
    require(sha256_file(receipt_path) == EXPECTED_FAILURE_RECEIPT_SHA256, "Prior pilot failure receipt bytes differ.")
    require(sha256_file(snapshot_path) == EXPECTED_HOST_SNAPSHOT_SHA256, "Prior pilot GPU snapshot bytes differ.")
    require(sha256_file(log_path) == EXPECTED_SANITIZED_LOG_SHA256, "Prior pilot sanitized log bytes differ.")
    blocked = read_json(blocked_path)
    receipt = read_json(receipt_path)
    snapshot = read_json(snapshot_path)
    require(
        blocked.get("runId") == EXPECTED_ORIGINAL_RUN_ID
        and blocked.get("status") == "blocked"
        and blocked.get("failure", {}).get("message") == EXPECTED_FAILURE,
        "Prior pilot failure identity differs.",
    )
    require(
        receipt.get("runId") == EXPECTED_ORIGINAL_RUN_ID
        and receipt.get("status") == "failed"
        and receipt.get("bindings", {}).get("planSha256") == EXPECTED_ORIGINAL_PLAN_SHA256
        and receipt.get("bindings", {}).get("sanitizedLogSha256") == EXPECTED_SANITIZED_LOG_SHA256
        and receipt.get("privacy", {}).get("sealedHoldoutRead") is False
        and receipt.get("fullCandidateStarted") is False
        and receipt.get("monitor", {}).get("competingWorkloadObserved") is False,
        "Prior pilot failure receipt differs.",
    )
    require(
        snapshot.get("gatePassed") is True
        and snapshot.get("minimumFreeVramMiB", 0) >= 22000
        and snapshot.get("maximumComputeProcessCount") == 0
        and snapshot.get("peakUtilizationPercent", 100) <= 1
        and snapshot.get("planSha256") == EXPECTED_ORIGINAL_PLAN_SHA256,
        "Prior pilot pre-execution GPU gate differs.",
    )
    require(original_plan.get("runtime", {}).get("image", {}).get("runtimeManifestDigest") == snapshot.get("runtimeManifestDigest"), "Prior runtime manifest binding differs.")
    log_text = log_path.read_text(encoding="utf-8", errors="strict")
    terminal_losses = re.findall(r"'train_loss':\s*'([0-9]+(?:\.[0-9]+)?)'", log_text)
    require(terminal_losses == ["20.67"], "Prior pilot terminal train-loss evidence differs.")
    final_eval_index = log_text.rfind("'eval_loss': '1.852'")
    train_index = log_text.rfind("'train_loss': '20.67'")
    second_eval_index = log_text.rfind("0/300")
    failure_index = log_text.rfind(EXPECTED_FAILURE)
    require(0 <= final_eval_index < train_index < second_eval_index < failure_index, "Prior duplicate step-237 evaluation order cannot be established.")
    return blocked, receipt, snapshot, terminal_losses[0]


def verify_checkpoint(checkpoint_root: Path) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any]]:
    root_inventory = tree_inventory(checkpoint_root)
    require(
        root_inventory == {"sha256": EXPECTED_CHECKPOINT_ROOT_SHA256, "fileCount": 22, "totalBytes": 355188096},
        "Completed pilot checkpoint-root inventory differs.",
    )
    checkpoint = checkpoint_root / EXPECTED_ORIGINAL_RUN_ID / "checkpoint-237"
    checkpoint_inventory = tree_inventory(checkpoint)
    require(
        checkpoint_inventory == {"sha256": EXPECTED_CHECKPOINT_237_SHA256, "fileCount": 11, "totalBytes": 177594324},
        "Completed pilot step-237 checkpoint inventory differs.",
    )
    required = {"optimizer.pt", "scheduler.pt", "rng_state.pth", "trainer_state.json", "training_args.bin", "adapter_model.safetensors"}
    require(required.issubset({path.name for path in checkpoint.iterdir() if path.is_file()}), "Step-237 checkpoint lacks recovery state.")
    require(sha256_file(checkpoint / "adapter_model.safetensors") == EXPECTED_ADAPTER_SHA256, "Step-237 adapter bytes differ.")
    state = read_json(checkpoint / "trainer_state.json")
    require(
        state.get("global_step") == 237
        and math.isclose(float(state.get("epoch", -1)), 1.0, abs_tol=1e-12)
        and state.get("max_steps") == 237
        and state.get("num_train_epochs") == 1
        and state.get("best_global_step") == 237,
        "Step-237 trainer state does not attest one full pilot epoch.",
    )
    history = state.get("log_history")
    require(isinstance(history, list) and history, "Step-237 trainer loss history is unavailable.")
    train_entries = [item for item in history if "loss" in item]
    eval_entries = [item for item in history if "eval_loss" in item]
    require([item.get("step") for item in eval_entries] == EXPECTED_EVAL_STEPS, "Persisted development evaluation order differs.")
    require([item.get("step") for item in train_entries] == sorted({item.get("step") for item in train_entries}), "Persisted training loss order differs.")
    for item in train_entries + eval_entries:
        for key, value in item.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                require(math.isfinite(float(value)), "Checkpoint history contains a non-finite metric.")
    best = min(float(item["eval_loss"]) for item in eval_entries)
    require(math.isclose(float(state.get("best_metric")), best, rel_tol=1e-7, abs_tol=1e-9), "Checkpoint best development loss differs.")
    return checkpoint, state, root_inventory, checkpoint_inventory


def verify_frozen_inputs(args: argparse.Namespace, plan: dict[str, Any], blocked: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    frozen_path = Path(args.frozen_manifest).resolve()
    train_path = Path(args.train_data).resolve()
    dev_path = Path(args.dev_data).resolve()
    recipe_path = Path(args.recipe).resolve()
    register_path = Path(args.register).resolve()
    audit_path = Path(args.audit).resolve()
    require(sha256_file(frozen_path) == EXPECTED_FROZEN_MANIFEST_SHA256, "Frozen v0.5.4 manifest bytes differ.")
    frozen = read_json(frozen_path)
    bindings = frozen.get("bindings", {})
    expected = plan["dataset"]
    require(
        sha256_file(train_path) == bindings.get("combinedTrainSha256") == expected.get("combinedTrainSha256")
        and sha256_file(dev_path) == bindings.get("originalDevelopmentSha256") == plan["fixedSuites"]["originalDevelopment"]["sha256"]
        and sha256_file(recipe_path) == bindings.get("trainingRecipeSha256") == expected.get("trainingRecipeSha256")
        and sha256_file(register_path) == bindings.get("registerSha256") == expected.get("registerSha256")
        and sha256_file(audit_path) == bindings.get("datasetAuditSha256") == expected.get("datasetAuditSha256"),
        "Frozen pilot input bytes differ.",
    )
    require(
        blocked.get("datasetManifestSha256") == EXPECTED_FROZEN_MANIFEST_SHA256
        and blocked.get("dataFiles", {}).get("train", {}).get("sha256") == sha256_file(train_path)
        and blocked.get("dataFiles", {}).get("dev", {}).get("sha256") == sha256_file(dev_path)
        and blocked.get("auditSha256") == sha256_file(audit_path)
        and blocked.get("registerSha256") == sha256_file(register_path),
        "Blocked pilot manifest input bindings differ.",
    )
    train_rows = read_jsonl(train_path, "train")
    dev_rows = read_jsonl(dev_path, "dev")
    require(len(train_rows) == 1864 and len(dev_rows) == 300, "Frozen train or development row count differs.")
    ids = [str(row.get("id")) for row in train_rows]
    require(len(set(ids)) == 1864 and all(value and value != "None" for value in ids), "Frozen training identity inventory differs.")
    recipe = read_json(recipe_path)
    order = recipe.get("sampleOrder")
    require(
        recipe.get("assistantOnlyLoss") is True
        and recipe.get("fullCandidateSubmissionAuthorized") is False
        and isinstance(order, list)
        and len(order) == 1896
        and len(set(order)) == 1864
        and set(order) == set(ids)
        and recipe.get("sampleOrderSha256") == hashlib.sha256("\n".join(order).encode("utf-8")).hexdigest(),
        "Frozen weighted sample order differs.",
    )
    return train_rows, dev_rows, [str(value) for value in order]


def evaluate_checkpoint(
    *,
    checkpoint: Path,
    model_root: Path,
    dev_rows: list[dict[str, Any]],
    state: dict[str, Any],
) -> tuple[dict[str, float], dict[str, int], dict[str, int], dict[str, Any]]:
    runner = load_module(RUNNER_PATH, "saferide_v054_reuse_runner")
    remediation = load_module(REMEDIATION_PATH, "saferide_v054_reuse_remediation")
    deps = runner.import_training_deps()
    torch = deps["torch"]
    require(torch.cuda.is_available() and torch.cuda.device_count() == 1, "Reuse evaluation requires exactly the governed device-0 CUDA view.")
    from peft import PeftModel  # type: ignore

    tokenizer = deps["AutoTokenizer"].from_pretrained(str(model_root), local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    base_model = deps["AutoModelForCausalLM"].from_pretrained(
        str(model_root),
        local_files_only=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        device_map={"": 0},
    )
    if getattr(base_model.config, "pad_token_id", None) is None:
        base_model.config.pad_token_id = tokenizer.pad_token_id
    if hasattr(base_model.config, "use_cache"):
        base_model.config.use_cache = False
    model = PeftModel.from_pretrained(base_model, str(checkpoint), is_trainable=False, local_files_only=True)
    model.eval()
    terminators = remediation.generation_terminator_ids(model, tokenizer)
    require(list(terminators) == EXPECTED_TERMINATORS, "Loaded checkpoint terminator behavior differs.")

    encoded_dev = [runner.encode_assistant_only_row(tokenizer, row, 1024) for row in dev_rows]
    dataset = deps["Dataset"].from_list(encoded_dev)
    arguments = deps["TrainingArguments"](
        output_dir="/tmp/saferide-v054-reuse-eval",
        per_device_eval_batch_size=1,
        report_to=[],
        remove_unused_columns=False,
        use_cpu=False,
        bf16=True,
        fp16=False,
        seed=419805,
        data_seed=419805,
    )
    trainer = deps["Trainer"](
        model=model,
        args=arguments,
        eval_dataset=dataset,
        data_collator=runner.AssistantOnlyDataCollator(tokenizer, torch),
        processing_class=tokenizer,
    )
    metrics = trainer.evaluate()
    numeric = {key: float(value) for key, value in metrics.items() if isinstance(value, (int, float)) and not isinstance(value, bool)}
    require("eval_loss" in numeric and all(math.isfinite(value) for value in numeric.values()), "Independent checkpoint evaluation produced a non-finite metric.")

    persisted = next(item for item in state["log_history"] if item.get("step") == 237 and "eval_loss" in item)
    independent = {**numeric, "step": 237, "epoch": float(persisted["epoch"])}
    coalesced = remediation._coalesce_equivalent_evaluations([
        (237, float(persisted["eval_loss"]), persisted),
        (237, float(independent["eval_loss"]), independent),
    ])
    require(len(coalesced) == 1, "Equivalent duplicate step-237 evaluation did not coalesce exactly once.")
    tensor_validation = runner.verify_finite_adapter_tensors(checkpoint / "adapter_model.safetensors", torch)
    require(tensor_validation == {"tensorCount": 410, "elementCount": 12079104, "nonFiniteTensorCount": 0}, "Step-237 adapter tensor integrity differs.")
    token_counts = {
        "dev": sum(len(item["input_ids"]) for item in encoded_dev),
        "assistantDev": sum(int(item["assistant_token_count"]) for item in encoded_dev),
    }
    duplicate = {
        "step": 237,
        "persistedLoss": float(persisted["eval_loss"]),
        "independentLoss": float(independent["eval_loss"]),
        "absoluteDifference": abs(float(persisted["eval_loss"]) - float(independent["eval_loss"])),
        "persistedEpoch": float(persisted["epoch"]),
        "independentEpoch": float(independent["epoch"]),
        "equivalentGovernedMetrics": True,
        "coalescedEntryCount": 1,
        "operationalMetricsExcluded": sorted(remediation.NON_GOVERNED_EVALUATION_FIELDS),
    }
    return numeric, tensor_validation, token_counts, duplicate


def copy_recovered_adapter(checkpoint: Path, output_root: Path) -> list[dict[str, Any]]:
    adapter_root = output_root / "adapter"
    require(not adapter_root.exists(), "Recovered adapter output already exists.")
    adapter_root.mkdir(parents=True, mode=0o700)
    adapter_root.chmod(0o700)
    inventory = []
    for name in EXPECTED_ADAPTER_FILES:
        source = checkpoint / name
        require(source.is_file() and not source.is_symlink(), f"Checkpoint adapter file is unavailable: {name}")
        target = adapter_root / name
        with source.open("rb") as input_handle, target.open("xb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, 8 * 1024 * 1024)
        target.chmod(0o600)
        inventory.append({"path": f"adapter/{name}", "sizeBytes": target.stat().st_size, "sha256": sha256_file(target)})
    require(next(item for item in inventory if item["path"].endswith("adapter_model.safetensors"))["sha256"] == EXPECTED_ADAPTER_SHA256, "Recovered adapter tensor bytes differ.")
    return inventory


def attest(args: argparse.Namespace) -> int:
    os.umask(0o077)
    require(RUN_ID_PATTERN.fullmatch(args.run_id) is not None, "Reuse run identity is invalid.")
    require(COMMIT_PATTERN.fullmatch(args.execution_commit) is not None, "Reuse execution commit is invalid.")
    try:
        created_at = dt.datetime.fromisoformat(args.created_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReuseError("Reuse creation time is invalid.") from error
    require(created_at.tzinfo is not None, "Reuse creation time lacks a timezone.")
    output_root = Path(args.output_root).resolve()
    private_directory(output_root, "New recovered-pilot output root")
    require(not any(output_root.iterdir()), "Recovered-pilot output root must be newly empty.")

    original_plan_path = Path(args.original_plan).resolve()
    current_plan_path = Path(args.plan).resolve()
    require(sha256_file(original_plan_path) == EXPECTED_ORIGINAL_PLAN_SHA256, "Original pilot execution plan bytes differ.")
    require(SHA256_PATTERN.fullmatch(args.plan_sha256) is not None and sha256_file(current_plan_path) == args.plan_sha256, "Current reuse plan bytes differ.")
    original_plan = read_json(original_plan_path)
    current_plan = read_json(current_plan_path)
    verify_immutable_contract(original_plan, current_plan)
    verify_code_bindings(original_plan, Path(args.original_code_root).resolve())
    verify_code_bindings(current_plan, Path(args.code_root).resolve())
    model_root = Path(args.model_root).resolve()
    verify_model(current_plan, model_root)

    blocked, receipt, _snapshot, terminal_loss_text = verify_prior_evidence(args, original_plan)
    checkpoint, state, checkpoint_root_inventory, checkpoint_inventory = verify_checkpoint(Path(args.checkpoint_root).resolve())
    train_rows, dev_rows, sample_order = verify_frozen_inputs(args, current_plan, blocked)
    require(math.ceil(len(sample_order) / int(blocked["runArguments"]["gradientAccumulationSteps"])) == 237, "Frozen sample order does not resolve to 237 optimizer steps.")

    metrics, tensor_validation, dev_token_counts, duplicate = evaluate_checkpoint(
        checkpoint=checkpoint,
        model_root=model_root,
        dev_rows=dev_rows,
        state=state,
    )
    runner = load_module(RUNNER_PATH, "saferide_v054_reuse_runner_outputs")
    remediation = load_module(REMEDIATION_PATH, "saferide_v054_reuse_remediation_outputs")
    tokenizer = runner.import_training_deps()["AutoTokenizer"].from_pretrained(str(model_root), local_files_only=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    by_id = {str(row["id"]): row for row in train_rows}
    encoded_train = [runner.encode_assistant_only_row(tokenizer, by_id[row_id], 1024) for row_id in sample_order]
    train_token_counts = {
        "train": sum(len(item["input_ids"]) for item in encoded_train),
        "assistantTrain": sum(int(item["assistant_token_count"]) for item in encoded_train),
    }
    raw_terminal_loss = float(terminal_loss_text)
    independent_entry = {
        "step": 237,
        "epoch": duplicate["independentEpoch"],
        "eval_loss": duplicate["independentLoss"],
        **{key: value for key, value in metrics.items() if key in remediation.NON_GOVERNED_EVALUATION_FIELDS},
    }
    loss_report = remediation.build_loss_report(
        train_metrics={"train_loss": raw_terminal_loss},
        log_history=[*state["log_history"], independent_entry],
        gradient_accumulation_steps=8,
        resumed_from_step=None,
        recorded_best_metric=float(state["best_metric"]),
    )
    adapter_config = read_json(checkpoint / "adapter_config.json")
    target_modules = adapter_config.get("target_modules")
    require(
        isinstance(target_modules, list)
        and len(target_modules) == 205
        and all(isinstance(value, str) and value for value in target_modules),
        "Step-237 adapter target-module inventory differs.",
    )
    adapter_files = copy_recovered_adapter(checkpoint, output_root)
    checkpoint_manifests = []
    for step in (225, 237):
        path = Path(args.checkpoint_root).resolve() / EXPECTED_ORIGINAL_RUN_ID / f"checkpoint-{step}"
        inventory = tree_inventory(path)
        checkpoint_manifests.append({"path": f"checkpoint-{step}", "fileCount": inventory["fileCount"], "manifestSha256": inventory["sha256"]})

    unique_train_ids = sorted(by_id)
    dev_ids = sorted(str(row["id"]) for row in dev_rows)
    outputs = {
        "modelId": EXPECTED_MODEL_ID,
        "modelSource": "staged-offline-snapshot",
        "baseRevision": EXPECTED_MODEL_REVISION,
        "tokenizerRevision": EXPECTED_MODEL_REVISION,
        "chatTemplateSha256": sha256_file(model_root / "chat_template.jinja"),
        "tinySmoke": False,
        "runKind": "pilot",
        "precision": "bf16",
        "epochsRequested": 1.0,
        "epochsCompleted": 1.0,
        "maxSteps": None,
        "globalSteps": 237,
        "bestCheckpoint": "checkpoint-237",
        "bestMetric": float(state["best_metric"]),
        "selectionMetric": "eval_loss",
        "resumedFromCheckpoint": None,
        "sampleOrder": sample_order,
        "sampleOrderSha256": hashlib.sha256("\n".join(sample_order).encode("utf-8")).hexdigest(),
        "sampleOrderPolicy": "frozen-explicit-weighted-order",
        "trainRowIds": unique_train_ids,
        "trainRowIdSha256": hashlib.sha256("\n".join(unique_train_ids).encode("utf-8")).hexdigest(),
        "developmentRowIds": dev_ids,
        "developmentRowIdSha256": hashlib.sha256("\n".join(dev_ids).encode("utf-8")).hexdigest(),
        "holdoutRowsRead": 0,
        "rowsSeen": 1896,
        "dataTokens": {**train_token_counts, **dev_token_counts},
        "lossMaskPolicy": "assistant-turns-only",
        "effectiveBatchSize": 8,
        "trainMetrics": {"train_loss": raw_terminal_loss},
        "devMetrics": metrics,
        "lossReport": loss_report,
        "logHistory": [
            {key: value for key, value in item.items() if key in {"epoch", "step", "loss", "eval_loss", "learning_rate", "grad_norm"} and isinstance(value, (int, float))}
            for item in state["log_history"]
        ],
        "loraTargetModuleCount": len(target_modules),
        "loraTargetModulePreview": sorted(target_modules)[:8],
        "trainableParameterSummary": {"recoveredFromImmutableCompletedCheckpoint": True},
        "adapterDir": "adapter",
        "adapterFiles": adapter_files,
        "adapterTensorValidation": tensor_validation,
        "checkpointRoot": "read-only-original-checkpoint-root",
        "checkpoints": checkpoint_manifests,
    }
    recovered = copy.deepcopy(blocked)
    recovered["status"] = "completed"
    recovered["failure"] = None
    recovered["outputs"] = outputs
    recovered_dir = output_root / EXPECTED_ORIGINAL_RUN_ID
    recovered_dir.mkdir(mode=0o700)
    recovered_dir.chmod(0o700)
    for item in adapter_files:
        source = output_root / item["path"]
        target = recovered_dir / item["path"]
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.parent.chmod(0o700)
        with source.open("rb") as input_handle, target.open("xb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, 8 * 1024 * 1024)
        target.chmod(0o600)
    shutil.rmtree(output_root / "adapter")
    for item in recovered["outputs"]["adapterFiles"]:
        item["path"] = f"adapter/{Path(item['path']).name}"
    manifest_path = recovered_dir / "metadata.json"
    write_private_json(manifest_path, recovered)

    attestation = {
        "schema": "com.saferide.ai.v054-pilot-reuse-attestation",
        "schemaVersion": 1,
        "runId": args.run_id,
        "createdAt": args.created_at,
        "issue": "ESH-4198",
        "executionCommit": args.execution_commit,
        "status": "passed",
        "originalPilotRunId": EXPECTED_ORIGINAL_RUN_ID,
        "bindings": {
            "originalPlanSha256": EXPECTED_ORIGINAL_PLAN_SHA256,
            "currentPlanSha256": args.plan_sha256,
            "frozenManifestSha256": EXPECTED_FROZEN_MANIFEST_SHA256,
            "blockedManifestSha256": EXPECTED_BLOCKED_MANIFEST_SHA256,
            "failureReceiptSha256": EXPECTED_FAILURE_RECEIPT_SHA256,
            "hostSnapshotSha256": EXPECTED_HOST_SNAPSHOT_SHA256,
            "sanitizedLogSha256": EXPECTED_SANITIZED_LOG_SHA256,
            "checkpointRootInventorySha256": checkpoint_root_inventory["sha256"],
            "checkpoint237InventorySha256": checkpoint_inventory["sha256"],
            "adapterTensorSha256": EXPECTED_ADAPTER_SHA256,
            "recoveredManifestSha256": sha256_file(manifest_path),
        },
        "completion": {"epochs": 1, "steps": 237, "rows": 1896, "exactFrozenOrder": True, "assistantOnlyLoss": True},
        "duplicateEvaluation": duplicate,
        "loss": {
            "rawTrainerAccumulatedLoss": raw_terminal_loss,
            "rawValueSource": "terminal-sanitized-log-display",
            "rawDisplayDecimalPlaces": 2,
            "meanTrainingObjectiveLoss": loss_report["meanTrainingObjectiveLoss"],
            "bestDevelopmentLoss": loss_report["bestDevelopmentLoss"],
            "finalDevelopmentLoss": loss_report["finalDevelopmentLoss"],
            "finite": True,
            "spikeGate": "passed",
            "divergenceGate": "passed",
        },
        "adapter": {**tensor_validation, "sizeBytes": (checkpoint / "adapter_model.safetensors").stat().st_size},
        "terminatorIds": EXPECTED_TERMINATORS,
        "recoveryState": {"optimizer": True, "scheduler": True, "rng": True, "trainer": True},
        "priorMonitoring": {
            "idleGatePassed": True,
            "competingWorkloadObserved": receipt["monitor"]["competingWorkloadObserved"],
        },
        "privacy": {
            "sealedHoldoutRead": False,
            "rawContentEmitted": False,
            "fullCandidateStarted": False,
            "promotionEligible": False,
        },
    }
    write_private_json(output_root / "reuse-attestation.json", attestation)
    print("SafeRide v0.5.4 pilot reuse PASS (step-237 duplicate equivalent; checkpoint and order attested; holdout closed).")
    print(f"Recovered manifest SHA-256: {sha256_file(manifest_path)}")
    print(f"Independent development loss: {metrics['eval_loss']:.16g}")
    return 0


def contract_check() -> int:
    require(EXPECTED_FROZEN_MANIFEST_SHA256 == "92f997666d83664e8319a59188941bc1510320d733bd891c8ab0ed2ee17812ad", "Frozen manifest constant differs.")
    require(EXPECTED_TERMINATORS == [1, 106, 50] and EXPECTED_EVAL_STEPS[-1] == 237, "Reuse terminator or completion contract differs.")
    require(RUNNER_PATH.is_file() and REMEDIATION_PATH.is_file(), "Reuse dependencies are unavailable.")
    print("SafeRide v0.5.4 pilot reuse contract PASS (read-only completed-checkpoint attestation; no training entrypoint).")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    run = subparsers.add_parser("attest")
    for name in (
        "run-id", "created-at", "execution-commit", "plan", "plan-sha256", "original-plan", "code-root",
        "original-code-root", "model-root", "blocked-manifest", "failure-receipt", "host-snapshot", "sanitized-log",
        "checkpoint-root", "frozen-manifest", "train-data", "dev-data", "recipe", "register", "audit", "output-root",
    ):
        run.add_argument(f"--{name}", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    return contract_check() if args.command == "contract-check" else attest(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReuseError, RuntimeError, ValueError, OSError) as error:
        print(re.sub(r"\s+", " ", str(error))[:600], file=sys.stderr)
        raise SystemExit(1)
