#!/usr/bin/env python3
"""Recover the exact SafeRide v0.5.3 ECR image graph as an OCI archive.

The command reads an immutable launch plan, verifies that its unique ECR tag
still resolves to the bound digest, retrieves that digest and every referenced
blob, and writes a deterministic private OCI archive plus a content-free
lineage manifest. Credentials remain in memory and are never logged.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import re
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, BinaryIO


sys.dont_write_bytecode = True
REPO_ROOT = Path(__file__).resolve().parents[1]
PORTABLE_PATH = REPO_ROOT / "scripts/saferide-gemma4-v053-portable-launcher.py"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
IMAGE_URI_PATTERN = re.compile(
    r"^(?P<account>[0-9]{12})\.dkr\.ecr\.(?P<region>[a-z0-9-]+)\.amazonaws\.com/"
    r"(?P<repository>[a-z0-9._/-]+):(?P<tag>[A-Za-z0-9._-]+)$"
)
INDEX_MEDIA_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_MEDIA_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
ACCEPT_MEDIA_TYPES = ", ".join(sorted(INDEX_MEDIA_TYPES | MANIFEST_MEDIA_TYPES))


class RecoveryError(RuntimeError):
    """Expected content-safe recovery failure."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RecoveryError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def compact_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def private_directory(path: Path, label: str) -> None:
    metadata = path.lstat()
    require(stat.S_ISDIR(metadata.st_mode), f"{label} must be a directory.")
    require(stat.S_IMODE(metadata.st_mode) == 0o700, f"{label} must use mode 0700.")
    require(not path.is_symlink(), f"{label} must not be a symbolic link.")
    if hasattr(os, "geteuid"):
        require(metadata.st_uid == os.geteuid(), f"{label} must be owned by the invoking user.")


def private_file(path: Path, label: str) -> None:
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file.")
    require(stat.S_IMODE(metadata.st_mode) == 0o600, f"{label} must use mode 0600.")
    require(not path.is_symlink(), f"{label} must not be a symbolic link.")
    if hasattr(os, "geteuid"):
        require(metadata.st_uid == os.geteuid(), f"{label} must be owned by the invoking user.")


