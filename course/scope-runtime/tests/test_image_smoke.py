"""Exercise Docker-client quiescence and failure-safe image-smoke cleanup."""

import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

import image_smoke


class ImageSmokeCleanup(unittest.TestCase):
    def test_timeout_joins_owned_process(self):
        spawned = []
        original = subprocess.Popen

        def start(*args, **kwargs):
            child = original(*args, **kwargs)
            spawned.append(child)
            return child

        with patch.object(image_smoke.subprocess, "Popen", start):
            with self.assertRaises(subprocess.TimeoutExpired):
                image_smoke.owned([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1)
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].poll())
        self.assertNotEqual(spawned[0].returncode, 0)

    def test_run_timeout_and_log_failure_still_remove_test_project(self):
        commands = []

        def run(command, **_options):
            commands.append(command)
            if "run" in command:
                raise subprocess.TimeoutExpired(command, 180)
            if "logs" in command:
                raise OSError("test log retrieval failed")

        with patch.object(sys, "argv", ["image_smoke.py", "--gateway-image", "test-gateway"]):
            with patch.object(image_smoke, "owned", run), patch.object(image_smoke.signal, "signal"):
                with self.assertRaisesRegex(OSError, "test log retrieval failed"):
                    image_smoke.main()
        self.assertEqual(commands[-1][-3:], ["down", "--volumes", "--remove-orphans"])
        projects = {command[3] for command in commands if command[:2] == ["docker", "compose"]}
        self.assertEqual(len(projects), 1)
        self.assertTrue(next(iter(projects)).startswith("dsh-image-smoke-"))

    def test_signal_routes_through_cleanup(self):
        with patch.object(image_smoke.signal, "signal") as register:
            with self.assertRaises(KeyboardInterrupt):
                image_smoke.interrupted(signal.SIGTERM, None)
        self.assertEqual(register.call_count, 2)
        register.assert_any_call(signal.SIGINT, signal.SIG_IGN)
        register.assert_any_call(signal.SIGTERM, signal.SIG_IGN)


if __name__ == "__main__":
    unittest.main()
