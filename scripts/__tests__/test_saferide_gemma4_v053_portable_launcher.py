import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v053-portable-launcher.py"
SPEC = importlib.util.spec_from_file_location("saferide_v053_portable_launcher_test", SCRIPT)
assert SPEC and SPEC.loader
PORTABLE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PORTABLE
SPEC.loader.exec_module(PORTABLE)


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def private_directory(path):
    path.mkdir(parents=True, mode=0o700)
    path.chmod(0o700)
    return path


def private_file(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if isinstance(value, (dict, list)):
        value = json_bytes(value)
    if isinstance(value, str):
        value = value.encode("utf-8")
    path.write_bytes(value)
    path.chmod(0o600)
    return path


def jsonl_bytes(values):
    return ("".join(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n" for value in values)).encode("utf-8")


class PortableFixture:
    source_commit = "1" * 40
    launcher_commit = "2" * 40
    image_uri = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05:commit-222222222222"

    def __init__(self, root, *, bad_sample_order=False):
        self.root = Path(root)
        self.control_root = private_directory(self.root / "control")
        image_archive_bytes, self.image_digest, self.docker_image_id = self._oci_image_archive()
        self.image_archive = private_file(self.control_root / "saferide-v053.oci.tar", image_archive_bytes)
        self.image_archive_sha = sha256_bytes(image_archive_bytes)
        self.handoff = private_directory(self.root / "handoff")
        self.model = private_directory(self.root / "model")
        self.runtime = private_directory(self.root / "runtime")
        self.model_output = private_directory(self.root / "model-output")
        self.output_data = private_directory(self.root / "output-data")
        self.checkpoints = private_directory(self.root / "checkpoints")
        self.paths = PORTABLE.BundlePaths(
            plan=self.control_root / "pilot-plan.json",
            image_archive=self.image_archive,
            handoff=self.handoff,
            model=self.model,
            runtime=self.runtime,
            model_output=self.model_output,
            output_data=self.output_data,
            checkpoints=self.checkpoints,
        )
        model_records = []
        for index, name in enumerate(PORTABLE.EXPECTED_MODEL_FILES):
            content = f"model-fixture-{index}-{name}".encode("utf-8")
            private_file(self.model / name, content)
            model_records.append({
                "path": name,
                "sha256": sha256_bytes(content),
                "sizeBytes": len(content),
                "s3Uri": f"s3://fixture/immutable/model/{name}",
                "versionId": f"version-{index}",
                "etag": f"etag-{index}",
            })
        archive_bytes, package_sha = self._dataset_archive(bad_sample_order=bad_sample_order)
        archive_name = "saferide-v053-sagemaker-input-0123456789ab.tar.gz"
        private_file(self.handoff / archive_name, archive_bytes)
        self.manifest = {
            "schema": "com.saferide.ai.v05-sagemaker-input-manifest",
            "schemaVersion": 1,
            "manifestId": "saferide-v053-sagemaker-input-0123456789ab",
            "createdAt": "2026-08-06T12:00:00Z",
            "sourceCommit": self.source_commit,
            "datasetId": PORTABLE.DATASET_ID,
            "region": "eu-central-1",
            "trainingArchive": {
                "fileName": archive_name,
                "sha256": sha256_bytes(archive_bytes),
                "sizeBytes": len(archive_bytes),
                "packageManifestSha256": package_sha,
                "topLevelDirectory": "saferide-v053-sagemaker-input-0123456789ab",
                "s3Uri": f"s3://fixture/immutable/handoff/{archive_name}",
                "versionId": "archive-version",
                "etag": "archive-etag",
            },
            "baseModel": {
                "modelId": PORTABLE.MODEL_ID,
                "revision": PORTABLE.MODEL_REVISION,
                "totalBytes": sum(item["sizeBytes"] for item in model_records),
                "fileCount": 9,
                "files": model_records,
                "s3Prefix": "s3://fixture/immutable/model/",
            },
            "storage": {
                "bucket": "fixture",
                "prefix": "saferide/v053/sagemaker/inputs/fixture/",
                "versioning": "Enabled",
                "serverSideEncryption": "AES256",
                "publicAccessBlocked": True,
            },
            "exclusions": {
                "qualityHoldout": True,
                "safetyHoldout": True,
                "blindPrompts": True,
                "candidateContent": True,
                "reviewLedgers": True,
                "reviewerIdentities": True,
                "credentials": True,
            },
            "privacy": {
                "classification": "controlled-training-input",
                "containsSurvivorData": False,
                "containsCredentials": False,
                "containsRestrictedEvaluationBytes": False,
            },
        }
        manifest_path = private_file(self.handoff / "input-manifest.json", self.manifest)
        self.manifest_sha = PORTABLE.sha256_file(manifest_path)
        self.plan = {
            "schema": "com.saferide.ai.v05-sagemaker-launch-plan",
            "schemaVersion": 1,
            "launchId": "saferide-v053-sagemaker-launch-weekend01",
            "createdAt": "2026-08-06T13:00:00Z",
            "launcherSourceCommit": self.launcher_commit,
            "datasetSourceCommit": self.source_commit,
            "datasetId": PORTABLE.DATASET_ID,
            "status": "ready",
            "runKind": "pilot",
            "runId": "saferide-v053-pilot-weekend01",
            "region": "eu-central-1",
            "roleArn": "arn:aws:iam::123456789012:role/SafeRideTraining",
            "image": {"uri": self.image_uri, "digest": self.image_digest},
            "inputManifest": {
                "path": "input-manifest.json",
                "sha256": self.manifest_sha,
                "s3Uri": "s3://fixture/immutable/handoff/input-manifest.json",
                "versionId": "manifest-version",
            },
            "instance": {"type": "ml.g5.xlarge", "count": 1, "volumeSizeGb": 80, "maxRuntimeSeconds": 14400},
            "hyperparameters": {"seed": 419805, "learningRate": 1e-5, "epochs": 1, "maxSteps": None, "pairedRunId": None},
            "output": {
                "s3Uri": "s3://fixture/immutable/output/",
                "checkpointS3Uri": "s3://fixture/immutable/checkpoints/",
            },
            "security": {"networkIsolation": True, "interContainerTrafficEncryption": True, "trainingChannels": ["handoff", "model"]},
            "privacy": {
                "containsHoldouts": False,
                "containsBlindPrompts": False,
                "containsReviewerIdentity": False,
                "containsCredentials": False,
                "rawContentLogging": "forbidden",
            },
        }
        private_file(self.paths.plan, self.plan)
        self.plan_sha = PORTABLE.sha256_file(self.paths.plan)
        self.control = PORTABLE.load_control(
            self.paths,
            plan_sha256=self.plan_sha,
            manifest_sha256=self.manifest_sha,
            image_archive_sha256=self.image_archive_sha,
            mode="pilot",
            minimum_model_bytes=0,
        )

    def _oci_image_archive(self):
        config = {
            "architecture": "amd64",
            "os": "linux",
            "config": {
                "Entrypoint": [
                    "python",
                    "/opt/saferide/scripts/saferide-gemma4-v05-sagemaker-entrypoint.py",
                ],
                "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
                "Labels": {
                    "org.opencontainers.image.title": "SafeRide Gemma 4 E2B v0.5-series SageMaker trainer",
                    "org.opencontainers.image.revision": self.launcher_commit,
                    "com.saferide.base-model-revision": PORTABLE.MODEL_REVISION,
                    "com.saferide.issue": "ESH-4198",
                },
            },
        }
        config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
        config_digest = sha256_bytes(config_bytes)
        layer_bytes = b"fixture-oci-layer"
        layer_digest = sha256_bytes(layer_bytes)
        manifest = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{config_digest}",
                "size": len(config_bytes),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar",
                "digest": f"sha256:{layer_digest}",
                "size": len(layer_bytes),
            }],
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
        manifest_digest = sha256_bytes(manifest_bytes)
        attestation_config = {"architecture": "unknown", "os": "unknown", "config": {}}
        attestation_config_bytes = json.dumps(attestation_config, sort_keys=True, separators=(",", ":")).encode("utf-8")
        attestation_config_digest = sha256_bytes(attestation_config_bytes)
        attestation_layer_bytes = b'{"predicateType":"fixture"}'
        attestation_layer_digest = sha256_bytes(attestation_layer_bytes)
        attestation_manifest = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{attestation_config_digest}",
                "size": len(attestation_config_bytes),
            },
            "layers": [{
                "mediaType": "application/vnd.in-toto+json",
                "digest": f"sha256:{attestation_layer_digest}",
                "size": len(attestation_layer_bytes),
            }],
        }
        attestation_manifest_bytes = json.dumps(attestation_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
        attestation_manifest_digest = sha256_bytes(attestation_manifest_bytes)
        source_index = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{manifest_digest}",
                    "size": len(manifest_bytes),
                    "platform": {"architecture": "amd64", "os": "linux"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{attestation_manifest_digest}",
                    "size": len(attestation_manifest_bytes),
                    "platform": {"architecture": "unknown", "os": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
            ],
        }
        source_index_bytes = json.dumps(source_index, sort_keys=True, separators=(",", ":")).encode("utf-8")
        source_index_digest = sha256_bytes(source_index_bytes)
        index = {
            "schemaVersion": 2,
            "manifests": [{
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "digest": f"sha256:{source_index_digest}",
                "size": len(source_index_bytes),
            }],
        }
        files = {
            "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
            "index.json": json.dumps(index, sort_keys=True, separators=(",", ":")).encode("utf-8"),
            f"blobs/sha256/{config_digest}": config_bytes,
            f"blobs/sha256/{layer_digest}": layer_bytes,
            f"blobs/sha256/{manifest_digest}": manifest_bytes,
            f"blobs/sha256/{attestation_config_digest}": attestation_config_bytes,
            f"blobs/sha256/{attestation_layer_digest}": attestation_layer_bytes,
            f"blobs/sha256/{attestation_manifest_digest}": attestation_manifest_bytes,
            f"blobs/sha256/{source_index_digest}": source_index_bytes,
        }
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for name, value in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size = len(value)
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(value))
        return stream.getvalue(), source_index_digest, config_digest

    def _dataset_archive(self, *, bad_sample_order):
        train = []
        dataset_counts = [
            ("saferide-synthetic-guidance-v0.5.0", 1600),
            ("saferide-synthetic-guidance-v0.5.1", 120),
            ("saferide-synthetic-guidance-v0.5.2", 48),
            (PORTABLE.DATASET_ID, 64),
        ]
        index = 0
        new_ids = []
        for dataset_id, count in dataset_counts:
            for _ in range(count):
                row_id = f"row-{index:04d}"
                train.append({"id": row_id, "split": "train", "datasetId": dataset_id})
                if dataset_id == PORTABLE.DATASET_ID:
                    new_ids.append(row_id)
                index += 1
        dev = [{"id": f"dev-{index:03d}", "split": "dev"} for index in range(300)]
        train_bytes = jsonl_bytes(train)
        dev_bytes = jsonl_bytes(dev)
        sample_order = [row["id"] for row in train] + [row_id for row_id in new_ids for _ in range(4)]
        sample_order_sha = sha256_bytes("\n".join(sample_order).encode("utf-8"))
        if bad_sample_order:
            sample_order_sha = "0" * 64
        recipe = {
            "schema": "com.saferide.ai.v053-training-recipe",
            "datasetId": PORTABLE.DATASET_ID,
            "status": "frozen-for-cost-controlled-pilot",
            "learningRate": 1e-5,
            "epochs": 1,
            "fullCandidateSubmissionAuthorized": False,
            "sampleOrder": sample_order,
            "sampleOrderSha256": sample_order_sha,
        }
        recipe_bytes = json_bytes(recipe)
        register = {
            "schema": "com.saferide.ai.v053-mitigation-register",
            "datasetId": PORTABLE.DATASET_ID,
            "status": "experimental-training-ready-promotion-blocked",
            "sourceCommit": self.source_commit,
            "baseModel": {"modelId": PORTABLE.MODEL_ID, "revision": PORTABLE.MODEL_REVISION},
            "trainingAllowed": True,
            "fullCandidatesAllowed": False,
            "promotionAllowed": False,
            "bindings": {"originalDevelopmentSha256": sha256_bytes(dev_bytes)},
        }
        register_bytes = json_bytes(register)
        audit = {"schema": "com.saferide.ai.v053-dataset-audit", "status": "passed"}
        audit_bytes = json_bytes(audit)
        semantic = {
            "status": "passed",
            "threshold": 0.92,
            "blockingResult": {"flaggedPairCount": 0, "unresolvedPairCount": 0},
            "scope": {"sealedMitigationHoldoutRead": False, "blindSuiteTextRead": False},
        }
        semantic_bytes = json_bytes(semantic)
        tokenization = {"status": "passed", "truncatedRowCount": 0, "assistantOnlyLabels": True}
        tokenization_bytes = json_bytes(tokenization)
        frozen = {
            "schema": "com.saferide.ai.v053-mitigation-manifest",
            "datasetId": PORTABLE.DATASET_ID,
            "status": "frozen",
            "sourceCommit": self.source_commit,
            "trainingAllowed": True,
            "fullCandidatesAllowed": False,
            "promotionAllowed": False,
            "files": [
                {"path": "combined-train.private.jsonl", "recordCount": 1832, "sha256": sha256_bytes(train_bytes)},
                {"path": "training-recipe.private.json", "recordCount": 2088, "sha256": sha256_bytes(recipe_bytes)},
            ],
            "bindings": {
                "registerSha256": sha256_bytes(register_bytes),
                "combinedTrainSha256": sha256_bytes(train_bytes),
                "trainingRecipeSha256": sha256_bytes(recipe_bytes),
                "datasetAuditSha256": sha256_bytes(audit_bytes),
                "originalDevelopmentSha256": sha256_bytes(dev_bytes),
                "semanticReportSha256": sha256_bytes(semantic_bytes),
                "tokenizationReportSha256": sha256_bytes(tokenization_bytes),
            },
            "privacy": {"sealedMitigationHoldoutRead": False, "containsDevelopmentRows": False},
        }
        files = {
            "register.json": register_bytes,
            "artifacts/audit/dataset-audit.json": audit_bytes,
            "artifacts/dataset/controlled/dev.jsonl": dev_bytes,
            "artifacts/dataset/controlled/pilot-row-manifest.json": recipe_bytes,
            "artifacts/dataset/controlled/train.jsonl": train_bytes,
            "artifacts/dataset/public-safe/dataset-manifest.json": json_bytes(frozen),
            "artifacts/policy/system-prompt.json": json_bytes({"status": "frozen"}),
            "artifacts/policy/v053-mitigation-plan.json": json_bytes({"status": "frozen"}),
            "artifacts/semantic/semantic-report.json": semantic_bytes,
            "artifacts/tokenization/tokenization-report.json": tokenization_bytes,
        }
        package = {
            "schema": "com.saferide.ai.v05-sagemaker-dataset-package",
            "schemaVersion": 1,
            "packageId": "saferide-v053-sagemaker-input-0123456789ab",
            "datasetId": PORTABLE.DATASET_ID,
            "sourceCommit": self.source_commit,
            "createdAt": "2026-08-06T12:00:00Z",
            "files": [
                {"path": name, "sha256": sha256_bytes(value), "sizeBytes": len(value)}
                for name, value in sorted(files.items())
            ],
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
            "privacy": {
                "containsSurvivorData": False,
                "containsRestrictedEvaluationBytes": False,
                "containsCredentials": False,
            },
        }
        package_bytes = json_bytes(package)
        files["metadata/sagemaker-package-manifest.json"] = package_bytes
        stream = io.BytesIO()
        top = "saferide-v053-sagemaker-input-0123456789ab"
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            directories = {top}
            for name in files:
                parts = Path(name).parts
                for size in range(1, len(parts)):
                    directories.add(f"{top}/{'/'.join(parts[:size])}")
            for name in sorted(directories):
                info = tarfile.TarInfo(f"{name}/")
                info.type = tarfile.DIRTYPE
                info.mode = 0o700
                archive.addfile(info)
            for name, value in sorted(files.items()):
                info = tarfile.TarInfo(f"{top}/{name}")
                info.size = len(value)
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(value))
        return stream.getvalue(), sha256_bytes(package_bytes)

    def snapshot(self, **gpu_changes):
        gpu = {
            "selectedDeviceCount": 1,
            "selectedDeviceIndex": 0,
            "uuidSha256": "a" * 64,
            "totalVramMiB": 24564,
            "freeVramMiB": 24000,
            "minimumFreeVramMiB": PORTABLE.MINIMUM_FREE_VRAM_MIB,
            "activeComputeProcessCount": 0,
            "gatePassed": True,
        }
        gpu.update(gpu_changes)
        return {
            "schema": "com.saferide.ai.v053-portable-host-gpu-snapshot",
            "schemaVersion": 1,
            "evidenceId": "fixture-host-gpu",
            "status": "captured",
            "capturedAt": "2026-08-08T09:00:00Z",
            "source": {
                "planSha256": self.plan_sha,
                "inputManifestSha256": self.manifest_sha,
                "imageDigest": self.image_digest,
                "imageArchiveSha256": self.image_archive_sha,
                "dockerImageId": self.docker_image_id,
                "launcherSourceCommit": self.launcher_commit,
                "datasetSourceCommit": self.source_commit,
                "baseModelRevision": PORTABLE.MODEL_REVISION,
            },
            "host": {"dockerServerVersion": "28.0.0", "imageAvailable": True, "imageLabelsMatch": True},
            "gpu": gpu,
            "security": {
                "networkMode": "none",
                "inputMountsReadOnly": True,
                "separateWritableOutputs": True,
                "hostPathsRecorded": False,
            },
            "privacy": {"containsHostPaths": False, "containsCredentials": False, "containsRawContent": False},
            "limitations": ["fixture"],
        }