def load_portable() -> Any:
    spec = importlib.util.spec_from_file_location("saferide_v053_oci_recovery_portable", PORTABLE_PATH)
    require(spec is not None and spec.loader is not None, "Portable launcher cannot be loaded.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def checked_aws(arguments: list[str], *, binary: bool = False) -> bytes | str:
    try:
        result = subprocess.run(
            ["aws", *arguments],
            cwd=REPO_ROOT,
            capture_output=True,
            text=not binary,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RecoveryError("Authorized AWS metadata operation could not run.") from error
    require(result.returncode == 0, "Authorized AWS metadata operation failed.")
    return result.stdout


class CredentialSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward the ECR Basic credential to a cross-host blob redirect."""

    def redirect_request(self, request: urllib.request.Request, *args: Any, **kwargs: Any) -> urllib.request.Request | None:
        redirected = super().redirect_request(request, *args, **kwargs)
        if redirected is not None:
            source_host = urllib.parse.urlsplit(request.full_url).hostname
            target_host = urllib.parse.urlsplit(redirected.full_url).hostname
            if source_host != target_host:
                redirected.remove_header("Authorization")
        return redirected


class RegistryClient:
    def __init__(self, registry: str, repository: str, password: bytes):
        require(password and b"\n" not in password and b"\r" not in password, "ECR authorization token is invalid.")
        self.registry = registry
        self.repository = urllib.parse.quote(repository, safe="/")
        credential = base64.b64encode(b"AWS:" + password).decode("ascii")
        self.authorization = f"Basic {credential}"
        self.opener = urllib.request.build_opener(
            CredentialSafeRedirectHandler(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )

    def _request(self, suffix: str, *, accept: str | None = None) -> urllib.response.addinfourl:
        headers = {"Authorization": self.authorization, "User-Agent": "saferide-v053-governed-recovery/1"}
        if accept:
            headers["Accept"] = accept
        request = urllib.request.Request(f"https://{self.registry}/v2/{self.repository}/{suffix}", headers=headers)
        try:
            return self.opener.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            raise RecoveryError(f"ECR registry retrieval failed with HTTP {error.code}.") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise RecoveryError("ECR registry retrieval failed.") from error

    def manifest(self, digest: str) -> tuple[bytes, str]:
        with self._request(f"manifests/sha256:{digest}", accept=ACCEPT_MEDIA_TYPES) as response:
            body = response.read()
            media_type = response.headers.get_content_type()
        return body, media_type

    def blob(self, digest: str, output: BinaryIO) -> tuple[str, int]:
        sha = hashlib.sha256()
        size = 0
        with self._request(f"blobs/sha256:{digest}") as response:
            for chunk in iter(lambda: response.read(8 * 1024 * 1024), b""):
                output.write(chunk)
                sha.update(chunk)
                size += len(chunk)
        return sha.hexdigest(), size


def descriptor_parts(value: Any, label: str) -> tuple[str, int, str]:
    require(isinstance(value, dict), f"{label} descriptor is invalid.")
    digest_value = str(value.get("digest", ""))
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest_value) is not None, f"{label} digest is invalid.")
    size = value.get("size")
    require(type(size) is int and size >= 0, f"{label} size is invalid.")
    media_type = str(value.get("mediaType", ""))
    require(bool(media_type), f"{label} media type is unavailable.")
    return digest_value.removeprefix("sha256:"), size, media_type


def add_tar_bytes(archive: tarfile.TarFile, name: str, value: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(value)
    info.mode = 0o600
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    archive.addfile(info, io.BytesIO(value))


def add_tar_file(archive: tarfile.TarFile, name: str, source: Path) -> None:
    info = tarfile.TarInfo(name)
    info.size = source.stat().st_size
    info.mode = 0o600
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    with source.open("rb") as handle:
        archive.addfile(info, handle)


def add_tar_member(
    destination: tarfile.TarFile,
    name: str,
    source_archive: tarfile.TarFile,
    source_member: tarfile.TarInfo,
) -> None:
    source = source_archive.extractfile(source_member)
    require(source is not None, "Docker cache archive member cannot be read.")
    info = tarfile.TarInfo(name)
    info.size = source_member.size
    info.mode = 0o600
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    with source:
        destination.addfile(info, source)


def inspect_local_image(image_uri: str) -> dict[str, Any]:
    template = (
        '{"descriptor":{{json .Descriptor}},"repoDigests":{{json .RepoDigests}},'
        '"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'
    )
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", template, image_uri],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RecoveryError("Local SafeRide image-cache inspection could not run.") from error
    require(result.returncode == 0, "The exact SafeRide image is unavailable in the local cache.")
    try:
        inspection = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RecoveryError("Local SafeRide image-cache metadata is invalid.") from error
    require(isinstance(inspection, dict), "Local SafeRide image-cache metadata is invalid.")
    return inspection


def recover(args: argparse.Namespace) -> int:
    os.umask(0o077)
    portable = load_portable()
    plan_path = Path(args.plan).expanduser().resolve(strict=True)
    private_file(plan_path, "Pilot plan")
    require(SHA256_PATTERN.fullmatch(args.plan_sha256) is not None, "Pilot-plan SHA-256 is invalid.")
    require(sha256_file(plan_path) == args.plan_sha256, "Pilot-plan bytes differ from the immutable binding.")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    portable.validate_plan(plan)
    match = IMAGE_URI_PATTERN.fullmatch(plan["image"]["uri"])
    require(match is not None, "Pilot image URI is not a supported private ECR tag.")
    expected_root_digest = plan["image"]["digest"]
    require(SHA256_PATTERN.fullmatch(expected_root_digest) is not None, "Pilot image digest is invalid.")
    account = match.group("account")
    region = match.group("region")
    repository = match.group("repository")
    tag = match.group("tag")
    registry = f"{account}.dkr.ecr.{region}.amazonaws.com"

    describe_output = checked_aws([
        "ecr", "describe-images", "--profile", args.profile, "--region", region,
        "--registry-id", account, "--repository-name", repository,
        "--image-ids", f"imageTag={tag}", "--output", "json",
    ])
    require(isinstance(describe_output, str), "ECR image inventory output is invalid.")
    description = json.loads(describe_output)
    details = description.get("imageDetails", []) if isinstance(description, dict) else []
    require(isinstance(details, list) and len(details) == 1, "ECR tag does not resolve to one immutable image detail.")
    require(details[0].get("imageDigest") == f"sha256:{expected_root_digest}", "ECR tag no longer resolves to the governed digest.")

    password_output = checked_aws([
        "ecr", "get-login-password", "--profile", args.profile, "--region", region,
    ], binary=True)
    require(isinstance(password_output, bytes), "ECR authorization output is invalid.")
    password = password_output.strip()
    client = RegistryClient(registry, repository, password)
    del password_output
    del password

    archive_path = Path(args.output_archive).expanduser().resolve()
    lineage_path = Path(args.output_manifest).expanduser().resolve()
    require(archive_path != lineage_path, "OCI archive and lineage manifest must be distinct files.")
    require(not archive_path.exists() and not lineage_path.exists(), "Recovery outputs already exist; immutable artifacts cannot be overwritten.")
    private_directory(archive_path.parent, "OCI archive output directory")
    private_directory(lineage_path.parent, "OCI lineage output directory")

    inventory: dict[str, dict[str, Any]] = {}
    runtime_candidates: list[tuple[str, str]] = []
    with tempfile.TemporaryDirectory(prefix=".saferide-v053-oci-", dir=archive_path.parent) as temporary:
        blob_root = Path(temporary) / "blobs/sha256"
        blob_root.mkdir(parents=True, mode=0o700)

        def store_bytes(digest: str, value: bytes, *, size: int, media_type: str, role: str) -> None:
            require(len(value) == size and hashlib.sha256(value).hexdigest() == digest, f"Recovered {role} bytes differ from the registry descriptor.")
            target = blob_root / digest
            if not target.exists():
                target.write_bytes(value)
                target.chmod(0o600)
            inventory.setdefault(digest, {"digest": digest, "sizeBytes": size, "mediaType": media_type, "role": role})

        def store_blob(descriptor: Any, label: str) -> tuple[str, int, str]:
            digest, size, media_type = descriptor_parts(descriptor, label)
            if digest in inventory:
                require(inventory[digest]["sizeBytes"] == size, f"{label} size conflicts with an existing blob reference.")
                return digest, size, media_type
            target = blob_root / digest
            with target.open("xb") as output:
                actual_digest, actual_size = client.blob(digest, output)
            target.chmod(0o600)
            require(actual_digest == digest and actual_size == size, f"Recovered {label} bytes differ from the registry descriptor.")
            inventory[digest] = {"digest": digest, "sizeBytes": size, "mediaType": media_type, "role": "blob"}
            return digest, size, media_type

        walked: set[str] = set()

        def walk_document(descriptor: Any, label: str) -> None:
            digest, size, declared_media_type = descriptor_parts(descriptor, label)
            if digest in walked:
                return
            body, response_media_type = client.manifest(digest)
            media_type = declared_media_type or response_media_type
            require(response_media_type in INDEX_MEDIA_TYPES | MANIFEST_MEDIA_TYPES, f"{label} registry media type is unsupported.")
            require(response_media_type == declared_media_type, f"{label} registry media type differs from its descriptor.")
            store_bytes(digest, body, size=size, media_type=media_type, role="document")
            try:
                document = json.loads(body.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise RecoveryError(f"{label} is not valid JSON.") from error
            require(isinstance(document, dict), f"{label} must be a JSON object.")
            if media_type in INDEX_MEDIA_TYPES:
                children = document.get("manifests", [])
                require(isinstance(children, list) and bool(children), f"{label} has no child descriptors.")
                for index, child in enumerate(children):
                    walk_document(child, f"{label} child {index}")
            else:
                config_descriptor = document.get("config")
                config_digest, _config_size, _config_media = store_blob(config_descriptor, f"{label} config")
                layers = document.get("layers", [])
                require(isinstance(layers, list) and bool(layers), f"{label} has no layers.")
                for index, layer in enumerate(layers):
                    store_blob(layer, f"{label} layer {index}")
                platform = descriptor.get("platform", {}) if isinstance(descriptor, dict) else {}
                require(isinstance(platform, dict), f"{label} platform is invalid.")
                if platform.get("os") == "linux" and platform.get("architecture") == "amd64":
                    runtime_candidates.append((digest, config_digest))
            walked.add(digest)

        root_body, root_media_type = client.manifest(expected_root_digest)
        require(root_media_type in INDEX_MEDIA_TYPES | MANIFEST_MEDIA_TYPES, "Governed ECR root media type is unsupported.")
        root_descriptor = {
            "mediaType": root_media_type,
            "digest": f"sha256:{expected_root_digest}",
            "size": len(root_body),
        }
        store_bytes(expected_root_digest, root_body, size=len(root_body), media_type=root_media_type, role="root-document")
        walk_document(root_descriptor, "Governed OCI root")
        if root_media_type in MANIFEST_MEDIA_TYPES:
            root_document = json.loads(root_body.decode("utf-8"))
            config_digest, _size, _media = store_blob(root_document.get("config"), "Governed OCI root config")
            runtime_candidates.append((expected_root_digest, config_digest))
        require(len(set(runtime_candidates)) == 1, "Recovered OCI graph must contain exactly one linux/amd64 runtime image.")
        runtime_manifest_digest, runtime_config_digest = runtime_candidates[0]

        index_bytes = compact_json_bytes({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [root_descriptor],
        })
        layout_bytes = b'{"imageLayoutVersion":"1.0.0"}'
        temporary_archive = Path(temporary) / "recovered.oci.tar"
        with tarfile.open(temporary_archive, "w", format=tarfile.GNU_FORMAT) as tar:
            add_tar_bytes(tar, "index.json", index_bytes)
            add_tar_bytes(tar, "oci-layout", layout_bytes)
            for digest in sorted(inventory):
                add_tar_file(tar, f"blobs/sha256/{digest}", blob_root / digest)
        temporary_archive.chmod(0o600)
        archive_sha256 = sha256_file(temporary_archive)
        archive_size = temporary_archive.stat().st_size
        os.replace(temporary_archive, archive_path)
        archive_path.chmod(0o600)

    lineage = {
        "schema": "com.saferide.ai.v053-oci-recovery-lineage",
        "schemaVersion": 1,
        "status": "recovered-exact-ecr-digest",
        "createdAt": args.created_at or utc_now(),
        "issue": "ESH-4198",
        "source": {
            "planSha256": args.plan_sha256,
            "imageDigest": expected_root_digest,
            "rootMediaType": root_media_type,
            "tagDigestVerified": True,
            "paidJobStarted": False,
        },
        "runtime": {
            "platform": "linux/amd64",
            "manifestDigest": runtime_manifest_digest,
            "configDigest": runtime_config_digest,
        },
        "archive": {
            "sha256": archive_sha256,
            "sizeBytes": archive_size,
            "blobCount": len(inventory),
            "blobBytes": sum(item["sizeBytes"] for item in inventory.values()),
            "blobs": [inventory[digest] for digest in sorted(inventory)],
        },
        "privacy": {
            "containsCredentials": False,
            "containsEnvironment": False,
            "containsHostPaths": False,
            "containsRawContent": False,
        },
    }
    lineage_path.write_bytes(canonical_json_bytes(lineage))
    lineage_path.chmod(0o600)
    print(
        "SafeRide v0.5.3 OCI recovery PASS "
        f"(rootDigest={expected_root_digest}; archiveSha256={archive_sha256}; "
        f"blobCount={len(inventory)}; paidJobs=0)."
    )
    return 0


def recover_local_cache(args: argparse.Namespace) -> int:
    """Create a governed runtime OCI lineage from an exact local Docker cache."""
    os.umask(0o077)
    portable = load_portable()
    plan_path = Path(args.plan).expanduser().resolve(strict=True)
    source_archive_path = Path(args.source_archive).expanduser().resolve(strict=True)
    private_file(plan_path, "Pilot plan")
    private_file(source_archive_path, "Local SafeRide image-cache archive")
    require(SHA256_PATTERN.fullmatch(args.plan_sha256) is not None, "Pilot-plan SHA-256 is invalid.")
    require(sha256_file(plan_path) == args.plan_sha256, "Pilot-plan bytes differ from the immutable binding.")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    portable.validate_plan(plan)
    image_uri = plan["image"]["uri"]
    match = IMAGE_URI_PATTERN.fullmatch(image_uri)
    require(match is not None, "Pilot image URI is not a supported private ECR tag.")
    expected_source_digest = plan["image"]["digest"]
    inspection = inspect_local_image(image_uri)
    descriptor = inspection.get("descriptor", {})
    source_digest, source_size, source_media_type = descriptor_parts(descriptor, "Local SafeRide source image")
    require(source_digest == expected_source_digest, "Local SafeRide image-cache descriptor differs from the immutable plan.")
    require(source_media_type in INDEX_MEDIA_TYPES, "Local SafeRide source image is not the governed OCI index.")
    require(inspection.get("os") == "linux" and inspection.get("architecture") == "amd64", "Local SafeRide image-cache platform differs.")
    image_id = str(inspection.get("id", ""))
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id) is not None, "Local SafeRide image-cache ID is invalid.")
    expected_config_digest = image_id.removeprefix("sha256:")
    repository_uri = image_uri.rsplit(":", 1)[0]
    expected_repo_digest = f"{repository_uri}@sha256:{expected_source_digest}"
    repo_digests = inspection.get("repoDigests", [])
    require(isinstance(repo_digests, list) and expected_repo_digest in repo_digests, "Local SafeRide repository digest binding is unavailable.")

    archive_path = Path(args.output_archive).expanduser().resolve()
    derived_plan_path = Path(args.output_plan).expanduser().resolve()
    lineage_path = Path(args.output_manifest).expanduser().resolve()
    outputs = {archive_path, derived_plan_path, lineage_path}
    require(len(outputs) == 3, "Local recovery outputs must be distinct files.")
    require(all(not path.exists() for path in outputs), "Recovery outputs already exist; immutable artifacts cannot be overwritten.")
    for path, label in (
        (archive_path, "OCI archive output directory"),
        (derived_plan_path, "Derived plan output directory"),
        (lineage_path, "OCI lineage output directory"),
    ):
        private_directory(path.parent, label)

    source_archive_sha256 = sha256_file(source_archive_path)
    source_archive_size = source_archive_path.stat().st_size
    with tempfile.TemporaryDirectory(prefix=".saferide-v053-local-oci-", dir=archive_path.parent) as temporary:
        temporary_root = Path(temporary)
        temporary_root.chmod(0o700)
        temporary_archive = temporary_root / "runtime.oci.tar"
        try:
            with tarfile.open(source_archive_path, "r:*") as source_tar:
                members: dict[str, tarfile.TarInfo] = {}
                for member in source_tar.getmembers():
                    path = Path(member.name)
                    require(not path.is_absolute() and ".." not in path.parts, "Local SafeRide image-cache archive contains path traversal.")
                    require(member.name not in members, "Local SafeRide image-cache archive contains duplicate paths.")
                    require(not (member.issym() or member.islnk() or member.isdev() or member.isfifo()), "Local SafeRide image-cache archive contains an unsafe entry.")
                    members[member.name] = member
                require("index.json" in members and "oci-layout" in members, "Local SafeRide image-cache archive lacks OCI metadata.")
                index_source = source_tar.extractfile(members["index.json"])
                layout_source = source_tar.extractfile(members["oci-layout"])
                require(index_source is not None and layout_source is not None, "Local SafeRide OCI metadata cannot be read.")
                index_bytes = index_source.read()
                layout_bytes = layout_source.read()
                index = json.loads(index_bytes.decode("utf-8"))
                manifests = index.get("manifests", []) if isinstance(index, dict) else []
                require(isinstance(manifests, list) and len(manifests) == 1, "Local SafeRide cache export must resolve one runtime image.")
                runtime_digest, _runtime_size, runtime_media_type = descriptor_parts(manifests[0], "Local SafeRide runtime image")
                require(runtime_media_type in MANIFEST_MEDIA_TYPES, "Local SafeRide cache export root is not a runtime manifest.")
                platform = manifests[0].get("platform", {})
                require(isinstance(platform, dict) and platform.get("os") == "linux" and platform.get("architecture") == "amd64", "Local SafeRide cache export platform differs.")
                blob_members = {
                    name: member for name, member in members.items()
                    if member.isfile() and re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", name)
                }
                require(bool(blob_members), "Local SafeRide cache export has no OCI blobs.")
                with tarfile.open(temporary_archive, "w", format=tarfile.GNU_FORMAT) as destination:
                    add_tar_bytes(destination, "index.json", index_bytes)
                    add_tar_bytes(destination, "oci-layout", layout_bytes)
                    for name in sorted(blob_members):
                        add_tar_member(destination, name, source_tar, blob_members[name])
        except (OSError, tarfile.TarError, UnicodeError, json.JSONDecodeError) as error:
            raise RecoveryError("Local SafeRide image-cache archive is unavailable or invalid.") from error
        temporary_archive.chmod(0o600)
        archive_sha256 = sha256_file(temporary_archive)
        archive_size = temporary_archive.stat().st_size
        derived_plan = json.loads(json.dumps(plan))
        derived_plan["image"]["digest"] = runtime_digest
        portable.validate_plan(derived_plan)
        runtime_config_digest = portable.verify_oci_image_archive(
            temporary_archive,
            expected_archive_sha256=archive_sha256,
            expected_manifest_digest=runtime_digest,
            plan=derived_plan,
        )
        require(runtime_config_digest == expected_config_digest, "Local SafeRide cache export config differs from the inspected governed image.")
        derived_plan_bytes = canonical_json_bytes(derived_plan)
        derived_plan_sha256 = hashlib.sha256(derived_plan_bytes).hexdigest()
        temporary_plan = temporary_root / "derived-plan.json"
        temporary_plan.write_bytes(derived_plan_bytes)
        temporary_plan.chmod(0o600)

        lineage = {
            "schema": "com.saferide.ai.v053-oci-recovery-lineage",
            "schemaVersion": 1,
            "status": "recovered-exact-runtime-from-local-cache",
            "createdAt": args.created_at or utc_now(),
            "issue": "ESH-4198",
            "source": {
                "historicalPlanSha256": args.plan_sha256,
                "imageDigest": expected_source_digest,
                "rootMediaType": source_media_type,
                "rootSizeBytes": source_size,
                "localRepoDigestVerified": True,
                "ecrLiveVerification": "unavailable-after-bounded-sso-authorization",
                "paidJobStarted": False,
            },
            "transportArchive": {
                "sha256": source_archive_sha256,
                "sizeBytes": source_archive_size,
            },
            "derived": {
                "planSha256": derived_plan_sha256,
                "imageDigest": runtime_digest,
                "derivation": "exact-linux-amd64-runtime-from-governed-local-index-cache",
            },
            "runtime": {
                "platform": "linux/amd64",
                "manifestDigest": runtime_digest,
                "configDigest": runtime_config_digest,
            },
            "archive": {
                "sha256": archive_sha256,
                "sizeBytes": archive_size,
                "blobCount": len(blob_members),
            },
            "privacy": {
                "containsCredentials": False,
                "containsEnvironment": False,
                "containsHostPaths": False,
                "containsRawContent": False,
            },
        }
        temporary_lineage = temporary_root / "lineage.json"
        temporary_lineage.write_bytes(canonical_json_bytes(lineage))
        temporary_lineage.chmod(0o600)
        os.replace(temporary_archive, archive_path)
        os.replace(temporary_plan, derived_plan_path)
        os.replace(temporary_lineage, lineage_path)
        for path in outputs:
            path.chmod(0o600)

    print(
        "SafeRide v0.5.3 local OCI recovery PASS "
        f"(sourceDigest={expected_source_digest}; runtimeDigest={runtime_digest}; "
        f"archiveSha256={archive_sha256}; paidJobs=0)."
    )
    return 0


def contract_check() -> int:
    require(PORTABLE_PATH.is_file(), "Portable launcher is unavailable.")
    require(len(INDEX_MEDIA_TYPES) == 2 and len(MANIFEST_MEDIA_TYPES) == 2, "OCI media-type contract differs.")
    require(IMAGE_URI_PATTERN.fullmatch("123456789012.dkr.ecr.eu-central-1.amazonaws.com/saferide/example:immutable") is not None, "ECR URI contract differs.")
    print("SafeRide v0.5.3 OCI recovery contract PASS (no AWS or network access).")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    recover_parser = subparsers.add_parser("recover-ecr")
    recover_parser.add_argument("--plan", required=True)
    recover_parser.add_argument("--plan-sha256", required=True)
    recover_parser.add_argument("--profile", required=True)
    recover_parser.add_argument("--output-archive", required=True)
    recover_parser.add_argument("--output-manifest", required=True)
    recover_parser.add_argument("--created-at")
    local_parser = subparsers.add_parser("recover-local-cache")
    local_parser.add_argument("--plan", required=True)
    local_parser.add_argument("--plan-sha256", required=True)
    local_parser.add_argument("--source-archive", required=True)
    local_parser.add_argument("--output-archive", required=True)
    local_parser.add_argument("--output-plan", required=True)
    local_parser.add_argument("--output-manifest", required=True)
    local_parser.add_argument("--created-at")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "contract-check":
        return contract_check()
    if args.command == "recover-local-cache":
        return recover_local_cache(args)
    return recover(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RecoveryError as error:
        print(f"SafeRide v0.5.3 OCI recovery blocked: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print("SafeRide v0.5.3 OCI recovery blocked by an unexpected content-suppressed error.", file=sys.stderr)
        raise SystemExit(1)
