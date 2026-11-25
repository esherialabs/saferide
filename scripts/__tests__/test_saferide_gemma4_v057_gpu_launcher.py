import ast
import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "saferide-gemma4-v057-gpu-launcher.py"
PLAN = SCRIPT.parents[1] / "config/ai/datasets/saferide-gemma4-v057-replacement-pilot-plan.json"
SPEC = importlib.util.spec_from_file_location("saferide_v057_launcher_test", SCRIPT)
assert SPEC and SPEC.loader
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class V057GpuLauncherContractTests(unittest.TestCase):
    def test_only_pilot_and_panel_modes_exist(self):
        self.assertEqual(set(LAUNCHER.RUN_PATTERNS), {"pilot", "panel"})

    def test_idle_and_lock_contract_is_inherited(self):
        self.assertEqual(LAUNCHER.V056.GPU_SAMPLE_COUNT, 16)
        self.assertEqual(LAUNCHER.V056.GPU_SAMPLE_INTERVAL_SECONDS, 2)
        self.assertEqual(LAUNCHER.V056.MINIMUM_FREE_VRAM_MIB, 22000)

    def test_contract_check_passes(self):
        self.assertEqual(LAUNCHER.contract_check(), 0)

    def test_initial_adapter_inventory_matches_the_immutable_loadable_v056_adapter(self):
        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        recipe = plan["recipe"]
        self.assertEqual(recipe["initialAdapterInventorySha256"], LAUNCHER.EXPECTED_INITIAL_ADAPTER_INVENTORY_SHA256)
        self.assertEqual(recipe["initialAdapterFileCount"], LAUNCHER.EXPECTED_INITIAL_ADAPTER_FILE_COUNT)
        self.assertEqual(recipe["initialAdapterTotalBytes"], LAUNCHER.EXPECTED_INITIAL_ADAPTER_SIZE)
        self.assertEqual((recipe["initialAdapterFileCount"], recipe["initialAdapterTotalBytes"]), (6, 80584074))

    def test_host_launcher_parses_as_python_3_8_without_eager_model_imports(self):
        source = SCRIPT.read_text(encoding="utf-8")
        ast.parse(source, filename=SCRIPT.name, feature_version=(3, 8))
        self.assertNotIn("TRAINING = load_module", source)
        self.assertNotIn("PANEL = load_module", source)

    def test_host_image_check_does_not_require_removeprefix(self):
        digest = "a" * 64
        plan = {
            "runtime": {
                "baseModel": {"revision": "revision"},
                "image": {"title": "title", "launcherSourceCommit": "commit"},
            }
        }
        response = json.dumps([{
            "Id": f"sha256:{digest}",
            "Config": {"Labels": {
                "org.opencontainers.image.title": "title",
                "org.opencontainers.image.revision": "commit",
                "com.saferide.base-model-revision": "revision",
                "com.saferide.issue": "ESH-4198",
            }},
        }])
        with mock.patch.object(LAUNCHER.V056, "checked", return_value=response):
            LAUNCHER.inspect_image(plan, digest)

    def test_gpu_monitor_accepts_only_safe_ride_container_descendants(self):
        with mock.patch.object(LAUNCHER, "pid_descends_from", side_effect=lambda pid, ancestor: (pid, ancestor) in {(200, 100), (201, 100)}):
            self.assertTrue(LAUNCHER.gpu_pids_are_container_owned([200, 201], 100))
            self.assertFalse(LAUNCHER.gpu_pids_are_container_owned([200, 999], 100))
            self.assertFalse(LAUNCHER.gpu_pids_are_container_owned([200], None))

    def test_pid_ancestry_accepts_a_real_child_and_rejects_an_unrelated_pid(self):
        import os
        self.assertTrue(LAUNCHER.pid_descends_from(os.getpid(), os.getppid()))
        self.assertFalse(LAUNCHER.pid_descends_from(os.getpid(), 999999999))

    def test_panel_container_runs_one_generation_then_read_only_replay(self):
        args = SimpleNamespace(
            code_root="/controlled/code", panel_input="/controlled/panel",
            model_dir="/controlled/model", adapter_root="/controlled/adapter",
            pilot_metadata="/controlled/pilot/metadata.json",
            output_data_dir="/controlled/output", container_name="sr-v057-panel-a11-contract",
            plan="/controlled/replacement-plan.json",
        )
        plan = {"runtime": {"image": {"runtimeManifestDigest": "b" * 64}}}
        command = LAUNCHER.panel_command(args, plan, "a" * 64)
        shell = command[-1]
        self.assertIn("pilot-panel.py run", shell)
        self.assertIn("--plan /opt/saferide-plan/plan.json", shell)
        self.assertIn("&& exec python scripts/saferide-gemma4-v057-pilot-panel.py verify-output", shell)
        self.assertTrue(any("/controlled/output/panel" in item for item in command))

    def test_exact_artifact_preflight_loads_without_panel_mount_or_generation(self):
        args = SimpleNamespace(
            code_root="/controlled/code", model_dir="/controlled/model",
            adapter_root="/controlled/adapter",
            pilot_metadata="/controlled/pilot/metadata.json",
            output_data_dir="/controlled/output",
            container_name="sr-v057-panel-a11-final-preflight-20260809",
            plan="/controlled/replacement-plan.json",
        )
        plan = {"runtime": {"image": {"runtimeManifestDigest": "b" * 64}}}
        command = LAUNCHER.panel_preflight_command(args, plan, "a" * 64)
        shell = command[-1]
        self.assertIn("pilot-panel.py preflight", shell)
        self.assertNotIn("pilot-panel.py run", shell)
        self.assertNotIn("verify-output", shell)
        self.assertFalse(any("saferide-panel" in item for item in command))
        self.assertTrue(any("/controlled/output/preflight" in item for item in command))

    def test_current_plan_has_consumed_the_final_panel_authorization(self):
        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        authorization = plan["replacementAuthorization"]
        self.assertEqual(plan["status"], LAUNCHER.PANEL_PENDING_STATUS)
        self.assertEqual(authorization["pilotRunsPerformed"], 1)
        self.assertEqual(
            (authorization["panelRunsAuthorized"], authorization["panelRunsPerformed"], authorization["panelRunsRemaining"]),
            (3, 3, 0),
        )
        self.assertIsNone(authorization["panelRunAuthorization"])
        self.assertTrue(plan["scope"]["replacementPanelGenerationPerformed"])
        self.assertTrue(plan["scope"]["panelAuthorizationPending"])
        self.assertTrue(plan["pilotExecution"]["valid"])
        args = SimpleNamespace(
            run_id="saferide-v057-panel-s419805-final-20260809-01",
            authorization_ref="ESH-4198-v057-final-panel-user-20260809-01",
            authorized_at="2026-08-09T08:14:56Z",
        )
        with self.assertRaisesRegex(RuntimeError, "authorization is exhausted"):
            LAUNCHER.verify_panel_run_authorization(plan, args)

    def test_synthetic_future_plan_binds_one_new_authorized_run(self):
        plan = copy.deepcopy(json.loads(PLAN.read_text(encoding="utf-8")))
        args = SimpleNamespace(
            run_id="saferide-v057-panel-s419805-synthetic-future",
            authorization_ref="ESH-4198-v057-synthetic-future-panel",
            authorized_at="2026-08-10T00:00:00+00:00",
        )
        plan["status"] = LAUNCHER.PANEL_AUTHORIZED_STATUS
        plan["strictDecision"] = LAUNCHER.PANEL_AUTHORIZED_DECISION
        authorization = plan["replacementAuthorization"]
        authorization.update({
            "panelRunsAuthorized": 3, "panelRunsPerformed": 2, "panelRunsRemaining": 1,
            "panelRunAuthorization": {
                "runId": args.run_id,
                "referenceSha256": hashlib.sha256(args.authorization_ref.encode("utf-8")).hexdigest(),
                "authorizedAt": args.authorized_at,
            },
        })
        plan["scope"]["panelAuthorizationPending"] = False
        plan["scope"]["replacementPanelGenerationPerformed"] = False
        LAUNCHER.verify_panel_run_authorization(plan, args)
        args.authorization_ref = LAUNCHER.CONSUMED_AUTHORIZATION_REFERENCE
        authorization["panelRunAuthorization"]["referenceSha256"] = hashlib.sha256(
            args.authorization_ref.encode("utf-8")
        ).hexdigest()
        with self.assertRaisesRegex(RuntimeError, "authorization is exhausted"):
            LAUNCHER.verify_panel_run_authorization(plan, args)


if __name__ == "__main__":
    unittest.main()
