#!/usr/bin/env python3
"""A11-only launcher for one v0.5.7 continuation and one frozen panel."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional


SCRIPT_PATH = Path(__file__).resolve()
V056_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v056-gpu-launcher.py")
TRAINING_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-training.py")
PANEL_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v057-pilot-panel.py")
EXPECTED_INITIAL_ADAPTER_SHA256 = "6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4"
EXPECTED_INITIAL_ADAPTER_INVENTORY_SHA256 = "7f5715a366c323bbf6da67f8e1ed5c219d697af83ab3a126c52b1366561656f1"
EXPECTED_INITIAL_ADAPTER_FILE_COUNT = 6
EXPECTED_INITIAL_ADAPTER_SIZE = 80584074
EXPECTED_ORIGINAL_DEVELOPMENT_SHA256 = "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"
EXPECTED_MITIGATION_DEVELOPMENT_SHA256 = "55a9181a1b328bcd632f35d65609a4addb6c45d36b9755f1725cf659679c44cd"
EXPECTED_MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
EXPECTED_IMAGE_SHA256 = "a3ed2f36eb4fcf3bf52f6759dbf80c65643d1b0cd6844fa927f281053f992adf"
EXPECTED_IMAGE_SIZE = 3350200320
EXPECTED_IMAGE_CONFIG = "7ea597c35a61e55823c554deb3821fdb50dfb68695ae712f46931a05ecb34a87"
EXPECTED_REPLACEMENT_PILOT_PLAN_SHA256 = "7a33b1fc1762aa5ad986dd997c12cc3de9d5c3bcc27ce2c9e980df19ae9dfbbf"
EXPECTED_REPLACEMENT_PILOT_RECEIPT_SHA256 = "e57c4616588494d7fd51bfb4d1ce272585ea79f51eb2e8b38d71531fb86a88bc"
EXPECTED_REPLACEMENT_PILOT_METADATA_SHA256 = "d986621b0457892e0de71f074ef85ce2f7002bdebf31ed31d9dec0a4af801d43"
EXPECTED_REPLACEMENT_PILOT_ADAPTER_SHA256 = "d200779ec5d6e1d54e192dc645e8159dde71732da9cf480b3ddbab361470ff6d"
CONSUMED_AUTHORIZATION_REFERENCE = "ESH-4198-v057-wrapper-defect-replacement-pilot"
PANEL_AUTHORIZED_STATUS = "code-fixed-panel-run-authorized"
PANEL_AUTHORIZED_DECISION = "NO-GO-ONE-FROZEN-PANEL-AUTHORIZED"
PANEL_PENDING_STATUS = "code-fixed-panel-authorization-pending"
PANEL_PENDING_DECISION = "NO-GO-PANEL-AUTHORIZATION-PENDING"
RUN_PATTERNS = {
    "pilot": re.compile(r"saferide-v057-pilot-s419805-[a-z0-9-]+"),
    "panel": re.compile(r"saferide-v057-panel-s419805-[a-z0-9-]+"),
}
CONTAINER_PATTERN = re.compile(r"sr-v057-(?:pilot|panel)-a11-[a-z0-9-]+")
EXPECTED_ADAPTER_FILES = (
    "README.md", "adapter_config.json", "adapter_model.safetensors",
    "chat_template.jinja", "tokenizer.json", "tokenizer_config.json",
)


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required launcher implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V056 = load_module(V056_PATH, "saferide_v057_launcher_v056")
require = V056.require
sha256_file = V056.sha256_file
write_private_json = V056.write_private_json


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def empty_private_directory(path: Path, label: str) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable.")
    require(path.stat().st_mode & 0o077 == 0, f"{label} permissions are too broad.")
    require(not any(path.iterdir()), f"{label} must be empty; retries and overwrites are forbidden.")


def inventory(root: Path) -> dict[str, Any]:
    files = []
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Controlled inventory contains a symlink.")
        if path.is_file():
            files.append({"path": path.relative_to(root).as_posix(), "sha256": sha256_file(path), "sizeBytes": path.stat().st_size})
    return {"sha256": canonical_sha256(files), "fileCount": len(files), "sizeBytes": sum(item["sizeBytes"] for item in files)}


def inspect_image(plan: dict[str, Any], config_digest: str) -> None:
    """Verify the governed image using host-Python-3.8-compatible operations."""
    reference = f"sha256:{config_digest}"
    output = V056.checked(["docker", "image", "inspect", reference], "Pinned Docker image")
    values = json.loads(output)
    require(isinstance(values, list) and len(values) == 1, "Pinned Docker image inspection differs.")
    image = values[0]
    image_id = str(image.get("Id", ""))
    if image_id.startswith("sha256:"):
        image_id = image_id[len("sha256:"):]
    require(image_id == config_digest, "Pinned Docker image ID differs.")
    labels = image.get("Config", {}).get("Labels", {})
    expected = plan["runtime"]["image"]
    require(
        labels.get("org.opencontainers.image.title") == expected["title"]
        and labels.get("org.opencontainers.image.revision") == expected["launcherSourceCommit"]
        and labels.get("com.saferide.base-model-revision") == plan["runtime"]["baseModel"]["revision"]
        and labels.get("com.saferide.issue") == "ESH-4198",
        "Pinned Docker image labels differ.",
    )


def read_controlled_json(path: Path, label: str) -> dict[str, Any]:
    require(path.is_file() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{label} is not a JSON object.")
    return value


def verify_frozen_training_inputs(frozen: Path, dev: Path, plan: dict[str, Any]) -> dict[str, Any]:
    frozen = frozen.resolve(); dev = dev.resolve()
    require(frozen.is_dir() and not frozen.is_symlink(), "v0.5.7 frozen root is unavailable or unsafe.")
    require(frozen.stat().st_mode & 0o077 == 0, "v0.5.7 frozen root permissions are too broad.")
    require(dev.is_file() and not dev.is_symlink(), "Frozen original development suite is unavailable or unsafe.")
    manifest_path = frozen / "frozen-manifest.private.json"
    manifest = read_controlled_json(manifest_path, "v0.5.7 frozen manifest")
    require(sha256_file(manifest_path) == plan["dataset"]["frozenManifestSha256"], "v0.5.7 frozen manifest differs from plan.")
    require(
        manifest.get("schema") == "com.saferide.ai.v057-mitigation-manifest"
        and manifest.get("status") == "frozen"
        and manifest.get("counts") == {
            "developmentRows": 300, "mitigationDevelopmentRows": 20,
            "newFamilies": 8, "newRows": 16, "uniqueTrainRows": 72,
            "weightedTrainingExamples": 104,
        },
        "v0.5.7 frozen manifest identity or counts differ.",
    )
    expected_records = {
        "continuation-unique-train.private.jsonl": 72,
        "dataset-audit.private.json": 1,
        "register.private.json": 1,
        "semantic-report.private.json": 1,
        "system-prompt.experimental.private.json": 1,
        "tokenization-report.private.json": 1,
        "training-recipe.private.json": 104,
        "v057-mitigation-train.private.jsonl": 16,
        "weighted-continuation-train.private.jsonl": 104,
    }
    declared = {str(item.get("path")): item for item in manifest.get("files", [])}
    require(set(declared) == set(expected_records), "v0.5.7 frozen file inventory differs.")
    for relative, expected_count in expected_records.items():
        item = declared[relative]
        path = frozen / relative
        require(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0, f"v0.5.7 frozen file is unsafe: {Path(relative).name}")
        require(
            item.get("recordCount") == expected_count
            and item.get("sha256") == sha256_file(path)
            and item.get("sizeBytes") == path.stat().st_size,
            f"v0.5.7 frozen file differs: {Path(relative).name}",
        )
    bindings = manifest.get("bindings", {})
    plan_dataset = plan["dataset"]
    for manifest_field, plan_field in (
        ("implementationSha256", "frozenDatasetBuilderSha256"),
        ("registerSha256", "registerSha256"),
        ("datasetAuditSha256", "datasetAuditSha256"),
        ("trainingRecipeSha256", "trainingRecipeSha256"),
        ("semanticReportSha256", "semanticReportSha256"),
        ("tokenizationReportSha256", "tokenizationReportSha256"),
        ("uniqueTrainSha256", "uniqueTrainSha256"),
        ("weightedTrainSha256", "weightedTrainSha256"),
        ("newMitigationTrainSha256", "newMitigationTrainSha256"),
    ):
        require(bindings.get(manifest_field) == plan_dataset.get(plan_field), f"v0.5.7 frozen binding differs: {manifest_field}")
    recipe = read_controlled_json(frozen / "training-recipe.private.json", "v0.5.7 training recipe")
    require(
        recipe.get("sampleOrderSha256") == plan_dataset["sampleOrderSha256"]
        and recipe.get("learningRate") == 5e-6
        and recipe.get("expectedOptimizerSteps") == 13
        and recipe.get("weightedTrainingExamples") == 104
        and recipe.get("assistantOnlyLoss") is True
        and recipe.get("retryAllowed") is False
        and recipe.get("promotionEligible") is False,
        "v0.5.7 frozen training recipe differs.",
    )
    for name in ("dataset-audit.private.json", "semantic-report.private.json", "tokenization-report.private.json"):
        require(read_controlled_json(frozen / name, name).get("status") == "passed", f"v0.5.7 gate is not passed: {name}")
    require(sha256_file(dev) == EXPECTED_ORIGINAL_DEVELOPMENT_SHA256, "Frozen original development suite differs.")
    with dev.open("r", encoding="utf-8") as handle:
        development_rows = sum(1 for line in handle if line.strip())
    require(development_rows == 300, "Frozen original development row count differs.")
    return {
        "status": "passed", "manifestSha256": sha256_file(manifest_path),
        "weightedTrainSha256": plan_dataset["weightedTrainSha256"],
        "sampleOrderSha256": recipe["sampleOrderSha256"], "uniqueRows": 72,
        "weightedExamples": 104, "optimizerSteps": 13, "developmentRows": 300,
        "assistantOnlyLoss": True, "sealedHoldoutRowsRead": 0,
    }


def verify_pilot_output(metadata_path: Path, adapter_root: Path) -> dict[str, Any]:
    metadata = read_controlled_json(metadata_path, "v0.5.7 pilot metadata")
    require(
        metadata.get("schema") == "com.saferide.ai.v057-pilot-run"
        and metadata.get("status") == "completed"
        and metadata.get("failure") is None
        and isinstance(metadata.get("finishedAt"), str)
        and metadata.get("retryAllowed") is False
        and metadata.get("promotionEligible") is False,
        "v0.5.7 pilot metadata is incomplete.",
    )
    inherited = metadata.get("inheritedRunner", {})
    require(
        inherited.get("runKind") == "pilot"
        and inherited.get("requiredFieldCount") == 40
        and inherited.get("modelCardPathPreflightPassed") is True,
        "v0.5.7 inherited model-card metadata is incomplete.",
    )
    require(metadata.get("bindings", {}).get("initialAdapterTensorSha256") == EXPECTED_INITIAL_ADAPTER_SHA256, "v0.5.7 pilot lineage differs.")
    outputs = metadata.get("outputs", {})
    require(outputs.get("runKind") == "pilot" and outputs.get("globalSteps") == 13 and outputs.get("rowsSeen") == 104 and outputs.get("epochsCompleted", 0) >= 0.999 and outputs.get("holdoutRowsRead") == 0, "v0.5.7 pilot coverage differs.")
    loss = outputs.get("lossReport", {})
    require(
        outputs.get("lossMaskPolicy") == "assistant-turns-only"
        and outputs.get("metadataPathsSanitized") is True
        and loss.get("finite") is True
        and all(math.isfinite(float(loss.get(field, math.nan))) for field in ("meanTrainingObjectiveLoss", "bestDevelopmentLoss", "finalDevelopmentLoss")),
        "v0.5.7 pilot loss integrity differs.",
    )
    tensor = adapter_root.resolve() / "adapter_model.safetensors"
    require(tensor.is_file() and not tensor.is_symlink(), "v0.5.7 pilot adapter tensor is unavailable.")
    tensor_sha = sha256_file(tensor)
    declared_items = outputs.get("adapterFiles", [])
    declared = {Path(str(item.get("path"))).name: item for item in declared_items}
    actual = {path.name: path for path in adapter_root.resolve().rglob("*") if path.is_file()}
    require(
        len(declared_items) == len(declared) == len(actual) == 6
        and set(declared) == set(actual) == set(EXPECTED_ADAPTER_FILES),
        "v0.5.7 pilot requires the exact six-file adapter inventory.",
    )
    for name in EXPECTED_ADAPTER_FILES:
        require(
            declared[name].get("sha256") == sha256_file(actual[name])
            and declared[name].get("sizeBytes") == actual[name].stat().st_size,
            f"v0.5.7 pilot adapter binding differs: {name}",
        )
    require(declared["adapter_model.safetensors"]["sha256"] == tensor_sha, "v0.5.7 pilot adapter tensor binding differs.")
    validation = outputs.get("adapterTensorValidation", {})
    require(validation.get("nonFiniteTensorCount") == 0 and validation.get("tensorCount") == 410 and validation.get("elementCount") == 12079104, "v0.5.7 pilot adapter integrity differs.")
    checkpoints = outputs.get("checkpoints", [])
    require(
        len(checkpoints) == 1
        and checkpoints[0].get("path") == "checkpoint-13"
        and checkpoints[0].get("fileCount") == 11
        and re.fullmatch(r"[a-f0-9]{64}", str(checkpoints[0].get("manifestSha256", ""))) is not None,
        "v0.5.7 checkpoint metadata differs.",
    )
    return metadata


def verify_panel_run_authorization(plan: dict[str, Any], args: argparse.Namespace) -> None:
    replacement = plan.get("replacementAuthorization", {})
    authorization = replacement.get("panelRunAuthorization")
    require(
        plan.get("status") == PANEL_AUTHORIZED_STATUS
        and plan.get("strictDecision") == PANEL_AUTHORIZED_DECISION
        and replacement.get("panelRunsAuthorized") == 3
        and replacement.get("panelRunsPerformed") == 2
        and replacement.get("panelRunsRemaining") == 1
        and replacement.get("panelRunsAuthorized") - replacement.get("panelRunsPerformed")
        == replacement.get("panelRunsRemaining")
        and isinstance(authorization, dict)
        and authorization.get("runId") == args.run_id
        and authorization.get("referenceSha256")
        == hashlib.sha256(args.authorization_ref.encode("utf-8")).hexdigest()
        and authorization.get("authorizedAt") == args.authorized_at
        and args.authorization_ref != CONSUMED_AUTHORIZATION_REFERENCE,
        "v0.5.7 panel authorization is exhausted; a new run-specific plan binding is required.",
    )


def verify_plan(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    plan_path = Path(args.plan).resolve(); code_root = Path(args.code_root).resolve()
    require(plan_path.is_file() and sha256_file(plan_path) == args.plan_sha256, "v0.5.7 next-pilot plan hash differs.")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    require(plan.get("schema") == "com.saferide.ai.v057-replacement-pilot-plan", "v0.5.7 replacement plan schema differs.")
    replacement = plan.get("replacementAuthorization", {})
    preflight_only = bool(getattr(args, "preflight_only", False))
    if args.mode == "pilot":
        require(
            plan.get("status") == "vps-validated-replacement-gpu-pilot-pending"
            and replacement.get("pilotRunsAuthorized") == 1
            and replacement.get("pilotRunsPerformed") == 0
            and replacement.get("automaticRetryAllowed") is False
            and replacement.get("panelConditionalOnValidPilot") is True
            and replacement.get("panelRunsPerformed") == 0
            and replacement.get("fullCandidateTrainingAuthorized") is False,
            "v0.5.7 replacement pilot authorization boundary differs.",
        )
    elif preflight_only:
        require(
            replacement.get("pilotRunsAuthorized") == 1
            and replacement.get("pilotRunsPerformed") == 1
            and replacement.get("automaticRetryAllowed") is False
            and replacement.get("panelConditionalOnValidPilot") is True
            and replacement.get("fullCandidateTrainingAuthorized") is False
            and replacement.get("holdoutAccessAuthorized") is False
            and (
                (
                    plan.get("status") == PANEL_PENDING_STATUS
                    and plan.get("strictDecision") == PANEL_PENDING_DECISION
                    and replacement.get("panelRunsAuthorized") == 2
                    and replacement.get("panelRunsPerformed") == 2
                    and replacement.get("panelRunsRemaining") == 0
                    and replacement.get("panelRunAuthorization") is None
                )
                or (
                    plan.get("status") == PANEL_AUTHORIZED_STATUS
                    and plan.get("strictDecision") == PANEL_AUTHORIZED_DECISION
                    and replacement.get("panelRunsAuthorized") == 3
                    and replacement.get("panelRunsPerformed") == 2
                    and replacement.get("panelRunsRemaining") == 1
                    and isinstance(replacement.get("panelRunAuthorization"), dict)
                )
            ),
            "v0.5.7 exact-artifact preflight requires the fail-closed pending or active single-run plan.",
        )
    else:
        verify_panel_run_authorization(plan, args)
        require(
            replacement.get("pilotRunsAuthorized") == 1
            and replacement.get("pilotRunsPerformed") == 1
            and replacement.get("automaticRetryAllowed") is False
            and replacement.get("panelConditionalOnValidPilot") is True
            and replacement.get("fullCandidateTrainingAuthorized") is False
            and replacement.get("holdoutAccessAuthorized") is False,
            "v0.5.7 replacement panel authorization boundary differs.",
        )
    if args.mode == "panel":
        pilot = plan.get("pilotExecution", {})
        require(
            pilot.get("valid") is True
            and pilot.get("attempts") == 1
            and pilot.get("runId") == "saferide-v057-pilot-s419805-replacement-002d8af"
            and pilot.get("planSha256") == EXPECTED_REPLACEMENT_PILOT_PLAN_SHA256
            and pilot.get("launchReceiptSha256") == EXPECTED_REPLACEMENT_PILOT_RECEIPT_SHA256
            and pilot.get("metadataSha256") == EXPECTED_REPLACEMENT_PILOT_METADATA_SHA256
            and pilot.get("adapterTensorSha256") == EXPECTED_REPLACEMENT_PILOT_ADAPTER_SHA256
            and pilot.get("holdoutRowsRead") == 0,
            "v0.5.7 valid replacement-pilot evidence differs.",
        )
    recipe = plan.get("recipe", {})
    require(
        recipe.get("initialAdapterTensorSha256") == EXPECTED_INITIAL_ADAPTER_SHA256
        and recipe.get("initialAdapterInventorySha256") == EXPECTED_INITIAL_ADAPTER_INVENTORY_SHA256
        and recipe.get("initialAdapterFileCount") == EXPECTED_INITIAL_ADAPTER_FILE_COUNT
        and recipe.get("initialAdapterTotalBytes") == EXPECTED_INITIAL_ADAPTER_SIZE
        and recipe.get("learningRate") == 5e-6,
        "v0.5.7 continuation recipe differs.",
    )
    require(plan.get("generation") == {"maxNewTokens": 192, "terminatorIds": [1, 106, 50], "terminatorSource": "pinned-model-generation-config", "zeroTruncationRequired": True}, "v0.5.7 generation contract differs.")
    for binding in plan.get("codeBindings", []):
        relative = binding.get("path")
        require(isinstance(relative, str) and V056.safe_relative(relative), "v0.5.7 code binding is unsafe.")
        target = code_root / relative
        require(target.is_file() and sha256_file(target) == binding.get("sha256"), f"v0.5.7 code binding differs: {Path(relative).name}")
    image = plan.get("runtime", {}).get("image", {})
    require(image.get("archiveSha256") == EXPECTED_IMAGE_SHA256 and image.get("archiveSizeBytes") == EXPECTED_IMAGE_SIZE and image.get("runtimeConfigDigest") == EXPECTED_IMAGE_CONFIG, "v0.5.7 runtime image binding differs.")
    image_archive = Path(args.image_archive).resolve()
    require(image_archive.is_file() and sha256_file(image_archive) == EXPECTED_IMAGE_SHA256 and image_archive.stat().st_size == EXPECTED_IMAGE_SIZE, "Governed runtime archive differs.")
    model_root = Path(args.model_dir).resolve(); model = plan.get("runtime", {}).get("baseModel", {})
    require(model.get("revision") == EXPECTED_MODEL_REVISION and model.get("fileCount") == 9, "Pinned base-model plan differs.")
    for item in model.get("files", []):
        path = model_root / item["path"]
        require(path.is_file() and sha256_file(path) == item["sha256"] and path.stat().st_size == item["sizeBytes"], f"Pinned base-model file differs: {path.name}")
    return plan, inventory(code_root)


def docker_common(args: argparse.Namespace, image_digest: str) -> list[str]:
    return [
        "docker", "run", "--rm", "--pull", "never", "--name", args.container_name,
        "--user", f"{os.getuid()}:{os.getgid()}", "--network", "none", "--gpus", "device=0",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "4096", "--cpus", "16", "--memory", "96g", "--memory-swap", "96g",
        "--shm-size", "8g", "--workdir", "/opt/saferide-v057",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=4g,mode=1777",
        "--env", "HOME=/tmp/saferide", "--env", "XDG_CACHE_HOME=/tmp/saferide/cache",
        "--env", "HF_HOME=/tmp/saferide/hf", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--env", "HF_HUB_OFFLINE=1", "--env", "HF_DATASETS_OFFLINE=1",
        "--env", "TRANSFORMERS_OFFLINE=1", "--env", "TOKENIZERS_PARALLELISM=false",
        "--env", "WANDB_DISABLED=true", "--env", "CUDA_VISIBLE_DEVICES=0",
        "--env", "NVIDIA_VISIBLE_DEVICES=0", "--env", "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        "--env", "WORLD_SIZE=1", "--entrypoint", "/bin/sh", f"sha256:{image_digest}",
    ]


def pid_descends_from(pid: int, ancestor_pid: int) -> bool:
    """Check PID ancestry without reading command lines or environments."""
    current = pid
    visited = set()
    for _index in range(64):
        if current == ancestor_pid:
            return True
        if current <= 1 or current in visited:
            return False
        visited.add(current)
        try:
            stat_value = Path(f"/proc/{current}/stat").read_text(encoding="utf-8")
            remainder = stat_value[stat_value.rfind(")") + 2:].split()
            current = int(remainder[1])
        except (OSError, ValueError, IndexError):
            return False
    return False


def gpu_pids_are_container_owned(processes: list[int], container_pid: Optional[int]) -> bool:
    return container_pid is not None and all(pid_descends_from(pid, container_pid) for pid in processes)


def monitor_gpu(process: subprocess.Popen[str], container_name: str, state: dict[str, Any]) -> None:
    minimum_free = 10**9
    peak_utilization = peak_temperature = maximum_processes = 0
    competing = False
    while process.poll() is None:
        try:
            _device, _total, free, utilization, temperature = V056.gpu_sample_once()
            processes = V056.compute_pids()
            minimum_free = min(minimum_free, free)
            peak_utilization = max(peak_utilization, utilization)
            peak_temperature = max(peak_temperature, temperature)
            maximum_processes = max(maximum_processes, len(processes))
            container_pid = None
            inspected = subprocess.run(
                ["docker", "container", "inspect", "--format", "{{.State.Pid}}", container_name],
                text=True, capture_output=True, timeout=10, check=False,
            )
            if inspected.returncode == 0 and inspected.stdout.strip().isdigit():
                container_pid = int(inspected.stdout.strip())
            if processes and not gpu_pids_are_container_owned(processes, container_pid):
                competing = True
                subprocess.run(
                    ["docker", "stop", "--time", "30", container_name],
                    text=True, capture_output=True, timeout=45, check=False,
                )
                break
        except Exception:
            state["monitorError"] = True
            try:
                subprocess.run(
                    ["docker", "stop", "--time", "30", container_name],
                    text=True, capture_output=True, timeout=45, check=False,
                )
            except Exception:
                pass
            break
        time.sleep(2)
    state.update({
        "minimumFreeVramMiB": None if minimum_free == 10**9 else minimum_free,
        "peakUtilizationPercent": peak_utilization,
        "peakTemperatureC": peak_temperature,
        "maximumComputeProcessCount": maximum_processes,
        "competingWorkloadObserved": competing,
        "onlySafeRideStopped": competing,
        "containerDescendantPidPolicy": True,
    })


V056.monitor_gpu = monitor_gpu


def pilot_command(args: argparse.Namespace, image_digest: str) -> list[str]:
    code = Path(args.code_root).resolve(); frozen = Path(args.frozen_dir).resolve()
    dev = Path(args.dev_data).resolve(); model = Path(args.model_dir).resolve()
    initial = Path(args.initial_adapter).resolve(); model_output = Path(args.model_output_dir).resolve()
    checkpoints = Path(args.checkpoint_dir).resolve()
    shell = " ".join([
        "umask 077; exec python scripts/saferide-gemma4-v057-finetune-runner.py run",
        "--frozen-dir /opt/saferide-input", "--dev-data /opt/saferide-dev/original-development.jsonl",
        "--initial-adapter /opt/saferide-initial-adapter", "--base-model-path /opt/saferide-model",
        "--output-root /opt/ml/model", "--checkpoint-root /opt/ml/checkpoints", f"--run-id {args.run_id}",
    ])
    values = docker_common(args, image_digest)
    insertion = values.index("--entrypoint")
    mounts = [
        "--mount", V056.mount(code, "/opt/saferide-v057", readonly=True),
        "--mount", V056.mount(frozen, "/opt/saferide-input", readonly=True),
        "--mount", V056.mount(dev.parent, "/opt/saferide-dev", readonly=True),
        "--mount", V056.mount(model, "/opt/saferide-model", readonly=True),
        "--mount", V056.mount(initial, "/opt/saferide-initial-adapter", readonly=True),
        "--mount", V056.mount(model_output, "/opt/ml/model", readonly=False),
        "--mount", V056.mount(checkpoints, "/opt/ml/checkpoints", readonly=False),
    ]
    return values[:insertion] + mounts + values[insertion:] + ["-c", shell]


def panel_command(args: argparse.Namespace, plan: dict[str, Any], image_digest: str) -> list[str]:
    code = Path(args.code_root).resolve(); panel_input = Path(args.panel_input).resolve()
    model = Path(args.model_dir).resolve(); adapter = Path(args.adapter_root).resolve()
    metadata = Path(args.pilot_metadata).resolve(); output = Path(args.output_data_dir).resolve() / "panel"
    plan_path = Path(args.plan).resolve()
    shell = " ".join([
        "umask 077; python scripts/saferide-gemma4-v057-pilot-panel.py run",
        "--panel-input /opt/saferide-panel", "--model-root /opt/saferide-model",
        "--adapter-root /opt/saferide-adapter", "--pilot-metadata /opt/saferide-pilot/metadata.json",
        "--plan /opt/saferide-plan/plan.json",
        "--output-root /opt/ml/output/panel",
        "&& exec python scripts/saferide-gemma4-v057-pilot-panel.py verify-output",
        "--panel-input /opt/saferide-panel", "--output-root /opt/ml/output/panel",
    ])
    values = docker_common(args, image_digest)
    insertion = values.index("--entrypoint")
    mounts = [
        "--mount", V056.mount(code, "/opt/saferide-v057", readonly=True),
        "--mount", V056.mount(plan_path, "/opt/saferide-plan/plan.json", readonly=True),
        "--mount", V056.mount(panel_input, "/opt/saferide-panel", readonly=True),
        "--mount", V056.mount(model, "/opt/saferide-model", readonly=True),
        "--mount", V056.mount(adapter, "/opt/saferide-adapter", readonly=True),
        "--mount", V056.mount(metadata.parent, "/opt/saferide-pilot", readonly=True),
        "--mount", V056.mount(output, "/opt/ml/output/panel", readonly=False),
        "--env", f"SAFERIDE_PANEL_IMAGE_DIGEST={plan['runtime']['image']['runtimeManifestDigest']}",
    ]
    return values[:insertion] + mounts + values[insertion:] + ["-c", shell]


def panel_preflight_command(args: argparse.Namespace, plan: dict[str, Any], image_digest: str) -> list[str]:
    code = Path(args.code_root).resolve(); model = Path(args.model_dir).resolve()
    adapter = Path(args.adapter_root).resolve(); metadata = Path(args.pilot_metadata).resolve()
    output = Path(args.output_data_dir).resolve() / "preflight"; plan_path = Path(args.plan).resolve()
    shell = " ".join([
        "umask 077; exec python scripts/saferide-gemma4-v057-pilot-panel.py preflight",
        "--model-root /opt/saferide-model", "--adapter-root /opt/saferide-adapter",
        "--pilot-metadata /opt/saferide-pilot/metadata.json",
        "--plan /opt/saferide-plan/plan.json", "--output-root /opt/ml/output/preflight",
    ])
    values = docker_common(args, image_digest)
    insertion = values.index("--entrypoint")
    mounts = [
        "--mount", V056.mount(code, "/opt/saferide-v057", readonly=True),
        "--mount", V056.mount(plan_path, "/opt/saferide-plan/plan.json", readonly=True),
        "--mount", V056.mount(model, "/opt/saferide-model", readonly=True),
        "--mount", V056.mount(adapter, "/opt/saferide-adapter", readonly=True),
        "--mount", V056.mount(metadata.parent, "/opt/saferide-pilot", readonly=True),
        "--mount", V056.mount(output, "/opt/ml/output/preflight", readonly=False),
        "--env", f"SAFERIDE_PANEL_IMAGE_DIGEST={plan['runtime']['image']['runtimeManifestDigest']}",
    ]
    return values[:insertion] + mounts + values[insertion:] + ["-c", shell]


def validate_mode_inputs(args: argparse.Namespace, plan: dict[str, Any]) -> None:
    output = Path(args.output_data_dir).resolve(); runtime = Path(args.runtime_root).resolve()
    empty_private_directory(output, "Output-data root"); empty_private_directory(runtime, "Runtime root")
    if args.mode == "pilot":
        frozen = Path(args.frozen_dir).resolve(); dev = Path(args.dev_data).resolve()
        model_output = Path(args.model_output_dir).resolve(); checkpoints = Path(args.checkpoint_dir).resolve()
        initial = Path(args.initial_adapter).resolve()
        empty_private_directory(model_output, "Model-output root"); empty_private_directory(checkpoints, "Checkpoint root")
        gate = verify_frozen_training_inputs(frozen, dev, plan)
        require(gate["manifestSha256"] == plan["dataset"]["frozenManifestSha256"], "v0.5.7 frozen dataset differs from plan.")
        require(sha256_file(initial / "adapter_model.safetensors") == EXPECTED_INITIAL_ADAPTER_SHA256, "v0.5.7 initial adapter differs.")
        initial_inventory = inventory(initial)
        recipe = plan["recipe"]
        require(
            initial_inventory["sha256"] == recipe["initialAdapterInventorySha256"]
            and initial_inventory["fileCount"] == recipe["initialAdapterFileCount"]
            and initial_inventory["sizeBytes"] == recipe["initialAdapterTotalBytes"],
            "v0.5.7 initial adapter inventory differs.",
        )
    else:
        adapter = Path(args.adapter_root).resolve(); metadata = Path(args.pilot_metadata).resolve()
        if not args.preflight_only:
            panel_input = Path(args.panel_input).resolve()
            require(sha256_file(panel_input / "data/original-development.jsonl") == EXPECTED_ORIGINAL_DEVELOPMENT_SHA256 and sha256_file(panel_input / "data/mitigation-development.jsonl") == EXPECTED_MITIGATION_DEVELOPMENT_SHA256, "Frozen panel input differs.")
        verify_pilot_output(metadata, adapter)
        pilot = plan["pilotExecution"]
        require(
            sha256_file(metadata) == pilot["metadataSha256"]
            and sha256_file(adapter / "adapter_model.safetensors") == pilot["adapterTensorSha256"]
            and inventory(adapter)["sha256"] == pilot["adapterInventorySha256"],
            "Replacement-pilot panel lineage differs.",
        )


def validate_outputs(args: argparse.Namespace) -> dict[str, Any]:
    if args.mode == "pilot":
        run_root = Path(args.model_output_dir).resolve() / args.run_id
        metadata_path = run_root / "metadata.json"
        adapter_root = run_root / "adapter"
        metadata = verify_pilot_output(metadata_path, adapter_root)
        controlled_roots = [
            Path(args.frozen_dir).resolve(), Path(args.dev_data).resolve(),
            Path(args.initial_adapter).resolve(), Path(args.model_dir).resolve(),
            Path(args.model_output_dir).resolve(), Path(args.checkpoint_dir).resolve(),
        ]
        serialized = json.dumps(metadata, sort_keys=True, allow_nan=False)
        require(all(str(root) not in serialized for root in controlled_roots), "v0.5.7 completed metadata contains a private host path.")
        outputs = metadata["outputs"]
        checkpoint = Path(args.checkpoint_dir).resolve() / args.run_id / "checkpoint-13"
        require(checkpoint.is_dir() and not checkpoint.is_symlink(), "v0.5.7 checkpoint-13 is unavailable.")
        checkpoint_inventory = inventory(checkpoint)
        adapter_inventory = inventory(adapter_root)
        model_output_inventory = inventory(run_root)
        initial_inventory = inventory(Path(args.initial_adapter).resolve())
        require(
            initial_inventory["sha256"] == metadata["initialAdapter"]["inventorySha256"]
            and initial_inventory["fileCount"] == metadata["initialAdapter"]["inventoryFileCount"]
            and initial_inventory["sizeBytes"] == metadata["initialAdapter"]["inventorySizeBytes"],
            "Initial v0.5.6 adapter changed during continuation.",
        )
        return {
            "metadataSha256": sha256_file(metadata_path), "globalSteps": outputs["globalSteps"],
            "rowsSeen": outputs["rowsSeen"], "epochsCompleted": outputs["epochsCompleted"],
            "sampleOrderSha256": outputs["sampleOrderSha256"], "loss": outputs["lossReport"],
            "adapterTensorValidation": outputs["adapterTensorValidation"],
            "adapterTensorSha256": next(item["sha256"] for item in outputs["adapterFiles"] if Path(item["path"]).name == "adapter_model.safetensors"),
            "adapterInventory": adapter_inventory, "checkpointInventory": checkpoint_inventory,
            "modelOutputInventory": model_output_inventory, "initialAdapterInventory": initial_inventory,
            "adapterFileCount": len(outputs["adapterFiles"]), "checkpointCount": len(outputs["checkpoints"]),
            "holdoutRowsRead": outputs["holdoutRowsRead"], "lossMaskPolicy": outputs["lossMaskPolicy"],
            "runKind": outputs["runKind"], "metadataCompleteAndSanitized": True,
        }
    if args.preflight_only:
        output = Path(args.output_data_dir).resolve() / "preflight"
        summary_path = output / "content-free/exact-artifact-preflight.json"
        summary = read_controlled_json(summary_path, "v0.5.7 exact-artifact preflight summary")
        runtime = summary.get("runtime", {})
        coverage = summary.get("coverage", {})
        require(
            summary.get("schema") == "com.saferide.ai.private-v057-exact-artifact-preflight"
            and summary.get("status") == "passed"
            and runtime.get("tokenizerEosTokenId") == 1
            and runtime.get("padTokenId") == 0
            and runtime.get("paddingSide") == "left"
            and runtime.get("terminatorIds") == [1, 106, 50]
            and runtime.get("tokenizerLoaded") is True
            and runtime.get("modelLoaded") is True
            and runtime.get("adapterLoaded") is True
            and runtime.get("unloadedCleanly") is True
            and coverage == {
                "panelRowsRead": 0, "modelCompletionsEmitted": 0,
                "generationCalls": 0, "sealedHoldoutRowsRead": 0,
            },
            "v0.5.7 exact-artifact preflight output differs.",
        )
        return {
            "preflightSummarySha256": sha256_file(summary_path),
            "status": "passed", "runtime": runtime, "coverage": coverage,
        }
    output = Path(args.output_data_dir).resolve() / "panel"
    summary_path = output / "content-free/pilot-panel-summary.json"
    summary = read_controlled_json(summary_path, "v0.5.7 panel summary")
    require(summary.get("combined", {}).get("rowCount") == 320 and summary.get("privacy", {}).get("sealedHoldoutRead") is False, "v0.5.7 panel output differs.")
    replay = read_controlled_json(output / "content-free/pilot-panel-replay.json", "v0.5.7 panel replay receipt")
    require(
        replay.get("status") == "passed"
        and replay.get("summarySha256") == sha256_file(summary_path)
        and replay.get("generatedResponsesRead") == 320
        and replay.get("generationRerun") is False
        and replay.get("sealedHoldoutRead") is False
        and replay.get("containsRawContent") is False,
        "v0.5.7 independent panel replay receipt differs.",
    )
    return {
        "summarySha256": sha256_file(summary_path), "status": summary["status"],
        "combined": summary["combined"], "byLanguage": summary["byLanguage"],
        "byCategory": summary["byCategory"], "byVariant": summary["byVariant"],
        "integrity": summary["integrity"], "eligibility": summary["eligibility"],
        "criticalAdjudication": summary["criticalAdjudication"],
    }


def launch(args: argparse.Namespace) -> int:
    os.umask(0o077)
    require(RUN_PATTERNS[args.mode].fullmatch(args.run_id) is not None and CONTAINER_PATTERN.fullmatch(args.container_name) is not None, "v0.5.7 run or container identity is unsafe.")
    if args.preflight_only:
        require(args.mode == "panel" and args.authorization_ref is None and args.authorized_at is None, "Exact-artifact preflight must not bind or consume panel authorization.")
    elif args.mode == "pilot":
        require(args.authorization_ref == CONSUMED_AUTHORIZATION_REFERENCE, "v0.5.7 replacement pilot authorization reference differs.")
    if not args.preflight_only:
        authorized = dt.datetime.fromisoformat(args.authorized_at.replace("Z", "+00:00"))
        require(authorized.tzinfo is not None and authorized <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5), "v0.5.7 authorization time is invalid.")
    plan, code_inventory = verify_plan(args)
    validate_mode_inputs(args, plan)
    existing = subprocess.run(["docker", "container", "inspect", args.container_name], text=True, capture_output=True, timeout=10, check=False)
    require(existing.returncode != 0, "Selected SafeRide container identity already exists.")
    lock = V056.acquire_lock()
    failure: dict[str, Any] = {"startedAt": None, "exitCode": None, "monitor": None}
    try:
        inspect_image(plan, EXPECTED_IMAGE_CONFIG)
        snapshot = V056.sample_idle_gpu()
        snapshot.update({
            "schema": "com.saferide.ai.v057-host-gpu-snapshot", "schemaVersion": 1,
            "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "mode": "preflight" if args.preflight_only else args.mode,
            "planSha256": args.plan_sha256, "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False},
        })
        write_private_json(Path(args.output_data_dir).resolve() / "host-gpu-snapshot.json", snapshot)
        if args.mode == "panel":
            operation_output = Path(args.output_data_dir).resolve() / ("preflight" if args.preflight_only else "panel")
            require(not operation_output.exists(), "Selected output payload root already exists; overwrites are forbidden.")
            operation_output.mkdir(mode=0o700)
        if args.mode == "pilot":
            command = pilot_command(args, EXPECTED_IMAGE_CONFIG)
        elif args.preflight_only:
            command = panel_preflight_command(args, plan, EXPECTED_IMAGE_CONFIG)
        else:
            command = panel_command(args, plan, EXPECTED_IMAGE_CONFIG)
        started = dt.datetime.now(dt.timezone.utc); failure["startedAt"] = started.isoformat()
        exit_code, monitor, log_sha = V056.run_container(command, args)
        failure.update({"exitCode": exit_code, "monitor": monitor, "sanitizedLogSha256": log_sha})
        require(not monitor.get("competingWorkloadObserved") and not monitor.get("monitorError"), "GPU isolation monitor failed; only the SafeRide container was stopped.")
        require(exit_code == 0, "SafeRide v0.5.7 container exited unsuccessfully.")
        _device, _total, free, utilization, temperature = V056.gpu_sample_once(); processes = len(V056.compute_pids())
        require(processes == 0, "A GPU workload is active after SafeRide exit; no unrelated process was changed.")
        monitor["finalState"] = {"freeVramMiB": free, "utilizationPercent": utilization, "temperatureC": temperature, "computeProcessCount": processes}
        result = validate_outputs(args); finished = dt.datetime.now(dt.timezone.utc)
        receipt = {
            "schema": "com.saferide.ai.v057-launch-receipt", "schemaVersion": 1,
            "status": "completed", "mode": "preflight" if args.preflight_only else args.mode, "runId": args.run_id,
            "startedAt": started.isoformat(), "finishedAt": finished.isoformat(),
            "wallSeconds": round((finished - started).total_seconds(), 3), "exitCode": exit_code,
            "authorization": None if args.preflight_only else {"referenceSha256": hashlib.sha256(args.authorization_ref.encode()).hexdigest(), "authorizedAt": args.authorized_at},
            "bindings": {"planSha256": args.plan_sha256, "codeInventory": code_inventory, "sanitizedLogSha256": log_sha, "runtimeConfigDigest": EXPECTED_IMAGE_CONFIG},
            "idleGate": snapshot, "monitor": monitor, "result": result,
            "isolation": {"device": 0, "network": "none", "readOnlyRoot": True, "readOnlyInputs": True, "cpuLimit": 16, "memoryLimitGiB": 96},
            "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False, "sealedHoldoutRead": False},
            "preflightOnly": args.preflight_only, "generationStarted": False if args.preflight_only else args.mode == "panel",
            "generationRerun": False, "fullCandidateStarted": False, "promotionEligible": False,
        }
        receipt_path = Path(args.output_data_dir).resolve() / "launch-receipt.json"
        write_private_json(receipt_path, receipt)
        operation = "exact-artifact preflight" if args.preflight_only else args.mode
        print(f"SafeRide v0.5.7 {operation} launch PASS (one bounded operation; promotion false).")
        return 0
    except Exception as error:
        roots = [
            Path(value).resolve() for value in (
                args.plan, args.code_root, args.model_dir, args.image_archive,
                args.output_data_dir, args.runtime_root, args.frozen_dir, args.dev_data,
                args.initial_adapter, args.model_output_dir, args.checkpoint_dir,
                args.panel_input, args.adapter_root, args.pilot_metadata,
            ) if value
        ]
        reason = V056.sanitized_line(str(error), roots) or "SafeRide v0.5.7 execution failed closed."
        try:
            write_private_json(Path(args.output_data_dir).resolve() / "launch-failure-receipt.json", {
                "schema": "com.saferide.ai.v057-launch-receipt", "schemaVersion": 1,
                "status": "failed", "mode": "preflight" if args.preflight_only else args.mode, "runId": args.run_id,
                "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "startedAt": failure["startedAt"],
                "exitCode": failure["exitCode"], "reason": reason, "monitor": failure["monitor"],
                "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False, "sealedHoldoutRead": False},
                "generationRerun": False, "fullCandidateStarted": False, "promotionEligible": False,
            })
        except Exception:
            pass
        raise
    finally:
        lock.close()


def contract_check() -> int:
    require(V056.MINIMUM_FREE_VRAM_MIB == 22000 and V056.GPU_SAMPLE_COUNT == 16 and V056.GPU_SAMPLE_INTERVAL_SECONDS == 2, "A11 30-second idle contract differs.")
    require(EXPECTED_INITIAL_ADAPTER_SHA256 == "6894f08954364b6a883bf39642d113de0fa7c17670811d41ab35bc22e5cb61c4", "v0.5.7 adapter lineage differs.")
    require(EXPECTED_INITIAL_ADAPTER_INVENTORY_SHA256 == "7f5715a366c323bbf6da67f8e1ed5c219d697af83ab3a126c52b1366561656f1" and EXPECTED_INITIAL_ADAPTER_FILE_COUNT == 6 and EXPECTED_INITIAL_ADAPTER_SIZE == 80584074, "v0.5.7 initial adapter inventory differs.")
    require(set(RUN_PATTERNS) == {"pilot", "panel"} and len(EXPECTED_ADAPTER_FILES) == 6, "v0.5.7 launcher exposes an unauthorized mode or adapter shape.")
    require(PANEL_AUTHORIZED_STATUS == "code-fixed-panel-run-authorized" and PANEL_PENDING_STATUS == "code-fixed-panel-authorization-pending" and CONSUMED_AUTHORIZATION_REFERENCE.startswith("ESH-4198-v057-"), "v0.5.7 panel authorization contract differs.")
    print("SafeRide v0.5.7 GPU launcher contract PASS (prior panel consumed; fresh run-specific authorization required).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("contract-check")
    launch_parser = sub.add_parser("launch")
    launch_parser.add_argument("--mode", choices=["pilot", "panel"], required=True)
    for name in ("plan", "plan-sha256", "code-root", "model-dir", "image-archive", "output-data-dir", "runtime-root", "run-id", "container-name"):
        launch_parser.add_argument(f"--{name}", required=True)
    launch_parser.add_argument("--authorization-ref"); launch_parser.add_argument("--authorized-at")
    launch_parser.add_argument("--preflight-only", action="store_true")
    launch_parser.add_argument("--frozen-dir"); launch_parser.add_argument("--dev-data")
    launch_parser.add_argument("--initial-adapter"); launch_parser.add_argument("--model-output-dir")
    launch_parser.add_argument("--checkpoint-dir"); launch_parser.add_argument("--panel-input")
    launch_parser.add_argument("--adapter-root"); launch_parser.add_argument("--pilot-metadata")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check())
        require(not parsed.preflight_only or parsed.mode == "panel", "Exact-artifact preflight is panel-runtime only.")
        required = (
            ("frozen_dir", "dev_data", "initial_adapter", "model_output_dir", "checkpoint_dir")
            if parsed.mode == "pilot"
            else ("adapter_root", "pilot_metadata") if parsed.preflight_only
            else ("panel_input", "adapter_root", "pilot_metadata")
        )
        require(all(getattr(parsed, name) for name in required), f"v0.5.7 {parsed.mode} inputs are incomplete.")
        require(parsed.preflight_only or (parsed.authorization_ref and parsed.authorized_at), "v0.5.7 execution authorization arguments are incomplete.")
        raise SystemExit(launch(parsed))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        message = re.sub(r"\s+", " ", str(error))[:500]
        print(f"SafeRide v0.5.7 launch blocked: {message}", file=sys.stderr)
        raise SystemExit(1)
