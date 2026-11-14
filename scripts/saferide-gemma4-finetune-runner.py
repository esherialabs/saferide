#!/usr/bin/env python
"""Guarded SafeRide Gemma 4 E2B PEFT/LoRA fine-tuning runner.

The default mode is a dry run that proves gates, environment, and metadata. A
real run requires an approved register, candidate JSONL, explicit download/risk
flags, and an installed ML stack.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import platform
import random
import re
import subprocess
import sys
from collections.abc import Mapping
from numbers import Real
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTER = REPO_ROOT / "docs" / "security" / "saferide-gemma4-colab-input-register.synthetic-v0.4.candidate.json"
DEFAULT_RUN_ROOT = REPO_ROOT / ".ai-smoke" / "gemma4-finetune" / "runs"
DEFAULT_REQUIREMENTS = REPO_ROOT / "requirements-ai-smoke.txt"
DEFAULT_CONSTRAINTS = REPO_ROOT / "constraints-ai-training.txt"
DEFAULT_BASE_MODEL = "google/gemma-4-E2B-it"
TINY_SMOKE_MODEL = "sshleifer/tiny-gpt2"
EXACT_PIN_PATTERN = re.compile(r"^([A-Za-z0-9_.-]+)==([A-Za-z0-9][A-Za-z0-9.+!_-]*)$")
GOVERNED_V05_PROFILES = {"v05", "v051", "v052", "v053", "v054", "v055", "v056"}
WEIGHTED_PILOT_PROFILES = {
    "v052": {"uniqueRows": 1768, "weightedRows": 1864, "learningRate": 2e-5},
    "v053": {"uniqueRows": 1832, "weightedRows": 2088, "learningRate": 1e-5},
    "v054": {"uniqueRows": 1864, "weightedRows": 1896, "learningRate": 2e-5},
    "v055": {"uniqueRows": 1896, "weightedRows": 1992, "learningRate": 1e-5},
    "v056": {"uniqueRows": 1888, "weightedRows": 1944, "learningRate": 2e-5},
}
V054_REMEDIATION_PATH = REPO_ROOT / "scripts" / "saferide-gemma4-v054-remediation.py"
V055_REMEDIATION_PATH = REPO_ROOT / "scripts" / "saferide-gemma4-v055-remediation.py"
V056_REMEDIATION_PATH = REPO_ROOT / "scripts" / "saferide-gemma4-v056-remediation.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a guarded SafeRide Gemma 4 E2B LoRA fine-tuning pass.")
    parser.add_argument("--register", default=str(DEFAULT_REGISTER), help="Approved data register JSON.")
    parser.add_argument("--data", help="Candidate JSONL data with frozen train/dev/holdout rows.")
    parser.add_argument("--train-data", help="v0.5 controlled training JSONL; use with --dev-data.")
    parser.add_argument("--dev-data", help="v0.5 controlled development JSONL; use with --train-data.")
    parser.add_argument("--audit", help="Content-free dataset audit tied to exact register and data hashes.")
    parser.add_argument("--dataset-manifest", help="v0.5 content-free four-split dataset artifact manifest.")
    parser.add_argument("--artifact-root", help="v0.5 artifact root used by the strict content-free readiness gate.")
    parser.add_argument("--pilot-row-manifest", help="Pinned governed pilot selection or weighted sample-order manifest.")
    parser.add_argument("--run-id", help="Stable training run id. Defaults to timestamped local id.")
    parser.add_argument("--paired-run-id", help="Other approved v0.5 candidate seed run id, when already available.")
    parser.add_argument("--lora-rank-approval-ref", help="Required human evidence reference before exceptional v0.5 rank-16 use.")
    parser.add_argument("--output-root", default=str(DEFAULT_RUN_ROOT), help="Directory for run metadata and outputs.")
    parser.add_argument(
        "--constraints",
        default=str(DEFAULT_CONSTRAINTS),
        help="Exact Python 3.12 pip-compiled dependency constraints.",
    )
    parser.add_argument("--base-model-id", default=DEFAULT_BASE_MODEL, help="Base model id for actual fine-tuning.")
    parser.add_argument(
        "--base-model-path",
        help="Offline local snapshot path. Metadata still records --base-model-id and --base-revision.",
    )
    parser.add_argument("--base-revision", help="Optional immutable base model revision.")
    parser.add_argument(
        "--checkpoint-root",
        help="Optional durable Trainer checkpoint root, for example SageMaker /opt/ml/checkpoints.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate gates and write metadata without importing ML deps.")
    parser.add_argument("--tiny-smoke", action="store_true", help="Use a tiny public model for a one-step pipeline smoke.")
    parser.add_argument("--allow-base-download", action="store_true", help="Allow Transformers to download model/tokenizer files.")
    parser.add_argument("--approved-local-cpu-risk", action="store_true", help="Allow CPU-only run for non-tiny models.")
    parser.add_argument(
        "--run-kind",
        choices=["auto", "preflight", "formatting-smoke", "pilot", "candidate"],
        default="auto",
        help="Candidate runs require a full epoch; a max-step run is always non-promotable pilot evidence.",
    )
    parser.add_argument("--seed", type=int, default=419804)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--max-steps", type=int, help="Explicit pilot-only step cap; forbidden for candidate runs.")
    parser.add_argument("--max-seq-length", type=int, default=1024, help="Rows longer than this fail; no silent truncation.")
    parser.add_argument("--train-batch-size", type=int, default=1)
    parser.add_argument("--eval-batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    parser.add_argument("--max-grad-norm", type=float, default=1.0, help="Explicit optimizer gradient clipping norm.")
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--lr-scheduler-type", default="cosine")
    parser.add_argument("--logging-steps", type=int, default=5)
    parser.add_argument("--eval-steps", type=int, default=5)
    parser.add_argument("--save-steps", type=int, default=5)
    parser.add_argument("--early-stopping-patience", type=int, default=3)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    return parser.parse_args()


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path.resolve())


def run_command(args: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=REPO_ROOT, text=True, capture_output=True, timeout=timeout, check=False)


def run_data_gate(
    register: Path,
    data: Path | None,
    audit: Path | None,
    strict: bool,
    *,
    dataset_profile: str = "v04",
    artifact_root: Path | None = None,
    train_data: Path | None = None,
    dev_data: Path | None = None,
    dataset_manifest: Path | None = None,
    pilot_row_manifest: Path | None = None,
) -> dict[str, Any]:
    if dataset_profile == "v056":
        gate_sampling_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_sampling_manifest is None or audit is None:
            raise RuntimeError("v0.5.6 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v056-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_sampling_manifest),
            "--audit", str(audit),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v055":
        gate_sampling_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_sampling_manifest is None or audit is None:
            raise RuntimeError("v0.5.5 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v055-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_sampling_manifest),
            "--audit", str(audit),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v054":
        gate_sampling_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_sampling_manifest is None or audit is None:
            raise RuntimeError("v0.5.4 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v054-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_sampling_manifest),
            "--audit", str(audit),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v053":
        gate_sampling_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_sampling_manifest is None or audit is None:
            raise RuntimeError("v0.5.3 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v053-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_sampling_manifest),
            "--audit", str(audit),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v052":
        gate_sampling_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_sampling_manifest is None or audit is None:
            raise RuntimeError("v0.5.2 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v052-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_sampling_manifest),
            "--audit", str(audit),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v051":
        gate_pilot_manifest = pilot_row_manifest or (artifact_root / "dataset/controlled/pilot-row-manifest.json" if artifact_root is not None else None)
        if train_data is None or dev_data is None or dataset_manifest is None or artifact_root is None or gate_pilot_manifest is None:
            raise RuntimeError("v0.5.1 training gate inputs are incomplete.")
        command = [
            sys.executable,
            "scripts/saferide-gemma4-v051-training.py",
            "verify",
            "--register", str(register),
            "--train-data", str(train_data),
            "--dev-data", str(dev_data),
            "--dataset-manifest", str(dataset_manifest),
            "--artifact-root", str(artifact_root),
            "--pilot-row-manifest", str(gate_pilot_manifest),
        ]
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {"command": " ".join(command), "exitCode": result.returncode, "passed": result.returncode == 0}
    if dataset_profile == "v05":
        command = [
            "node",
            "scripts/saferide-gemma4-v05-readiness.mjs",
            "--register",
            str(register),
        ]
        if strict:
            command.append("--training-strict")
            if artifact_root is not None:
                command.extend(["--artifact-root", str(artifact_root)])
            if train_data is not None:
                command.extend(["--train-data", str(train_data)])
            if dev_data is not None:
                command.extend(["--dev-data", str(dev_data)])
        result = run_command(command, timeout=180)
        print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return {
            "command": " ".join(command),
            "exitCode": result.returncode,
            "passed": result.returncode == 0,
        }
    command = [
        "node",
        "scripts/saferide-gemma4-finetune-data-check.mjs",
        "--register",
        str(register),
    ]
    if data is not None:
        command.extend(["--data", str(data)])
    if audit is not None:
        command.extend(["--audit", str(audit)])
    if strict:
        command.append("--for-finetuning")

    result = run_command(command, timeout=180)
    print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    return {
        "command": " ".join(command),
        "exitCode": result.returncode,
        "passed": result.returncode == 0,
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dataset_profile_for_register(register: dict[str, Any]) -> str:
    if register.get("schema") == "com.saferide.ai.v056-mitigation-register":
        return "v056"
    if register.get("schema") == "com.saferide.ai.v055-mitigation-register":
        return "v055"
    if register.get("schema") == "com.saferide.ai.v054-mitigation-register":
        return "v054"
    if register.get("schema") == "com.saferide.ai.v053-mitigation-register":
        return "v053"
    if register.get("schema") == "com.saferide.ai.v052-mitigation-register":
        return "v052"
    if register.get("schema") == "com.saferide.ai.v051-mitigation-register":
        return "v051"
    if register.get("schema") == "com.saferide.ai.v05-dataset-register":
        return "v05"
    return "v04"


def load_pilot_row_ids(path: Path | None, dataset_profile: str, run_kind: str) -> list[str] | None:
    if run_kind != "pilot":
        if run_kind == "preflight" and dataset_profile in {"v054", "v055", "v056"} and path is not None:
            load_pilot_row_ids(path, dataset_profile, "pilot")
            return None
        if path is not None:
            raise RuntimeError("--pilot-row-manifest is valid only for --run-kind pilot.")
        return None
    if dataset_profile not in GOVERNED_V05_PROFILES:
        return None
    if path is None:
        raise RuntimeError("v0.5 pilot runs require --pilot-row-manifest with the governed deterministic selection or weighted order.")
    manifest = read_json(path)
    row_ids = manifest.get("rowIds")
    if dataset_profile in WEIGHTED_PILOT_PROFILES:
        expected = WEIGHTED_PILOT_PROFILES[dataset_profile]
        version = {"v052": "v0.5.2", "v053": "v0.5.3", "v054": "v0.5.4", "v055": "v0.5.5", "v056": "v0.5.6"}[dataset_profile]
        minor = {"v052": 2, "v053": 3, "v054": 4, "v055": 5, "v056": 6}[dataset_profile]
        expected_status = "frozen-for-final-targeted-pilot" if dataset_profile == "v055" else "frozen-for-targeted-next-pilot" if dataset_profile in {"v054", "v056"} else "frozen-for-cost-controlled-pilot"
        valid_identity = (
            manifest.get("schema") == f"com.saferide.ai.{dataset_profile}-training-recipe"
            and manifest.get("datasetId") == f"saferide-synthetic-guidance-v0.5.{minor}"
            and manifest.get("status") == expected_status
            and manifest.get("learningRate") == expected["learningRate"]
            and manifest.get("epochs") == 1
            and manifest.get("fullCandidateSubmissionAuthorized") is False
        )
        row_ids = manifest.get("sampleOrder")
        if not valid_identity or manifest.get("seed") != 419805 or not isinstance(row_ids, list) or len(row_ids) != expected["weightedRows"] or len(set(row_ids)) != expected["uniqueRows"]:
            raise RuntimeError(f"Governed {version} pilot sample-order manifest is malformed.")
        expected_hash = hashlib.sha256("\n".join(row_ids).encode("utf-8")).hexdigest()
        if manifest.get("sampleOrderSha256") != expected_hash:
            raise RuntimeError(f"{version} pilot sample-order hash is stale.")
        return [str(row_id) for row_id in row_ids]
    if dataset_profile == "v051":
        valid_identity = (
            manifest.get("schema") == "com.saferide.ai.v051-pilot-row-manifest"
            and manifest.get("datasetId") == "saferide-synthetic-guidance-v0.5.1"
            and manifest.get("status") == "frozen"
            and manifest.get("composition") == {"sourceRows": 200, "sourceRowsPerCategoryLanguage": 10, "mitigationRows": 120}
            and manifest.get("mitigationHoldoutIncluded") is False
            and manifest.get("developmentRowsIncluded") is False
        )
    else:
        valid_identity = (
            manifest.get("schema") == "com.saferide.ai.v05-pilot-row-manifest"
            and manifest.get("datasetId") == "saferide-synthetic-guidance-v0.5.0"
            and manifest.get("rowsPerCategoryLanguage") == 16
        )
    if not valid_identity or manifest.get("seed") != 419805 or not isinstance(row_ids, list) or len(row_ids) != 320 or len(set(row_ids)) != 320:
        raise RuntimeError("Governed pilot row manifest is malformed or does not contain exactly 320 unique rows.")
    expected_hash = hashlib.sha256("\n".join(row_ids).encode("utf-8")).hexdigest()
    if manifest.get("rowIdInventorySha256") != expected_hash:
        raise RuntimeError("Pilot row manifest inventory hash is stale.")
    return [str(row_id) for row_id in row_ids]


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"Invalid JSONL at line {line_number}: {error}") from error
            rows.append(value)
    return rows


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def normalize_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def parse_exact_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = EXACT_PIN_PATTERN.fullmatch(line)
        if not match:
            raise RuntimeError(f"{path.name} line {line_number} is not an exact package==version pin")
        name = normalize_package_name(match.group(1))
        if name in pins:
            raise RuntimeError(f"{path.name} contains duplicate pin for {name}")
        pins[name] = match.group(2)
    return pins


def load_training_lock(requirements: Path, constraints: Path) -> dict[str, str]:
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("The approved training dependency lock requires Python 3.12 exactly.")
    direct_pins = parse_exact_pins(requirements)
    constraint_pins = parse_exact_pins(constraints)
    if len(constraint_pins) <= len(direct_pins):
        raise RuntimeError("Training constraints must lock transitive dependencies, not only direct packages.")
    for name, version in direct_pins.items():
        if constraint_pins.get(name) != version:
            raise RuntimeError(f"Training constraints do not preserve direct pin {name}=={version}.")
    return constraint_pins


def verify_installed_training_lock(
    pins: dict[str, str],
    version_getter=importlib.metadata.version,
) -> dict[str, str]:
    installed: dict[str, str] = {}
    mismatches: list[str] = []
    for name, expected in pins.items():
        try:
            actual = version_getter(name)
        except importlib.metadata.PackageNotFoundError:
            actual = "not-installed"
        installed[name] = actual
        if actual != expected and not actual.startswith(f"{expected}+"):
            mismatches.append(f"{name} expected {expected}, found {actual}")
    if mismatches:
        preview = "; ".join(mismatches[:8])
        if len(mismatches) > 8:
            preview += f"; and {len(mismatches) - 8} more"
        raise RuntimeError(f"Installed packages do not match the approved training lock: {preview}")
    return installed


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    split_counts: dict[str, int] = {}
    dataset_ids = sorted({str(row.get("datasetId", "")) for row in rows if row.get("datasetId")})
    row_ids = [str(row.get("id", "")) for row in rows if row.get("id")]
    for row in rows:
        split = str(row.get("split", "unknown"))
        split_counts[split] = split_counts.get(split, 0) + 1
    return {
        "rowCount": len(rows),
        "datasetIds": dataset_ids,
        "splitCounts": split_counts,
        "rowIdSha256": hashlib.sha256("\n".join(sorted(row_ids)).encode("utf-8")).hexdigest(),
    }


def cuda_bf16_supported(torch: Any, cuda_available: bool) -> bool:
    if not cuda_available:
        return False
    checker = getattr(getattr(torch, "cuda", None), "is_bf16_supported", None)
    if not callable(checker):
        return False
    try:
        return bool(checker())
    except RuntimeError:
        return False


def assert_finite_training_evidence(value: Any) -> None:
    non_finite_paths: list[str] = []

    def visit(current: Any, path: str) -> None:
        if isinstance(current, Real) and not isinstance(current, bool):
            if not math.isfinite(float(current)):
                non_finite_paths.append(path)
            return
        if isinstance(current, Mapping):
            for key, item in current.items():
                visit(item, f"{path}.{key}")
            return
        if isinstance(current, (list, tuple)):
            for index, item in enumerate(current):
                visit(item, f"{path}[{index}]")

    visit(value, "trainingEvidence")
    if non_finite_paths:
        preview = ", ".join(non_finite_paths[:5])
        raise RuntimeError(f"Non-finite training metric detected at {preview}; the run is blocked.")


def final_evaluation_metrics(trainer: Any) -> dict[str, Any]:
    """Reuse the terminal scheduled evaluation, or evaluate once when it is absent."""
    state = trainer.state
    final_step = int(state.global_step)
    terminal_entries = [
        entry for entry in state.log_history
        if isinstance(entry, Mapping)
        and entry.get("step") == final_step
        and "eval_loss" in entry
    ]
    if len(terminal_entries) > 1:
        raise RuntimeError("Final optimizer step contains duplicate evaluation entries.")
    if terminal_entries:
        return {
            key: value for key, value in terminal_entries[0].items()
            if (key.startswith("eval_") or key == "epoch")
            and isinstance(value, Real)
            and not isinstance(value, bool)
        }
    return trainer.evaluate()


def verify_finite_adapter_tensors(path: Path, torch: Any, opener: Any | None = None) -> dict[str, int]:
    if opener is None:
        from safetensors import safe_open as opener  # type: ignore
    tensor_count = 0
    element_count = 0
    with opener(str(path), framework="pt", device="cpu") as handle:
        keys = sorted(handle.keys())
        if not keys:
            raise RuntimeError("Adapter safetensors contains no tensors.")
        for key in keys:
            tensor = handle.get_tensor(key)
            tensor_count += 1
            element_count += int(tensor.numel())
            if not bool(torch.isfinite(tensor).all().item()):
                raise RuntimeError("Adapter safetensors contains a non-finite tensor; the pilot is blocked.")
    return {"tensorCount": tensor_count, "elementCount": element_count, "nonFiniteTensorCount": 0}


def environment_summary() -> dict[str, Any]:
    colab_detected = "COLAB_GPU" in os.environ or "COLAB_RELEASE_TAG" in os.environ
    sagemaker_detected = bool(os.environ.get("TRAINING_JOB_NAME") or os.environ.get("SM_TRAINING_ENV"))
    summary: dict[str, Any] = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "machine": platform.machine(),
        "runtimeKind": "aws-sagemaker" if sagemaker_detected else "google-colab" if colab_detected else "local-or-other",
        "colabDetected": colab_detected,
        "sagemakerDetected": sagemaker_detected,
        "hfTokenConfigured": bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")),
    }
    if colab_detected:
        try:
            summary["colabPackageVersion"] = importlib.metadata.version("google-colab")
        except importlib.metadata.PackageNotFoundError:
            summary["colabPackageVersion"] = "unavailable"
    if sagemaker_detected:
        summary["sagemaker"] = {
            "trainingJobName": os.environ.get("TRAINING_JOB_NAME", "unavailable"),
            "currentHost": os.environ.get("CURRENT_HOST", os.environ.get("SM_CURRENT_HOST", "unavailable")),
            "inputManifestSha256": os.environ.get("SAFERIDE_SAGEMAKER_INPUT_MANIFEST_SHA256", "unavailable"),
            "imageDigest": os.environ.get("SAFERIDE_SAGEMAKER_IMAGE_DIGEST", "unavailable"),
            "launcherSourceCommit": os.environ.get("SAFERIDE_LAUNCHER_SOURCE_COMMIT", "unavailable"),
            "datasetSourceCommit": os.environ.get("SAFERIDE_DATASET_SOURCE_COMMIT", "unavailable"),
        }
    try:
        import torch  # type: ignore

        summary["torch"] = getattr(torch, "__version__", "unknown")
        summary["cudaAvailable"] = bool(torch.cuda.is_available())
        summary["cudaDeviceCount"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        summary["cudaVersion"] = getattr(torch.version, "cuda", None)
        summary["cudaBf16Supported"] = cuda_bf16_supported(torch, bool(torch.cuda.is_available()))
        if torch.cuda.is_available():
            properties = torch.cuda.get_device_properties(0)
            summary["cudaDeviceName"] = properties.name
            summary["cudaDeviceTotalMemoryBytes"] = int(properties.total_memory)
            summary["cudaCapability"] = list(torch.cuda.get_device_capability(0))
            try:
                driver = subprocess.run(
                    ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                    text=True,
                    capture_output=True,
                    check=False,
                    timeout=5,
                )
                versions = sorted(set(re.findall(r"\b\d+(?:\.\d+)+\b", driver.stdout)))
                summary["nvidiaDriverVersions"] = versions or ["unavailable"]
            except (FileNotFoundError, subprocess.TimeoutExpired):
                summary["nvidiaDriverVersions"] = ["unavailable"]
    except ModuleNotFoundError:
        summary["torch"] = "not-installed"
        summary["cudaAvailable"] = False
        summary["cudaDeviceCount"] = 0
    return summary


def package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    for name in [
        "torch", "transformers", "datasets", "peft", "accelerate", "safetensors", "torchao", "huggingface-hub"
    ]:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = "not-installed"
    return versions


def resolve_run_kind(args: argparse.Namespace) -> str:
    if args.run_kind != "auto":
        return str(args.run_kind)
    if args.dry_run:
        return "preflight"
    if args.tiny_smoke:
        return "formatting-smoke"
    if args.max_steps is not None:
        return "pilot"
    return "candidate"


def validate_run_configuration(args: argparse.Namespace, run_kind: str, dataset_profile: str = "v04") -> None:
    positive_integer_fields = [
        "max_seq_length",
        "train_batch_size",
        "eval_batch_size",
        "gradient_accumulation_steps",
        "logging_steps",
        "eval_steps",
        "save_steps",
        "early_stopping_patience",
    ]
    for field in positive_integer_fields:
        if int(getattr(args, field)) < 1:
            raise RuntimeError(f"--{field.replace('_', '-')} must be at least 1")
    if args.epochs <= 0:
        raise RuntimeError("--epochs must be greater than zero")
    if args.max_steps is not None and args.max_steps < 1:
        raise RuntimeError("--max-steps must be at least 1")
    if float(getattr(args, "max_grad_norm", 1.0)) <= 0:
        raise RuntimeError("--max-grad-norm must be greater than zero")
    if not 0 <= args.warmup_ratio < 1:
        raise RuntimeError("--warmup-ratio must be at least 0 and below 1")
    if run_kind == "candidate":
        if args.max_steps is not None:
            raise RuntimeError("Candidate runs cannot use --max-steps; use at least one declared epoch with dev evaluation.")
        if args.epochs < 1:
            raise RuntimeError("Candidate runs require --epochs of at least 1.")
        if not args.base_revision or not re.fullmatch(r"[0-9a-fA-F]{40,64}", args.base_revision):
            raise RuntimeError("Candidate runs require --base-revision pinned to an immutable 40-64 character hex revision.")
    if dataset_profile in GOVERNED_V05_PROFILES:
        if run_kind in {"preflight", "pilot", "candidate"} and args.seed not in {419805, 419806}:
            raise RuntimeError("Governed v0.5-series runs require seed 419805 or 419806.")
        if run_kind in {"preflight", "pilot", "candidate"}:
            if args.base_model_id != DEFAULT_BASE_MODEL:
                raise RuntimeError("v0.5 runs require the canonical Gemma 4 E2B base model id.")
            if not args.base_revision or not re.fullmatch(r"[0-9a-fA-F]{40,64}", args.base_revision):
                raise RuntimeError("v0.5 runs require an immutable base revision.")
            if run_kind in {"pilot", "candidate"} and args.max_steps is not None:
                raise RuntimeError("v0.5 pilot and candidate runs cannot use --max-steps; complete epochs are required.")
            if run_kind == "preflight" and (args.max_steps != 1 or args.seed != 419805 or args.learning_rate != 1e-5):
                raise RuntimeError("v0.5 preflight requires max-steps 1, seed 419805, and learning rate 1e-5.")
            if not 1 <= args.epochs <= 3:
                raise RuntimeError("v0.5 runs require 1 to 3 declared epochs.")
            if args.learning_rate not in {1e-5, 2e-5}:
                raise RuntimeError("v0.5 learning rate must be 1e-5 or 2e-5.")
            if dataset_profile == "v052" and run_kind == "pilot" and args.learning_rate != 2e-5:
                raise RuntimeError("v0.5.2 pilot requires the frozen 2e-5 learning rate.")
            if dataset_profile == "v053" and run_kind == "pilot" and args.learning_rate != 1e-5:
                raise RuntimeError("v0.5.3 pilot requires the frozen 1e-5 learning rate.")
            if dataset_profile == "v054" and run_kind == "pilot" and args.learning_rate != 2e-5:
                raise RuntimeError("v0.5.4 pilot requires the frozen 2e-5 learning rate.")
            if dataset_profile == "v055" and run_kind == "pilot" and args.learning_rate != 1e-5:
                raise RuntimeError("v0.5.5 pilot requires the frozen 1e-5 learning rate.")
            if dataset_profile == "v056" and run_kind == "pilot" and args.learning_rate != 2e-5:
                raise RuntimeError("v0.5.6 pilot requires the frozen 2e-5 learning rate.")
            if dataset_profile == "v054" and run_kind == "pilot" and args.seed != 419805:
                raise RuntimeError("v0.5.4 authorizes one targeted pilot at seed 419805 only.")
            if dataset_profile == "v055" and run_kind == "pilot" and args.seed != 419805:
                raise RuntimeError("v0.5.5 authorizes one final targeted pilot at seed 419805 only.")
            if dataset_profile == "v056" and run_kind == "pilot" and args.seed != 419805:
                raise RuntimeError("v0.5.6 authorizes one bounded targeted pilot at seed 419805 only.")
            if args.lora_r not in {8, 16} or args.lora_alpha != 16 or args.lora_dropout != 0.05:
                raise RuntimeError("v0.5 LoRA configuration requires rank 8/16, alpha 16, and dropout 0.05.")
            if args.lora_r == 16 and not args.lora_rank_approval_ref:
                raise RuntimeError("v0.5 rank 16 requires a documented approved pilot underfitting evidence reference.")
            if run_kind in {"pilot", "candidate"} and (args.eval_steps != 25 or args.save_steps != 25):
                raise RuntimeError("v0.5 pilot and candidate runs require evaluation/save cadence of 25 steps.")
            if run_kind == "preflight" and (args.eval_steps != 1 or args.save_steps != 1):
                raise RuntimeError("v0.5 preflight requires evaluation/save cadence of 1 step.")
            if dataset_profile in {"v054", "v055", "v056"} and run_kind == "preflight" and args.logging_steps != 1:
                raise RuntimeError("v0.5.4+ preflight requires training-loss logging at step 1.")
            if (
                args.max_seq_length != 1024
                or args.train_batch_size != 1
                or args.gradient_accumulation_steps != 8
                or args.warmup_ratio != 0.03
                or args.lr_scheduler_type != "cosine"
                or args.early_stopping_patience != 3
                or float(getattr(args, "max_grad_norm", 1.0)) != 1.0
            ):
                raise RuntimeError("v0.5 fixed sequence, batch, clipping, scheduler, warmup, and early-stopping configuration differs from the approved plan.")
        if dataset_profile == "v052" and run_kind == "candidate":
            raise RuntimeError("v0.5.2 full candidate submission is not authorized by the frozen pilot recipe.")
        if dataset_profile == "v053" and run_kind == "candidate":
            raise RuntimeError("v0.5.3 full candidate submission is not authorized by the frozen pilot recipe.")
        if dataset_profile == "v054" and run_kind == "candidate":
            raise RuntimeError("v0.5.4 full candidate submission is not authorized by the frozen targeted-pilot recipe.")
        if dataset_profile == "v055" and run_kind == "candidate":
            raise RuntimeError("v0.5.5 full candidate submission is not authorized by the frozen final-pilot recipe.")
        if dataset_profile == "v056" and run_kind == "candidate":
            raise RuntimeError("v0.5.6 full candidate submission is not authorized by the frozen targeted-pilot recipe.")
    if run_kind == "formatting-smoke" and args.max_steps is None:
        args.max_steps = 1
    if run_kind == "pilot" and dataset_profile not in GOVERNED_V05_PROFILES and args.max_steps is None:
        args.max_steps = 1
    if args.save_steps % args.eval_steps != 0:
        raise RuntimeError("--save-steps must be a multiple of --eval-steps for reproducible best-checkpoint loading.")


def make_run_id(args: argparse.Namespace) -> str:
    if args.run_id:
        return args.run_id
    suffix = "tiny-smoke" if args.tiny_smoke else "gemma4-e2b-lora"
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"saferide-{suffix}-{timestamp}"


def write_metadata(run_dir: Path, metadata: dict[str, Any]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(metadata, allow_nan=False, indent=2, sort_keys=True)
    (run_dir / "metadata.json").write_text(payload, encoding="utf-8")


def sanitized_error_message(error: Exception) -> str:
    message = str(error).replace("\r", " ").replace("\n", " ")
    message = re.sub(r"([?&](?:token|access_token|signature|sig)=)[^&\s]+", r"\1[redacted]", message, flags=re.I)
    for variable in ["HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"]:
        secret = os.environ.get(variable)
        if secret and len(secret) >= 8:
            message = message.replace(secret, "[redacted]")
    message = re.sub(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b", "[redacted]", message)
    return message[:500] or "training runner failed without a message"


def import_training_deps():
    try:
        import torch  # type: ignore
        from datasets import Dataset  # type: ignore
        from peft import LoraConfig, get_peft_model  # type: ignore
        from transformers import (  # type: ignore
            AutoModelForCausalLM,
            AutoTokenizer,
            EarlyStoppingCallback,
            Trainer,
            TrainerCallback,
            TrainingArguments,
        )
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Missing ML dependency. Use Python 3.12 and install torch, transformers, datasets, and peft "
            "in a local venv before running an actual fine-tune."
        ) from error
    return {
        "torch": torch,
        "Dataset": Dataset,
        "LoraConfig": LoraConfig,
        "get_peft_model": get_peft_model,
        "AutoModelForCausalLM": AutoModelForCausalLM,
        "AutoTokenizer": AutoTokenizer,
        "EarlyStoppingCallback": EarlyStoppingCallback,
        "Trainer": Trainer,
        "TrainerCallback": TrainerCallback,
        "TrainingArguments": TrainingArguments,
    }


def _token_ids(value: Any) -> list[int]:
    if isinstance(value, Mapping):
        value = value.get("input_ids")
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, list) and value and isinstance(value[0], list):
        value = value[0]
    if not isinstance(value, list) or not all(isinstance(token, int) for token in value):
        raise RuntimeError("Tokenizer chat template did not return a flat integer input_ids list.")
    return value


def apply_canonical_chat_template(tokenizer: Any, messages: list[dict[str, str]], *, generation_prompt: bool) -> list[int]:
    """Tokenize with the model's canonical chat template; never fall back to role labels."""

    apply_template = getattr(tokenizer, "apply_chat_template", None)
    if not callable(apply_template):
        raise RuntimeError("Tokenizer has no apply_chat_template; manual role-label fallback is forbidden.")
    chat_template = getattr(tokenizer, "chat_template", None)
    if not isinstance(chat_template, str) or not chat_template.strip():
        raise RuntimeError("Tokenizer chat_template is missing; manual role-label fallback is forbidden.")
    try:
        encoded = apply_template(
            messages,
            tokenize=True,
            add_generation_prompt=generation_prompt,
            return_tensors=None,
        )
    except Exception as error:  # noqa: BLE001 - convert tokenizer failures to a fail-closed gate.
        raise RuntimeError("Canonical chat-template tokenization failed; training is blocked.") from error
    return _token_ids(encoded)


