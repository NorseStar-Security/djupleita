"""HTTP(S)/WebSocket mediation. CONNECT never creates an opaque network tunnel."""

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import select
import socket
import ssl
import threading

from policy import ScopeDenied, destination
from operations import RequestBudget


class UpgradeResponse(http.client.HTTPResponse):
    def _check_close(self):
        return False if self.status == 101 else super()._check_close()


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, policy, certificates, audit, timeout=30, max_body=8 * 1024 * 1024):
        self.policy, self.certificates, self.audit = policy, certificates, audit
        self.timeout_seconds, self.max_body = timeout, max_body
        self.slots = threading.BoundedSemaphore(32)
        self.budget = RequestBudget(policy.operations.budget) if policy.operations is not None else None
        self.upstream_tls = ssl.create_default_context(cafile=str(certificates.public / "combined.pem"))
        self.upstream_tls.set_alpn_protocols(["http/1.1"])
        super().__init__(address, ProxyHandler)

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


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CourseScope"
    hop_headers = {"connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}

    def __init__(self, request, address, server, tunnel=None):
        self.tunnel = tunnel
        request.settimeout(server.timeout_seconds)
        super().__init__(request, address, server)

    def log_message(self, *_args):
        # Base logging includes paths and potentially credentials; audit hosts only.
        pass

    def handle(self):
        self.close_connection = True
        try:
            self.handle_one_request()
        except (ConnectionError, TimeoutError, ssl.SSLError):
            pass

    def do_CONNECT(self):
        target = None
        try:
            if self.tunnel is not None or "/" in self.path or "?" in self.path or "#" in self.path:
                raise ScopeDenied("nested or malformed CONNECT")
            target = destination("https://" + self.path + "/")
            if target.port not in self.server.policy.ports["https"] or not self.server.policy.host_allowed(target.host):
                raise ScopeDenied("CONNECT destination is outside scope")
            if self.headers.get("Content-Length") not in (None, "0") or self.headers.get("Transfer-Encoding"):
                raise ScopeDenied("CONNECT request must not contain a body")
            context = self.server.certificates.context(target.host)
            self.send_response(200, "Connection established")
            self.end_headers()
            self.wfile.flush()
            with context.wrap_socket(self.connection, server_side=True) as tls:
                ProxyHandler(tls, self.client_address, self.server, target)
        except ScopeDenied as error:
            self.denied(target, str(error))
        except (ssl.SSLError, OSError, ValueError) as error:
            self.server.audit("tls_failure", host=target.host if target else None, error=type(error).__name__)
        self.close_connection = True

    def __getattr__(self, name):
        if name.startswith("do_"):
            return self.forward
        raise AttributeError(name)

    def denied(self, target, reason):
        self.server.audit("denied", transport="proxy", host=target.host if target else None, port=target.port if target else None, reason=reason)
        body = ("scope judge denied connection: " + reason + "\n").encode()
        try:
            self.send_response(403, "Scope denied")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def target(self):
        scheme = "https" if self.tunnel else "http"
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            raise ScopeDenied("exactly one Host header is required")
        claimed = destination(scheme + "://" + hosts[0] + "/")
        if self.path.startswith("/") and self.tunnel:
            target = destination(scheme + "://" + self.tunnel.authority + self.path)
        else:
            target = destination(self.path)
        if target.scheme != scheme or (target.host, target.port) != (claimed.host, claimed.port):
            raise ScopeDenied("request URL and Host disagree")
        if self.tunnel and (target.host, target.port) != (self.tunnel.host, self.tunnel.port):
            raise ScopeDenied("HTTPS request cannot change CONNECT authority")
        return target

    def read_body(self):
        lengths = self.headers.get_all("Content-Length", [])
        encodings = self.headers.get_all("Transfer-Encoding", [])
        if len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings):
            raise ScopeDenied("ambiguous request framing")
        if encodings:
            if encodings[0].lower() != "chunked":
                raise ScopeDenied("unsupported transfer encoding")
            result = bytearray()
            while True:
                line = self.rfile.readline(128)
                if not line.endswith(b"\r\n") or b";" in line:
                    raise ScopeDenied("invalid chunk framing")
                try:
                    size = int(line[:-2], 16)
                except ValueError:
                    raise ScopeDenied("invalid chunk length") from None
                if size < 0 or len(result) + size > self.server.max_body:
                    raise ScopeDenied("request body exceeds gateway limit")
                if size == 0:
                    if self.rfile.readline(8192) != b"\r\n":
                        raise ScopeDenied("request trailers are not supported")
                    return bytes(result)
                data = self.rfile.read(size)
                if len(data) != size or self.rfile.read(2) != b"\r\n":
                    raise ScopeDenied("truncated chunk")
                result.extend(data)
        if not lengths:
            return b""
        if not lengths[0].isascii() or not lengths[0].isdigit():
            raise ScopeDenied("invalid Content-Length")
        size = int(lengths[0])
        if size > self.server.max_body:
            raise ScopeDenied("request body exceeds gateway limit")
        body = self.rfile.read(size)
        if len(body) != size:
            raise ScopeDenied("truncated request body")
        return body

    def connect(self, target):
        addresses = self.server.policy.resolve(target.host, target.port)
        last_error = None
        for address in addresses:
            sock = None
            try:
                sock = socket.create_connection((address, target.port), self.server.timeout_seconds)
                if target.scheme == "https":
                    sock = self.server.upstream_tls.wrap_socket(sock, server_hostname=target.host)
                return sock
            except OSError as error:
                if sock:
                    sock.close()
                last_error = error
        raise last_error or OSError("no reachable validated address")

    def forward(self):
        target, connection = None, None
        budget = self.server.budget
        admitted = False
        try:
            target = self.target()
            self.server.policy.authorize(target, self.command)
            if budget is not None:
                try:
                    budget.acquire()
                    admitted = True
                except ValueError as error:
                    raise ScopeDenied(str(error)) from None
            body = self.read_body()
            upgrade = self.headers.get("Upgrade", "").lower()
            if upgrade not in ("", "websocket"):
                raise ScopeDenied("only HTTP(S) and WebSocket upgrades are supported")
            removed = self.hop_headers | {part.strip().lower() for part in self.headers.get("Connection", "").split(",")}
            headers = {key: value for key, value in self.headers.items() if key.lower() not in removed | {"host", "content-length"}}
            headers["Host"] = target.authority
            headers["Connection"] = "Upgrade" if upgrade else "close"
            if body or self.headers.get("Content-Length") is not None or self.headers.get("Transfer-Encoding"):
                headers["Content-Length"] = str(len(body))
            if upgrade:
                headers["Upgrade"] = "websocket"
            # Supplying the connected socket prevents HTTPConnection from resolving again.
            connection = http.client.HTTPConnection(target.host, target.port, timeout=self.server.timeout_seconds)
            connection.response_class = UpgradeResponse
            connection.sock = self.connect(target)
            self.server.audit("allowed", transport="proxy", host=target.host, port=target.port, method=self.command)
            connection.request(self.command, target.path, body=body, headers=headers)
            response = connection.getresponse()
            if response.status == 101 and upgrade != "websocket":
                raise ScopeDenied("unexpected protocol upgrade")
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in self.hop_headers:
                    self.send_header(key, value)
            if response.status == 101:
                self.send_header("Connection", "Upgrade")
                self.send_header("Upgrade", "websocket")
            else:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()
            if response.status == 101:
                self.relay(connection.sock)
            elif self.command != "HEAD":
                while data := response.read(65536):
                    self.wfile.write(data)
        except ScopeDenied as error:
            self.denied(target, str(error))
        except (OSError, ValueError, http.client.HTTPException) as error:
            self.server.audit("upstream_failure", host=target.host if target else None, error=type(error).__name__)
            try:
                self.send_error(502, "Scoped upstream connection failed")
            except OSError:
                pass
        finally:
            if admitted:
                budget.release()
            if connection:
                connection.close()
            self.close_connection = True

    def relay(self, upstream):
        sockets = [self.connection, upstream]
        while True:
            pending = [sock for sock in sockets if isinstance(sock, ssl.SSLSocket) and sock.pending()]
            readable = pending or select.select(sockets, [], [], self.server.timeout_seconds)[0]
            if not readable:
                return
            for source in readable:
                data = source.recv(65536)
                if not data:
                    return
                (upstream if source is self.connection else self.connection).sendall(data)
