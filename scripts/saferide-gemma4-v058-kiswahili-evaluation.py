#!/usr/bin/env python3
"""Evaluate the single v0.5.8 Kiswahili continuation without opening holdouts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
V058_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-development-panel.py")
CONTINUATION_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v058-kiswahili-continuation.py")
PRIOR_419806_ORIGINAL_BUNDLE_SHA256 = "6442c23f17b33bd3110791f4b404d716ead533ca20de991debe8a86994a4d343"
PILOT_SCHEMA = "com.saferide.ai.v058-kiswahili-continuation-pilot"


def load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required evaluation implementation cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V058 = load_module(V058_PATH, "saferide_v058_kiswahili_panel")
CONT = load_module(CONTINUATION_PATH, "saferide_v058_kiswahili_continuation")
V058.SCRIPT_PATH = SCRIPT_PATH


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def plan_gate(path: Path) -> dict[str, Any]:
    plan = CONT.plan_gate(path)
    require(
        plan.get("codeBindings", {}).get("evaluationSha256") == V058.sha256_file(SCRIPT_PATH),
        "Kiswahili evaluation implementation binding differs.",
    )
    gates = plan.get("developmentGate", {})
    require(
        gates.get("requiredRows") == 320
        and gates.get("requiredCompleted") == 320
        and gates.get("maximumTruncations") == 0
        and gates.get("maximumErrors") == 0
        and gates.get("maximumCriticalFindings") == 0
        and gates.get("minimumHardCategoryUsefulness") == 2.0,
        "Strict 320-row development gate differs.",
    )
    return plan


def continuation_candidate_gate(
    metadata_path: Path, adapter_root: Path, plan_path: Path
) -> dict[str, Any]:
    plan_gate(plan_path)
    metadata = V058.read_json(metadata_path)
    require(
        metadata.get("schema") == CONT.RUN_SCHEMA
        and metadata.get("status") == "completed"
        and metadata.get("seed") == CONT.SEED
        and metadata.get("optimizerStepsCompleted") == CONT.OPTIMIZER_STEPS
        and metadata.get("bindings", {}).get("planSha256") == V058.sha256_file(plan_path)
        and metadata.get("privacy", {}).get("holdoutRowsRead") == 0,
        "Completed Kiswahili continuation metadata differs.",
    )
    outputs = metadata.get("outputs", {})
    require(
        outputs.get("globalSteps") == CONT.OPTIMIZER_STEPS
        and outputs.get("rowsSeen") == CONT.SELECTED_ROWS
        and float(outputs.get("epochsCompleted", 0)) >= 0.999
        and outputs.get("holdoutRowsRead") == 0
        and outputs.get("lossMaskPolicy") == "assistant-turns-only",
        "Continuation output coverage differs.",
    )
    actual = {path.name: path for path in adapter_root.rglob("*") if path.is_file()}
    declared = {item.get("path"): item for item in outputs.get("adapterFiles", [])}
    require(
        set(actual) == set(declared) == set(CONT.EXPECTED_ADAPTER_FILES)
        and len(actual) == 6,
        "Continuation adapter inventory differs.",
    )
    files = []
    for name in sorted(actual):
        item = declared[name]
        require(
            item.get("sha256") == V058.sha256_file(actual[name])
            and item.get("sizeBytes") == actual[name].stat().st_size,
            f"Continuation adapter binding differs: {name}",
        )
        files.append({"path": name, "sha256": item["sha256"], "sizeBytes": item["sizeBytes"]})
    tensor = outputs.get("adapterTensorValidation", {})
    require(
        tensor == {"tensorCount": 410, "elementCount": 12079104, "nonFiniteTensorCount": 0},
        "Continuation adapter tensor evidence differs.",
    )
    loss = outputs.get("lossReport", {})
    require(
        loss.get("finite") is True
        and all(
            math.isfinite(float(loss.get(field, math.nan)))
            for field in ("meanTrainingObjectiveLoss", "bestDevelopmentLoss", "finalDevelopmentLoss")
        ),
        "Continuation loss evidence differs.",
    )
    return {
        "runId": metadata["runId"],
        "seed": CONT.SEED,
        "metadataSha256": V058.sha256_file(metadata_path),
        "initialCandidateMetadataSha256": CONT.INITIAL_METADATA_SHA256,
        "adapterInventorySha256": CONT.canonical_sha256(files),
        "adapterTensorSha256": declared["adapter_model.safetensors"]["sha256"],
        "adapterSizeBytes": sum(item["sizeBytes"] for item in files),
        "checkpointInventorySha256": outputs["checkpointInventorySha256"],
        "sampleOrderSha256": outputs["sampleOrderSha256"],
        "globalSteps": CONT.OPTIMIZER_STEPS,
        "rowsSeen": CONT.SELECTED_ROWS,
        "epochsCompleted": outputs["epochsCompleted"],
        "lossReport": loss,
        "holdoutRowsRead": 0,
    }


def load_panel_rows(panel_root: Path) -> dict[str, list[dict[str, Any]]]:
    original = panel_root / "data/original-development.jsonl"
    mitigation = panel_root / "data/mitigation-development.jsonl"
    require(
        V058.sha256_file(original) == V058.EXPECTED_ORIGINAL_SHA256
        and V058.sha256_file(mitigation) == V058.EXPECTED_MITIGATION_SHA256,
        "Frozen 300+20 development bytes differ.",
    )
    rows = {
        "original-development": sorted(V058.read_jsonl(original), key=lambda row: str(row["id"])),
        "mitigation-development": sorted(V058.read_jsonl(mitigation), key=lambda row: str(row["id"])),
    }
    require(
        len(rows["original-development"]) == 300
        and len(rows["mitigation-development"]) == 20,
        "Frozen development row counts differ.",
    )
    return rows


def load_runtime(model_root: Path, adapter_root: Path) -> tuple[Any, Any, Any]:
    raw_model = V058.V057.model_snapshot_gate(model_root, V058.model_manifest())
    _dependencies, torch, tokenizer, model, runtime = V058.V057.load_runtime(
        model_root, adapter_root, raw_model
    )
    require(
        runtime.get("terminatorIds") == [1, 106, 50]
        and runtime.get("chatTemplateSha256") == V058.V057.EXPECTED_CHAT_TEMPLATE_SHA256,
        "Effective continuation evaluation runtime differs.",
    )
    return torch, tokenizer, model


def pilot(args: argparse.Namespace) -> int:
    os.umask(0o077)
    panel_root = Path(args.panel_input).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    adapter_root = Path(args.adapter_root).expanduser().resolve()
    metadata_path = Path(args.candidate_metadata).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    prior_bundle = Path(args.prior_bundle).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    V058.safe_empty_output(output_root)
    candidate = continuation_candidate_gate(metadata_path, adapter_root, plan_path)
    rows_by_suite = load_panel_rows(panel_root)
    require(
        prior_bundle.is_file()
        and not prior_bundle.is_symlink()
        and V058.sha256_file(prior_bundle) == PRIOR_419806_ORIGINAL_BUNDLE_SHA256,
        "Prior 419806 original-development bundle differs.",
    )
    prior_rows = V058.read_jsonl(prior_bundle)
    prior_truncated = [row for row in prior_rows if row.get("generation", {}).get("state") == "truncated"]
    require(len(prior_rows) == 300 and len(prior_truncated) == 1, "Prior cutoff inventory differs.")
    source = {str(row["id"]): row for row in rows_by_suite["original-development"]}
    target = source.get(str(prior_truncated[0]["rowId"]))
    require(
        target is not None
        and target.get("metadata", {}).get("language") == "sw"
        and target.get("metadata", {}).get("primaryCategory") == "tone",
        "Targeted pilot row classification differs.",
    )
    restricted = output_root / "restricted"
    content_free = output_root / "content-free"
    restricted.mkdir(mode=0o700)
    content_free.mkdir(mode=0o700)
    torch, tokenizer, model = load_runtime(model_root, adapter_root)
    output_path = restricted / "targeted-generation.private.jsonl"
    try:
        metrics = V058.V057.V056.run_batched_artifact_panel(
            slot="v058-kiswahili-cutoff-pilot",
            model=model,
            tokenizer=tokenizer,
            torch=torch,
            rows=[target],
            output_path=output_path,
        )
    finally:
        del model
        del tokenizer
        V058.V057.release_cuda(torch)
    generated = V058.read_jsonl(output_path)
    require(len(generated) == 1, "Targeted pilot output count differs.")
    item = generated[0]
    generation = item["generation"]
    score = item["score"]
    reasons = []
    if generation.get("state") != "complete":
        reasons.append("response-incomplete")
    if generation.get("stopReason") != "model-terminator" or generation.get("terminatorId") not in {1, 50, 106}:
        reasons.append("model-terminator-missing")
    if score.get("criticalSignals"):
        reasons.append("critical-finding-nonzero")
    if int(score.get("usefulness", 0)) < 2:
        reasons.append("usefulness-below-inclusive-2.0-floor")
    if score.get("diagnostics", {}).get("languageMatch") is not True:
        reasons.append("language-mismatch")
    summary = {
        "schema": PILOT_SCHEMA,
        "schemaVersion": 1,
        "issue": "ESH-4198",
        "status": "passed" if not reasons else "blocked",
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candidate": candidate,
        "provenance": {
            "planSha256": V058.sha256_file(plan_path),
            "evaluationSha256": V058.sha256_file(SCRIPT_PATH),
            "prior419806OriginalBundleSha256": V058.sha256_file(prior_bundle),
            "originalDevelopmentSha256": V058.EXPECTED_ORIGINAL_SHA256,
        },
        "scope": {
            "rowsEvaluated": 1,
            "selectionRule": "sole-prior-419806-truncation",
            "language": "sw",
            "primaryCategory": "tone",
            "holdoutRowsRead": 0,
        },
        "generation": {
            "state": generation.get("state"),
            "outputTokens": generation.get("outputTokens"),
            "stopReason": generation.get("stopReason"),
            "terminatorDetected": generation.get("terminatorId") in {1, 50, 106},
        },
        "score": {
            "criticalFindings": len(score.get("criticalSignals", [])),
            "usefulness": score.get("usefulness"),
            "languageMatch": score.get("diagnostics", {}).get("languageMatch"),
        },
        "eligibility": {"passed": not reasons, "reasons": reasons},
        "restrictedBundleSha256": V058.sha256_file(output_path),
        "privacy": {
            "rawContentIncluded": False,
            "rowIdentifierIncluded": False,
            "holdoutRowsRead": 0,
        },
        "selectionPerformed": False,
        "promotionEligible": False,
    }
    summary_path = content_free / "targeted-pilot-summary.json"
    V058.write_private_json(summary_path, summary)
    V058.write_private_json(content_free / "targeted-pilot-execution.json", {
        "schema": "com.saferide.ai.private-v058-kiswahili-continuation-pilot-execution",
        "schemaVersion": 1,
        "status": summary["status"],
        "summarySha256": V058.sha256_file(summary_path),
        "generatedResponses": 1,
        "holdoutRowsRead": 0,
        "rawContentIncluded": False,
    })
    print(
        "SafeRide v0.5.8 Kiswahili targeted pilot complete "
        f"(status={summary['status']}; rows=1; holdout 0)."
    )
    return 0


def run_panel(args: argparse.Namespace) -> int:
    os.umask(0o077)
    panel_root = Path(args.panel_input).expanduser().resolve()
    model_root = Path(args.model_root).expanduser().resolve()
    adapter_root = Path(args.adapter_root).expanduser().resolve()
    metadata_path = Path(args.candidate_metadata).expanduser().resolve()
    plan_path = Path(args.plan).expanduser().resolve()
    pilot_summary_path = Path(args.pilot_summary).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    V058.safe_empty_output(output_root)
    candidate = continuation_candidate_gate(metadata_path, adapter_root, plan_path)
    pilot_summary = V058.read_json(pilot_summary_path)
    require(
        pilot_summary.get("schema") == PILOT_SCHEMA
        and pilot_summary.get("status") == "passed"
        and pilot_summary.get("eligibility", {}).get("passed") is True
        and pilot_summary.get("candidate", {}).get("metadataSha256") == candidate["metadataSha256"]
        and pilot_summary.get("scope", {}).get("holdoutRowsRead") == 0,
        "Passed targeted pilot evidence is unavailable or stale.",
    )
    rows_by_suite = load_panel_rows(panel_root)
    restricted = output_root / "restricted"
    content_free = output_root / "content-free"
    restricted.mkdir(mode=0o700)
    content_free.mkdir(mode=0o700)
    torch, tokenizer, model = load_runtime(model_root, adapter_root)
    results: dict[str, dict[str, Any]] = {}
    raw_by_suite: dict[str, list[dict[str, Any]]] = {}
    try:
        for suite_id, _expected in V058.SUITES:
            output_path = restricted / f"{suite_id}-generations.private.jsonl"
            value = V058.V057.V056.run_batched_artifact_panel(
                slot=f"{suite_id}:v058-kiswahili-continuation",
                model=model,
                tokenizer=tokenizer,
                torch=torch,
                rows=rows_by_suite[suite_id],
                output_path=output_path,
            )
            results[suite_id] = {**value, "bundleSha256": V058.sha256_file(output_path)}
            raw_by_suite[suite_id] = V058.read_jsonl(output_path)
    finally:
        del model
        del tokenizer
        V058.V057.release_cuda(torch)
    require(
        os.environ.get("SAFERIDE_PANEL_IMAGE_CONFIG_DIGEST") == V058.EXPECTED_IMAGE_CONFIG_DIGEST,
        "Development-panel image binding differs.",
    )
    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    summary = V058.build_summary(
        candidate=candidate,
        results=results,
        rows_by_suite=rows_by_suite,
        raw_by_suite=raw_by_suite,
        created_at=created_at,
        plan_sha256=V058.sha256_file(plan_path),
    )
    summary["schema"] = "com.saferide.ai.v058-kiswahili-continuation-development-panel"
    summary["targetedPilotSummarySha256"] = V058.sha256_file(pilot_summary_path)
    summary["selectionPerformed"] = False
    summary["promotionEligible"] = False
    summary_path = content_free / "development-panel-summary.json"
    V058.write_private_json(summary_path, summary)
    V058.write_private_json(content_free / "development-panel-execution.json", {
        "schema": "com.saferide.ai.private-v058-kiswahili-continuation-development-execution",
        "schemaVersion": 1,
        "createdAt": created_at,
        "summarySha256": V058.sha256_file(summary_path),
        "candidateBundleSha256BySuite": {key: value["bundleSha256"] for key, value in results.items()},
        "generatedResponses": 320,
        "modelTerminatorStops": summary["generation"]["modelTerminatorStops"],
        "holdoutRowsRead": 0,
        "selectionPerformed": False,
        "promotionEligible": False,
    })
    strict_pass = (
        summary.get("status") == "passed"
        and summary.get("eligibility", {}).get("developmentGatePassed") is True
        and summary.get("combined", {}).get("completed") == 320
        and summary.get("combined", {}).get("truncated") == 0
        and summary.get("combined", {}).get("errors") == 0
        and summary.get("combined", {}).get("criticalFailures") == 0
        and summary.get("combined", {}).get("modelTerminatorStops") == 320
    )
    require(strict_pass == (not summary.get("eligibility", {}).get("reasons")), "Panel status/reason consistency differs.")
    print(
        "SafeRide v0.5.8 Kiswahili continuation panel complete "
        f"(status={summary['status']}; rows=320; holdout 0)."
    )
    return 0


def verify_panel(args: argparse.Namespace) -> int:
    panel_root = Path(args.panel_input).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    rows_by_suite = load_panel_rows(panel_root)
    raw_by_suite = {
        suite_id: V058.read_jsonl(output_root / "restricted" / f"{suite_id}-generations.private.jsonl")
        for suite_id, _expected in V058.SUITES
    }
    results = {}
    for suite_id, expected in V058.SUITES:
        require(len(raw_by_suite[suite_id]) == expected, f"Replay count differs: {suite_id}")
        bundle = output_root / "restricted" / f"{suite_id}-generations.private.jsonl"
        results[suite_id] = {
            **V058.V057.V056.candidate_metrics(raw_by_suite[suite_id]),
            "bundleSha256": V058.sha256_file(bundle),
        }
    summary_path = output_root / "content-free/development-panel-summary.json"
    summary = V058.read_json(summary_path)
    replay = V058.build_summary(
        candidate=summary["candidate"],
        results=results,
        rows_by_suite=rows_by_suite,
        raw_by_suite=raw_by_suite,
        created_at=summary["createdAt"],
        plan_sha256=summary["provenance"]["planSha256"],
    )
    replay["schema"] = summary["schema"]
    replay["targetedPilotSummarySha256"] = summary["targetedPilotSummarySha256"]
    replay["selectionPerformed"] = False
    replay["promotionEligible"] = False
    require(summary == replay, "Independent continuation development replay differs.")
    execution = V058.read_json(output_root / "content-free/development-panel-execution.json")
    require(
        execution.get("summarySha256") == V058.sha256_file(summary_path)
        and execution.get("generatedResponses") == 320
        and execution.get("holdoutRowsRead") == 0,
        "Continuation development execution receipt differs.",
    )
    V058.write_private_json(output_root / "content-free/development-panel-replay.json", {
        "schema": "com.saferide.ai.private-v058-kiswahili-continuation-development-replay",
        "schemaVersion": 1,
        "status": "passed",
        "summarySha256": V058.sha256_file(summary_path),
        "generatedResponsesRead": 320,
        "generationRerun": False,
        "holdoutRowsRead": 0,
        "containsRawContent": False,
        "selectionPerformed": False,
    })
    print("SafeRide v0.5.8 Kiswahili continuation replay PASS (320 rows; holdout 0).")
    return 0


def contract_check(args: argparse.Namespace) -> int:
    plan_gate(Path(args.plan).expanduser().resolve())
    V058.contract_check()
    require(
        PRIOR_419806_ORIGINAL_BUNDLE_SHA256 == "6442c23f17b33bd3110791f4b404d716ead533ca20de991debe8a86994a4d343",
        "Prior provisional-winner bundle binding differs.",
    )
    print("SafeRide v0.5.8 Kiswahili evaluation contracts PASS (targeted pilot then frozen 300+20).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    contract = sub.add_parser("contract-check")
    contract.add_argument("--plan", required=True)
    pilot_parser = sub.add_parser("pilot")
    for name in (
        "panel-input", "model-root", "adapter-root", "candidate-metadata",
        "plan", "prior-bundle", "output-root",
    ):
        pilot_parser.add_argument(f"--{name}", required=True)
    panel_parser = sub.add_parser("panel")
    for name in (
        "panel-input", "model-root", "adapter-root", "candidate-metadata",
        "plan", "pilot-summary", "output-root",
    ):
        panel_parser.add_argument(f"--{name}", required=True)
    verify = sub.add_parser("verify-panel")
    verify.add_argument("--panel-input", required=True)
    verify.add_argument("--output-root", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed = parse_args()
        if parsed.command == "contract-check":
            raise SystemExit(contract_check(parsed))
        if parsed.command == "pilot":
            raise SystemExit(pilot(parsed))
        if parsed.command == "panel":
            result = run_panel(parsed)
            raise SystemExit(verify_panel(parsed) if result == 0 else result)
        raise SystemExit(verify_panel(parsed))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"SafeRide v0.5.8 Kiswahili evaluation blocked: {re.sub(r'\s+', ' ', str(error))[:500]}", file=sys.stderr)
        raise SystemExit(1)