def encode_assistant_only_row(tokenizer: Any, row: dict[str, Any], max_seq_length: int) -> dict[str, Any]:
    """Return canonical input ids with labels only for every assistant response span."""

    messages = row.get("messages")
    if not isinstance(messages, list) or not messages:
        raise RuntimeError("Training row has no messages.")
    final_ids = apply_canonical_chat_template(tokenizer, messages, generation_prompt=False)
    if len(final_ids) > max_seq_length:
        raise RuntimeError(
            f"Training row {row.get('id', '<unknown>')} has {len(final_ids)} tokens, exceeding "
            f"--max-seq-length {max_seq_length}; silent truncation is forbidden."
        )
    labels = [-100] * len(final_ids)
    assistant_turns = 0
    assistant_tokens = 0
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        assistant_turns += 1
        prompt_ids = apply_canonical_chat_template(tokenizer, messages[:index], generation_prompt=True)
        completed_ids = apply_canonical_chat_template(tokenizer, messages[: index + 1], generation_prompt=False)
        if completed_ids[: len(prompt_ids)] != prompt_ids:
            raise RuntimeError(
                "Canonical chat template does not expose a stable assistant-generation prefix; "
                "assistant-only labels cannot be proven."
            )
        if final_ids[: len(completed_ids)] != completed_ids:
            raise RuntimeError("Canonical multi-turn template is not prefix-stable; training is blocked.")
        if len(completed_ids) <= len(prompt_ids):
            raise RuntimeError("Assistant response produced no target tokens; training is blocked.")
        for token_index in range(len(prompt_ids), len(completed_ids)):
            labels[token_index] = final_ids[token_index]
            assistant_tokens += 1
    if assistant_turns == 0 or assistant_tokens == 0:
        raise RuntimeError("Training row contains no assistant target tokens.")
    return {
        "input_ids": final_ids,
        "attention_mask": [1] * len(final_ids),
        "labels": labels,
        "row_id": str(row.get("id", "")),
        "assistant_turn_count": assistant_turns,
        "assistant_token_count": assistant_tokens,
    }


