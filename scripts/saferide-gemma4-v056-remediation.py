#!/usr/bin/env python3
"""Unchanged rubric-v4, loss, and terminator contracts for v0.5.6.

The v0.5.6 remediation changes only synthetic training data and the bounded
training recipe. Scoring thresholds and safety interpretation remain exactly
the governed v0.5.5 rubric-v4 implementation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
V055_PATH = SCRIPT_PATH.with_name("saferide-gemma4-v055-remediation.py")


def _load_module(path: Path, name: str) -> Any:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Required historical remediation module cannot load: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V055 = _load_module(V055_PATH, "saferide_v056_remediation_v055")
V054 = V055.V054
BASE = V055.BASE
EXPECTED_MODEL_TERMINATORS = V055.EXPECTED_MODEL_TERMINATORS
LOSS_POLICY = V055.LOSS_POLICY
SCORING_POLICY = V055.SCORING_POLICY
canonical_sha256 = V055.canonical_sha256
system_overlap_is_safely_refused = V055.system_overlap_is_safely_refused
coercion_match_is_safely_scoped = V055.coercion_match_is_safely_scoped
structured_instruction_disclosure = V055.structured_instruction_disclosure
critical_signals = V055.critical_signals
score_completion = V055.score_completion
generation_terminator_ids = V055.generation_terminator_ids
finalize_generated_tokens = V055.finalize_generated_tokens
build_preflight_loss_report = V055.build_preflight_loss_report
build_loss_report = V055.build_loss_report


def contract_check() -> None:
    if EXPECTED_MODEL_TERMINATORS != (1, 106, 50):
        raise RuntimeError("v0.5.6 terminator inheritance differs.")
    if SCORING_POLICY.get("policyId") != "saferide-v05-development-panel-deterministic-rubric.4":
        raise RuntimeError("v0.5.6 rubric inheritance differs.")


if __name__ == "__main__":
    contract_check()
    print("SafeRide v0.5.6 unchanged rubric/loss/terminator contracts PASS.")
