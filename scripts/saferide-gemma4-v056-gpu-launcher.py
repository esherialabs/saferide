#!/usr/bin/env python3
"""Fail-closed A11 launcher for the SafeRide v0.5.6 final pilot and panel."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_PATH = REPO_ROOT / "config/ai/datasets/saferide-gemma4-v056-next-pilot-plan.json"
PORTABLE_V053_PATH = REPO_ROOT / "scripts/saferide-gemma4-v053-portable-launcher.py"
LOCK_PATH = Path("/tmp/saferide-esh4198-v056-gpu.lock")
MINIMUM_FREE_VRAM_MIB = 22000
MAXIMUM_IDLE_UTILIZATION_PERCENT = 1
GPU_SAMPLE_COUNT = 16
GPU_SAMPLE_INTERVAL_SECONDS = 2
EXPECTED_FROZEN_MANIFEST_SHA256 = "9900b4d55eef76d5dcc2deead3a5586695f08aaaea38ebbe6783ee5f23138dc0"
EXPECTED_ORIGINAL_DEVELOPMENT_SHA256 = "434d7961ca8707f7b0ce847b0817493b71a92bc845a9862a472b5ea6b46d8881"
RUN_ID_PATTERN = re.compile(r"^saferide-v056-(?:preflight|pilot|panel)-[a-z0-9][a-z0-9-]{7,79}$")
CONTAINER_PATTERN = re.compile(r"^sr4198-v056-(?:preflight|pilot|panel)-[a-z0-9]{4,16}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
SAFE_AUTHORIZATION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")
PROHIBITED_PATH_PATTERN = re.compile(r"(?i)(?:holdout|blind|protected|reviewer|candidate-2|selection|promotion|deploy|publish)")


class LaunchError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise LaunchError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def read_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"Required controlled JSON is unavailable: {path.name}")
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"Controlled JSON is not an object: {path.name}")
    return value


def read_jsonl_ids(path: Path, expected_split: str) -> list[str]:
    values: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            value = json.loads(line)
            require(isinstance(value, dict) and value.get("split") == expected_split, "Controlled row split differs.")
            identifier = value.get("id")
            require(isinstance(identifier, str) and identifier and identifier not in values, "Controlled row identity differs.")
            values.append(identifier)
    return values


def write_private_json(path: Path, value: Any) -> None:
    path.write_bytes(canonical_bytes(value))
    path.chmod(0o600)


def private_directory(path: Path, label: str) -> None:
    require(path.is_dir() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, f"{label} must be mode 0700.")


def private_file(path: Path, label: str) -> None:
    require(path.is_file() and not path.is_symlink(), f"{label} is unavailable or unsafe.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o600, f"{label} must be mode 0600.")


def safe_relative(value: str) -> bool:
    candidate = Path(value)
    return bool(value) and not candidate.is_absolute() and ".." not in candidate.parts and not PROHIBITED_PATH_PATTERN.search(value)


def tree_inventory(root: Path, *, allow_empty: bool = False) -> dict[str, Any]:
    private_directory(root, "Controlled inventory root")
    records = []
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Controlled inventory contains a symlink.")
        if path.is_dir():
            require(stat.S_IMODE(path.stat().st_mode) == 0o700, "Controlled inventory directory permissions differ.")
        elif path.is_file():
            require(stat.S_IMODE(path.stat().st_mode) == 0o600, "Controlled inventory file permissions differ.")
            relative = path.relative_to(root).as_posix()
            require(not PROHIBITED_PATH_PATTERN.search(relative), "Controlled inventory contains a protected path.")
            records.append({"path": relative, "sha256": sha256_file(path), "sizeBytes": path.stat().st_size})
        else:
            raise LaunchError("Controlled inventory contains a non-regular entry.")
    require(allow_empty or bool(records), "Controlled inventory is unexpectedly empty.")
    return {
        "sha256": sha256_bytes(canonical_bytes(records)),
        "fileCount": len(records),
        "totalBytes": sum(item["sizeBytes"] for item in records),
    }


def require_empty(root: Path, label: str) -> None:
    private_directory(root, label)
    require(not any(root.iterdir()), f"{label} must be newly empty.")


def load_portable_v053() -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("saferide_v056_oci_verifier", PORTABLE_V053_PATH)
    require(spec is not None and spec.loader is not None, "Governed OCI verifier is unavailable.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def verify_plan_and_inputs(args: argparse.Namespace) -> tuple[dict[str, Any], str, dict[str, Any]]:
    plan_path = Path(args.plan).expanduser().resolve()
    code_root = Path(args.code_root).expanduser().resolve()
    model_root = Path(args.model_dir).expanduser().resolve()
    image_archive = Path(args.image_archive).expanduser().resolve()
    private_file(plan_path, "v0.5.6 next-pilot plan")
    private_directory(code_root, "v0.5.6 code root")
    private_directory(model_root, "Pinned model root")
    private_file(image_archive, "Governed OCI archive")
    require(SHA256_PATTERN.fullmatch(args.plan_sha256) is not None and sha256_file(plan_path) == args.plan_sha256, "v0.5.6 next-pilot plan hash differs.")
    plan = read_json(plan_path)
    require(plan.get("schema") == "com.saferide.ai.v056-next-pilot-plan" and plan.get("strictDecision") == "NO-GO-PENDING-FUTURE-GPU-PILOT", "v0.5.6 next-pilot plan state differs.")
    require(plan.get("dataset", {}).get("frozenManifestSha256") == EXPECTED_FROZEN_MANIFEST_SHA256, "Frozen v0.5.6 manifest binding differs.")
    expected_code = {item["path"]: item for item in plan.get("codeBindings", [])}
    actual_code = {
        path.relative_to(code_root).as_posix(): path
        for path in code_root.rglob("*") if path.is_file()
    }
    require(set(actual_code) == set(expected_code), "Staged v0.5.6 code inventory differs from the frozen plan.")
    for relative, path in actual_code.items():
        private_file(path, "Staged v0.5.6 code file")
        require(safe_relative(relative) and sha256_file(path) == expected_code[relative]["sha256"], f"Staged v0.5.6 code bytes differ: {Path(relative).name}")
    model = plan["runtime"]["baseModel"]
    expected_model = {item["path"]: item for item in model["files"]}
    actual_model = {path.name: path for path in model_root.iterdir() if path.is_file()}
    require(set(actual_model) == set(expected_model) and len(actual_model) == model["fileCount"], "Pinned nine-file model inventory differs.")
    for name, path in actual_model.items():
        private_file(path, "Pinned model file")
        require(path.stat().st_size == expected_model[name]["sizeBytes"] and sha256_file(path) == expected_model[name]["sha256"], f"Pinned model bytes differ: {name}")
    require(sum(path.stat().st_size for path in actual_model.values()) == model["totalBytes"], "Pinned model total bytes differ.")
    generation = read_json(model_root / "generation_config.json")
    require(generation.get("eos_token_id") == [1, 106, 50], "Pinned model terminator inventory differs.")
    image = plan["runtime"]["image"]
    require(image_archive.stat().st_size == image["archiveSizeBytes"] and sha256_file(image_archive) == image["archiveSha256"], "Governed OCI archive bytes differ.")
    portable = load_portable_v053()
    compatible_plan = {
        "image": {"digest": image["runtimeManifestDigest"]},
        "launcherSourceCommit": image["launcherSourceCommit"],
    }
    config_digest = portable.verify_oci_image_archive(
        image_archive,
        expected_archive_sha256=image["archiveSha256"],
        expected_manifest_digest=image["runtimeManifestDigest"],
        plan=compatible_plan,
    )
    require(config_digest == image["runtimeConfigDigest"], "Governed OCI runtime config digest differs.")
    frozen_inventory: dict[str, Any] = {"sha256": None, "fileCount": 0, "totalBytes": 0}
    if args.mode in {"preflight", "pilot"}:
        frozen_root = Path(args.frozen_dir).expanduser().resolve()
        dev_path = Path(args.dev_data).expanduser().resolve()
        private_directory(frozen_root, "Frozen v0.5.6 root")
        private_directory(dev_path.parent, "Frozen original-development root")
        private_file(dev_path, "Frozen original-development input")
        require(dev_path.name == "original-development.jsonl" and {path.name for path in dev_path.parent.iterdir()} == {dev_path.name}, "Development mount must contain exactly the frozen 300-row file.")
        require(sha256_file(dev_path) == EXPECTED_ORIGINAL_DEVELOPMENT_SHA256, "Frozen 300-row development bytes differ.")
        manifest_path = frozen_root / "frozen-manifest.private.json"
        private_file(manifest_path, "Frozen v0.5.6 manifest")
        require(sha256_file(manifest_path) == EXPECTED_FROZEN_MANIFEST_SHA256, "Frozen v0.5.6 manifest bytes differ.")
        frozen = read_json(manifest_path)
        declared = {item["path"]: item for item in frozen.get("files", [])}
        for relative, item in declared.items():
            target = frozen_root / relative
            private_file(target, "Frozen v0.5.6 artifact")
            require(target.stat().st_size == item["sizeBytes"] and sha256_file(target) == item["sha256"], f"Frozen v0.5.6 artifact differs: {relative}")
        require(frozen.get("bindings", {}).get("combinedTrainSha256") == plan["dataset"]["combinedTrainSha256"], "Frozen train binding differs from the next-pilot plan.")
        require(frozen.get("bindings", {}).get("trainingRecipeSha256") == plan["dataset"]["trainingRecipeSha256"], "Frozen recipe binding differs from the next-pilot plan.")
        frozen_inventory = tree_inventory(frozen_root)
    elif args.mode == "panel":
        panel_input = Path(args.panel_input).expanduser().resolve()
        private_directory(panel_input, "Frozen v0.5.6 panel input")
        private_file(panel_input / "panel-input-manifest.json", "Frozen v0.5.6 panel manifest")
    return plan, config_digest, frozen_inventory


def checked(arguments: list[str], label: str, *, timeout: int = 30) -> str:
    try:
        result = subprocess.run(arguments, text=True, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise LaunchError(f"{label} could not be read.") from error
    require(result.returncode == 0, f"{label} read-only inspection failed.")
    return result.stdout.strip()


def gpu_sample_once() -> tuple[int, int, int, int, int]:
    output = checked(["nvidia-smi", "--id=0", "--query-gpu=index,memory.total,memory.free,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"], "GPU inventory")
    rows = [row.strip() for row in output.splitlines() if row.strip()]
    require(len(rows) == 1, "GPU inventory must resolve exactly device 0.")
    values = [int(value.strip()) for value in rows[0].split(",")]
    require(len(values) == 5 and values[0] == 0, "GPU inventory format differs.")
    return values[0], values[1], values[2], values[3], values[4]


def compute_pids() -> list[int]:
    output = checked(["nvidia-smi", "--id=0", "--query-compute-apps=pid", "--format=csv,noheader,nounits"], "GPU occupancy")
    values = []
    for line in output.splitlines():
        value = line.strip()
        if value and "no running" not in value.lower():
            require(value.isdigit(), "GPU occupancy format differs.")
            values.append(int(value))
    return values


def sample_idle_gpu() -> dict[str, Any]:
    minimum_free = 10**9
    peak_utilization = 0
    maximum_processes = 0
    total = temperature = 0
    for index in range(GPU_SAMPLE_COUNT):
        _device, total, free, utilization, temperature = gpu_sample_once()
        processes = len(compute_pids())
        minimum_free = min(minimum_free, free)
        peak_utilization = max(peak_utilization, utilization)
        maximum_processes = max(maximum_processes, processes)
        if index + 1 < GPU_SAMPLE_COUNT:
            time.sleep(GPU_SAMPLE_INTERVAL_SECONDS)
    passed = minimum_free >= MINIMUM_FREE_VRAM_MIB and peak_utilization <= MAXIMUM_IDLE_UTILIZATION_PERCENT and maximum_processes == 0
    require(passed, "GPU idle gate failed; stop without changing another workload.")
    return {
        "sampleCount": GPU_SAMPLE_COUNT,
        "sampleDurationSeconds": (GPU_SAMPLE_COUNT - 1) * GPU_SAMPLE_INTERVAL_SECONDS,
        "deviceIndex": 0,
        "totalVramMiB": total,
        "minimumFreeVramMiB": minimum_free,
        "peakUtilizationPercent": peak_utilization,
        "maximumComputeProcessCount": maximum_processes,
        "finalTemperatureC": temperature,
        "gatePassed": True,
    }


def inspect_image(plan: dict[str, Any], config_digest: str) -> None:
    reference = f"sha256:{config_digest}"
    output = checked(["docker", "image", "inspect", reference], "Pinned Docker image")
    values = json.loads(output)
    require(isinstance(values, list) and len(values) == 1, "Pinned Docker image inspection differs.")
    image = values[0]
    require(str(image.get("Id", "")).removeprefix("sha256:") == config_digest, "Pinned Docker image ID differs.")
    labels = image.get("Config", {}).get("Labels", {})
    expected = plan["runtime"]["image"]
    require(
        labels.get("org.opencontainers.image.title") == expected["title"]
        and labels.get("org.opencontainers.image.revision") == expected["launcherSourceCommit"]
        and labels.get("com.saferide.base-model-revision") == plan["runtime"]["baseModel"]["revision"]
        and labels.get("com.saferide.issue") == "ESH-4198",
        "Pinned Docker image labels differ.",
    )


def validate_authorization(args: argparse.Namespace) -> None:
    require(SAFE_AUTHORIZATION_PATTERN.fullmatch(args.authorization_ref) is not None, "Authorization reference is missing or unsafe.")
    require("url" not in args.authorization_ref.lower() and "token" not in args.authorization_ref.lower(), "Authorization reference may not contain a URL or token.")
    expected_kind = f"v056-{args.mode}"
    require(args.authorization_kind == expected_kind, "Authorization kind differs from the selected operation.")
    try:
        value = dt.datetime.fromisoformat(args.authorized_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise LaunchError("Authorization time is invalid.") from error
    require(value.tzinfo is not None and value >= dt.datetime(2026, 8, 8, tzinfo=dt.timezone.utc), "Authorization predates the governed v0.5.6 window.")
    require(value <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5), "Authorization time is in the future.")


def mount(source: Path, target: str, *, readonly: bool) -> str:
    value = f"type=bind,src={source},dst={target}"
    return f"{value},readonly" if readonly else value


def training_command(args: argparse.Namespace, plan: dict[str, Any], config_digest: str) -> list[str]:
    code = Path(args.code_root).resolve()
    frozen = Path(args.frozen_dir).resolve()
    dev = Path(args.dev_data).resolve()
    model = Path(args.model_dir).resolve()
    runtime = Path(args.runtime_root).resolve()
    model_output = Path(args.model_output_dir).resolve()
    output_data = Path(args.output_data_dir).resolve()
    checkpoints = Path(args.checkpoint_dir).resolve()
    values = [
        "python", "scripts/saferide-gemma4-finetune-runner.py",
        "--register", "/opt/saferide-input/register.private.json",
        "--train-data", "/opt/saferide-input/combined-train.private.jsonl",
        "--dev-data", "/opt/saferide-dev/original-development.jsonl",
        "--audit", "/opt/saferide-input/dataset-audit.private.json",
        "--dataset-manifest", "/opt/saferide-input/frozen-manifest.private.json",
        "--artifact-root", "/opt/saferide-input",
        "--pilot-row-manifest", "/opt/saferide-input/training-recipe.private.json",
        "--run-id", args.run_id,
        "--output-root", "/opt/ml/model",
        "--checkpoint-root", "/opt/ml/checkpoints",
        "--constraints", "/opt/saferide-v056/constraints-ai-training.txt",
        "--base-model-id", "google/gemma-4-E2B-it",
        "--base-model-path", "/opt/saferide-model",
        "--base-revision", plan["runtime"]["baseModel"]["revision"],
        "--run-kind", args.mode,
        "--seed", "419805", "--epochs", "1", "--max-seq-length", "1024",
        "--train-batch-size", "1", "--eval-batch-size", "1",
        "--gradient-accumulation-steps", "8", "--max-grad-norm", "1.0",
        "--warmup-ratio", "0.03", "--lr-scheduler-type", "cosine",
        "--early-stopping-patience", "3",
        "--lora-r", "8", "--lora-alpha", "16", "--lora-dropout", "0.05",
    ]
    if args.mode == "preflight":
        values.extend(["--learning-rate", "0.00002", "--max-steps", "1", "--logging-steps", "1", "--eval-steps", "1", "--save-steps", "1"])
    else:
        values.extend(["--learning-rate", "0.00002", "--logging-steps", "5", "--eval-steps", "25", "--save-steps", "25"])
    shell = "umask 077; exec " + " ".join(values)
    return [
        "docker", "run", "--rm", "--pull", "never", "--name", args.container_name,
        "--user", f"{os.getuid()}:{os.getgid()}", "--network", "none", "--gpus", "device=0",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "4096", "--cpus", "16", "--memory", "96g", "--memory-swap", "96g",
        "--shm-size", "8g", "--workdir", "/opt/saferide-v056",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=4g,mode=1777",
        "--mount", mount(code, "/opt/saferide-v056", readonly=True),
        "--mount", mount(frozen, "/opt/saferide-input", readonly=True),
        "--mount", mount(dev.parent, "/opt/saferide-dev", readonly=True),
        "--mount", mount(model, "/opt/saferide-model", readonly=True),
        "--mount", mount(runtime, "/opt/ml/runtime", readonly=False),
        "--mount", mount(model_output, "/opt/ml/model", readonly=False),
        "--mount", mount(output_data, "/opt/ml/output/data", readonly=False),
        "--mount", mount(checkpoints, "/opt/ml/checkpoints", readonly=False),
        "--env", "HOME=/tmp/saferide", "--env", "XDG_CACHE_HOME=/tmp/saferide/cache", "--env", "HF_HOME=/tmp/saferide/hf",
        "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "HF_HUB_OFFLINE=1", "--env", "HF_DATASETS_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "TOKENIZERS_PARALLELISM=false", "--env", "WANDB_DISABLED=true", "--env", "CUDA_VISIBLE_DEVICES=0", "--env", "NVIDIA_VISIBLE_DEVICES=0",
        "--env", "NVIDIA_DRIVER_CAPABILITIES=compute,utility", "--env", "WORLD_SIZE=1",
        "--entrypoint", "/bin/sh", f"sha256:{config_digest}", "-c", shell,
    ]


def panel_command(args: argparse.Namespace, plan: dict[str, Any], config_digest: str) -> list[str]:
    code = Path(args.code_root).resolve()
    panel_input = Path(args.panel_input).resolve()
    model = Path(args.model_dir).resolve()
    output = Path(args.output_data_dir).resolve()
    panel_sha = sha256_file(panel_input / "panel-input-manifest.json")
    shell = (
        "umask 077; exec python scripts/saferide-gemma4-v056-pilot-panel.py run "
        "--input-root /opt/saferide-panel --code-root /opt/saferide-v056 "
        "--model-root /opt/saferide-model --output-root /opt/ml/output/panel"
    )
    return [
        "docker", "run", "--rm", "--pull", "never", "--name", args.container_name,
        "--user", f"{os.getuid()}:{os.getgid()}", "--network", "none", "--gpus", "device=0",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "4096", "--cpus", "16", "--memory", "96g", "--memory-swap", "96g",
        "--shm-size", "8g", "--workdir", "/opt/saferide-v056",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=4g,mode=1777",
        "--mount", mount(code, "/opt/saferide-v056", readonly=True),
        "--mount", mount(panel_input, "/opt/saferide-panel", readonly=True),
        "--mount", mount(model, "/opt/saferide-model", readonly=True),
        "--mount", mount(output, "/opt/ml/output/panel", readonly=False),
        "--env", f"SAFERIDE_PANEL_INPUT_SHA256={panel_sha}",
        "--env", f"SAFERIDE_PANEL_IMAGE_DIGEST={plan['runtime']['image']['runtimeManifestDigest']}",
        "--env", f"TRAINING_JOB_NAME={args.run_id}",
        "--env", "HOME=/tmp/saferide", "--env", "XDG_CACHE_HOME=/tmp/saferide/cache", "--env", "HF_HOME=/tmp/saferide/hf",
        "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "HF_HUB_OFFLINE=1", "--env", "HF_DATASETS_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "TOKENIZERS_PARALLELISM=false", "--env", "WANDB_DISABLED=true", "--env", "CUDA_VISIBLE_DEVICES=0", "--env", "NVIDIA_VISIBLE_DEVICES=0",
        "--env", "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        "--entrypoint", "/bin/sh", f"sha256:{config_digest}", "-c", shell,
    ]


def panel_verification_command(args: argparse.Namespace) -> list[str]:
    code = Path(args.code_root).resolve()
    panel_input = Path(args.panel_input).resolve()
    output = Path(args.output_data_dir).resolve()
    plan = read_json(Path(args.plan).resolve())
    config_digest = plan["runtime"]["image"]["runtimeConfigDigest"]
    return [
        "docker", "run", "--rm", "--pull", "never", "--network", "none",
        "--user", f"{os.getuid()}:{os.getgid()}", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "512", "--cpus", "4",
        "--memory", "8g", "--memory-swap", "8g", "--workdir", "/opt/saferide-v056",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
        "--mount", mount(code, "/opt/saferide-v056", readonly=True),
        "--mount", mount(panel_input, "/opt/saferide-panel", readonly=True),
        "--mount", mount(output, "/opt/ml/output/panel", readonly=True),
        "--env", "HOME=/tmp/saferide", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--env", "HF_HUB_OFFLINE=1", "--env", "TRANSFORMERS_OFFLINE=1",
        "--entrypoint", "python", f"sha256:{config_digest}",
        "scripts/saferide-gemma4-v056-pilot-panel.py", "verify-output",
        "--input-root", "/opt/saferide-panel", "--code-root", "/opt/saferide-v056",
        "--output-root", "/opt/ml/output/panel",
    ]


def sanitized_line(value: str, roots: list[Path]) -> str | None:
    lowered = value.lower()
    if any(token in lowered for token in ('"messages"', '"completion"', '"prompt"', '"reference"', 'rowid')):
        return None
    result = value.replace("\r", " ").replace("\n", " ")
    for root in roots:
        result = result.replace(str(root), "<private-path>")
    result = re.sub(r"(?i)(?:AKIA|ASIA)[A-Z0-9]{16}", "<redacted>", result)
    result = re.sub(r"(?i)(?:token|secret|password|authorization)\s*[=:]\s*\S+", "<redacted>", result)
    result = re.sub(r"https?://\S+[?&]\S+", "<redacted-url>", result)
    return result[:1000]


def monitor_gpu(process: subprocess.Popen[str], container_name: str, state: dict[str, Any]) -> None:
    minimum_free = 10**9
    peak_utilization = peak_temperature = maximum_processes = 0
    competing = False
    while process.poll() is None:
        try:
            _device, _total, free, utilization, temperature = gpu_sample_once()
            processes = compute_pids()
            minimum_free = min(minimum_free, free)
            peak_utilization = max(peak_utilization, utilization)
            peak_temperature = max(peak_temperature, temperature)
            maximum_processes = max(maximum_processes, len(processes))
            container_pid = None
            inspected = subprocess.run(["docker", "container", "inspect", "--format", "{{.State.Pid}}", container_name], text=True, capture_output=True, timeout=10, check=False)
            if inspected.returncode == 0 and inspected.stdout.strip().isdigit():
                container_pid = int(inspected.stdout.strip())
            if len(processes) > 1 or (len(processes) == 1 and (container_pid is None or processes[0] != container_pid)):
                competing = True
                subprocess.run(["docker", "stop", "--time", "30", container_name], text=True, capture_output=True, timeout=45, check=False)
                break
        except Exception:
            state["monitorError"] = True
            try:
                subprocess.run(["docker", "stop", "--time", "30", container_name], text=True, capture_output=True, timeout=45, check=False)
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
    })


def run_container(command: list[str], args: argparse.Namespace) -> tuple[int, dict[str, Any], str]:
    roots = [Path(value).resolve() for value in (args.plan, args.code_root, args.model_dir, args.image_archive, args.output_data_dir)]
    for name in (
        "frozen_dir", "dev_data", "runtime_root", "model_output_dir", "checkpoint_dir", "panel_input",
    ):
        value = getattr(args, name, None)
        if value:
            roots.append(Path(value).resolve())
    log_root = Path(args.runtime_root).resolve() if args.runtime_root else Path(args.output_data_dir).resolve()
    log_path = log_root / "sanitized-container.log"
    process = subprocess.Popen(command, cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1)
    state: dict[str, Any] = {"monitorError": False}
    monitor = threading.Thread(target=monitor_gpu, args=(process, args.container_name, state), daemon=True)
    monitor.start()
    with log_path.open("x", encoding="utf-8") as log:
        log_path.chmod(0o600)
        assert process.stdout is not None
        for line in process.stdout:
            safe = sanitized_line(line, roots)
            if safe is not None:
                log.write(safe + "\n")
                log.flush()
                print(safe, flush=True)
    exit_code = process.wait()
    monitor.join(timeout=10)
    return exit_code, state, sha256_file(log_path)


def expected_sample_order(args: argparse.Namespace) -> tuple[list[str], list[str]]:
    frozen_root = Path(args.frozen_dir).resolve()
    train_path = frozen_root / "combined-train.private.jsonl"
    recipe_path = frozen_root / "training-recipe.private.json"
    private_file(train_path, "Frozen v0.5.6 training input")
    private_file(recipe_path, "Frozen v0.5.6 training recipe")
    unique_ids = read_jsonl_ids(train_path, "train")
    require(len(unique_ids) == 1888, "Frozen v0.5.6 unique training inventory differs.")
    if args.mode == "preflight":
        return [sorted(unique_ids)[0]], sorted(unique_ids)
    recipe = read_json(recipe_path)
    order = recipe.get("sampleOrder")
    require(
        recipe.get("schema") == "com.saferide.ai.v056-training-recipe"
        and isinstance(order, list)
        and all(isinstance(value, str) for value in order)
        and len(order) == 1944
        and len(set(order)) == 1888
        and set(order) == set(unique_ids)
        and recipe.get("sampleOrderSha256") == sha256_bytes("\n".join(order).encode("utf-8")),
        "Frozen v0.5.6 weighted sample order differs.",
    )
    return order, sorted(unique_ids)


def checkpoint_recovery_readiness(checkpoint_root: Path, outputs: dict[str, Any]) -> dict[str, Any]:
    checkpoints = sorted(
        (path for path in checkpoint_root.rglob("checkpoint-*") if path.is_dir()),
        key=lambda path: int(path.name.rsplit("-", 1)[-1]) if path.name.rsplit("-", 1)[-1].isdigit() else -1,
    )
    require(checkpoints, "v0.5.6 checkpoint creation evidence is unavailable.")
    latest = checkpoints[-1]
    suffix = latest.name.rsplit("-", 1)[-1]
    require(suffix.isdigit(), "v0.5.6 latest checkpoint step is malformed.")
    required_names = {
        "adapter_config.json", "adapter_model.safetensors", "optimizer.pt", "rng_state.pth",
        "scheduler.pt", "trainer_state.json", "training_args.bin",
    }
    actual = {path.name: path for path in latest.rglob("*") if path.is_file()}
    require(required_names.issubset(actual) and all(actual[name].stat().st_size > 0 for name in required_names), "v0.5.6 checkpoint lacks durable optimizer/scheduler/RNG/trainer state.")
    state = read_json(actual["trainer_state.json"])
    step = int(suffix)
    require(state.get("global_step") == step and step <= int(outputs.get("globalSteps", 0)), "v0.5.6 checkpoint trainer-state step differs.")
    require(isinstance(state.get("log_history"), list) and state["log_history"], "v0.5.6 checkpoint lacks pre-resume loss history.")
    best_name = Path(str(outputs.get("bestCheckpoint", ""))).name
    best_matches = [path for path in checkpoints if path.name == best_name]
    require(len(best_matches) == 1, "v0.5.6 best checkpoint inventory differs.")
    return {
        "status": "resume-ready",
        "latestCheckpoint": latest.name,
        "latestCheckpointStep": step,
        "latestCheckpointInventory": tree_inventory(latest),
        "bestCheckpoint": best_name,
        "bestCheckpointInventory": tree_inventory(best_matches[0]),
        "optimizerStatePresent": True,
        "schedulerStatePresent": True,
        "rngStatePresent": True,
        "trainerStatePresent": True,
    }


def validate_outputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    if args.mode == "panel":
        output_root = Path(args.output_data_dir).resolve()
        code_root = Path(args.code_root).resolve()
        verification = subprocess.run(
            panel_verification_command(args),
            cwd=code_root,
            text=True,
            capture_output=True,
            timeout=300,
            check=False,
        )
        require(verification.returncode == 0, "Independent v0.5.6 rubric and output replay failed.")
        summary_path = output_root / "content-free/pilot-panel-summary.json"
        execution_path = output_root / "content-free/pilot-panel-execution.json"
        private_file(summary_path, "v0.5.6 panel summary")
        private_file(execution_path, "v0.5.6 panel execution")
        summary = read_json(summary_path)
        require(summary.get("schema") == "com.saferide.ai.v056-pilot-panel-summary", "v0.5.6 panel summary identity differs.")
        require(
            summary.get("status") == "passed"
            and summary.get("eligibility") == {"eligible": True, "reasons": []}
            and summary.get("requiredSubgroupGates", {}).get("kiswahili") == {"requiredRows": 160, "eligible": True, "reasons": []}
            and summary.get("requiredSubgroupGates", {}).get("agencyPreserving") == {"requiredRows": 12, "eligible": True, "reasons": []},
            "v0.5.6 panel gates failed; preserve the single panel output and stop NO-GO.",
        )
        return {
            "summarySha256": sha256_file(summary_path),
            "executionSha256": sha256_file(execution_path),
            "verificationStdoutSha256": sha256_bytes(verification.stdout.encode("utf-8")),
            "status": summary.get("status"),
        }, tree_inventory(output_root)
    manifest_path = Path(args.model_output_dir).resolve() / args.run_id / "metadata.json"
    private_file(manifest_path, "v0.5.6 training manifest")
    manifest = read_json(manifest_path)
    outputs = manifest.get("outputs", {})
    require(manifest.get("datasetProfile") == "v056" and manifest.get("runKind") == args.mode and manifest.get("status") == "completed", "v0.5.6 training result is not complete.")
    require(outputs.get("holdoutRowsRead") == 0 and outputs.get("adapterTensorValidation", {}).get("nonFiniteTensorCount") == 0, "v0.5.6 training integrity or holdout boundary differs.")
    expected_order, unique_train_ids = expected_sample_order(args)
    expected_dev_ids = sorted(read_jsonl_ids(Path(args.dev_data).resolve(), "dev"))
    require(outputs.get("sampleOrder") == expected_order, "v0.5.6 exact sample order differs from the frozen recipe.")
    require(outputs.get("sampleOrderSha256") == sha256_bytes("\n".join(expected_order).encode("utf-8")), "v0.5.6 sample-order hash differs.")
    expected_train_inventory = expected_order if args.mode == "preflight" else unique_train_ids
    expected_dev_inventory = expected_dev_ids[:1] if args.mode == "preflight" else expected_dev_ids
    require(outputs.get("trainRowIds") == sorted(set(expected_train_inventory)), "v0.5.6 training row inventory differs.")
    require(outputs.get("developmentRowIds") == expected_dev_inventory, "v0.5.6 development row inventory differs.")
    tokens = outputs.get("dataTokens", {})
    require(
        outputs.get("lossMaskPolicy") == "assistant-turns-only"
        and isinstance(tokens.get("assistantTrain"), int)
        and 0 < tokens["assistantTrain"] < tokens.get("train", 0)
        and isinstance(tokens.get("assistantDev"), int)
        and 0 < tokens["assistantDev"] < tokens.get("dev", 0),
        "v0.5.6 assistant-only loss-mask evidence differs.",
    )
    loss = outputs.get("lossReport", {})
    if args.mode == "preflight":
        require(outputs.get("globalSteps") == 1 and outputs.get("rowsSeen") == 1 and len(outputs.get("sampleOrder", [])) == 1, "v0.5.6 preflight coverage differs.")
        require(loss.get("policyId") == "saferide-v054-preflight-loss-integrity.1" and loss.get("rawTrainerLoss") == loss.get("meanTrainingObjectiveLoss") and loss.get("finite") is True, "v0.5.6 preflight normalized loss differs.")
    else:
        require(outputs.get("globalSteps") == 243 and outputs.get("rowsSeen") == 1944 and len(outputs.get("sampleOrder", [])) == 1944 and len(set(outputs.get("sampleOrder", []))) == 1888, "v0.5.6 pilot coverage differs.")
        require(loss.get("policyId") == "saferide-v054-training-loss-integrity.1" and math_close(loss.get("rawTrainerAccumulatedLoss"), loss.get("meanTrainingObjectiveLoss"), 8) and loss.get("finite") is True and loss.get("spikeGate") == "passed" and loss.get("divergenceGate") == "passed", "v0.5.6 pilot truthful-loss gate differs.")
    checkpoint_root = Path(args.checkpoint_dir).resolve()
    checkpoint_inventory = tree_inventory(checkpoint_root)
    recovery_readiness = checkpoint_recovery_readiness(checkpoint_root, outputs)
    output_inventory = tree_inventory(Path(args.model_output_dir).resolve())
    adapter_root = Path(args.model_output_dir).resolve() / args.run_id / "adapter"
    private_directory(adapter_root, "v0.5.6 adapter root")
    actual_adapter = {path.name: path for path in adapter_root.rglob("*") if path.is_file()}
    declared_adapter = {Path(str(item.get("path"))).name: item for item in outputs.get("adapterFiles", [])}
    require(set(actual_adapter) == set(declared_adapter) and len(actual_adapter) == len(outputs.get("adapterFiles", [])), "v0.5.6 adapter inventory differs.")
    adapter_files = []
    for name, path in sorted(actual_adapter.items()):
        item = declared_adapter[name]
        require(path.stat().st_size == item.get("sizeBytes") and sha256_file(path) == item.get("sha256"), f"v0.5.6 adapter bytes differ: {name}")
        adapter_files.append({"path": name, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
    require(outputs.get("adapterTensorValidation", {}).get("tensorCount") == 410, "v0.5.6 adapter tensor count differs.")
    return {
        "manifestSha256": sha256_file(manifest_path),
        "globalSteps": outputs["globalSteps"], "rowsSeen": outputs["rowsSeen"],
        "epochsCompleted": outputs["epochsCompleted"],
        "sampleOrderSha256": outputs["sampleOrderSha256"],
        "lossMaskPolicy": outputs["lossMaskPolicy"],
        "lossReport": loss, "bestCheckpoint": Path(str(outputs.get("bestCheckpoint"))).name,
        "adapterTensorValidation": outputs["adapterTensorValidation"],
        "adapterInventorySha256": sha256_bytes(canonical_bytes(adapter_files)),
        "adapterFiles": adapter_files,
        "checkpointInventory": checkpoint_inventory,
        "recovery": {
            "status": "resumed" if outputs.get("resumedFromCheckpoint") else "not-required",
            "resumeReadiness": recovery_readiness,
        },
    }, output_inventory


def math_close(raw: Any, normalized: Any, divisor: int) -> bool:
    return isinstance(raw, (int, float)) and isinstance(normalized, (int, float)) and abs(float(raw) / divisor - float(normalized)) <= 1e-9


def acquire_lock() -> Any:
    descriptor = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    os.chmod(LOCK_PATH, 0o600)
    handle = os.fdopen(descriptor, "r+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        handle.close()
        raise LaunchError("SafeRide GPU lock is already held; no launch occurred.") from error
    return handle


def run_launch(args: argparse.Namespace) -> int:
    os.umask(0o077)
    validate_authorization(args)
    require(RUN_ID_PATTERN.fullmatch(args.run_id) is not None and CONTAINER_PATTERN.fullmatch(args.container_name) is not None, "Run or container identity is unsafe.")
    output_data = Path(args.output_data_dir).expanduser().resolve()
    require_empty(output_data, "Output-data root")
    if args.mode in {"preflight", "pilot"}:
        require_empty(Path(args.runtime_root).expanduser().resolve(), "Runtime root")
        require_empty(Path(args.model_output_dir).expanduser().resolve(), "Model-output root")
        checkpoint_root = Path(args.checkpoint_dir).expanduser().resolve()
        if args.resume:
            private_directory(checkpoint_root, "Checkpoint root")
            require(args.mode == "pilot" and any(checkpoint_root.iterdir()), "Only an interrupted pilot may resume from an existing checkpoint.")
        else:
            require_empty(checkpoint_root, "Checkpoint root")
    existing = subprocess.run(["docker", "container", "inspect", args.container_name], text=True, capture_output=True, timeout=10, check=False)
    require(existing.returncode != 0, "Selected SafeRide container identity already exists.")
    lock = acquire_lock()
    failure_context: dict[str, Any] = {"startedAt": None, "exitCode": None, "monitor": None}
    try:
        plan, config_digest, frozen_inventory = verify_plan_and_inputs(args)
        inspect_image(plan, config_digest)
        snapshot = sample_idle_gpu()
        snapshot.update({
            "schema": "com.saferide.ai.v056-host-gpu-snapshot", "schemaVersion": 1,
            "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "mode": args.mode,
            "planSha256": args.plan_sha256, "frozenManifestSha256": EXPECTED_FROZEN_MANIFEST_SHA256,
            "imageArchiveSha256": plan["runtime"]["image"]["archiveSha256"],
            "runtimeManifestDigest": plan["runtime"]["image"]["runtimeManifestDigest"],
            "runtimeConfigDigest": config_digest,
            "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False},
        })
        write_private_json(output_data / "host-gpu-snapshot.json", snapshot)
        command = panel_command(args, plan, config_digest) if args.mode == "panel" else training_command(args, plan, config_digest)
        started = dt.datetime.now(dt.timezone.utc)
        failure_context["startedAt"] = started.isoformat()
        exit_code, monitor, log_sha = run_container(command, args)
        failure_context.update({"exitCode": exit_code, "monitor": monitor, "sanitizedLogSha256": log_sha})
        finished = dt.datetime.now(dt.timezone.utc)
        require(not monitor.get("competingWorkloadObserved"), "Another GPU workload activated; only the SafeRide container was stopped.")
        require(not monitor.get("monitorError"), "Continuous GPU monitoring failed; the SafeRide run was stopped.")
        require(exit_code == 0, "SafeRide container exited unsuccessfully.")
        _device, _total, final_free, final_utilization, final_temperature = gpu_sample_once()
        final_processes = len(compute_pids())
        monitor["finalState"] = {
            "freeVramMiB": final_free, "utilizationPercent": final_utilization,
            "temperatureC": final_temperature, "computeProcessCount": final_processes,
        }
        require(final_processes == 0, "A GPU workload is active after the SafeRide container exit; no unrelated process was changed.")
        result, output_inventory = validate_outputs(args)
        receipt = {
            "schema": "com.saferide.ai.v056-launch-receipt", "schemaVersion": 1,
            "status": "completed", "mode": args.mode, "runId": args.run_id,
            "startedAt": started.isoformat(), "finishedAt": finished.isoformat(),
            "wallSeconds": round((finished - started).total_seconds(), 3), "exitCode": exit_code,
            "authorization": {"referenceSha256": sha256_bytes(args.authorization_ref.encode("utf-8")), "authorizedAt": args.authorized_at, "kind": args.authorization_kind},
            "bindings": {
                "planSha256": args.plan_sha256, "frozenManifestSha256": EXPECTED_FROZEN_MANIFEST_SHA256,
                "runtimeManifestDigest": plan["runtime"]["image"]["runtimeManifestDigest"],
                "runtimeConfigDigest": config_digest, "commandSha256": sha256_bytes(canonical_bytes(command)),
                "sanitizedLogSha256": log_sha, "frozenInventory": frozen_inventory,
            },
            "isolation": {"device": 0, "network": "none", "readOnlyRoot": True, "readOnlyInputs": True, "cpuLimit": 16, "memoryLimitGiB": 96},
            "monitor": monitor, "result": result, "outputInventory": output_inventory,
            "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False, "sealedHoldoutRead": False},
            "fullCandidateStarted": False, "promotionEligible": False,
        }
        write_private_json(output_data / "launch-receipt.json", receipt)
        print(f"SafeRide v0.5.6 {args.mode} launch PASS (content-free receipt recorded; promotion false).")
        return 0
    except Exception as error:
        roots = [Path(value).resolve() for value in (args.plan, args.code_root, args.model_dir, args.image_archive, args.output_data_dir)]
        reason = sanitized_line(str(error), roots) or "SafeRide execution failed closed."
        failure = {
            "schema": "com.saferide.ai.v056-launch-receipt", "schemaVersion": 1,
            "status": "failed", "mode": args.mode, "runId": args.run_id,
            "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "startedAt": failure_context["startedAt"], "exitCode": failure_context["exitCode"],
            "reason": reason, "monitor": failure_context["monitor"],
            "bindings": {"planSha256": args.plan_sha256, "frozenManifestSha256": EXPECTED_FROZEN_MANIFEST_SHA256},
            "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False, "sealedHoldoutRead": False},
            "fullCandidateStarted": False, "promotionEligible": False,
        }
        if failure_context.get("sanitizedLogSha256"):
            failure["bindings"]["sanitizedLogSha256"] = failure_context["sanitizedLogSha256"]
        try:
            write_private_json(output_data / "launch-failure-receipt.json", failure)
        except Exception:
            pass
        raise
    finally:
        lock.close()


def contract_check() -> int:
    require(EXPECTED_FROZEN_MANIFEST_SHA256 == "9900b4d55eef76d5dcc2deead3a5586695f08aaaea38ebbe6783ee5f23138dc0", "Frozen v0.5.6 manifest constant differs.")
    require(MINIMUM_FREE_VRAM_MIB == 22000 and GPU_SAMPLE_COUNT == 16 and GPU_SAMPLE_INTERVAL_SECONDS == 2, "GPU idle sampling contract differs.")
    require(PORTABLE_V053_PATH.is_file(), "Required governed launcher implementation is unavailable.")
    print("SafeRide v0.5.6 GPU launcher contract PASS (30-second idle gate; SafeRide-only lock; reuse/candidate modes absent).")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    launch = subparsers.add_parser("launch")
    launch.add_argument("--mode", choices=["preflight", "pilot", "panel"], required=True)
    launch.add_argument("--authorization-kind", required=True)
    launch.add_argument("--authorization-ref", required=True)
    launch.add_argument("--authorized-at", required=True)
    launch.add_argument("--plan", default=str(PLAN_PATH))
    launch.add_argument("--plan-sha256", required=True)
    launch.add_argument("--code-root", required=True)
    launch.add_argument("--model-dir", required=True)
    launch.add_argument("--image-archive", required=True)
    launch.add_argument("--frozen-dir")
    launch.add_argument("--dev-data")
    launch.add_argument("--panel-input")
    launch.add_argument("--runtime-root")
    launch.add_argument("--model-output-dir")
    launch.add_argument("--output-data-dir", required=True)
    launch.add_argument("--checkpoint-dir")
    launch.add_argument("--run-id", required=True)
    launch.add_argument("--container-name", required=True)
    launch.add_argument("--resume", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "contract-check":
        return contract_check()
    if args.mode in {"preflight", "pilot"}:
        require(all(getattr(args, name) for name in ("frozen_dir", "dev_data", "runtime_root", "model_output_dir", "checkpoint_dir")), "Training launch roots are incomplete.")
        require(args.panel_input is None, "Training launch may not mount a panel input.")
    else:
        require(args.panel_input and not args.resume, "Panel launch requires one immutable panel input and cannot resume.")
        require(all(getattr(args, name) is None for name in ("frozen_dir", "dev_data", "runtime_root", "model_output_dir", "checkpoint_dir")), "Panel launch contains a training-only root.")
    return run_launch(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - content-free terminal handoff only.
        print(re.sub(r"\s+", " ", str(error))[:600], file=sys.stderr)
        raise SystemExit(1)