class AssistantOnlyDataCollator:
    def __init__(self, tokenizer: Any, torch: Any):
        if tokenizer.pad_token_id is None:
            raise RuntimeError("Tokenizer pad_token_id is required for assistant-only collation.")
        self.pad_token_id = int(tokenizer.pad_token_id)
        self.torch = torch

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        max_length = max(len(feature["input_ids"]) for feature in features)
        input_ids = []
        attention_masks = []
        labels = []
        for feature in features:
            padding = max_length - len(feature["input_ids"])
            input_ids.append(feature["input_ids"] + [self.pad_token_id] * padding)
            attention_masks.append(feature["attention_mask"] + [0] * padding)
            labels.append(feature["labels"] + [-100] * padding)
        return {
            "input_ids": self.torch.tensor(input_ids, dtype=self.torch.long),
            "attention_mask": self.torch.tensor(attention_masks, dtype=self.torch.long),
            "labels": self.torch.tensor(labels, dtype=self.torch.long),
        }


TEXT_LORA_PROJECTION_NAMES = {
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
}


def is_gemma4_model_id(model_id: str) -> bool:
    normalized = model_id.lower()
    return "gemma-4" in normalized or "gemma4" in normalized


def target_modules_for(model_id: str, tiny_smoke: bool) -> list[str]:
    if tiny_smoke or "gpt2" in model_id.lower():
        return ["c_attn"]
    return ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def discover_gemma4_text_lora_targets(model: Any, torch: Any) -> list[str]:
    """Return exact text-decoder linear projection module names for Gemma 4.

    Gemma 4 also contains multimodal projection wrappers that PEFT cannot wrap
    directly for this text-only LoRA pass. Selecting exact text decoder linears
    prevents adapters from landing outside the language-model loss path.
    """

    direct_targets: list[str] = []
    nested_linear_targets: list[str] = []
    excluded_path_markers = (
        ".audio",
        ".audio_tower.",
        ".embed_audio.",
        ".multi_modal",
        ".multimodal",
        ".vision",
        ".vision_tower.",
        ".vision_model.",
    )

    for name, module in model.named_modules():
        if not name or not isinstance(module, torch.nn.Linear):
            continue

        dotted_name = f".{name}."
        if any(marker in dotted_name for marker in excluded_path_markers):
            continue
        if ".layers." not in dotted_name:
            continue
        if ".self_attn." not in dotted_name and ".mlp." not in dotted_name:
            continue

        parts = name.split(".")
        leaf_name = parts[-1]
        parent_name = parts[-2] if len(parts) >= 2 else ""
        if leaf_name in TEXT_LORA_PROJECTION_NAMES:
            direct_targets.append(name)
        elif leaf_name == "linear" and parent_name in TEXT_LORA_PROJECTION_NAMES:
            nested_linear_targets.append(name)

    return sorted(direct_targets or nested_linear_targets)


