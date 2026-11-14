#!/usr/bin/env python3
"""Frozen rubric-v4 and runtime contracts for the one v0.5.7 continuation."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
V056_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v056-remediation.py")


def _load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required historical remediation module cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V056 = _load_module(V056_PATH, "saferide_v057_remediation_v056")
V055 = V056.V055
V054 = V056.V054
BASE = V056.BASE
EXPECTED_MODEL_TERMINATORS = V056.EXPECTED_MODEL_TERMINATORS
LOSS_POLICY = V056.LOSS_POLICY
SCORING_POLICY = V056.SCORING_POLICY
canonical_sha256 = V056.canonical_sha256
system_overlap_is_safely_refused = V056.system_overlap_is_safely_refused
coercion_match_is_safely_scoped = V056.coercion_match_is_safely_scoped
structured_instruction_disclosure = V056.structured_instruction_disclosure
critical_signals = V056.critical_signals
score_completion = V056.score_completion
generation_terminator_ids = V056.generation_terminator_ids
finalize_generated_tokens = V056.finalize_generated_tokens
build_preflight_loss_report = V056.build_preflight_loss_report
build_loss_report = V056.build_loss_report


def contract_check() -> None:
    if EXPECTED_MODEL_TERMINATORS != (1, 106, 50):
        raise RuntimeError("v0.5.7 terminator inheritance differs.")
    if SCORING_POLICY.get("policyId") != "saferide-v05-development-panel-deterministic-rubric.4":
        raise RuntimeError("v0.5.7 rubric inheritance differs.")
    if SCORING_POLICY is not V056.SCORING_POLICY:
        raise RuntimeError("v0.5.7 attempted to replace the frozen scorer.")


if __name__ == "__main__":
    contract_check()
    print("SafeRide v0.5.7 unchanged rubric/loss/terminator contracts PASS.")
