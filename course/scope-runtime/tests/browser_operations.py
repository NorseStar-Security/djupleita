"""Run real Chromium operation checks in one disposable offline research image."""

import argparse
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import uuid


PATHS = (
    "/quitquitquit", "/quitquitquit/", "/quitquitquit?confirm=1", "/quitquitquit/subpath",
    "/%71uitquitquit", "/qu%69tquitquit", "/safe/../quitquitquit", "/safe/%2e%2e/quitquitquit",
    "/quitquitquit%2fchild", "/quitquitquit%5cchild", "/quitquitquit;ignored",
    "/quitquitquit%3bignored", "/%2571uitquitquit",
)
BODY = b'<!doctype html><link rel="icon" href="data:,"><p>ordinary research capability</p>'


def owned(command, *, data=None, timeout):
    """Join the exact child even after a timeout, signal, or assertion failure."""
    timed_out = False
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        try:
            stdout, stderr = child.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            stdout, stderr = child.communicate()
        except BaseException:
            child.kill()
            child.communicate()
            raise
        outcome = {"timedOut": timed_out, "signal": -child.returncode if child.returncode < 0 else None, "exitCode": child.returncode}
        assert not timed_out, (command[0], outcome)
        assert len(stdout) + len(stderr) <= 1024 * 1024, "fixture output exceeded its budget"
        assert child.returncode == 0, (command[0], outcome, stderr.decode(errors="replace"), stdout.decode(errors="replace"))
        return stdout, stderr


class ObservedServer(ThreadingHTTPServer):
    """Count accepted TCP sockets before TLS and requests before responding."""

    daemon_threads = False

    def __init__(self):
        self.lock = threading.Lock()
        self.connections, self.calls = 0, []
        self.tls = None
        super().__init__(("127.0.0.1", 0), Backend)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        with self.lock:
            self.connections += 1
        if self.tls is not None:
            try:
                connection = self.tls.wrap_socket(connection, server_side=True)
            except BaseException:
                connection.close()
                raise
        return connection, address

    def snapshot(self):
        with self.lock:
            return self.connections, list(self.calls)


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with self.server.lock:
            self.server.calls.append((self.command, self.path, body.decode()))
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    do_GET = respond
    do_POST = respond


def inside():
    """Use image-owned gateway code and CA trust, changing only private fixture policy."""
    sys.path.insert(0, "/opt/course")
    from certificates import Certificates
    from policy import Policy
    from proxy import GatewayServer

    assert sys.platform == "linux" and os.geteuid() == 1000
    assert set(os.listdir("/sys/class/net")) == {"lo"}, "browser checks require Docker --network none"
    servers, threads = [], []
    events, event_lock = [], threading.Lock()

    def audit(event, **data):
        with event_lock:
            events.append({"event": event, **data})

    def event_count(name):
        with event_lock:
            return sum(event["event"] == name and event.get("host") == "acme.test" for event in events)

    with tempfile.TemporaryDirectory(prefix="dsh-browser-operations-") as temporary:
        root = Path(temporary)
        try:
            certificates = Certificates(root / "private", root / "public")
            backend = ObservedServer()
            servers.append(backend)
            tls_backend = ObservedServer()
            servers.append(tls_backend)
            tls_backend.tls = certificates.context("acme.test")
            config = json.loads(Path("/opt/course/scope.json").read_text())
            rule_id = "shared-service-shutdown"
            assert any(rule["id"] == rule_id and rule["methods"] == ["*"] and "/quitquitquit" in rule["prefixes"] for rule in config["operations"]["deny"])
            config.update({"domains": ["acme.test"], "infrastructure": {}, "domain_addresses": {"acme.test": ["127.0.0.1"]},
                           "ports": {"http": [backend.server_port], "https": [tls_backend.server_port]}})
            proxy = GatewayServer(("127.0.0.1", 0), Policy(config), certificates, audit, timeout=5)
            proxy.daemon_threads = False
            servers.append(proxy)
            for server in servers:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                threads.append(thread)

            home = root / "browser-home"
            database = home / ".pki/nssdb"
            database.mkdir(parents=True)
            owned(["certutil", "-N", "-d", "sql:" + str(database), "--empty-password"], timeout=10)
            owned(["certutil", "-A", "-d", "sql:" + str(database), "-n", "DSH course fixture CA", "-t", "C,,", "-i", str(certificates.ca)], timeout=10)
            env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(root), "LANG": "C.UTF-8"}

            def browser(phase):
                settings = {"phase": phase, "proxy": f"http://127.0.0.1:{proxy.server_port}",
                            "origins": [f"http://acme.test:{backend.server_port}", f"https://acme.test:{tls_backend.server_port}"], "paths": PATHS}
                command = ["node", str(Path(__file__).with_suffix(".mjs")), json.dumps(settings)]
                # No model keys or remote telemetry settings are inherited.
                with subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
                    timed_out = False
                    try:
                        stdout, stderr = child.communicate(timeout=30)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        child.terminate()
                        try:
                            stdout, stderr = child.communicate(timeout=5)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            stdout, stderr = child.communicate()
                    except BaseException:
                        child.kill()
                        child.communicate()
                        raise
                    outcome = {"timedOut": timed_out, "signal": -child.returncode if child.returncode < 0 else None, "exitCode": child.returncode}
                    assert not timed_out, (phase, outcome)
                    assert child.returncode == 0, (phase, outcome, stdout.decode(), stderr.decode())
                    assert len(stdout) + len(stderr) <= 65536, "browser output exceeded its budget"
                    assert stderr == b"", stderr.decode()
                    result = json.loads(stdout)
                    assert result["phase"] == phase
                    return result

            ordinary = browser("ordinary")
            assert len(ordinary["results"]) == 2
            for server in (backend, tls_backend):
                assert server.snapshot() == (2, [("GET", "/research", ""), ("POST", "/research", "private browser fixture")]), server.snapshot()
            before = [server.snapshot() for server in (backend, tls_backend)]
            denials_before = event_count("denied")
            denied = browser("denied")
            denied_count = 2 * len(PATHS) * 2
            assert len(denied["results"]) == 2 * len(PATHS)
            assert event_count("denied") - denials_before == denied_count, events
            assert [server.snapshot() for server in (backend, tls_backend)] == before, "forbidden browser requests contacted an upstream"

            # Negative control: remove exactly the shutdown rule only from this
            # private gateway, retaining domain mediation and request budgets.
            removed = deepcopy(config)
            removed["operations"]["deny"] = [rule for rule in removed["operations"]["deny"] if rule["id"] != rule_id]
            previous = proxy.policy
            try:
                proxy.policy = Policy(removed)
                bypass = browser("rule-removed")
                assert len(bypass["results"]) == 2
            finally:
                proxy.policy = previous
            for server, snapshot in zip((backend, tls_backend), before):
                expected = snapshot[1] + [("GET", "/quitquitquit", ""), ("POST", "/quitquitquit", "private browser fixture")]
                assert server.snapshot() == (snapshot[0] + 2, expected), server.snapshot()
            assert event_count("upstream_failure") == 0, events
            assert all(event.get("host") == "acme.test" for event in events if event["event"] == "allowed"), events
            assert proxy.budget.active == 0
            print(json.dumps({"chromium": ordinary["chromium"], "transports": ["HTTP", "HTTPS"], "pathVariants": len(PATHS),
                              "ordinaryAllowed": 4, "forbiddenDenied": denied_count, "forbiddenUpstreamTcp": 0,
                              "forbiddenUpstreamHttp": 0, "ruleRemovedReachedUpstream": 4,
                              "postTransportCloses": sum(row["post"]["kind"] == "failed" for row in denied["results"])}), flush=True)
        finally:
            for server in servers[:len(threads)]:
                server.shutdown()
            for server in servers:
                server.server_close()
            for thread in threads:
                thread.join(10)
                assert not thread.is_alive(), "browser gateway fixture did not stop"