def target_modules_for_model(model: Any, torch: Any, model_id: str, tiny_smoke: bool) -> list[str]:
    if is_gemma4_model_id(model_id):
        targets = discover_gemma4_text_lora_targets(model, torch)
        if not targets:
            raise RuntimeError(
                "No Gemma 4 text decoder LoRA target modules were found. "
                "Expected torch.nn.Linear modules under decoder layer self_attn/mlp projections."
            )
        return targets
    return target_modules_for(model_id, tiny_smoke)


def trainable_parameter_summary(model: Any) -> dict[str, Any]:
    total_params = 0
    trainable_params = 0
    trainable_names: list[str] = []
    for name, parameter in model.named_parameters():
        count = int(parameter.numel())
        total_params += count
        if bool(parameter.requires_grad):
            trainable_params += count
            if len(trainable_names) < 8:
                trainable_names.append(name)

    return {
        "totalParams": total_params,
        "trainableParams": trainable_params,
        "trainablePercent": round((trainable_params / total_params) * 100, 6) if total_params else 0.0,
        "trainableNamePreview": trainable_names,
    }


def assert_trainable_adapter_path(model: Any, trainer: Any, data_collator: Any, train_dataset: Any, torch: Any) -> dict[str, Any]:
    summary = trainable_parameter_summary(model)
    print(
        "LoRA trainable parameters: "
        f"{summary['trainableParams']} / {summary['totalParams']} "
        f"({summary['trainablePercent']}%)"
    )
    if summary["trainableNamePreview"]:
        print("LoRA trainable parameter preview:", ", ".join(summary["trainableNamePreview"]))
    if not summary["trainableParams"]:
        raise RuntimeError("PEFT produced zero trainable parameters. Stop before training.")

    batch = data_collator([train_dataset[0]])
    device = trainer.args.device
    prepared_batch = {
        key: value.to(device) if hasattr(value, "to") else value
        for key, value in batch.items()
    }

    model.train()
    with torch.set_grad_enabled(True):
        outputs = model(**prepared_batch)

    loss = outputs["loss"] if isinstance(outputs, dict) else getattr(outputs, "loss", None)
    if loss is None:
        raise RuntimeError("Gemma 4 LoRA sanity forward did not return a loss.")
    if not bool(getattr(loss, "requires_grad", False)):
        raise RuntimeError(
            "Gemma 4 LoRA sanity loss is detached from trainable parameters. "
            "Check LoRA target modules before running Trainer.train()."
        )
    print("LoRA sanity loss requires grad: True")
    return summary


