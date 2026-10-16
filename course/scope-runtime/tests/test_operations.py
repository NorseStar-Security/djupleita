"""Operation policy and gateway admission checks use private, observed upstreams."""

from contextlib import closing
from copy import deepcopy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import socket
import ssl
import tempfile
import threading
import unittest

from certificates import Certificates
from operations import OperationPolicy, RequestBudget, canonical_method, canonical_path
from policy import Policy, ScopeDenied, destination
from proxy import GatewayServer


def operation_config():
    return {
        "requireMediatedHttp": True,
        "deny": [
            {"id": "shared-service-shutdown", "methods": ["*"], "paths": [], "prefixes": ["/quitquitquit"]},
            {"id": "admin", "methods": ["*"], "paths": [], "prefixes": ["/admin"]},
            {"id": "write-only", "methods": ["POST"], "paths": ["/destroy"], "prefixes": []},
        ],
        "budget": {"maxRequests": 10000, "windowSeconds": 60, "maxConcurrent": 8},
    }


class OperationPolicyTests(unittest.TestCase):
    def test_default_policy_requires_mediation_and_denies_shutdown(self):
        config = json.loads((Path(__file__).resolve().parents[1] / "scope.json").read_text())
        policy = Policy(config)
        policy.authorize(destination("https://example.test/research?q=shutdown"), "GET")
        for method in ("GET", "POST", "DELETE", "CUSTOM-METHOD", "get"):
            for path in ("/quitquitquit", "/quitquitquit/", "/quitquitquit/subpath", "/%71uitquitquit?confirm=1"):
                with self.subTest(method=method, path=path), self.assertRaises(ScopeDenied):
                    policy.authorize(destination("https://example.test" + path), method)

    def test_paths_decode_once_and_ignore_query_for_operation_matching(self):
        for value, expected in (("/", "/"), ("/normal/", "/normal"), ("/%61dmin", "/admin"), ("/search?q=%2F%25%00", "/search"), ("/caf%C3%A9", "/café")):
            with self.subTest(value=value):
                self.assertEqual(canonical_path(value), expected)
        for value in ("/a//b", "/a/../admin", "/a/%2e%2E/admin", "/./admin", "/%2fadmin", "/%2Fadmin", "/%5cadmin", "/%25%36%31dmin", "/%3fadmin", "/%23admin", "/%00admin", "/%C0%AFadmin", "/%FF", "/%", "/%2", "/%zz", "/admin;ignored", "/admin%3bignored", "/admin%20", "/admin%0a", "admin", "/a\\b"):
            with self.subTest(value=value), self.assertRaises((ValueError, UnicodeError)):
                canonical_path(value)

    def test_rules_match_exact_paths_segment_prefixes_and_method_casing(self):
        policy = OperationPolicy(operation_config(), False)
        for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND", "CUSTOM-METHOD", "post"):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, "admin"):
                policy.authorize("/%61dmin/tools?mode=read", method)
        for method in ("POST", "post", "pOsT"):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, "write-only"):
                policy.authorize("/destroy", method)
        for path, method in (("/normal", "POST"), ("/administrator", "DELETE"), ("/administer", "CUSTOM-METHOD"), ("/destroy", "GET"), ("/destroy/child", "POST")):
            policy.authorize(path, method)
        root = operation_config()
        root["deny"] = [{"id": "root-tree", "methods": ["*"], "paths": [], "prefixes": ["/"]}]
        for path in ("/", "/ordinary", "/deep/path"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "root-tree"):
                OperationPolicy(root, False).authorize(path, "GET")

    def test_method_tokens_keep_extension_methods_available(self):
        for method in ("GET", "get", "M-SEARCH", "CUSTOM2", "X!METHOD"):
            self.assertEqual(canonical_method(method), method.upper())
        for method in (None, "", "GET POST", "GET\n", "GET/POST", "méthod"):
            with self.subTest(method=method), self.assertRaises(ValueError):
                canonical_method(method)

    def test_raw_ip_grants_cannot_bypass_required_mediation(self):
        for address in ("192.0.2.1", "192.0.2.0/24", "2001:db8::/32"):
            with self.subTest(address=address), self.assertRaisesRegex(ValueError, "remove raw IP grants"):
                Policy({"domains": ["lab.test"], "ips": [address], "operations": operation_config()})
        policy = Policy({"domains": ["lab.test"], "domain_addresses": {"lab.test": ["192.0.2.1"]}, "operations": operation_config()})
        self.assertEqual(policy.resolve("lab.test", 443), ("192.0.2.1",))
        self.assertFalse(policy.ip_allowed("192.0.2.1"))
        unmediated = operation_config()
        unmediated["requireMediatedHttp"] = False
        self.assertTrue(Policy({"ips": ["192.0.2.1"], "operations": unmediated}).ip_allowed("192.0.2.1"))

    def test_infrastructure_permissions_win_target_domain_overlap(self):
        policy = Policy({"domains": ["*.lab.test"], "operations": operation_config(), "infrastructure": {"api.lab.test": {"methods": ["GET"], "paths": ["/v1/query"]}}})
        for path in ("/v1/query", "/v1/query?secret=not-logged"):
            policy.authorize(destination("https://api.lab.test" + path), "GET")
        for path, method in (("/", "GET"), ("/v1/query", "POST"), ("/v1/query/child", "GET"), ("/v1/query/", "GET"), ("/v1/%71uery", "GET"), ("/admin", "GET")):
            with self.subTest(path=path, method=method), self.assertRaises(ScopeDenied):
                policy.authorize(destination("https://api.lab.test" + path), method)

    def test_noncanonical_infrastructure_paths_fail_at_startup(self):
        for path in ("/v1/", "/v1//query", "/v1/../query", "/%71uery", "/query;extra", "/query?x=1", "/query#x"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                Policy({"domains": ["lab.test"], "infrastructure": {"api.lab.test": {"methods": ["GET"], "paths": [path]}}})

    def test_invalid_operation_configuration_fails_at_startup(self):
        invalid = [None, {}, {**operation_config(), "extra": True}]
        for key, values in (("requireMediatedHttp", (None, 0, "true")), ("deny", (None, {}, "deny")), ("budget", ({}, {"maxRequests": True, "windowSeconds": 1, "maxConcurrent": 1}, {"maxRequests": 1, "windowSeconds": 0, "maxConcurrent": 1}, {"maxRequests": 1, "windowSeconds": 1, "maxConcurrent": 1000001}))):
            invalid.extend({**operation_config(), key: value} for value in values)
        base_rule = operation_config()["deny"][0]
        for field, values in (("id", ("", "contains space", None)), ("methods", ([], ["post"], ["GET POST"], "GET")), ("paths", (["/a/../b"], ["/a/"], ["/a?x=1"], [None])), ("prefixes", (["/%61dmin"], ["/a#x"], "/admin"))):
            invalid.extend({**operation_config(), "deny": [{**base_rule, field: value}]} for value in values)
        invalid.extend(({**operation_config(), "deny": [base_rule, deepcopy(base_rule)]}, {**operation_config(), "deny": [{**base_rule, "paths": [], "prefixes": []}]}))
        for config in invalid:
            with self.subTest(config=config), self.assertRaises((ValueError, UnicodeError)):
                OperationPolicy(config, False)

    def test_validated_rules_do_not_retain_mutable_input(self):
        config = operation_config()
        policy = OperationPolicy(config, False)
        config["deny"][0]["prefixes"].clear()
        config["budget"]["maxConcurrent"] = 999
        with self.assertRaisesRegex(ValueError, "shared-service-shutdown"):
            policy.authorize("/quitquitquit", "GET")
        self.assertEqual(policy.budget["maxConcurrent"], 8)


class RequestBudgetTests(unittest.TestCase):
    def test_rate_window_uses_injected_monotonic_clock(self):
        now = [100.0]
        budget = RequestBudget({"maxRequests": 2, "windowSeconds": 10, "maxConcurrent": 1}, lambda: now[0])
        for _ in range(2):
            budget.acquire()
            budget.release()
        for timestamp in (100.0, 109.999):
            now[0] = timestamp
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                budget.acquire()
        now[0] = 110.0
        budget.acquire()
        budget.release()
        self.assertEqual(len(budget.starts), 1)

    def test_concurrency_denial_does_not_consume_rate_admission(self):
        budget = RequestBudget({"maxRequests": 2, "windowSeconds": 60, "maxConcurrent": 1})
        budget.acquire()
        with self.assertRaises(ValueError):
            budget.acquire()
        budget.release()
        budget.acquire()
        budget.release()
        with self.assertRaises(ValueError):
            budget.acquire()
        with self.assertRaisesRegex(ValueError, "without admission"):
            budget.release()
        self.assertEqual(budget.active, 0)

    def test_concurrent_threads_atomically_share_one_budget(self):
        budget = RequestBudget({"maxRequests": 100, "windowSeconds": 60, "maxConcurrent": 3})
        start, admitted = threading.Barrier(13), threading.Barrier(13)
        release = threading.Event()
        outcomes, errors = queue.Queue(), queue.Queue()

        def compete():
            acquired = False
            try:
                start.wait(10)
                try:
                    budget.acquire()
                    acquired = True
                except ValueError:
                    pass
                outcomes.put(acquired)
                admitted.wait(10)
                if acquired and not release.wait(10):
                    raise AssertionError("budget fixture release did not arrive")
            except BaseException as error:
                errors.put(error)
            finally:
                if acquired:
                    budget.release()

        threads = [threading.Thread(target=compete) for _ in range(12)]
        try:
            for thread in threads:
                thread.start()
            start.wait(10)
            admitted.wait(10)
            self.assertEqual(sum(outcomes.get_nowait() for _ in range(12)), 3)
            self.assertEqual(budget.active, 3)
        finally:
            release.set()
            for thread in threads:
                thread.join(10)
                self.assertFalse(thread.is_alive(), "budget contender did not stop")
        self.assertTrue(errors.empty(), list(errors.queue))
        self.assertEqual(budget.active, 0)


class ObservedServer(ThreadingHTTPServer):
    tls = None

    def __init__(self, *args):
        self.lock = threading.Lock()
        self.connections, self.calls = 0, []
        self.holding, self.release = threading.Event(), threading.Event()
        super().__init__(*args)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        with self.lock:
            self.connections += 1
        if self.tls is not None:
            try:
                connection = self.tls.wrap_socket(connection, server_side=True)
            except BaseException:
                connection.close()
                raise
        return connection, address

    def counters(self):
        with self.lock:
            return self.connections, len(self.calls)


class ObservedBackend(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.respond
        raise AttributeError(name)

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with self.server.lock:
            self.server.calls.append((self.command, self.path, body))
        if self.path == "/hold":
            self.server.holding.set()
            if not self.server.release.wait(10):
                raise AssertionError("held backend was not released")
        if self.path == "/close":
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        self.send_response(200)
        self.send_header("Content-Length", "7")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b"allowed")


class ObservedBudget(RequestBudget):
    def __init__(self, config):
        self.admitted = threading.Event()
        self.released = threading.Event()
        super().__init__(config)

    def acquire(self):
        super().acquire()
        self.admitted.set()

    def release(self):
        super().release()
        self.released.set()


class OperationProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.servers, cls.threads = [], []
        cls.addClassCleanup(cls.close_servers)
        cls.certificates = Certificates(Path(cls.temporary.name) / "private", Path(cls.temporary.name) / "public")
        for name in ("backend", "tls_backend", "forbidden"):
            server = ObservedServer(("127.0.0.1", 0), ObservedBackend)
            cls.servers.append(server)
            setattr(cls, name, server)
        cls.tls_backend.tls = cls.certificates.context("acme.test")
        infrastructure_tls = cls.certificates.context("api.lab.test")

        def select_certificate(connection, name, _context):
            if name == "api.lab.test":
                connection.context = infrastructure_tls

        cls.tls_backend.tls.set_servername_callback(select_certificate)
        cls.policy = Policy({"domains": ["acme.test", "*.lab.test"], "operations": operation_config(), "infrastructure": {"api.lab.test": {"methods": ["GET"], "paths": ["/v1/query"]}}, "domain_addresses": {name: ["127.0.0.1"] for name in ("acme.test", "api.lab.test", "widgets.test")}, "ports": {"http": [cls.backend.server_port, cls.forbidden.server_port], "https": [cls.tls_backend.server_port]}})
        cls.events = []
        cls.proxy = GatewayServer(("127.0.0.1", 0), cls.policy, cls.certificates, lambda event, **data: cls.events.append({"event": event, **data}), timeout=10, max_body=64)
        cls.proxy.daemon_threads = False
        cls.servers.append(cls.proxy)
        cls.tls_context = ssl.create_default_context(cafile=str(cls.certificates.ca))
        for server in cls.servers:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def close_servers(cls):
        for server in cls.servers:
            if isinstance(server, ObservedServer):
                server.release.set()
        for server, _thread in zip(cls.servers, cls.threads):
            server.shutdown()
        for server in cls.servers:
            server.server_close()
        for thread in cls.threads:
            thread.join(10)
            if thread.is_alive():
                raise AssertionError("operation fixture did not stop")

    def request(self, path="/", method="GET", tls=False, name="acme.test", body=None, headers=None, forbidden=False):
        port = self.tls_backend.server_port if tls else (self.forbidden.server_port if forbidden else self.backend.server_port)
        if tls:
            connection = http.client.HTTPSConnection("127.0.0.1", self.proxy.server_port, context=self.tls_context, timeout=15)
            connection.set_tunnel(name, port)
            target = path
        else:
            connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=15)
            target = f"http://{name}:{port}{path}"
        with closing(connection):
            connection.request(method, target, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read()

    def install_budget(self, requests=10000, concurrency=8):
        previous = self.proxy.budget
        budget = ObservedBudget({"maxRequests": requests, "windowSeconds": 60, "maxConcurrent": concurrency})
        self.proxy.budget = budget
        self.addCleanup(setattr, self.proxy, "budget", previous)
        return budget

    def test_ordinary_requests_and_extensions_still_reach_in_scope(self):
        for tls in (False, True):
            server = self.tls_backend if tls else self.backend
            before = server.counters()
            for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND", "CUSTOM-METHOD"):
                with self.subTest(tls=tls, method=method):
                    self.assertEqual(self.request("/research?mode=normal", method, tls)[0], 200)
            self.assertEqual(server.counters(), (before[0] + 10, before[1] + 10))

    def test_forbidden_admin_paths_all_methods_never_connect_upstream(self):
        paths = ("/admin", "/admin/", "/admin/config?confirm=1", "/%61dmin", "/ad%6din", "/quitquitquit", "/%71uitquitquit/", "/a/../admin", "/a/%2e%2E/admin", "/admin%2fconfig", "/admin%2Fconfig", "/admin%5cconfig", "/%2561dmin", "/admin;ignored", "/admin%3bignored", "/admin%00", "/admin%3fignored", "/admin//config", "/%FF", "/%zz")
        for tls in (False, True):
            server = self.tls_backend if tls else self.backend
            before = server.counters()
            for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND", "CUSTOM-METHOD", "get", "CONNECT"):
                for path in paths:
                    with self.subTest(tls=tls, method=method, path=path):
                        self.assertEqual(self.request(path, method, tls)[0], 403)
            self.assertEqual(server.counters(), before)

    def test_outside_destination_stays_denied_despite_claimed_allow(self):
        before = self.forbidden.counters()
        self.assertEqual(self.request(name="widgets.test", forbidden=True, headers={"X-Scope-Decision": "allow", "X-Action-Review": "allow"})[0], 403)
        self.assertEqual(self.forbidden.counters(), before)
        self.assertFalse(self.policy.ip_allowed("127.0.0.1"))
        self.assertEqual(self.request(name="127.0.0.1", forbidden=True)[0], 403)
        self.assertEqual(self.forbidden.counters(), before)
        tls_before = self.tls_backend.counters()
        with self.assertRaisesRegex(OSError, "403"):
            self.request(tls=True, name="widgets.test", headers={"X-Scope-Decision": "allow"})
        self.assertEqual(self.tls_backend.counters(), tls_before)

    def test_infrastructure_target_overlap_keeps_exact_allowlist(self):
        for tls in (False, True):
            server = self.tls_backend if tls else self.backend
            self.assertEqual(self.request("/v1/query?secret=private", tls=tls, name="api.lab.test")[0], 200)
            before = server.counters()
            for path, method in (("/", "GET"), ("/v1/query", "POST"), ("/v1/query/child", "GET"), ("/v1/query/", "GET"), ("/v1/%71uery", "GET"), ("/admin", "GET")):
                with self.subTest(tls=tls, path=path, method=method):
                    self.assertEqual(self.request(path, method, tls, name="api.lab.test")[0], 403)
            self.assertEqual(server.counters(), before)
        self.assertNotIn("private", str(self.events))

    def test_body_bytes_are_bounded_not_semantically_certified(self):
        # The gateway cannot infer server-side SSRF or safe actions from an allowed body.
        payload = b"url=http://widgets.test/&operation=delete"
        self.assertEqual(self.request("/research", "POST", body=payload)[0], 200)
        self.assertEqual(self.backend.calls[-1][2], payload)
        for tls in (False, True):
            server = self.tls_backend if tls else self.backend
            before = server.counters()
            budget = self.install_budget()
            self.assertEqual(self.request("/research", "POST", tls, headers={"Content-Length": "65"})[0], 403)
            self.assertTrue(budget.released.wait(10), "denied body retained admission")
            self.assertEqual(server.counters(), before)

    def test_uploaded_oversized_body_closes_or_returns_denial_without_upstream_effect(self):
        for tls in (False, True):
            server = self.tls_backend if tls else self.backend
            before = server.counters()
            events_before = len(self.events)
            budget = self.install_budget()
            try:
                result = self.request("/research", "POST", tls, body=b"x" * 65)
            except (ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
                # Unread uploaded bytes can prevent a complete HTTP denial before TLS closes.
                outcome = type(error).__name__
            else:
                self.assertEqual(result[0], 403)
                outcome = "HTTP 403"
            self.assertTrue(budget.released.wait(10), "uploaded denied body retained admission")
            self.assertEqual(server.counters(), before)
            self.assertTrue(any(event.get("event") == "denied" and event.get("reason") == "request body exceeds gateway limit" for event in self.events[events_before:]), f"Missing explicit denial audit after {outcome}")

    def test_counter_oracle_observes_fixture_only_operation_regression(self):
        previous = self.proxy.policy
        self.proxy.policy = Policy({"domains": ["acme.test"], "domain_addresses": {"acme.test": ["127.0.0.1"]}, "ports": {scheme: list(ports) for scheme, ports in previous.ports.items()}})
        before = self.backend.counters()
        try:
            self.assertEqual(self.request("/admin")[0], 200)
            self.assertEqual(self.backend.counters(), (before[0] + 1, before[1] + 1))
        finally:
            self.proxy.policy = previous

    def test_admission_also_bounds_waiting_request_body_readers(self):
        budget = self.install_budget(concurrency=1)
        before = self.backend.counters()
        with closing(socket.create_connection(("127.0.0.1", self.proxy.server_port), timeout=10)) as client:
            authority = f"acme.test:{self.backend.server_port}"
            client.sendall(f"POST http://{authority}/research HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 4\r\n\r\n".encode())
            try:
                self.assertTrue(budget.admitted.wait(10), "body reader did not acquire admission")
                self.assertEqual(self.backend.counters(), before)
                tls_before = self.tls_backend.counters()
                self.assertEqual(self.request(tls=True)[0], 403)
                self.assertEqual(self.tls_backend.counters(), tls_before)
                client.sendall(b"data")
                with closing(http.client.HTTPResponse(client)) as response:
                    response.begin()
                    self.assertEqual((response.status, response.read()), (200, b"allowed"))
            finally:
                client.close()
        self.assertTrue(budget.released.wait(10), "body reader retained admission")

    def test_rate_limit_is_shared_across_hosts_and_tls_and_denies_before_connect(self):
        budget = self.install_budget(requests=2)
        self.assertEqual(self.request()[0], 200)
        self.assertTrue(budget.released.wait(10))
        budget.released.clear()
        self.assertEqual(self.request("/v1/query", tls=True, name="api.lab.test")[0], 200)
        self.assertTrue(budget.released.wait(10))
        before = self.backend.counters()
        self.assertEqual(self.request()[0], 403)
        self.assertEqual(self.backend.counters(), before)
        self.assertEqual(budget.active, 0)

    def test_denied_destination_and_path_do_not_spend_request_budget(self):
        budget = self.install_budget(requests=1)
        self.assertEqual(self.request("/admin")[0], 403)
        self.assertEqual(self.request(name="widgets.test", forbidden=True)[0], 403)
        self.assertEqual(self.request()[0], 200)
        self.assertTrue(budget.released.wait(10))
        self.assertEqual(self.request()[0], 403)

    def test_concurrent_budget_is_held_until_upstream_settles_then_released(self):
        budget = self.install_budget(concurrency=1)
        self.backend.holding.clear()
        self.backend.release.clear()
        result = queue.Queue()

        def held_request():
            try:
                result.put(self.request("/hold"))
            except BaseException as error:
                result.put(error)

        thread = threading.Thread(target=held_request)
        thread.start()
        try:
            self.assertTrue(self.backend.holding.wait(10), "upstream did not reach hold point")
            before = self.tls_backend.counters()
            self.assertEqual(self.request(tls=True)[0], 403)
            self.assertEqual(self.tls_backend.counters(), before)
            self.assertEqual(budget.active, 1)
        finally:
            self.backend.release.set()
            thread.join(15)
            self.assertFalse(thread.is_alive(), "held client did not stop")
        self.assertEqual(result.get_nowait(), (200, b"allowed"))
        self.assertTrue(budget.released.wait(10))
        self.assertEqual(budget.active, 0)
        self.assertEqual(self.request(tls=True)[0], 200)

    def test_upstream_failure_releases_admission(self):
        budget = self.install_budget(concurrency=1)
        self.assertEqual(self.request("/close")[0], 502)
        self.assertTrue(budget.released.wait(10), "failed upstream retained admission")
        self.assertEqual(budget.active, 0)
        self.assertEqual(self.request()[0], 200)


if __name__ == "__main__":
    unittest.main()