BOOTSTRAP = """
import pathlib, subprocess, sys, tarfile, tempfile
with tempfile.TemporaryDirectory(prefix='dsh-browser-checks-') as temporary:
    root = pathlib.Path(temporary)
    expected = {'browser_operations.py', 'browser_operations.mjs'}
    with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
        for member in archive:
            assert member.name in expected and member.isfile() and member.size <= 65536
            expected.remove(member.name)
            source = archive.extractfile(member)
            with (root / member.name).open('xb') as destination:
                destination.write(source.read())
    assert not expected
    subprocess.run([sys.executable, str(root / 'browser_operations.py'), '--inside'], check=True, timeout=110)
"""


def interrupted(signum, _frame):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise KeyboardInterrupt(f"browser operation test interrupted by signal {signum}")


def main():
    """Stream only the two new tests; remove only this invocation's named container."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--context", required=True)
    args = parser.parse_args()
    docker = ["docker", "--context", args.context]
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    image, _ = owned(docker + ["image", "inspect", "--format", "{{.Id}}", args.image], timeout=15)
    identity = image.decode().strip()
    assert re.fullmatch("sha256:[a-f0-9]{64}", identity), identity
    print("image: " + identity, flush=True)
    container = "dsh-browser-operations-" + uuid.uuid4().hex
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as stream:
        for name in ("browser_operations.py", "browser_operations.mjs"):
            stream.add(Path(__file__).with_name(name), arcname=name)
    try:
        stdout, stderr = owned(docker + ["run", "--rm", "--name", container, "--init", "-i", "--network", "none",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--user", "1000:1000",
            "--memory", "768m", "--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
            "--entrypoint", "python3", identity, "-c", BOOTSTRAP], data=archive.getvalue(), timeout=120)
        assert not stderr, stderr.decode()
        print(stdout.decode().strip(), flush=True)
    finally:
        query = docker + ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", f"name=^/{container}$"]
        remaining, _ = owned(query, timeout=15)
        if remaining.strip():
            identity = remaining.decode().strip()
            assert re.fullmatch("[a-f0-9]{64}", identity), identity
            owned(docker + ["container", "rm", "--force", identity], timeout=15)
        remaining, _ = owned(query, timeout=15)
        assert remaining == b"", "owned browser container remained after cleanup"


if __name__ == "__main__":
    if sys.argv[1:] == ["--inside"]:
        inside()
    else:
        main()
