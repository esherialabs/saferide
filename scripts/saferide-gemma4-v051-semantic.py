#!/usr/bin/env python3
"""Run the content-free deterministic v0.5.1 semantic-separation gate."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import stat
import sys
import unicodedata
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
GOVERNANCE_PATH = REPO_ROOT / "config/ai/datasets/saferide-gemma4-v051-experimental-governance-amendment.json"
POLICY_PATH = REPO_ROOT / "config/ai/datasets/saferide-gemma4-v051-semantic-separation-policy.json"
DATASET_ID = "saferide-synthetic-guidance-v0.5.1"
SOURCE_DATASET_ID = "saferide-synthetic-guidance-v0.5.0"
MODEL_ID = "sentence-transformers/LaBSE"
MODEL_REVISION = "836121a0533e5664b21c7aacc5d22951f2b8b25b"
SOURCE_EMBEDDINGS_SHA256 = "fdcf609f020a95801895da6dbb9195748f246d159aa2e64e22dcb05b9e4a5979"
SOURCE_ROW_INVENTORY_SHA256 = "a359fb028bcd75365a8e42866d12f89975cd2ef8ed01cc913575d18ee0cd56f4"
HISTORICAL_REPORT_SHA256 = "fd277cdb16ad3e3543d50bcc28e91a1be1b0180145c1701b92ebd55c7f76a6a6"
HISTORICAL_FLAGGED_PAIR_COUNT = 31
HISTORICAL_MAXIMUM_SIMILARITY = 0.97773707
ONNX_SHA256 = "2a48ae86b3ef337ea47916915386180fe97ecbb73f0797b6f6b5550bb05c4979"
DENSE_SHA256 = "f866c945fa2147ce4940c8ead0b4b20af4217e0f4664bd35f41c2a0967c4fe77"
CANDIDATE_MANIFEST_SHA256 = "0f9ea98bd6a196d0b8a4f466b360eadccc3882963d94543e7f395ca18eb9d4ec"
THRESHOLD = 0.92
EXPECTED_SOURCE_COUNTS = {
    "train": 1600,
    "development": 300,
    "qualityHoldout": 300,
    "safetyHoldout": 400,
    "blindSuite": 240,
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def read_json(path: Path) -> Any:
    require(path.is_file(), f"Required JSON input is missing: {path.name}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"JSON input is invalid: {path.name}") from error


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    require(path.is_file(), f"Required JSONL input is missing: {path.name}")
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"JSONL input is invalid at line {line_number}: {path.name}") from error
            require(isinstance(row, dict), f"JSONL row is not an object: {path.name}")
            rows.append(row)
    return rows


def assert_private_file(path: Path) -> None:
    require(path.is_file(), f"Controlled file is missing: {path.name}")
    require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, f"Controlled file permissions are too broad: {path.name}")


def assert_private_directory(path: Path) -> None:
    require(path.is_dir(), f"Controlled directory is missing: {path.name}")
    require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, f"Controlled directory permissions are too broad: {path.name}")


def full_dialogue_text(row: dict[str, Any]) -> str:
    """Return the immutable historical non-system full-dialogue representation."""
    messages = row.get("messages")
    require(isinstance(messages, list) and messages, "Semantic input row lacks messages.")
    parts: list[str] = []
    for message in messages:
        require(isinstance(message, dict), "Semantic input message is invalid.")
        role = message.get("role")
        content = message.get("content")
        require(role in {"system", "user", "assistant"} and isinstance(content, str) and content.strip(), "Semantic input message differs from the chat contract.")
        if role != "system":
            normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
            parts.append(f"{role}:\n{normalized}")
    require(parts, "Semantic input row has no visible conversation text.")
    return "\n".join(parts)


# Preserve the historical helper name for the immutable v1 evaluator contract.
semantic_text = full_dialogue_text


def normalize_prompt_turn(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\s+", " ", normalized, flags=re.UNICODE).strip()


def prompt_only_text(row: dict[str, Any]) -> str:
    """Return only normalized user turns; system and assistant text never enter."""
    messages = row.get("messages")
    require(isinstance(messages, list) and messages, "Prompt semantic input row lacks messages.")
    turns: list[str] = []
    for message in messages:
        require(isinstance(message, dict), "Prompt semantic input message is invalid.")
        role = message.get("role")
        content = message.get("content")
        require(role in {"system", "user", "assistant"} and isinstance(content, str) and content.strip(), "Prompt semantic input message differs from the chat contract.")
        if role == "user":
            normalized = normalize_prompt_turn(content)
            require(normalized, "Prompt semantic user turn is empty after normalization.")
            turns.append(normalized)
    require(turns, "Prompt semantic input row has no user turns.")
    return "\n".join(turns)


def model_inventory(model_dir: Path) -> list[dict[str, Any]]:
    records = []
    for path in sorted(model_dir.rglob("*")):
        relative = path.relative_to(model_dir)
        if path.is_file() and ".cache" not in relative.parts:
            records.append({
                "path": relative.as_posix(),
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
            })
    require(records, "Pinned semantic model directory is empty.")
    return records


def iter_cross_split_pairs(split_indices: dict[str, list[int]]) -> Iterable[tuple[list[int], list[int]]]:
    yield split_indices["train"], split_indices["mitigation-dev"]
    yield split_indices["train"], split_indices["mitigation-holdout"]
    yield split_indices["mitigation-dev"], split_indices["mitigation-holdout"]


def similarity_statistics(candidate_embeddings: Any, source_embeddings: Any, split_indices: dict[str, list[int]], numpy_module: Any) -> tuple[int, float, int]:
    evaluated = 0
    flagged = 0
    maximum = -1.0
    source_matrix = numpy_module.asarray(source_embeddings, dtype=numpy_module.float32)
    for start in range(0, len(candidate_embeddings), 16):
        block = numpy_module.asarray(candidate_embeddings[start:start + 16], dtype=numpy_module.float32)
        scores = block @ source_matrix.T
        evaluated += int(scores.size)
        flagged += int(numpy_module.count_nonzero(scores >= THRESHOLD))
        maximum = max(maximum, float(scores.max()))
    candidate_matrix = numpy_module.asarray(candidate_embeddings, dtype=numpy_module.float32)
    for left_indices, right_indices in iter_cross_split_pairs(split_indices):
        scores = candidate_matrix[left_indices] @ candidate_matrix[right_indices].T
        evaluated += int(scores.size)
        flagged += int(numpy_module.count_nonzero(scores >= THRESHOLD))
        maximum = max(maximum, float(scores.max()))
    return evaluated, round(maximum, 8), flagged


def ensure_new_private_directory(path: Path) -> Path:
    require(path.is_absolute() and REPO_ROOT not in path.parents and not path.exists(), "Semantic output must be a new controlled directory outside the repository.")
    assert_private_directory(path.parent)
    path.mkdir(mode=0o700)
    return path


def write_private_json(path: Path, value: Any) -> None:
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n")
    path.chmod(0o600)


def source_identifier(row: dict[str, Any], blind: bool) -> str:
    key = "promptId" if blind else "id"
    value = row.get(key)
    require(isinstance(value, str) and value, f"Semantic source lacks {key}.")
    return value


def ordered_source_rows(source_rows_by_name: dict[str, list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], str]:
    core = sorted(
        source_rows_by_name["train"]
        + source_rows_by_name["development"]
        + source_rows_by_name["qualityHoldout"]
        + source_rows_by_name["safetyHoldout"],
        key=lambda row: source_identifier(row, False),
    )
    require(len(core) == 2600 and len({source_identifier(row, False) for row in core}) == 2600, "Approved source semantic row inventory differs.")
    require(hashlib.sha256("\n".join(source_identifier(row, False) for row in core).encode("utf-8")).hexdigest() == SOURCE_ROW_INVENTORY_SHA256, "Approved source embedding row order differs.")
    blind = sorted(source_rows_by_name["blindSuite"], key=lambda row: source_identifier(row, True))
    require(len(blind) == 240 and len({source_identifier(row, True) for row in blind}) == 240, "Approved blind semantic inventory differs.")
    ordering = [f"core:{source_identifier(row, False)}" for row in core] + [f"blind:{source_identifier(row, True)}" for row in blind]
    return core + blind, hashlib.sha256("\n".join(ordering).encode("utf-8")).hexdigest()


def load_source_rows(args: argparse.Namespace, request: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    source_paths = {
        "train": Path(args.source_train).expanduser().resolve(),
        "development": Path(args.source_development).expanduser().resolve(),
        "qualityHoldout": Path(args.source_quality_holdout).expanduser().resolve(),
        "safetyHoldout": Path(args.source_safety_holdout).expanduser().resolve(),
        "blindSuite": Path(args.source_blind_suite).expanduser().resolve(),
    }
    binding_names = {
        "train": "trainSha256",
        "development": "developmentSha256",
        "qualityHoldout": "qualityHoldoutSha256",
        "safetyHoldout": "safetyHoldoutSha256",
        "blindSuite": "blindSuiteSha256",
    }
    result: dict[str, list[dict[str, Any]]] = {}
    for name, path in source_paths.items():
        assert_private_file(path)
        require(sha256_file(path) == request["sourceBindings"][binding_names[name]], f"{name} semantic source hash differs.")
        rows = read_jsonl(path)
        require(len(rows) == EXPECTED_SOURCE_COUNTS[name], f"{name} semantic source count differs.")
        result[name] = rows
    return result


def load_candidate_package(package_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any], str]:
    assert_private_directory(package_dir)
    manifest_path = package_dir / "candidate-manifest.private.json"
    corpus_path = package_dir / "candidates.private.jsonl"
    request_path = package_dir / "semantic-request.private.json"
    for path in (manifest_path, corpus_path, request_path):
        assert_private_file(path)
    manifest_sha = sha256_file(manifest_path)
    manifest = read_json(manifest_path)
    request = read_json(request_path)
    rows = read_jsonl(corpus_path)
    require(len(rows) == 160 and manifest.get("counts", {}).get("rows") == 160, "Candidate semantic row count differs.")
    require(request.get("candidateManifestSha256") == manifest_sha and request.get("candidateCorpusSha256") == sha256_file(corpus_path), "Semantic request candidate binding differs.")
    return manifest, rows, request, manifest_sha


def candidate_split_indices(candidate_rows: list[dict[str, Any]]) -> dict[str, list[int]]:
    indices = {
        split: [index for index, row in enumerate(candidate_rows) if row.get("split") == split]
        for split in ("train", "mitigation-dev", "mitigation-holdout")
    }
    require({key: len(value) for key, value in indices.items()} == {"train": 120, "mitigation-dev": 20, "mitigation-holdout": 20}, "Candidate semantic split counts differ.")
    families: dict[str, dict[str, set[str]]] = {}
    for row in candidate_rows:
        metadata = row.get("metadata", {})
        family = metadata.get("scenarioFamilyId")
        language = metadata.get("language")
        split = row.get("split")
        require(isinstance(family, str) and language in {"en", "sw"} and split in indices, "Candidate bilingual family metadata differs.")
        state = families.setdefault(family, {"languages": set(), "splits": set()})
        state["languages"].add(str(language))
        state["splits"].add(str(split))
    require(len(families) == 80, "Candidate semantic family count differs.")
    require(all(state["languages"] == {"en", "sw"} for state in families.values()), "Candidate bilingual family is incomplete.")
    require(all(len(state["splits"]) == 1 for state in families.values()), "Candidate family crosses split boundaries; bilingual sibling exemption is forbidden across splits.")
    return indices


def load_runtime(model_dir: Path) -> tuple[Any, Any, Any, Any, Any, Any, dict[str, Any]]:
    require(model_dir.name == MODEL_REVISION, "Semantic model directory must be the immutable LaBSE revision snapshot.")
    model_path = model_dir / "onnx/model.onnx"
    dense_path = model_dir / "2_Dense/model.safetensors"
    require(sha256_file(model_path) == ONNX_SHA256 and sha256_file(dense_path) == DENSE_SHA256, "Pinned LaBSE ONNX or dense bytes differ from the approved method.")
    try:
        import numpy as np  # type: ignore
        import onnxruntime as ort  # type: ignore
        import transformers  # type: ignore
        from safetensors.numpy import load_file  # type: ignore
        from transformers import AutoTokenizer  # type: ignore
    except ModuleNotFoundError as error:
        raise RuntimeError("Pinned semantic runtime dependencies are unavailable.") from error
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, trust_remote_code=False)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 8
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    require(session.get_providers() == ["CPUExecutionProvider"], "Semantic evaluator provider differs from the approved deterministic runtime.")
    dense = load_file(str(dense_path))
    dense_weight = dense["linear.weight"].astype(np.float32)
    dense_bias = dense["linear.bias"].astype(np.float32)
    runtime = {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "onnxruntime": ort.__version__,
        "transformers": transformers.__version__,
        "providers": session.get_providers(),
        "intraOpThreads": 8,
        "interOpThreads": 1,
        "executionMode": "ORT_SEQUENTIAL",
    }
    return np, ort, tokenizer, session, dense_weight, dense_bias, runtime


def encode_texts(texts: list[str], tokenizer: Any, session: Any, dense_weight: Any, dense_bias: Any, np: Any) -> tuple[Any, list[int]]:
    require(texts, "Semantic encoder received no text.")
    token_lengths = [len(tokenizer(text, add_special_tokens=True, truncation=False)["input_ids"]) for text in texts]
    require(max(token_lengths) <= 256, "Semantic evaluator input exceeds the approved LaBSE maximum; truncation is forbidden.")
    batches = []
    for start in range(0, len(texts), 64):
        encoded = tokenizer(texts[start:start + 64], padding=True, truncation=False, return_tensors="np")
        feed = {}
        for item in session.get_inputs():
            if item.name in encoded:
                feed[item.name] = encoded[item.name].astype(np.int64)
            elif item.name == "token_type_ids":
                feed[item.name] = np.zeros_like(encoded["input_ids"], dtype=np.int64)
            else:
                raise RuntimeError(f"Pinned LaBSE model requires unsupported input: {item.name}")
        hidden = session.run(["last_hidden_state"], feed)[0]
        pooled = np.tanh(hidden[:, 0, :] @ dense_weight.T + dense_bias)
        pooled /= np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)
        batches.append(pooled.astype(np.float32))
    return np.concatenate(batches, axis=0), token_lengths


def similarity_findings(candidate_embeddings: Any, source_embeddings: Any, split_indices: dict[str, list[int]], np: Any) -> tuple[int, float, dict[tuple[str, int, int], float]]:
    evaluated = 0
    maximum = -1.0
    findings: dict[tuple[str, int, int], float] = {}
    source_matrix = np.asarray(source_embeddings, dtype=np.float32)
    for start in range(0, len(candidate_embeddings), 16):
        block = np.asarray(candidate_embeddings[start:start + 16], dtype=np.float32)
        scores = block @ source_matrix.T
        evaluated += int(scores.size)
        maximum = max(maximum, float(scores.max()))
        for local_candidate, source_index in np.argwhere(scores >= THRESHOLD):
            key = ("source", start + int(local_candidate), int(source_index))
            findings[key] = round(float(scores[int(local_candidate), int(source_index)]), 8)
    candidate_matrix = np.asarray(candidate_embeddings, dtype=np.float32)
    for left_indices, right_indices in iter_cross_split_pairs(split_indices):
        scores = candidate_matrix[left_indices] @ candidate_matrix[right_indices].T
        evaluated += int(scores.size)
        maximum = max(maximum, float(scores.max()))
        for left_position, right_position in np.argwhere(scores >= THRESHOLD):
            left = int(left_indices[int(left_position)])
            right = int(right_indices[int(right_position)])
            key = ("cross", min(left, right), max(left, right))
            findings[key] = round(float(scores[int(left_position), int(right_position)]), 8)
    return evaluated, round(maximum, 8), findings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("contract-check")
    evaluate = subparsers.add_parser("evaluate")
    evaluate.add_argument("--package-dir", required=True)
    evaluate.add_argument("--source-train", required=True)
    evaluate.add_argument("--source-development", required=True)
    evaluate.add_argument("--source-quality-holdout", required=True)
    evaluate.add_argument("--source-safety-holdout", required=True)
    evaluate.add_argument("--source-blind-suite", required=True)
    evaluate.add_argument("--source-embeddings", required=True)
    evaluate.add_argument("--model-dir", required=True)
    evaluate.add_argument("--governance-amendment", default=str(GOVERNANCE_PATH))
    evaluate.add_argument("--output", required=True)

    prompt_source = subparsers.add_parser("build-prompt-source")
    prompt_source.add_argument("--package-dir", required=True)
    prompt_source.add_argument("--source-train", required=True)
    prompt_source.add_argument("--source-development", required=True)
    prompt_source.add_argument("--source-quality-holdout", required=True)
    prompt_source.add_argument("--source-safety-holdout", required=True)
    prompt_source.add_argument("--source-blind-suite", required=True)
    prompt_source.add_argument("--model-dir", required=True)
    prompt_source.add_argument("--policy", default=str(POLICY_PATH))
    prompt_source.add_argument("--output-dir", required=True)

    prompt_evaluate = subparsers.add_parser("evaluate-prompt")
    prompt_evaluate.add_argument("--package-dir", required=True)
    prompt_evaluate.add_argument("--source-train", required=True)
    prompt_evaluate.add_argument("--source-development", required=True)
    prompt_evaluate.add_argument("--source-quality-holdout", required=True)
    prompt_evaluate.add_argument("--source-safety-holdout", required=True)
    prompt_evaluate.add_argument("--source-blind-suite", required=True)
    prompt_evaluate.add_argument("--prompt-source-dir", required=True)
    prompt_evaluate.add_argument("--historical-report", required=True)
    prompt_evaluate.add_argument("--historical-reconciliation-summary")
    prompt_evaluate.add_argument("--historical-source-embeddings", required=True)
    prompt_evaluate.add_argument("--model-dir", required=True)
    prompt_evaluate.add_argument("--governance-amendment", default=str(GOVERNANCE_PATH))
    prompt_evaluate.add_argument("--policy", default=str(POLICY_PATH))
    prompt_evaluate.add_argument("--output-dir", required=True)
    return parser.parse_args()


def contract_check() -> int:
    governance = read_json(GOVERNANCE_PATH)
    policy = read_json(POLICY_PATH)
    require(governance.get("status") == "active", "v0.5.1 governance amendment is inactive.")
    require(governance.get("bindings", {}).get("historicalCandidateManifestSha256") == CANDIDATE_MANIFEST_SHA256, "Governance candidate binding differs.")
    require(governance.get("controls", {}).get("automatedSemanticReportRequired") is True, "Automated semantic report is not mandatory.")
    require(governance.get("controls", {}).get("semanticThreshold") == THRESHOLD, "Semantic threshold differs.")
    require(all(item.get("status") == "not_required" for item in governance.get("retiredIntermediateGates", [])), "Retired human gates are not explicitly not_required.")
    require(policy.get("status") == "active-prospective", "Prompt-only semantic-separation policy is inactive.")
    require(policy.get("historicalEvidence", {}).get("reportSha256") == HISTORICAL_REPORT_SHA256 and policy.get("historicalEvidence", {}).get("immutable") is True, "Historical full-dialogue evidence is not preserved immutably.")
    require(policy.get("method", {}).get("threshold") == THRESHOLD and policy.get("method", {}).get("immutableRevision") == MODEL_REVISION, "Prompt-only semantic method differs.")
    require(policy.get("blockingRepresentation", {}).get("includedRoles") == ["user"] and policy.get("blockingRepresentation", {}).get("excludedRoles") == ["system", "assistant"], "Prompt-only semantic role scope differs.")
    require(policy.get("fullDialogueDiagnostic", {}).get("blocking") is False and policy.get("fullDialogueDiagnostic", {}).get("historicalFlaggedPairCountMustReconcile") == HISTORICAL_FLAGGED_PAIR_COUNT, "Full-dialogue evidence must be diagnostic and reconciled.")
    require(policy.get("remediation", {}).get("maximumTargetedRounds") == 2 and policy.get("remediation", {}).get("roundSeeds") == {"1": 419852, "2": 419853} and policy.get("remediation", {}).get("thresholdMayBeLowered") is False, "Semantic remediation policy differs.")
    print("SafeRide v0.5.1 prompt-only semantic contract passed.")
    print("Pinned LaBSE, 459600 prompt-only comparisons, threshold 0.92, zero truncation, and exact historical reconciliation are required.")
    return 0


def evaluate(args: argparse.Namespace) -> int:
    package_dir = Path(args.package_dir).expanduser().resolve()
    governance_path = Path(args.governance_amendment).expanduser().resolve()
    model_dir = Path(args.model_dir).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    assert_private_directory(package_dir)
    assert_private_directory(model_dir)
    require(model_dir.name == MODEL_REVISION, "Semantic model directory must be the immutable LaBSE revision snapshot.")
    require(output.is_absolute() and REPO_ROOT not in output.parents and not output.exists(), "Semantic report output must be a new controlled file outside the repository.")
    assert_private_directory(output.parent)

    manifest_path = package_dir / "candidate-manifest.private.json"
    corpus_path = package_dir / "candidates.private.jsonl"
    request_path = package_dir / "semantic-request.private.json"
    for path in (manifest_path, corpus_path, request_path):
        assert_private_file(path)
    require(sha256_file(manifest_path) == CANDIDATE_MANIFEST_SHA256, "Candidate manifest hash differs.")
    manifest = read_json(manifest_path)
    request = read_json(request_path)
    governance = read_json(governance_path)
    require(governance.get("status") == "active" and governance.get("bindings", {}).get("historicalCandidateManifestSha256") == CANDIDATE_MANIFEST_SHA256, "Governance amendment binding differs.")
    require(request.get("candidateManifestSha256") == CANDIDATE_MANIFEST_SHA256 and request.get("candidateCorpusSha256") == sha256_file(corpus_path), "Semantic request candidate binding differs.")

    source_paths = {
        "train": Path(args.source_train).expanduser().resolve(),
        "development": Path(args.source_development).expanduser().resolve(),
        "qualityHoldout": Path(args.source_quality_holdout).expanduser().resolve(),
        "safetyHoldout": Path(args.source_safety_holdout).expanduser().resolve(),
        "blindSuite": Path(args.source_blind_suite).expanduser().resolve(),
    }
    binding_names = {
        "train": "trainSha256",
        "development": "developmentSha256",
        "qualityHoldout": "qualityHoldoutSha256",
        "safetyHoldout": "safetyHoldoutSha256",
        "blindSuite": "blindSuiteSha256",
    }
    source_rows_by_name: dict[str, list[dict[str, Any]]] = {}
    for name, path in source_paths.items():
        assert_private_file(path)
        require(sha256_file(path) == request["sourceBindings"][binding_names[name]], f"{name} semantic source hash differs.")
        rows = read_jsonl(path)
        require(len(rows) == EXPECTED_SOURCE_COUNTS[name], f"{name} semantic source count differs.")
        source_rows_by_name[name] = rows
    source_core_rows = sorted(
        source_rows_by_name["train"] + source_rows_by_name["development"] + source_rows_by_name["qualityHoldout"] + source_rows_by_name["safetyHoldout"],
        key=lambda row: str(row.get("id", "")),
    )
    require(len(source_core_rows) == 2600 and len({str(row.get("id")) for row in source_core_rows}) == 2600, "Approved source semantic row inventory differs.")
    require(hashlib.sha256("\n".join(str(row["id"]) for row in source_core_rows).encode("utf-8")).hexdigest() == SOURCE_ROW_INVENTORY_SHA256, "Approved source embedding row order differs.")

    candidate_rows = read_jsonl(corpus_path)
    require(len(candidate_rows) == 160 and manifest.get("counts", {}).get("rows") == 160, "Candidate semantic row count differs.")
    split_indices = {
        split: [index for index, row in enumerate(candidate_rows) if row.get("split") == split]
        for split in ("train", "mitigation-dev", "mitigation-holdout")
    }
    require({key: len(value) for key, value in split_indices.items()} == {"train": 120, "mitigation-dev": 20, "mitigation-holdout": 20}, "Candidate semantic split counts differ.")

    source_embeddings_path = Path(args.source_embeddings).expanduser().resolve()
    assert_private_file(source_embeddings_path)
    require(sha256_file(source_embeddings_path) == SOURCE_EMBEDDINGS_SHA256, "Approved source embedding bytes differ.")
    model_path = model_dir / "onnx/model.onnx"
    dense_path = model_dir / "2_Dense/model.safetensors"
    require(sha256_file(model_path) == ONNX_SHA256 and sha256_file(dense_path) == DENSE_SHA256, "Pinned LaBSE ONNX or dense bytes differ from the approved method.")
    try:
        import numpy as np  # type: ignore
        import onnxruntime as ort  # type: ignore
        import transformers  # type: ignore
        from safetensors.numpy import load_file  # type: ignore
        from transformers import AutoTokenizer  # type: ignore
    except ModuleNotFoundError as error:
        raise RuntimeError("Pinned semantic runtime dependencies are unavailable.") from error
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, trust_remote_code=False)
    encoded_rows = candidate_rows + source_rows_by_name["blindSuite"]
    texts = [semantic_text(row) for row in encoded_rows]
    token_lengths = [len(tokenizer(text, add_special_tokens=True, truncation=False)["input_ids"]) for text in texts]
    require(max(token_lengths) <= 256, "Semantic evaluator input exceeds the approved LaBSE maximum; truncation is forbidden.")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 8
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    require(session.get_providers() == ["CPUExecutionProvider"], "Semantic evaluator provider differs from the approved deterministic runtime.")
    dense = load_file(str(dense_path))
    dense_weight = dense["linear.weight"].astype(np.float32)
    dense_bias = dense["linear.bias"].astype(np.float32)
    encoded_embeddings = []
    for start in range(0, len(texts), 64):
        encoded = tokenizer(texts[start:start + 64], padding=True, truncation=False, return_tensors="np")
        feed = {}
        for item in session.get_inputs():
            if item.name in encoded:
                feed[item.name] = encoded[item.name].astype(np.int64)
            elif item.name == "token_type_ids":
                feed[item.name] = np.zeros_like(encoded["input_ids"], dtype=np.int64)
            else:
                raise RuntimeError(f"Pinned LaBSE model requires unsupported input: {item.name}")
        hidden = session.run(["last_hidden_state"], feed)[0]
        pooled = np.tanh(hidden[:, 0, :] @ dense_weight.T + dense_bias)
        pooled /= np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)
        encoded_embeddings.append(pooled.astype(np.float32))
    encoded_matrix = np.concatenate(encoded_embeddings, axis=0)
    candidate_embeddings = encoded_matrix[:160]
    blind_embeddings = encoded_matrix[160:]
    source_core_embeddings = np.load(source_embeddings_path, allow_pickle=False)
    require(source_core_embeddings.shape == (2600, 768) and source_core_embeddings.dtype == np.float32, "Approved source embedding matrix shape or dtype differs.")
    source_embeddings = np.concatenate([source_core_embeddings, blind_embeddings], axis=0)
    require(source_embeddings.shape == (2840, 768), "Combined semantic source embedding shape differs.")
    evaluated, maximum, flagged = similarity_statistics(candidate_embeddings, source_embeddings, split_indices, np)
    require(evaluated == 459600, "Semantic comparison count differs.")

    inventory_sha = canonical_sha256(model_inventory(model_dir))
    report = {
        "schema": "com.saferide.ai.v051-mitigation-semantic-report",
        "schemaVersion": 1,
        "datasetId": DATASET_ID,
        "status": "passed" if flagged == 0 and maximum < THRESHOLD else "blocked",
        "requestSha256": sha256_file(request_path),
        "candidateManifestSha256": CANDIDATE_MANIFEST_SHA256,
        "governanceAmendmentSha256": sha256_file(governance_path),
        "method": {
            "modelId": MODEL_ID,
            "immutableRevision": MODEL_REVISION,
            "distanceMetric": "cosine-similarity",
            "implementationSha256": sha256_file(Path(__file__).resolve()),
        },
        "sourceBindings": {**request["sourceBindings"], "sourceEmbeddingsSha256": SOURCE_EMBEDDINGS_SHA256, "modelInventorySha256": inventory_sha},
        "runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "onnxruntime": ort.__version__,
            "transformers": transformers.__version__,
            "providers": session.get_providers(),
        },
        "scope": {key: value for key, value in request["scope"].items() if key != "requiredPairCount"},
        "threshold": THRESHOLD,
        "evaluatedPairCount": evaluated,
        "maximumSimilarity": maximum,
        "flaggedPairCount": flagged,
        "unresolvedPairCount": flagged,
        "maximumInputTokens": max(token_lengths),
        "truncatedInputCount": 0,
        "execution": {
            "mode": "deterministic-controlled-automated-evaluator",
            "humanApprovalRequired": False,
            "protectedInputsOpenedByAuthoringRole": False,
            "protectedInputsOpenedForCandidateSelection": False,
        },
        "intermediateHumanReview": {"status": "not_required", "approvalInferred": False},
        "privacy": {"rawTextIncluded": False, "rowIdentifiersIncluded": False, "contentLogged": False},
    }
    with output.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n")
    output.chmod(0o600)
    print("SafeRide v0.5.1 deterministic semantic evaluation completed.")
    print(f"Pairs: {evaluated}; maximum similarity: {maximum:.8f}; flagged: {flagged}; status: {report['status']}.")
    print(f"Report SHA-256: {sha256_file(output)}; no raw text or row identifiers were printed.")
    return 0 if report["status"] == "passed" else 1


def build_prompt_source(args: argparse.Namespace) -> int:
    package_dir = Path(args.package_dir).expanduser().resolve()
    _, _, request, _ = load_candidate_package(package_dir)
    policy_path = Path(args.policy).expanduser().resolve()
    policy = read_json(policy_path)
    require(policy.get("status") == "active-prospective" and policy.get("method", {}).get("threshold") == THRESHOLD, "Prompt-only semantic policy differs.")
    source_rows_by_name = load_source_rows(args, request)
    source_rows, ordering_sha = ordered_source_rows(source_rows_by_name)
    model_dir = Path(args.model_dir).expanduser().resolve()
    assert_private_directory(model_dir)
    np, _, tokenizer, session, dense_weight, dense_bias, runtime = load_runtime(model_dir)
    embeddings, token_lengths = encode_texts([prompt_only_text(row) for row in source_rows], tokenizer, session, dense_weight, dense_bias, np)
    require(embeddings.shape == (2840, 768) and embeddings.dtype == np.float32, "Prompt-only source embedding matrix shape or dtype differs.")

    output = ensure_new_private_directory(Path(args.output_dir).expanduser().resolve())
    embeddings_path = output / "prompt-source-embeddings.npy"
    with embeddings_path.open("xb") as handle:
        np.save(handle, embeddings, allow_pickle=False)
    embeddings_path.chmod(0o600)
    inventory_sha = canonical_sha256(model_inventory(model_dir))
    manifest = {
        "schema": "com.saferide.ai.v051-prompt-source-embedding-manifest",
        "schemaVersion": 1,
        "status": "complete",
        "datasetId": SOURCE_DATASET_ID,
        "policySha256": sha256_file(policy_path),
        "method": {
            "modelId": MODEL_ID,
            "immutableRevision": MODEL_REVISION,
            "distanceMetric": "cosine-similarity",
            "representation": "normalized-user-turns-only-v1",
            "implementationSha256": sha256_file(Path(__file__).resolve()),
            "modelInventorySha256": inventory_sha,
        },
        "sourceBindings": dict(request["sourceBindings"]),
        "sourceOrdering": {
            "algorithm": "v05-core-global-row-id-ascending-then-blind-prompt-id-ascending",
            "rowCount": 2840,
            "inventorySha256": ordering_sha,
        },
        "runtime": runtime,
        "tokenization": {
            "maximumTokensAllowed": 256,
            "maximumInputTokens": max(token_lengths),
            "truncatedInputCount": 0,
        },
        "embeddings": {
            "fileName": embeddings_path.name,
            "sha256": sha256_file(embeddings_path),
            "sizeBytes": embeddings_path.stat().st_size,
            "shape": [2840, 768],
            "dtype": "float32",
        },
        "privacy": {
            "rawTextIncluded": False,
            "sourceIdentifiersIncluded": False,
            "embeddingsCommittable": False,
            "contentLogged": False,
        },
    }
    manifest_path = output / "prompt-source-embedding-manifest.private.json"
    write_private_json(manifest_path, manifest)
    require({path.name for path in output.iterdir()} == {embeddings_path.name, manifest_path.name}, "Prompt-only source embedding output inventory differs.")
    print("SafeRide v0.5.1 prompt-only source embeddings completed.")
    print(f"Rows: 2840; maximum input tokens: {max(token_lengths)}; truncated: 0.")
    print(f"Embeddings SHA-256: {sha256_file(embeddings_path)}; manifest SHA-256: {sha256_file(manifest_path)}.")
    print("No raw text or source identifiers were printed.")
    return 0


def validate_prompt_source(
    prompt_source_dir: Path,
    policy_path: Path,
    request: dict[str, Any],
    ordering_sha: str,
    model_dir: Path,
    np: Any,
) -> tuple[Any, dict[str, Any], Path]:
    assert_private_directory(prompt_source_dir)
    expected_names = {"prompt-source-embeddings.npy", "prompt-source-embedding-manifest.private.json"}
    require({path.name for path in prompt_source_dir.iterdir()} == expected_names, "Prompt-only source embedding inventory differs.")
    embeddings_path = prompt_source_dir / "prompt-source-embeddings.npy"
    manifest_path = prompt_source_dir / "prompt-source-embedding-manifest.private.json"
    assert_private_file(embeddings_path)
    assert_private_file(manifest_path)
    manifest = read_json(manifest_path)
    require(manifest.get("schema") == "com.saferide.ai.v051-prompt-source-embedding-manifest" and manifest.get("schemaVersion") == 1 and manifest.get("status") == "complete", "Prompt-only source embedding manifest differs.")
    require(manifest.get("policySha256") == sha256_file(policy_path), "Prompt-only source embedding policy binding differs.")
    require(manifest.get("sourceBindings") == request["sourceBindings"], "Prompt-only source file bindings differ.")
    require(manifest.get("sourceOrdering") == {
        "algorithm": "v05-core-global-row-id-ascending-then-blind-prompt-id-ascending",
        "rowCount": 2840,
        "inventorySha256": ordering_sha,
    }, "Prompt-only source ordering binding differs.")
    method = manifest.get("method", {})
    require(method.get("modelId") == MODEL_ID and method.get("immutableRevision") == MODEL_REVISION and method.get("distanceMetric") == "cosine-similarity" and method.get("representation") == "normalized-user-turns-only-v1", "Prompt-only source embedding method differs.")
    require(method.get("implementationSha256") == sha256_file(Path(__file__).resolve()), "Prompt-only source embedding implementation is stale.")
    require(method.get("modelInventorySha256") == canonical_sha256(model_inventory(model_dir)), "Prompt-only source embedding model inventory differs.")
    require(manifest.get("tokenization", {}).get("truncatedInputCount") == 0 and 0 < manifest.get("tokenization", {}).get("maximumInputTokens", 0) <= 256, "Prompt-only source embedding tokenization differs.")
    require(manifest.get("embeddings", {}).get("sha256") == sha256_file(embeddings_path) and manifest.get("embeddings", {}).get("sizeBytes") == embeddings_path.stat().st_size, "Prompt-only source embedding file binding differs.")
    require(manifest.get("privacy") == {"rawTextIncluded": False, "sourceIdentifiersIncluded": False, "embeddingsCommittable": False, "contentLogged": False}, "Prompt-only source embedding privacy declaration differs.")
    embeddings = np.load(embeddings_path, allow_pickle=False)
    require(embeddings.shape == (2840, 768) and embeddings.dtype == np.float32, "Prompt-only source embedding shape or dtype differs.")
    return embeddings, manifest, manifest_path


def remediation_record(row: dict[str, Any], collision_type: str, score: float) -> dict[str, Any]:
    metadata = row.get("metadata", {})
    record = {
        "candidateId": row.get("candidateId"),
        "candidateHash": metadata.get("reviewableContentSha256"),
        "family": metadata.get("scenarioFamilyId"),
        "language": metadata.get("language"),
        "split": row.get("split"),
        "track": metadata.get("track"),
        "collisionType": collision_type,
        "similarityScore": round(float(score), 8),
    }
    require(isinstance(record["candidateId"], str) and isinstance(record["candidateHash"], str) and len(record["candidateHash"]) == 64, "Candidate remediation binding differs.")
    require(record["language"] in {"en", "sw"} and record["split"] in {"train", "mitigation-dev", "mitigation-holdout"}, "Candidate remediation metadata differs.")
    return record


def records_for_finding(candidate_rows: list[dict[str, Any]], key: tuple[str, int, int], collision_type: str, score: float) -> list[dict[str, Any]]:
    candidate_indices = [key[1]] if key[0] == "source" else [key[1], key[2]]
    return [remediation_record(candidate_rows[index], collision_type, score) for index in candidate_indices]


def evaluate_prompt(args: argparse.Namespace) -> int:
    package_dir = Path(args.package_dir).expanduser().resolve()
    candidate_manifest, candidate_rows, request, manifest_sha = load_candidate_package(package_dir)
    split_indices = candidate_split_indices(candidate_rows)
    policy_path = Path(args.policy).expanduser().resolve()
    governance_path = Path(args.governance_amendment).expanduser().resolve()
    policy = read_json(policy_path)
    governance = read_json(governance_path)
    require(policy.get("status") == "active-prospective" and policy.get("historicalEvidence", {}).get("reportSha256") == HISTORICAL_REPORT_SHA256, "Prompt-only semantic policy differs.")
    require(sha256_file(governance_path) == policy.get("bindings", {}).get("governanceAmendmentSha256"), "Prompt-only policy governance binding differs.")
    require(governance.get("status") == "active" and governance.get("controls", {}).get("semanticThreshold") == THRESHOLD, "Governance semantic threshold differs.")
    is_historical_candidate = manifest_sha == CANDIDATE_MANIFEST_SHA256
    if not is_historical_candidate:
        bindings = candidate_manifest.get("bindings", {})
        require(bindings.get("historicalCandidateManifestSha256") == CANDIDATE_MANIFEST_SHA256, "Remediated candidate omits the historical candidate binding.")
        require(isinstance(bindings.get("remediationRound"), int) and bindings["remediationRound"] in {1, 2}, "Remediated candidate round differs.")
    source_rows_by_name = load_source_rows(args, request)
    ordered_rows, ordering_sha = ordered_source_rows(source_rows_by_name)

    model_dir = Path(args.model_dir).expanduser().resolve()
    assert_private_directory(model_dir)
    np, _, tokenizer, session, dense_weight, dense_bias, runtime = load_runtime(model_dir)
    prompt_source, prompt_source_manifest, prompt_source_manifest_path = validate_prompt_source(
        Path(args.prompt_source_dir).expanduser().resolve(), policy_path, request, ordering_sha, model_dir, np
    )

    historical_report_path = Path(args.historical_report).expanduser().resolve()
    historical_embeddings_path = Path(args.historical_source_embeddings).expanduser().resolve()
    assert_private_file(historical_report_path)
    assert_private_file(historical_embeddings_path)
    require(sha256_file(historical_report_path) == HISTORICAL_REPORT_SHA256, "Historical full-dialogue report bytes differ.")
    require(sha256_file(historical_embeddings_path) == SOURCE_EMBEDDINGS_SHA256, "Historical full-dialogue source embedding bytes differ.")
    historical_report = read_json(historical_report_path)
    require(historical_report.get("schema") == "com.saferide.ai.v051-mitigation-semantic-report" and historical_report.get("schemaVersion") == 1 and historical_report.get("status") == "blocked", "Historical full-dialogue report identity differs.")
    require(historical_report.get("evaluatedPairCount") == 459600 and historical_report.get("flaggedPairCount") == HISTORICAL_FLAGGED_PAIR_COUNT and historical_report.get("unresolvedPairCount") == HISTORICAL_FLAGGED_PAIR_COUNT, "Historical full-dialogue report counts differ.")
    require(historical_report.get("maximumSimilarity") == HISTORICAL_MAXIMUM_SIMILARITY and historical_report.get("threshold") == THRESHOLD and historical_report.get("truncatedInputCount") == 0, "Historical full-dialogue report metric differs.")

    candidate_prompt_embeddings, candidate_prompt_lengths = encode_texts(
        [prompt_only_text(row) for row in candidate_rows], tokenizer, session, dense_weight, dense_bias, np
    )
    prompt_evaluated, prompt_maximum, prompt_findings = similarity_findings(candidate_prompt_embeddings, prompt_source, split_indices, np)
    require(prompt_evaluated == 459600, "Prompt-only semantic comparison count differs.")

    blind_rows = ordered_rows[2600:]
    full_rows = candidate_rows + blind_rows
    full_encoded, full_token_lengths = encode_texts(
        [full_dialogue_text(row) for row in full_rows], tokenizer, session, dense_weight, dense_bias, np
    )
    historical_core = np.load(historical_embeddings_path, allow_pickle=False)
    require(historical_core.shape == (2600, 768) and historical_core.dtype == np.float32, "Historical full-dialogue source embedding shape or dtype differs.")
    historical_source = np.concatenate([historical_core, full_encoded[160:]], axis=0)
    full_evaluated, full_maximum, full_findings = similarity_findings(full_encoded[:160], historical_source, split_indices, np)
    require(full_evaluated == historical_report["evaluatedPairCount"], "Historical full-dialogue comparison count did not reproduce.")
    full_keys = set(full_findings)
    prompt_keys = set(prompt_findings)
    assistant_only_keys = full_keys - prompt_keys
    shared_keys = full_keys & prompt_keys
    prompt_only_keys = prompt_keys - full_keys
    historical_reconciliation_summary_sha: str | None = None
    if is_historical_candidate:
        require(full_maximum == historical_report["maximumSimilarity"], "Historical full-dialogue maximum similarity did not reproduce.")
        require(len(full_findings) == historical_report["flaggedPairCount"] == HISTORICAL_FLAGGED_PAIR_COUNT, "Historical full-dialogue findings did not reproduce.")
        require(len(assistant_only_keys) + len(shared_keys) == HISTORICAL_FLAGGED_PAIR_COUNT, "Historical semantic findings did not reconcile.")
        historical_assistant_only = len(assistant_only_keys)
        historical_genuine_prompt = len(shared_keys)
        historical_prompt_only = len(prompt_only_keys)
    else:
        require(args.historical_reconciliation_summary, "Remediated candidates require the immutable pre-remediation reconciliation summary.")
        reconciliation_path = Path(args.historical_reconciliation_summary).expanduser().resolve()
        assert_private_file(reconciliation_path)
        reconciliation = read_json(reconciliation_path)
        historical_reconciliation_summary_sha = sha256_file(reconciliation_path)
        diagnostic = reconciliation.get("diagnosticReconciliation", {})
        require(reconciliation.get("schema") == "com.saferide.ai.v051-prompt-semantic-summary" and reconciliation.get("schemaVersion") == 2 and reconciliation.get("candidateManifestSha256") == CANDIDATE_MANIFEST_SHA256, "Historical prompt-only reconciliation summary identity differs.")
        require(reconciliation.get("historicalEvidence", {}).get("reportSha256") == HISTORICAL_REPORT_SHA256 and diagnostic.get("reproducedFlaggedPairCount") == HISTORICAL_FLAGGED_PAIR_COUNT and diagnostic.get("reconciled") is True, "Historical prompt-only reconciliation summary does not preserve the 31 findings.")
        historical_assistant_only = int(diagnostic.get("assistantResponseSimilarityOnlyCount", -1))
        historical_genuine_prompt = int(diagnostic.get("genuinePromptCollisionWithinHistoricalCount", -1))
        historical_prompt_only = int(diagnostic.get("promptOnlyCollisionCount", -1))
        require(historical_assistant_only + historical_genuine_prompt == HISTORICAL_FLAGGED_PAIR_COUNT and historical_prompt_only >= 0, "Historical prompt-only reconciliation counts differ.")

    remediation_records: list[dict[str, Any]] = []
    for key in sorted(assistant_only_keys):
        remediation_records.extend(records_for_finding(candidate_rows, key, "full-dialogue-assistant-response-diagnostic", full_findings[key]))
    for key in sorted(shared_keys):
        collision_type = "prompt-source-blocking" if key[0] == "source" else "prompt-cross-split-blocking"
        remediation_records.extend(records_for_finding(candidate_rows, key, collision_type, prompt_findings[key]))
    for key in sorted(prompt_only_keys):
        collision_type = "prompt-only-source-blocking" if key[0] == "source" else "prompt-only-cross-split-blocking"
        remediation_records.extend(records_for_finding(candidate_rows, key, collision_type, prompt_findings[key]))
    remediation_records.sort(key=lambda item: (
        item["collisionType"], item["family"], item["language"], item["candidateId"], item["similarityScore"]
    ))
    allowed_remediation_fields = {"candidateId", "candidateHash", "family", "language", "split", "track", "collisionType", "similarityScore"}
    require(all(set(record) == allowed_remediation_fields for record in remediation_records), "Controlled remediation output contains an unapproved field.")

    output = ensure_new_private_directory(Path(args.output_dir).expanduser().resolve())
    remediation_path = output / "prompt-semantic-remediation.private.json"
    write_private_json(remediation_path, remediation_records)
    blocking_candidate_indices = {
        index
        for key in prompt_keys
        for index in ([key[1]] if key[0] == "source" else [key[1], key[2]])
    }
    affected_families = {candidate_rows[index]["metadata"]["scenarioFamilyId"] for index in blocking_candidate_indices}
    status = "passed" if not prompt_findings and prompt_maximum < THRESHOLD else "blocked"
    summary = {
        "schema": "com.saferide.ai.v051-prompt-semantic-summary",
        "schemaVersion": 2,
        "datasetId": DATASET_ID,
        "status": status,
        "policySha256": sha256_file(policy_path),
        "requestSha256": sha256_file(package_dir / "semantic-request.private.json"),
        "candidateManifestSha256": manifest_sha,
        "governanceAmendmentSha256": sha256_file(governance_path),
        "historicalEvidence": {
            "reportSha256": HISTORICAL_REPORT_SHA256,
            "sourceEmbeddingsSha256": SOURCE_EMBEDDINGS_SHA256,
            "representation": "non-system-full-dialogue",
            "status": "blocked",
            "immutable": True,
            "eligibilityUse": "diagnostic-only",
        },
        "method": {
            "modelId": MODEL_ID,
            "immutableRevision": MODEL_REVISION,
            "distanceMetric": "cosine-similarity",
            "representation": "normalized-user-turns-only-v1",
            "normalization": policy["blockingRepresentation"]["normalization"],
            "includedRoles": ["user"],
            "excludedRoles": ["system", "assistant"],
            "implementationSha256": sha256_file(Path(__file__).resolve()),
            "modelInventorySha256": canonical_sha256(model_inventory(model_dir)),
        },
        "sourceBindings": {
            **request["sourceBindings"],
            "promptSourceEmbeddingsSha256": prompt_source_manifest["embeddings"]["sha256"],
            "promptSourceEmbeddingManifestSha256": sha256_file(prompt_source_manifest_path),
            "promptSourceOrderingSha256": ordering_sha,
            "historicalFullDialogueSourceEmbeddingsSha256": SOURCE_EMBEDDINGS_SHA256,
            **({"historicalPromptOnlyReconciliationSummarySha256": historical_reconciliation_summary_sha} if historical_reconciliation_summary_sha else {}),
        },
        "runtime": runtime,
        "scope": {
            "mitigationRows": 160,
            "sourceRows": 2840,
            "sourceComparisonPairs": 454400,
            "newCrossSplitPairs": 5200,
            "evaluatedPairCount": 459600,
        },
        "threshold": THRESHOLD,
        "blockingResult": {
            "representation": "normalized-user-turns-only-v1",
            "maximumSimilarity": prompt_maximum,
            "flaggedPairCount": len(prompt_findings),
            "unresolvedPairCount": len(prompt_findings),
        },
        "diagnosticReconciliation": {
            "representation": "non-system-user-and-assistant-turns",
            "blocking": False,
            "historicalEvaluatedPairCount": historical_report["evaluatedPairCount"],
            "historicalMaximumSimilarity": historical_report["maximumSimilarity"],
            "historicalFlaggedPairCount": HISTORICAL_FLAGGED_PAIR_COUNT,
            "reproducedFlaggedPairCount": HISTORICAL_FLAGGED_PAIR_COUNT,
            "assistantResponseSimilarityOnlyCount": historical_assistant_only,
            "genuinePromptCollisionWithinHistoricalCount": historical_genuine_prompt,
            "promptOnlyCollisionCount": historical_prompt_only,
            "reconciled": True,
        },
        "currentFullDialogueDiagnostic": {
            "representation": "non-system-user-and-assistant-turns",
            "blocking": False,
            "evaluatedPairCount": full_evaluated,
            "maximumSimilarity": full_maximum,
            "flaggedPairCount": len(full_findings),
        },
        "bilingualSiblingControl": {
            "familyCount": 80,
            "sameSplitSiblingPairCount": 80,
            "crossSplitFamilyCount": 0,
            "crossSplitExemptionCount": 0,
        },
        "tokenization": {
            "maximumTokensAllowed": 256,
            "sourcePromptMaximumInputTokens": prompt_source_manifest["tokenization"]["maximumInputTokens"],
            "candidatePromptMaximumInputTokens": max(candidate_prompt_lengths),
            "fullDialogueDiagnosticMaximumInputTokens": max(full_token_lengths),
            "truncatedInputCount": 0,
        },
        "remediation": {
            "fileSha256": sha256_file(remediation_path),
            "recordCount": len(remediation_records),
            "blockingPairCount": len(prompt_findings),
            "diagnosticPairCount": len(assistant_only_keys),
            "affectedFamilyCount": len(affected_families),
            "maximumTargetedRounds": 2,
            "roundsUsed": int(candidate_manifest.get("bindings", {}).get("remediationRound", 0)),
        },
        "execution": {
            "mode": "deterministic-controlled-automated-evaluator",
            "humanApprovalRequired": False,
            "protectedInputsOpenedByAuthoringRole": False,
            "protectedInputsOpenedForCandidateSelection": False,
            "fullDialogueEligibilityUse": "diagnostic-only",
        },
        "intermediateHumanReview": {"status": "not_required", "approvalInferred": False},
        "privacy": {
            "rawTextIncluded": False,
            "protectedSourceIdentifiersIncluded": False,
            "candidateIdentifiersIncluded": False,
            "embeddingsIncluded": False,
            "contentLogged": False,
        },
    }
    summary_path = output / "prompt-semantic-summary.private.json"
    write_private_json(summary_path, summary)
    require({path.name for path in output.iterdir()} == {remediation_path.name, summary_path.name}, "Prompt-only semantic output inventory differs.")
    print("SafeRide v0.5.1 prompt-only semantic evaluation completed.")
    print(f"Prompt-only pairs: {prompt_evaluated}; maximum similarity: {prompt_maximum:.8f}; flagged: {len(prompt_findings)}; status: {status}.")
    print(f"Historical findings reconciled: {HISTORICAL_FLAGGED_PAIR_COUNT}; response-inclusive-only: {historical_assistant_only}; genuine prompt overlap within historical findings: {historical_genuine_prompt}; prompt-only additions: {historical_prompt_only}.")
    print(f"Current full-dialogue diagnostic findings: {len(full_findings)}; blocking use: false.")
    print(f"Summary SHA-256: {sha256_file(summary_path)}; remediation SHA-256: {sha256_file(remediation_path)}.")
    print("No raw text, protected source identifiers, prompts, or embeddings were printed.")
    return 0 if status == "passed" else 1


def main() -> int:
    os.umask(0o077)
    args = parse_args()
    if args.command == "contract-check":
        return contract_check()
    if args.command == "evaluate":
        return evaluate(args)
    if args.command == "build-prompt-source":
        return build_prompt_source(args)
    if args.command == "evaluate-prompt":
        return evaluate_prompt(args)
    fail("Unknown command.")
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - command boundary emits content-free failures only.
        print(str(error).replace("\r", " ").replace("\n", " ")[:800], file=sys.stderr)
        raise SystemExit(1)