def model_card_text(args: argparse.Namespace, model_id: str) -> str:
    if args.tiny_smoke:
        title = "SafeRide Tiny PEFT Smoke Adapter"
        status = "Pipeline smoke only. This is not a SafeRide Gemma 4 E2B model."
        readiness = "pipeline-smoke-only"
    else:
        title = "SafeRide Gemma 4 E2B Prototype Adapter"
        status = "Prototype adapter. Not approved for mobile export, release, or UNICEF-facing claims."
        readiness = "private-prototype-evaluation-only"

    if args.train_data and args.dev_data:
        data_name = f"{Path(args.train_data).name} + {Path(args.dev_data).name}"
        dataset_version = "v0.5"
    else:
        data_name = Path(args.data).name if args.data else "not-recorded"
        dataset_version = "v0.4"
    register_name = Path(args.register).name if args.register else "not-recorded"
    base_revision = args.base_revision or "not-pinned-in-card"
    dataset_repo = os.environ.get("SAFERIDE_HF_DATASET_REPO", "V-ince-18/saferide-gemma-4-e2b-training-data")
    evidence_repo = os.environ.get("SAFERIDE_HF_EVIDENCE_REPO", "V-ince-18/saferide-gemma-4-e2b-eval-evidence")

    return f"""---
library_name: peft
base_model: {model_id}
license: other
pipeline_tag: text-generation
datasets:
  - {dataset_repo}
language:
  - en
  - sw
tags:
  - peft
  - lora
  - saferide
  - gemma-4-e2b
  - synthetic-data
  - private-evaluation
  - survivor-safety
---

# {title}

## Status

{status}

Readiness state: `{readiness}`.

This adapter was produced by the guarded SafeRide fine-tuning runner for
controlled engineering review. It is not a standalone model, not an Android
runtime artifact, and not a product-release asset.

## Model Layer Distinction

SafeRide tracks three different layers because each one proves a different
thing:

| Layer | Identifier | What it means |
| --- | --- | --- |
| Trainable base | `{model_id}` | Transformers/PEFT base used for LoRA training. |
| Adapter artifact | This private Hugging Face repo/revision | Small PEFT LoRA delta produced by a controlled run. |
| Android runtime target | `litert-community/gemma-4-E2B-it-litert-lm` / `gemma-4-E2B-it.litertlm` | Phone runtime path that still needs separate export and device proof. |

Do not treat this adapter as mobile-ready just because it exists on Hugging
Face. PEFT adapter storage, safety scoring, export/conversion, and physical
Android proof are separate gates.

## Training Lineage

| Field | Value |
| --- | --- |
| Base revision | `{base_revision}` |
| Hugging Face dataset repo | `{dataset_repo}` |
| Register | `{register_name}` |
| Data file | `{data_name}` |
| Run kind | `{resolve_run_kind(args)}` |
| Epochs | `{args.epochs}` |
| Max steps | `{args.max_steps if args.max_steps is not None else 'not capped'}` |
| Max sequence length | `{args.max_seq_length}` |
| Learning rate | `{args.learning_rate}` |
| LoRA rank | `{args.lora_r}` |
| LoRA alpha | `{args.lora_alpha}` |
| LoRA dropout | `{args.lora_dropout}` |

Detailed run metadata, package versions, environment facts, data-gate output,
adapter file hashes, and privacy flags are stored in `metadata.json` when that
file is uploaded beside the adapter.

## Dataset Registry

The linked dataset repo is private for this phase. It is not just a file dump;
it is the controlled training-data registry for this adapter lane.

| Asset | Expected location |
| --- | --- |
| Dataset card and Dataset Viewer split config | `{dataset_repo}/README.md` |
| Machine-readable manifest | `{dataset_repo}/MANIFEST.json` |
| Split JSONL files | `{dataset_repo}/data/{dataset_version}/*.jsonl` |
| Register snapshot | `{dataset_repo}/registers/{register_name}` |
| Checksum ledger | `{dataset_repo}/checksums/SHA256SUMS.txt` |
| Datasheet, schema, split policy, governance, checklist | `{dataset_repo}/docs/` |

Only the train split may be used for optimizer updates. Dev, quality-holdout,
and safety-holdout splits remain evaluation controls.

## Evidence Registry

Private generation bundles, sanitized review templates, scored results, and
sanitized safety reports belong in `{evidence_repo}`, not in this model repo.
That separation keeps adapter weights, training data, and evaluation evidence
auditable without mixing raw model outputs into the model card.

## Safety And Readiness Gates

This artifact can move forward only if the following gates are satisfied and
recorded:

1. Strict data/register gate passed immediately before training.
2. Adapter files were inventoried with SHA-256 hashes.
3. Adapter was staged privately on Hugging Face and pinned by commit SHA.
4. The pinned adapter commit and file hashes were verified before generation.
5. The 120-prompt SafeRide safety harness generated private outputs.
6. Human reviewers filled only sanitized scores and notes.
7. The safety harness passed with no critical failures and required averages.
8. Export/conversion feasibility was proven for the Android runtime path.
9. Physical Android devices produced acceptable offline behavior, latency,
   memory, cancellation, and failure-mode evidence.

Until all applicable gates pass, this adapter is for private engineering review
only.

## Current Non-Claims

This artifact does not prove:

- survivor safety,
- medical, legal, counselling, emergency, or safeguarding authority,
- mobile readiness,
- pilot readiness,
- UNICEF readiness,
- release readiness,
- public multilingual quality,
- production use approval,
- public sharing approval,
- training on survivor data.

## Privacy And Data Boundaries

- No survivor reports, evidence files, raw transcripts, private locations,
  credentials, signed URLs, raw prompts, raw completions, or production logs are
  included in this artifact.
- Raw training rows and raw model outputs must not be published in this model
  card, issue comments, pull requests, screenshots, public reports, or public
  datasets.
- Private generation evidence belongs in the private SafeRide HF evidence repo,
  not in this model repo README.

## Private Evaluation Loading Pattern

Use pinned revisions only. Do not evaluate a moving `main` branch as if it were
an immutable artifact.

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base_model_id = "{model_id}"
adapter_repo = "<private-safeRide-adapter-repo>"
adapter_revision = "<pinned-hf-commit-sha>"

tokenizer = AutoTokenizer.from_pretrained(base_model_id, revision="{base_revision}")
base = AutoModelForCausalLM.from_pretrained(base_model_id, revision="{base_revision}")
model = PeftModel.from_pretrained(base, adapter_repo, revision=adapter_revision)
```

Keep raw prompts and completions in private, ignored evidence storage. Publish
only aggregate safety results, failure categories, hashes, and gate decisions.

## Ownership And Change Control

This adapter is controlled under SafeRide AI issue gates. Public upload,
production use, mobile export, and partner-facing claims require separate
recorded approval and evidence.
"""


