#!/usr/bin/env python3
"""Package and stage immutable SafeRide v0.5.1 SageMaker training inputs."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BASE_STAGER_PATH = REPO_ROOT / "scripts/saferide-gemma4-v05-sagemaker-stage.py"
GOVERNANCE_PATH = REPO_ROOT / "config/ai/datasets/saferide-gemma4-v051-experimental-governance-amendment.json"
DATASET_ID = "saferide-synthetic-guidance-v0.5.1"
MODEL_ID = "google/gemma-4-E2B-it"
MODEL_REVISION = "70af34e20bd4b7a91f0de6b22675850c43922a03"
REGION = "eu-central-1"
COMMIT_PATTERN = re.compile(r"^[a-f0-9]{40}$")
PACKAGE_FILES = {
    "register.json": "register.private.json",
    "artifacts/audit/dataset-audit.json": "frozen-manifest.private.json",
    "artifacts/dataset/controlled/train.jsonl": "combined-train.private.jsonl",
    "artifacts/dataset/controlled/pilot-row-manifest.json": "pilot-row-manifest.private.json",
    "artifacts/dataset/public-safe/dataset-manifest.json": "frozen-manifest.private.json",
    "artifacts/governance/governance-state.json": "governance-state.private.json",
    "artifacts/policy/system-prompt.json": "system-prompt.experimental.private.json",
    "artifacts/semantic/semantic-report.json": "semantic-report.private.json",
    "artifacts/splits/split-manifest.json": "split-manifest.private.json",
    "artifacts/tokenization/tokenization-report.json": "tokenization-report.private.json",
}
SOURCE_DEV_RELATIVE = "artifacts/dataset/controlled/dev.jsonl"


def load_base_stager() -> Any:
    spec = importlib.util.spec_from_file_location("saferide_v051_base_stager", BASE_STAGER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Canonical SageMaker stager cannot be loaded.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load_base_stager()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def copy_private(source: Path, target: Path) -> None:
    require(source.is_file(), f"Required controlled source is missing: {source.name}")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with source.open("rb") as input_handle, target.open("xb") as output_handle:
        shutil.copyfileobj(input_handle, output_handle, length=8 * 1024 * 1024)
    target.chmod(0o600)


def verify_frozen(frozen_dir: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts/saferide-gemma4-v051-dataset.py"), "verify-frozen", "--frozen-dir", str(frozen_dir)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Frozen v0.5.1 package verification failed before staging.")


def package_dataset(frozen_dir: Path, source_v05_package: Path, output_dir: Path, source_commit: str, created_at: str) -> dict[str, Any]:
    require(COMMIT_PATTERN.fullmatch(source_commit) is not None, "v0.5.1 staging requires an immutable source commit.")
    require("T" in created_at and created_at.endswith("Z"), "v0.5.1 staging requires a UTC creation timestamp.")
    verify_frozen(frozen_dir)
    source_dev = source_v05_package / SOURCE_DEV_RELATIVE
    require(source_dev.is_file(), "Immutable v0.5 development comparator is missing.")
    frozen_manifest = json.loads((frozen_dir / "frozen-manifest.private.json").read_text(encoding="utf-8"))
    require(BASE.sha256_file(source_dev) == frozen_manifest.get("bindings", {}).get("sourceDevelopmentSha256"), "v0.5 development comparator hash differs from the frozen v0.5.1 lineage.")
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    package_id = f"saferide-v051-sagemaker-input-{BASE.sha256_file(frozen_dir / 'frozen-manifest.private.json')[:12]}"
    with tempfile.TemporaryDirectory(prefix="saferide-v051-package-", dir=output_dir) as temporary:
        root = Path(temporary) / "root"
        root.mkdir(mode=0o700)
        for destination, source_name in PACKAGE_FILES.items():
            copy_private(frozen_dir / source_name, root / destination)
        copy_private(source_dev, root / SOURCE_DEV_RELATIVE)
        copy_private(GOVERNANCE_PATH, root / "artifacts/policy/governance-amendment.json")
        file_paths = sorted(path for path in root.rglob("*") if path.is_file())
        files = [
            {"path": path.relative_to(root).as_posix(), "sha256": BASE.sha256_file(path), "sizeBytes": path.stat().st_size}
            for path in file_paths
        ]
        package_manifest = {
            "schema": "com.saferide.ai.v05-sagemaker-dataset-package",
            "schemaVersion": 1,
            "packageId": package_id,
            "datasetId": DATASET_ID,
            "sourceCommit": source_commit,
            "createdAt": created_at,
            "files": files,
            "exclusions": {
                "qualityHoldout": True,
                "safetyHoldout": True,
                "blindPrompts": True,
                "mitigationDevelopment": True,
                "mitigationHoldout": True,
                "reviewLedgers": True,
                "reviewerIdentities": True,
                "credentials": True,
            },
            "privacy": {"containsSurvivorData": False, "containsRestrictedEvaluationBytes": False, "containsCredentials": False},
        }
        package_manifest_path = root / "metadata/sagemaker-package-manifest.json"
        BASE.write_private_json(package_manifest_path, package_manifest)
        public_manifest_path = output_dir / f"{package_id}.package-manifest.json"
        BASE.write_private_json(public_manifest_path, package_manifest)
        archive_path = output_dir / f"{package_id}.tar.gz"
        BASE.create_deterministic_archive(root, package_id, archive_path)
    return {
        "packageId": package_id,
        "sourceCommit": source_commit,
        "createdAt": created_at,
        "archivePath": str(archive_path),
        "archiveSha256": BASE.sha256_file(archive_path),
        "archiveSizeBytes": archive_path.stat().st_size,
        "packageManifestPath": str(public_manifest_path),
        "packageManifestSha256": BASE.sha256_file(public_manifest_path),
        "topLevelDirectory": package_id,
    }


def parse_s3_uri(uri: str) -> tuple[str, str]:
    require(uri.startswith("s3://") and "/" in uri[5:], "Base-model S3 URI is invalid.")
    bucket, key = uri[5:].split("/", 1)
    return bucket, key


def verify_reused_model(profile: str, bucket: str, source_manifest: dict[str, Any]) -> dict[str, Any]:
    model = source_manifest.get("baseModel", {})
    require(model.get("modelId") == MODEL_ID and model.get("revision") == MODEL_REVISION and model.get("fileCount") == 9, "Source base-model manifest differs.")
    for item in model.get("files", []):
        object_bucket, key = parse_s3_uri(str(item.get("s3Uri")))
        require(object_bucket == bucket, "Reused base-model object is outside the controlled bucket.")
        head = BASE.head_object(profile, object_bucket, key, str(item.get("versionId")))
        require(head is not None, f"Reused base-model object is missing: {item.get('path')}")
        require(int(head.get("ContentLength", -1)) == item.get("sizeBytes") and head.get("Metadata", {}).get("sha256") == item.get("sha256") and head.get("VersionId") == item.get("versionId") and head.get("ServerSideEncryption") == "AES256", f"Reused base-model object differs: {item.get('path')}")
    return model


def stage(args: argparse.Namespace) -> dict[str, Any]:
    frozen_dir = Path(args.frozen_dir).expanduser().resolve()
    source_package = Path(args.source_v05_package).expanduser().resolve()
    source_manifest_path = Path(args.source_input_manifest).expanduser().resolve()
    work_dir = Path(args.work_dir).expanduser().resolve()
    require(not work_dir.exists(), "v0.5.1 staging work directory already exists.")
    work_dir.mkdir(parents=True, mode=0o700)
    BASE.verify_bucket_controls(args.profile, args.bucket)
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    model = verify_reused_model(args.profile, args.bucket, source_manifest)
    package = package_dataset(frozen_dir, source_package, work_dir / "dataset", args.source_commit, args.created_at)
    prefix = f"saferide/v051/sagemaker/inputs/{package['packageId']}/"
    archive_path = Path(package["archivePath"])
    archive_key = f"{prefix}handoff/{archive_path.name}"
    archive_head = BASE.upload_file(args.profile, args.bucket, archive_key, archive_path, package["archiveSha256"], args.source_commit)
    archive_record = BASE.staged_object(
        archive_path,
        package["archiveSha256"],
        f"s3://{args.bucket}/{archive_key}",
        archive_head,
        fileName=archive_path.name,
        packageManifestSha256=package["packageManifestSha256"],
        topLevelDirectory=package["topLevelDirectory"],
    )
    manifest = {
        "schema": "com.saferide.ai.v05-sagemaker-input-manifest",
        "schemaVersion": 1,
        "manifestId": package["packageId"],
        "createdAt": args.created_at,
        "sourceCommit": args.source_commit,
        "datasetId": DATASET_ID,
        "region": REGION,
        "trainingArchive": archive_record,
        "baseModel": model,
        "storage": {"bucket": args.bucket, "prefix": prefix, "versioning": "Enabled", "serverSideEncryption": "AES256", "publicAccessBlocked": True},
        "exclusions": {"qualityHoldout": True, "safetyHoldout": True, "blindPrompts": True, "candidateContent": True, "reviewLedgers": True, "reviewerIdentities": True, "credentials": True},
        "privacy": {"classification": "controlled-training-input", "containsSurvivorData": False, "containsCredentials": False, "containsRestrictedEvaluationBytes": False},
    }
    manifest_path = work_dir / "input-manifest.json"
    BASE.write_private_json(manifest_path, manifest)
    manifest_sha = BASE.sha256_file(manifest_path)
    manifest_key = f"{prefix}handoff/input-manifest.json"
    manifest_head = BASE.upload_file(args.profile, args.bucket, manifest_key, manifest_path, manifest_sha, args.source_commit)
    receipt = {
        "schema": "com.saferide.ai.v051-sagemaker-staging-receipt",
        "schemaVersion": 1,
        "createdAt": args.created_at,
        "manifestId": manifest["manifestId"],
        "manifestPath": str(manifest_path),
        "manifestSha256": manifest_sha,
        "manifestSizeBytes": manifest_path.stat().st_size,
        "manifestS3Uri": f"s3://{args.bucket}/{manifest_key}",
        "manifestVersionId": str(manifest_head["VersionId"]),
        "manifestEtag": str(manifest_head.get("ETag", "unknown")),
        "datasetSourceCommit": args.source_commit,
        "trainingArchiveSha256": package["archiveSha256"],
        "baseModelRevision": MODEL_REVISION,
        "baseModelReusedFromImmutableV05Input": True,
        "restrictedEvaluationBytesUploaded": False,
        "mitigationHoldoutUploaded": False,
    }
    receipt_path = work_dir / "staging-receipt.json"
    BASE.write_private_json(receipt_path, receipt)
    return {**receipt, "receiptPath": str(receipt_path)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    package = subparsers.add_parser("package-dataset")
    for target in (package,):
        target.add_argument("--frozen-dir", required=True)
        target.add_argument("--source-v05-package", required=True)
        target.add_argument("--output-dir", required=True)
        target.add_argument("--source-commit", required=True)
        target.add_argument("--created-at", required=True)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--frozen-dir", required=True)
    stage_parser.add_argument("--source-v05-package", required=True)
    stage_parser.add_argument("--source-input-manifest", required=True)
    stage_parser.add_argument("--work-dir", required=True)
    stage_parser.add_argument("--source-commit", required=True)
    stage_parser.add_argument("--created-at", required=True)
    stage_parser.add_argument("--bucket", required=True)
    stage_parser.add_argument("--profile", default="esheria-prod")
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if args.command == "contract-check":
        require(BASE_STAGER_PATH.is_file() and GOVERNANCE_PATH.is_file(), "v0.5.1 staging dependencies are missing.")
        print("SafeRide v0.5.1 SageMaker staging contract passed.")
        return 0
    if args.command == "package-dataset":
        result = package_dataset(Path(args.frozen_dir).resolve(), Path(args.source_v05_package).resolve(), Path(args.output_dir).resolve(), args.source_commit, args.created_at)
    else:
        result = stage(args)
    print(json.dumps({key: value for key, value in result.items() if key not in {"manifestS3Uri", "manifestVersionId", "manifestEtag"}}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - output is content-free.
        print(f"SafeRide v0.5.1 staging blocked: {str(error)[:500]}", file=sys.stderr)
        raise SystemExit(1)