class PortableLauncherTests(unittest.TestCase):
    def fixture(self, **options):
        temporary = tempfile.TemporaryDirectory(prefix="saferide-v053-portable-test-")
        self.addCleanup(temporary.cleanup)
        return PortableFixture(temporary.name, **options)

    def test_full_no_gpu_validator_checks_artifact_hashes_and_frozen_sample_order(self):
        fixture = self.fixture()
        validated = PORTABLE.validate_bundle(fixture.control, fixture.paths, fixture.snapshot())
        self.assertEqual(validated.control.mode, "pilot")
        self.assertRegex(validated.command_sha256, r"^[a-f0-9]{64}$")

        broken = self.fixture(bad_sample_order=True)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "sample order"):
            PORTABLE.validate_bundle(broken.control, broken.paths, broken.snapshot())

    def test_command_is_deterministic_offline_and_mounts_only_inputs_read_only(self):
        fixture = self.fixture()
        command_a = PORTABLE.build_docker_command(fixture.control, fixture.paths)
        command_b = PORTABLE.build_docker_command(fixture.control, fixture.paths)
        self.assertEqual(command_a, command_b)
        self.assertEqual(PORTABLE.command_sha256(command_a), PORTABLE.command_sha256(command_b))
        self.assertIn("none", command_a[command_a.index("--network") + 1:])
        self.assertEqual(command_a[command_a.index("--gpus") + 1], "device=0")
        self.assertIn("--read-only", command_a)
        self.assertIn("--pull", command_a)
        self.assertEqual(command_a[command_a.index("--cpus") + 1], "16")
        self.assertEqual(command_a[command_a.index("--memory") + 1], "96g")
        self.assertEqual(command_a[command_a.index("--memory-swap") + 1], "96g")
        self.assertIn(f"sha256:{fixture.docker_image_id}", command_a)
        self.assertIn(f"SAFERIDE_SAGEMAKER_IMAGE_DIGEST={fixture.image_digest}", command_a)
        mounts = [command_a[index + 1] for index, item in enumerate(command_a) if item == "--mount"]
        self.assertTrue(any("dst=/opt/ml/input/data/handoff,readonly" in item for item in mounts))
        self.assertTrue(any("dst=/opt/ml/input/data/model,readonly" in item for item in mounts))
        self.assertTrue(any("dst=/opt/ml/input/config,readonly" in item for item in mounts))
        self.assertTrue(any("dst=/opt/ml/model" in item and not item.endswith("readonly") for item in mounts))
        output_mount = next(item for item in mounts if "dst=/opt/ml/output/data" in item)
        self.assertIn(f"src={fixture.paths.container_output}", output_mount)
        self.assertNotIn(str(fixture.paths.evidence), "\n".join(command_a))
        self.assertFalse(output_mount.endswith("readonly"))
        self.assertTrue(any("dst=/opt/ml/checkpoints" in item and not item.endswith("readonly") for item in mounts))

    def test_stale_image_and_artifact_bindings_fail_closed(self):
        fixture = self.fixture()
        stale = fixture.snapshot()
        stale["source"]["imageDigest"] = "e" * 64
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "digest is stale"):
            PORTABLE.validate_host_snapshot(stale, fixture.control)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "stale image digest"):
            PORTABLE.verify_oci_image_archive(
                fixture.image_archive,
                expected_archive_sha256=fixture.image_archive_sha,
                expected_manifest_digest="e" * 64,
                plan=fixture.plan,
            )

        archive = fixture.handoff / fixture.manifest["trainingArchive"]["fileName"]
        os.chmod(archive, 0o600)
        with archive.open("ab") as handle:
            handle.write(b"changed")
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "size differs"):
            PORTABLE.verify_handoff(fixture.paths, fixture.control)

    def test_path_traversal_and_protected_input_inventory_are_rejected(self):
        fixture = self.fixture()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            info = tarfile.TarInfo("saferide-v053-sagemaker-input-0123456789ab/../../escape")
            info.size = 1
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(b"x"))
        unsafe = private_file(fixture.control_root / "unsafe.tar.gz", stream.getvalue())
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "path traversal"):
            PORTABLE.archive_file_members(unsafe, "saferide-v053-sagemaker-input-0123456789ab")

        private_file(fixture.handoff / "sealed-holdout.jsonl", b"fixture")
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "additional files"):
            PORTABLE.verify_handoff(fixture.paths, fixture.control)

    def test_unsafe_permissions_and_overlapping_output_bindings_are_rejected(self):
        fixture = self.fixture()
        fixture.handoff.chmod(0o755)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "0700"):
            PORTABLE.verify_handoff(fixture.paths, fixture.control)
        fixture.handoff.chmod(0o700)

        overlapping = PORTABLE.BundlePaths(
            plan=fixture.paths.plan,
            image_archive=fixture.paths.image_archive,
            handoff=fixture.paths.handoff,
            model=fixture.paths.model,
            runtime=fixture.paths.runtime,
            model_output=fixture.paths.checkpoints,
            output_data=fixture.paths.output_data,
            checkpoints=fixture.paths.checkpoints,
        )
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "separate non-nested"):
            PORTABLE.validate_path_separation(overlapping)

        broad = copy.copy(fixture.paths)
        broad = PORTABLE.BundlePaths(
            plan=broad.plan,
            image_archive=broad.image_archive,
            handoff=broad.handoff,
            model=broad.model,
            runtime=PORTABLE.REPO_ROOT.parent,
            model_output=broad.model_output,
            output_data=broad.output_data,
            checkpoints=broad.checkpoints,
        )
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "broader workspace ancestor"):
            PORTABLE.validate_path_separation(broad)

        symlink = fixture.root / "handoff-link"
        symlink.symlink_to(fixture.handoff, target_is_directory=True)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "symbolic links"):
            PORTABLE.resolved(symlink)

        private_file(fixture.output_data / "stale-result.json", {})
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "must be empty"):
            PORTABLE.validate_writable_roots(
                fixture.paths,
                resume=False,
                run_id=fixture.control.run_id,
            )

    def test_gpu_busy_and_insufficient_vram_snapshots_fail_without_termination(self):
        fixture = self.fixture()
        busy = fixture.snapshot(activeComputeProcessCount=1, gatePassed=False)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "occupied"):
            PORTABLE.validate_host_snapshot(busy, fixture.control)
        low_memory = fixture.snapshot(freeVramMiB=21000, gatePassed=False)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "free VRAM"):
            PORTABLE.validate_host_snapshot(low_memory, fixture.control)

    def test_live_host_gate_uses_only_read_only_inspection_commands(self):
        fixture = self.fixture()
        calls = []
        def fake_runner(arguments, **_kwargs):
            calls.append(arguments)
            if arguments[:3] == ["docker", "image", "inspect"]:
                payload = [{
                    "Id": f"sha256:{fixture.docker_image_id}",
                    "Config": {"Labels": {
                        "org.opencontainers.image.title": "SafeRide Gemma 4 E2B v0.5-series SageMaker trainer",
                        "org.opencontainers.image.revision": fixture.launcher_commit,
                        "com.saferide.base-model-revision": PORTABLE.MODEL_REVISION,
                        "com.saferide.issue": "ESH-4198",
                    }},
                }]
                return subprocess.CompletedProcess(arguments, 0, json.dumps(payload), "")
            if arguments[:2] == ["docker", "version"]:
                return subprocess.CompletedProcess(arguments, 0, "28.0.0\n", "")
            if "--query-gpu=index,uuid,memory.total,memory.free" in arguments:
                return subprocess.CompletedProcess(arguments, 0, "0, GPU-fixture, 24564, 24000\n", "")
            if "--query-compute-apps=gpu_uuid" in arguments:
                return subprocess.CompletedProcess(arguments, 0, "", "")
            raise AssertionError(arguments)

        snapshot = PORTABLE.collect_host_snapshot(
            fixture.control,
            runner=fake_runner,
            captured_at="2026-08-08T09:00:00Z",
        )
        PORTABLE.validate_host_snapshot(snapshot, fixture.control)
        self.assertTrue(snapshot["gpu"]["gatePassed"])
        self.assertEqual(snapshot["gpu"]["activeComputeProcessCount"], 0)
        self.assertFalse(any(call[:2] == ["docker", "run"] for call in calls))
        self.assertFalse(any("kill" in call or "stop" in call for call in calls))

        def busy_runner(arguments, **_kwargs):
            if "--query-gpu=index,uuid,memory.total,memory.free" in arguments:
                return subprocess.CompletedProcess(arguments, 0, "0, GPU-fixture, 24564, 24000\n", "")
            if "--query-compute-apps=gpu_uuid" in arguments:
                return subprocess.CompletedProcess(arguments, 0, "GPU-fixture\n", "")
            raise AssertionError(arguments)

        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "occupied"):
            PORTABLE.early_gpu_gate(busy_runner)

    def test_candidate_promotion_and_pre_authorization_launches_are_rejected(self):
        fixture = self.fixture()
        candidate = copy.deepcopy(fixture.plan)
        candidate["runKind"] = "candidate"
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "candidate and promotion"):
            PORTABLE.validate_plan(candidate)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "Candidate training"):
            PORTABLE.build_hyperparameters(fixture.plan, fixture.control.policy, "candidate")
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "scope"):
            PORTABLE.validate_launch_authorization(
                mode="pilot",
                authorization_kind="v053-promotion",
                authorization_ref="leadership-approval-20260808",
                authorized_at="2026-08-08T08:00:00Z",
                now=dt.datetime(2026, 8, 8, 9, tzinfo=dt.timezone.utc),
            )
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "frozen before"):
            PORTABLE.validate_launch_authorization(
                mode="pilot",
                authorization_kind="v053-pilot",
                authorization_ref="leadership-approval-20260807",
                authorized_at="2026-08-07T23:59:59Z",
                now=dt.datetime(2026, 8, 8, 9, tzinfo=dt.timezone.utc),
            )
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "must not be a URL"):
            PORTABLE.validate_launch_authorization(
                mode="pilot",
                authorization_kind="v053-pilot",
                authorization_ref="https://approval.example/reference",
                authorized_at="2026-08-08T08:00:00Z",
                now=dt.datetime(2026, 8, 8, 9, tzinfo=dt.timezone.utc),
            )
        reference_hash, authorization_time = PORTABLE.validate_launch_authorization(
            mode="pilot",
            authorization_kind="v053-pilot",
            authorization_ref="leadership-approval-20260808",
            authorized_at="2026-08-08T08:00:00Z",
            now=dt.datetime(2026, 8, 8, 9, tzinfo=dt.timezone.utc),
        )
        self.assertRegex(reference_hash, r"^[a-f0-9]{64}$")
        self.assertEqual(authorization_time, "2026-08-08T08:00:00Z")

    def test_secret_and_content_safe_log_filter_never_echoes_paths_or_payloads(self):
        secret = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz012345"
        synthetic_aws_key = "AK" + "IA" + "1234567890ABCDEF"
        raw = f"failed at /srv/private/input?token=unsafe {secret} {synthetic_aws_key}"
        sanitized = PORTABLE.sanitize_log_text(raw, [Path("/srv/private")])
        self.assertNotIn("/srv/private", sanitized)
        self.assertNotIn("unsafe", sanitized)
        self.assertNotIn(secret, sanitized)
        self.assertNotIn("AKIA", sanitized)
        self.assertEqual(PORTABLE.sanitize_log_text('{"prompt":"fixture narrative"}'), "[content-redacted]")
        self.assertIsNone(PORTABLE.content_safe_container_line("unstructured fixture narrative"))
        self.assertEqual(
            PORTABLE.content_safe_container_line("{'loss': 1.25, 'epoch': 0.5}"),
            "{'loss': 1.25, 'epoch': 0.5}",
        )

    def test_model_revision_and_manifest_hash_cannot_drift(self):
        fixture = self.fixture()
        stale_manifest = copy.deepcopy(fixture.manifest)
        stale_manifest["baseModel"]["revision"] = "3" * 40
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "revision differs"):
            PORTABLE.validate_manifest(stale_manifest, 0)
        invalid_size = copy.deepcopy(fixture.manifest)
        invalid_size["baseModel"]["files"][0]["sizeBytes"] = "12"
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "size binding is invalid"):
            PORTABLE.validate_manifest(invalid_size, 0)
        with self.assertRaisesRegex(PORTABLE.PortableLaunchError, "Input-manifest bytes"):
            PORTABLE.load_control(
                fixture.paths,
                plan_sha256=fixture.plan_sha,
                manifest_sha256="f" * 64,
                image_archive_sha256=fixture.image_archive_sha,
                mode="pilot",
                minimum_model_bytes=0,
            )

    def test_completed_output_contract_recovers_checkpoint_adapter_and_metadata(self):
        fixture = self.fixture()
        validated = PORTABLE.validate_bundle(fixture.control, fixture.paths, fixture.snapshot())
        checkpoint_run = private_directory(fixture.checkpoints / fixture.control.run_id)
        checkpoint = private_directory(checkpoint_run / "checkpoint-25")
        private_file(checkpoint / "trainer_state.json", {"global_step": 25})
        run_root = private_directory(fixture.model_output / fixture.control.run_id)
        adapter = private_directory(run_root / "adapter")
        private_file(adapter / "adapter_config.json", {"r": 8})
        private_file(adapter / "adapter_model.safetensors", b"fixture-adapter")
        private_file(adapter / "README.md", "fixture")
        private_file(run_root / "metadata.json", {
            "schema": "com.saferide.ai.training-run",
            "status": "completed",
            "datasetProfile": "v053",
            "runKind": "pilot",
            "runId": fixture.control.run_id,
            "baseModelId": PORTABLE.MODEL_ID,
            "baseRevision": PORTABLE.MODEL_REVISION,
            "promotionEligible": False,
            "outputs": {
                "holdoutRowsRead": 0,
                "rowsSeen": 2088,
                "epochsCompleted": 1.0,
                "bestMetric": 1.25,
                "adapterTensorValidation": {
                    "tensorCount": 4,
                    "elementCount": 128,
                    "nonFiniteTensorCount": 0,
                },
            },
        })
        container_output = private_directory(fixture.paths.container_output)
        private_file(container_output / "saferide-sagemaker-execution.json", {
            "schema": "com.saferide.ai.v05-sagemaker-execution",
            "status": "completed",
            "runKind": "pilot",
            "runId": fixture.control.run_id,
            "trainingJobName": fixture.control.run_id,
            "inputManifestSha256": fixture.control.manifest_sha256,
            "imageDigest": fixture.control.plan["image"]["digest"],
            "launcherSourceCommit": fixture.control.plan["launcherSourceCommit"],
            "datasetSourceCommit": fixture.control.plan["datasetSourceCommit"],
            "trainingArchiveSha256": fixture.control.manifest["trainingArchive"]["sha256"],
            "baseModelRevision": PORTABLE.MODEL_REVISION,
            "restrictedEvaluationBytesRead": False,
        })
        evidence = private_directory(fixture.output_data / "portable-evidence")
        private_file(evidence / "host-gpu-snapshot.json", fixture.snapshot())
        private_file(evidence / "launch-receipt.json", {"status": "running"})
        checkpoint_sha, model_sha = PORTABLE.verify_completed_outputs(validated)
        self.assertRegex(checkpoint_sha, r"^[a-f0-9]{64}$")
        self.assertRegex(model_sha, r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
