"""Real tool programs run without argument adapters; only destinations are restricted."""

import http.client
from contextlib import closing
import errno
import json
import os
from pathlib import Path
import socket
import subprocess


def run(args, expected=0, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, **kwargs)
    assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
    return result.stdout


assert os.geteuid() == 1000
assert json.loads(Path("/run/course-public/policy.json").read_text())["domains"] == ["acme.test", "*.lab.test"]


class ScopeControl(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(3)
        self.sock.connect("/run/course-public/control.sock")


def inspect_scope(after=None, targets=None):
    with closing(ScopeControl("localhost", timeout=3)) as control:
        control.request("POST", "/inspect", json.dumps({"after": after, "targets": targets or []}))
        reply = control.getresponse()
        assert reply.status == 200
        return json.loads(reply.read())


initial = inspect_scope()
assert initial["healthy"] and initial["uid"] == 1000
assert inspect_scope(targets=[{"url": "https://acme.test:18443/", "method": "GET"}])["allowed"]
assert not inspect_scope(targets=[{"url": "https://widgets.test:18443/", "method": "GET"}])["allowed"]
assert run(["curl", "-fsS", "http://acme.test:18080/ok"]) == "allowed"
assert run(["curl", "-fsS", "https://acme.test:18443/ok"]) == "allowed"
run(["curl", "-fsS", "http://widgets.test:18080/no"], expected=22)
run(["curl", "-fsS", "https://widgets.test:18443/no"], expected=22)
run(["curl", "-fsSL", "https://acme.test:18443/redirect"], expected=22)
run(["curl", "-fsS", "-H", "Host: widgets.test:18080", "http://acme.test:18080/host"], expected=22)
raw_env = {key: value for key, value in os.environ.items() if "proxy" not in key.lower()}
assert run(["curl", "-fsS", "--max-time", "2", "http://198.18.0.2:18080/"], env=raw_env) == "allowed"
run(["curl", "-fsS", "--max-time", "2", "http://198.18.0.3:18080/"], expected=28, env=raw_env)
assert run(["curl", "-gfsS", "--max-time", "2", "http://[fd31::2]:18080/"], env=raw_env) == "allowed"
run(["curl", "-gfsS", "--max-time", "2", "http://[fd31::3]:18080/"], expected=28, env=raw_env)
for address in ("198.18.0.3", "198.18.0.4", "198.18.0.5", "fd31::3"):
    try:
        with socket.create_connection((address, 18080), timeout=0.5):
            raise AssertionError("unproxied forbidden socket connected: " + address)
    except (TimeoutError, OSError):
        pass
for address, allowed in (("198.18.0.2", True), ("198.18.0.3", False), ("fd31::2", True), ("fd31::3", False)):
    with socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(0.5)
        try:
            udp.sendto(b"scope-control", (address, 18081))
            assert udp.recv(2048) == b"scope-control"
            assert allowed, "forbidden UDP destination replied"
        except TimeoutError:
            assert not allowed, "allowed UDP destination did not reply"
        except PermissionError as error:
            assert not allowed and error.errno in (errno.EPERM, errno.EACCES), (address, error)
connection = http.client.HTTPConnection("127.0.0.1", 3128, timeout=3)
connection.request("GET", "http://acme.test:18080/python")
assert connection.getresponse().read() == b"allowed"
connection.close()
assert "18080/tcp open" in run(["nmap", "-n", "-Pn", "-sT", "-p", "18080", "198.18.0.2"])
assert "18080/tcp filtered" in run(["nmap", "-n", "-Pn", "-sT", "--max-retries", "0", "--host-timeout", "5s", "-p", "18080", "198.18.0.3"])
assert "198.18.0.4" in run(["dig", "+short", "acme.test"])
assert "REFUSED" in run(["dig", "widgets.test"])
run(["dig", "@127.0.0.11", "+time=1", "+tries=1", "widgets.test"], expected=9)
observed = inspect_scope(initial["nextSeq"])
assert observed["instance"] == initial["instance"] and observed["policyHash"] == initial["policyHash"]
assert any(event.get("host") == "widgets.test" and event["event"] == "denied" for event in observed["events"])
assert any(event.get("transport") == "kernel" for event in observed["events"])
assert [event["seq"] for event in observed["events"]] == list(range(initial["nextSeq"], observed["nextSeq"]))
print("PASS: research UID reads live immutable gateway policy, decisions, and contiguous environment audit over the read-only socket")
run(["node", "/opt/course/tests/browser.mjs"])
print("PASS: curl, redirects, custom Host, arbitrary Python TCP/UDP sockets, IPv4/IPv6, nmap, DNS, Chromium and WebSockets")
