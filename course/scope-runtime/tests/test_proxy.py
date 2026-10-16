from contextlib import closing
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import tempfile
import threading
import unittest

from certificates import Certificates
from policy import Policy
from proxy import GatewayServer


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.server.calls += 1
        self.send_response(200)
        self.send_header("Content-Length", "7")
        self.end_headers()
        self.wfile.write(b"allowed")

    def do_POST(self):
        self.server.body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.do_GET()


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.servers, cls.threads = [], []
        cls.addClassCleanup(cls.close_servers)
        cls.certificates = Certificates(Path(cls.temporary.name) / "private", Path(cls.temporary.name) / "public")
        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        cls.servers.append(cls.backend)
        cls.backend.calls = 0
        cls.backend.body = None
        cls.forbidden = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        cls.servers.append(cls.forbidden)
        cls.forbidden.calls = 0
        cls.tls_backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        cls.servers.append(cls.tls_backend)
        cls.tls_backend.calls = 0
        cls.tls_backend.socket = cls.certificates.context("acme.test").wrap_socket(cls.tls_backend.socket, server_side=True)
        cls.policy = Policy({"domains": ["acme.test"], "domain_addresses": {"acme.test": ["127.0.0.1"], "widgets.test": ["127.0.0.1"]}, "ports": {"http": [cls.backend.server_port, cls.forbidden.server_port], "https": [cls.tls_backend.server_port]}})
        cls.events = []
        cls.proxy = GatewayServer(("127.0.0.1", 0), cls.policy, cls.certificates, lambda event, **data: cls.events.append({"event": event, **data}))
        cls.servers.append(cls.proxy)
        for server in cls.servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def close_servers(cls):
        for server, _thread in zip(cls.servers, cls.threads):
            server.shutdown()
        for server in cls.servers:
            server.server_close()
        for thread in cls.threads:
            thread.join(timeout=5)
            if thread.is_alive():
                raise AssertionError("test HTTP server did not stop")

    def request(self, name="acme.test", path="/", headers=None, method="GET", body=None, port=None):
        with closing(http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=3)) as connection:
            connection.request(method, f"http://{name}:{port or self.backend.server_port}{path}", headers=headers or {}, body=body)
            response = connection.getresponse()
            return response.status, response.read()

    def test_allowed_traffic_reaches_real_server(self):
        before = self.backend.calls
        self.assertEqual(self.request(), (200, b"allowed"))
        self.assertEqual(self.backend.calls, before + 1)

    def test_forbidden_server_receives_zero_requests(self):
        self.assertEqual(self.request("widgets.test", port=self.forbidden.server_port)[0], 403)
        self.assertEqual(self.forbidden.calls, 0)

    def test_host_override_and_domain_lookalikes_are_blocked(self):
        before = self.backend.calls
        self.assertEqual(self.request(headers={"Host": f"widgets.test:{self.backend.server_port}"})[0], 403)
        self.assertEqual(self.request("acme.test.widgets.test")[0], 403)
        self.assertEqual(self.backend.calls, before)

    def test_https_is_inspected_not_opaque_connect(self):
        context = ssl.create_default_context(cafile=str(self.certificates.ca))
        with closing(http.client.HTTPSConnection("127.0.0.1", self.proxy.server_port, context=context, timeout=3)) as connection:
            connection.set_tunnel("acme.test", self.tls_backend.server_port)
            connection.request("GET", "/")
            response = connection.getresponse()
            self.assertEqual((response.status, response.read()), (200, b"allowed"))
        before = self.tls_backend.calls
        with closing(http.client.HTTPSConnection("127.0.0.1", self.proxy.server_port, context=context, timeout=3)) as connection:
            connection.set_tunnel("acme.test", self.tls_backend.server_port)
            connection.request("GET", "/", headers={"Host": f"widgets.test:{self.tls_backend.server_port}"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
        self.assertEqual(self.tls_backend.calls, before)

    def test_ordinary_post_and_chunked_body_work(self):
        self.assertEqual(self.request(method="POST", body=b"research payload")[0], 200)
        self.assertEqual(self.backend.body, b"research payload")
        with closing(http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=3)) as connection:
            connection.request("POST", f"http://acme.test:{self.backend.server_port}/", body=iter([b"chunk one", b"chunk two"]), encode_chunked=True)
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            response.read()
        self.assertEqual(self.backend.body, b"chunk onechunk two")

    def test_audit_does_not_record_query_secrets(self):
        self.request(path="/?token=do-not-log")
        self.assertNotIn("do-not-log", str(self.events))


if __name__ == "__main__":
    unittest.main()
