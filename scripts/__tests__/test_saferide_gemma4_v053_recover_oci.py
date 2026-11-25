import argparse
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v053-recover-oci.py"
SPEC = importlib.util.spec_from_file_location("saferide_v053_recover_oci_test", SCRIPT)
assert SPEC and SPEC.loader
RECOVERY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RECOVERY
SPEC.loader.exec_module(RECOVERY)


def compact(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


class FakeRegistry:
    manifests = {}
    blobs = {}

    def __init__(self, _registry, _repository, password):
        assert password == b"fixture-password"

    def manifest(self, value):
        return self.manifests[value]

    def blob(self, value, output):
        body = self.blobs[value]
        output.write(body)
        return digest(body), len(body)


class OciRecoveryTests(unittest.TestCase):
    def test_exact_ecr_index_is_recovered_and_validates_with_portable_launcher(self):
        runtime_config = compact({
            "architecture": "amd64",
            "os": "linux",
            "config": {
                "Entrypoint": ["python", "/opt/saferide/scripts/saferide-gemma4-v05-sagemaker-entrypoint.py"],
                "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
                "Labels": {
                    "org.opencontainers.image.title": "SafeRide Gemma 4 E2B v0.5-series SageMaker trainer",
                    "org.opencontainers.image.revision": "2" * 40,
                    "com.saferide.base-model-revision": "70af34e20bd4b7a91f0de6b22675850c43922a03",
                    "com.saferide.issue": "ESH-4198",
                },
            },
        })
        runtime_layer = b"runtime-layer"
        runtime_manifest = compact({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{digest(runtime_config)}",
                "size": len(runtime_config),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar",
                "digest": f"sha256:{digest(runtime_layer)}",
                "size": len(runtime_layer),
            }],
        })
        attestation_config = compact({"architecture": "unknown", "os": "unknown", "config": {}})
        attestation_layer = b"attestation"
        attestation_manifest = compact({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{digest(attestation_config)}",
                "size": len(attestation_config),
            },
            "layers": [{
                "mediaType": "application/vnd.in-toto+json",
                "digest": f"sha256:{digest(attestation_layer)}",
                "size": len(attestation_layer),
            }],
        })
        source_index = compact({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{digest(runtime_manifest)}",
                    "size": len(runtime_manifest),
                    "platform": {"architecture": "amd64", "os": "linux"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{digest(attestation_manifest)}",
                    "size": len(attestation_manifest),
                    "platform": {"architecture": "unknown", "os": "unknown"},
                },
            ],
        })
        root_digest = digest(source_index)
        FakeRegistry.manifests = {
            root_digest: (source_index, "application/vnd.oci.image.index.v1+json"),
            digest(runtime_manifest): (runtime_manifest, "application/vnd.oci.image.manifest.v1+json"),
            digest(attestation_manifest): (attestation_manifest, "application/vnd.oci.image.manifest.v1+json"),
        }
        FakeRegistry.blobs = {
            digest(runtime_config): runtime_config,
            digest(runtime_layer): runtime_layer,
            digest(attestation_config): attestation_config,
            digest(attestation_layer): attestation_layer,
        }

        with tempfile.TemporaryDirectory(prefix="saferide-v053-recover-oci-test-") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            plan = {
                "schema": "com.saferide.ai.v05-sagemaker-launch-plan",
                "schemaVersion": 1,
                "launchId": "saferide-v053-sagemaker-launch-fixture001",
                "createdAt": "2026-08-08T00:00:00Z",
                "launcherSourceCommit": "2" * 40,
                "datasetSourceCommit": "1" * 40,
                "datasetId": "saferide-synthetic-guidance-v0.5.3",
                "status": "ready",
                "runKind": "pilot",
                "runId": "saferide-v053-pilot-fixture001",
                "region": "eu-central-1",
                "roleArn": "arn:aws:iam::123456789012:role/SafeRideTraining",
                "image": {
                    "uri": "123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05-training:immutable",
                    "digest": root_digest,
                },
                "inputManifest": {
                    "path": "input-manifest.json",
                    "sha256": "3" * 64,
                    "s3Uri": "s3://fixture/input-manifest.json",
                    "versionId": "fixture-version",
                },
                "instance": {"type": "ml.g5.xlarge", "count": 1, "volumeSizeGb": 80, "maxRuntimeSeconds": 14400},
                "hyperparameters": {"seed": 419805, "learningRate": 1e-5, "epochs": 1, "maxSteps": None, "pairedRunId": None},
                "output": {"s3Uri": "s3://fixture/output/", "checkpointS3Uri": "s3://fixture/checkpoint/"},
                "security": {"networkIsolation": True, "interContainerTrafficEncryption": True, "trainingChannels": ["handoff", "model"]},
                "privacy": {
                    "containsHoldouts": False,
                    "containsBlindPrompts": False,
                    "containsReviewerIdentity": False,
                    "containsCredentials": False,
                    "rawContentLogging": "forbidden",
                },
            }
            plan_path = root / "plan.json"
            plan_path.write_bytes(RECOVERY.canonical_json_bytes(plan))
            plan_path.chmod(0o600)
            plan_sha = RECOVERY.sha256_file(plan_path)
            archive_path = root / "image.oci.tar"
            lineage_path = root / "image-lineage.json"

            def fake_aws(arguments, *, binary=False):
                if arguments[:2] == ["ecr", "describe-images"]:
                    return json.dumps({"imageDetails": [{"imageDigest": f"sha256:{root_digest}"}]})
                if arguments[:2] == ["ecr", "get-login-password"] and binary:
                    return b"fixture-password\n"
                raise AssertionError(arguments)

            arguments = argparse.Namespace(
                plan=str(plan_path),
                plan_sha256=plan_sha,
                profile="fixture",
                output_archive=str(archive_path),
                output_manifest=str(lineage_path),
                created_at="2026-08-08T01:00:00Z",
            )
            with mock.patch.object(RECOVERY, "checked_aws", side_effect=fake_aws), mock.patch.object(RECOVERY, "RegistryClient", FakeRegistry):
                self.assertEqual(RECOVERY.recover(arguments), 0)

            lineage = json.loads(lineage_path.read_text(encoding="utf-8"))
            self.assertEqual(lineage["source"]["imageDigest"], root_digest)
            self.assertEqual(lineage["runtime"]["manifestDigest"], digest(runtime_manifest))
            self.assertEqual(lineage["runtime"]["configDigest"], digest(runtime_config))
            self.assertNotIn("fixture-password", lineage_path.read_text(encoding="utf-8"))
            portable = RECOVERY.load_portable()
            self.assertEqual(
                portable.verify_oci_image_archive(
                    archive_path,
                    expected_archive_sha256=lineage["archive"]["sha256"],
                    expected_manifest_digest=root_digest,
                    plan=plan,
                ),
                digest(runtime_config),
            )

            cache_index = compact({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [{
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{digest(runtime_manifest)}",
                    "size": len(runtime_manifest),
                    "platform": {"architecture": "amd64", "os": "linux"},
                }],
            })
            cache_archive = root / "local-cache.tar"
            with tarfile.open(cache_archive, "w", format=tarfile.GNU_FORMAT) as output:
                for name, body in (
                    ("index.json", cache_index),
                    ("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'),
                    ("manifest.json", b"[]"),
                    (f"blobs/sha256/{digest(runtime_manifest)}", runtime_manifest),
                    (f"blobs/sha256/{digest(runtime_config)}", runtime_config),
                    (f"blobs/sha256/{digest(runtime_layer)}", runtime_layer),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(body)
                    info.mode = 0o600
                    output.addfile(info, io.BytesIO(body))
            cache_archive.chmod(0o600)
            local_archive = root / "local-runtime.oci.tar"
            local_plan = root / "local-plan.json"
            local_lineage = root / "local-lineage.json"
            local_arguments = argparse.Namespace(
                plan=str(plan_path),
                plan_sha256=plan_sha,
                source_archive=str(cache_archive),
                output_archive=str(local_archive),
                output_plan=str(local_plan),
                output_manifest=str(local_lineage),
                created_at="2026-08-08T02:00:00Z",
            )
            local_inspection = {
                "descriptor": {
                    "mediaType": "application/vnd.oci.image.index.v1+json",
                    "digest": f"sha256:{root_digest}",
                    "size": len(source_index),
                },
                "repoDigests": [
                    f"123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/gemma4-v05-training@sha256:{root_digest}"
                ],
                "id": f"sha256:{digest(runtime_config)}",
                "os": "linux",
                "architecture": "amd64",
            }
            with mock.patch.object(RECOVERY, "inspect_local_image", return_value=local_inspection):
                self.assertEqual(RECOVERY.recover_local_cache(local_arguments), 0)
            derived = json.loads(local_plan.read_text(encoding="utf-8"))
            local_evidence = json.loads(local_lineage.read_text(encoding="utf-8"))
            self.assertEqual(derived["image"]["digest"], digest(runtime_manifest))
            self.assertEqual(local_evidence["source"]["imageDigest"], root_digest)
            self.assertEqual(local_evidence["runtime"]["configDigest"], digest(runtime_config))
            self.assertEqual(
                portable.verify_oci_image_archive(
                    local_archive,
                    expected_archive_sha256=local_evidence["archive"]["sha256"],
                    expected_manifest_digest=digest(runtime_manifest),
                    plan=derived,
                ),
                digest(runtime_config),
            )

            mismatched_inspection = {**local_inspection, "id": f"sha256:{'6' * 64}"}
            mismatched_arguments = argparse.Namespace(
                plan=str(plan_path),
                plan_sha256=plan_sha,
                source_archive=str(cache_archive),
                output_archive=str(root / "mismatched-runtime.oci.tar"),
                output_plan=str(root / "mismatched-plan.json"),
                output_manifest=str(root / "mismatched-lineage.json"),
                created_at="2026-08-08T03:00:00Z",
            )
            with mock.patch.object(RECOVERY, "inspect_local_image", return_value=mismatched_inspection):
                with self.assertRaisesRegex(RECOVERY.RecoveryError, "config differs"):
                    RECOVERY.recover_local_cache(mismatched_arguments)


if __name__ == "__main__":
    unittest.main()
