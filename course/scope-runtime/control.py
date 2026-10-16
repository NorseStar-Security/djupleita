"""Read-only policy decisions and bounded audit feed over a private Unix socket."""

from collections import deque
from http.server import BaseHTTPRequestHandler
import json
import os
import socketserver
import threading
import uuid

from policy import ScopeDenied, destination
from action_review import ReviewUnavailable


class Journal:
    """Monotonic, bounded environment records; clients detect overwritten cursors."""

    def __init__(self, policy, config, capacity=1024):
        self.policy, self.config = policy, config
        self.instance = str(uuid.uuid4())
        self.records = deque(maxlen=capacity)
        self.next_seq = 0
        self.lock = threading.Lock()

    def append(self, record):
        with self.lock:
            self.records.append({**record, "seq": self.next_seq})
            self.next_seq += 1

    def inspect(self, after, targets, healthy):
        allowed = True
        for target in targets:
            try:
                self.policy.authorize(destination(target["url"]), target["method"])
            except ScopeDenied:
                allowed = False
        with self.lock:
            first = self.records[0]["seq"] if self.records else self.next_seq
            if after is not None and after > self.next_seq:
                raise ValueError("future audit cursor")
            return {"protocol": 1, "instance": self.instance, "policyHash": self.policy.digest,
                    "boundary": "linux-netns-nftables", "uid": 1000, "healthy": bool(healthy),
                    "policy": self.config, "firstSeq": first, "nextSeq": self.next_seq,
                    "events": [] if after is None else [dict(record) for record in self.records if record["seq"] >= after],
                    "allowed": allowed}


class ControlServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    # Only one bounded request per connection; no mutable policy endpoints.
    daemon_threads = True
    block_on_close = True
    request_queue_size = 16

    def __init__(self, path, journal, healthy, review=None):
        self.journal, self.healthy = journal, healthy
        self.review = review
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(str(path), Handler)
        os.chmod(path, 0o666)  # research sees the containing volume read-only

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(3)
        super().setup()

    def log_message(self, *_args):
        pass  # Never log request bodies, URL queries, headers, or credentials.

    def reply(self, value, status=200):
        data = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path not in ("/review/status", "/review/health") or self.server.review is None:
            self.send_error(404)
            return
        value = self.server.review.status()
        if self.path == "/review/health":
            value["ready"] = self.server.review.healthy()
        self.reply({**value, "ready": value["ready"] and bool(self.server.healthy())})

    def do_POST(self):
        if self.path not in ("/inspect", "/review"):
            self.send_error(404)
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding") is not None:
                raise ValueError("invalid framing")
            length = int(lengths[0])
            maximum = self.server.review.config["maxInputBytes"] if self.path == "/review" and self.server.review is not None else 32768
            if not 0 < length <= maximum:
                raise ValueError("request too large")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("truncated request")
            if self.path == "/review":
                if self.server.review is None or not self.server.healthy():
                    self.reply({"error": "ACTION_REVIEW_UNAVAILABLE"}, 503)
                    return
                self.request.settimeout(self.server.review.config["timeoutSeconds"] + 5)
                self.reply(self.server.review.review(raw))
                return
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {"after", "targets"}:
                raise ValueError("invalid request")
            after, targets = value["after"], value["targets"]
            if after is not None and (type(after) is not int or not 0 <= after <= 2**53 - 1):
                raise ValueError("invalid cursor")
            if not isinstance(targets, list) or len(targets) > 32:
                raise ValueError("invalid targets")
            for target in targets:
                if not isinstance(target, dict) or set(target) != {"url", "method"} or not all(isinstance(target[key], str) for key in target):
                    raise ValueError("invalid target")
                if not target["method"].isalpha() or not target["method"].isascii() or target["method"] != target["method"].upper():
                    raise ValueError("invalid method")
            data = json.dumps(self.server.journal.inspect(after, targets, self.server.healthy()), separators=(",", ":")).encode()
        except ReviewUnavailable:
            self.reply({"error": "ACTION_REVIEW_AUDIT_UNAVAILABLE"}, 503)
            return
        except (ValueError, TypeError, UnicodeError, RecursionError):
            self.send_error(400, "invalid inspection request")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start(path, journal, healthy, review=None):
    path.unlink(missing_ok=True)
    server = ControlServer(path, journal, healthy, review)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
