#!/usr/bin/env python3
"""Fail-closed SageMaker entrypoint for SafeRide Gemma 4 E2B v0.5-series."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any


REPO_ROOT = Path("/opt/saferide")
HANDOFF_CHANNEL = Path(os.environ.get("SM_CHANNEL_HANDOFF", "/opt/ml/input/data/handoff"))
MODEL_CHANNEL = Path(os.environ.get("SM_CHANNEL_MODEL", "/opt/ml/input/data/model"))
HYPERPARAMETERS = Path("/opt/ml/input/config/hyperparameters.json")
WORK_ROOT = Path("/opt/ml/input/data/saferide-v05-extracted")
MODEL_OUTPUT = Path(os.environ.get("SM_MODEL_DIR", "/opt/ml/model"))
OUTPUT_DATA = Path(os.environ.get("SM_OUTPUT_DATA_DIR", "/opt/ml/output/data"))
CHECKPOINT_ROOT = Path("/opt/ml/checkpoints")
MODEL_ID = "google/gemma-4-E2B-it"
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
FORBIDDEN_PATH = re.compile(
    r"(?:^|/)(?:quality-holdout|safety-holdout|blind|reviews?|candidates?|approvals?|credentials?)(?:/|$)",
    re.IGNORECASE,
)
ALLOWED_HYPERPARAMETERS = {
    "run-kind", "run-id", "seed", "learning-rate", "epochs", "max-steps",
    "max-seq-length", "train-batch-size", "eval-batch-size",
    "gradient-accumulation-steps", "lora-r", "lora-alpha", "lora-dropout",
    "warmup-ratio", "lr-scheduler-type", "eval-steps", "save-steps",
    "early-stopping-patience", "paired-run-id",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def one_file(root: Path, name: str) -> Path:
    matches = [path for path in root.rglob(name) if path.is_file() and path.name == name]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one staged {name}; found {len(matches)}.")
    return matches[0]


def safe_extract(archive_path: Path, destination: Path, top_level: str) -> Path:
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != top_level or ".." in parts or PurePosixPath(member.name).is_absolute():
                raise RuntimeError("Training archive contains an unsafe or unexpected path.")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("Training archive contains a link or device entry.")
        archive.extractall(destination, filter="data")
    extracted = destination / top_level
    if not extracted.is_dir():
        raise RuntimeError("Training archive top-level directory is missing after extraction.")
    return extracted


def verify_dataset_package(extracted: Path, input_manifest: dict[str, Any]) -> dict[str, Any]:
    package_manifest_path = extracted / "metadata" / "sagemaker-package-manifest.json"
    if not package_manifest_path.is_file():
        raise RuntimeError("SageMaker dataset package manifest is missing.")
    if sha256_file(package_manifest_path) != input_manifest["trainingArchive"]["packageManifestSha256"]:
        raise RuntimeError("SageMaker dataset package-manifest hash differs.")
    package = json.loads(package_manifest_path.read_text(encoding="utf-8"))
    if (
        package.get("schema") != "com.saferide.ai.v05-sagemaker-dataset-package"
        or package.get("datasetId") not in {"saferide-synthetic-guidance-v0.5.0", "saferide-synthetic-guidance-v0.5.1", "saferide-synthetic-guidance-v0.5.2", "saferide-synthetic-guidance-v0.5.3"}
        or package.get("datasetId") != input_manifest.get("datasetId")
        or package.get("sourceCommit") != input_manifest.get("sourceCommit")
        or package.get("packageId") != input_manifest["trainingArchive"]["topLevelDirectory"]
    ):
        raise RuntimeError("SageMaker dataset package identity differs from the input manifest.")
    allowed = {item["path"] for item in package.get("files", [])} | {"metadata/sagemaker-package-manifest.json"}
    actual = {
        path.relative_to(extracted).as_posix()
        for path in extracted.rglob("*")
        if path.is_file()
    }
    if actual != allowed:
        raise RuntimeError("Extracted dataset package contains missing or additional files.")
    for item in package.get("files", []):
        relative = item.get("path", "")
        if FORBIDDEN_PATH.search(relative):
            raise RuntimeError("Extracted dataset package contains a prohibited training path.")
        target = extracted / relative
        if (
            not target.is_file()
            or target.stat().st_size != item.get("sizeBytes")
            or sha256_file(target) != item.get("sha256")
        ):
            raise RuntimeError(f"Extracted dataset package bytes differ: {relative}")
    return package


def verify_model_snapshot(input_manifest: dict[str, Any]) -> None:
    model = input_manifest.get("baseModel", {})
    if model.get("modelId") != MODEL_ID or model.get("revision") != MODEL_REVISION:
        raise RuntimeError("Staged base-model identity or revision differs.")
    expected_names = {item["path"] for item in model.get("files", [])}
    actual_files = [path for path in MODEL_CHANNEL.rglob("*") if path.is_file()]
    actual_by_name = {path.name: path for path in actual_files}
    if len(actual_by_name) != len(actual_files) or set(actual_by_name) != expected_names:
        raise RuntimeError("SageMaker model channel inventory differs from the immutable manifest.")
    for item in model["files"]:
        target = actual_by_name[item["path"]]
        if target.stat().st_size != item["sizeBytes"] or sha256_file(target) != item["sha256"]:
            raise RuntimeError(f"SageMaker model channel bytes differ: {item['path']}")


def read_hyperparameters() -> dict[str, str]:
    values = json.loads(HYPERPARAMETERS.read_text(encoding="utf-8"))
    unknown = set(values) - ALLOWED_HYPERPARAMETERS
    if unknown:
        raise RuntimeError(f"Unexpected SageMaker hyperparameters: {sorted(unknown)}")
    return {str(key): str(value) for key, value in values.items()}


def runner_command(hyperparameters: dict[str, str], extracted: Path) -> list[str]:
    required = ALLOWED_HYPERPARAMETERS - {"max-steps", "paired-run-id"}
    missing = sorted(required - set(hyperparameters))
    if missing:
        raise RuntimeError(f"SageMaker hyperparameters are incomplete: {missing}")
    run_kind = hyperparameters["run-kind"]
    if run_kind not in {"preflight", "pilot", "candidate"}:
        raise RuntimeError("SageMaker run kind is unsupported.")
    command = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "saferide-gemma4-finetune-runner.py"),
        "--register", str(extracted / "register.json"),
        "--train-data", str(extracted / "artifacts/dataset/controlled/train.jsonl"),
        "--dev-data", str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
        "--audit", str(extracted / "artifacts/audit/dataset-audit.json"),
        "--dataset-manifest", str(extracted / "artifacts/dataset/public-safe/dataset-manifest.json"),
        "--artifact-root", str(extracted / "artifacts"),
        "--base-model-id", MODEL_ID,
        "--base-model-path", str(MODEL_CHANNEL),
        "--base-revision", MODEL_REVISION,
        "--constraints", str(REPO_ROOT / "constraints-ai-training.txt"),
        "--output-root", str(MODEL_OUTPUT),
        "--checkpoint-root", str(CHECKPOINT_ROOT),
        "--run-kind", run_kind,
        "--run-id", hyperparameters["run-id"],
        "--seed", hyperparameters["seed"],
        "--learning-rate", hyperparameters["learning-rate"],
        "--epochs", hyperparameters["epochs"],
        "--max-seq-length", hyperparameters["max-seq-length"],
        "--train-batch-size", hyperparameters["train-batch-size"],
        "--eval-batch-size", hyperparameters["eval-batch-size"],
        "--gradient-accumulation-steps", hyperparameters["gradient-accumulation-steps"],
        "--lora-r", hyperparameters["lora-r"],
        "--lora-alpha", hyperparameters["lora-alpha"],
        "--lora-dropout", hyperparameters["lora-dropout"],
        "--warmup-ratio", hyperparameters["warmup-ratio"],
        "--lr-scheduler-type", hyperparameters["lr-scheduler-type"],
        "--eval-steps", hyperparameters["eval-steps"],
        "--save-steps", hyperparameters["save-steps"],
        "--early-stopping-patience", hyperparameters["early-stopping-patience"],
    ]
    if "max-steps" in hyperparameters:
        command.extend(["--max-steps", hyperparameters["max-steps"]])
    if "paired-run-id" in hyperparameters:
        command.extend(["--paired-run-id", hyperparameters["paired-run-id"]])
    if run_kind == "pilot":
        command.extend([
            "--pilot-row-manifest",
            str(extracted / "artifacts/dataset/controlled/pilot-row-manifest.json"),
        ])
    return command


def strict_training_gate(extracted: Path, dataset_id: str) -> None:
    if dataset_id == "saferide-synthetic-guidance-v0.5.3":
        command = [
            sys.executable,
            str(REPO_ROOT / "scripts" / "saferide-gemma4-v053-training.py"),
            "verify",
            "--register", str(extracted / "register.json"),
            "--train-data", str(extracted / "artifacts/dataset/controlled/train.jsonl"),
            "--dev-data", str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
            "--dataset-manifest", str(extracted / "artifacts/dataset/public-safe/dataset-manifest.json"),
            "--artifact-root", str(extracted / "artifacts"),
            "--pilot-row-manifest", str(extracted / "artifacts/dataset/controlled/pilot-row-manifest.json"),
            "--audit", str(extracted / "artifacts/audit/dataset-audit.json"),
        ]
    elif dataset_id == "saferide-synthetic-guidance-v0.5.2":
        command = [
            sys.executable,
            str(REPO_ROOT / "scripts" / "saferide-gemma4-v052-training.py"),
            "verify",
            "--register", str(extracted / "register.json"),
            "--train-data", str(extracted / "artifacts/dataset/controlled/train.jsonl"),
            "--dev-data", str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
            "--dataset-manifest", str(extracted / "artifacts/dataset/public-safe/dataset-manifest.json"),
            "--artifact-root", str(extracted / "artifacts"),
            "--pilot-row-manifest", str(extracted / "artifacts/dataset/controlled/pilot-row-manifest.json"),
            "--audit", str(extracted / "artifacts/audit/dataset-audit.json"),
        ]
    elif dataset_id == "saferide-synthetic-guidance-v0.5.1":
        command = [
            sys.executable,
            str(REPO_ROOT / "scripts" / "saferide-gemma4-v051-training.py"),
            "verify",
            "--register", str(extracted / "register.json"),
            "--train-data", str(extracted / "artifacts/dataset/controlled/train.jsonl"),
            "--dev-data", str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
            "--dataset-manifest", str(extracted / "artifacts/dataset/public-safe/dataset-manifest.json"),
            "--artifact-root", str(extracted / "artifacts"),
            "--pilot-row-manifest", str(extracted / "artifacts/dataset/controlled/pilot-row-manifest.json"),
        ]
    else:
        command = [
            "node",
            str(REPO_ROOT / "scripts" / "saferide-gemma4-v05-readiness.mjs"),
            "--register", str(extracted / "register.json"),
            "--training-strict",
            "--artifact-root", str(extracted / "artifacts"),
            "--train-data", str(extracted / "artifacts/dataset/controlled/train.jsonl"),
            "--dev-data", str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
        ]
    result = subprocess.run(command, cwd=REPO_ROOT, check=False)
    if result.returncode != 0:
        raise RuntimeError("Strict v0.5 training-input gate failed inside the SageMaker image.")


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "train":
        del sys.argv[1]
    OUTPUT_DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    execution = {
        "schema": "com.saferide.ai.v05-sagemaker-execution",
        "schemaVersion": 1,
        "status": "verifying-inputs",
        "trainingJobName": os.environ.get("TRAINING_JOB_NAME", "unavailable"),
        "inputManifestSha256": os.environ.get("SAFERIDE_SAGEMAKER_INPUT_MANIFEST_SHA256", "unavailable"),
        "imageDigest": os.environ.get("SAFERIDE_SAGEMAKER_IMAGE_DIGEST", "unavailable"),
        "launcherSourceCommit": os.environ.get("SAFERIDE_LAUNCHER_SOURCE_COMMIT", "unavailable"),
        "datasetSourceCommit": os.environ.get("SAFERIDE_DATASET_SOURCE_COMMIT", "unavailable"),
        "restrictedEvaluationBytesRead": False,
        "failure": None,
    }
    execution_path = OUTPUT_DATA / "saferide-sagemaker-execution.json"
    try:
        manifest_path = one_file(HANDOFF_CHANNEL, "input-manifest.json")
        actual_manifest_sha = sha256_file(manifest_path)
        if actual_manifest_sha != execution["inputManifestSha256"]:
            raise RuntimeError("SageMaker input-manifest hash differs from the launch plan.")
        input_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if input_manifest.get("sourceCommit") != execution["datasetSourceCommit"]:
            raise RuntimeError("SageMaker dataset source commit differs from the launch plan.")
        archive_record = input_manifest["trainingArchive"]
        archive_path = one_file(HANDOFF_CHANNEL, archive_record["fileName"])
        if archive_path.stat().st_size != archive_record["sizeBytes"] or sha256_file(archive_path) != archive_record["sha256"]:
            raise RuntimeError("SageMaker training archive differs from the immutable manifest.")
        extracted = safe_extract(archive_path, WORK_ROOT, archive_record["topLevelDirectory"])
        package = verify_dataset_package(extracted, input_manifest)
        verify_model_snapshot(input_manifest)
        strict_training_gate(extracted, input_manifest.get("datasetId", ""))
        hyperparameters = read_hyperparameters()
        execution.update({
            "status": "training",
            "runKind": hyperparameters["run-kind"],
            "runId": hyperparameters["run-id"],
            "datasetPackageManifestSha256": archive_record["packageManifestSha256"],
            "trainingArchiveSha256": archive_record["sha256"],
            "baseModelRevision": input_manifest["baseModel"]["revision"],
            "baseModelFileCount": input_manifest["baseModel"]["fileCount"],
            "baseModelTotalBytes": input_manifest["baseModel"]["totalBytes"],
            "datasetFileCount": len(package["files"]),
        })
        write_private_json(execution_path, execution)
        result = subprocess.run(runner_command(hyperparameters, extracted), cwd=REPO_ROOT, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"Fine-tuning runner exited with status {result.returncode}.")
        execution["status"] = "completed"
        write_private_json(execution_path, execution)
        print("SafeRide SageMaker training entrypoint completed.")
        return 0
    except Exception as error:  # noqa: BLE001 - persist a short content-free failure record.
        execution["status"] = "blocked"
        execution["failure"] = {
            "errorType": type(error).__name__,
            "message": re.sub(r"\s+", " ", str(error))[:500],
        }
        write_private_json(execution_path, execution)
        print(execution["failure"]["message"], file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
