from contextlib import closing
import http.client
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from control import ControlServer, Journal
from policy import Policy


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=3)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = str(Path(self.temporary.name) / "control.sock")
        self.config = {"domains": ["acme.test", "*.lab.test"], "ips": ["198.18.0.0/30"], "exclude_domains": ["excluded.lab.test"], "exclude_ips": ["198.18.0.3"]}
        self.journal = Journal(Policy(self.config), self.config, capacity=2)
        self.healthy = True
        self.server = ControlServer(self.path, self.journal, lambda: self.healthy)
        self.addCleanup(self.server.server_close)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def inspect(self, after=None, targets=None, path="/inspect", method="POST", extra=None):
        import json
        with closing(UnixConnection(self.path)) as connection:
            connection.request(method, path, json.dumps({"after": after, "targets": targets or [], **(extra or {})}) if method == "POST" and path == "/inspect" else None)
            response = connection.getresponse()
            body = response.read()
            return response.status, json.loads(body) if response.status == 200 else body

    def test_same_policy_checks_domains_ips_and_exclusions_without_network_io(self):
        for url, allowed in [("https://acme.test/", True), ("https://widgets.test/", False), ("https://acme.test.widgets.test/", False), ("https://app.lab.test/", True), ("https://excluded.lab.test/", False), ("http://198.18.0.2/", True), ("http://198.18.0.3/", False)]:
            status, value = self.inspect(targets=[{"url": url, "method": "GET"}])
            self.assertEqual(status, 200)
            self.assertEqual(value["allowed"], allowed, url)
            self.assertEqual(value["policyHash"], self.journal.policy.digest)

    def test_ring_cursors_expose_loss_and_do_not_reset_on_read(self):
        for index in range(3):
            self.journal.append({"time": "fixture", "event": "denied", "policy": self.journal.policy.digest, "port": index})
        self.assertEqual(self.inspect()[1]["events"], [])
        value = self.inspect(after=0)[1]
        self.assertEqual((value["firstSeq"], value["nextSeq"]), (1, 3))
        self.assertEqual([event["seq"] for event in value["events"]], [1, 2])
        self.assertEqual(self.inspect(after=2)[1]["events"][0]["seq"], 2)
        self.assertEqual(self.inspect(after=4)[0], 400)

    def test_health_is_live_and_no_policy_mutation_endpoint_exists(self):
        self.healthy = False
        self.assertFalse(self.inspect()[1]["healthy"])
        self.assertEqual(self.inspect(path="/policy")[0], 404)
        self.assertEqual(self.inspect(extra={"domains": ["widgets.test"]})[0], 400)
        self.assertEqual(self.inspect(method="PUT")[0], 501)
        self.assertFalse(self.inspect(targets=[{"url": "https://widgets.test", "method": "GET"}])[1]["allowed"])
