"""Verify pinned CLI flags and active JSONL against loopback-only fixtures, not external targets."""
import http.server
import json
from pathlib import Path
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading


class HTTPFixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<html><title>Course fixture</title><a href="http://127.0.0.1:18080/next">next</a></html>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class DNSFixture(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        end = 12
        while data[end]:
            end += data[end] + 1
        end += 5
        is_a = struct.unpack("!H", data[end - 4:end - 2])[0] == 1
        header = data[:2] + struct.pack("!HHHHH", 0x8180, 1, int(is_a), 0, 0)
        answer = b'\xc0\x0c' + struct.pack("!HHIH", 1, 1, 60, 4) + b'\x7f\x00\x00\x01' if is_a else b''
        sock.sendto(header + data[12:end] + answer, self.client_address)


def main():
    cases = json.load(sys.stdin)
    web = http.server.ThreadingHTTPServer(("127.0.0.1", 18080), HTTPFixture)
    dns = socketserver.UDPServer(("127.0.0.1", 15353), DNSFixture)
    threads = [threading.Thread(target=server.serve_forever) for server in (web, dns)]
    for thread in threads:
        thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="recon-smoke-") as directory:
            Path(directory, "config.yaml").write_text("{}\n")
            Path(directory, "providers.yaml").write_text("{}\n")
            for case in cases:
                args = [value.replace("/tmp/recon-smoke-config", directory) for value in case["args"]]
                result = subprocess.run([case["name"], *args, "-h"], capture_output=True, text=True, timeout=30)
                if result.returncode or "flag provided but not defined" in result.stderr:
                    raise AssertionError(f'{case["name"]} flags: {result.stderr}')
                if case["mode"] == "active":
                    result = subprocess.run([case["name"], *args], input=case["target"] + "\n", capture_output=True, text=True, timeout=30)
                    if result.returncode:
                        raise AssertionError(f'{case["name"]}: {result.stderr}')
                    records = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                    if not records:
                        raise AssertionError(f'{case["name"]} produced no fixture observations: {result.stderr}')
                    if case["name"] == "dnsx":
                        assert any(record["host"] == "example.test" and "127.0.0.1" in record["a"] for record in records)
                    elif case["name"] == "httpx":
                        assert all(record["url"].startswith("http://127.0.0.1:18080") and record["status_code"] == 200 for record in records)
                    elif case["name"] == "naabu":
                        assert all(record["ip"] == "127.0.0.1" and record["port"] == 18080 for record in records)
                    elif case["name"] == "katana":
                        assert all(record["request"]["endpoint"].startswith("http://127.0.0.1:18080") for record in records)
                    print(case["name"], "JSONL PASS", len(records), flush=True)
                else:
                    print(case["name"], "flags PASS (no external API call)", flush=True)
    finally:
        for server in (web, dns):
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join()


if __name__ == "__main__":
    main()
