"""Exercise pinned passive source adapters without external API calls or target traffic.

Run only inside the driver's private --network none container. The HTTP proxy
terminates CONNECT locally; it never opens an upstream socket. Its fixed port
is private to that container's network namespace, not acquired on the host.
"""
import http.server
import json
import queue
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit


class FixtureServer(http.server.ThreadingHTTPServer):
    def handle_error(self, _request, _address):
        self.failures.put(repr(sys.exception()))


class SourceProxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_CONNECT(self):
        if self.path != "crt.sh:443":
            self.server.failures.put(f"unexpected CONNECT {self.path}")
            self.send_error(502)
            return
        self.server.connects.put(self.path)
        self.send_response(200)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        with self.server.tls.wrap_socket(self.connection, server_side=True) as connection:
            SourceProxy(connection, self.client_address, self.server)

    def do_GET(self):
        parsed = urlsplit(self.path)
        host = parsed.hostname or self.headers.get("Host", "")
        query = parse_qs(parsed.query)
        if host == "crt.sh" and parsed.path == "/" and query == {"q": ["%.example.test"], "output": ["json"]}:
            body = json.dumps([
                {"id": 1, "name_value": "api.example.test\nblocked.example.test"},
                {"id": 2, "name_value": "api.example.test"},
            ]).encode()
        elif host == "web.archive.org" and parsed.path == "/cdx/search/cdx" and query == {
            "url": ["*.example.test/*"], "output": ["txt"], "fl": ["original"], "collapse": ["urlkey"],
        }:
            body = b"https://api.example.test/first\nhttps://blocked.example.test/denied\nhttps://api.example.test/first\n"
        else:
            self.server.failures.put(f"unexpected source GET {host} {self.path}")
            self.send_error(502)
            return
        mode = self.server.mode
        self.server.requests.put({"host": host, "path": parsed.path, "query": query})
        if mode == "hold" and not self.server.release.wait(30):
            self.server.failures.put("held response was not released after child exit")
        status = 503 if mode == "failure" else 200
        try:
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
            # Cancellation closes the only owned client before releasing the held response.
            if mode != "hold":
                raise

    def log_message(self, *_args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.server.failures.put(f"unexpected HTTP {code}: {self.command} {self.path}")
        super().send_error(code, message, explain)


def completed(case, args):
    result = subprocess.run([case["name"], *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise AssertionError(f'{case["name"]} exited {result.returncode}: {result.stderr}')
    return result


def next_request(server, case):
    request = server.requests.get(timeout=30)
    expected = "crt.sh" if case["name"] == "subfinder" else "web.archive.org"
    assert request["host"] == expected, request
    if case["name"] == "subfinder":
        assert server.connects.get(timeout=1) == "crt.sh:443"


def main():
    cases = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="passive-recon-smoke-") as directory:
        private = Path(directory)
        (private / "config.yaml").write_text("{}\n")
        (private / "providers.yaml").write_text("{}\n")
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=crt.sh", "-keyout", str(private / "key.pem"), "-out", str(private / "cert.pem"),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        server = FixtureServer(("127.0.0.1", 18081), SourceProxy)
        server.daemon_threads = False
        server.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.tls.load_cert_chain(private / "cert.pem", private / "key.pem")
        server.requests = queue.Queue()
        server.connects = queue.Queue()
        server.failures = queue.Queue()
        server.mode = "success"
        server.release = threading.Event()
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        results = []
        try:
            for case in cases:
                args = [value.replace("/tmp/passive-smoke-config", directory) for value in case["args"]]
                server.mode = "success"
                success = completed(case, args)
                next_request(server, case)
                assert success.stdout.strip(), f'{case["name"]} must emit fixture JSONL'
                server.mode = "failure"
                failure = completed(case, args)
                next_request(server, case)
                assert not failure.stdout.strip(), f'{case["name"]} source errors must not fabricate observations'
                # The pinned binaries may exit zero and suppress source diagnostics under -silent.
                server.mode = "hold"
                server.release.clear()
                process = subprocess.Popen([case["name"], *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    next_request(server, case)
                    process.send_signal(signal.SIGTERM)
                    process.communicate(timeout=10)
                    assert process.returncode is not None
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=10)
                    server.release.set()
                results.append({
                    "name": case["name"], "stdout": success.stdout, "failureStdout": failure.stdout,
                    "failureDiagnosticsPresent": bool(failure.stderr.strip()),
                })
        finally:
            server.release.set()
            server.shutdown()
            server.server_close()
            thread.join()
        assert server.failures.empty(), list(server.failures.queue)
        assert server.requests.empty(), "the pinned source made additional API requests"
        assert server.connects.empty(), "the pinned source made additional CONNECT requests"
        print(json.dumps(results))


if __name__ == "__main__":
    main()
