#!/usr/bin/env python3
"""Fail-closed portable Docker launcher for the SafeRide v0.5.3 GPU pilot.

The validator performs no GPU or Docker calls. The launch command is reserved
for an explicitly authorized host on or after 2026-08-08 and exposes exactly
one idle GPU to the immutable, network-isolated training image.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable


sys.dont_write_bytecode = True
REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = REPO_ROOT / "config/ai/training/saferide-gemma4-v053-sagemaker-policy.json"
TRAINING_GATE_PATH = REPO_ROOT / "scripts/saferide-gemma4-v053-training.py"
EVIDENCE_SCHEMA_PATH = REPO_ROOT / "schemas/ai-v053-weekend-evidence.schema.json"
DATASET_ID = "saferide-synthetic-guidance-v0.5.3"
MODEL_ID = "google/gemma-4-E2B-it"
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
MINIMUM_FREE_VRAM_MIB = 22_000
MINIMUM_BASE_MODEL_BYTES = 1_000_000_000
CONTAINER_CPU_LIMIT = "16"
CONTAINER_MEMORY_LIMIT = "96g"
EARLIEST_AUTHORIZATION = dt.datetime(2026, 8, 8, tzinfo=dt.timezone.utc)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}$")
RUN_ID_PATTERN = re.compile(r"^saferide-v053-[a-z0-9](?:[a-z0-9-]{6,48}[a-z0-9])$")
IMAGE_URI_PATTERN = re.compile(
    r"^[0-9]{12}\.dkr\.ecr\.eu-central-1\.amazonaws\.com/[a-z0-9._/-]+:[A-Za-z0-9._-]+$"
)
AUTHORIZATION_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$")
EXPECTED_MODEL_FILES = (
    ".gitattributes",
    "README.md",
    "chat_template.jinja",
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
)
EXPECTED_PACKAGE_FILES = (
    "register.json",
    "artifacts/audit/dataset-audit.json",
    "artifacts/dataset/controlled/dev.jsonl",
    "artifacts/dataset/controlled/pilot-row-manifest.json",
    "artifacts/dataset/controlled/train.jsonl",
    "artifacts/dataset/public-safe/dataset-manifest.json",
    "artifacts/policy/system-prompt.json",
    "artifacts/policy/v053-mitigation-plan.json",
    "artifacts/semantic/semantic-report.json",
    "artifacts/tokenization/tokenization-report.json",
)
OCI_INDEX_MEDIA_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
OCI_MANIFEST_MEDIA_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
PROTECTED_PATH_PATTERN = re.compile(
    r"(?:^|/)(?:[^/]*holdout[^/]*|blind[^/]*|reviews?|candidates?|approvals?|credentials?|secrets?|private-keys?)(?:/|$)",
    re.IGNORECASE,
)
PLAN_KEYS = {
    "schema", "schemaVersion", "launchId", "createdAt", "launcherSourceCommit",
    "datasetSourceCommit", "datasetId", "status", "runKind", "runId", "region",
    "roleArn", "image", "inputManifest", "instance", "hyperparameters", "output",
    "security", "privacy",
}


class PortableLaunchError(RuntimeError):
    """Expected fail-closed validation failure."""


@dataclass(frozen=True)
class BundlePaths:
    plan: Path
    image_archive: Path
    handoff: Path
    model: Path
    runtime: Path
    model_output: Path
    output_data: Path
    checkpoints: Path

    @property
    def manifest(self) -> Path:
        return self.handoff / "input-manifest.json"

    @property
    def config(self) -> Path:
        return self.runtime / "config"

    @property
    def scratch(self) -> Path:
        return self.runtime / "scratch"

    @property
    def container_output(self) -> Path:
        return self.output_data / "container"

    @property
    def evidence(self) -> Path:
        return self.output_data / "portable-evidence"


@dataclass(frozen=True)
class ControlBinding:
    plan: dict[str, Any]
    manifest: dict[str, Any]
    policy: dict[str, Any]
    plan_sha256: str
    manifest_sha256: str
    image_archive_sha256: str
    docker_image_id: str
    mode: str
    run_id: str
    hyperparameters: dict[str, str]
    hyperparameters_bytes: bytes


@dataclass(frozen=True)
class ValidatedLaunch:
    control: ControlBinding
    paths: BundlePaths
    host_snapshot: dict[str, Any]
    command: list[str]
    command_sha256: str
    checkpoint_input_inventory_sha256: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PortableLaunchError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PortableLaunchError(f"{label} is unavailable or invalid JSON.") from error
    require(isinstance(value, dict), f"{label} must be a JSON object.")
    return value


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(canonical_json_bytes(value))
    path.chmod(0o600)


def resolved(path: str | Path) -> Path:
    candidate = Path(os.path.abspath(Path(path).expanduser()))
    component = candidate
    while True:
        try:
            metadata = component.lstat()
        except OSError as error:
            raise PortableLaunchError("Every supplied path and parent component must already exist.") from error
        require(not stat.S_ISLNK(metadata.st_mode), "Supplied paths and parent components must not be symbolic links.")
        if component.parent == component:
            break
        component = component.parent
    try:
        return candidate.resolve(strict=True)
    except OSError as error:
        raise PortableLaunchError("Supplied path resolution failed.") from error


def private_mode(path: Path, expected: int, label: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise PortableLaunchError(f"{label} is unavailable.") from error
    require(not stat.S_ISLNK(metadata.st_mode), f"{label} must not be a symbolic link.")
    expected_type = stat.S_ISDIR if expected == 0o700 else stat.S_ISREG
    require(expected_type(metadata.st_mode), f"{label} has an unsafe file type.")
    require(stat.S_IMODE(metadata.st_mode) == expected, f"{label} must use mode {expected:04o}.")
    if hasattr(os, "geteuid"):
        require(metadata.st_uid == os.geteuid(), f"{label} must be owned by the invoking user.")


def private_tree(root: Path, label: str) -> list[Path]:
    private_mode(root, 0o700, label)
    files: list[Path] = []
    for directory, names, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        private_mode(directory_path, 0o700, label)
        for name in names:
            private_mode(directory_path / name, 0o700, label)
        for name in filenames:
            target = directory_path / name
            private_mode(target, 0o600, label)
            files.append(target)
    return sorted(files)


def relative_inventory(root: Path, files: Iterable[Path]) -> list[str]:
    return sorted(path.relative_to(root).as_posix() for path in files)


def ensure_empty(root: Path, label: str) -> None:
    require(not any(root.iterdir()), f"{label} must be empty for a new immutable run.")


def safe_relative(value: str) -> bool:
    candidate = PurePosixPath(value)
    return bool(value) and not candidate.is_absolute() and ".." not in candidate.parts and "\\" not in value


def validate_path_separation(paths: BundlePaths) -> None:
    mount_roots = {
        "handoff": paths.handoff,
        "model": paths.model,
        "runtime": paths.runtime,
        "model output": paths.model_output,
        "output data": paths.output_data,
        "checkpoints": paths.checkpoints,
    }
    for label, path in mount_roots.items():
        require(path != Path(path.anchor), f"{label} cannot use a filesystem root.")
        require(
            path != REPO_ROOT
            and REPO_ROOT not in path.parents
            and path not in REPO_ROOT.parents,
            f"{label} cannot use the repository tree or a broader workspace ancestor.",
        )
        require("," not in str(path) and "\n" not in str(path) and "\r" not in str(path), f"{label} path is unsafe for Docker binding.")
    entries = list(mount_roots.items())
    for index, (left_label, left) in enumerate(entries):
        for right_label, right in entries[index + 1:]:
            overlap = left == right or left in right.parents or right in left.parents
            require(not overlap, f"{left_label} and {right_label} must use separate non-nested roots.")


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    require(set(value) == expected, f"{label} fields differ from the immutable contract.")


def validate_policy(policy: dict[str, Any]) -> None:
    require(policy.get("schema") == "com.saferide.ai.v05-sagemaker-policy", "v0.5.3 policy schema differs.")
    require(policy.get("backend") == "aws-sagemaker-training-job", "v0.5.3 policy backend differs.")
    require(policy.get("region") == "eu-central-1", "v0.5.3 policy region differs.")
    require(policy.get("instance") == {
        "type": "ml.g5.xlarge",
        "count": 1,
        "volumeSizeGb": 80,
        "quotaCode": "L-B6D80D9C",
    }, "v0.5.3 policy instance binding differs.")
    require(policy.get("storage") == {
        "serverSideEncryption": "AES256",
        "bucketVersioningRequired": True,
        "publicAccessBlockRequired": True,
        "checkpointSyncRequired": True,
    }, "v0.5.3 policy storage controls differ.")
    require(policy.get("container") == {
        "python": "3.12",
        "entrypoint": "scripts/saferide-gemma4-v05-sagemaker-entrypoint.py",
        "requirements": "requirements-ai-smoke.txt",
        "constraints": "constraints-ai-training.txt",
        "networkDownloadAllowed": False,
    }, "v0.5.3 container policy differs.")
    require(policy.get("security") == {
        "networkIsolation": True,
        "interContainerTrafficEncryption": True,
        "restrictedInputsForbidden": True,
        "rawContentLoggingForbidden": True,
    }, "v0.5.3 security policy differs.")
    training = policy.get("training", {})
    require(training.get("baseModelId") == MODEL_ID and training.get("baseRevision") == MODEL_REVISION, "v0.5.3 model policy differs.")
    require(training.get("pilot") == {"rows": 2088, "seed": 419805, "learningRates": [1e-5], "epochs": 1}, "v0.5.3 pilot policy differs.")
    fixed = training.get("fixed", {})
    require(
        fixed.get("maxSequenceLength") == 1024
        and fixed.get("trainBatchSize") == 1
        and fixed.get("evalBatchSize") == 1
        and fixed.get("gradientAccumulationSteps") == 8
        and fixed.get("loraRank") == 8
        and fixed.get("loraAlpha") == 16
        and fixed.get("loraDropout") == 0.05
        and fixed.get("warmupRatio") == 0.03
        and fixed.get("scheduler") == "cosine"
        and fixed.get("evalSteps") == 25
        and fixed.get("saveSteps") == 25
        and fixed.get("earlyStoppingPatience") == 3,
        "v0.5.3 fixed training policy differs.",
    )
    require(policy.get("privacy") == {
        "syntheticOnly": True,
        "holdoutsAvailableToTraining": False,
        "blindSuiteAvailableToTraining": False,
        "reviewerIdentityIncluded": False,
    }, "v0.5.3 privacy policy differs.")


def validate_plan(plan: dict[str, Any]) -> None:
    exact_keys(plan, PLAN_KEYS, "pilot plan")
    require(plan.get("schema") == "com.saferide.ai.v05-sagemaker-launch-plan" and plan.get("schemaVersion") == 1, "Pilot plan schema differs.")
    require(plan.get("datasetId") == DATASET_ID and plan.get("status") == "ready", "Pilot plan dataset or state differs.")
    require(plan.get("runKind") == "pilot", "Portable control plan must be the immutable v0.5.3 pilot plan; candidate and promotion plans are forbidden.")
    require(plan.get("region") == "eu-central-1", "Pilot plan region differs from the frozen policy.")
    require(re.fullmatch(r"saferide-v053-sagemaker-launch-[a-z0-9-]{8,55}", str(plan.get("launchId", ""))) is not None, "Pilot launch ID differs.")
    require(re.fullmatch(r"arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,128}", str(plan.get("roleArn", ""))) is not None, "Pilot role binding is invalid.")
    require(RUN_ID_PATTERN.fullmatch(str(plan.get("runId", ""))) is not None, "Pilot plan run ID differs.")
    require(COMMIT_PATTERN.fullmatch(str(plan.get("launcherSourceCommit", ""))) is not None, "Pilot plan launcher commit is not immutable.")
    require(COMMIT_PATTERN.fullmatch(str(plan.get("datasetSourceCommit", ""))) is not None, "Pilot plan dataset commit is not immutable.")
    image = plan.get("image", {})
    require(isinstance(image, dict), "Pilot image binding is invalid.")
    exact_keys(image, {"uri", "digest"}, "pilot image")
    require(IMAGE_URI_PATTERN.fullmatch(str(image.get("uri", ""))) is not None, "Pilot image URI differs from the pinned private-image contract.")
    require(SHA256_PATTERN.fullmatch(str(image.get("digest", ""))) is not None, "Pilot image digest is not an exact SHA-256.")
    input_manifest = plan.get("inputManifest", {})
    require(isinstance(input_manifest, dict), "Pilot input-manifest binding is invalid.")
    exact_keys(input_manifest, {"path", "sha256", "s3Uri", "versionId"}, "pilot input manifest")
    require(SHA256_PATTERN.fullmatch(str(input_manifest.get("sha256", ""))) is not None, "Pilot input-manifest binding is unavailable.")
    instance = plan.get("instance", {})
    require(isinstance(instance, dict), "Pilot instance binding is invalid.")
    exact_keys(instance, {"type", "count", "volumeSizeGb", "maxRuntimeSeconds"}, "pilot instance")
    require(instance == {
        "type": "ml.g5.xlarge",
        "count": 1,
        "volumeSizeGb": 80,
        "maxRuntimeSeconds": 14400,
    }, "Pilot instance binding differs from the frozen single-GPU contract.")
    hyperparameters = plan.get("hyperparameters", {})
    require(isinstance(hyperparameters, dict), "Pilot hyperparameters are invalid.")
    exact_keys(hyperparameters, {"seed", "learningRate", "epochs", "maxSteps", "pairedRunId"}, "pilot hyperparameters")
    require(hyperparameters == {
        "seed": 419805,
        "learningRate": 1e-5,
        "epochs": 1,
        "maxSteps": None,
        "pairedRunId": None,
    }, "Pilot plan differs from the frozen one-epoch recipe.")
    output = plan.get("output", {})
    require(isinstance(output, dict), "Pilot output binding is invalid.")
    exact_keys(output, {"s3Uri", "checkpointS3Uri"}, "pilot output")
    security = plan.get("security", {})
    require(isinstance(security, dict), "Pilot security binding is invalid.")
    exact_keys(security, {"networkIsolation", "interContainerTrafficEncryption", "trainingChannels"}, "pilot security")
    require(security.get("networkIsolation") is True, "Pilot plan network isolation is disabled.")
    require(security.get("interContainerTrafficEncryption") is True, "Pilot plan transport isolation is disabled.")
    require(security.get("trainingChannels") == ["handoff", "model"], "Pilot plan training channels differ.")
    privacy = plan.get("privacy", {})
    require(isinstance(privacy, dict), "Pilot privacy binding is invalid.")
    require(privacy == {
        "containsHoldouts": False,
        "containsBlindPrompts": False,
        "containsReviewerIdentity": False,
        "containsCredentials": False,
        "rawContentLogging": "forbidden",
    }, "Pilot plan privacy boundary differs.")


def validate_manifest(manifest: dict[str, Any], minimum_model_bytes: int) -> None:
    exact_keys(manifest, {
        "schema", "schemaVersion", "manifestId", "createdAt", "sourceCommit", "datasetId",
        "region", "trainingArchive", "baseModel", "storage", "exclusions", "privacy",
    }, "input manifest")
    require(manifest.get("schema") == "com.saferide.ai.v05-sagemaker-input-manifest" and manifest.get("schemaVersion") == 1, "Input-manifest schema differs.")
    require(manifest.get("datasetId") == DATASET_ID, "Only the frozen v0.5.3 dataset is supported.")
    require(manifest.get("region") == "eu-central-1", "Input-manifest region differs from the frozen policy.")
    require(COMMIT_PATTERN.fullmatch(str(manifest.get("sourceCommit", ""))) is not None, "Input-manifest source commit is not immutable.")
    archive = manifest.get("trainingArchive", {})
    require(isinstance(archive, dict), "Training archive binding is invalid.")
    exact_keys(archive, {
        "fileName", "sha256", "sizeBytes", "packageManifestSha256", "topLevelDirectory",
        "s3Uri", "versionId", "etag",
    }, "training archive")
    file_name = str(archive.get("fileName", ""))
    require(file_name == Path(file_name).name and safe_relative(file_name), "Training archive file name is unsafe.")
    require(SHA256_PATTERN.fullmatch(str(archive.get("sha256", ""))) is not None, "Training archive hash is unavailable.")
    require(SHA256_PATTERN.fullmatch(str(archive.get("packageManifestSha256", ""))) is not None, "Dataset package-manifest hash is unavailable.")
    require(type(archive.get("sizeBytes")) is int and archive["sizeBytes"] > 0, "Training archive size binding is unavailable.")
    require(re.fullmatch(r"saferide-v053-sagemaker-input-[a-f0-9]{12}", str(archive.get("topLevelDirectory", ""))) is not None, "Training archive top-level binding differs.")
    require(manifest.get("manifestId") == archive.get("topLevelDirectory"), "Input-manifest ID and archive root differ.")
    model = manifest.get("baseModel", {})
    require(isinstance(model, dict), "Base-model binding is invalid.")
    exact_keys(model, {"modelId", "revision", "totalBytes", "fileCount", "files", "s3Prefix"}, "base model")
    files = model.get("files", [])
    require(model.get("modelId") == MODEL_ID and model.get("revision") == MODEL_REVISION, "Base-model identity or revision differs.")
    require(model.get("fileCount") == 9 and isinstance(files, list) and len(files) == 9, "Base-model file count differs.")
    for item in files:
        require(isinstance(item, dict), "Base-model file record is invalid.")
        exact_keys(item, {"path", "sha256", "sizeBytes", "s3Uri", "versionId", "etag"}, "base-model file")
        require(type(item.get("sizeBytes")) is int and item["sizeBytes"] > 0, "Base-model file size binding is invalid.")
    require(tuple(item.get("path") for item in files) == EXPECTED_MODEL_FILES, "Base-model inventory or canonical order differs.")
    declared_total = sum(item["sizeBytes"] for item in files)
    require(type(model.get("totalBytes")) is int and declared_total == model["totalBytes"] and declared_total >= minimum_model_bytes, "Base-model total-byte binding differs.")
    require(all(SHA256_PATTERN.fullmatch(str(item.get("sha256", ""))) is not None for item in files), "Base-model file hash binding is incomplete.")
    storage = manifest.get("storage", {})
    require(isinstance(storage, dict), "Input storage binding is invalid.")
    exact_keys(storage, {"bucket", "prefix", "versioning", "serverSideEncryption", "publicAccessBlocked"}, "input storage")
    require(
        storage.get("versioning") == "Enabled"
        and storage.get("serverSideEncryption") == "AES256"
        and storage.get("publicAccessBlocked") is True,
        "Input storage controls differ.",
    )
    require(manifest.get("exclusions") == {
        "qualityHoldout": True,
        "safetyHoldout": True,
        "blindPrompts": True,
        "candidateContent": True,
        "reviewLedgers": True,
        "reviewerIdentities": True,
        "credentials": True,
    }, "Input-manifest protected-input exclusions differ.")
    require(manifest.get("privacy") == {
        "classification": "controlled-training-input",
        "containsSurvivorData": False,
        "containsCredentials": False,
        "containsRestrictedEvaluationBytes": False,
    }, "Input-manifest privacy declaration differs.")


def derived_run_id(pilot_run_id: str, mode: str) -> str:
    if mode == "pilot":
        return pilot_run_id
    require(mode == "preflight", "Only v0.5.3 preflight and pilot modes are supported.")
    require("-pilot-" in pilot_run_id, "Pilot run ID cannot derive the preflight identity.")
    value = pilot_run_id.replace("-pilot-", "-preflight-", 1)
    require(RUN_ID_PATTERN.fullmatch(value) is not None and len(value) <= 63, "Derived preflight run ID is invalid.")
    return value


def build_hyperparameters(plan: dict[str, Any], policy: dict[str, Any], mode: str) -> dict[str, str]:
    require(mode in {"preflight", "pilot"}, "Candidate training and promotion are not authorized.")
    fixed = policy["training"]["fixed"]
    values = {
        "run-kind": mode,
        "run-id": derived_run_id(plan["runId"], mode),
        "seed": "419805",
        "learning-rate": "0.00001",
        "epochs": "1",
        "max-seq-length": "1024",
        "train-batch-size": "1",
        "eval-batch-size": "1",
        "gradient-accumulation-steps": "8",
        "lora-r": "8",
        "lora-alpha": "16",
        "lora-dropout": "0.05",
        "warmup-ratio": "0.03",
        "lr-scheduler-type": "cosine",
        "eval-steps": str(1 if mode == "preflight" else fixed["evalSteps"]),
        "save-steps": str(1 if mode == "preflight" else fixed["saveSteps"]),
        "early-stopping-patience": "3",
    }
    if mode == "preflight":
        values["max-steps"] = "1"
    return values


def tar_member_bytes(archive: tarfile.TarFile, member: tarfile.TarInfo, label: str) -> bytes:
    source = archive.extractfile(member)
    require(source is not None, f"{label} cannot be read from the OCI archive.")
    with source:
        return source.read()


def tar_member_sha256(archive: tarfile.TarFile, member: tarfile.TarInfo, label: str) -> str:
    source = archive.extractfile(member)
    require(source is not None, f"{label} cannot be read from the OCI archive.")
    digest = hashlib.sha256()
    with source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def descriptor_digest(value: Any, label: str) -> tuple[str, int]:
    require(isinstance(value, dict), f"{label} descriptor is invalid.")
    digest = str(value.get("digest", ""))
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is not None, f"{label} digest is invalid.")
    size = value.get("size")
    require(type(size) is int and size >= 0, f"{label} size is invalid.")
    return digest.removeprefix("sha256:"), size


def verify_oci_image_archive(
    image_archive: Path,
    *,
    expected_archive_sha256: str,
    expected_manifest_digest: str,
    plan: dict[str, Any],
) -> str:
    require(SHA256_PATTERN.fullmatch(expected_archive_sha256) is not None, "Expected OCI image-archive SHA-256 is invalid.")
    private_mode(image_archive, 0o600, "OCI image archive")
    require(sha256_file(image_archive) == expected_archive_sha256, "OCI image-archive bytes differ from the immutable transfer ledger.")
    try:
        with tarfile.open(image_archive, "r:*") as archive:
            members: dict[str, tarfile.TarInfo] = {}
            for member in archive.getmembers():
                path = PurePosixPath(member.name)
                require(not path.is_absolute() and ".." not in path.parts, "OCI image archive contains path traversal.")
                require(PROTECTED_PATH_PATTERN.search(path.as_posix()) is None, "OCI image archive contains a protected-input path.")
                require(member.name not in members, "OCI image archive contains duplicate paths.")
                require(not (member.issym() or member.islnk() or member.isdev() or member.isfifo()), "OCI image archive contains a link or device entry.")
                members[member.name] = member
            require("index.json" in members and "oci-layout" in members, "OCI image archive layout metadata is missing.")
            index = json.loads(tar_member_bytes(archive, members["index.json"], "OCI index").decode("utf-8"))
            manifests = index.get("manifests", []) if isinstance(index, dict) else []
            require(isinstance(manifests, list) and len(manifests) == 1, "OCI image archive must contain exactly one governed root descriptor.")
            root_digest, _root_size = descriptor_digest(manifests[0], "OCI image root")
            require(root_digest == expected_manifest_digest, "OCI image archive contains a stale image digest.")
            layout = json.loads(tar_member_bytes(archive, members["oci-layout"], "OCI layout").decode("utf-8"))
            require(layout == {"imageLayoutVersion": "1.0.0"}, "OCI image layout version differs.")

            expected_blob_names: set[str] = set()
            verified_blob_sizes: dict[str, int] = {}

            def verify_descriptor_blob(descriptor: Any, label: str) -> tuple[str, tarfile.TarInfo]:
                digest, size = descriptor_digest(descriptor, label)
                member_name = f"blobs/sha256/{digest}"
                require(member_name in members and members[member_name].isfile(), f"{label} blob is missing.")
                require(members[member_name].size == size, f"{label} size differs.")
                previous_size = verified_blob_sizes.get(digest)
                require(previous_size is None or previous_size == size, f"{label} descriptor size conflicts with another reference.")
                if previous_size is None:
                    require(tar_member_sha256(archive, members[member_name], label) == digest, f"{label} hash differs.")
                    verified_blob_sizes[digest] = size
                    expected_blob_names.add(member_name)
                return digest, members[member_name]

            def descriptor_bytes(descriptor: Any, label: str) -> tuple[str, bytes]:
                digest, member = verify_descriptor_blob(descriptor, label)
                return digest, tar_member_bytes(archive, member, label)

            runtime_candidates: list[tuple[str, str, dict[str, Any]]] = []
            walked_documents: set[str] = set()
            walking_documents: set[str] = set()

            def walk_document(descriptor: Any, label: str, *, root: bool = False) -> None:
                digest, document_bytes = descriptor_bytes(descriptor, label)
                if digest in walked_documents:
                    return
                require(digest not in walking_documents, "OCI image descriptor graph contains a cycle.")
                walking_documents.add(digest)
                try:
                    document = json.loads(document_bytes.decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError) as error:
                    raise PortableLaunchError(f"{label} is not valid JSON.") from error
                require(isinstance(document, dict), f"{label} must be a JSON object.")
                media_type = str(descriptor.get("mediaType", "")) if isinstance(descriptor, dict) else ""
                if media_type in OCI_INDEX_MEDIA_TYPES or ("manifests" in document and "config" not in document):
                    children = document.get("manifests", [])
                    require(isinstance(children, list) and bool(children), f"{label} has no image descriptors.")
                    for index_value, child in enumerate(children):
                        walk_document(child, f"{label} descriptor {index_value}")
                else:
                    require(
                        media_type in OCI_MANIFEST_MEDIA_TYPES or ("config" in document and "layers" in document),
                        f"{label} media type is not an OCI/Docker image manifest or index.",
                    )
                    config_descriptor = document.get("config")
                    config_digest, config_bytes = descriptor_bytes(config_descriptor, f"{label} config")
                    layers = document.get("layers", [])
                    require(isinstance(layers, list) and bool(layers), f"{label} has no layers.")
                    for index_value, layer in enumerate(layers):
                        verify_descriptor_blob(layer, f"{label} layer {index_value}")
                    try:
                        config = json.loads(config_bytes.decode("utf-8"))
                    except (UnicodeError, json.JSONDecodeError) as error:
                        raise PortableLaunchError(f"{label} config is not valid JSON.") from error
                    require(isinstance(config, dict), f"{label} config is invalid.")
                    platform = descriptor.get("platform", {}) if isinstance(descriptor, dict) else {}
                    require(isinstance(platform, dict), f"{label} platform descriptor is invalid.")
                    platform_os = platform.get("os", config.get("os"))
                    platform_arch = platform.get("architecture", config.get("architecture"))
                    if root or (platform_os == "linux" and platform_arch == "amd64"):
                        require(config.get("os") in {None, "linux"}, "Governed OCI runtime config OS differs from linux.")
                        require(config.get("architecture") in {None, "amd64"}, "Governed OCI runtime config architecture differs from amd64.")
                        runtime_candidates.append((digest, config_digest, config))
                walking_documents.remove(digest)
                walked_documents.add(digest)

            walk_document(manifests[0], "OCI image root", root=str(manifests[0].get("mediaType", "")) not in OCI_INDEX_MEDIA_TYPES)
            require(len(runtime_candidates) == 1, "OCI image archive must resolve exactly one linux/amd64 runtime image.")
            _runtime_manifest_digest, config_digest, config = runtime_candidates[0]
            expected_files = {"index.json", "oci-layout", *expected_blob_names}
            actual_files = {name for name, member in members.items() if member.isfile()}
            require(actual_files == expected_files, "OCI image archive contains missing or additional files.")
    except (OSError, tarfile.TarError, UnicodeError, json.JSONDecodeError) as error:
        raise PortableLaunchError("OCI image archive is unavailable or invalid.") from error
    container_config = config.get("config", {}) if isinstance(config, dict) else {}
    require(isinstance(container_config, dict), "OCI image runtime config is invalid.")
    require(
        container_config.get("Entrypoint") == [
            "python",
            "/opt/saferide/scripts/saferide-gemma4-v05-sagemaker-entrypoint.py",
        ],
        "OCI image does not use the governed SafeRide training entrypoint.",
    )
    image_environment = container_config.get("Env") or []
    require(isinstance(image_environment, list) and all(isinstance(item, str) for item in image_environment), "OCI image environment is invalid.")
    require(
        all(
            re.search(r"(?i)(?:^|_)(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|HF_TOKEN|HUGGINGFACE_HUB_TOKEN|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)=", item) is None
            for item in image_environment
        ),
        "OCI image config contains a prohibited credential-bearing environment field.",
    )
    labels = container_config.get("Labels", {})
    require(isinstance(labels, dict), "OCI image labels are invalid.")
    require(
            labels.get("org.opencontainers.image.title") == "SafeRide Gemma 4 E2B v0.5-series SageMaker trainer"
            and labels.get("org.opencontainers.image.revision") == plan["launcherSourceCommit"]
        and labels.get("com.saferide.base-model-revision") == MODEL_REVISION
        and labels.get("com.saferide.issue") == "ESH-4198",
        "OCI image labels differ from the immutable launch plan.",
    )
    return config_digest


def load_control(
    paths: BundlePaths,
    *,
    plan_sha256: str,
    manifest_sha256: str,
    image_archive_sha256: str,
    mode: str,
    minimum_model_bytes: int = MINIMUM_BASE_MODEL_BYTES,
) -> ControlBinding:
    require(SHA256_PATTERN.fullmatch(plan_sha256) is not None, "Expected pilot-plan SHA-256 is invalid.")
    require(SHA256_PATTERN.fullmatch(manifest_sha256) is not None, "Expected input-manifest SHA-256 is invalid.")
    private_mode(paths.plan.parent, 0o700, "Pilot control directory")
    private_mode(paths.image_archive.parent, 0o700, "OCI image-archive directory")
    private_mode(paths.plan, 0o600, "Pilot plan")
    private_mode(paths.manifest, 0o600, "Input manifest")
    actual_plan_sha = sha256_file(paths.plan)
    actual_manifest_sha = sha256_file(paths.manifest)
    require(actual_plan_sha == plan_sha256, "Pilot plan bytes differ from the immutable SHA-256 binding.")
    require(actual_manifest_sha == manifest_sha256, "Input-manifest bytes differ from the immutable SHA-256 binding.")
    plan = read_json(paths.plan, "Pilot plan")
    manifest = read_json(paths.manifest, "Input manifest")
    policy = read_json(POLICY_PATH, "v0.5.3 policy")
    validate_policy(policy)
    validate_plan(plan)
    validate_manifest(manifest, minimum_model_bytes)
    docker_image_id = verify_oci_image_archive(
        paths.image_archive,
        expected_archive_sha256=image_archive_sha256,
        expected_manifest_digest=plan["image"]["digest"],
        plan=plan,
    )
    require(plan["inputManifest"]["sha256"] == actual_manifest_sha, "Pilot plan has a stale input-manifest hash.")
    require(plan["datasetSourceCommit"] == manifest["sourceCommit"], "Pilot plan and input-manifest source commits differ.")
    hyperparameters = build_hyperparameters(plan, policy, mode)
    hyperparameters_bytes = canonical_json_bytes(hyperparameters)
    return ControlBinding(
        plan=plan,
        manifest=manifest,
        policy=policy,
        plan_sha256=actual_plan_sha,
        manifest_sha256=actual_manifest_sha,
        image_archive_sha256=image_archive_sha256,
        docker_image_id=docker_image_id,
        mode=mode,
        run_id=hyperparameters["run-id"],
        hyperparameters=hyperparameters,
        hyperparameters_bytes=hyperparameters_bytes,
    )


def verify_handoff(paths: BundlePaths, control: ControlBinding) -> Path:
    files = private_tree(paths.handoff, "Handoff input tree")
    archive_name = control.manifest["trainingArchive"]["fileName"]
    require(set(relative_inventory(paths.handoff, files)) == {"input-manifest.json", archive_name}, "Handoff input inventory contains missing or additional files.")
    archive_path = paths.handoff / archive_name
    archive = control.manifest["trainingArchive"]
    require(archive_path.stat().st_size == archive["sizeBytes"], "Training archive size differs from the immutable manifest.")
    require(sha256_file(archive_path) == archive["sha256"], "Training archive hash differs from the immutable manifest.")
    return archive_path


def verify_model(paths: BundlePaths, control: ControlBinding) -> None:
    files = private_tree(paths.model, "Base-model input tree")
    require(tuple(relative_inventory(paths.model, files)) == tuple(sorted(EXPECTED_MODEL_FILES)), "Base-model input tree contains missing or additional files.")
    records = {item["path"]: item for item in control.manifest["baseModel"]["files"]}
    actual_total = 0
    for name in EXPECTED_MODEL_FILES:
        target = paths.model / name
        record = records[name]
        actual_total += target.stat().st_size
        require(target.stat().st_size == record["sizeBytes"], "Base-model file size differs from the immutable manifest.")
        require(sha256_file(target) == record["sha256"], "Base-model file hash differs from the immutable manifest.")
    require(actual_total == control.manifest["baseModel"]["totalBytes"], "Base-model total bytes differ from the immutable manifest.")


def archive_file_members(archive_path: Path, top_level: str) -> tuple[list[tarfile.TarInfo], set[str]]:
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
    except (OSError, tarfile.TarError) as error:
        raise PortableLaunchError("Training archive is unavailable or invalid.") from error
    require(bool(members), "Training archive is empty.")
    file_names: set[str] = set()
    seen_names: set[str] = set()
    for member in members:
        posix = PurePosixPath(member.name)
        parts = posix.parts
        require(parts and parts[0] == top_level and not posix.is_absolute() and ".." not in parts, "Training archive contains path traversal or an unexpected root.")
        require(member.name not in seen_names, "Training archive contains duplicate paths.")
        seen_names.add(member.name)
        require(not (member.issym() or member.islnk() or member.isdev() or member.isfifo()), "Training archive contains a link or device entry.")
        relative = PurePosixPath(*parts[1:]).as_posix()
        if relative == ".":
            require(member.isdir() and stat.S_IMODE(member.mode) == 0o700, "Training archive root permissions differ.")
            continue
        require(PROTECTED_PATH_PATTERN.search(relative) is None, "Training archive contains a protected-input path.")
        if member.isdir():
            require(stat.S_IMODE(member.mode) == 0o700, "Training archive directory permissions differ.")
        elif member.isfile():
            require(stat.S_IMODE(member.mode) == 0o600, "Training archive file permissions differ.")
            file_names.add(relative)
        else:
            raise PortableLaunchError("Training archive contains an unsupported entry type.")
    expected = set(EXPECTED_PACKAGE_FILES) | {"metadata/sagemaker-package-manifest.json"}
    require(file_names == expected, "Training archive inventory contains missing or additional files.")
    return members, file_names


def extract_verified_archive(archive_path: Path, destination: Path, top_level: str) -> Path:
    members, _ = archive_file_members(archive_path, top_level)
    extracted = destination / top_level
    extracted.mkdir(parents=True, mode=0o700)
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in members:
            parts = PurePosixPath(member.name).parts[1:]
            if not parts:
                continue
            target = extracted.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                target.chmod(0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            source = archive.extractfile(member)
            require(source is not None, "Training archive member cannot be read.")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=8 * 1024 * 1024)
            target.chmod(0o600)
    return extracted


def load_training_gate() -> Any:
    spec = importlib.util.spec_from_file_location("saferide_v053_portable_training_gate", TRAINING_GATE_PATH)
    require(spec is not None and spec.loader is not None, "v0.5.3 training gate cannot be loaded.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_dataset_archive(archive_path: Path, control: ControlBinding) -> None:
    top_level = control.manifest["trainingArchive"]["topLevelDirectory"]
    with tempfile.TemporaryDirectory(prefix="saferide-v053-portable-verify-") as temporary:
        temporary_root = Path(temporary)
        temporary_root.chmod(0o700)
        extracted = extract_verified_archive(archive_path, temporary_root, top_level)
        package_path = extracted / "metadata/sagemaker-package-manifest.json"
        require(sha256_file(package_path) == control.manifest["trainingArchive"]["packageManifestSha256"], "Dataset package-manifest hash differs.")
        package = read_json(package_path, "Dataset package manifest")
        exact_keys(package, {
            "schema", "schemaVersion", "packageId", "datasetId", "sourceCommit",
            "createdAt", "files", "exclusions", "privacy",
        }, "dataset package manifest")
        require(
            package.get("schema") == "com.saferide.ai.v05-sagemaker-dataset-package"
            and package.get("packageId") == top_level
            and package.get("datasetId") == DATASET_ID
            and package.get("sourceCommit") == control.manifest["sourceCommit"],
            "Dataset package identity differs.",
        )
        file_records = package.get("files", [])
        require(isinstance(file_records, list) and len(file_records) == len(EXPECTED_PACKAGE_FILES), "Dataset package file declarations differ.")
        for item in file_records:
            require(isinstance(item, dict), "Dataset package file record is invalid.")
            exact_keys(item, {"path", "sha256", "sizeBytes"}, "dataset package file")
            require(type(item.get("sizeBytes")) is int and item["sizeBytes"] > 0, "Dataset package file size binding is invalid.")
        declared = {str(item.get("path")): item for item in file_records}
        require(set(declared) == set(EXPECTED_PACKAGE_FILES), "Dataset package declaration contains missing or additional files.")
        for relative, record in declared.items():
            require(safe_relative(relative) and PROTECTED_PATH_PATTERN.search(relative) is None, "Dataset package declares an unsafe or protected path.")
            target = extracted / relative
            require(target.is_file() and target.stat().st_size == record.get("sizeBytes"), "Dataset package file size differs.")
            require(sha256_file(target) == record.get("sha256"), "Dataset package file hash differs.")
        require(package.get("exclusions") == {
            "qualityHoldout": True,
            "safetyHoldout": True,
            "blindPrompts": True,
            "mitigationDevelopment": True,
            "mitigationHoldout": True,
            "reviewLedgers": True,
            "reviewerIdentities": True,
            "credentials": True,
        }, "Dataset package protected-input exclusions differ.")
        require(package.get("privacy") == {
            "containsSurvivorData": False,
            "containsRestrictedEvaluationBytes": False,
            "containsCredentials": False,
        }, "Dataset package privacy declaration differs.")
        gate = load_training_gate()
        arguments = argparse.Namespace(
            register=str(extracted / "register.json"),
            train_data=str(extracted / "artifacts/dataset/controlled/train.jsonl"),
            dev_data=str(extracted / "artifacts/dataset/controlled/dev.jsonl"),
            dataset_manifest=str(extracted / "artifacts/dataset/public-safe/dataset-manifest.json"),
            artifact_root=str(extracted / "artifacts"),
            pilot_row_manifest=str(extracted / "artifacts/dataset/controlled/pilot-row-manifest.json"),
            audit=str(extracted / "artifacts/audit/dataset-audit.json"),
        )
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = gate.verify(arguments)
        except Exception as error:  # noqa: BLE001 - convert to a content-free gate error.
            raise PortableLaunchError("v0.5.3 dataset hashes, frozen sample order, or authorization boundary differ.") from error
        require(result == 0, "v0.5.3 dataset and frozen sample-order gate failed.")


def tree_inventory(root: Path, *, allow_empty: bool) -> tuple[str, int, int]:
    files = private_tree(root, "Writable output tree")
    require(allow_empty or bool(files), "Required recovery checkpoint inventory is empty.")
    records = []
    total = 0
    for path in files:
        size = path.stat().st_size
        total += size
        records.append({"path": path.relative_to(root).as_posix(), "sizeBytes": size, "sha256": sha256_file(path)})
    return sha256_bytes(canonical_json_bytes(records)), len(records), total


def validate_writable_roots(paths: BundlePaths, *, resume: bool, run_id: str) -> str:
    for root, label in (
        (paths.runtime, "Runtime root"),
        (paths.model_output, "Model-output root"),
        (paths.output_data, "Output-data root"),
        (paths.checkpoints, "Checkpoint root"),
    ):
        private_mode(root, 0o700, label)
    ensure_empty(paths.runtime, "Runtime root")
    ensure_empty(paths.model_output, "Model-output root")
    ensure_empty(paths.output_data, "Output-data root")
    if not resume:
        ensure_empty(paths.checkpoints, "Checkpoint root")
        return sha256_bytes(canonical_json_bytes([]))
    checkpoint_files = private_tree(paths.checkpoints, "Checkpoint recovery tree")
    require(bool(checkpoint_files), "Resume was requested without a private checkpoint inventory.")
    top_level = {path.relative_to(paths.checkpoints).parts[0] for path in checkpoint_files}
    require(top_level == {run_id}, "Checkpoint recovery tree does not bind the selected run ID.")
    require(
        any(
            re.fullmatch(r"checkpoint-[0-9]+", part)
            for path in checkpoint_files
            for part in path.relative_to(paths.checkpoints).parts
        ),
        "Checkpoint recovery tree lacks a Trainer checkpoint.",
    )
    return tree_inventory(paths.checkpoints, allow_empty=False)[0]


def docker_mount(source: Path, destination: str, *, readonly: bool) -> str:
    suffix = ",readonly" if readonly else ""
    return f"type=bind,src={source},dst={destination}{suffix}"


def local_image_reference(control: ControlBinding) -> str:
    return f"sha256:{control.docker_image_id}"


def build_docker_command(control: ControlBinding, paths: BundlePaths) -> list[str]:
    uid = os.getuid() if hasattr(os, "getuid") else 1000
    gid = os.getgid() if hasattr(os, "getgid") else 1000
    command = [
        "docker", "run", "--rm", "--pull", "never",
        "--name", control.run_id,
        "--hostname", "saferide-v053-offline",
        "--user", f"{uid}:{gid}",
        "--network", "none",
        "--gpus", "device=0",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "4096",
        "--cpus", CONTAINER_CPU_LIMIT,
        "--memory", CONTAINER_MEMORY_LIMIT,
        "--memory-swap", CONTAINER_MEMORY_LIMIT,
        "--shm-size", "8g",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=4g,mode=1777",
        "--mount", docker_mount(paths.handoff, "/opt/ml/input/data/handoff", readonly=True),
        "--mount", docker_mount(paths.model, "/opt/ml/input/data/model", readonly=True),
        "--mount", docker_mount(paths.config, "/opt/ml/input/config", readonly=True),
        "--mount", docker_mount(paths.scratch, "/opt/ml/input/data/saferide-v05-extracted", readonly=False),
        "--mount", docker_mount(paths.model_output, "/opt/ml/model", readonly=False),
        "--mount", docker_mount(paths.container_output, "/opt/ml/output/data", readonly=False),
        "--mount", docker_mount(paths.checkpoints, "/opt/ml/checkpoints", readonly=False),
        "--env", "HOME=/tmp/saferide",
        "--env", "HF_HUB_OFFLINE=1",
        "--env", "TRANSFORMERS_OFFLINE=1",
        "--env", "WANDB_DISABLED=true",
        "--env", "CUDA_VISIBLE_DEVICES=0",
        "--env", "NVIDIA_VISIBLE_DEVICES=0",
        "--env", "NVIDIA_DRIVER_CAPABILITIES=compute,utility",
        "--env", "SM_CHANNEL_HANDOFF=/opt/ml/input/data/handoff",
        "--env", "SM_CHANNEL_MODEL=/opt/ml/input/data/model",
        "--env", "SM_MODEL_DIR=/opt/ml/model",
        "--env", "SM_OUTPUT_DATA_DIR=/opt/ml/output/data",
        "--env", f"TRAINING_JOB_NAME={control.run_id}",
        "--env", "CURRENT_HOST=portable-gpu",
        "--env", f"SAFERIDE_SAGEMAKER_INPUT_MANIFEST_SHA256={control.manifest_sha256}",
        "--env", f"SAFERIDE_SAGEMAKER_IMAGE_DIGEST={control.plan['image']['digest']}",
        "--env", f"SAFERIDE_LAUNCHER_SOURCE_COMMIT={control.plan['launcherSourceCommit']}",
        "--env", f"SAFERIDE_DATASET_SOURCE_COMMIT={control.plan['datasetSourceCommit']}",
        "--entrypoint", "/bin/sh",
        local_image_reference(control),
        "-c", "umask 077; exec python /opt/saferide/scripts/saferide-gemma4-v05-sagemaker-entrypoint.py train",
    ]
    return command


def command_sha256(command: list[str]) -> str:
    return sha256_bytes(json.dumps(command, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))


def validate_host_snapshot(snapshot: dict[str, Any], control: ControlBinding) -> None:
    exact_keys(snapshot, {
        "schema", "schemaVersion", "evidenceId", "status", "capturedAt", "source",
        "host", "gpu", "security", "privacy", "limitations",
    }, "host/GPU snapshot")
    require(snapshot.get("schema") == "com.saferide.ai.v053-portable-host-gpu-snapshot" and snapshot.get("schemaVersion") == 1, "Host/GPU snapshot schema differs.")
    require(snapshot.get("status") == "captured", "Host/GPU snapshot is not a completed read-only capture.")
    parse_utc(str(snapshot.get("capturedAt", "")), "Host/GPU snapshot capture time")
    source = snapshot.get("source", {})
    require(isinstance(source, dict), "Host/GPU snapshot source binding is invalid.")
    exact_keys(source, {
        "planSha256", "inputManifestSha256", "imageDigest", "imageArchiveSha256",
        "dockerImageId", "launcherSourceCommit", "datasetSourceCommit", "baseModelRevision",
    }, "host/GPU snapshot source")
    require(source.get("planSha256") == control.plan_sha256 and source.get("inputManifestSha256") == control.manifest_sha256, "Host/GPU snapshot is stale for the immutable launch inputs.")
    require(source.get("imageDigest") == control.plan["image"]["digest"], "Host image digest is stale.")
    require(source.get("imageArchiveSha256") == control.image_archive_sha256, "Host image archive binding is stale.")
    require(source.get("dockerImageId") == control.docker_image_id, "Host Docker image ID is stale.")
    require(source.get("launcherSourceCommit") == control.plan["launcherSourceCommit"], "Host image launcher label is stale.")
    require(source.get("datasetSourceCommit") == control.plan["datasetSourceCommit"], "Host snapshot dataset binding is stale.")
    require(source.get("baseModelRevision") == MODEL_REVISION, "Host image base-model label is stale.")
    host = snapshot.get("host", {})
    require(isinstance(host, dict), "Host snapshot Docker binding is invalid.")
    exact_keys(host, {"dockerServerVersion", "imageAvailable", "imageLabelsMatch"}, "host snapshot Docker")
    require(re.fullmatch(r"[0-9][A-Za-z0-9.+_-]{0,63}", str(host.get("dockerServerVersion", ""))) is not None, "Host snapshot Docker version is unavailable or unsafe.")
    require(host.get("imageAvailable") is True and host.get("imageLabelsMatch") is True, "Exact pinned Docker image is unavailable or mislabeled.")
    gpu = snapshot.get("gpu", {})
    require(isinstance(gpu, dict), "Host snapshot GPU binding is invalid.")
    exact_keys(gpu, {
        "selectedDeviceCount", "selectedDeviceIndex", "uuidSha256", "totalVramMiB",
        "freeVramMiB", "minimumFreeVramMiB", "activeComputeProcessCount", "gatePassed",
    }, "host snapshot GPU")
    require(SHA256_PATTERN.fullmatch(str(gpu.get("uuidSha256", ""))) is not None, "GPU snapshot UUID binding is invalid.")
    require(gpu.get("selectedDeviceCount") == 1 and gpu.get("selectedDeviceIndex") == 0, "Portable launch must expose exactly GPU device 0.")
    require(gpu.get("minimumFreeVramMiB") == MINIMUM_FREE_VRAM_MIB, "GPU snapshot uses a stale free-VRAM threshold.")
    require(type(gpu.get("totalVramMiB")) is int and gpu["totalVramMiB"] >= MINIMUM_FREE_VRAM_MIB, "GPU total VRAM is insufficient.")
    require(type(gpu.get("freeVramMiB")) is int and gpu["freeVramMiB"] >= MINIMUM_FREE_VRAM_MIB, "GPU free VRAM is insufficient.")
    require(type(gpu.get("activeComputeProcessCount")) is int and gpu["activeComputeProcessCount"] == 0, "GPU is occupied by another compute workload; stop without terminating it.")
    require(gpu.get("gatePassed") is True, "Host/GPU availability gate did not pass.")
    security = snapshot.get("security", {})
    require(isinstance(security, dict), "Host snapshot security binding is invalid.")
    exact_keys(security, {"networkMode", "inputMountsReadOnly", "separateWritableOutputs", "hostPathsRecorded"}, "host snapshot security")
    require(security.get("networkMode") == "none" and security.get("inputMountsReadOnly") is True and security.get("separateWritableOutputs") is True and security.get("hostPathsRecorded") is False, "Host snapshot security declaration differs.")
    privacy = snapshot.get("privacy", {})
    require(isinstance(privacy, dict), "Host snapshot privacy binding is invalid.")
    exact_keys(privacy, {"containsHostPaths", "containsCredentials", "containsRawContent"}, "host snapshot privacy")
    require(privacy.get("containsHostPaths") is False and privacy.get("containsCredentials") is False and privacy.get("containsRawContent") is False, "Host snapshot contains prohibited evidence fields.")


def validate_bundle(
    control: ControlBinding,
    paths: BundlePaths,
    host_snapshot: dict[str, Any],
    *,
    resume: bool = False,
) -> ValidatedLaunch:
    validate_path_separation(paths)
    validate_host_snapshot(host_snapshot, control)
    require(not resume or control.mode == "pilot", "Only the v0.5.3 pilot may resume from a checkpoint.")
    archive_path = verify_handoff(paths, control)
    verify_model(paths, control)
    checkpoint_inventory = validate_writable_roots(paths, resume=resume, run_id=control.run_id)
    verify_dataset_archive(archive_path, control)
    command = build_docker_command(control, paths)
    return ValidatedLaunch(
        control=control,
        paths=paths,
        host_snapshot=host_snapshot,
        command=command,
        command_sha256=command_sha256(command),
        checkpoint_input_inventory_sha256=checkpoint_inventory,
    )


CommandRunner = Callable[..., subprocess.CompletedProcess[str]]


def checked_capture(arguments: list[str], runner: CommandRunner, label: str) -> str:
    try:
        result = runner(
            arguments,
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise PortableLaunchError(f"{label} could not be read.") from error
    require(result.returncode == 0, f"{label} read-only inspection failed.")
    return result.stdout.strip()


def read_gpu_availability(runner: CommandRunner = subprocess.run) -> tuple[int, str, int, int, int]:
    gpu_output = checked_capture([
        "nvidia-smi", "--id=0", "--query-gpu=index,uuid,memory.total,memory.free", "--format=csv,noheader,nounits",
    ], runner, "GPU inventory")
    gpu_rows = [row.strip() for row in gpu_output.splitlines() if row.strip()]
    require(len(gpu_rows) == 1, "GPU inventory must resolve exactly one selected device.")
    parts = [part.strip() for part in gpu_rows[0].split(",")]
    require(len(parts) == 4, "GPU inventory format differs.")
    try:
        gpu_index, gpu_uuid, total_vram, free_vram = int(parts[0]), parts[1], int(parts[2]), int(parts[3])
    except ValueError as error:
        raise PortableLaunchError("GPU inventory contains invalid numeric fields.") from error
    processes_output = checked_capture([
        "nvidia-smi", "--id=0", "--query-compute-apps=gpu_uuid", "--format=csv,noheader,nounits",
    ], runner, "GPU occupancy")
    process_rows = [row.strip() for row in processes_output.splitlines() if row.strip() and "no running" not in row.lower()]
    return gpu_index, gpu_uuid, total_vram, free_vram, len(process_rows)


def early_gpu_gate(runner: CommandRunner = subprocess.run) -> None:
    gpu_index, _gpu_uuid, total_vram, free_vram, active_processes = read_gpu_availability(runner)
    require(gpu_index == 0 and total_vram >= MINIMUM_FREE_VRAM_MIB, "Selected GPU total VRAM is insufficient.")
    require(active_processes == 0, "GPU is occupied by another compute workload; stop without terminating it.")
    require(free_vram >= MINIMUM_FREE_VRAM_MIB, "GPU free VRAM is insufficient.")


def collect_host_snapshot(
    control: ControlBinding,
    *,
    runner: CommandRunner = subprocess.run,
    captured_at: str | None = None,
) -> dict[str, Any]:
    exact_image = local_image_reference(control)
    inspect_output = checked_capture(["docker", "image", "inspect", exact_image], runner, "Pinned Docker image")
    try:
        inspected = json.loads(inspect_output)
        image = inspected[0]
        image_id = str(image.get("Id", "")).removeprefix("sha256:")
        labels = image.get("Config", {}).get("Labels") or {}
    except (IndexError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise PortableLaunchError("Pinned Docker image inspection returned invalid metadata.") from error
    docker_version = checked_capture(["docker", "version", "--format", "{{.Server.Version}}"], runner, "Docker server version")
    gpu_index, gpu_uuid, total_vram, free_vram, active_processes = read_gpu_availability(runner)
    labels_match = (
        labels.get("org.opencontainers.image.title") == "SafeRide Gemma 4 E2B v0.5-series SageMaker trainer"
        and labels.get("org.opencontainers.image.revision") == control.plan["launcherSourceCommit"]
        and labels.get("com.saferide.base-model-revision") == MODEL_REVISION
        and labels.get("com.saferide.issue") == "ESH-4198"
    )
    image_available = image_id == control.docker_image_id
    gate_passed = image_available and labels_match and gpu_index == 0 and free_vram >= MINIMUM_FREE_VRAM_MIB and active_processes == 0
    return {
        "schema": "com.saferide.ai.v053-portable-host-gpu-snapshot",
        "schemaVersion": 1,
        "evidenceId": f"{control.run_id}-host-gpu",
        "status": "captured",
        "capturedAt": captured_at or utc_now(),
        "source": {
            "planSha256": control.plan_sha256,
            "inputManifestSha256": control.manifest_sha256,
            "imageDigest": control.plan["image"]["digest"],
            "imageArchiveSha256": control.image_archive_sha256,
            "dockerImageId": control.docker_image_id,
            "launcherSourceCommit": control.plan["launcherSourceCommit"],
            "datasetSourceCommit": control.plan["datasetSourceCommit"],
            "baseModelRevision": MODEL_REVISION,
        },
        "host": {
            "dockerServerVersion": docker_version,
            "imageAvailable": image_available,
            "imageLabelsMatch": labels_match,
        },
        "gpu": {
            "selectedDeviceCount": 1,
            "selectedDeviceIndex": gpu_index,
            "uuidSha256": sha256_bytes(gpu_uuid.encode("utf-8")),
            "totalVramMiB": total_vram,
            "freeVramMiB": free_vram,
            "minimumFreeVramMiB": MINIMUM_FREE_VRAM_MIB,
            "activeComputeProcessCount": active_processes,
            "gatePassed": gate_passed,
        },
        "security": {
            "networkMode": "none",
            "inputMountsReadOnly": True,
            "separateWritableOutputs": True,
            "hostPathsRecorded": False,
        },
        "privacy": {
            "containsHostPaths": False,
            "containsCredentials": False,
            "containsRawContent": False,
        },
        "limitations": ["Read-only point-in-time host snapshot; launch rechecks occupancy immediately before Docker execution."],
    }


def utc_now() -> str:
    return format_utc(dt.datetime.now(dt.timezone.utc))


def format_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_utc(value: str, label: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PortableLaunchError(f"{label} must be an ISO-8601 UTC timestamp.") from error
    require(parsed.tzinfo is not None and parsed.utcoffset() == dt.timedelta(0), f"{label} must be UTC.")
    return parsed.astimezone(dt.timezone.utc)


def validate_launch_authorization(
    *,
    mode: str,
    authorization_kind: str,
    authorization_ref: str,
    authorized_at: str,
    now: dt.datetime | None = None,
) -> tuple[str, str]:
    require(authorization_kind == f"v053-{mode}", "Human authorization scope does not match the selected preflight or pilot.")
    require(AUTHORIZATION_REF_PATTERN.fullmatch(authorization_ref) is not None, "Human authorization reference must be content-free and contain no query string or whitespace.")
    require("://" not in authorization_ref, "Human authorization reference must not be a URL.")
    authorized = parse_utc(authorized_at, "Authorization time")
    current = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    require(authorized >= EARLIEST_AUTHORIZATION, "A11 access and GPU launch remain frozen before 2026-08-08 explicit authorization.")
    require(authorized <= current, "Human authorization time cannot be in the future.")
    return sha256_bytes(authorization_ref.encode("utf-8")), format_utc(authorized)


def prepare_runtime(validated: ValidatedLaunch) -> None:
    ensure_empty(validated.paths.runtime, "Runtime root")
    validated.paths.config.mkdir(mode=0o700)
    validated.paths.scratch.mkdir(mode=0o700)
    validated.paths.container_output.mkdir(mode=0o700)
    hyperparameters_path = validated.paths.config / "hyperparameters.json"
    hyperparameters_path.write_bytes(validated.control.hyperparameters_bytes)
    hyperparameters_path.chmod(0o600)
    require(sha256_file(hyperparameters_path) == sha256_bytes(validated.control.hyperparameters_bytes), "Generated hyperparameters changed before launch.")


def verify_completed_outputs(validated: ValidatedLaunch) -> tuple[str, str]:
    control = validated.control
    paths = validated.paths
    checkpoint_sha, checkpoint_count, _checkpoint_bytes = tree_inventory(paths.checkpoints, allow_empty=False)
    model_output_sha, model_file_count, _model_bytes = tree_inventory(paths.model_output, allow_empty=False)
    require(checkpoint_count > 0 and model_file_count > 0, "Completed run lacks checkpoint or model-output files.")
    checkpoint_files = private_tree(paths.checkpoints, "Completed checkpoint tree")
    require({path.name for path in paths.checkpoints.iterdir()} == {control.run_id}, "Completed checkpoint root contains an unexpected run.")
    checkpoint_top = {path.relative_to(paths.checkpoints).parts[0] for path in checkpoint_files}
    require(checkpoint_top == {control.run_id}, "Completed checkpoint tree does not bind the selected run ID.")
    require(
        any(
            re.fullmatch(r"checkpoint-[0-9]+", part)
            for path in checkpoint_files
            for part in path.relative_to(paths.checkpoints).parts
        ),
        "Completed run has no Trainer checkpoint.",
    )
    run_root = paths.model_output / control.run_id
    require({path.name for path in paths.model_output.iterdir()} == {control.run_id}, "Completed model-output root contains an unexpected run.")
    private_mode(run_root, 0o700, "Completed run output")
    metadata_path = run_root / "metadata.json"
    private_mode(metadata_path, 0o600, "Completed training metadata")
    metadata = read_json(metadata_path, "Completed training metadata")
    require(
        metadata.get("schema") == "com.saferide.ai.training-run"
        and metadata.get("status") == "completed"
        and metadata.get("datasetProfile") == "v053"
        and metadata.get("runKind") == control.mode
        and metadata.get("runId") == control.run_id
        and metadata.get("baseModelId") == MODEL_ID
        and metadata.get("baseRevision") == MODEL_REVISION
        and metadata.get("promotionEligible") is False,
        "Completed training metadata identity or state differs.",
    )
    outputs = metadata.get("outputs", {})
    require(isinstance(outputs, dict) and outputs.get("holdoutRowsRead") == 0, "Completed training metadata indicates protected-row access.")
    require(
        isinstance(outputs.get("bestMetric"), (int, float))
        and not isinstance(outputs.get("bestMetric"), bool)
        and math.isfinite(float(outputs["bestMetric"])),
        "Completed training metadata lacks a finite development loss.",
    )
    tensor_gate = outputs.get("adapterTensorValidation", {})
    require(
        isinstance(tensor_gate, dict)
        and type(tensor_gate.get("tensorCount")) is int
        and tensor_gate["tensorCount"] > 0
        and type(tensor_gate.get("elementCount")) is int
        and tensor_gate["elementCount"] > 0
        and tensor_gate.get("nonFiniteTensorCount") == 0,
        "Completed adapter finite-tensor gate differs.",
    )
    if control.mode == "pilot":
        require(
            outputs.get("rowsSeen") == 2088
            and isinstance(outputs.get("epochsCompleted"), (int, float))
            and float(outputs["epochsCompleted"]) >= 0.999,
            "Completed pilot coverage differs from the frozen one-epoch recipe.",
        )
    adapter = run_root / "adapter"
    private_mode(adapter, 0o700, "Completed adapter output")
    for name in ("adapter_config.json", "adapter_model.safetensors", "README.md"):
        private_mode(adapter / name, 0o600, "Completed adapter file")
    execution_path = paths.container_output / "saferide-sagemaker-execution.json"
    output_files = private_tree(paths.output_data, "Completed output-data tree")
    require(
        set(relative_inventory(paths.output_data, output_files)) == {
            "container/saferide-sagemaker-execution.json",
            "portable-evidence/host-gpu-snapshot.json",
            "portable-evidence/launch-receipt.json",
        },
        "Completed output-data inventory contains missing or additional files.",
    )
    private_mode(execution_path, 0o600, "Completed execution record")
    execution = read_json(execution_path, "Completed execution record")
    require(
        execution.get("schema") == "com.saferide.ai.v05-sagemaker-execution"
        and execution.get("status") == "completed"
        and execution.get("runKind") == control.mode
        and execution.get("runId") == control.run_id
        and execution.get("trainingJobName") == control.run_id
        and execution.get("inputManifestSha256") == control.manifest_sha256
        and execution.get("imageDigest") == control.plan["image"]["digest"]
        and execution.get("launcherSourceCommit") == control.plan["launcherSourceCommit"]
        and execution.get("datasetSourceCommit") == control.plan["datasetSourceCommit"]
        and execution.get("trainingArchiveSha256") == control.manifest["trainingArchive"]["sha256"]
        and execution.get("baseModelRevision") == MODEL_REVISION
        and execution.get("restrictedEvaluationBytesRead") is False,
        "Completed execution record identity or privacy state differs.",
    )
    return checkpoint_sha, model_output_sha


def git_head() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True, capture_output=True,
            timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and COMMIT_PATTERN.fullmatch(value) else None


def launch_receipt(
    validated: ValidatedLaunch,
    *,
    status: str,
    authorization_ref_sha256: str,
    authorized_at: str,
    host_snapshot_sha256: str,
    started_at: str,
    finished_at: str | None,
    exit_code: int | None,
    resume: bool,
    failure_code: str | None,
    checkpoint_inventory_sha256: str | None = None,
    model_output_inventory_sha256: str | None = None,
) -> dict[str, Any]:
    control = validated.control
    return {
        "schema": "com.saferide.ai.v053-portable-launch-receipt",
        "schemaVersion": 1,
        "evidenceId": f"{control.run_id}-launch",
        "status": status,
        "runKind": control.mode,
        "runId": control.run_id,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "bindings": {
            "planSha256": control.plan_sha256,
            "inputManifestSha256": control.manifest_sha256,
            "imageDigest": control.plan["image"]["digest"],
            "imageArchiveSha256": control.image_archive_sha256,
            "dockerImageId": control.docker_image_id,
            "hyperparametersSha256": sha256_bytes(control.hyperparameters_bytes),
            "commandSha256": validated.command_sha256,
            "hostSnapshotSha256": host_snapshot_sha256,
            "portableLauncherSourceCommit": git_head(),
            "portableLauncherSha256": sha256_file(Path(__file__).resolve()),
            "checkpointInputInventorySha256": validated.checkpoint_input_inventory_sha256,
            "checkpointOutputInventorySha256": checkpoint_inventory_sha256,
            "modelOutputInventorySha256": model_output_inventory_sha256,
        },
        "authorization": {
            "referenceSha256": authorization_ref_sha256,
            "authorizedAt": authorized_at,
            "candidateTrainingAuthorized": False,
            "promotionAuthorized": False,
            "sealedHoldoutAuthorized": False,
        },
        "recipe": {
            "seed": 419805,
            "learningRate": 1e-5,
            "epochs": 1,
            "maxSteps": 1 if control.mode == "preflight" else None,
            "weightedExamples": 2088,
            "uniqueRows": 1832,
            "trainBatchSize": 1,
            "maxSequenceLength": 1024,
        },
        "container": {
            "exitCode": exit_code,
            "networkMode": "none",
            "gpuCount": 1,
            "readOnlyRootFilesystem": True,
            "inputMountsReadOnly": True,
            "separateWritableOutputs": True,
            "resumeRequested": resume,
        },
        "failureCode": failure_code,
        "privacy": {
            "containsHostPaths": False,
            "containsCredentials": False,
            "containsRawPrompts": False,
            "containsRawResponses": False,
            "containsProtectedContent": False,
        },
        "limitations": ["This receipt authorizes neither full candidate training nor promotion."],
    }


def sanitize_log_text(value: str, sensitive_paths: Iterable[Path] = ()) -> str:
    text = value.replace("\r", " ")
    for path in sorted((str(path) for path in sensitive_paths), key=len, reverse=True):
        if path:
            text = text.replace(path, "[private-path]")
    if re.search(r"(?i)(?:\"(?:prompt|completion|response|messages|content)\"\s*:|(?:prompt|completion|response|messages)=)", text):
        return "[content-redacted]"
    text = re.sub(r"([?&](?:token|access_token|signature|sig)=)[^&\s]+", r"\1[redacted]", text, flags=re.I)
    text = re.sub(r"\b(?:sk-(?:proj-)?|hf_)[A-Za-z0-9_-]{16,}\b", "[redacted]", text)
    text = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[redacted]", text)
    text = re.sub(r"(?i)\b(?:HF_TOKEN|HUGGINGFACE_HUB_TOKEN|AWS_SECRET_ACCESS_KEY)=\S+", "[redacted]", text)
    text = re.sub(r"(?<![A-Za-z0-9])/(?:opt|home|root|tmp|mnt|srv|var|run)/[^\s,'\"]+", "[private-path]", text)
    text = re.sub(r"\b[A-Za-z]:\\[^\s,'\"]+", "[private-path]", text)
    return re.sub(r"\s+", " ", text).strip()[:1000]


def content_safe_container_line(value: str, sensitive_paths: Iterable[Path] = ()) -> str | None:
    sanitized = sanitize_log_text(value, sensitive_paths)
    if not sanitized:
        return None
    if sanitized == "[content-redacted]":
        return sanitized
    safe_prefixes = (
        "SafeRide ",
        "Unique train:",
        "Training precision selected:",
        "LoRA target modules selected:",
        "LoRA target module preview:",
        "LoRA trainable parameters:",
        "LoRA trainable parameter preview:",
        "LoRA sanity loss requires grad:",
        "Run metadata:",
        "Dry run only.",
        "Tiny smoke adapter created.",
        "Prototype adapter created.",
    )
    if sanitized.startswith(safe_prefixes):
        return sanitized
    if sanitized.startswith("{") and sanitized.endswith("}"):
        try:
            metrics = ast.literal_eval(sanitized)
        except (SyntaxError, ValueError):
            return None
        allowed_keys = {
            "loss", "grad_norm", "learning_rate", "epoch", "eval_loss", "eval_runtime",
            "eval_samples_per_second", "eval_steps_per_second", "train_runtime",
            "train_samples_per_second", "train_steps_per_second", "total_flos", "train_loss",
        }
        if (
            isinstance(metrics, dict)
            and set(metrics).issubset(allowed_keys)
            and all(isinstance(value, (int, float, bool)) or value is None for value in metrics.values())
        ):
            return sanitized
    return None


def execute_docker(command: list[str], sensitive_paths: Iterable[Path]) -> int:
    try:
        process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell, immutable image digest.
            command,
            cwd=REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            errors="replace",
        )
    except OSError as error:
        raise PortableLaunchError("Docker launch could not start.") from error
    assert process.stdout is not None
    suppressed_notice_written = False
    for line in process.stdout:
        sanitized = content_safe_container_line(line, sensitive_paths)
        if sanitized:
            print(sanitized, flush=True)
        elif not suppressed_notice_written:
            print("[non-content-log-suppressed]", flush=True)
            suppressed_notice_written = True
    return_code = process.wait()
    return return_code if return_code >= 0 else 128 + abs(return_code)


def paths_from_args(args: argparse.Namespace) -> BundlePaths:
    return BundlePaths(
        plan=resolved(args.plan),
        image_archive=resolved(args.image_archive),
        handoff=resolved(args.handoff_dir),
        model=resolved(args.model_dir),
        runtime=resolved(args.runtime_root),
        model_output=resolved(args.model_output_dir),
        output_data=resolved(args.output_data_dir),
        checkpoints=resolved(args.checkpoint_dir),
    )


def common_control(args: argparse.Namespace, paths: BundlePaths) -> ControlBinding:
    return load_control(
        paths,
        plan_sha256=args.plan_sha256,
        manifest_sha256=args.manifest_sha256,
        image_archive_sha256=args.image_archive_sha256,
        mode=args.mode,
    )


def run_validate(args: argparse.Namespace) -> int:
    paths = paths_from_args(args)
    control = common_control(args, paths)
    snapshot_path = resolved(args.host_snapshot)
    private_mode(snapshot_path.parent, 0o700, "Host/GPU snapshot fixture directory")
    private_mode(snapshot_path, 0o600, "Host/GPU snapshot fixture")
    snapshot = read_json(snapshot_path, "Host/GPU snapshot fixture")
    validated = validate_bundle(control, paths, snapshot, resume=args.resume)
    print(
        "SafeRide v0.5.3 portable dry-run PASS "
        f"(runKind={control.mode}; plan={control.plan_sha256}; manifest={control.manifest_sha256}; "
        f"command={validated.command_sha256}; protected inputs absent)."
    )
    return 0


def run_launch(args: argparse.Namespace) -> int:
    authorization_ref_sha, authorization_time = validate_launch_authorization(
        mode=args.mode,
        authorization_kind=args.authorization_kind,
        authorization_ref=args.authorization_ref,
        authorized_at=args.authorized_at,
    )
    early_gpu_gate()
    paths = paths_from_args(args)
    control = common_control(args, paths)
    first_snapshot = collect_host_snapshot(control)
    validated = validate_bundle(control, paths, first_snapshot, resume=args.resume)
    prepare_runtime(validated)
    final_snapshot = collect_host_snapshot(control)
    validate_host_snapshot(final_snapshot, control)
    evidence_root = paths.evidence
    evidence_root.mkdir(mode=0o700)
    snapshot_path = evidence_root / "host-gpu-snapshot.json"
    write_private_json(snapshot_path, final_snapshot)
    snapshot_sha = sha256_file(snapshot_path)
    receipt_path = evidence_root / "launch-receipt.json"
    started_at = utc_now()
    write_private_json(receipt_path, launch_receipt(
        validated,
        status="running",
        authorization_ref_sha256=authorization_ref_sha,
        authorized_at=authorization_time,
        host_snapshot_sha256=snapshot_sha,
        started_at=started_at,
        finished_at=None,
        exit_code=None,
        resume=args.resume,
        failure_code=None,
    ))
    sensitive_paths = (
        paths.plan, paths.image_archive, paths.handoff, paths.model, paths.runtime,
        paths.model_output, paths.output_data, paths.checkpoints,
    )
    exit_code: int | None = None
    failure_code: str | None = None
    checkpoint_sha: str | None = None
    model_output_sha: str | None = None
    try:
        early_gpu_gate()
        exit_code = execute_docker(validated.command, sensitive_paths)
        if exit_code != 0:
            failure_code = "container-exit-nonzero"
        else:
            checkpoint_sha, model_output_sha = verify_completed_outputs(validated)
    except Exception:  # noqa: BLE001 - persist a content-free blocked receipt at the launch boundary.
        failure_code = "docker-or-output-verification-failed"
    completed = exit_code == 0 and failure_code is None
    write_private_json(receipt_path, launch_receipt(
        validated,
        status="completed" if completed else "blocked",
        authorization_ref_sha256=authorization_ref_sha,
        authorized_at=authorization_time,
        host_snapshot_sha256=snapshot_sha,
        started_at=started_at,
        finished_at=utc_now(),
        exit_code=exit_code,
        resume=args.resume,
        failure_code=failure_code,
        checkpoint_inventory_sha256=checkpoint_sha,
        model_output_inventory_sha256=model_output_sha,
    ))
    require(completed, "Portable v0.5.3 run failed or produced incomplete outputs; see the content-free launch receipt.")
    print(f"SafeRide v0.5.3 {control.mode} completed (receiptSha256={sha256_file(receipt_path)}; promotion=false).")
    return 0


def contract_check() -> int:
    validate_policy(read_json(POLICY_PATH, "v0.5.3 policy"))
    require(TRAINING_GATE_PATH.is_file(), "v0.5.3 training gate is unavailable.")
    require(EVIDENCE_SCHEMA_PATH.is_file(), "Weekend evidence schema is unavailable.")
    require(MINIMUM_FREE_VRAM_MIB == 22_000, "Portable GPU threshold differs.")
    require(MINIMUM_BASE_MODEL_BYTES == 1_000_000_000, "Portable base-model floor differs.")
    require(CONTAINER_CPU_LIMIT == "16" and CONTAINER_MEMORY_LIMIT == "96g", "Portable CPU/RAM boundary differs.")
    synthetic_secret = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz"
    sample = sanitize_log_text(
        f'token=unsafe {synthetic_secret} "prompt":"private" /srv/private/input',
        [Path("/srv/private")],
    )
    require("unsafe" not in sample and "private" not in sample and "prompt" not in sample, "Content-safe log sanitizer differs.")
    print("SafeRide v0.5.3 portable launcher contract passed (no Docker or GPU accessed).")
    return 0


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--mode", required=True, choices=["preflight", "pilot"])
    parser.add_argument("--plan", required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--image-archive", required=True)
    parser.add_argument("--image-archive-sha256", required=True)
    parser.add_argument("--handoff-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--model-output-dir", required=True)
    parser.add_argument("--output-data-dir", required=True)
    parser.add_argument("--checkpoint-dir", required=True)
    parser.add_argument("--resume", action="store_true")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    validate_parser = subparsers.add_parser("validate", help="No-GPU validation using a content-free host snapshot fixture.")
    add_common_arguments(validate_parser)
    validate_parser.add_argument("--host-snapshot", required=True)
    launch_parser = subparsers.add_parser("launch", help="Authorized Saturday Docker launch with live read-only host checks.")
    add_common_arguments(launch_parser)
    launch_parser.add_argument("--authorization-kind", required=True, choices=["v053-preflight", "v053-pilot"])
    launch_parser.add_argument("--authorization-ref", required=True)
    launch_parser.add_argument("--authorized-at", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    args = parse_args(argv)
    if args.command == "contract-check":
        return contract_check()
    if args.command == "validate":
        return run_validate(args)
    return run_launch(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PortableLaunchError as error:
        print(f"SafeRide v0.5.3 portable launch blocked: {sanitize_log_text(str(error))}", file=sys.stderr)
        raise SystemExit(1)
    except Exception:  # noqa: BLE001 - never expose unexpected data at the CLI boundary.
        print("SafeRide v0.5.3 portable launch blocked by an unexpected content-suppressed error.", file=sys.stderr)
        raise SystemExit(1)
