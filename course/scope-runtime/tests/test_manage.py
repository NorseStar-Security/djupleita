"""Native lifecycle order, immutable revisions, and generated confinement."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from manage import Manager
from action_review import digest as review_digest


class RuntimeManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        # Configuration is generated without reading source files; use a distinct
        # instructor checkout identity in both the repository and packed gateway.
        self.manager = Manager(self.temporary.name, Path(self.temporary.name) / "instructor-checkout", "colima-dsh-course")
        self.request = {"revision": 1, "publicUrl": "http://127.0.0.1:3080/runtimes/course/", "reconEnabled": True, "config": {
            "policy": {"domains": ["example.test"], "operations": json.loads((Path(__file__).resolve().parents[1] / "scope.json").read_text())["operations"]},
            "provider": {"socketPath": "/run/course-public/control.sock"}, "guard": {}, "recon": {}, "forwardOpenAIKey": False,
            "actionReview": json.loads((Path(__file__).resolve().parents[1] / "review.json").read_text())},
            "features": {"bundles": [], "patches": [], "credentials": {"version": 1, "refs": {}, "records": {}}, "trajectories": True,
                         "reviewCredentials": {"OPENAI_API_KEY": "private-review-fixture"}}}
        self.request["config"]["actionReview"]["evaluators"][0]["model"] = "fixture-model"

    def test_generation_has_no_host_mount_or_secret_copy(self):
        with patch.object(self.manager, "run", return_value="") as run:
            digest = self.manager.configuration(self.request)
        value = json.loads(self.manager.compose_file.read_text())
        research = value["services"]["research"]
        self.assertEqual(research["user"], "1000:1000")
        self.assertEqual(research["network_mode"], "service:gateway")
        self.assertEqual(research["cap_drop"], ["ALL"])
        self.assertTrue(research["read_only"])
        self.assertEqual(research["environment"]["OPENAI_API_KEY"], "")
        self.assertNotIn("docker.sock", json.dumps(value))
        self.assertNotIn(str(self.manager.source), json.dumps(value))
        self.assertIn("127.0.0.1::3082", value["services"]["gateway"]["ports"])
        self.assertEqual(value["services"]["gateway"]["dns"], ["127.0.0.1"])
        self.assertEqual(value["services"]["gateway"]["network_mode"], "bridge")
        self.assertEqual(research["environment"]["NARB_NATIVE_CACHE_DIR"], "/home/course/.cache/dsh-native")
        self.assertEqual(len(digest), 64)
        payload = json.loads(run.call_args_list[-1].kwargs["data"])
        self.assertIn("nameserver 127.0.0.1", payload["resolv.conf"])
        self.assertIn('"role": "research"', payload["profile.patch.yml"])
        permission = next(row for row in json.loads(payload["profile.patch.yml"]) if row.get("id") == "permission")
        self.assertEqual(permission["config"]["presets"]["protected"]["approval"], "ask")
        self.assertNotIn("private-review-fixture", json.dumps(payload))
        self.assertNotIn("reviewCredentials", payload["native.json"])
        self.assertNotIn("review-audit:/var/lib/course-review", research["volumes"])
        self.assertFalse(any(":/etc/course/review" in mount for mount in research["volumes"]))
        self.assertIn("review-audit:/var/lib/course-review", value["services"]["gateway"]["volumes"])
        private = [json.loads(call.kwargs["data"]) for call in run.call_args_list if "data" in call.kwargs and "credentials.json" in call.kwargs["data"]]
        self.assertEqual(len(private), 1)
        self.assertIn("private-review-fixture", private[0]["credentials.json"])
        insert = next(row["insert"] for row in json.loads(payload["profile.patch.yml"]) if "insert" in row)
        self.assertTrue(any(row["id"] == "course-action-review-guard" for row in insert))

    def test_imports_only_supplied_model_credentials_and_selected_bundles(self):
        self.request["features"].update({"bundles": ["@deepseek-ai/dsh-experimental-auto-review"],
            "patches": [{"id": "llm-pi-ai", "config": {"providers": {"openai": {"apiKeyEnv": "MODEL_KEY"}}}}],
            "credentials": {"version": 1, "refs": {"MODEL_KEY": "fixture-only"}, "records": {}}, "trajectories": True})
        with patch.object(self.manager, "run", return_value="") as run:
            self.manager.configuration(self.request)
        payload = json.loads(run.call_args_list[-1].kwargs["data"])
        self.assertEqual(json.loads(payload["native.json"]), {name: value for name, value in self.request["features"].items() if name != "reviewCredentials"})
        self.assertIn("@deepseek-ai/dsh-experimental-auto-review", json.loads(payload["bundles.json"]))
        rows = next(row["insert"] for row in json.loads(payload["profile.patch.yml"]) if "insert" in row)
        viewer = next(row for row in rows if row["id"] == "course-trajectory-viewer")
        # A file entry retains package-root browser metadata; package subpaths deliberately do not.
        self.assertEqual(viewer["name"], "/opt/dsh/packages/experimental/trajectory-viewer/lib/native-management.js")
        self.assertNotIn("fixture-only", self.manager.compose_file.read_text())
        self.assertNotIn("fixture-only", json.dumps([path.read_text() for path in (self.manager.root / "revisions").rglob("*.json")]))

    def test_snapshot_cannot_change_under_the_same_revision(self):
        with patch.object(self.manager, "run", return_value=""):
            self.manager.configuration(self.request)
            self.request["config"]["policy"]["domains"] = ["other.test"]
            with self.assertRaisesRegex(RuntimeError, "immutable"):
                self.manager.configuration(self.request)

    def test_apply_validates_before_stopping_and_checks_policy_before_research(self):
        operations = []
        self.request["config"]["policy"] = {"domains": []}
        with patch.object(self.manager, "stop", side_effect=lambda: operations.append("stop")):
            with self.assertRaises(ValueError):
                self.manager.apply(self.request)
        self.assertEqual(operations, [])
        self.request["config"]["policy"]["domains"] = ["example.test"]
        self.request["config"]["policy"]["operations"] = json.loads((Path(__file__).resolve().parents[1] / "scope.json").read_text())["operations"]
        with patch.object(self.manager, "stop", side_effect=lambda: operations.append("stop")), patch.object(self.manager, "configuration", return_value="expected"), patch.object(self.manager, "compose", side_effect=lambda *args, **_: operations.append(args) or "gateway"), patch.object(self.manager, "run", return_value='{"policy":"wrong"}'):
            with self.assertRaisesRegex(RuntimeError, "hash"):
                self.manager.apply(self.request)
        self.assertEqual(operations[0], "stop")
        self.assertFalse(any(isinstance(row, tuple) and row[-1] == "research" for row in operations))

    def test_apply_rejects_missing_review_collection_or_mediation_before_stop(self):
        import copy
        for change in ("model", "key", "collector", "operations", "review"):
            request = copy.deepcopy(self.request)
            if change == "model":
                request["config"]["actionReview"]["evaluators"][0]["model"] = ""
            elif change == "key":
                request["features"]["reviewCredentials"] = {}
            elif change == "collector":
                request["features"]["trajectories"] = False
            elif change == "operations":
                del request["config"]["policy"]["operations"]
            else:
                del request["config"]["actionReview"]
            with patch.object(self.manager, "stop") as stop:
                with self.assertRaises(ValueError):
                    self.manager.apply(request)
                stop.assert_not_called()

    def test_wrong_or_absent_review_hash_never_starts_research(self):
        from policy import Policy
        expected = Policy(self.request["config"]["policy"]).digest
        for ready in ({"policy": expected}, {"policy": expected, "actionReviewReady": True, "reviewHash": "wrong"}):
            operations = []
            with patch.object(self.manager, "stop"), patch.object(self.manager, "configuration", return_value=expected), patch.object(self.manager, "compose", side_effect=lambda *args, **_: operations.append(args) or "gateway"), patch.object(self.manager, "run", return_value=json.dumps(ready)):
                with self.assertRaisesRegex(RuntimeError, "review"):
                    self.manager.apply(self.request)
            self.assertFalse(any(row[-1] == "research" for row in operations))

    def test_archive_lease_renewal_uses_privileged_gateway_exec_not_worker_input(self):
        self.manager.report("running", healthy=True, actionReviewReady=False)
        deployment = {"revision": 1, "policyHash": "a" * 64, "reviewHash": "b" * 64}
        state = {"phase": "running", "healthy": True, "appliedRevision": 1, "policyHash": deployment["policyHash"], "reviewHash": deployment["reviewHash"]}
        with patch.object(self.manager, "status", return_value=state), patch.object(self.manager, "compose", return_value="gateway-fixture"), patch.object(self.manager, "run", return_value="") as run:
            self.manager.archive_ready(deployment)
        self.assertEqual(run.call_args.args[0][:4], ["exec", "gateway-fixture", "python3", "-c"])
        self.assertIn("/run/course-private/archive-until", run.call_args.args[0][4])
        self.assertTrue(json.loads((self.manager.root / "status.json").read_text())["actionReviewReady"])

    def test_old_native_collection_cannot_renew_a_new_deployment(self):
        state = {"phase": "running", "healthy": True, "appliedRevision": 2, "policyHash": "a" * 64, "reviewHash": "b" * 64}
        current = {"revision": 2, "policyHash": "a" * 64, "reviewHash": "b" * 64}
        for change in ({"revision": 1}, {"policyHash": "c" * 64}, {"reviewHash": "d" * 64}, {"revision": True}):
            with self.subTest(change=change), patch.object(self.manager, "status", return_value=state), patch.object(self.manager, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "different isolated deployment"):
                    self.manager.archive_ready({**current, **change})
                run.assert_not_called()

    def test_stop_orders_research_before_gateway_without_removing_data(self):
        self.manager.compose_file.write_text("{}")
        with patch.object(self.manager, "compose") as compose:
            self.manager.stop()
        commands = [call.args for call in compose.call_args_list]
        self.assertEqual(commands[:2], [("stop", "--timeout", "15", "research"), ("stop", "--timeout", "5", "gateway")])
        self.assertNotIn("--volumes", json.dumps(commands))
        self.assertEqual(self.manager.status()["phase"], "stopped")