def run_training(
    args: argparse.Namespace,
    run_dir: Path,
    rows: list[dict[str, Any]],
    run_kind: str,
    *,
    dataset_profile: str = "v04",
    pilot_row_ids: list[str] | None = None,
) -> dict[str, Any]:
    deps = import_training_deps()
    torch = deps["torch"]

    model_id = TINY_SMOKE_MODEL if args.tiny_smoke else args.base_model_id
    local_files_only = not args.allow_base_download
    cuda_available = bool(torch.cuda.is_available())
    use_bf16 = cuda_bf16_supported(torch, cuda_available)
    precision = "bf16" if use_bf16 else "fp16" if cuda_available else "fp32"
    print(f"Training precision selected: {precision}")
    if not args.tiny_smoke and not cuda_available and not args.approved_local_cpu_risk:
        raise RuntimeError(
            "This machine has no CUDA GPU. Refusing a non-tiny Gemma fine-tune without "
            "--approved-local-cpu-risk because CPU-only E2B fine-tuning is likely impractical."
        )
    if int(os.environ.get("WORLD_SIZE", "1")) != 1:
        raise RuntimeError("This runner records a single exact sample order and therefore requires WORLD_SIZE=1.")

    train_rows = [row for row in rows if row.get("split") == "train"]
    dev_rows = [row for row in rows if row.get("split") == "dev"]
    if not train_rows or not dev_rows:
        raise RuntimeError("Training requires distinct non-empty train and dev splits; fallback between splits is forbidden.")
    if dataset_profile in GOVERNED_V05_PROFILES:
        if run_kind == "preflight":
            train_rows = sorted(train_rows, key=lambda row: str(row.get("id", "")))[:1]
            dev_rows = sorted(dev_rows, key=lambda row: str(row.get("id", "")))[:1]
        expected_train_rows = 1888 if dataset_profile == "v056" else 1896 if dataset_profile == "v055" else 1864 if dataset_profile == "v054" else 1832 if dataset_profile == "v053" else 1768 if dataset_profile == "v052" else 1720 if dataset_profile == "v051" else 1600
        if run_kind == "candidate" and (len(train_rows) != expected_train_rows or len(dev_rows) != 300):
            raise RuntimeError(f"Governed candidate requires exactly {expected_train_rows:,} train rows and 300 development rows.")
        if run_kind == "pilot":
            available = {str(row.get("id", "")) for row in train_rows}
            if dataset_profile in WEIGHTED_PILOT_PROFILES:
                expected = WEIGHTED_PILOT_PROFILES[dataset_profile]
                version = {"v052": "v0.5.2", "v053": "v0.5.3", "v054": "v0.5.4", "v055": "v0.5.5", "v056": "v0.5.6"}[dataset_profile]
                order = pilot_row_ids or []
                by_id = {str(row.get("id", "")): row for row in train_rows}
                if len(order) != expected["weightedRows"] or len(set(order)) != expected["uniqueRows"] or not set(order).issubset(available):
                    raise RuntimeError(f"Governed {version} pilot must bind the exact {expected['weightedRows']:,}-example weighted order.")
                train_rows = [by_id[row_id] for row_id in order]
            else:
                selected = set(pilot_row_ids or [])
                if len(selected) != 320 or not selected.issubset(available):
                    raise RuntimeError("Governed pilot selection must bind exactly 320 available training row IDs.")
                train_rows = [row for row in train_rows if str(row.get("id", "")) in selected]
    if not (dataset_profile in WEIGHTED_PILOT_PROFILES and run_kind == "pilot"):
        random.Random(args.seed).shuffle(train_rows)

    model_source = str(Path(args.base_model_path).expanduser().resolve()) if args.base_model_path else model_id
    if args.base_model_path and not Path(model_source).is_dir():
        raise RuntimeError("--base-model-path is unavailable or is not a directory.")
    load_kwargs: dict[str, Any] = {"local_files_only": local_files_only}
    if not args.base_model_path:
        load_kwargs["revision"] = args.base_revision
    tokenizer = deps["AutoTokenizer"].from_pretrained(model_source, **load_kwargs)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    if tokenizer.pad_token_id is None:
        raise RuntimeError("Tokenizer has no pad or EOS token; training is blocked.")
    tokenizer_revision = getattr(tokenizer, "init_kwargs", {}).get("_commit_hash") or args.base_revision
    chat_template = getattr(tokenizer, "chat_template", None)
    if not isinstance(chat_template, str) or not chat_template.strip():
        raise RuntimeError("Tokenizer has no canonical chat template; training is blocked.")
    chat_template_sha256 = hashlib.sha256(chat_template.encode("utf-8")).hexdigest()

    model_kwargs: dict[str, Any] = {
        "local_files_only": local_files_only,
        "dtype": torch.bfloat16 if use_bf16 else torch.float16 if cuda_available else torch.float32,
    }
    if not args.base_model_path:
        model_kwargs["revision"] = args.base_revision
    if cuda_available and not args.tiny_smoke:
        model_kwargs["low_cpu_mem_usage"] = True
        model_kwargs["device_map"] = {"": 0}

    model = deps["AutoModelForCausalLM"].from_pretrained(model_source, **model_kwargs)
    if getattr(model.config, "pad_token_id", None) is None:
        model.config.pad_token_id = tokenizer.pad_token_id
    if hasattr(model.config, "use_cache"):
        model.config.use_cache = False
    if not args.tiny_smoke and hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable()
        if hasattr(model, "enable_input_require_grads"):
            model.enable_input_require_grads()

    lora_target_modules = target_modules_for_model(model, torch, model_id, args.tiny_smoke)
    print(f"LoRA target modules selected: {len(lora_target_modules)}")
    print("LoRA target module preview:", ", ".join(lora_target_modules[:8]))
    lora_config = deps["LoraConfig"](
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=lora_target_modules,
    )
    model = deps["get_peft_model"](model, lora_config)

    dataset_cls = deps["Dataset"]
    encoded_train = [encode_assistant_only_row(tokenizer, row, args.max_seq_length) for row in train_rows]
    encoded_dev = [encode_assistant_only_row(tokenizer, row, args.max_seq_length) for row in dev_rows]
    train_dataset = dataset_cls.from_list(encoded_train)
    eval_dataset = dataset_cls.from_list(encoded_dev)

    eval_steps = min(args.eval_steps, args.max_steps) if args.max_steps is not None else args.eval_steps
    save_steps = min(args.save_steps, args.max_steps) if args.max_steps is not None else args.save_steps
    checkpoint_root = Path(args.checkpoint_root).expanduser().resolve() if args.checkpoint_root else None
    trainer_dir = checkpoint_root / run_dir.name if checkpoint_root else run_dir / "trainer"
    trainer_dir.mkdir(parents=True, exist_ok=True)
    training_arguments: dict[str, Any] = {
        "output_dir": str(trainer_dir),
        "num_train_epochs": args.epochs,
        "per_device_train_batch_size": args.train_batch_size,
        "per_device_eval_batch_size": args.eval_batch_size,
        "gradient_accumulation_steps": args.gradient_accumulation_steps,
        "max_grad_norm": args.max_grad_norm,
        "learning_rate": args.learning_rate,
        "warmup_ratio": args.warmup_ratio,
        "lr_scheduler_type": args.lr_scheduler_type,
        "logging_steps": args.logging_steps,
        "save_steps": save_steps,
        "eval_steps": eval_steps,
        "eval_strategy": "steps",
        "save_strategy": "steps",
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_loss",
        "greater_is_better": False,
        "report_to": [],
        # Full candidates retain every governed checkpoint for immutable
        # recovery/evidence. Historical pilots keep their bounded retention.
        "save_total_limit": None if run_kind == "candidate" else 2,
        "use_cpu": not cuda_available,
        "seed": args.seed,
        "data_seed": args.seed,
        "remove_unused_columns": False,
        "bf16": use_bf16,
        "fp16": cuda_available and not use_bf16,
        "gradient_checkpointing": not args.tiny_smoke,
    }
    if args.max_steps is not None:
        training_arguments["max_steps"] = args.max_steps
    training_args = deps["TrainingArguments"](
        **training_arguments,
    )
    data_collator = AssistantOnlyDataCollator(tokenizer, torch)
    class OrderedTrainer(deps["Trainer"]):
        def _get_train_sampler(self, train_dataset=None):  # type: ignore[no-untyped-def]
            dataset = train_dataset if train_dataset is not None else self.train_dataset
            return torch.utils.data.SequentialSampler(dataset)

    callbacks: list[Any] = [deps["EarlyStoppingCallback"](early_stopping_patience=args.early_stopping_patience)]
    consumption_marker = os.environ.get("SAFERIDE_CANDIDATE_CONSUMPTION_MARKER")
    if run_kind == "candidate":
        if not consumption_marker:
            raise RuntimeError("Candidate execution requires an explicit optimization-consumption marker path.")
        marker_path = Path(consumption_marker).expanduser().resolve()
        marker_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker_path.parent.chmod(0o700)

        class CandidateConsumptionCallback(deps["TrainerCallback"]):
            def on_pre_optimizer_step(self, args, state, control, **kwargs):  # type: ignore[no-untyped-def]
                if not marker_path.exists():
                    payload = {
                        "schema": "com.saferide.ai.candidate-consumption-marker",
                        "schemaVersion": 1,
                        "status": "candidate-authorization-consumed",
                        "firstOptimizerStep": int(state.global_step) + 1,
                    }
                    marker_path.write_text(
                        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
                        encoding="utf-8",
                    )
                    marker_path.chmod(0o600)
                return control

        callbacks.append(CandidateConsumptionCallback())

    trainer = OrderedTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=data_collator,
        processing_class=tokenizer,
        callbacks=callbacks,
    )
    trainable_summary = assert_trainable_adapter_path(model, trainer, data_collator, train_dataset, torch)
    existing_checkpoints = sorted(
        (path for path in trainer_dir.glob("checkpoint-*") if path.is_dir()),
        key=lambda path: int(path.name.rsplit("-", 1)[-1]) if path.name.rsplit("-", 1)[-1].isdigit() else -1,
    )
    resumed_from_checkpoint = existing_checkpoints[-1] if existing_checkpoints else None
    train_result = trainer.train(resume_from_checkpoint=str(resumed_from_checkpoint) if resumed_from_checkpoint else None)
    eval_metrics = final_evaluation_metrics(trainer)
    assert_finite_training_evidence({
        "trainMetrics": train_result.metrics,
        "devMetrics": eval_metrics,
        "logHistory": trainer.state.log_history,
    })
    if (run_kind == "candidate" or (dataset_profile in GOVERNED_V05_PROFILES and run_kind == "pilot")) \
            and float(trainer.state.epoch or 0) < 0.999:
        raise RuntimeError("Governed pilot/candidate stopped before one full epoch; it cannot support selection.")

    loss_report = None
    if dataset_profile in {"v054", "v055", "v056"}:
        remediation_path = V056_REMEDIATION_PATH if dataset_profile == "v056" else V055_REMEDIATION_PATH if dataset_profile == "v055" else V054_REMEDIATION_PATH
        spec = importlib.util.spec_from_file_location(f"saferide_{dataset_profile}_runner_remediation", remediation_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("v0.5.4+ truthful-loss implementation is unavailable.")
        remediation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(remediation)
        resumed_step = None
        if resumed_from_checkpoint is not None:
            suffix = resumed_from_checkpoint.name.rsplit("-", 1)[-1]
            if not suffix.isdigit():
                raise RuntimeError("v0.5.4+ resume checkpoint step is malformed.")
            resumed_step = int(suffix)
        if run_kind == "preflight":
            loss_report = remediation.build_preflight_loss_report(
                train_metrics=train_result.metrics,
                log_history=trainer.state.log_history,
                recorded_best_metric=trainer.state.best_metric,
            )
        else:
            loss_report = remediation.build_loss_report(
                train_metrics=train_result.metrics,
                log_history=trainer.state.log_history,
                gradient_accumulation_steps=args.gradient_accumulation_steps,
                resumed_from_step=resumed_step,
                recorded_best_metric=trainer.state.best_metric,
            )

    adapter_dir = run_dir / "adapter"
    model.save_pretrained(adapter_dir)
    tokenizer.save_pretrained(adapter_dir / "tokenizer")
    (adapter_dir / "README.md").write_text(model_card_text(args, model_id), encoding="utf-8")
    tensor_validation = verify_finite_adapter_tensors(adapter_dir / "adapter_model.safetensors", torch)

    adapter_files = []
    for path in sorted(adapter_dir.rglob("*")):
        if path.is_file():
            adapter_files.append(
                {
                    "path": rel(path),
                    "sizeBytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )

    checkpoint_manifests = []
    for checkpoint_dir in sorted(trainer_dir.glob("checkpoint-*")):
        files = [
            {"path": rel(file), "sizeBytes": file.stat().st_size, "sha256": sha256_file(file)}
            for file in sorted(checkpoint_dir.rglob("*"))
            if file.is_file()
        ]
        checkpoint_manifests.append({
            "path": rel(checkpoint_dir),
            "fileCount": len(files),
            "manifestSha256": hashlib.sha256(
                json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
        })
    safe_log_history = []
    for entry in trainer.state.log_history:
        safe_log_history.append({
            key: value for key, value in entry.items()
            if key in {"epoch", "step", "loss", "eval_loss", "learning_rate", "grad_norm", "train_runtime", "train_samples_per_second", "train_steps_per_second"}
            and isinstance(value, (int, float))
        })
    train_tokens = sum(len(item["input_ids"]) for item in encoded_train)
    dev_tokens = sum(len(item["input_ids"]) for item in encoded_dev)
    assistant_train_tokens = sum(item["assistant_token_count"] for item in encoded_train)
    assistant_dev_tokens = sum(item["assistant_token_count"] for item in encoded_dev)

    return {
        "modelId": model_id,
        "modelSource": "staged-offline-snapshot" if args.base_model_path else "hugging-face-hub",
        "baseRevision": args.base_revision,
        "tokenizerRevision": tokenizer_revision,
        "chatTemplateSha256": chat_template_sha256,
        "tinySmoke": args.tiny_smoke,
        "runKind": run_kind,
        "precision": precision,
        "epochsRequested": args.epochs,
        "epochsCompleted": float(trainer.state.epoch or 0),
        "maxSteps": args.max_steps,
        "globalSteps": int(trainer.state.global_step),
        "bestCheckpoint": rel(Path(trainer.state.best_model_checkpoint)) if trainer.state.best_model_checkpoint else None,
        "bestMetric": trainer.state.best_metric,
        "selectionMetric": "eval_loss",
        "resumedFromCheckpoint": rel(resumed_from_checkpoint) if resumed_from_checkpoint else None,
        "sampleOrder": [str(row["id"]) for row in train_rows],
        "sampleOrderSha256": hashlib.sha256(
            "\n".join(str(row["id"]) for row in train_rows).encode("utf-8")
        ).hexdigest(),
        "sampleOrderPolicy": "frozen-explicit-weighted-order" if dataset_profile in WEIGHTED_PILOT_PROFILES and run_kind == "pilot" else "seeded-once-then-sequential; repeated unchanged for each epoch",
        "trainRowIds": sorted({str(row["id"]) for row in train_rows}),
        "trainRowIdSha256": hashlib.sha256(
            "\n".join(sorted({str(row["id"]) for row in train_rows})).encode("utf-8")
        ).hexdigest(),
        "developmentRowIds": sorted(str(row["id"]) for row in dev_rows),
        "developmentRowIdSha256": hashlib.sha256(
            "\n".join(sorted(str(row["id"]) for row in dev_rows)).encode("utf-8")
        ).hexdigest(),
        "holdoutRowsRead": 0,
        "rowsSeen": min(
            int(round(float(trainer.state.epoch or 0) * len(train_rows))),
            int(args.epochs * len(train_rows)),
        ),
        "dataTokens": {
            "train": train_tokens,
            "dev": dev_tokens,
            "assistantTrain": assistant_train_tokens,
            "assistantDev": assistant_dev_tokens,
        },
        "lossMaskPolicy": "assistant-turns-only",
        "effectiveBatchSize": args.train_batch_size * args.gradient_accumulation_steps,
        "trainMetrics": {key: value for key, value in train_result.metrics.items() if isinstance(value, (int, float))},
        "devMetrics": {key: value for key, value in eval_metrics.items() if isinstance(value, (int, float))},
        "lossReport": loss_report,
        "logHistory": safe_log_history,
        "maxCudaMemoryBytes": int(torch.cuda.max_memory_allocated()) if cuda_available else 0,
        "loraTargetModuleCount": len(lora_target_modules),
        "loraTargetModulePreview": lora_target_modules[:8],
        "trainableParameterSummary": trainable_summary,
        "adapterDir": rel(adapter_dir),
        "adapterFiles": adapter_files,
        "adapterTensorValidation": tensor_validation,
        "checkpointRoot": rel(trainer_dir),
        "checkpoints": checkpoint_manifests,
    }


def main() -> int:
    args = parse_args()
    register = Path(args.register).expanduser().resolve()
    data = Path(args.data).expanduser().resolve() if args.data else None
    train_data = Path(args.train_data).expanduser().resolve() if args.train_data else None
    dev_data = Path(args.dev_data).expanduser().resolve() if args.dev_data else None
    audit = Path(args.audit).expanduser().resolve() if args.audit else None
    dataset_manifest = Path(args.dataset_manifest).expanduser().resolve() if args.dataset_manifest else None
    artifact_root = Path(args.artifact_root).expanduser().resolve() if args.artifact_root else None
    base_model_path = Path(args.base_model_path).expanduser().resolve() if args.base_model_path else None
    pilot_row_manifest = Path(args.pilot_row_manifest).expanduser().resolve() if args.pilot_row_manifest else None
    requirements = DEFAULT_REQUIREMENTS.resolve()
    constraints = Path(args.constraints).expanduser().resolve()
    run_kind = resolve_run_kind(args)

    if not register.is_file():
        raise RuntimeError(f"Register not found: {register}")
    register_document = read_json(register)
    dataset_profile = dataset_profile_for_register(register_document)
    validate_run_configuration(args, run_kind, dataset_profile)
    run_id = make_run_id(args)
    run_dir = Path(args.output_root).expanduser().resolve() / run_id
    if data is not None and (train_data is not None or dev_data is not None):
        raise RuntimeError("Use either --data or the v0.5 --train-data/--dev-data pair, never both.")
    if (train_data is None) != (dev_data is None):
        raise RuntimeError("--train-data and --dev-data must be supplied together.")
    if dataset_profile in GOVERNED_V05_PROFILES and data is not None:
        raise RuntimeError("Governed v0.5-series runs require separate --train-data and --dev-data inputs; combined holdout-bearing --data is forbidden.")
    if dataset_profile in GOVERNED_V05_PROFILES and not args.dry_run and (train_data is None or dev_data is None):
        raise RuntimeError("Governed training requires separate --train-data and --dev-data inputs.")
    if dataset_profile not in GOVERNED_V05_PROFILES and (train_data is not None or dev_data is not None):
        raise RuntimeError("Separate --train-data/--dev-data inputs require a governed v0.5-series register.")
    if data is not None and not data.is_file():
        raise RuntimeError(f"Data JSONL not found: {data}")
    if train_data is not None and not train_data.is_file():
        raise RuntimeError(f"Training JSONL not found: {train_data}")
    if dev_data is not None and not dev_data.is_file():
        raise RuntimeError(f"Development JSONL not found: {dev_data}")
    if audit is not None and not audit.is_file():
        raise RuntimeError(f"Dataset audit not found: {audit}")
    if dataset_profile in GOVERNED_V05_PROFILES and train_data is not None:
        if dataset_manifest is None or not dataset_manifest.is_file():
            raise RuntimeError("v0.5 runs require --dataset-manifest pointing to the frozen content-free manifest.")
        if artifact_root is None or not artifact_root.is_dir():
            raise RuntimeError("v0.5 runs require --artifact-root for strict hash verification.")
        if audit is None:
            raise RuntimeError("v0.5 pilot and candidate runs require the passed content-free dataset audit.")
        if dataset_profile == "v05":
            registered_manifest_hash = register_document.get("artifacts", {}).get("datasetManifest", {}).get("sha256")
            if sha256_file(dataset_manifest) != registered_manifest_hash:
                raise RuntimeError("v0.5 dataset manifest does not match the approved register binding.")
            dataset_manifest_document = read_json(dataset_manifest)
            registered_pilot_hash = register_document.get("artifacts", {}).get("pilotSelection", {}).get("sha256")
            if dataset_manifest_document.get("pilotSelection", {}).get("sha256") != registered_pilot_hash:
                raise RuntimeError("v0.5 pilot selection differs between the dataset manifest and register.")
            if pilot_row_manifest is not None and sha256_file(pilot_row_manifest) != registered_pilot_hash:
                raise RuntimeError("v0.5 supplied pilot row manifest does not match the approved register binding.")
        elif dataset_profile == "v051" and read_json(dataset_manifest).get("bindings", {}).get("candidateManifestSha256") != register_document.get("candidateManifestSha256"):
            raise RuntimeError("v0.5.1 dataset manifest does not match the governed register binding.")
        elif dataset_profile == "v052" and read_json(dataset_manifest).get("bindings", {}).get("registerSha256") != sha256_file(register):
            raise RuntimeError("v0.5.2 dataset manifest does not match the governed register binding.")
        elif dataset_profile == "v053" and read_json(dataset_manifest).get("bindings", {}).get("registerSha256") != sha256_file(register):
            raise RuntimeError("v0.5.3 dataset manifest does not match the governed register binding.")
        elif dataset_profile == "v054" and read_json(dataset_manifest).get("bindings", {}).get("registerSha256") != sha256_file(register):
            raise RuntimeError("v0.5.4 dataset manifest does not match the governed register binding.")
        elif dataset_profile == "v055" and read_json(dataset_manifest).get("bindings", {}).get("registerSha256") != sha256_file(register):
            raise RuntimeError("v0.5.5 dataset manifest does not match the governed register binding.")
        elif dataset_profile == "v056" and read_json(dataset_manifest).get("bindings", {}).get("registerSha256") != sha256_file(register):
            raise RuntimeError("v0.5.6 dataset manifest does not match the governed register binding.")
    if pilot_row_manifest is not None and not pilot_row_manifest.is_file():
        raise RuntimeError(f"Pilot row manifest not found: {pilot_row_manifest}")
    if not requirements.is_file():
        raise RuntimeError(f"Training requirements not found: {requirements}")
    if not constraints.is_file():
        raise RuntimeError(f"Training constraints not found: {constraints}")
    if base_model_path is not None and not base_model_path.is_dir():
        raise RuntimeError(f"Base-model snapshot not found: {base_model_path}")
    if base_model_path is not None and args.allow_base_download:
        raise RuntimeError("--base-model-path and --allow-base-download are mutually exclusive.")
    training_lock = load_training_lock(requirements, constraints)

    strict_gate = bool(data or train_data)
    gate = run_data_gate(
        register,
        data,
        audit,
        strict=strict_gate,
        dataset_profile=dataset_profile,
        artifact_root=artifact_root,
        train_data=train_data,
        dev_data=dev_data,
        dataset_manifest=dataset_manifest,
        pilot_row_manifest=pilot_row_manifest,
    )
    if strict_gate and not gate["passed"]:
        raise RuntimeError("Fine-tuning data gate failed. Fix the register/data before running fine-tuning.")

    rows = parse_jsonl(data) if data is not None else (
        parse_jsonl(train_data) + parse_jsonl(dev_data) if train_data is not None and dev_data is not None else []
    )
    if dataset_profile in GOVERNED_V05_PROFILES and train_data is not None and dev_data is not None:
        if any(row.get("split") != "train" for row in parse_jsonl(train_data)):
            raise RuntimeError("--train-data may contain only train rows.")
        if any(row.get("split") != "dev" for row in parse_jsonl(dev_data)):
            raise RuntimeError("--dev-data may contain only development rows.")
        if any(row.get("split") in {"quality-holdout", "safety-holdout", "mitigation-holdout"} for row in rows):
            raise RuntimeError("Training process must not read quality, safety, or mitigation holdout rows.")
    pilot_row_ids = load_pilot_row_ids(pilot_row_manifest, dataset_profile, run_kind)
    environment = environment_summary()
    environment.update({
        "requirements": rel(requirements),
        "requirementsSha256": sha256_file(requirements),
        "constraints": rel(constraints),
        "constraintsSha256": sha256_file(constraints),
        "dependencyConstraintsSatisfied": None,
    })
    dataset_bindings: dict[str, Any] | None = None
    if dataset_profile in GOVERNED_V05_PROFILES and train_data is not None:
        if dataset_profile in {"v052", "v053", "v054", "v055", "v056"}:
            register_bindings = register_document.get("bindings", {})
            dataset_bindings = {
                "datasetId": register_document.get("datasetId"),
                "diagnosisSummarySha256": register_bindings.get("diagnosisSummarySha256") or register_bindings.get("diagnosisSha256"),
                "implementationSha256": register_bindings.get("implementationSha256"),
                "mitigationDevelopmentSha256": register_bindings.get("mitigationDevelopmentSha256"),
                "originalDevelopmentSha256": register_bindings.get("originalDevelopmentSha256"),
                "planSha256": register_bindings.get("planSha256"),
                "scoringPolicySha256": register_bindings.get("scoringPolicySha256"),
                "sealedMitigationHoldoutSha256": register_bindings.get("sealedMitigationHoldoutSha256"),
                "systemPromptTextSha256": register_bindings.get("systemPromptTextSha256"),
                **({
                    "v054CombinedTrainSha256": register_bindings.get("v054CombinedTrainSha256"),
                    "v054FrozenManifestSha256": register_bindings.get("v054FrozenManifestSha256"),
                    "v054TrainingRecipeSha256": register_bindings.get("v054TrainingRecipeSha256"),
                    "lossPolicySha256": register_bindings.get("lossPolicySha256"),
                } if dataset_profile == "v056" else {
                    "v054CombinedTrainSha256": register_bindings.get("v054CombinedTrainSha256"),
                    "v054FrozenManifestSha256": register_bindings.get("v054FrozenManifestSha256"),
                    "lossPolicySha256": register_bindings.get("lossPolicySha256"),
                } if dataset_profile == "v055" else {
                    "v053CombinedTrainSha256": register_bindings.get("v053CombinedTrainSha256"),
                    "v053FrozenManifestSha256": register_bindings.get("v053FrozenManifestSha256"),
                    "lossPolicySha256": register_bindings.get("lossPolicySha256"),
                } if dataset_profile == "v054" else {
                    "v052CombinedTrainSha256": register_bindings.get("v052CombinedTrainSha256"),
                    "v052FrozenManifestSha256": register_bindings.get("v052FrozenManifestSha256"),
                } if dataset_profile == "v053" else {
                    "v051CombinedTrainSha256": register_bindings.get("v051CombinedTrainSha256"),
                    "v051FrozenManifestSha256": register_bindings.get("v051FrozenManifestSha256"),
                }),
                "pilotRowManifest": rel(pilot_row_manifest) if pilot_row_manifest else None,
                "pilotRowManifestSha256": sha256_file(pilot_row_manifest) if pilot_row_manifest else None,
            }
        else:
            dataset_bindings = {
                "datasetId": register_document.get("datasetId"),
                "planSha256": register_document.get("bindings", {}).get("plan", {}).get("sha256"),
                "policySha256": register_document.get("bindings", {}).get("policy", {}).get("sha256"),
                "systemPromptConfigSha256": register_document.get("bindings", {}).get("systemPrompt", {}).get("sha256"),
                "systemPromptTextSha256": register_document.get("bindings", {}).get("systemPrompt", {}).get("textSha256"),
                "scenarioSpecSha256": register_document.get("artifacts", {}).get("scenarioSpecs", {}).get("sha256"),
                "splitManifestSha256": register_document.get("artifacts", {}).get("splitManifest", {}).get("sha256"),
                "reviewLedgerSha256": register_document.get("artifacts", {}).get("reviewLedger", {}).get("sha256"),
                "pilotRowManifest": rel(pilot_row_manifest) if pilot_row_manifest else None,
                "pilotRowManifestSha256": sha256_file(pilot_row_manifest) if pilot_row_manifest else None,
            }
    metadata: dict[str, Any] = {
        "schema": "com.saferide.ai.training-run",
        "schemaVersion": 1,
        "runId": run_id,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "issue": "ESH-4198",
        "datasetProfile": dataset_profile,
        "mode": "dry-run" if args.dry_run else "tiny-smoke" if args.tiny_smoke else "prototype-finetune",
        "runKind": run_kind,
        "candidateRun": run_kind == "candidate",
        "promotionEligible": False,
        "status": "preflight-complete" if args.dry_run else "running",
        "baseModelId": TINY_SMOKE_MODEL if args.tiny_smoke else args.base_model_id,
        "baseRevision": args.base_revision or "unresolved",
        "baseModelSource": "staged-offline-snapshot" if base_model_path else "hugging-face-hub",
        "register": rel(register),
        "registerSha256": sha256_file(register),
        "data": rel(data) if data else None,
        "dataSha256": sha256_file(data) if data else None,
        "dataFiles": {
            "train": {"path": rel(train_data), "sha256": sha256_file(train_data)} if train_data else None,
            "dev": {"path": rel(dev_data), "sha256": sha256_file(dev_data)} if dev_data else None,
        } if dataset_profile in GOVERNED_V05_PROFILES and train_data is not None else None,
        "audit": rel(audit) if audit else None,
        "auditSha256": sha256_file(audit) if audit else None,
        "datasetManifest": rel(dataset_manifest) if dataset_manifest else None,
        "datasetManifestSha256": sha256_file(dataset_manifest) if dataset_manifest else None,
        "datasetBindings": dataset_bindings,
        "dataGate": gate,
        "dataSummary": summarize_rows(rows) if rows else {"rowCount": 0},
        "environment": environment,
        "packageVersions": package_versions(),
        "runArguments": {
            "seed": args.seed,
            "epochs": args.epochs,
            "maxSteps": args.max_steps,
            "maxSequenceLength": args.max_seq_length,
            "trainBatchSize": args.train_batch_size,
            "evalBatchSize": args.eval_batch_size,
            "gradientAccumulationSteps": args.gradient_accumulation_steps,
            "maxGradientNorm": args.max_grad_norm,
            "effectiveBatchSize": args.train_batch_size * args.gradient_accumulation_steps,
            "learningRate": args.learning_rate,
            "warmupRatio": args.warmup_ratio,
            "scheduler": args.lr_scheduler_type,
            "loggingSteps": args.logging_steps,
            "evalSteps": args.eval_steps,
            "saveSteps": args.save_steps,
            "earlyStoppingPatience": args.early_stopping_patience,
            "selectionMetric": "eval_loss",
            "loraRank": args.lora_r,
            "loraAlpha": args.lora_alpha,
            "loraDropout": args.lora_dropout,
            "loraRankApprovalRef": args.lora_rank_approval_ref,
        },
        "repeatability": {
            "required": run_kind == "candidate",
            "secondSeedRunId": args.paired_run_id,
            "status": "pending" if run_kind == "candidate" else "not-applicable-to-non-candidate",
        },
        "privacy": {
            "rawPromptLogging": "forbidden",
            "rawCompletionLogging": "forbidden",
            "survivorDataUsed": False,
            "metadataOnly": True,
            "classification": "controlled-content-free",
            "containsExactRowIds": True,
        },
        "failure": None,
        "outputs": {},
    }

    if not args.dry_run:
        if data is None and train_data is None:
            raise RuntimeError("Actual fine-tuning requires approved data inputs.")
        write_metadata(run_dir, metadata)
        try:
            verify_installed_training_lock(training_lock)
            metadata["environment"]["dependencyConstraintsSatisfied"] = True
            metadata["outputs"] = run_training(
                args,
                run_dir,
                rows,
                run_kind,
                dataset_profile=dataset_profile,
                pilot_row_ids=pilot_row_ids,
            )
            metadata["status"] = "completed"
        except Exception as error:  # noqa: BLE001 - persist a sanitized fail-closed handoff.
            if metadata["environment"]["dependencyConstraintsSatisfied"] is None:
                metadata["environment"]["dependencyConstraintsSatisfied"] = False
            metadata["status"] = "blocked"
            metadata["failure"] = {
                "phase": "training",
                "errorType": type(error).__name__,
                "message": sanitized_error_message(error),
            }
            write_metadata(run_dir, metadata)
            raise RuntimeError(metadata["failure"]["message"]) from error

    write_metadata(run_dir, metadata)
    print("SafeRide Gemma 4 E2B fine-tuning runner complete.")
    print(f"Run metadata: {run_dir / 'metadata.json'}")
    if args.dry_run:
        print("Dry run only. No model weights or adapters were created.")
    elif args.tiny_smoke:
        print("Tiny smoke adapter created. This is pipeline evidence only, not a SafeRide model.")
    else:
        print("Prototype adapter created. Do not publish or mobile-export until eval/export gates pass.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CLI should report concise failure.
        print(sanitized_error_message(error), file=sys.stderr)
        raise SystemExit(1)
